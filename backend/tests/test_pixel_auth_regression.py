"""Live 픽셀 인증 회귀 고정 — 적대적 검증에서 살아남은 두 지적.

① [우회] 공개 자가가입이 Live 픽셀 게이트를 통째로 무력화했다.
   익명 공격자가 `POST /api/signup`(무인증, 승인 없음, role=admin, enabled=True) →
   `POST /api/auth/login` 두 번으로 HttpOnly sv_pix 쿠키를 정상 발급받고 A 의 모든 Live
   검사 PHI 픽셀을 받았다. 스위치 기본값도 켜짐(1)이었고 prod 게이트도 이 항목을 안 봤다.
   → 고친 것: (a) SAINTVIEW_SIGNUP_ENABLED 기본 0 (b) prod 기동 게이트가 켜짐을 거부
              (c) 켜더라도 가입 산출물은 병원·계정 모두 enabled=False(승인 대기).

② [회귀] 무자격 logout 이 픽셀 쿠키를 무조건 지웠다.
   쿠키 항아리는 브라우저 단위(탭 공유)인데 JWT 는 sessionStorage(탭별)라, 다른 탭의
   로그인 실패 한 번(401 → 프론트 setToken(null) → 자격 없는 POST /api/auth/logout)이
   판독 중인 탭의 sv_pix 를 지워 **영상만 조용히 401** 이 됐다.
   → 고친 것: (a) 서버는 자격증명을 제시한 요청에만 쿠키를 지운다(auth.logout)
              (b) 프론트는 이전 토큰이 있을 때만 serverLogout 을 보낸다(api.ts setToken).
   만료 토큰으로 로그아웃해도 쿠키가 지워져야 한다는 원래 요구는 그대로 유지된다.
"""
from __future__ import annotations

import socket
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "harness"))

from mock_webpacs_api import build_app  # noqa: E402

from app.services.webpacs_live import VID_BASE  # noqa: E402

VID1 = VID_BASE + 1


# ── 모의 A 서버 + 브리지 설정(픽셀이 실제로 나오는 URL 을 얻기 위해) ────────────
@pytest.fixture(scope="module")
def mock_remote():
    import uvicorn

    app = build_app(num_studies=1, instances_per_study=1)
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    for _ in range(200):
        if server.started:
            break
        time.sleep(0.05)
    assert server.started
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    t.join(timeout=5)


def _client(**kw):
    """TestClient — base_url 은 https(픽셀 쿠키가 Secure 라 http 로는 되돌아오지 않는다)."""
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app, base_url="https://testserver", **kw)


@pytest.fixture(scope="module")
def pixel_urls(mock_remote):
    """브리지를 모의 A 로 지정하고, 실제 픽셀이 나오는 rendered/thumb URL 한 쌍을 만든다."""
    c = _client()
    r = c.post("/api/auth/login", json={"username": "admin", "password": "admin1234"})
    assert r.status_code == 200, r.text
    headers = {"Authorization": f"Bearer {r.json()['token']}"}
    r = c.put("/api/webpacs/config", headers=headers, json={"value": {
        "enabled": True, "base_url": mock_remote,
        "user_id": "webpacs", "password": "webpacs1234",
    }})
    assert r.status_code == 200, r.text
    tree = c.get(f"/api/webpacs/live/studies/{VID1}/series-tree", headers=headers).json()
    s0 = tree["series"][0]
    i0 = s0["instances"][0]
    return {
        "rendered": (f"/api/webpacs/live/dicom-web/studies/{tree['study_uid']}"
                     f"/series/{s0['series_uid']}/instances/{i0['sop_uid']}/rendered"),
        "thumb": i0["preview_url"],
    }


@pytest.fixture()
def signup_on():
    from app.config import get_settings

    s = get_settings()
    old = s.signup_enabled
    s.signup_enabled = True
    yield
    s.signup_enabled = old


