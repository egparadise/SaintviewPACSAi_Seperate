"""판독 상태(read_state)·하트비트·확정(Fixed) 잠금 — 레인 B2 (SPEC §B·§C)."""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import select


# ════════════════════════════════ 헬퍼 ════════════════════════════════
_SR = {
    "exam": {"modality": "CT", "body_part": "CHEST", "technique": "CT"},
    "comparison": {"prior_study_refs": [], "summary": ""},
    "findings": [{"organ": "폐", "observation": "정상 소견", "severity": "normal",
                  "measurements": []}],
    "impression": [{"rank": 1, "statement": "정상", "confidence": "high", "codes": []}],
    "recommendations": [],
    "ai_meta": {"caveats": []},
}


def _seed(db, tag, patient_key=None):
    """검사 시드 — 하네스 공용 register_study 재사용(병원 미귀속=관리자 전체 조회)."""
    from app.services.study_service import register_study

    study = register_study(
        db, study_uid=f"1.2.826.0.1.888.{tag}", patient_key=patient_key or f"RS{tag}",
        patient_name="판독^상태", study_date="20260710", modality="CT",
        study_desc=f"ReadState {tag}",
    )
    return study.id


def _row(client, headers, sid, patient_key):
    """워크리스트에서 시드 검사 행 조회 — pid 정확 일치('=' 연산자)."""
    r = client.get("/api/worklist", headers=headers, params={"pid": f"={patient_key}"})
    assert r.status_code == 200, r.text
    rows = [it for it in r.json()["items"] if it["id"] == sid]
    assert rows, f"워크리스트에 검사 {sid} 가 보여야 한다"
    return rows[0]


def _hb(client, headers, sids, kind, typing=False):
    r = client.post("/api/activity/heartbeat", headers=headers,
                    json={"study_ids": sids, "kind": kind, "typing": typing})
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True}


def _draft(db, sid):
    """AI 초안 리포트 생성(버전 자동 증가) — narrative_text 채워짐."""
    from app.models import Study
    from app.services.report_service import save_draft_from_ai

    db.expire_all()
    return save_draft_from_ai(db, db.get(Study, sid), _SR, model="mock", sources={})


# ════════════════════ ① 하트비트 upsert — 동일 키 재호출 시 행 1개 ════════════════════
def test_heartbeat_upsert_single_row(client, auth_headers, db):
    from app.models import StudyActivity

    sid = _seed(db, "hb1")
    _hb(client, auth_headers, [sid], "report", typing=False)
    _hb(client, auth_headers, [sid], "report", typing=True)  # 동일 (study,kind,user) 재호출

    db.expire_all()
    rows = db.execute(select(StudyActivity).where(
        StudyActivity.study_id == sid, StudyActivity.kind == "report")).scalars().all()
    assert len(rows) == 1, "동일 키 재호출은 upsert — 행이 1개여야 한다"
    assert rows[0].typing is True

    # 검증: 64건 초과 400 / kind 오류 400
    r = client.post("/api/activity/heartbeat", headers=auth_headers,
                    json={"study_ids": list(range(1, 66)), "kind": "viewer"})
    assert r.status_code == 400
    r = client.post("/api/activity/heartbeat", headers=auth_headers,
                    json={"study_ids": [sid], "kind": "bogus"})
    assert r.status_code == 400


# ════════ ② read_state 전이: unread → open → reading → read → fixed ════════
def test_read_state_transitions(client, auth_headers, db):
    sid = _seed(db, "st1")
    key = "RSst1"

    # 초기 — unread
    row = _row(client, auth_headers, sid, key)
    assert row["read_state"] == "unread"
    assert row["viewer_open"] is False and row["report_locked"] is False

    # 뷰어 하트비트 → open
    _hb(client, auth_headers, [sid], "viewer")
    row = _row(client, auth_headers, sid, key)
    assert row["read_state"] == "open" and row["viewer_open"] is True

    # 판독 하트비트 → reading (open 보다 우선)
    _hb(client, auth_headers, [sid], "report")
    row = _row(client, auth_headers, sid, key)
    assert row["read_state"] == "reading"

    # 확정 → read (하트비트 활성이어도 finalized 가 우선)
    rep = _draft(db, sid)
    r = client.post(f"/api/reports/{rep.id}/finalize", headers=auth_headers)
    assert r.status_code == 200, r.text
    row = _row(client, auth_headers, sid, key)
    assert row["read_state"] == "read"

    # 잠금 → fixed (최우선)
    r = client.post(f"/api/studies/{sid}/report-lock", headers=auth_headers,
                    json={"locked": True})
    assert r.status_code == 200, r.text
    assert r.json() == {"locked": True}
    row = _row(client, auth_headers, sid, key)
    assert row["read_state"] == "fixed" and row["report_locked"] is True

    # 단건 경로(study_detail)에도 동일 필드
    r = client.get(f"/api/studies/{sid}", headers=auth_headers)
    assert r.status_code == 200, r.text
    assert r.json()["read_state"] == "fixed" and r.json()["report_locked"] is True

    # Exam Control 목록 경로(search_worklist 경유)에도 동일 필드
    r = client.get("/api/examctl/studies", headers=auth_headers, params={"q": key})
    assert r.status_code == 200, r.text
    ex = [it for it in r.json()["items"] if it["id"] == sid]
    assert ex and ex[0]["read_state"] == "fixed"


