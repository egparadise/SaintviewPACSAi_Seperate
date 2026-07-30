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
import time
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
# 검사-후-추가를 원자화한다. get_frame 은 sync def 라 FastAPI 가 스레드풀에서 병렬 실행하고,
# 뷰어는 시리즈를 열 때 같은 시리즈의 여러 프레임을 동시에 요청한다.
# (현재 CPython 에서는 `not in` + `add` 사이에 GIL 을 놓는 바이트코드가 없어 사실상 원자적이지만,
#  그건 구현 세부에 기댄 것이다 — free-threading 빌드에서는 성립하지 않는다.
#  webpacs_live 의 _prefetch_lock/_prefetching 이 이미 이 형태다. 같은 규칙을 지킨다.)
_INFLIGHT_LOCK = threading.Lock()

# ── 인코딩 동시 상한 ──────────────────────────────────────────────────────
# get_frame 은 sync def 라 anyio 스레드풀(기본 40)에서 돈다. 온디맨드 인코딩 한 건은
# Node 서브프로세스를 띄우므로 CPU 도 먹고 시간도 든다. 상한이 없으면 CT 시리즈를 한 번
# 훑는 동작이 스레드풀을 통째로 채워 **로그인·health 까지 굶는다** —
# webpacs_live 의 a_pixel_slot 을 만들게 한 그 증상과 같은 것이고, 이쪽만 빠져 있었다.
_ENC_SLOTS = int(os.getenv("SAINTVIEW_HTJ2K_ENCODE_SLOTS", "4"))
_enc_gate = threading.BoundedSemaphore(max(1, _ENC_SLOTS))
_ENC_WAIT = float(os.getenv("SAINTVIEW_HTJ2K_ENCODE_WAIT", "15"))

# ── 전송구문 판정 캐시 (sop → 비압축인가) ────────────────────────────────
# ⚠ 왜 필요한가: 기압축 인스턴스는 프레임을 볼 때마다 **인스턴스 전체(수 MB)를 다시 받아**
#   전송구문만 확인하고 버렸다. 판정 결과는 그 SOP 에 대해 불변이므로 한 번만 확인하면 된다.
#   이 캐시가 기압축 검사(대부분의 외부 반입 데이터)의 스크롤 비용을 없앤다.
_TS_UNCOMPRESSED: dict[str, bool] = {}
_TS_LOCK = threading.Lock()
_TS_MAX = 20000        # SOP 하나당 bool — 2만 개도 수 MB 미만. 넘으면 통째로 비운다(재학습은 저렴).


def _ts_verdict(sop: str) -> bool | None:
    with _TS_LOCK:
        return _TS_UNCOMPRESSED.get(sop)


def _ts_remember(sop: str, uncompressed: bool) -> None:
    with _TS_LOCK:
        if len(_TS_UNCOMPRESSED) >= _TS_MAX:
            _TS_UNCOMPRESSED.clear()
        _TS_UNCOMPRESSED[sop] = uncompressed


def _atomic_write(dest: Path, data: bytes) -> None:
    """캐시 파일 원자 기록 — 같은 이름으로 직접 쓰면 **읽는 쪽이 빈 파일을 본다**.

    write_bytes() 는 'wb' 로 열어 먼저 0바이트로 자른 뒤 채운다. 그 사이 다른 스레드가
    get_frame 의 `cached.exists()` 에서 True 를 보고 read_bytes() 하면 b"" 를 받아
    Content-Length: 0 인 **정상 200 멀티파트**(178바이트)를 내보낸다 — 전송 오류가 아니라
    성공 응답이라 재시도도 안 걸리고, 클라이언트 WASM 코덱이 빈 j2c 로 디코딩에 실패해
    뷰어에 검은 타일이 남는다(사용자가 다시 스크롤할 때까지 복구 안 됨).
    실측: 찢긴 읽기는 **전부 정확히 0바이트** — j2c 크기와 무관한 O_TRUNC 구간이다.
    webpacs_live.get_instance_bytes 가 같은 이유로 이미 tmp+os.replace 를 쓴다.
    tmp 이름에 스레드 id 를 넣는 것도 그쪽과 같은 이유다(같은 .part 에 동시 기록 방지).
    """
    if dest.exists():
        # 이 캐시는 내용 주소지정이다 — (sop, frame) 이 같으면 j2c 바이트도 같다.
        # 이미 있으면 덮어쓸 이유가 없고, 덮어쓰지 않는 것이 곧 찢긴 읽기를 없애는 길이다.
        # (온디맨드 경로가 만든 파일을 시리즈 배치가 나중에 되덮던 경로도 여기서 끊긴다.)
        return
    tmp = dest.with_suffix(f".{threading.get_ident():x}.part")
    try:
        tmp.write_bytes(data)
        os.replace(tmp, dest)     # 원자 교체 — 읽는 쪽은 옛 파일 아니면 새 파일만 본다
    except OSError:
        # Windows 는 대상 파일이 열려 있으면 교체를 거부한다(파이썬 open 이 FILE_SHARE_DELETE
        # 를 안 걸어서다). 그 사이 다른 스레드가 같은 프레임을 이미 넣은 것이므로 내용은 동일 —
        # tmp 만 버리고 성공으로 본다. 대상이 정말 없을 때만 실패를 올린다.
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        if not dest.exists():
            raise

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
        # 원자 쓰기(_atomic_write)의 tmp 가 프로세스 중단으로 남을 수 있다 — glob("*.j2c") 이
        # 못 잡아 무한정 쌓인다. 1시간 넘게 방치된 것만 회수(진행 중인 쓰기는 건드리지 않는다).
        cutoff = time.time() - 3600
        for f in CACHE.glob("*.part"):
            try:
                if f.stat().st_mtime < cutoff:
                    f.unlink()
            except OSError:
                continue
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
        with _INFLIGHT_LOCK:
            _inflight_series.discard(series_uid)


