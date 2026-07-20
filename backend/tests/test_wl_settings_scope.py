"""병원 기본 워크리스트 설정 — wl-setting 엔드포인트 + 사용자 폴백(user > hospital > 빈값) + 인코딩 복구."""
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


def test_wl_setting_roundtrip_and_whitelist(client, auth_headers):
    hid = _mk_hospital(client, auth_headers, "WLS1", "워크리스트설정병원")
    # PUT → GET 라운드트립 (병원 스코프)
    r = client.put(f"/api/hospitals/{hid}/wl-setting/worklist.prefs", headers=auth_headers,
                   json={"value": {"auto_refresh_sec": 30, "columns": ["pid", "pname"]}})
    assert r.status_code == 200, r.text
    r = client.get(f"/api/hospitals/{hid}/wl-setting/worklist.prefs", headers=auth_headers)
    assert r.status_code == 200 and r.json()["value"]["auto_refresh_sec"] == 30
    # 화이트리스트 밖 키 404
    r = client.get(f"/api/hospitals/{hid}/wl-setting/viewer.prefs", headers=auth_headers)
    assert r.status_code == 404
    # 탭 10개 초과 400
    items = [{"id": f"t{i}", "label": f"P{i}", "filter": {}} for i in range(11)]
    r = client.put(f"/api/hospitals/{hid}/wl-setting/worklist.tabs", headers=auth_headers,
                   json={"value": {"items": items}})
    assert r.status_code == 400


def test_wl_setting_user_fallback_to_hospital(client, auth_headers):
    """계정 설정이 없으면 병원 기본값 폴백, 계정 저장 시 그 값이 우선."""
    hid = _mk_hospital(client, auth_headers, "WLS2", "폴백병원")
    client.put(f"/api/hospitals/{hid}/wl-setting/worklist.prefs", headers=auth_headers,
               json={"value": {"auto_refresh_sec": 5, "default_status": "unread"}})
    user_h = _mk_account(client, auth_headers, "wls2doc", "doctor", hid)

    # 계정 설정 없음 → 병원 기본값
    r = client.get("/api/settings/worklist.prefs", headers=user_h)
    assert r.status_code == 200, r.text
    assert r.json()["value"].get("auto_refresh_sec") == 5

    # 계정 저장 → 개인 값 우선
    r = client.put("/api/settings/worklist.prefs", headers=user_h,
                   json={"value": {"auto_refresh_sec": 10}, "scope": "user"})
    assert r.status_code == 200, r.text
    r = client.get("/api/settings/worklist.prefs", headers=user_h)
    assert r.json()["value"].get("auto_refresh_sec") == 10


def test_wl_setting_staff_write_forbidden(client, auth_headers):
    hid = _mk_hospital(client, auth_headers, "WLS3", "권한병원")
    staff_h = _mk_account(client, auth_headers, "wls3staff", "staff", hid)
    r = client.put(f"/api/hospitals/{hid}/wl-setting/worklist.prefs", headers=staff_h,
                   json={"value": {"auto_refresh_sec": 5}})
    assert r.status_code == 403


def test_repair_encoding_recovers_mojibake(client, auth_headers, db):
    """EUC-KR→Latin-1 mojibake 복구 — 깨진 행만 교정, 정상 한글은 보존(멱등)."""
    from app.services.study_service import register_study

    broken = "Abdomen CT(Á¶¿µÁ¦)"      # '조영제'의 mojibake
    normal = "복부 CT(조영제)"           # 정상 UTF-8 — 손대면 안 됨
    s1 = register_study(db, study_uid="1.2.826.0.1.999.enc1", patient_key="ENC01",
                        patient_name="인코딩^환자", study_date="20260701", modality="CT",
                        study_desc=broken)
    s2 = register_study(db, study_uid="1.2.826.0.1.999.enc2", patient_key="ENC02",
                        patient_name="인코딩^환자2", study_date="20260701", modality="CT",
                        study_desc=normal)
    sid1, sid2 = s1.id, s2.id
    db.commit()

    r = client.post("/api/maintenance/repair-encoding", headers=auth_headers,
                    json={"dry_run": False})
    assert r.status_code == 200, r.text
    assert r.json()["fixed"] >= 1

    from app.models import Study
    db.expire_all()
    assert db.get(Study, sid1).study_desc == "Abdomen CT(조영제)"
    assert db.get(Study, sid2).study_desc == normal
