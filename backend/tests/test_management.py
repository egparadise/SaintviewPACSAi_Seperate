"""33차 — 서버 관리 1단계: 병원·계정/역할·등록 장비·SCP 제어."""
from __future__ import annotations


def test_roles_catalog(client, auth_headers):
    r = client.get("/api/admin/roles", headers=auth_headers)
    assert r.status_code == 200, r.text
    keys = {x["key"] for x in r.json()["roles"]}
    assert {"admin", "doctor", "radiologist", "technologist", "staff"} <= keys


def test_hospital_crud(client, auth_headers):
    r = client.post("/api/admin/hospitals", headers=auth_headers,
                    json={"code": "H001", "name": "성모병원", "ae_title": "SUNGMO",
                          "max_accounts": 3, "enforce_isolation": True})
    assert r.status_code == 200, r.text
    hid = r.json()["id"]
    # 중복 코드 거부
    assert client.post("/api/admin/hospitals", headers=auth_headers,
                       json={"code": "H001"}).status_code == 409
    # 수정
    r = client.put(f"/api/admin/hospitals/{hid}", headers=auth_headers,
                   json={"code": "H001", "name": "성모영상의학", "phone": "02-123"})
    assert r.json()["name"] == "성모영상의학"
    # 목록
    items = client.get("/api/admin/hospitals", headers=auth_headers).json()["items"]
    assert any(h["id"] == hid for h in items)


def test_account_lifecycle_and_permissions(client, auth_headers):
    # 병원 생성
    h = client.post("/api/admin/hospitals", headers=auth_headers,
                    json={"code": "HACC", "name": "계정테스트", "max_accounts": 0}).json()
    # 방사선사 계정 생성
    r = client.post("/api/admin/accounts", headers=auth_headers, json={
        "username": "rt1", "password": "rtpass123", "role": "technologist",
        "hospital_id": h["id"], "display_name": "김방사",
    })
    assert r.status_code == 200, r.text
    aid = r.json()["id"]
    assert r.json()["role_label"] == "방사선사(Radiographer)"  # 등급 라벨 병기
    # 새 계정 로그인
    tok = client.post("/api/auth/login", json={"username": "rt1", "password": "rtpass123"})
    assert tok.status_code == 200, tok.text
    rt_headers = {"Authorization": f"Bearer {tok.json()['token']}"}
    # 방사선사는 계정 관리 권한 없음 → 403
    assert client.get("/api/admin/accounts", headers=rt_headers).status_code == 403
    # 워크리스트는 조회 가능
    assert client.get("/api/worklist", headers=rt_headers).status_code == 200
    # 비활성화 후 로그인 거부
    client.put(f"/api/admin/accounts/{aid}", headers=auth_headers, json={"enabled": False})
    assert client.post("/api/auth/login",
                       json={"username": "rt1", "password": "rtpass123"}).status_code == 401
    # 삭제
    assert client.delete(f"/api/admin/accounts/{aid}", headers=auth_headers).status_code == 200


def test_cannot_demote_last_admin(client, auth_headers):
    me = client.get("/api/admin/accounts", headers=auth_headers).json()["items"]
    admin = next(a for a in me if a["username"] == "admin")
    r = client.put(f"/api/admin/accounts/{admin['id']}", headers=auth_headers,
                   json={"role": "doctor"})
    assert r.status_code == 400  # 자기 자신 + 마지막 관리자 보호


def test_modality_crud_and_apply(client, auth_headers):
    r = client.post("/api/admin/modalities", headers=auth_headers, json={
        "name": "CT_ROOM1", "ae_title": "CT1", "host": "192.168.0.50", "port": 104,
        "modality_type": "CT", "role": "both", "allow_receive": True,
    })
    assert r.status_code == 200, r.text
    mid = r.json()["id"]
    assert r.json()["ae_title"] == "CT1"
    # 중복 이름 거부
    assert client.post("/api/admin/modalities", headers=auth_headers,
                       json={"name": "CT_ROOM1", "ae_title": "X", "port": 104}).status_code == 409
    # 잘못된 포트 거부
    assert client.post("/api/admin/modalities", headers=auth_headers,
                       json={"name": "BAD", "ae_title": "X", "port": 99999}).status_code == 400
    # 수정
    client.put(f"/api/admin/modalities/{mid}", headers=auth_headers, json={
        "name": "CT_ROOM1", "ae_title": "CT1", "host": "10.0.0.1", "port": 11112,
        "role": "scu", "allow_receive": False,
    })
    # apply (Orthanc 없으면 ok=False여도 예외 없이 처리)
    r = client.post("/api/admin/modalities/apply", headers=auth_headers)
    assert r.status_code == 200, r.text
    # 삭제
    assert client.delete(f"/api/admin/modalities/{mid}", headers=auth_headers).status_code == 200


def test_scp_config_persists(client, auth_headers):
    r = client.post("/api/admin/scp-config", headers=auth_headers, json={
        "receive_enabled": True, "registered_only": True, "check_called_aet": True,
    })
    assert r.status_code == 200, r.text
    assert r.json()["config"]["registered_only"] is True
    s = client.get("/api/admin/scp-status", headers=auth_headers)
    assert s.status_code == 200, s.text
    assert s.json()["config"]["registered_only"] is True
