"""검사 DICOM 반출(/api/export) — 경로 규칙·인증·ZIP 내용 검증.

Orthanc 왕복은 막고(_read/_cached_series_tree 대체), **우리 계약**만 본다:
  · manifest 경로가 환자/검사/시리즈로 갈라지는가
  · ZIP 이 그 경로 그대로 담기는가 (받는 쪽이 폴더째 열 수 있어야 한다)
  · 다운로드 전용 토큰 통로(?token=)가 헤더 없이도 통과하고, 잘못된 토큰은 막히는가
"""
from __future__ import annotations

import io
import zipfile

import pytest

from app.api import export_dicom as ex


@pytest.fixture()
def study(client, auth_headers, db):
    """반출 대상 검사 1건 — Orthanc 없이 DB 행만 만든다(트리는 아래에서 대체)."""
    from app.models import Patient, Study

    pt = db.query(Patient).filter_by(patient_key="P-EXP-01").first()
    if not pt:
        pt = Patient(patient_key="P-EXP-01", name_masked="홍길동", sex="F")
        db.add(pt)
        db.commit()
        db.refresh(pt)
    st = Study(patient_id=pt.id, modality="MG", study_date="20260727",
               study_desc="유방촬영", status="received",
               study_uid="1.2.3.4.export", orthanc_id="orth-1")
    db.add(st)
    db.commit()
    db.refresh(st)
    yield st
    db.delete(st)
    db.delete(pt)
    db.commit()


@pytest.fixture()
def fake_tree(monkeypatch):
    """시리즈 트리 2시리즈 × 2장 — Orthanc 를 타지 않는다."""
    from app.api import worklist as wl

    def tree(_client, _oid):
        return [
            {"series_uid": "1.2.3.4.1", "modality": "MG", "series_desc": "R CC",
             "series_number": 1,
             "instances": [{"orthanc_id": "i1", "sop_uid": "s1", "instance_number": 1},
                           {"orthanc_id": "i2", "sop_uid": "s2", "instance_number": 2}]},
            {"series_uid": "1.2.3.4.2", "modality": "MG", "series_desc": "L CC",
             "series_number": 2,
             "instances": [{"orthanc_id": "i3", "sop_uid": "s3", "instance_number": 1}]},
        ]

    monkeypatch.setattr(wl, "_cached_series_tree", tree)
    monkeypatch.setattr(ex, "_read", lambda db, f: b"DICM-" + f["sop_uid"].encode())
    # OrthancClient() 생성만으로 접속을 시도하지 않도록 — _entries 는 인스턴스만 만든다
    return tree


def test_manifest_paths(client, auth_headers, study, fake_tree):
    r = client.get(f"/api/export/manifest?study_ids={study.id}", headers=auth_headers)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["total_files"] == 3
    paths = [f["path"] for f in d["studies"][0]["files"]]
    # 환자ID/검사일_모달리티/S시리즈/일련번호 — 받는 쪽에서 검사가 섞이지 않는다
    assert paths[0] == "DICOM/P-EXP-01/20260727_MG/S001/000001.dcm"
    assert paths[2] == "DICOM/P-EXP-01/20260727_MG/S002/000001.dcm"


def test_zip_contains_files(client, auth_headers, study, fake_tree):
    r = client.get(f"/api/export/package?study_ids={study.id}&format=zip", headers=auth_headers)
    assert r.status_code == 200, r.text
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    names = zf.namelist()
    assert "INDEX.txt" in names
    assert "DICOM/P-EXP-01/20260727_MG/S001/000001.dcm" in names
    assert zf.read("DICOM/P-EXP-01/20260727_MG/S001/000001.dcm") == b"DICM-s1"


def test_package_accepts_query_token(client, auth_headers, study, fake_tree):
    """브라우저 내려받기는 Authorization 헤더를 못 붙인다 — ?token= 이 그 통로."""
    tok = auth_headers["Authorization"].split(" ", 1)[1]
    r = client.get(f"/api/export/package?study_ids={study.id}&format=zip&token={tok}")
    assert r.status_code == 200, r.text
    assert zipfile.ZipFile(io.BytesIO(r.content)).namelist()

    # 토큰이 아예 없거나 위조면 막힌다 — 쿼리 통로가 인증 구멍이 되면 안 된다
    assert client.get(f"/api/export/package?study_ids={study.id}").status_code == 401
    assert client.get(f"/api/export/package?study_ids={study.id}&token=bogus").status_code == 401


def test_ids_validation(client, auth_headers):
    assert client.get("/api/export/manifest?study_ids=", headers=auth_headers).status_code == 400
    assert client.get("/api/export/manifest?study_ids=abc", headers=auth_headers).status_code == 400
    many = ",".join(str(i) for i in range(1, 220))
    assert client.get(f"/api/export/manifest?study_ids={many}",
                      headers=auth_headers).status_code == 400


def test_iso_image(client, auth_headers, study, fake_tree):
    """CD 굽기용 ISO — pycdlib 가 있으면 실제 이미지를 만들고, 없으면 501 로 이유를 밝힌다."""
    pycdlib = pytest.importorskip("pycdlib")
    r = client.get(f"/api/export/package?study_ids={study.id}&format=iso", headers=auth_headers)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/x-iso9660-image"

    # 만든 이미지를 되읽어 확인 — 굽기 전에 내용이 실제로 들어 있어야 한다
    iso = pycdlib.PyCdlib()
    iso.open_fp(io.BytesIO(r.content))
    got = io.BytesIO()
    iso.get_file_from_iso_fp(got, joliet_path="/DICOM/P-EXP-01/20260727_MG/S001/000001.dcm")
    assert got.getvalue() == b"DICM-s1"
    iso.close()
