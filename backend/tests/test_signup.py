"""37차 — 가입 흐름: 홈→가입 신청→운영자 승인→로그인→병원별 페이지 + 관리자 감독.

⚠ 공개 가입은 **기본 OFF** 다(app/config.py: SAINTVIEW_SIGNUP_ENABLED 기본 0). 무인증
  /api/signup 이 즉시 쓸 수 있는 계정을 만들면 그것만으로 Live 픽셀(PHI) 인증이 우회되기
  때문이다. 이 파일의 테스트는 그 스위치를 명시적으로 켜고(signup_on) 가입 자체의 계약을
  검증한다. '꺼져 있을 때 403' 과 '켜도 승인 전에는 로그인 불가' 는
  test_zzz_rebut4_signup_pixel.py 가 고정한다.
"""
from __future__ import annotations

import pytest


@pytest.fixture()
def signup_on():
    """이 테스트 동안만 공개 가입을 켠다(기본값은 OFF)."""
    from app.config import get_settings

    s = get_settings()
    old = s.signup_enabled
    s.signup_enabled = True
    yield
    s.signup_enabled = old


def _approve(client, auth_headers, hospital_id: int, username: str) -> None:
    """운영자 승인 — 병원·계정을 활성화(관리자 콘솔이 하는 일과 동일한 API)."""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Account, Hospital

    with SessionLocal() as db:
        h = db.get(Hospital, hospital_id)
        a = db.execute(select(Account).where(Account.username == username)).scalar_one()
        body = {"code": h.code, "name": h.name, "enabled": True,
                "license_clients": h.license_clients, "modality_limit": h.modality_limit}
        aid = a.id
    r = client.put(f"/api/admin/hospitals/{hospital_id}", headers=auth_headers, json=body)
    assert r.status_code == 200, r.text
    r = client.put(f"/api/admin/accounts/{aid}", headers=auth_headers, json={"enabled": True})
    assert r.status_code == 200, r.text


def _payload(username="newadmin", hosp="성모영상의학과의원"):
    return {
        "hospital": {
            "name": hosp, "address": "서울시 강남구", "departments": "영상의학과,내과",
            "phone": "02-1234-5678", "fax": "02-1234-5679", "homepage": "https://sungmo.example",
            "license_clients": 5, "modality_limit": 3,
        },
        "registrant": {
            "name": "김원장", "title": "원장", "sex": "M", "birth6": "700101",
            "phone": "02-1234-5678", "mobile": "010-1111-2222", "email": "won@example.com",
            "username": username, "password": "signup12345", "password_confirm": "signup12345",
        },
        "billing": {"method": "card", "card_last4": "1234567890"},
    }


def test_signup_creates_pending_hospital_and_admin_then_login_after_approval(
    client, auth_headers, signup_on
):
    """가입은 **신청**이다 — 승인 전 로그인 401, 승인 후 admin 으로 로그인."""
    r = client.post("/api/signup", json=_payload())
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] and body["hospital_code"] and body["pending"] is True

    # 승인 전: 가입만으로는 어떤 자격증명도 얻지 못한다(= 픽셀 쿠키도 안 나온다)
    lg = client.post("/api/auth/login", json={"username": "newadmin", "password": "signup12345"})
    assert lg.status_code == 401, lg.text
    assert lg.cookies.get("sv_pix") is None

    # 운영자 승인 후에야 로그인된다
    _approve(client, auth_headers, body["hospital_id"], "newadmin")
    lg = client.post("/api/auth/login", json={"username": "newadmin", "password": "signup12345"})
    assert lg.status_code == 200, lg.text
    assert lg.json()["role"] == "admin"


def test_signup_password_mismatch(client, signup_on):
    p = _payload(username="mismatch1")
    p["registrant"]["password_confirm"] = "different999"
    assert client.post("/api/signup", json=p).status_code == 400


def test_signup_duplicate_username(client, signup_on):
    client.post("/api/signup", json=_payload(username="dupe1", hosp="A병원"))
    assert client.post("/api/signup", json=_payload(username="dupe1", hosp="B병원")).status_code == 409


def test_signup_card_only_stores_last4(client, db, signup_on):
    from sqlalchemy import select

    from app.models import Hospital

    r = client.post("/api/signup", json=_payload(username="cardadmin", hosp="카드병원"))
    code = r.json()["hospital_code"]
    h = db.execute(select(Hospital).where(Hospital.code == code)).scalar_one()
    assert h.billing_card_last4 == "7890"  # 마지막 4자리만
    assert len(h.billing_card_last4) <= 4


def test_admin_overview(client, auth_headers, signup_on):
    client.post("/api/signup", json=_payload(username="ovadmin", hosp="감독병원"))
    r = client.get("/api/admin/overview", headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "hospitals" in body and "totals" in body and "server" in body
    assert any(h["name"] == "감독병원" for h in body["hospitals"])
    assert body["server"]["api"] is True


# ────────────────────────────── 가입 환경 설정 공개 조회 (요구 7) ──────────────────────────────
def test_signup_fields_public_endpoint(client, auth_headers):
    """가입 화면은 무인증이므로 signup.fields.* 를 공개 엔드포인트로 읽는다.

    미설정=빈 목록(기존 폼 회귀 0) · 관리자 저장분 무인증 왕복 · 알 수 없는 kind 404.
    """
    # 미설정 → 빈 목록 (프론트는 null 처리 → 기존 기본 폼 유지)
    r = client.get("/api/signup/fields/client")
    assert r.status_code == 200, r.text
    assert r.json() == {"kind": "client", "fields": []}

    # 관리자가 설정(전역) → 무인증으로 그대로 조회 가능
    cfg = {"fields": [
        {"key": "name", "label": "병원 이름", "enabled": True, "required": True},
        {"key": "fax", "label": "Fax", "enabled": False, "required": False},
    ]}
    r = client.put("/api/settings/signup.fields.hospital", headers=auth_headers,
                   json={"value": cfg, "scope": "global"})
    assert r.status_code == 200, r.text
    r2 = client.get("/api/signup/fields/hospital")  # 무인증
    assert r2.status_code == 200
    assert r2.json()["fields"] == cfg["fields"]

    # 알 수 없는 kind → 404 (임의 설정 키 노출 방지)
    assert client.get("/api/signup/fields/nope").status_code == 404
