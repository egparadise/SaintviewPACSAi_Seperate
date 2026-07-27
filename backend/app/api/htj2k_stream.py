"""HTJ2K 스트리밍 프록시 — Orthanc 가 HTJ2K 를 지원하지 않으므로 백엔드가 대신 제공.

클라이언트(WASM 파이프라인/3D 뷰어)가 전송구문을 HTJ2K 로 설정하면 프레임 요청이 이 엔드포인트로
온다. 원본(비압축)을 Orthanc 에서 받아 OpenJPH(Node WASM)로 무손실 인코딩 후 WADO-RS 멀티파트로
응답(디스크 캐시 — 최초 1회만 인코딩, 이후 즉시 서빙). 같은 시리즈의 나머지 프레임은 백그라운드
프리인코딩으로 스크롤 시 캐시 적중. 이미 압축된 인스턴스는 Orthanc 원본 프레임을 그대로 프록시.
"""
from __future__ import annotations

import io
import logging
import os
import threading
import uuid
from pathlib import Path

import pydicom
from fastapi import APIRouter, Depends, HTTPException, Response

from app.api.deps import current_user

logger = logging.getLogger("saintview.htj2k")

router = APIRouter(prefix="/api/htj2k", tags=["htj2k-stream"])

HTJ2K_LOSSLESS = "1.2.840.10008.1.2.4.201"
CACHE = Path(__file__).resolve().parents[2] / "cache" / "htj2k"
_inflight_series: set[str] = set()

# ── 캐시 상한 ──────────────────────────────────────────────────────────────
# 이 캐시는 **본 프레임을 전부 영구 보관**했다. 판독을 계속하면 디스크가 찰 때까지
# 자라고, 다 차면 인코딩 쓰기가 실패해 뷰어가 프레임을 못 받는다(영상 서버에서는 곧 정지).
# webpacs_live 의 디스크 캐시와 같은 방식으로 상한을 둔다.
#  · 파일 수가 아니라 **바이트 합**으로 센다 — j2c 크기가 프레임마다 크게 다르다.
#  · 정렬 기준은 mtime = **넣은 시각**이므로 엄밀히는 FIFO 다(LRU 아님).
#    읽기마다 파일을 건드려 atime 을 갱신하면 적중 경로에 쓰기가 생겨 더 손해라 택하지 않았다.
#  · 디렉터리 스캔이 비싸므로 쓰기 N회마다 상각한다(매번 스캔하면 단일 워커가 그동안 멈춘다).
CACHE_MAX_MB = int(os.getenv("SAINTVIEW_HTJ2K_CACHE_MB", "4096"))
_PRUNE_EVERY = 128
_prune_counter = 0
_PRUNE_LOCK = threading.Lock()


def _prune_cache(force: bool = False) -> None:
    """상한을 넘으면 오래 전에 넣은 것부터 지운다."""
    global _prune_counter
    with _PRUNE_LOCK:
        _prune_counter += 1
        if not force and _prune_counter % _PRUNE_EVERY != 0:
            return
    limit = max(0, CACHE_MAX_MB) * 1024 * 1024
    try:
        entries = []
        total = 0
        for f in CACHE.glob("*.j2c"):
            try:
                st = f.stat()
            except OSError:      # 다른 스레드가 방금 지웠을 수 있다
                continue
            entries.append((st.st_mtime, st.st_size, f))
            total += st.st_size
        if total <= limit:
            return
        entries.sort(key=lambda e: e[0])
        freed = 0
        for _, size, f in entries:
            if total <= limit:
                break
            try:
                f.unlink()
            except OSError:
                continue
            total -= size
            freed += size
        logger.info("HTJ2K 캐시 정리 — %.1fMB 회수(상한 %dMB)", freed / 1048576, CACHE_MAX_MB)
    except OSError as e:
        logger.warning("HTJ2K 캐시 정리 실패: %s", e)


def _multipart(cs: bytes) -> Response:
    """WADO-RS 멀티파트 응답 — Orthanc 형식 모방(part Content-Type 에 transfer-syntax 명시)."""
    boundary = uuid.uuid4().hex
    part_ct = f"application/octet-stream; transfer-syntax={HTJ2K_LOSSLESS}"
    body = (f"--{boundary}\r\nContent-Type: {part_ct}\r\n"
            f"Content-Length: {len(cs)}\r\n\r\n").encode() + cs + f"\r\n--{boundary}--\r\n".encode()
    return Response(
        content=body,
        media_type=f'multipart/related; type="{part_ct}"; boundary={boundary}',
    )


