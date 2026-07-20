"""3차: DICOM SR 변환·설정 API·AI 품질 통계 검증."""
import io

import pydicom

from app.db import SessionLocal
from app.services.study_service import queue_ai_job, register_study
from app.workers.ai_worker import process_once


def _draft_study(db, uid: str, patient: str):
    study = register_study(
        db, study_uid=uid, patient_key=patient, patient_name="홍길동",
        study_date="20260611", modality="CT", body_part="CHEST",
        study_desc="CT Chest", clinical_info="검진",
    )
    queue_ai_job(db, study)
    return study.id


def test_dicom_sr_export(client, auth_headers):
    with SessionLocal() as db:
        study_id = _draft_study(db, "1.2.840.999.8.1", "P800")
    process_once()
    reports = client.get(f"/api/studies/{study_id}/reports", headers=auth_headers).json()["items"]
    rid = reports[0]["id"]
    client.post(f"/api/reports/{rid}/finalize", headers=auth_headers)

    r = client.get(f"/api/reports/{rid}/export?format=dicom-sr", headers=auth_headers)
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/dicom"

    ds = pydicom.dcmread(io.BytesIO(r.content))
    assert ds.Modality == "SR"
    assert ds.SOPClassUID == "1.2.840.10008.5.1.4.1.1.88.11"  # Basic Text SR
    assert ds.StudyInstanceUID == "1.2.840.999.8.1"  # 동일 Study 귀속
    assert ds.VerificationFlag == "VERIFIED"
    assert ds.PatientID == "P800"
    # 섹션 존재
    concepts = [item.ConceptNameCodeSequence[0].CodeMeaning for item in ds.ContentSequence]
    assert "Findings" in concepts
    assert "Impressions" in concepts


def test_send_sr_requires_finalized(client, auth_headers):
    with SessionLocal() as db:
        study_id = _draft_study(db, "1.2.840.999.8.2", "P801")
    process_once()
    reports = client.get(f"/api/studies/{study_id}/reports", headers=auth_headers).json()["items"]
    rid = reports[0]["id"]
    # draft 상태에서는 409 (Orthanc 가용 여부와 무관하게 먼저 검사)
    r = client.post(f"/api/reports/{rid}/send-sr", headers=auth_headers)
    assert r.status_code == 409


def test_settings_api(client, auth_headers):
    # 관리자 전역 설정
    r = client.put("/api/settings/pdf.template", headers=auth_headers,
                   json={"value": {"hospital": "테스트병원"}, "scope": "global"})
    assert r.status_code == 200
    r = client.get("/api/settings/pdf.template", headers=auth_headers)
    assert r.json()["value"]["hospital"] == "테스트병원"
    # 화이트리스트 밖 키 거부
    assert client.get("/api/settings/hacky.key", headers=auth_headers).status_code == 404
    # 사용자 scope 저장
    r = client.put("/api/settings/worklist.prefs", headers=auth_headers,
                   json={"value": {"auto_refresh_sec": 5}, "scope": "user"})
    assert r.status_code == 200
    assert client.get("/api/settings/worklist.prefs", headers=auth_headers).json()["value"][
        "auto_refresh_sec"] == 5


def test_ai_quality_metrics(client, auth_headers):
    with SessionLocal() as db:
        study_id = _draft_study(db, "1.2.840.999.8.3", "P802")
    process_once()
    reports = client.get(f"/api/studies/{study_id}/reports", headers=auth_headers).json()["items"]
    client.post(f"/api/reports/{reports[0]['id']}/finalize", headers=auth_headers)

    r = client.get("/api/admin/ai-quality", headers=auth_headers)
    assert r.status_code == 200
    body = r.json()
    assert body["with_ai_draft"] >= 1
    assert 0.0 <= body["acceptance_rate"] <= 1.0
    assert "critical_dropped" in body
