"""12차 — 자연어검색(S1 nl_to_query)·묶음판독(report_merge)·Mode Profile JSON(S7) 검증."""
from app.db import SessionLocal
from app.services.study_service import queue_ai_job, register_study
from app.workers.ai_worker import process_once


def _make_study(db, uid: str, *, patient: str, modality: str = "CR",
                study_date: str = "20260611", desc: str = "Chest PA", draft: bool = True) -> tuple[int, str]:
    study = register_study(
        db,
        study_uid=uid,
        patient_key=patient,
        patient_name="테스트",
        study_date=study_date,
        modality=modality,
        body_part="CHEST",
        study_desc=desc,
        clinical_info="검진",
    )
    if draft:
        queue_ai_job(db, study)
    return study.id, study.study_uid


# ── S1 자연어 검색 ───────────────────────────────────────────


def test_nl_query_mock_parses_korean(client, auth_headers):
    r = client.post("/api/worklist/nl-query", headers=auth_headers,
                    json={"text": "지난주 흉부 CT 미판독 열어줘"})
    assert r.status_code == 200
    body = r.json()
    f = body["filter"]
    assert f["modality"] == "CT"
    assert f["body_part"] == "CHEST"
    assert f["status"] == "unread"
    assert len(f["date_from"]) == 8 and len(f["date_to"]) == 8
    assert f["date_from"] < f["date_to"]
    assert body["explanation"]  # 미리보기 설명 필수(S1: 적용 전 사용자 확인)
    assert body["source"] == "mock"


def test_nl_query_emergency_and_status(client, auth_headers):
    r = client.post("/api/worklist/nl-query", headers=auth_headers,
                    json={"text": "오늘 응급 MR 확정된 것"})
    f = r.json()["filter"]
    assert f["modality"] == "MR"
    assert f["status"] == "finalized"
    assert f["emergency"] is True
    assert f["date_from"] == f["date_to"]


def test_nl_query_rejects_empty(client, auth_headers):
    r = client.post("/api/worklist/nl-query", headers=auth_headers, json={"text": "   "})
    assert r.status_code == 400


def test_worklist_unread_status_filter(client, auth_headers):
    """status=unread는 finalized를 제외한 전체(미판독)를 반환한다."""
    with SessionLocal() as db:
        open_id, _ = _make_study(db, "1.2.840.999.12.10", patient="P1210")
        fin_id, _ = _make_study(db, "1.2.840.999.12.11", patient="P1211")
    process_once()
    rid = client.get(f"/api/studies/{fin_id}/reports", headers=auth_headers).json()["items"][0]["id"]
    assert client.post(f"/api/reports/{rid}/finalize", headers=auth_headers).status_code == 200

    items = client.get("/api/worklist?status=unread&limit=500", headers=auth_headers).json()["items"]
    ids = [i["id"] for i in items]
    assert open_id in ids
    assert fin_id not in ids


# ── report_merge 묶음판독 ────────────────────────────────────


def test_report_merge(client, auth_headers):
    with SessionLocal() as db:
        a_id, _ = _make_study(db, "1.2.840.999.12.1", patient="P1200", modality="CT", desc="Chest CT")
        b_id, b_uid = _make_study(db, "1.2.840.999.12.2", patient="P1200", modality="CR",
                                  study_date="20260610", desc="Chest PA")
    process_once()

    r = client.post("/api/reports/merge", headers=auth_headers, json={"study_ids": [a_id, b_id]})
    assert r.status_code == 200, r.text
    rep = r.json()
    assert rep["status"] == "in_review"
    assert rep["study_id"] == a_id
    assert b_uid in rep["sr_json"]["comparison"]["prior_study_refs"]
    assert rep["ai_sources"]["merged_study_ids"] == [b_id]
    # 부속 검사 소견이 [MOD 검사일] 태그로 병합됨
    assert any("[CR 20260610]" in f["organ"] for f in rep["sr_json"]["findings"])
    assert any("묶음판독" in c for c in rep["sr_json"]["ai_meta"]["caveats"])


def test_report_merge_guards(client, auth_headers):
    with SessionLocal() as db:
        a_id, _ = _make_study(db, "1.2.840.999.12.3", patient="P1202")
        other_id, _ = _make_study(db, "1.2.840.999.12.4", patient="P1203")  # 타 환자
    process_once()

    # 2건 미만 거부
    assert client.post("/api/reports/merge", headers=auth_headers,
                       json={"study_ids": [a_id]}).status_code == 409
    # 타 환자 거부
    assert client.post("/api/reports/merge", headers=auth_headers,
                       json={"study_ids": [a_id, other_id]}).status_code == 409
    # 확정본 병합 거부
    with SessionLocal() as db:
        c_id, _ = _make_study(db, "1.2.840.999.12.5", patient="P1202", study_date="20260609")
    process_once()
    rid = client.get(f"/api/studies/{a_id}/reports", headers=auth_headers).json()["items"][0]["id"]
    client.post(f"/api/reports/{rid}/finalize", headers=auth_headers)
    assert client.post("/api/reports/merge", headers=auth_headers,
                       json={"study_ids": [a_id, c_id]}).status_code == 409


# ── Mode Profile JSON (S7) ──────────────────────────────────


def test_mode_profiles_defaults_and_admin_edit(client, auth_headers):
    # 설정이 없으면 기본 4종 노출 (ty=현행 자체 뷰어, infi=신규 뷰어 레이아웃 저장소)
    r = client.get("/api/settings/mode.profiles", headers=auth_headers)
    assert r.status_code == 200
    profs = r.json()["value"]["profiles"]
    assert set(profs) >= {"saintvidw", "ty", "infi"}
    assert profs["ty"]["viewer"]["client_viewer"] == "ty"
    assert profs["infi"]["viewer"]["client_viewer"] == "infi"

    # user scope 저장 거부(전역 전용)
    assert client.put("/api/settings/mode.profiles", headers=auth_headers,
                      json={"value": {"profiles": {}}, "scope": "user"}).status_code == 400

    # 관리자 global 저장 → 오버라이드 반영
    custom = {"profiles": {"saintvidw": {"label": "커스텀", "worklist": {}, "viewer": {}}}}
    assert client.put("/api/settings/mode.profiles", headers=auth_headers,
                      json={"value": custom, "scope": "global"}).status_code == 200
    r2 = client.get("/api/settings/mode.profiles", headers=auth_headers)
    assert r2.json()["value"]["profiles"]["saintvidw"]["label"] == "커스텀"
