"""협진 초대 정책(2026-08-10 사용자 확정) — 1:1 대화·통화는 **차단만 아니면 허용**.

친구가 아니어도 [찾기]>[초대]로 대화·통화를 시작할 수 있어야 한다. 친구 관계는
목록·프레즌스 편의일 뿐 자격이 아니다. 통화 시그널 게이트(collab_ws._can_relay_dm_rtc)가
friend_ids 대신 dm_allowed(차단 검사)를 쓰는 것이 이 계약의 구현이다.
"""
from __future__ import annotations

from datetime import datetime, timezone


def _link(db, a, b, status, requester=None):
    from app.models import CollabFriend

    lo, hi = min(a, b), max(a, b)
    row = CollabFriend(low_id=lo, high_id=hi, requester_id=requester or a, status=status,
                       requested_at=datetime.now(timezone.utc))
    if status == "blocked":
        row.blocked_by = requester or a
    db.add(row)
    db.commit()
    return row


def test_dm_allowed_without_any_friendship(db):
    """관계 행이 아예 없는 두 사용자 — 초대(대화·통화) 허용."""
    from app.services import collab_service as svc

    assert svc.dm_allowed(db, 9301, 9302) is True


def test_dm_allowed_when_pending_or_accepted(db):
    """대기 중·수락 관계 — 당연히 허용(친구 여부는 자격이 아니다)."""
    from app.services import collab_service as svc

    _link(db, 9303, 9304, "pending")
    _link(db, 9305, 9306, "accepted")
    assert svc.dm_allowed(db, 9303, 9304) is True
    assert svc.dm_allowed(db, 9306, 9305) is True


def test_dm_blocked_is_the_only_refusal(db):
    """차단은 양방향 모두 거부 — 유일한 거부 사유."""
    from app.services import collab_service as svc

    _link(db, 9307, 9308, "blocked", requester=9307)
    assert svc.dm_allowed(db, 9307, 9308) is False
    assert svc.dm_allowed(db, 9308, 9307) is False


def test_rtc_gate_uses_dm_allowed_not_friend_ids():
    """통화 시그널 게이트가 friend_ids(친구 한정)로 되돌아가면 초대 계약이 깨진다 — 소스 계약."""
    import inspect

    from app.api import collab_ws

    src = inspect.getsource(collab_ws._can_relay_dm_rtc)
    assert "dm_allowed" in src, "차단 검사(dm_allowed)를 써야 한다"
    assert "friend_ids" not in src, "친구 한정 게이트 금지(2026-08-10 초대 계약)"
