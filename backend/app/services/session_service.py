"""동시 로그인(세션 인계) — (hospital_id, username) 당 활성 Client 세션 추적.

poll 기반 자발적 로그아웃(하드 revoke 아님) — Client 뷰어 UX 목적.
- register: 로그인 시 세션 등록 → session_id(=JWT sid) 반환.
- find_live: 같은 (병원, 사용자)의 살아있는 세션(비인계, TTL 내) 1건.
- revoke: 인계 예약 — 기존 세션에 카운트다운(revoke_deadline) 설정.
- status: /auth/session-status poll — 종료 예고 상태 반환 + last_seen 갱신(하트비트).
- pixel_session: 픽셀 GET 전용 쿠키(sv_pix)의 sid 검증 — 취소 가능한 자격증명의 실체.
- end: 로그아웃 — 세션 행 삭제(쿠키가 가리키던 sid 를 즉시 무효화).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.models import ActiveSession

SESSION_TTL = 30        # 이 초 이내 last_seen 이면 '살아있는' 세션(poll 주기보다 넉넉히)
REVOKE_COUNTDOWN = 10   # 인계 Yes 후 기존 세션 종료까지 카운트다운(초)
_STALE = SESSION_TTL * 20  # 이보다 오래된 세션 행은 정리(하한 — 아래 _max_age 가 우선)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _max_age() -> int:
    """세션 행이 의미를 갖는 최대 시간(초) = JWT 만료(기본 8시간).

    왜 필요한가: 픽셀 쿠키(sv_pix)는 이 행을 근거로 검증된다. 예전 _STALE(600초)로
    행을 지워 버리면, 포털 창을 닫고 뷰어 창만 열어 둔 사용자가 다른 사람의 로그인
    한 번에 영상만 401 로 끊긴다(판독 화면의 빈 화면 = 오진 위험). 그래서 행의 수명을
    쿠키/JWT 수명과 같은 값으로 맞춘다 — 더 오래 살리지도, 더 일찍 죽이지도 않는다.
    """
    from app.config import get_settings

    return max(1, get_settings().jwt_expire_minutes) * 60


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
    stale = max(_STALE, _max_age())
    db.execute(delete(ActiveSession).where(ActiveSession.last_seen < _now() - timedelta(seconds=stale)))
    sid = uuid.uuid4().hex
    db.add(ActiveSession(session_id=sid, hospital_id=hospital_id or 0, username=username, last_seen=_now()))
    return sid


def revoke(db: Session, sess: ActiveSession, reason: str) -> None:
    """기존 세션 인계 예약 — 카운트다운 시작(커밋은 호출부)."""
    sess.revoke_deadline = _now() + timedelta(seconds=REVOKE_COUNTDOWN)
    sess.revoke_reason = reason[:200]


def pixel_session(db: Session, sid: str) -> dict | None:
    """픽셀 GET 전용 쿠키(sv_pix)의 sid 검증 → 사용자 dict, 실패면 None.

    JWT 대신 이 불투명 sid 를 쿠키에 담는 이유가 여기 있다: JWT 는 발급 후 만료(8시간)까지
    취소할 수 없지만, 이 검증은 매 요청 DB 를 보므로 로그아웃(행 삭제)·중복 로그인 인계
    (revoke_deadline)가 즉시 반영된다.

    ⚠ last_seen 을 갱신하지 않는다 — 픽셀 GET 은 슬라이스마다 발생하는 최다 빈도 요청이라
      매번 UPDATE 를 걸면 DB 가 무너지고, find_live(30초 창)의 중복 로그인 판정 의미도 바뀐다.
      하트비트는 지금처럼 /auth/session-status poll 이 담당한다.
      읽기 1회(session_id 유니크 인덱스)는 남긴다 — 즉시 취소를 포기하지 않기 위한 값이고,
      헤더(Bearer)로 오는 호출자는 이 경로를 아예 타지 않는다.
    """
    if not sid or len(sid) > 64:
        return None
    sess = db.execute(
        select(ActiveSession).where(ActiveSession.session_id == sid)
    ).scalar_one_or_none()
    if sess is None:
        return None
    # 중복 로그인 인계 — 카운트다운이 끝난 구 세션의 쿠키는 더 이상 픽셀을 못 받는다
    dl = _aware(sess.revoke_deadline)
    if dl is not None and _now() >= dl:
        return None
    seen = _aware(sess.last_seen)
    if seen is not None and seen < _now() - timedelta(seconds=_max_age()):
        return None
    # 픽셀 엔드포인트는 이 값을 쓰지 않지만(현재 인가 근거가 A 측에 없다), 감사·후속
    # 스코프 축소(세션이 연 study_uid 집합)를 위해 신원을 실어 둔다.
    return {"sub": sess.username, "hid": sess.hospital_id or None, "sid": sid, "via": "cookie"}


def end(db: Session, sid: str) -> bool:
    """로그아웃 — 세션 행 삭제(커밋은 호출부). 그 sid 를 담은 픽셀 쿠키가 즉시 무효가 된다."""
    if not sid:
        return False
    n = db.execute(delete(ActiveSession).where(ActiveSession.session_id == sid)).rowcount
    return bool(n)


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
