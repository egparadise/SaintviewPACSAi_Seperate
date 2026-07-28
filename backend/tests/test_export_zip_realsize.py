"""ZIP 반출을 **실 크기 페이로드**로 — 4MB 흘려보내기 분기를 실제로 태운다.

기존 test_export_dicom.py 는 _read 를 12바이트로 대체해 4MB flush 분기가 돌지 않는다.
여기서는 실 DICOM 크기(512KB/장)를 돌려주게 해 분기를 태운다.
"""
from __future__ import annotations

import hashlib
import io
import zipfile

import pytest

from app.api import export_dicom as ex

SLICE = 512 * 1024          # CT 슬라이스 한 장 대략치
N = 40                      # 20MB — 실사용에서는 흔한 크기(CT 1건)


def _payload(sop: str) -> bytes:
    seed = hashlib.sha256(sop.encode()).digest()
    return b"DICM" + seed + b"\xab" * (SLICE - 36)


@pytest.fixture()
def big_study(db):
    from app.models import Patient, Study

    pt = db.query(Patient).filter_by(patient_key="P-BIG-99").first()
    if not pt:
        pt = Patient(patient_key="P-BIG-99", name_masked="대용량", sex="M")
        db.add(pt); db.commit(); db.refresh(pt)
    st = Study(patient_id=pt.id, modality="CT", study_date="20260728",
               study_desc="CHEST", status="received",
               study_uid="1.2.3.9.big", orthanc_id="orth-big")
    db.add(st); db.commit(); db.refresh(st)
    yield st
    db.delete(st); db.delete(pt); db.commit()


@pytest.fixture()
def big_tree(monkeypatch):
    from app.api import worklist as wl

    def tree(_client, _oid):
        return [{"series_uid": "1.2.3.9.1", "modality": "CT", "series_desc": "AX",
                 "series_number": 1,
                 "instances": [{"orthanc_id": f"i{i}", "sop_uid": f"sop{i}",
                                "instance_number": i} for i in range(1, N + 1)]}]

    monkeypatch.setattr(wl, "_cached_series_tree", tree)
    monkeypatch.setattr(ex, "_read", lambda db, f: _payload(f["sop_uid"]))


def test_real_size_zip_is_readable(client, auth_headers, big_study, big_tree):
    r = client.get(f"/api/export/package?study_ids={big_study.id}&format=zip",
                   headers=auth_headers)
    assert r.status_code == 200, r.text
    blob = r.content
    print(f"\n[산출] {len(blob):,}B  (실 payload {N*SLICE:,}B)")
    print(f"[0x00] {blob.count(bytes(1)):,}B")

    # 0 채움 회귀 감지 — 되감기 버그일 때 산출이 페이로드의 3~7배로 부풀었다
    # (BytesIO 가 EOF 너머 seek 의 간극을 0x00 으로 메운 결과).
    assert len(blob) < N * SLICE + 64 * 1024, f"스트림이 부풀었다: {len(blob):,}B"

    zf = zipfile.ZipFile(io.BytesIO(blob))
    names = [n for n in zf.namelist() if n.endswith(".dcm")]
    print(f"[항목] {len(zf.namelist())}  dcm={len(names)}")
    # 중앙디렉터리 오프셋이 실제 로컬 헤더와 맞는지 — 손상의 1차 관문
    assert zf.testzip() is None, "ZIP 무결성 검사 실패(로컬 헤더 오프셋 어긋남)"
    assert len(names) == N

    bad = []
    for n in names:
        try:
            data = zf.read(n)
        except Exception as e:  # noqa: BLE001
            bad.append((n, f"{type(e).__name__}: {e}")); continue
        if len(data) != SLICE or not data.startswith(b"DICM"):
            bad.append((n, f"길이 {len(data)}"))
    print(f"[깨진 항목] {len(bad)}/{len(names)}  첫: {bad[0] if bad else None}")
    assert not bad, f"{len(bad)}/{len(names)} 손상"
