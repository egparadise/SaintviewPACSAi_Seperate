"""34차 — 서버 관리 2단계: 저장공간·백업·압축."""
from __future__ import annotations

import httpx
import pytest

from app.models import BackupJob
from app.services.backup_service import (
    COMPRESSION_LABELS,
    TRANSFER_SYNTAX,
    maybe_run_scheduled_backup,
    run_backup_job,
)
from app.services.study_service import register_study


class FakeOrthanc:
    """run_backup_job 주입용 — 실제 Orthanc 없이 인스턴스/트랜스코드 시뮬레이션."""

    def __init__(self, instances, fail_transcode=False):
        self._instances = instances  # orthanc_study_id → [{orthanc_id, sop_uid, instance_number}]
        self.fail_transcode = fail_transcode

    def alive(self):
        return True

    def study_instances(self, oid):
        return self._instances.get(oid, [])

    def instance_file(self, oid, transcode=None):
        if transcode and self.fail_transcode:
            raise httpx.HTTPError("코덱 없음")
        return b"DICM-" + oid.encode()

    def close(self):
        pass


def _mk_study(db, uid, oid, date):
    s = register_study(db, study_uid=uid, patient_key=f"P-{uid}", patient_name="홍^길동",
                       study_date=date, modality="CT", orthanc_id=oid)
    return s


def test_compression_catalog():
    # 압축 키와 라벨이 1:1, 전송구문 UID 매핑 존재
    assert set(TRANSFER_SYNTAX) == set(COMPRESSION_LABELS)
    assert TRANSFER_SYNTAX["jpeg2000_lossless"] == "1.2.840.10008.1.2.4.90"


def test_run_backup_job_writes_files(db, tmp_path):
    s = _mk_study(db, "B-UID-1", "ORTH-1", "20240101")
    insts = {"ORTH-1": [
        {"orthanc_id": "i1", "sop_uid": "sop1", "instance_number": 1},
        {"orthanc_id": "i2", "sop_uid": "sop2", "instance_number": 2},
    ]}
    job = BackupJob(kind="manual", status="queued", compression="jpeg2000_lossless",
                    target_dir=str(tmp_path), date_from="20231231", date_to="20240102")
    db.add(job); db.commit(); db.refresh(job)
    run_backup_job(db, job.id, client=FakeOrthanc(insts))
    db.refresh(job)
    assert job.status == "done", job.error
    assert job.instance_count == 2 and job.study_count == 1
    assert job.total_bytes > 0
    written = list(tmp_path.rglob("*.dcm"))
    assert len(written) == 2
    _ = s


def test_run_backup_job_transcode_fallback(db, tmp_path):
    _mk_study(db, "B-UID-2", "ORTH-2", "20240105")
    insts = {"ORTH-2": [{"orthanc_id": "j1", "sop_uid": "sopj1", "instance_number": 1}]}
    job = BackupJob(kind="manual", status="queued", compression="jpeg",
                    target_dir=str(tmp_path), date_from="", date_to="")
    db.add(job); db.commit(); db.refresh(job)
    # 트랜스코드 실패 → 원본 폴백으로 저장(상태는 done, error에 폴백 안내)
    run_backup_job(db, job.id, client=FakeOrthanc(insts, fail_transcode=True))
    db.refresh(job)
    assert job.status == "done"
    assert job.instance_count == 1
    assert "폴백" in job.error
    assert len(list(tmp_path.rglob("*.dcm"))) == 1


def test_scheduled_backup_runs_when_due(db, tmp_path):
    from datetime import datetime

    from app.services.backup_service import set_policy

    set_policy(db, {"enabled": True, "schedule_time": "00:00", "compression": "none",
                    "target_dir": str(tmp_path)})
    _mk_study(db, "B-UID-3", "ORTH-3", "20240110")
    insts = {"ORTH-3": [{"orthanc_id": "k1", "sop_uid": "sopk1", "instance_number": 1}]}
    # now=정오 → 00:00 예정 지남 → 실행
    job = maybe_run_scheduled_backup(db, now=datetime(2024, 6, 13, 12, 0),
                                     client=FakeOrthanc(insts))
    assert job is not None and job.kind == "scheduled" and job.status == "done"
    # 같은 날 재호출 → None(중복 방지)
    again = maybe_run_scheduled_backup(db, now=datetime(2024, 6, 13, 13, 0),
                                       client=FakeOrthanc(insts))
    assert again is None


