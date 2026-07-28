"""픽셀 컷오프 고지 — "인계 픽셀 컷오프를 알리는 UI 가 포털 창에만 있어 뷰어가 조용히 빈 화면".

검증할 불변식(서비스 계층 직접 — HTTP 경로는 별도 결함 때문에 못 씀. 아래 주석 참조):
  ① revoke 를 걸 수 있는 조건 = find_live(last_seen 30초 이내). last_seen 을 갱신하는
     주체는 register(로그인)와 status(/auth/session-status poll)뿐이고, poll 을 도는
     주체는 배너를 그리는 SessionGuard 다. 포털이 죽으면 인계가 아예 성립하지 않는다.
  ② revoke 직후 status(poll)는 곧바로 revoked=true + seconds_left≈10 을 준다.
     그 시점에 pixel_session 은 아직 유효 → 경고가 컷오프보다 먼저 온다.
  ③ 무음 빈 화면이 성립하려면 poll 주기 P > REVOKE_COUNTDOWN(10초) 여야 한다(수식).
  ④ 같은 브라우저 재로그인은 sv_pix 를 새 sid 로 덮는다 → 그 창에는 401 자체가 없다.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest


def _mk(client, auth_headers, code, name):
    r = client.post("/api/admin/hospitals", headers=auth_headers,
                    json={"code": code, "name": name, "license_clients": 5})
    assert r.status_code == 200, r.text
    return r.json()["id"], code


def _seed(db, hid, user, age_s):
    """세션 행 직접 삽입 — last_seen 이 age_s 초 전(=포털 poll 이 그때 멈춤)."""
    import uuid

    from app.models import ActiveSession
    sid = uuid.uuid4().hex
    db.add(ActiveSession(session_id=sid, hospital_id=hid, username=user,
                         last_seen=datetime.now(timezone.utc) - timedelta(seconds=age_s)))
    db.commit()
    return sid


@pytest.mark.parametrize("age,live,pix", [
    (0, True, True), (29, True, True), (31, False, True),
    (600, False, True), (7200, False, True),      # 포털 닫고 2시간 — 픽셀은 그대로
    (28801, False, False),                        # JWT/쿠키 수명(8h) 초과 — 여기서만 만료
])
def test_revoke_can_only_target_a_session_whose_banner_poll_is_alive(db, age, live, pix):
    """① 하트비트(=배너를 그리는 poll)가 멈춘 세션에는 카운트다운을 걸 방법이 없다."""
    from app.services import session_service

    user = f"rb3a{age}"
    sid = _seed(db, 9001, user, age)
    found = session_service.find_live(db, 9001, user)
    assert (found is not None) is live, (age, found)
    # 인계가 안 걸리는 경우 = 픽셀 자격은 쿠키 수명까지 그대로다(빈 화면이 생기지 않는다)
    assert (session_service.pixel_session(db, sid) is not None) is pix, age


def test_the_same_poll_that_arms_the_revoke_delivers_the_banner(db):
    """② 인계 직후 첫 poll 이 배너 정보를 주고, 그 순간 픽셀은 아직 살아 있다."""
    from app.services import session_service

    sid = _seed(db, 9002, "rb3b", 0)
    live = session_service.find_live(db, 9002, "rb3b")
    assert live is not None
    session_service.revoke(db, live, "다른 곳에서 로그인됩니다.")
    db.commit()

    st = session_service.status(db, sid)          # = SessionGuard 의 다음 poll
    db.commit()
    assert st["revoked"] is True and st["seconds_left"] >= 9, st
    # 배너가 뜬 그 시점에 픽셀은 유효하다 → 경고가 화면 끊김보다 앞선다
    assert session_service.pixel_session(db, sid) is not None, "배너보다 픽셀이 먼저 죽었다"

    # 카운트다운 종료 후에야 401 이 된다(그때는 이미 배너가 10초째 떠 있었다)
    from sqlalchemy import select

    from app.models import ActiveSession
    row = db.execute(select(ActiveSession).where(ActiveSession.session_id == sid)).scalar_one()
    row.revoke_deadline = datetime.now(timezone.utc) - timedelta(seconds=1)
    db.commit()
    assert session_service.pixel_session(db, sid) is None


def test_silent_blank_requires_a_poll_period_longer_than_the_countdown():
    """③ 수식: 무음 구간 = (다음 poll) - (컷오프). P ≤ 10초면 음수 = 무음이 불가능."""
    from app.services import session_service

    P = 3            # SessionGuard.tsx setInterval(3000)
    C = session_service.REVOKE_COUNTDOWN
    T = session_service.SESSION_TTL
    # 마지막 poll t, 인계 f (arming 조건 f-t ≤ T), 컷오프 f+C, 배너 t+P
    worst = max((t_p + P) - (f + C) for t_p in (0,) for f in range(0, T + 1))
    assert worst < 0, f"P={P},C={C},T={T} 에서 무음 구간 {worst}s"
    assert P <= C, "poll 주기가 카운트다운보다 짧아야 배너가 먼저 뜬다"


def test_same_browser_relogin_replaces_the_pixel_cookie(client, auth_headers, db):
    """④ 같은 브라우저에서 다시 로그인하면 쿠키가 새 sid 로 덮인다 → 401 이 없다."""
    from app.services import session_service

    hid, hcode = _mk(client, auth_headers, "RB3C", "반박3-쿠키")
    client.post("/api/admin/accounts", headers=auth_headers, json={
        "username": "rb3ck", "password": "viewer12345", "role": "radiologist", "hospital_id": hid})
    r1 = client.post("/api/auth/client-login",
                     json={"hospital_id": hcode, "username": "rb3ck", "password": "viewer12345"})
    first = r1.cookies.get("sv_pix")
    assert first

    # 포털 poll 이 멈춘 뒤(=중복 판정 없음) 같은 브라우저에서 다시 로그인
    from sqlalchemy import select

    from app.models import ActiveSession
    row = db.execute(select(ActiveSession).where(ActiveSession.session_id == first)).scalar_one()
    row.last_seen = datetime.now(timezone.utc) - timedelta(seconds=31)
    db.commit()
    r2 = client.post("/api/auth/client-login",
                     json={"hospital_id": hcode, "username": "rb3ck", "password": "viewer12345"})
    second = r2.cookies.get("sv_pix")
    assert second and second != first
    assert client.cookies.get("sv_pix") == second      # 쿠키 항아리에는 새 sid 만 남는다
    assert session_service.pixel_session(db, second) is not None
