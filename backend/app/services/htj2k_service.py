"""HTJ2K(OpenJPH) 자체 인코딩 서비스 — 백업 저장 시점 변환.

Orthanc(1.12.11)는 HTJ2K 트랜스코딩·디코딩을 아직 지원하지 않으므로(실측: rendered/preview 415,
WADO-RS frames 500), 진단 원본은 Orthanc 에 그대로 두고 **백업 파일 생성 시** HTJ2K 무손실로
변환해 기록한다. 인코더는 프론트 의존성의 OpenJPH WASM(@cornerstonejs/codec-openjph)을
Node CLI(tools/htj2k_encode.mjs)로 재사용 — 실측 무손실 압축률 ~6%(2,097,152B→121,269B).

검사(Study) 단위 배치: 인스턴스 프레임들을 한 번의 Node 실행으로 인코딩(WASM 초기화 1회).
비압축(Implicit/Explicit LE·BE) 인스턴스만 변환하고, 이미 압축된 인스턴스는 원본 그대로 기록(폴백).
"""
from __future__ import annotations

import io
import json
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


def _run_node(jobs: list[dict]) -> dict[str, dict]:
    """Node OpenJPH 배치 실행 — out 경로 → 결과 dict."""
    tmp = Path(tempfile.mkdtemp(prefix="htj2k_j_"))
    try:
        jobp = tmp / "jobs.json"
        jobp.write_text(json.dumps(jobs), encoding="utf-8")
        r = subprocess.run(["node", str(_ENCODER), str(jobp)],
                           capture_output=True, text=True, timeout=1800)
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
        res = _run_node(jobs)
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
            js = _frame_jobs(ds, tmp, sop[:32], list(range(n)))
            for f, j in enumerate(js):
                jobs.append(j)
                index.append((j["out"], cache_dir / f"{sop}_{f + 1}.j2c"))
        if not jobs:
            return 0
        res = _run_node(jobs)
        for out, dest in index:
            r = res.get(out)
            if r and r.get("ok"):
                dest.write_bytes(Path(out).read_bytes())
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
