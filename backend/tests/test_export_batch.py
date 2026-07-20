"""S5(PDF 출력) + F-22(일괄 검토) 검증."""
from app.db import SessionLocal
from app.services.study_service import queue_ai_job, register_study
from app.workers.ai_worker import process_once


def _make_draft(db, uid: str, *, patient: str, clinical: str = "검진") -> int:
    study = register_study(
        db,
        study_uid=uid,
        patient_key=patient,
        patient_name="테스트",
        study_date="20260611",
        modality="CR",
        body_part="CHEST",
        study_desc="Chest PA",
        clinical_info=clinical,
    )
    queue_ai_job(db, study)
    return study.id


def test_pdf_export(client, auth_headers):
    with SessionLocal() as db:
        study_id = _make_draft(db, "1.2.840.999.5.1", patient="P500")
    process_once()
    reports = client.get(f"/api/studies/{study_id}/reports", headers=auth_headers).json()["items"]
    rid = reports[0]["id"]

    r = client.get(f"/api/reports/{rid}/export?format=pdf", headers=auth_headers)
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert r.content[:5] == b"%PDF-"
    assert len(r.content) > 1500  # 실제 내용 포함

    # 미지원 형식
    assert client.get(f"/api/reports/{rid}/export?format=hl7", headers=auth_headers).status_code == 400


def test_batch_review_excludes_critical(client, auth_headers):
    with SessionLocal() as db:
        normal_id = _make_draft(db, "1.2.840.999.5.2", patient="P501")
        critical_id = _make_draft(db, "1.2.840.999.5.3", patient="P502", clinical="기흉 의심")
    process_once()

    r = client.get("/api/batch-review", headers=auth_headers)
    assert r.status_code == 200
    study_ids = [c["study_id"] for c in r.json()["items"]]
    assert normal_id in study_ids
    assert critical_id not in study_ids  # critical은 개별 검토 강제


def test_batch_finalize(client, auth_headers):
    with SessionLocal() as db:
        _make_draft(db, "1.2.840.999.5.4", patient="P503")
        _make_draft(db, "1.2.840.999.5.5", patient="P504")
    process_once()

    candidates = client.get("/api/batch-review", headers=auth_headers).json()["items"]
    ids = [c["report_id"] for c in candidates]
    assert len(ids) >= 2

    r = client.post("/api/reports/batch-finalize", headers=auth_headers, json={"report_ids": ids})
    assert r.status_code == 200
    body = r.json()
    assert body["finalized"] == len(ids)

    # 재확정은 거부
    r2 = client.post("/api/reports/batch-finalize", headers=auth_headers, json={"report_ids": ids[:1]})
    assert r2.json()["finalized"] == 0


def test_sync_seq_persisted(db):
    """Orthanc 동기화 seq가 app_setting에 영속화되는 구조 검증(클라이언트 없이 setting만)."""
    from app.services.settings_service import get_setting, set_setting

    set_setting(db, "orthanc.last_change_seq", {"seq": 42})
    assert get_setting(db, "orthanc.last_change_seq")["seq"] == 42
    set_setting(db, "orthanc.last_change_seq", {"seq": 99})
    assert get_setting(db, "orthanc.last_change_seq")["seq"] == 99


def test_setting_scope_override(db):
    """화면분석 §5.7: user > source > global 우선순위."""
    from app.services.settings_service import get_setting, set_setting

    set_setting(db, "worklist.columns", {"v": "global"})
    set_setting(db, "worklist.columns", {"v": "user1"}, scope="user", scope_id="admin")
    assert get_setting(db, "worklist.columns")["v"] == "global"
    assert get_setting(db, "worklist.columns", user="admin")["v"] == "user1"
    assert get_setting(db, "worklist.columns", user="other")["v"] == "global"
