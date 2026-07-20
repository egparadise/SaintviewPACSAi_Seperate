"""동시 로그인(세션 인계) — (hospital_id, username) 당 활성 Client 세션 추적.

poll 기반 자발적 로그아웃(하드 revoke 아님) — Client 뷰어 UX 목적.
- register: 로그인 시 세션 등록 → session_id(=JWT sid) 반환.
- find_live: 같은 (병원, 사용자)의 살아있는 세션(비인계, TTL 내) 1건.
- revoke: 인계 예약 — 기존 세션에 카운트다운(revoke_deadline) 설정.
- status: /auth/session-status poll — 종료 예고 상태 반환 + last_seen 갱신(하트비트).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.models import ActiveSession

SESSION_TTL = 30        # 이 초 이내 last_seen 이면 '살아있는' 세션(poll 주기보다 넉넉히)
REVOKE_COUNTDOWN = 10   # 인계 Yes 후 기존 세션 종료까지 카운트다운(초)
_STALE = SESSION_TTL * 20  # 이보다 오래된 세션 행은 정리


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    """SQLite 등에서 naive 로 돌아온 datetime 을 UTC-aware 로 보정."""
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def find_live(db: Session, hospital_id: int | None, username: str) -> ActiveSession | None:
    """해당 (병원, 사용자)의 살아있는 세션 1건 — 인계 예약(revoke_deadline) 없고 TTL 내."""
    cutoff = _now() - timedelta(seconds=SESSION_TTL)
    return db.execute(
        select(ActiveSession)
        .where(
            ActiveSession.hospital_id == (hospital_id or 0),
            ActiveSession.username == username,
            ActiveSession.revoke_deadline.is_(None),
            ActiveSession.last_seen >= cutoff,
        )
        .order_by(ActiveSession.last_seen.desc())
    ).scalars().first()


def register(db: Session, hospital_id: int | None, username: str) -> str:
    """새 세션 등록 → session_id 반환. 오래된 행 정리도 겸함(커밋은 호출부)."""
    db.execute(delete(ActiveSession).where(ActiveSession.last_seen < _now() - timedelta(seconds=_STALE)))
    sid = uuid.uuid4().hex
    db.add(ActiveSession(session_id=sid, hospital_id=hospital_id or 0, username=username, last_seen=_now()))
    return sid


def revoke(db: Session, sess: ActiveSession, reason: str) -> None:
    """기존 세션 인계 예약 — 카운트다운 시작(커밋은 호출부)."""
    sess.revoke_deadline = _now() + timedelta(seconds=REVOKE_COUNTDOWN)
    sess.revoke_reason = reason[:200]


def status(db: Session, sid: str) -> dict:
    """poll — 해당 sid 의 종료 예고 상태 + last_seen 갱신(하트비트). 커밋은 호출부."""
    sess = db.execute(select(ActiveSession).where(ActiveSession.session_id == sid)).scalar_one_or_none()
    if not sess:
        return {"revoked": False, "reason": "", "seconds_left": 0}
    sess.last_seen = _now()
    dl = _aware(sess.revoke_deadline)
    if dl is not None:
        left = (dl - _now()).total_seconds()
        return {"revoked": True, "reason": sess.revoke_reason, "seconds_left": max(0, int(round(left)))}
    return {"revoked": False, "reason": "", "seconds_left": 0}