def test_policy_and_storage_endpoints(client, auth_headers):
    # 정책 저장/조회
    r = client.put("/api/admin/backup/policy", headers=auth_headers, json={
        "enabled": True, "schedule_time": "03:30", "retention_days": 30,
        "compression": "jpeg2000_lossless", "target_dir": "",
    })
    assert r.status_code == 200, r.text
    assert r.json()["compression"] == "jpeg2000_lossless"
    assert client.get("/api/admin/backup/policy", headers=auth_headers).json()["retention_days"] == 30
    # 잘못된 압축은 none으로 보정
    r2 = client.put("/api/admin/backup/policy", headers=auth_headers, json={"compression": "bogus"})
    assert r2.json()["compression"] == "none"
    # 압축 카탈로그
    comps = client.get("/api/admin/backup/compressions", headers=auth_headers).json()["items"]
    assert any(c["key"] == "jpeg2000_lossless" for c in comps)
    # 저장공간 현황(Orthanc 유무와 무관하게 200)
    st = client.get("/api/admin/storage", headers=auth_headers)
    assert st.status_code == 200, st.text
    assert "policy" in st.json() and "disk" in st.json()
    # 수동 백업 실행(작업 생성) — 미래 날짜 범위로 대상 0건(백그라운드 스레드 즉시 종료)
    run = client.post("/api/admin/backup/run", headers=auth_headers,
                      json={"compression": "none", "date_from": "29990101", "date_to": "29991231"})
    assert run.status_code == 200, run.text
    assert run.json()["status"] in ("queued", "running", "done", "failed")
    jobs = client.get("/api/admin/backup/jobs", headers=auth_headers).json()["items"]
    assert len(jobs) >= 1


def test_backup_real_jpeg2000_transcode(db, tmp_path):
    """통합 — 실제 Orthanc에서 JPEG2000 무손실로 백업, 출력 전송구문 확인(미가동 시 skip)."""
    import io

    import pydicom

    from app.dicom.orthanc import OrthancClient

    c = OrthancClient()
    try:
        if not c.alive():
            pytest.skip("Orthanc 미가동 — 통합 테스트 건너뜀")
        studies = c._client.get("/studies").json()
        if not studies:
            pytest.skip("Orthanc에 검사 없음")
        sid = studies[0]
        uid = c.study_metadata(sid)["MainDicomTags"]["StudyInstanceUID"]
    finally:
        c.close()

    _mk_study(db, uid + "-bkp", sid, "20260101")  # orthanc_id = 실제 Orthanc study id
    job = BackupJob(kind="manual", status="queued", compression="jpeg2000_lossless",
                    target_dir=str(tmp_path), date_from="", date_to="")
    db.add(job); db.commit(); db.refresh(job)
    run_backup_job(db, job.id)  # 실제 OrthancClient 사용
    db.refresh(job)
    assert job.status == "done", job.error
    assert job.instance_count >= 1 and job.total_bytes > 0
    files = list(tmp_path.rglob("*.dcm"))
    assert files
    ds = pydicom.dcmread(io.BytesIO(files[0].read_bytes()))
    assert str(ds.file_meta.TransferSyntaxUID) == "1.2.840.10008.1.2.4.90", "JPEG2000 무손실로 변환되지 않음"


def test_purge_requires_confirm(client, auth_headers):
    # confirm 없으면 거부
    r = client.post("/api/admin/storage/purge", headers=auth_headers,
                    json={"retention_days": 1})
    assert r.status_code == 400
    # 미리보기는 삭제하지 않음
    p = client.post("/api/admin/storage/purge-preview", headers=auth_headers,
                    json={"retention_days": 1})
    assert p.status_code == 200
    assert "count" in p.json()
