"""로컬(local.db) 환자 병합(/api/local/examctl/merge|unmerge|merges) 테스트.

서버 merge 와 동형 계약 — merge 로 slave 환자의 전 검사가 master 환자로 표시되고
(merged=True), unmerge 로 originals 스냅샷 기준 완전 원복된다. 가드(동일 환자·
UNASSIGNED 버킷·중복 병합·미존재 404)와 활성 병합 목록도 검증한다.
"""
import io

import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

from app.services.settings_service import set_setting

_CT_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.2"  # CT Image Storage


def _set_root(db, path) -> None:
    set_setting(db, "server.network", {"local_share_dir": str(path)})


def _make_dicom(
    *,
    pid="P001",
    name="Hong^Gildong",
    sex="M",
    birth_date="19700101",
    modality="CT",
    study_date="20260101",
    study_desc="CHEST CT",
    study_uid=None,
    series_uid=None,
    sop_uid=None,
) -> bytes:
    """합성 DICOM(8x8, 16bit) — test_localpacs 패턴 + PatientBirthDate 지원."""
    sop_uid = sop_uid or generate_uid()
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = _CT_SOP_CLASS
    meta.MediaStorageSOPInstanceUID = sop_uid
    meta.TransferSyntaxUID = ExplicitVRLittleEndian

    ds = Dataset()
    ds.file_meta = meta
    ds.SOPClassUID = _CT_SOP_CLASS
    ds.SOPInstanceUID = sop_uid
    ds.PatientID = pid
    ds.PatientName = name
    ds.PatientSex = sex
    ds.PatientBirthDate = birth_date
    ds.Modality = modality
    ds.StudyDate = study_date
    ds.StudyDescription = study_desc
    ds.StudyInstanceUID = study_uid or generate_uid()
    ds.SeriesInstanceUID = series_uid or generate_uid()
    ds.SeriesNumber = 1
    ds.InstanceNumber = 1
    ds.Rows = 8
    ds.Columns = 8
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 0
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.PixelData = (np.arange(64, dtype=np.uint16) * 100).tobytes()
    ds.is_little_endian = True
    ds.is_implicit_VR = False

    buf = io.BytesIO()
    ds.save_as(buf, write_like_original=False)
    return buf.getvalue()


def _import_study(client, auth_headers, **kwargs) -> dict:
    """검사 1건(이미지 1장) 업로드 후 study dict 반환."""
    data = _make_dicom(**kwargs)
    files = [("files", ("a.dcm", io.BytesIO(data), "application/octet-stream"))]
    r = client.post("/api/local/import", files=files, headers=auth_headers)
    assert r.status_code == 200, r.text
    return r.json()["studies"][0]


def _rows(client, auth_headers) -> list[dict]:
    return client.get("/api/local/examctl/studies", headers=auth_headers).json()["items"]


def _row(client, auth_headers, sid) -> dict:
    return next(i for i in _rows(client, auth_headers) if i["id"] == sid)


def test_merge_requires_auth(client):
    """미인증 401 — merge/unmerge/merges 전 엔드포인트."""
    assert client.post("/api/local/examctl/merge",
                       json={"master_study_id": 1, "slave_study_id": 2}).status_code == 401
    assert client.post("/api/local/examctl/unmerge", json={"study_id": 1}).status_code == 401
    assert client.get("/api/local/examctl/merges").status_code == 401


def test_merge_requires_permission(client, auth_headers):
    """권한 게이트 — 서버 병합과 동일하게 study.match/unmatch 없으면(staff) 403."""
    r = client.post("/api/admin/accounts", headers=auth_headers, json={
        "username": "lm_staff1", "password": "testpass123", "role": "staff"})
    assert r.status_code == 200, r.text
    tok = client.post("/api/auth/login",
                      json={"username": "lm_staff1", "password": "testpass123"})
    assert tok.status_code == 200, tok.text
    staff = {"Authorization": f"Bearer {tok.json()['token']}"}
    assert client.post("/api/local/examctl/merge", headers=staff,
                       json={"master_study_id": 1, "slave_study_id": 2}).status_code == 403
    assert client.post("/api/local/examctl/unmerge", headers=staff,
                       json={"study_id": 1}).status_code == 403