def _proxy_frame(client, stu: str, ser: str, sop: str, frame: int) -> Response:
    """기압축 인스턴스의 프레임을 Orthanc 에서 원본 전송구문 그대로 프록시."""
    r = client._client.get(  # noqa: SLF001
        f"/dicom-web/studies/{stu}/series/{ser}/instances/{sop}/frames/{frame}",
        headers={"Accept": 'multipart/related; type="application/octet-stream"; transfer-syntax=*'})
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail="Orthanc 프레임 조회 실패")
    return Response(content=r.content, media_type=r.headers.get("content-type", ""))


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
        # ★ 기압축으로 이미 판정된 SOP 은 인스턴스 전체를 받지 않는다 — 프레임만 프록시한다.
        #   예전에는 판정을 위해 매번 수 MB 를 내려받고 버렸다(프레임 볼 때마다).
        if _ts_verdict(sop) is False:
            return _proxy_frame(client, stu, ser, sop, frame)
        oid = _lookup(client, sop, "instance")
        raw = client.instance_file(oid)
        ds = pydicom.dcmread(io.BytesIO(raw))
        ts = str(ds.file_meta.TransferSyntaxUID)
        uncompressed = ts in UNCOMPRESSED_TS
        _ts_remember(sop, uncompressed)
        if not uncompressed:
            # 이미 압축된 원본 — Orthanc 프레임을 원본 전송구문 그대로 프록시(클라이언트 코덱이 디코딩)
            return _proxy_frame(client, stu, ser, sop, frame)
        # 인코딩은 동시 상한 안에서 — 상한이 없으면 스크롤 한 번이 스레드풀을 다 먹는다
        if not _enc_gate.acquire(timeout=_ENC_WAIT):
            raise HTTPException(status_code=503, detail="HTJ2K 인코딩 대기 상한 — 잠시 후 다시 시도하세요")
        try:
            cs = encode_frame(ds, frame - 1)
        finally:
            _enc_gate.release()
        if cs is None:
            raise HTTPException(status_code=500, detail="HTJ2K 인코딩 실패")
        CACHE.mkdir(parents=True, exist_ok=True)
        _atomic_write(cached, cs)
        _prune_cache()
        # 같은 시리즈 나머지 프레임 프리인코딩(백그라운드 1회)
        with _INFLIGHT_LOCK:
            start = ser not in _inflight_series
            if start:
                _inflight_series.add(ser)
        if start:
            try:
                threading.Thread(target=_pre_encode_series, args=(ser,), daemon=True).start()
            except RuntimeError:
                # 스레드 생성 실패 — discard 는 _pre_encode_series 의 finally 에 있으므로
                # 여기서 직접 풀지 않으면 그 시리즈는 프로세스가 죽을 때까지 영영
                # 프리인코딩되지 않는다(온디맨드로만 한 장씩 → 스크롤이 계속 느려진다).
                with _INFLIGHT_LOCK:
                    _inflight_series.discard(ser)
        return _multipart(cs)
    finally:
        client.close()