# ════════════════ ③ TTL 만료 — 과거 last_seen(naive) 주입 시 open 해제 ════════════════
def test_heartbeat_ttl_expiry(client, auth_headers, db):
    from app.models import StudyActivity

    sid = _seed(db, "ttl1")
    _hb(client, auth_headers, [sid], "viewer")
    assert _row(client, auth_headers, sid, "RSttl1")["read_state"] == "open"

    # 과거 last_seen 주입 — naive datetime(SQLite 반환 형태)으로 안전 비교 검증
    db.expire_all()
    act = db.execute(select(StudyActivity).where(
        StudyActivity.study_id == sid, StudyActivity.kind == "viewer")).scalar_one()
    act.last_seen = datetime.utcnow() - timedelta(seconds=300)  # ACTIVE_TTL(120s) 초과
    db.commit()

    row = _row(client, auth_headers, sid, "RSttl1")
    assert row["read_state"] == "unread" and row["viewer_open"] is False


# ════════════════════════ ④ report_typing — typing TTL(90s) ════════════════════════
def test_report_typing_flag(client, auth_headers, db):
    from app.models import StudyActivity

    sid = _seed(db, "typ1")
    _hb(client, auth_headers, [sid], "report", typing=True)
    row = _row(client, auth_headers, sid, "RStyp1")
    assert row["read_state"] == "reading" and row["report_typing"] is True

    # TYPING_TTL(90s) 초과·ACTIVE_TTL(120s) 이내 — typing 해제, reading 유지
    db.expire_all()
    act = db.execute(select(StudyActivity).where(
        StudyActivity.study_id == sid, StudyActivity.kind == "report")).scalar_one()
    act.last_seen = datetime.utcnow() - timedelta(seconds=100)
    db.commit()
    row = _row(client, auth_headers, sid, "RStyp1")
    assert row["read_state"] == "reading" and row["report_typing"] is False

    # typing=False 하트비트로도 해제
    _hb(client, auth_headers, [sid], "report", typing=False)
    row = _row(client, auth_headers, sid, "RStyp1")
    assert row["report_typing"] is False


# ═══════════════ ⑤ has_report_text / image_changed(주석 추가 시) ═══════════════
def test_has_report_text_and_image_changed(client, auth_headers, db):
    from app.models import Annotation

    sid = _seed(db, "img1")
    row = _row(client, auth_headers, sid, "RSimg1")
    assert row["has_report_text"] is False and row["image_changed"] is False
    assert row["merged"] is False

    # 판독문 생성 → has_report_text
    _draft(db, sid)
    row = _row(client, auth_headers, sid, "RSimg1")
    assert row["has_report_text"] is True

    # 주석 추가 → image_changed
    db.add(Annotation(study_id=sid, kind="line", points=[[0.1, 0.1], [0.2, 0.2]],
                      created_by="admin"))
    db.commit()
    row = _row(client, auth_headers, sid, "RSimg1")
    assert row["image_changed"] is True


