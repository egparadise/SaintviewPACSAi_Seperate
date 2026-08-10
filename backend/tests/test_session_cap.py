"""동시 로그인 3시스템(2026-08-10 사용자 확정) — 계정당 활성 세션 상한 3.

계약:
  · 3개까지는 프롬프트 없이 로그인된다(태블릿·노트북·판독환경을 같은 계정으로).
  · 4번째 로그인은 {duplicate:true, max_sessions:3} → force 는 **가장 오래 안 쓴
    세션 하나만** 인계한다 — 나머지 두 시스템은 계속 산다.
  · 상한 판단·인계 대상 선정은 session_service(live_sessions/enforce_cap) 한 곳이다.
    A(webpacs) 로그인 경로도 같은 enforce_cap 을 쓴다(프롬프트 채널이 없어 자동 인계).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone


def _mk(client, auth_headers, code, name):
    r = client.post("/api/admin/hospitals", headers=auth_headers,
                    json={"code": code, "name": name, "license_clients": 5})
    assert r.status_code == 200, r.text
    return r.json()["id"], code


def _acct(client, auth_headers, hid, user):
    r = client.post("/api/admin/accounts", headers=auth_headers, json={
        "username": user, "password": "viewer12345", "role": "radiologist", "hospital_id": hid})
    assert r.status_code == 200, r.text


def _login(client, hcode, user, force=False):
    path = "/api/auth/client-login" + ("/force" if force else "")
    return client.post(path, json={"hospital_id": hcode, "username": user, "password": "viewer12345"})


def test_three_systems_login_without_prompt_and_fourth_prompts(client, auth_headers, db):
    """3개까지 무프롬프트, 4번째만 duplicate — 1세션 인계 모델(구)로 돌아가면 여기서 죽는다."""
    from app.services import session_service

    hid, hcode = _mk(client, auth_headers, "MS3A", "다중시스템A")
    _acct(client, auth_headers, hid, "ms3a")

    for i in range(3):                       # 태블릿 → 노트북 → 판독 PC
        r = _login(client, hcode, "ms3a")
        assert r.status_code == 200, r.text
        assert r.json().get("token") and not r.json().get("duplicate"), (i, r.json())
    assert len(session_service.live_sessions(db, hid, "ms3a")) == 3

    j = _login(client, hcode, "ms3a").json()   # 4번째 시스템 → Yes/No 프롬프트
    assert j.get("duplicate") is True, j
    assert j.get("max_sessions") == session_service.MAX_LIVE_SESSIONS == 3, j


def test_force_hands_over_only_the_oldest_session(client, auth_headers, db):
    """force 인계는 가장 오래 안 쓴 세션 **하나만** — 나머지 시스템은 계속 산다."""
    from sqlalchemy import select

    from app.models import ActiveSession
    from app.services import session_service

    hid, hcode = _mk(client, auth_headers, "MS3B", "다중시스템B")
    _acct(client, auth_headers, hid, "ms3b")
    sids = [_login(client, hcode, "ms3b").cookies.get("sv_pix") for _ in range(3)]
    assert all(sids)
    # last_seen 을 명시적으로 벌린다(같은 초 등록 → 최고령 판정 모호 방지). sids[0]=최고령.
    now = datetime.now(timezone.utc)
    for i, sid in enumerate(sids):
        row = db.execute(select(ActiveSession).where(ActiveSession.session_id == sid)).scalar_one()
        row.last_seen = now - timedelta(seconds=20 - i * 5)
    db.commit()

    r = _login(client, hcode, "ms3b", force=True)
    assert r.status_code == 200 and r.json().get("token"), r.text

    rows = {s: db.execute(select(ActiveSession).where(ActiveSession.session_id == s)).scalar_one()
            for s in sids}
    assert rows[sids[0]].revoke_deadline is not None, "가장 오래된 세션이 인계돼야 한다"
    assert rows[sids[1]].revoke_deadline is None and rows[sids[2]].revoke_deadline is None, \
        "나머지 시스템은 계속 산다(3슬롯 계약)"
    # 인계 예약 세션은 live 에서 빠지고 새 세션이 들어와 다시 3
    assert len(session_service.live_sessions(db, hid, "ms3b")) == 3


def test_live_sessions_orders_oldest_first_and_enforce_cap_math(db):
    """live_sessions 정렬(오래된 것부터)과 enforce_cap 의 초과분 계산 — 인계 정책의 근거."""
    from app.models import ActiveSession
    from app.services import session_service

    now = datetime.now(timezone.utc)
    by_age = {}
    for age in (25, 5, 15):
        sid = uuid.uuid4().hex
        db.add(ActiveSession(session_id=sid, hospital_id=9101, username="msord",
                             last_seen=now - timedelta(seconds=age)))
        by_age[age] = sid
    db.commit()

    got = [s.session_id for s in session_service.live_sessions(db, 9101, "msord")]
    assert got == [by_age[25], by_age[15], by_age[5]], "오래된 것부터"

    victims = session_service.enforce_cap(db, 9101, "msord", "테스트 인계")
    db.commit()
    assert [v.session_id for v in victims] == [by_age[25]], "상한 3 에서 +1 자리 = 최고령 1건만"
    assert len(session_service.live_sessions(db, 9101, "msord")) == 2

    # 2건뿐이면(자리 있음) enforce_cap 은 아무도 인계하지 않는다
    assert session_service.enforce_cap(db, 9101, "msord", "테스트 인계") == []


def test_webpacs_login_path_uses_the_same_cap(db):
    """A 계정 경로(username='a:…') — 같은 enforce_cap 이 4번째에서 최고령을 자동 인계."""
    from app.models import ActiveSession
    from app.services import session_service

    now = datetime.now(timezone.utc)
    sids = []
    for i in range(3):
        sid = uuid.uuid4().hex
        db.add(ActiveSession(session_id=sid, hospital_id=0, username="a:drkim",
                             last_seen=now - timedelta(seconds=20 - i * 5)))
        sids.append(sid)
    db.commit()

    victims = session_service.enforce_cap(db, None, "a:drkim",
                                          "같은 계정이 다른 시스템에서 로그인됩니다.")
    db.commit()
    assert [v.session_id for v in victims] == [sids[0]], "최고령 1건만 자동 인계"
    assert len(session_service.live_sessions(db, None, "a:drkim")) == 2
