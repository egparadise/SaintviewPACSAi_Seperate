"""A 계정 미러링 — 아이디·이름·역할만. 인증은 계속 A 가 한다.

지켜야 하는 계약(깨지면 자격증명 관리가 두 곳으로 갈라진다):
  ① **미러 계정은 로컬 비밀번호로 로그인할 수 없다.** password_hash 가 비어 있고,
     verify_password 가 어떤 입력에도 False 를 준다. 이게 이 설계 전체가 기대는 전제다.
  ② 비밀번호를 저장하지 않는다(A 응답에 애초에 없다).
  ③ 손으로 만든 로컬 계정은 동기화가 건드리지 않는다 — 관리자가 자기 시스템에서 잠기면 안 된다.
  ④ A 에서 사라진 계정은 **지우지 않고 비활성**한다(판독 이력이 참조한다).
  ⑤ 멱등 — 같은 목록을 두 번 넣어도 결과가 같다.
"""
from __future__ import annotations

import pytest

from app.services import account_mirror as am
from app.services.auth_service import verify_password

A_ROWS = [
    {"user_idx": 11, "user_id": "dr.kim", "user_name": "김판독", "user_type": "P", "user_status": "A"},
    {"user_idx": 12, "user_id": "mgr.lee", "user_name": "이관리", "user_type": "MP",
     "user_status": "A", "group_level": 99},
    {"user_idx": 13, "user_id": "tech.park", "user_name": "박기사", "user_type": "M", "user_status": "A"},
    {"user_idx": 14, "user_id": "gone.choi", "user_name": "최퇴사", "user_type": "P", "user_status": "D"},
]


@pytest.fixture()
def clean(db):
    """이 테스트가 만든 계정만 정리."""
    yield
    from app.models import Account

    for u in ("dr.kim", "mgr.lee", "tech.park", "gone.choi", "local.only"):
        a = db.query(Account).filter_by(username=u).first()
        if a:
            db.delete(a)
    db.commit()


def _get(db, username):
    from app.models import Account

    return db.query(Account).filter_by(username=username).first()


def test_mirror_account_cannot_log_in_with_any_password(db, clean):
    """① 핵심 계약 — 미러 계정은 **어떤 비밀번호로도** 로컬 로그인이 안 된다."""
    am.sync_accounts(db, A_ROWS)
    acc = _get(db, "dr.kim")
    assert acc is not None
    assert acc.password_hash == "", "미러 계정에 해시가 생기면 로컬 로그인 경로가 열린다"
    for guess in ("", "1234", "dr.kim", "admin1234", "a" * 64):
        assert verify_password(guess, acc.password_hash) is False, guess


def test_no_password_material_is_stored(db, clean):
    """② A 응답에 비번이 없고, 우리도 저장하지 않는다."""
    rows = [{**r, "user_passwd": "sha.LEAKED"} for r in A_ROWS]   # 혹시 섞여 와도
    am.sync_accounts(db, rows)
    acc = _get(db, "dr.kim")
    assert acc.password_hash == ""
    assert "LEAKED" not in (acc.pw_plain or "")
    assert acc.pw_plain == ""


def test_role_mapping_is_narrow(db, clean):
    """역할은 넓게 주지 않는다 — 관리자급만 admin, P 없으면 최소 권한."""
    assert am.map_role("P", None) == "radiologist"
    assert am.map_role("MP", 99) == "admin"
    assert am.map_role("M", None) == "staff"
    assert am.map_role(None, None) == "staff"
    assert am.map_role("P", 97) == "radiologist", "98 미만은 관리자가 아니다"


def test_blocked_user_is_mirrored_disabled(db, clean):
    """A 에서 차단(user_status='D')된 계정은 비활성으로 들어온다."""
    am.sync_accounts(db, A_ROWS)
    assert _get(db, "gone.choi").enabled is False
    assert _get(db, "dr.kim").enabled is True


def test_local_only_account_is_never_touched(db, clean):
    """③ 손으로 만든 로컬 계정(a_user_idx 없음)은 건드리지 않는다."""
    from app.models import Account
    from app.services.auth_service import hash_password

    db.add(Account(username="local.only", password_hash=hash_password("keep-me"),
                   role="admin", enabled=True))
    db.commit()

    am.sync_accounts(db, A_ROWS)          # A 목록에 local.only 는 없다

    acc = _get(db, "local.only")
    assert acc.enabled is True, "로컬 계정이 'A 에 없다'는 이유로 잠기면 관리자가 갇힌다"
    assert acc.role == "admin"
    assert verify_password("keep-me", acc.password_hash) is True


def test_vanished_mirror_is_disabled_not_deleted(db, clean):
    """④ A 에서 사라지면 비활성 — 삭제는 판독 이력을 끊는다."""
    am.sync_accounts(db, A_ROWS)
    assert _get(db, "tech.park").enabled is True

    am.sync_accounts(db, [r for r in A_ROWS if r["user_id"] != "tech.park"])

    acc = _get(db, "tech.park")
    assert acc is not None, "삭제하면 안 된다"
    assert acc.enabled is False


def test_sync_is_idempotent(db, clean):
    """⑤ 두 번 돌려도 같은 결과. 두 번째는 생성 0."""
    first = am.sync_accounts(db, A_ROWS)
    second = am.sync_accounts(db, A_ROWS)
    assert first.created == 4
    assert second.created == 0 and second.updated == 0


def test_dry_run_changes_nothing(db, clean):
    """미리보기는 세기만 한다."""
    res = am.sync_accounts(db, A_ROWS, dry_run=True)
    assert res.created == 4
    assert _get(db, "dr.kim") is None


def test_api_requires_admin(client, auth_headers):
    """관리자 전용 — 무인증은 401."""
    assert client.post("/api/webpacs/mirror-accounts").status_code == 401