# ════════ ⑥ 잠금 후 판독 변이 전부 409 → 잠금 해제 후 성공 ════════
def test_lock_blocks_report_mutations(client, auth_headers, db):
    sid = _seed(db, "lk1")
    sid2 = _seed(db, "lk2", patient_key="RSlk1")  # 동일 환자 — 묶음판독용

    v1 = _draft(db, sid)
    r = client.post(f"/api/reports/{v1.id}/finalize", headers=auth_headers)
    assert r.status_code == 200, r.text
    v2 = _draft(db, sid)  # 잠금 대상 검사에 미확정 새 버전(v2)

    r = client.post(f"/api/studies/{sid}/report-lock", headers=auth_headers,
                    json={"locked": True})
    assert r.status_code == 200 and r.json() == {"locked": True}

    # update_report 409
    r = client.put(f"/api/reports/{v2.id}", headers=auth_headers, json={"sr_json": _SR})
    assert r.status_code == 409, r.text
    assert "잠금" in r.json()["detail"]
    # finalize 409
    assert client.post(f"/api/reports/{v2.id}/finalize",
                       headers=auth_headers).status_code == 409
    # suspend 409
    assert client.post(f"/api/reports/{v2.id}/suspend",
                       headers=auth_headers).status_code == 409
    # AI 재생성(analyze) 409
    assert client.post(f"/api/studies/{sid}/analyze",
                       headers=auth_headers).status_code == 409
    # external-ai 반영 409
    r = client.post(f"/api/studies/{sid}/external-ai", headers=auth_headers,
                    json={"vendor": "TestAI",
                          "results": [{"label": "nodule", "severity": "normal",
                                       "confidence": 0.5}]})
    assert r.status_code == 409, r.text
    # 묶음판독(merge) — 잠금 검사 포함 409
    assert client.post("/api/reports/merge", headers=auth_headers,
                       json={"study_ids": [sid, sid2]}).status_code == 409
    # batch-finalize — 대상 포함 시 해당 건 실패(기존 batch 에러 패턴)
    r = client.post("/api/reports/batch-finalize", headers=auth_headers,
                    json={"report_ids": [v2.id]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["finalized"] == 0 and body["results"][0]["ok"] is False
    assert "잠금" in body["results"][0]["detail"]

    # 잠금 해제 → 변이 성공
    r = client.post(f"/api/studies/{sid}/report-lock", headers=auth_headers,
                    json={"locked": False})
    assert r.status_code == 200 and r.json() == {"locked": False}
    r = client.put(f"/api/reports/{v2.id}", headers=auth_headers, json={"sr_json": _SR})
    assert r.status_code == 200, r.text
    assert client.post(f"/api/studies/{sid}/analyze",
                       headers=auth_headers).status_code == 200


# ═══ ⑥b 잠금 중 AI 초안 생성(워커 실행 시점) 차단 — 큐잉→잠금→실행 TOCTOU ═══
def test_ai_draft_blocked_while_locked_at_run_time(client, auth_headers, db):
    """analyze 큐잉 가드 통과 후 잠금이 걸려도 워커 실행 시점에 차단되어야 한다.

    미차단 시 잠금 중 새 리포트가 생기고 study.status 가 finalized→draft_ready 로
    오염된다('fixed 인데 finalized 아님' 상태 생성 경로).
    """
    import pytest

    from app.models import AiJob, Study
    from app.services.ai_service import run_draft_job
    from app.services.report_service import WorkflowError

    sid = _seed(db, "lkai")
    v1 = _draft(db, sid)
    r = client.post(f"/api/reports/{v1.id}/finalize", headers=auth_headers)
    assert r.status_code == 200, r.text

    # 미잠금 상태에서 큐잉(가드 통과) → 이후 잠금 → 워커 실행
    job = AiJob(study_id=sid, kind="regenerate", status="queued")
    db.add(job)
    db.commit()
    r = client.post(f"/api/studies/{sid}/report-lock", headers=auth_headers,
                    json={"locked": True})
    assert r.status_code == 200 and r.json() == {"locked": True}

    db.expire_all()
    with pytest.raises(WorkflowError):
        run_draft_job(db, job)
    db.expire_all()
    assert job.status == "failed" and "잠금" in (job.error or "")
    # 잠금 중 새 리포트 미생성 + study.status 미오염(finalized 유지)
    st = db.get(Study, sid)
    assert st.status == "finalized"
    r = client.get(f"/api/studies/{sid}/reports", headers=auth_headers)
    assert len(r.json()["items"]) == 1, "잠금 중에는 새 버전이 생기면 안 된다"


# ═══ ⑧ 하트비트 실존·병원 스코프 — 미존재 id 미적재 / 타 병원 검사 오염 차단 ═══
def test_heartbeat_existence_and_hospital_scope(client, auth_headers, db):
    from app.models import Study, StudyActivity

    # 미존재 id — 200(무시)이지만 행이 쌓이면 안 된다
    _hb(client, auth_headers, [99999998], "viewer")
    db.expire_all()
    ghost = db.execute(select(StudyActivity).where(
        StudyActivity.study_id == 99999998)).scalars().all()
    assert ghost == [], "존재하지 않는 검사 id 하트비트는 무시되어야 한다"

    # 병원 A 검사 + 병원 B 소속 사용자
    r = client.post("/api/admin/hospitals", headers=auth_headers,
                    json={"code": "RSHA", "name": "하트비트A병원"})
    hid_a = r.json()["id"]
    r = client.post("/api/admin/hospitals", headers=auth_headers,
                    json={"code": "RSHB", "name": "하트비트B병원"})
    hid_b = r.json()["id"]
    sid_a = _seed(db, "hbscope")
    db.get(Study, sid_a).hospital_id = hid_a
    db.commit()
    r = client.post("/api/admin/accounts", headers=auth_headers, json={
        "username": "rs_hb_b", "password": "testpass123", "role": "radiologist",
        "hospital_id": hid_b})
    assert r.status_code == 200, r.text
    tok = client.post("/api/auth/login",
                      json={"username": "rs_hb_b", "password": "testpass123"})
    hb_b = {"Authorization": f"Bearer {tok.json()['token']}"}

    # 병원 B 사용자가 병원 A 검사에 kind=report 하트비트 → 무시(reading 오염 없음)
    _hb(client, hb_b, [sid_a], "report", typing=True)
    db.expire_all()
    rows = db.execute(select(StudyActivity).where(
        StudyActivity.study_id == sid_a)).scalars().all()
    assert rows == [], "타 병원 검사 하트비트는 반영되면 안 된다"
    row = _row(client, auth_headers, sid_a, "RShbscope")
    assert row["read_state"] == "unread" and row["report_typing"] is False

    # 시스템 관리자는 전체 반영(기존 동작 유지)
    _hb(client, auth_headers, [sid_a], "viewer")
    assert _row(client, auth_headers, sid_a, "RShbscope")["read_state"] == "open"


# ═══ ⑨ report-lock 병원 스코프 — 타 병원 계정의 잠금/해제 403 ═══
def test_report_lock_hospital_scope(client, auth_headers, db):
    from app.models import Study

    r = client.post("/api/admin/hospitals", headers=auth_headers,
                    json={"code": "RSLA", "name": "잠금A병원"})
    hid_a = r.json()["id"]
    r = client.post("/api/admin/hospitals", headers=auth_headers,
                    json={"code": "RSLB", "name": "잠금B병원"})
    hid_b = r.json()["id"]
    sid = _seed(db, "lkscope")
    db.get(Study, sid).hospital_id = hid_a
    db.commit()
    v1 = _draft(db, sid)
    assert client.post(f"/api/reports/{v1.id}/finalize",
                       headers=auth_headers).status_code == 200

    # 병원 B 판독의(report.finalize 보유) — 타 병원 검사 잠금/해제 403
    r = client.post("/api/admin/accounts", headers=auth_headers, json={
        "username": "rs_rad_b", "password": "testpass123", "role": "radiologist",
        "hospital_id": hid_b})
    assert r.status_code == 200, r.text
    tok = client.post("/api/auth/login",
                      json={"username": "rs_rad_b", "password": "testpass123"})
    rad_b = {"Authorization": f"Bearer {tok.json()['token']}"}
    for locked in (True, False):
        r = client.post(f"/api/studies/{sid}/report-lock", headers=rad_b,
                        json={"locked": locked})
        assert r.status_code == 403, r.text

    # 시스템 관리자·자기 병원 판독의는 정상
    assert client.post(f"/api/studies/{sid}/report-lock", headers=auth_headers,
                       json={"locked": True}).status_code == 200
    r = client.post("/api/admin/accounts", headers=auth_headers, json={
        "username": "rs_rad_a", "password": "testpass123", "role": "radiologist",
        "hospital_id": hid_a})
    assert r.status_code == 200, r.text
    tok = client.post("/api/auth/login",
                      json={"username": "rs_rad_a", "password": "testpass123"})
    rad_a = {"Authorization": f"Bearer {tok.json()['token']}"}
    assert client.post(f"/api/studies/{sid}/report-lock", headers=rad_a,
                       json={"locked": False}).status_code == 200


# ═══════ ⑦ report-lock 권한 403 / finalized 없이 400 / 미존재 404 ═══════
def test_report_lock_permission_and_validation(client, auth_headers, db):
    sid = _seed(db, "pm1")

    # finalized 리포트 없이 잠금 → 400
    r = client.post(f"/api/studies/{sid}/report-lock", headers=auth_headers,
                    json={"locked": True})
    assert r.status_code == 400, r.text
    assert "확정된 판독이 없습니다" in r.json()["detail"]

    # report.finalize 권한 없는 역할(staff) → 403
    r = client.post("/api/admin/accounts", headers=auth_headers, json={
        "username": "rs_staff", "password": "testpass123", "role": "staff"})
    assert r.status_code == 200, r.text
    tok = client.post("/api/auth/login",
                      json={"username": "rs_staff", "password": "testpass123"})
    assert tok.status_code == 200, tok.text
    staff_headers = {"Authorization": f"Bearer {tok.json()['token']}"}
    r = client.post(f"/api/studies/{sid}/report-lock", headers=staff_headers,
                    json={"locked": True})
    assert r.status_code == 403, r.text

    # 미존재 검사 → 404
    assert client.post("/api/studies/9999999/report-lock", headers=auth_headers,
                       json={"locked": True}).status_code == 404