def _signup_payload(username: str, hosp: str):
    return {
        "hospital": {"name": hosp, "license_clients": 1},
        "registrant": {"name": "공격자", "username": username,
                       "password": "attack12345", "password_confirm": "attack12345"},
        "billing": {"method": "monthly_transfer"},
    }


# ══════════════════ ① 공개 자가가입이 픽셀 게이트를 우회하던 경로 ══════════════════
def test_public_signup_is_off_by_default(client):
    """스위치 기본값이 꺼짐이고, 꺼져 있으면 무인증 가입 자체가 403."""
    from app.config import get_settings

    assert get_settings().signup_enabled is False, "공개 자가가입이 기본으로 켜져 있다"
    r = _client().post("/api/signup", json=_signup_payload("atk_off", "기본꺼짐병원"))
    assert r.status_code == 403, r.text
    assert client.get("/api/signup/enabled").json()["enabled"] is False


def test_prod_gate_refuses_to_boot_with_public_signup(monkeypatch):
    """prod 기동 게이트가 이 항목을 본다 — 켜져 있으면 기동 거부(문구에 근거 포함)."""
    from app.config import Settings

    s = Settings()
    monkeypatch.setattr(s, "env", "prod")
    monkeypatch.setattr(s, "signup_enabled", True)
    with pytest.raises(RuntimeError) as exc:
        s.validate_for_prod()
    assert "SAINTVIEW_SIGNUP_ENABLED" in str(exc.value)

    # 꺼 두면 이 항목은 사라진다(다른 항목으로 걸리더라도 signup 은 언급되지 않는다)
    monkeypatch.setattr(s, "signup_enabled", False)
    try:
        s.validate_for_prod()
    except RuntimeError as e:
        assert "SAINTVIEW_SIGNUP_ENABLED" not in str(e)


def test_self_signup_cannot_mint_a_pixel_credential(pixel_urls, signup_on):
    """가입을 켜 두어도 '가입→로그인' 만으로는 픽셀 자격이 나오지 않는다(승인 대기).

    지적의 재현 시퀀스를 그대로 따라간다:
      signup 200 → 무자격 rendered 401 → login → 쿠키 → rendered 200(이었다)
    """
    atk = _client()
    r = atk.post("/api/signup", json=_signup_payload("attacker9", "공격자병원"))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["pending"] is True, "가입이 즉시 활성 계정을 만들었다"

    # 자격 없는 픽셀은 401 (기존 계약)
    assert atk.get(pixel_urls["rendered"]).status_code == 401

    # 콘솔 로그인 — 승인 전이라 401, 쿠키도 발급되지 않는다
    lg = atk.post("/api/auth/login",
                  json={"username": "attacker9", "password": "attack12345"})
    assert lg.status_code == 401, lg.text
    assert atk.cookies.get("sv_pix") is None, "실패한 로그인이 픽셀 쿠키를 남겼다"

    # Client 로그인 — 병원도 비활성이라 401
    cl = atk.post("/api/auth/client-login", json={
        "hospital_id": body["hospital_code"], "username": "attacker9",
        "password": "attack12345"})
    assert cl.status_code == 401, cl.text
    assert atk.cookies.get("sv_pix") is None

    # 결국 PHI 픽셀은 그대로 닫혀 있다
    for key in ("rendered", "thumb"):
        r = atk.get(pixel_urls[key])
        assert r.status_code == 401, f"{key}: 자가가입만으로 {r.status_code} — 게이트 우회"
        assert not r.headers.get("content-type", "").startswith("image/")


def test_signup_products_are_disabled_until_an_operator_approves(db, signup_on):
    """DB 상태로도 고정 — 가입이 만든 병원·계정은 둘 다 enabled=False."""
    from sqlalchemy import select

    from app.models import Account, Hospital

    r = _client().post("/api/signup", json=_signup_payload("pend_kim", "승인대기병원"))
    assert r.status_code == 200, r.text
    code = r.json()["hospital_code"]
    h = db.execute(select(Hospital).where(Hospital.code == code)).scalar_one()
    a = db.execute(select(Account).where(Account.username == "pend_kim")).scalar_one()
    assert h.enabled is False and a.enabled is False
    assert a.hospital_id == h.id


