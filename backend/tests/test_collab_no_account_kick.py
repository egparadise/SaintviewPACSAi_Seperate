"""협진 버튼을 누르면 **화면이 튕겨 나가던 것** — 재발 방지 계약.

실제 사고(sv70): A 계정으로 로그인한 사용자가 워크리스트/뷰어에서 [협진]을 누르는 순간
로그인 화면으로 튕겨 나갔다.

사슬은 이랬다:
  ① A 로그인(webpacs-login)은 로컬 Account 행 없이 세션을 만든다(uid=None, sub=A아이디)
  ② 협진은 Account.id 기반 — account_of() 가 행을 못 찾는다
  ③ _me() 가 **401** 을 냈다
  ④ 프론트 전역 401 처리기는 '세션 만료' 로 보고 setToken(null) + 강제 리로드
  → 멀쩡한 세션이 협진 클릭 한 번에 로그아웃됐다

계약 두 개로 막는다:
  · '계정 행 없음' 은 **403** 이다 — 401 은 세션 만료 전용(프론트가 로그아웃한다)
  · A 로그인 성공 시 미러 행을 **자동 보장**한다(ensure_mirror) — 협진이 실제로 동작한다
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.api.collab import _me
from app.services.account_mirror import ensure_mirror


def test_missing_account_is_403_not_401(db):
    """★ 핵심 회귀 방어 — 401 로 되돌리면 협진 클릭이 다시 사용자를 로그아웃시킨다."""
    ghost = {"sub": "존재하지않는계정", "uid": None, "sid": "s1"}
    with pytest.raises(HTTPException) as e:
        _me(db, ghost)
    assert e.value.status_code == 403, (
        f"{e.value.status_code} — 401 이면 프론트 전역 처리기가 강제 로그아웃한다(그 사고다)")


def test_a_login_provisions_a_mirror_account(db):
    """A 로그인 직후 ensure_mirror 가 만든 행으로 협진(_me)이 성립한다."""
    acc = ensure_mirror(db, user_id="a_doctor1", name="김판독", role="doctor", a_user_idx=77)
    db.commit()
    assert acc.username == "a_doctor1"
    assert acc.a_user_idx == 77
    assert acc.password_hash == "", "미러는 로컬 비밀번호 로그인이 불가능해야 한다(모듈 계약)"
    # 이제 A 세션 dict(uid 없음, sub=아이디)로 협진 신원이 잡힌다 — 튕김의 반대편 증명
    me = _me(db, {"sub": "a_doctor1", "uid": None, "sid": "s2", "a_user": True})
    assert me.id == acc.id


def test_ensure_mirror_is_idempotent(db):
    a1 = ensure_mirror(db, user_id="a_doc2", name="이판독", role="doctor", a_user_idx=88)
    db.commit()
    a2 = ensure_mirror(db, user_id="a_doc2", name="이판독", role="doctor", a_user_idx=88)
    assert a1.id == a2.id, "같은 로그인을 반복하면 같은 행이어야 한다"


def test_ensure_mirror_reenables_blocked_mirror(db):
    """A 가 방금 인증해 줬다 — 꺼져 있던 미러는 다시 켠다(차단이 풀린 계정)."""
    acc = ensure_mirror(db, user_id="a_doc3", name="박판독", role="doctor", a_user_idx=99)
    acc.enabled = False
    db.commit()
    again = ensure_mirror(db, user_id="a_doc3", name="박판독", role="doctor", a_user_idx=99)
    assert again.enabled is True


def test_ensure_mirror_never_hijacks_local_account(db):
    """손으로 만든 동명 로컬 계정은 **그대로 쓴다** — 미러로 바꾸면 관리자가 잠길 수 있다."""
    from app.models import Account

    local = Account(username="admin2", password_hash="argon2-실제해시라고치자", role="admin",
                    enabled=True, title="진짜 관리자", a_user_idx=None)
    db.add(local)
    db.commit()

    got = ensure_mirror(db, user_id="admin2", name="A쪽이름", role="doctor", a_user_idx=55)
    assert got.id == local.id
    assert got.password_hash == "argon2-실제해시라고치자", "로컬 비밀번호를 지웠다 — 관리자 잠금 사고"
    assert got.role == "admin", "역할을 덮었다"
    assert got.title == "진짜 관리자", "이름을 덮었다"
    assert got.a_user_idx is None, "로컬 계정을 미러로 둔갑시켰다"


def test_ws_close_codes_are_distinct():
    """WS: '계정 없음(4403)' 과 '인증 만료(4401)' 는 달라야 한다 — 같으면 거짓 안내가 뜬다."""
    from app.api import collab_ws as ws

    assert ws.CLOSE_NO_ACCOUNT != ws.CLOSE_UNAUTHORIZED
    assert ws.CLOSE_NO_ACCOUNT == 4403
