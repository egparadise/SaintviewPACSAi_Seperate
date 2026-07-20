"""E2E: 검사 등록 → AI 워커 초안 → 워크리스트 → 수정 → 확정(환류+불일치 지표).

설계 핵심 흐름(§1)과 F-14/F-15/F-20을 API 레벨에서 검증한다.
"""
from app.db import SessionLocal
from app.models import ReportEmbedding, Study
from app.services.study_service import queue_ai_job, register_study
from app.workers.ai_worker import process_once


def _register(db, uid: str, *, patient="P100", name="홍길동", date="20260601", clinical="", desc="CT Chest"):
    return register_study(
        db,
        study_uid=uid,
        patient_key=patient,
        patient_name=name,
        birth_date="19600101",
        sex="M",
        accession_no=f"A{uid[-4:]}",
        study_date=date,
        modality="CT",
        body_part="CHEST",
        study_desc=desc,
        clinical_info=clinical,
    )


def test_full_reading_workflow(client, auth_headers):
    # 1) 검사 등록 + AI 작업 큐
    with SessionLocal() as db:
        study = _register(db, "1.2.840.999.1.1", clinical="만성 기침, 추적 검사")
        queue_ai_job(db, study)
        study_id = study.id

    # 2) 워커 1회 실행 → 초안 생성
    assert process_once() >= 1
    with SessionLocal() as db:
        s = db.get(Study, study_id)
        assert s.status == "draft_ready"

    # 3) 워크리스트에서 초안 상태·임프레션 미리보기 확인 (디자인 §3.1 [C])
    r = client.get("/api/worklist", headers=auth_headers, params={"q": "P100"})
    assert r.status_code == 200
    row = next(i for i in r.json()["items"] if i["id"] == study_id)
    assert row["report_status"] == "draft"
    assert row["impression_preview"]

    # 4) 검사 상세 — Related Exams (F-14)
    with SessionLocal() as db:
        _register(db, "1.2.840.999.1.2", date="20250101", desc="CT Chest (prior)")
    detail = client.get(f"/api/studies/{study_id}", headers=auth_headers).json()
    assert any(e["study_uid"] == "1.2.840.999.1.2" for e in detail["related_exams"])

    # 5) 리포트 수정(in_review) → 확정
    reports = client.get(f"/api/studies/{study_id}/reports", headers=auth_headers).json()["items"]
    draft = reports[0]
    assert draft["created_by"] == "ai"
    sr = draft["sr_json"]
    sr["impression"][0]["statement"] = "판독의 수정: 특이 소견 없음."
    r = client.put(f"/api/reports/{draft['id']}", headers=auth_headers, json={"sr_json": sr})
    assert r.status_code == 200
    assert r.json()["status"] == "in_review"

    r = client.post(f"/api/reports/{draft['id']}/finalize", headers=auth_headers)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "finalized"
    # F-20: 불일치 지표
    dm = body["diff_metrics"]
    assert dm["has_ai_draft"] is True
    assert 0.0 <= dm["modified_ratio"] <= 1.0

    # 6) 환류 인제스트 확인 (설계 §4.1)
    with SessionLocal() as db:
        chunks = db.query(ReportEmbedding).filter_by(report_id=draft["id"]).count()
        assert chunks >= 1

    # 7) 확정본 재수정 차단 (워크플로 게이트)
    r = client.put(f"/api/reports/{draft['id']}", headers=auth_headers, json={"sr_json": sr})
    assert r.status_code == 409


def test_critical_promotes_emergency(client, auth_headers):
    """critical 소견 → emergency 플래그 + 워크리스트 최상단 (F-15, 설계 §6.2)."""
    with SessionLocal() as db:
        study = _register(
            db, "1.2.840.999.2.1", patient="P200", name="김철수", clinical="기흉 의심", desc="Chest PA"
        )
        queue_ai_job(db, study)
        study_id = study.id
    process_once()

    r = client.get("/api/worklist", headers=auth_headers, params={"q": "P200"})
    row = next(i for i in r.json()["items"] if i["id"] == study_id)
    assert row["critical"] is True
    assert row["emergency"] is True

    # Emergency가 일반 검사보다 위에 정렬되는지
    r = client.get("/api/worklist", headers=auth_headers)
    items = r.json()["items"]
    emergency_idx = [i for i, x in enumerate(items) if x["emergency"]]
    normal_idx = [i for i, x in enumerate(items) if not x["emergency"]]
    if emergency_idx and normal_idx:
        assert max(emergency_idx) < min(normal_idx)


def test_rag_uses_patient_priors(client, auth_headers):
    """과거 확정 판독이 다음 초안의 comparison에 반영되는지 (설계 §4.2 축1)."""
    with SessionLocal() as db:
        prior = _register(db, "1.2.840.999.3.1", patient="P300", name="이영희", date="20250101")
        queue_ai_job(db, prior)
    process_once()
    # 과거 검사 확정
    with SessionLocal() as db:
        prior_id = db.query(Study).filter_by(study_uid="1.2.840.999.3.1").one().id
    reports = client.get(f"/api/studies/{prior_id}/reports", headers=auth_headers).json()["items"]
    client.post(f"/api/reports/{reports[0]['id']}/finalize", headers=auth_headers)

    # 신규 검사 → 초안의 prior_study_refs에 과거 검사 포함
    with SessionLocal() as db:
        new = _register(db, "1.2.840.999.3.2", patient="P300", name="이영희", date="20260610")
        queue_ai_job(db, new)
        new_id = new.id
    process_once()
    reports = client.get(f"/api/studies/{new_id}/reports", headers=auth_headers).json()["items"]
    sr = reports[0]["sr_json"]
    assert "1.2.840.999.3.1" in sr["comparison"]["prior_study_refs"]
    assert reports[0]["ai_sources"]["prior_report_ids"]


def test_auth_required(client):
    assert client.get("/api/worklist").status_code == 401