# ══════════════════ ② 무자격 logout 이 남의 픽셀 쿠키를 지우던 회귀 ══════════════════
def test_credentialless_logout_does_not_kill_another_tabs_pixel(pixel_urls):
    """지적의 [1]~[5] 시퀀스 고정 — 로그인 실패 한 번이 판독 중인 영상을 죽이면 안 된다."""
    c = _client()   # = 브라우저 하나(쿠키 항아리 공유). 탭은 이 항아리를 함께 쓴다.

    # [1] 탭 A: 로그인 → 픽셀 정상
    r = c.post("/api/auth/webpacs-login", json={"user_id": "dr_kim", "user_passwd": "kim1234"})
    assert r.status_code == 200, r.text
    sid = c.cookies.get("sv_pix")
    assert sid
    assert c.get(pixel_urls["rendered"]).status_code == 200

    # [2] 탭 B: 로그인 오입력 → 401 (프론트는 여기서 setToken(null) 을 부른다)
    bad = c.post("/api/auth/client-login",
                 json={"hospital_id": "없는병원", "username": "nobody", "password": "wrong1234"})
    assert bad.status_code == 401

    # [3] 그 결과로 나가던 '자격증명 0' 로그아웃 — 200 이되 쿠키를 지우지 않아야 한다
    out = c.post("/api/auth/logout")
    assert out.status_code == 200
    assert out.json().get("cleared") is False
    assert "sv_pix" not in (out.headers.get("set-cookie") or ""), \
        "자격 없는 요청이 남의 픽셀 쿠키를 지웠다(무인증 DoS)"

    # [4] 항아리에 쿠키가 그대로 있고 [5] 탭 A 의 영상도 그대로 살아 있다
    assert c.cookies.get("sv_pix") == sid
    r = c.get(pixel_urls["rendered"])
    assert r.status_code == 200 and r.headers["content-type"].startswith("image/")


def test_logout_with_expired_bearer_still_clears_the_cookie(pixel_urls):
    """원래 요구는 유지 — 만료·위조 토큰으로 로그아웃해도 브라우저 자격은 사라진다."""
    import time as _t

    import jwt as _jwt

    from app.config import get_settings

    c = _client()
    r = c.post("/api/auth/webpacs-login", json={"user_id": "dr_lee", "user_passwd": "lee1234"})
    assert r.status_code == 200, r.text
    assert c.get(pixel_urls["rendered"]).status_code == 200

    st = get_settings()
    expired = _jwt.encode({"sub": "dr_lee", "role": "doctor", "exp": int(_t.time()) - 60},
                          st.jwt_secret, algorithm=st.jwt_algorithm)
    out = c.post("/api/auth/logout", headers={"Authorization": f"Bearer {expired}"})
    assert out.status_code == 200 and out.json().get("cleared") is True
    assert not c.cookies.get("sv_pix"), "만료 토큰 로그아웃이 쿠키를 남겼다"


def test_logout_with_the_pixel_cookie_itself_still_ends_the_session(pixel_urls, db):
    """쿠키만 제시한 로그아웃(Path 를 넓힌 배치·비브라우저 호출자)도 그대로 동작한다."""
    from app.services import session_service

    c = _client()
    r = c.post("/api/auth/webpacs-login", json={"user_id": "dr_kim", "user_passwd": "kim1234"})
    assert r.status_code == 200, r.text
    sid = c.cookies.get("sv_pix")

    out = c.post("/api/auth/logout", headers={"Cookie": f"sv_pix={sid}"})
    assert out.status_code == 200 and out.json().get("cleared") is True
    assert session_service.pixel_session(db, sid) is None, "세션이 끝나지 않았다"
