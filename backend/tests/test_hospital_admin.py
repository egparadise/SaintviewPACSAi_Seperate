"""병원별 설정·관리 — 권한 매트릭스 오버라이드 · staff 403 · usage · modalities · admin-action."""
from __future__ import annotations


def _mk_hospital(client, auth_headers, code, name="병원"):
    r = client.post("/api/admin/hospitals", headers=auth_headers,
                    json={"code": code, "name": name})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _mk_account(client, auth_headers, username, role, hid):
    r = client.post("/api/admin/accounts", headers=auth_headers, json={
        "username": username, "password": "testpass123", "role": role, "hospital_id": hid,
    })
    assert r.status_code == 200, r.text
    tok = client.post("/api/auth/login", json={"username": username, "password": "testpass123"})
    assert tok.status_code == 200, tok.text
    return {"Authorization": f"Bearer {tok.json()['token']}"}


def _mk_study(db, hid, uid_suffix, patient_key="PADM01"):
    from app.services.study_service import register_study

    study = register_study(
        db, study_uid=f"1.2.826.0.1.999.{uid_suffix}", patient_key=patient_key,
        patient_name="관리^환자", study_date="20260701", modality="CR",
        study_desc="병원관리 테스트",
    )
    study.hospital_id = hid
    db.commit()
    return study.id