def test_merge_unmerge_roundtrip(client, db, auth_headers, tmp_path):
    """merge → slave 검사가 master 환자로 표시(merged=True) → unmerge 완전 원복."""
    root = tmp_path / "share"
    _set_root(db, root)
    master = _import_study(client, auth_headers, pid="PA", name="Kim^Master",
                           sex="M", birth_date="19700101")
    slave = _import_study(client, auth_headers, pid="PB", name="Lee^Slave",
                          sex="F", birth_date="19800202")

    # 병합 실행 — slave 환자 전 검사(1건)가 이동
    r = client.post(
        "/api/local/examctl/merge",
        json={"master_study_id": master["id"], "slave_study_id": slave["id"]},
        headers=auth_headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["moved"] == 1
    merge_id = body["merge_id"]

    # slave 검사 행이 master 환자 4필드로 표시 + merged=True, master 도 merged=True
    sl = _row(client, auth_headers, slave["id"])
    assert sl["patient_key"] == "PA" and sl["patient_name"] == "Kim^Master"
    assert sl["sex"] == "M" and sl["merged"] is True
    assert _row(client, auth_headers, master["id"])["merged"] is True

    # 일반 목록(/api/local/studies)도 동일 계산 소비
    items = client.get("/api/local/studies", headers=auth_headers).json()["items"]
    assert next(i for i in items if i["id"] == slave["id"])["merged"] is True

    # 활성 병합 목록 — 서버 동형 항목(master/slave 스냅샷 + moved_study_ids)
    merges = client.get("/api/local/examctl/merges", headers=auth_headers).json()["items"]
    hit = next(m for m in merges if m["id"] == merge_id)
    assert hit["master"] == {"patient_key": "PA", "patient_name": "Kim^Master"}
    assert hit["slave"] == {"patient_key": "PB", "patient_name": "Lee^Slave"}
    assert hit["moved_study_ids"] == [slave["id"]]
    assert hit["created_at"]

    # unmerge(이동된 검사 study_id 로 병합 역해석) → 원복
    u = client.post("/api/local/examctl/unmerge", json={"study_id": slave["id"]},
                    headers=auth_headers)
    assert u.status_code == 200, u.text
    assert u.json()["restored"] == 1
    sl2 = _row(client, auth_headers, slave["id"])
    assert sl2["patient_key"] == "PB" and sl2["patient_name"] == "Lee^Slave"
    assert sl2["sex"] == "F" and sl2["merged"] is False
    assert _row(client, auth_headers, master["id"])["merged"] is False
    merges2 = client.get("/api/local/examctl/merges", headers=auth_headers).json()["items"]
    assert all(m["id"] != merge_id for m in merges2)

    # 감사 로그(서버 DB) — local_examctl_merge / unmerge
    from sqlalchemy import select

    from app.models import AuditLog

    actions = {
        a for (a,) in db.execute(
            select(AuditLog.action).where(AuditLog.action.like("local_examctl_%"))
        ).all()
    }
    assert {"local_examctl_merge", "local_examctl_unmerge"} <= actions


def test_merge_moves_all_slave_studies(client, db, auth_headers, tmp_path):
    """slave 환자의 검사가 여럿이면 전부 이동(moved=N)·전부 원복된다."""
    root = tmp_path / "share"
    _set_root(db, root)
    master = _import_study(client, auth_headers, pid="PA", name="Kim^Master")
    s1 = _import_study(client, auth_headers, pid="PB", name="Lee^Slave",
                       study_date="20260101")
    s2 = _import_study(client, auth_headers, pid="PB", name="Lee^Slave",
                       study_date="20260202", study_desc="BRAIN MR", modality="MR")
    assert s1["id"] != s2["id"]

    r = client.post(
        "/api/local/examctl/merge",
        json={"master_study_id": master["id"], "slave_study_id": s1["id"]},
        headers=auth_headers,
    )
    assert r.status_code == 200 and r.json()["moved"] == 2
    for sid in (s1["id"], s2["id"]):
        row = _row(client, auth_headers, sid)
        assert row["patient_key"] == "PA" and row["merged"] is True

    # merge_id 로 직접 해제
    u = client.post("/api/local/examctl/unmerge",
                    json={"merge_id": r.json()["merge_id"]}, headers=auth_headers)
    assert u.status_code == 200 and u.json()["restored"] == 2
    for sid in (s1["id"], s2["id"]):
        row = _row(client, auth_headers, sid)
        assert row["patient_key"] == "PB" and row["merged"] is False


def test_merge_guards(client, db, auth_headers, tmp_path):
    """가드 — 동일 환자 400 / UNASSIGNED 버킷 400 / 중복 병합 400 / 미존재 404."""
    root = tmp_path / "share"
    _set_root(db, root)
    a = _import_study(client, auth_headers, pid="PA", name="A^A")
    b = _import_study(client, auth_headers, pid="PB", name="B^B")
    c = _import_study(client, auth_headers, pid="PC", name="C^C")
    d = _import_study(client, auth_headers, pid="PD", name="D^D")
    a2 = _import_study(client, auth_headers, pid="PA", name="A^A",
                       study_date="20260505")

    # 동일 환자(같은 patient_key) → 400 (자기 자신 포함)
    assert client.post("/api/local/examctl/merge",
                       json={"master_study_id": a["id"], "slave_study_id": a2["id"]},
                       headers=auth_headers).status_code == 400
    assert client.post("/api/local/examctl/merge",
                       json={"master_study_id": a["id"], "slave_study_id": a["id"]},
                       headers=auth_headers).status_code == 400

    # 미존재 검사 → 404
    assert client.post("/api/local/examctl/merge",
                       json={"master_study_id": a["id"], "slave_study_id": 999999},
                       headers=auth_headers).status_code == 404

    # UNASSIGNED 버킷(study_uid=="local.unassigned") → 400 (master/slave 어느 쪽이든)
    se = generate_uid()
    e = _import_study(client, auth_headers, pid="PE", name="E^E", series_uid=se)
    u = client.post("/api/local/examctl/unassign", json={"series_uids": [se]},
                    headers=auth_headers)
    bucket_id = u.json()["bucket_study_id"]
    for payload in (
        {"master_study_id": bucket_id, "slave_study_id": a["id"]},
        {"master_study_id": a["id"], "slave_study_id": bucket_id},
    ):
        assert client.post("/api/local/examctl/merge", json=payload,
                           headers=auth_headers).status_code == 400

    # A←B 병합 성립 후 중복 가드
    ok = client.post("/api/local/examctl/merge",
                     json={"master_study_id": a["id"], "slave_study_id": b["id"]},
                     headers=auth_headers)
    assert ok.status_code == 200, ok.text
    # slave(B) 가 이미 활성 병합의 slave → 400
    assert client.post("/api/local/examctl/merge",
                       json={"master_study_id": c["id"], "slave_study_id": b["id"]},
                       headers=auth_headers).status_code == 400
    # slave(A) 가 활성 병합의 master → 400
    assert client.post("/api/local/examctl/merge",
                       json={"master_study_id": d["id"], "slave_study_id": a["id"]},
                       headers=auth_headers).status_code == 400
    # master(B... 의 현재 환자키는 PA) — B 검사로 master 지정 시 PA 취급이므로
    # 원 slave 환자(PB)가 master 인 경우를 별도 재현: C←D 병합 후 D 를 master 로 → 400
    ok2 = client.post("/api/local/examctl/merge",
                      json={"master_study_id": c["id"], "slave_study_id": d["id"]},
                      headers=auth_headers)
    assert ok2.status_code == 200, ok2.text
    # d 행은 이제 PC 환자 — PC 는 활성 병합의 master 지만 master 역할 중복은 허용
    e2 = _import_study(client, auth_headers, pid="PF", name="F^F")
    multi = client.post("/api/local/examctl/merge",
                        json={"master_study_id": c["id"], "slave_study_id": e2["id"]},
                        headers=auth_headers)
    assert multi.status_code == 200, multi.text  # master 다중 병합 허용


def test_unmerge_not_found_and_master_study_lookup(client, db, auth_headers, tmp_path):
    """unmerge — 빈 요청 400, 병합 없음 404, master 환자 검사 study_id 로 해제."""
    root = tmp_path / "share"
    _set_root(db, root)
    a = _import_study(client, auth_headers, pid="PA", name="A^A")
    b = _import_study(client, auth_headers, pid="PB", name="B^B")

    # study_id/merge_id 모두 없음 → 400
    assert client.post("/api/local/examctl/unmerge", json={},
                       headers=auth_headers).status_code == 400
    # 활성 병합 없음 → 404 (검사 미존재도 404)
    assert client.post("/api/local/examctl/unmerge", json={"study_id": a["id"]},
                       headers=auth_headers).status_code == 404
    assert client.post("/api/local/examctl/unmerge", json={"study_id": 999999},
                       headers=auth_headers).status_code == 404
    assert client.post("/api/local/examctl/unmerge", json={"merge_id": 999999},
                       headers=auth_headers).status_code == 404

    # 병합 후 master 환자의 검사 study_id 로 해제(이동 검사가 아니어도 역해석)
    r = client.post("/api/local/examctl/merge",
                    json={"master_study_id": a["id"], "slave_study_id": b["id"]},
                    headers=auth_headers)
    assert r.status_code == 200
    u = client.post("/api/local/examctl/unmerge", json={"study_id": a["id"]},
                    headers=auth_headers)
    assert u.status_code == 200 and u.json()["restored"] == 1
    assert _row(client, auth_headers, b["id"])["patient_key"] == "PB"
    # 이미 해제된 병합 재해제 → 404 (undone=1 은 비활성)
    assert client.post("/api/local/examctl/unmerge",
                       json={"merge_id": r.json()["merge_id"]},
                       headers=auth_headers).status_code == 404