def _lookup(client, uid: str, level: str) -> str:
    r = client._client.post("/tools/lookup", content=uid)  # noqa: SLF001 — UID→Orthanc ID 조회
    for it in (r.json() if r.status_code == 200 else []):
        if it.get("Type", "").lower() == level:
            return it["ID"]
    raise HTTPException(status_code=404, detail=f"{level} 를 찾을 수 없습니다")


def _pre_encode_series(series_uid: str) -> None:
    """시리즈 전체 백그라운드 프리인코딩 — 한 번의 Node 배치로 캐시 채움(스크롤 가속)."""
    from app.dicom.orthanc import OrthancClient
    from app.services.htj2k_service import UNCOMPRESSED_TS, encode_frames_batch

    client = OrthancClient()
    try:
        sid = _lookup(client, series_uid, "series")
        insts = client._client.get(f"/series/{sid}/instances").json()  # noqa: SLF001
        specs = []
        for it in insts:
            oid = it["ID"]
            sop = it.get("MainDicomTags", {}).get("SOPInstanceUID", "")
            if not sop or (CACHE / f"{sop}_1.j2c").exists():
                continue
            try:
                ds = pydicom.dcmread(io.BytesIO(client.instance_file(oid)))
                if str(ds.file_meta.TransferSyntaxUID) not in UNCOMPRESSED_TS:
                    continue
                specs.append((sop, ds))
            except Exception:  # noqa: BLE001
                continue
        if specs:
            CACHE.mkdir(parents=True, exist_ok=True)
            encode_frames_batch(specs, CACHE)
            # 배치는 한 번에 수백 장을 넣는다 — 상각 카운터를 기다리지 말고 바로 확인한다
            _prune_cache(force=True)
    except Exception:  # noqa: BLE001 — 프리인코딩 실패는 온디맨드 경로가 대신함
        pass
    finally:
        client.close()
        _inflight_series.discard(series_uid)


@router.get("/studies/{stu}/series/{ser}/instances/{sop}/frames/{frame}")
def get_frame(stu: str, ser: str, sop: str, frame: int,
              user: dict = Depends(current_user)):
    """HTJ2K 프레임 — 캐시 → 온디맨드 인코딩 → (기압축이면 Orthanc 원본 프록시)."""
    from app.dicom.orthanc import OrthancClient
    from app.services.htj2k_service import UNCOMPRESSED_TS, encode_frame

    cached = CACHE / f"{sop}_{frame}.j2c"
    if cached.exists():
        return _multipart(cached.read_bytes())
    client = OrthancClient()
    try:
        oid = _lookup(client, sop, "instance")
        raw = client.instance_file(oid)
        ds = pydicom.dcmread(io.BytesIO(raw))
        ts = str(ds.file_meta.TransferSyntaxUID)
        if ts not in UNCOMPRESSED_TS:
            # 이미 압축된 원본 — Orthanc 프레임을 원본 전송구문 그대로 프록시(클라이언트 코덱이 디코딩)
            r = client._client.get(  # noqa: SLF001
                f"/dicom-web/studies/{stu}/series/{ser}/instances/{sop}/frames/{frame}",
                headers={"Accept": 'multipart/related; type="application/octet-stream"; transfer-syntax=*'})
            if r.status_code != 200:
                raise HTTPException(status_code=502, detail="Orthanc 프레임 조회 실패")
            return Response(content=r.content, media_type=r.headers.get("content-type", ""))
        cs = encode_frame(ds, frame - 1)
        if cs is None:
            raise HTTPException(status_code=500, detail="HTJ2K 인코딩 실패")
        CACHE.mkdir(parents=True, exist_ok=True)
        cached.write_bytes(cs)
        _prune_cache()
        # 같은 시리즈 나머지 프레임 프리인코딩(백그라운드 1회)
        if ser not in _inflight_series:
            _inflight_series.add(ser)
            threading.Thread(target=_pre_encode_series, args=(ser,), daemon=True).start()
        return _multipart(cs)
    finally:
        client.close()