# ════════════════════════════ 권한 매트릭스 ════════════════════════════
def test_perm_matrix_default_and_override(client, auth_headers, db):
    hid = _mk_hospital(client, auth_headers, "PMH1", "매트릭스병원")
    # GET — 기본값 폴백 병합
    r = client.get(f"/api/hospitals/{hid}/perm-matrix", headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert {x["key"] for x in body["roles"]} == {"doctor", "radiologist", "technologist", "staff"}
    assert "study.delete" in {p["key"] for p in body["permissions"]}
    assert body["matrix"]["staff"] == ["report.read", "worklist.view"]  # 조회 전용 기본
    assert "report.print" in body["matrix"]["radiologist"]
    assert "study.copy" in body["matrix"]["technologist"]

    # PUT — 병원별 오버라이드: staff 에게 report.write 부여, technologist 에서 study.copy 회수
    override = dict(body["matrix"])
    override["staff"] = ["worklist.view", "report.read", "report.write"]
    override["technologist"] = [p for p in body["matrix"]["technologist"] if p != "study.copy"]
    r = client.put(f"/api/hospitals/{hid}/perm-matrix", headers=auth_headers,
                   json={"matrix": override})
    assert r.status_code == 200, r.text
    saved = r.json()["matrix"]
    assert "report.write" in saved["staff"]
    assert "study.copy" not in saved["technologist"]

    # effective_perms 반영 확인 (서비스 계층)
    from app.services.permissions import effective_perms, has_perm

    assert "report.write" in effective_perms(db, "staff", hid)
    assert "study.copy" not in effective_perms(db, "technologist", hid)
    # 다른 병원은 기본 매트릭스 유지
    assert "report.write" not in effective_perms(db, "staff", hid + 9999)
    # has_perm 하위호환(전역 검사 폴백) + 병원 반영
    assert has_perm("staff", "report.write") is False
    assert has_perm("staff", "report.write", db=db, hospital_id=hid) is True

    # /api/perm/me — 병원 소속 staff 의 유효 권한에 오버라이드 반영
    staff_h = _mk_account(client, auth_headers, "pm_staff1", "staff", hid)
    me = client.get("/api/perm/me", headers=staff_h)
    assert me.status_code == 200, me.text
    assert me.json()["role"] == "staff" and me.json()["hospital_id"] == hid
    assert "report.write" in me.json()["perms"]


def test_perm_matrix_put_requires_admin_and_validates(client, auth_headers):
    hid = _mk_hospital(client, auth_headers, "PMH2")
    doc_h = _mk_account(client, auth_headers, "pm_doc1", "doctor", hid)
    # 비관리자 PUT → 403
    assert client.put(f"/api/hospitals/{hid}/perm-matrix", headers=doc_h,
                      json={"matrix": {"staff": ["worklist.view"]}}).status_code == 403
    # 알 수 없는 역할/권한 키 → 400 (admin 역할도 편집 불가)
    assert client.put(f"/api/hospitals/{hid}/perm-matrix", headers=auth_headers,
                      json={"matrix": {"admin": ["worklist.view"]}}).status_code == 400
    assert client.put(f"/api/hospitals/{hid}/perm-matrix", headers=auth_headers,
                      json={"matrix": {"staff": ["no.such.perm"]}}).status_code == 400
    # 타병원 소속은 접근 불가
    other = _mk_hospital(client, auth_headers, "PMH3")
    assert client.get(f"/api/hospitals/{other}/perm-matrix", headers=doc_h).status_code == 403


# ════════════════════════════ staff(Medician) 조회 전용 403 ════════════════════════════
def test_staff_report_write_forbidden(client, auth_headers, db):
    hid = _mk_hospital(client, auth_headers, "STF1", "조회전용병원")
    staff_h = _mk_account(client, auth_headers, "stf_ro1", "staff", hid)
    sid = _mk_study(db, hid, "700.1", patient_key="PSTF1")
    # 리포트 생성(관리자) 후 staff 가 수정/확정/출력 시도 → 403
    from app.db import SessionLocal
    from app.models import Study
    from app.services.report_service import save_draft_from_ai

    with SessionLocal() as s:
        study = s.get(Study, sid)
        report = save_draft_from_ai(s, study, {"findings": [], "impression": []},
                                    model="mock", sources={})
        rid = report.id
    assert client.put(f"/api/reports/{rid}", headers=staff_h,
                      json={"sr_json": {"findings": []}}).status_code == 403
    assert client.post(f"/api/reports/{rid}/finalize", headers=staff_h).status_code == 403
    assert client.get(f"/api/reports/{rid}/export?format=pdf", headers=staff_h).status_code == 403
    # 조회는 가능
    assert client.get(f"/api/studies/{sid}/reports", headers=staff_h).status_code == 200
    assert client.get("/api/worklist", headers=staff_h).status_code == 200
    # 영상 관리 액션 5종 전부 403 (조회 전용)
    for action in ("delete", "move", "match", "unmatch", "copy"):
        assert client.post(f"/api/studies/{sid}/admin-action", headers=staff_h,
                           json={"action": action, "target_hid": hid, "order_id": 1}
                           ).status_code == 403, action
    # 권한 매트릭스 PUT 도 403 (관리자 전용)
    assert client.put(f"/api/hospitals/{hid}/perm-matrix", headers=staff_h,
                      json={"matrix": {"staff": ["worklist.view"]}}).status_code == 403


# ════════════════════════════ 사용량 ════════════════════════════
def test_hospital_usage(client, auth_headers, db):
    hid = _mk_hospital(client, auth_headers, "USG1", "사용량병원")
    _mk_study(db, hid, "701.1", patient_key="PUSG1")
    r = client.get(f"/api/hospitals/{hid}/usage", headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["db"]["studies"] >= 1
    assert set(body["db"]) == {"studies", "reports", "annotations"}
    # Orthanc 미가용 환경 — orthanc_ok:false 로 우아 강등(disk_mb 0)
    assert set(body["storage"]) == {"disk_mb", "instances", "orthanc_ok"}
    assert isinstance(body["storage"]["orthanc_ok"], bool)
    # 타병원 소속 사용자는 403
    other = _mk_hospital(client, auth_headers, "USG2")
    doc_h = _mk_account(client, auth_headers, "usg_doc1", "doctor", other)
    assert client.get(f"/api/hospitals/{hid}/usage", headers=doc_h).status_code == 403


# ════════════════════════════ Modality 노드 CRUD + 테스트 ════════════════════════════
def test_hospital_modalities_crud_and_test(client, auth_headers):
    hid = _mk_hospital(client, auth_headers, "MODH1", "장비병원")
    # 초기 빈 목록
    assert client.get(f"/api/hospitals/{hid}/modalities",
                      headers=auth_headers).json() == {"items": []}
    # 저장(PUT 전체 교체)
    items = [
        {"name": "CT-1", "ae_title": "ct_scp", "ip": "10.0.0.5", "port": 104, "kind": "scp"},
        {"name": "CR-1", "ae_title": "CR_SCU", "ip": "10.0.0.6", "port": 11112, "kind": "scu"},
    ]
    r = client.put(f"/api/hospitals/{hid}/modalities", headers=auth_headers, json={"items": items})
    assert r.status_code == 200, r.text
    saved = r.json()["items"]
    assert saved[0]["ae_title"] == "CT_SCP"  # AET 대문자 정규화
    assert client.get(f"/api/hospitals/{hid}/modalities",
                      headers=auth_headers).json()["items"] == saved
    # 검증 오류 — 포트 범위 / kind
    bad_port = [{"name": "X", "ae_title": "X", "ip": "1.1.1.1", "port": 0, "kind": "scp"}]
    assert client.put(f"/api/hospitals/{hid}/modalities", headers=auth_headers,
                      json={"items": bad_port}).status_code == 400
    bad_kind = [{"name": "X", "ae_title": "X", "ip": "1.1.1.1", "port": 104, "kind": "qr"}]
    assert client.put(f"/api/hospitals/{hid}/modalities", headers=auth_headers,
                      json={"items": bad_kind}).status_code == 400
    # 비관리자 PUT → 403, GET 은 소속 사용자 허용
    doc_h = _mk_account(client, auth_headers, "mod_doc1", "doctor", hid)
    assert client.put(f"/api/hospitals/{hid}/modalities", headers=doc_h,
                      json={"items": items}).status_code == 403
    assert client.get(f"/api/hospitals/{hid}/modalities", headers=doc_h).status_code == 200
    # 연결 테스트(에코·핑 상태등) — 닫힌 포트에 C-ECHO → ok:false (우아 실패)
    t = client.post(f"/api/hospitals/{hid}/modalities/test", headers=doc_h,
                    json={"ip": "127.0.0.1", "port": 1, "ae_title": "NOPE", "mode": "echo"})
    assert t.status_code == 200 and t.json()["ok"] is False
    assert client.post(f"/api/hospitals/{hid}/modalities/test", headers=doc_h,
                       json={"ip": "127.0.0.1", "port": 1, "mode": "bogus"}).status_code == 400


# ════════════════════════════ 병원 SCU 설정 ════════════════════════════
def test_hospital_scu_get_put(client, auth_headers):
    hid = _mk_hospital(client, auth_headers, "SCUH1", "에스씨유병원")
    r = client.get(f"/api/hospitals/{hid}/scu", headers=auth_headers)
    assert r.status_code == 200 and r.json()["name"] == "에스씨유병원"
    # 변경 — 병원명·AET 는 Hospital 컬럼, IP/Port 는 hospital 스코프 setting
    r = client.put(f"/api/hospitals/{hid}/scu", headers=auth_headers,
                   json={"name": "바뀐병원", "ae_title": "newscu", "ip": "192.168.0.9", "port": 11113})
    assert r.status_code == 200, r.text
    got = client.get(f"/api/hospitals/{hid}/scu", headers=auth_headers).json()
    assert got == {"name": "바뀐병원", "ae_title": "NEWSCU", "ip": "192.168.0.9", "port": 11113}
    # 병원명이 실제 Hospital 컬럼에 반영됐는지(관리자 목록)
    hs = client.get("/api/admin/hospitals", headers=auth_headers).json()["items"]
    assert next(h for h in hs if h["id"] == hid)["name"] == "바뀐병원"
    # 비관리자 PUT → 403
    doc_h = _mk_account(client, auth_headers, "scu_doc1", "doctor", hid)
    assert client.put(f"/api/hospitals/{hid}/scu", headers=doc_h,
                      json={"name": "x", "ae_title": "X", "ip": "1.1.1.1", "port": 1}).status_code == 403


# ════════════════════════════ admin-action (삭제·이동·매칭·언매칭·복제) ════════════════════════════
def test_admin_action_move_match_unmatch_copy_delete(client, auth_headers, db):
    h1 = _mk_hospital(client, auth_headers, "ACT1", "액션병원1")
    h2 = _mk_hospital(client, auth_headers, "ACT2", "액션병원2")
    sid = _mk_study(db, h1, "702.1", patient_key="PACT1")

    # match — 오더 생성 후 accession 링크
    order = client.post("/api/orders", headers=auth_headers, json={
        "patient_key": "PACT1", "modality": "CR", "procedure_desc": "흉부 PA",
    }).json()
    r = client.post(f"/api/studies/{sid}/admin-action", headers=auth_headers,
                    json={"action": "match", "order_id": order["id"]})
    assert r.status_code == 200 and r.json()["accession_no"] == order["accession_no"]
    # 워크리스트 ORDER NAME 조인 확인
    from app.models import Study as _Study

    db.expire_all()
    assert db.get(_Study, sid).accession_no == order["accession_no"]

    # unmatch — accession 해제
    r = client.post(f"/api/studies/{sid}/admin-action", headers=auth_headers,
                    json={"action": "unmatch"})
    assert r.status_code == 200 and r.json()["accession_no"] == ""

    # move — h1 → h2 재귀속 (target_hid 필수)
    assert client.post(f"/api/studies/{sid}/admin-action", headers=auth_headers,
                       json={"action": "move"}).status_code == 400
    r = client.post(f"/api/studies/{sid}/admin-action", headers=auth_headers,
                    json={"action": "move", "target_hid": h2})
    assert r.status_code == 200 and r.json()["hospital_id"] == h2

    # copy — 동일 병원 내 사본 등록
    r = client.post(f"/api/studies/{sid}/admin-action", headers=auth_headers,
                    json={"action": "copy"})
    assert r.status_code == 200, r.text
    copy_id = r.json()["copy_study_id"]
    db.expire_all()
    dup = db.get(_Study, copy_id)
    assert dup.hospital_id == h2 and dup.study_uid.endswith(".C1")

    # delete — 원본 삭제(Orthanc 미가용이어도 DB 정리)
    r = client.post(f"/api/studies/{sid}/admin-action", headers=auth_headers,
                    json={"action": "delete"})
    assert r.status_code == 200 and r.json()["ok"] is True
    db.expire_all()
    assert db.get(_Study, sid) is None

    # 잘못된 action → 400 / 없는 검사 → 404
    assert client.post(f"/api/studies/{copy_id}/admin-action", headers=auth_headers,
                       json={"action": "explode"}).status_code == 400
    assert client.post("/api/studies/99999999/admin-action", headers=auth_headers,
                       json={"action": "delete"}).status_code == 404


def test_admin_action_copy_to_target_hospital(client, auth_headers, db):
    """copy 가 target_hid 를 존중하는지 — UI(대상 병원 선택/입력) 계약과 일치."""
    h1 = _mk_hospital(client, auth_headers, "CPY1", "복제원병원")
    h2 = _mk_hospital(client, auth_headers, "CPY2", "복제대상병원")
    sid = _mk_study(db, h1, "704.1", patient_key="PCPY1")
    from app.models import Study as _Study

    # target_hid 지정 → 사본이 대상 병원으로 귀속
    r = client.post(f"/api/studies/{sid}/admin-action", headers=auth_headers,
                    json={"action": "copy", "target_hid": h2})
    assert r.status_code == 200, r.text
    assert r.json()["hospital_id"] == h2
    db.expire_all()
    assert db.get(_Study, r.json()["copy_study_id"]).hospital_id == h2
    # 미지정 → 동일 병원(기존 동작 유지)
    r = client.post(f"/api/studies/{sid}/admin-action", headers=auth_headers,
                    json={"action": "copy"})
    assert r.status_code == 200 and r.json()["hospital_id"] == h1
    # 존재하지 않는 대상 병원 → 404
    assert client.post(f"/api/studies/{sid}/admin-action", headers=auth_headers,
                       json={"action": "copy", "target_hid": 99999999}).status_code == 404


def test_client_role_persist_roundtrip(client, auth_headers):
    """Client(좌석) 등급이 hospital 스코프 setting 으로 저장·조회·삭제되는지."""
    hid = _mk_hospital(client, auth_headers, "CLR1", "등급병원")
    # 생성 시 등급 지정
    r = client.post(f"/api/hospitals/{hid}/clients", headers=auth_headers,
                    json={"name": "판독실1", "role": "radiologist"})
    assert r.status_code == 200, r.text
    cid = r.json()["id"]
    assert r.json()["role"] == "radiologist"
    # 목록에 등급 반영
    got = client.get(f"/api/hospitals/{hid}/clients", headers=auth_headers).json()["items"]
    assert next(c for c in got if c["id"] == cid)["role"] == "radiologist"
    # 수정으로 등급 변경 / 미지정("")이면 기존 유지
    r = client.put(f"/api/hospitals/{hid}/clients/{cid}", headers=auth_headers,
                   json={"name": "판독실1", "role": "technologist"})
    assert r.status_code == 200 and r.json()["role"] == "technologist"
    r = client.put(f"/api/hospitals/{hid}/clients/{cid}", headers=auth_headers,
                   json={"name": "판독실1"})
    assert r.status_code == 200 and r.json()["role"] == "technologist"
    # 등급 미지정 생성 = staff 기본
    r2 = client.post(f"/api/hospitals/{hid}/clients", headers=auth_headers,
                     json={"name": "접수1"})
    assert r2.json()["role"] == "staff"
    # 잘못된 등급 → 400
    assert client.post(f"/api/hospitals/{hid}/clients", headers=auth_headers,
                       json={"name": "X", "role": "hacker"}).status_code == 400
    # 삭제 시 등급 매핑 정리(고아 키 없음)
    assert client.delete(f"/api/hospitals/{hid}/clients/{cid}",
                         headers=auth_headers).json()["ok"] is True
    from app.db import SessionLocal
    from app.services.settings_service import get_hospital_setting

    with SessionLocal() as s:
        stored = get_hospital_setting(s, hid, "client.roles", default={}) or {}
        assert str(cid) not in stored


def test_admin_action_gates_by_role_and_hospital(client, auth_headers, db):
    h1 = _mk_hospital(client, auth_headers, "ACT3", "게이트병원")
    h2 = _mk_hospital(client, auth_headers, "ACT4", "타병원")
    sid = _mk_study(db, h1, "703.1", patient_key="PACT3")

    # doctor: study.delete 권한 없음(기본 매트릭스) → 403
    doc_h = _mk_account(client, auth_headers, "act_doc1", "doctor", h1)
    assert client.post(f"/api/studies/{sid}/admin-action", headers=doc_h,
                       json={"action": "delete"}).status_code == 403
    # technologist: study.match 보유(기본) → 허용
    tech_h = _mk_account(client, auth_headers, "act_tech1", "technologist", h1)
    order = client.post("/api/orders", headers=auth_headers,
                        json={"patient_key": "PACT3"}).json()
    assert client.post(f"/api/studies/{sid}/admin-action", headers=tech_h,
                       json={"action": "match", "order_id": order["id"]}).status_code == 200
    # 타병원 소속 technologist → 검사 접근 403
    tech2_h = _mk_account(client, auth_headers, "act_tech2", "technologist", h2)
    assert client.post(f"/api/studies/{sid}/admin-action", headers=tech2_h,
                       json={"action": "unmatch"}).status_code == 403
    # 병원별 오버라이드로 technologist 의 study.unmatch 회수 → 403 으로 전환
    client.put(f"/api/hospitals/{h1}/perm-matrix", headers=auth_headers,
               json={"matrix": {"technologist": ["worklist.view", "report.read"]}})
    assert client.post(f"/api/studies/{sid}/admin-action", headers=tech_h,
                       json={"action": "unmatch"}).status_code == 403
