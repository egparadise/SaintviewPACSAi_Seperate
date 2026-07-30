"""HTJ2K(OpenJPH) 자체 인코딩 서비스 — 백업 저장 시점 변환.

Orthanc(1.12.11)는 HTJ2K 트랜스코딩·디코딩을 아직 지원하지 않으므로(실측: rendered/preview 415,
WADO-RS frames 500), 진단 원본은 Orthanc 에 그대로 두고 **백업 파일 생성 시** HTJ2K 무손실로
변환해 기록한다. 인코더는 프론트 의존성의 OpenJPH WASM(@cornerstonejs/codec-openjph)을
Node CLI(tools/htj2k_encode.mjs)로 재사용 — 실측 무손실 압축률 ~6%(2,097,152B→121,269B).

검사(Study) 단위 배치: 인스턴스 프레임들을 한 번의 Node 실행으로 인코딩(WASM 초기화 1회).
비압축(Implicit/Explicit LE·BE) 인스턴스만 변환하고, 이미 압축된 인스턴스는 원본 그대로 기록(폴백).
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pydicom
from pydicom.encaps import encapsulate

HTJ2K_LOSSLESS = "1.2.840.10008.1.2.4.201"
UNCOMPRESSED_TS = ("1.2.840.10008.1.2", "1.2.840.10008.1.2.1", "1.2.840.10008.1.2.2")

# pydicom 2.4 는 HTJ2K UID 미등록 — 전송구문으로 인식하도록 레지스트리에 추가
from pydicom._uid_dict import UID_dictionary  # noqa: E402

for _uid, _name in [("1.2.840.10008.1.2.4.201", "HTJ2K Lossless"),
                    ("1.2.840.10008.1.2.4.202", "HTJ2K Lossless RPCL"),
                    ("1.2.840.10008.1.2.4.203", "HTJ2K")]:
    UID_dictionary.setdefault(_uid, (_name, "Transfer Syntax", "", "", _name.replace(" ", "")))

_ENCODER = Path(__file__).resolve().parents[2] / "tools" / "htj2k_encode.mjs"


def encoder_available() -> bool:
    """Node + OpenJPH 코덱 사용 가능 여부 — 압축 목록 노출 게이트."""
    if not _ENCODER.exists():
        return False
    return shutil.which("node") is not None


def batch_tag(sop: str, idx: int) -> str:
    """시리즈 배치의 인스턴스별 임시 파일 이름 조각 — **반드시 유일해야 한다.**

    ⚠ 예전에는 `sop[:32]` 를 썼다. 그런데 **같은 시리즈의 SOP UID 는 앞부분이 똑같다**:

        1.2.840.113619.2.55.3.604688119.868.1700000000.1
        1.2.840.113619.2.55.3.604688119.868.1700000000.2
        → 앞 32자가 둘 다 '1.2.840.113619.2.55.3.604688119.'

    그래서 같은 이름의 .raw 를 서로 덮어써 **마지막 인스턴스의 픽셀만 남고**, Node 결과가
    out 경로로 키를 잡으니 그 한 장이 시리즈 전 인스턴스의 캐시로 복사됐다.
    스크롤해도 같은 영상이 보이는 판독 사고다(tests/test_htj2k_batch_collision.py 가 고정).

    UID 를 이름에 넣지 않는다 — 배치 안의 **순번**이 유일성의 근거고, 짧은 해시는 로그에서
    어느 인스턴스인지 되짚기 위한 것뿐이다.
    """
    h = hashlib.sha1(sop.encode("utf-8", "replace")).hexdigest()[:10]  # noqa: S324 — 식별용, 보안용 아님
    return f"b{idx:05d}_{h}"


# 배치(검사·시리즈 전체)는 오래 걸릴 수 있어 넉넉히, **단일 프레임은 짧게** 끊는다.
# ⚠ 예전에는 둘 다 1800초였다. 온디맨드 프레임 요청은 sync 핸들러가 스레드풀 스레드를 쥔 채
#   기다리므로, 인코더가 멈추면 스레드 하나가 30분간 묶인다 — 그런 요청 몇 개면 로그인이 굶는다.
NODE_TIMEOUT_BATCH = float(os.getenv("SAINTVIEW_HTJ2K_NODE_TIMEOUT", "1800"))
NODE_TIMEOUT_FRAME = float(os.getenv("SAINTVIEW_HTJ2K_FRAME_TIMEOUT", "30"))


def _run_node(jobs: list[dict], timeout: float = NODE_TIMEOUT_BATCH) -> dict[str, dict]:
    """Node OpenJPH 배치 실행 — out 경로 → 결과 dict. 타임아웃이면 빈 dict(호출부가 실패 처리)."""
    tmp = Path(tempfile.mkdtemp(prefix="htj2k_j_"))
    try:
        jobp = tmp / "jobs.json"
        jobp.write_text(json.dumps(jobs), encoding="utf-8")
        try:
            r = subprocess.run(["node", str(_ENCODER), str(jobp)],
                               capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            # 스레드를 물고 무한정 기다리지 않는다. 프레임 경로는 500 으로, 배치는 0건으로 접힌다.
            return {}
        return {x["out"]: x for x in json.loads(r.stdout or "[]")}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _frame_jobs(ds, tmp: Path, tag: str, frames: list[int]) -> list[dict]:
    frame_bytes = ds.Rows * ds.Columns * (ds.BitsAllocated // 8) * ds.SamplesPerPixel
    jobs = []
    for f in frames:
        rawp = tmp / f"{tag}_{f}.raw"
        rawp.write_bytes(ds.PixelData[f * frame_bytes:(f + 1) * frame_bytes])
        jobs.append({"raw": str(rawp), "out": str(tmp / f"{tag}_{f}.j2c"),
                     "width": int(ds.Columns), "height": int(ds.Rows),
                     "bitsPerSample": int(ds.BitsAllocated),
                     "isSigned": bool(ds.PixelRepresentation),
                     "componentCount": int(ds.SamplesPerPixel)})
    return jobs


def encode_frame(ds, frame_idx: int) -> bytes | None:
    """단일 프레임 온디맨드 인코딩 — 스트리밍 프록시용."""
    tmp = Path(tempfile.mkdtemp(prefix="htj2k_f_"))
    try:
        jobs = _frame_jobs(ds, tmp, "f", [frame_idx])
        res = _run_node(jobs, timeout=NODE_TIMEOUT_FRAME)   # 단일 프레임 — 짧게 끊는다
        r = res.get(jobs[0]["out"])
        return Path(jobs[0]["out"]).read_bytes() if r and r.get("ok") else None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def encode_frames_batch(specs: list[tuple[str, "pydicom.Dataset"]], cache_dir: Path) -> int:
    """시리즈 프리인코딩 — (sop, ds) 목록의 전 프레임을 한 번의 Node 실행으로 캐시에 기록."""
    tmp = Path(tempfile.mkdtemp(prefix="htj2k_b_"))
    done = 0
    try:
        jobs = []
        index = []  # (out, cache path)
        for sop, ds in specs:
            n = int(getattr(ds, "NumberOfFrames", 1) or 1)
            # ★ 인스턴스별 유일한 이름 — sop[:32] 는 같은 시리즈에서 충돌한다(batch_tag 주석)
            js = _frame_jobs(ds, tmp, batch_tag(sop, len(index)), list(range(n)))
            for f, j in enumerate(js):
                jobs.append(j)
                index.append((j["out"], cache_dir / f"{sop}_{f + 1}.j2c"))
        if not jobs:
            return 0
        res = _run_node(jobs)
        for out, dest in index:
            r = res.get(out)
            if r and r.get("ok"):
                # ⚠ dest.write_bytes() 로 직접 쓰면 안 된다 — 'wb' 는 먼저 0바이트로 자른다.
                #   이 배치가 도는 동안 사용자는 **바로 그 시리즈를 스크롤 중**이고(프리인코딩을
                #   촉발한 것이 그 스크롤이다), 온디맨드 경로가 만들어 둔 같은 파일을 다른
                #   스레드가 읽고 있다. 그때 자르면 빈 j2c 가 나가 뷰어에 검은 타일이 남는다.
                #   (건너뛰기 판정은 _pre_encode_series 가 sop 의 **첫 프레임**만 보므로,
                #    다중프레임에서는 여기까지 온 뒤에야 이미 있는 것이 드러난다.)
                #   내용은 (sop, frame) 에 대해 결정적이라 이미 있으면 그대로 두면 된다.
                if dest.exists():
                    continue
                part = dest.with_suffix(f".{os.getpid():x}.part")
                try:
                    part.write_bytes(Path(out).read_bytes())
                    os.replace(part, dest)
                except OSError:
                    part.unlink(missing_ok=True)
                    if not dest.exists():
                        continue
                done += 1
        return done
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def encode_study_htj2k(client, study, sdir: Path) -> tuple[int, int, int]:
    """검사 1건의 인스턴스들을 HTJ2K 무손실 DICOM 으로 기록.

    Returns: (기록 바이트 합, 기록 인스턴스 수, 폴백(원본 기록) 수)
    """
    instances = client.study_instances(study.orthanc_id)
    tmp = Path(tempfile.mkdtemp(prefix="htj2k_"))
    jobs: list[dict] = []
    metas: list[dict] = []  # {ds, frames:[raw paths], out paths} — 조립용
    total = 0
    fallbacks = 0
    written = 0
    try:
        for k, inst in enumerate(instances):
            oid = inst["orthanc_id"]
            try:
                raw = client.instance_file(oid)
            except Exception:  # noqa: BLE001 — 개별 인스턴스 실패는 건너뜀
                continue
            try:
                ds = pydicom.dcmread(io.BytesIO(raw))
                ts = str(ds.file_meta.TransferSyntaxUID)
            except Exception:  # noqa: BLE001
                ds = None
                ts = ""
            out_path = sdir / f"{inst.get('sop_uid', oid)}.dcm"
            if ds is None or ts not in UNCOMPRESSED_TS or "PixelData" not in ds:
                # 이미 압축됐거나 파싱 불가 — 원본 그대로 기록(폴백)
                out_path.write_bytes(raw)
                written += 1
                fallbacks += 1
                total += len(raw)
                continue
            n_frames = int(getattr(ds, "NumberOfFrames", 1) or 1)
            frame_bytes = ds.Rows * ds.Columns * (ds.BitsAllocated // 8) * ds.SamplesPerPixel
            frame_jobs = []
            for f in range(n_frames):
                rawp = tmp / f"{k}_{f}.raw"
                outp = tmp / f"{k}_{f}.j2c"
                rawp.write_bytes(ds.PixelData[f * frame_bytes:(f + 1) * frame_bytes])
                jobs.append({
                    "raw": str(rawp), "out": str(outp),
                    "width": int(ds.Columns), "height": int(ds.Rows),
                    "bitsPerSample": int(ds.BitsAllocated),
                    "isSigned": bool(ds.PixelRepresentation),
                    "componentCount": int(ds.SamplesPerPixel),
                })
                frame_jobs.append(outp)
            metas.append({"ds": ds, "outs": frame_jobs, "path": out_path, "orig": raw})

        if jobs:
            jobp = tmp / "jobs.json"
            jobp.write_text(json.dumps(jobs), encoding="utf-8")
            r = subprocess.run(["node", str(_ENCODER), str(jobp)],
                               capture_output=True, text=True, timeout=1800)
            results = {x["out"]: x for x in json.loads(r.stdout or "[]")}
        else:
            results = {}

        for m in metas:
            ds = m["ds"]
            codestreams = []
            ok = True
            for outp in m["outs"]:
                res = results.get(str(outp))
                if not res or not res.get("ok"):
                    ok = False
                    break
                codestreams.append(Path(outp).read_bytes())
            if not ok:
                m["path"].write_bytes(m["orig"])   # 인코딩 실패 — 원본 폴백
                written += 1
                fallbacks += 1
                total += len(m["orig"])
                continue
            ds.file_meta.TransferSyntaxUID = HTJ2K_LOSSLESS
            ds.PixelData = encapsulate(codestreams)
            ds["PixelData"].is_undefined_length = True
            buf = io.BytesIO()
            ds.save_as(buf, write_like_original=False)
            data = buf.getvalue()
            m["path"].write_bytes(data)
            written += 1
            total += len(data)
        return total, written, fallbacks
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
