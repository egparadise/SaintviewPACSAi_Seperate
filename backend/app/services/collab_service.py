"""협진(Co-Reading) 도메인 로직 — 친구·메신저·세션·제어권·임시 열람권.

전송(WebSocket 팬아웃)은 collab_hub 가, 상태·규칙은 여기가 갖는다.
여기 함수는 전부 **동기 SQLAlchemy** 다 — WS 경로에서 부를 때는 호출부가
run_in_threadpool 로 감싼다(이벤트루프를 막지 않기 위해).

보안 불변식(테스트 test_collab_perm.py 가 지킨다):
  1. 임시 열람권(CollabGrant)은 **조회**만 연다. 쓰기 권한은 1mm 도 늘지 않는다.
  2. 위임 가능한 것은 collab.* capability 뿐 — permissions.sanitize_collab_caps 가
     화이트리스트 교집합으로 강제하므로 report.write 같은 키는 통과 자체가 불가능하다.
  3. 세션이 닫히면 그 세션의 전 grant 에 revoked_at 이 찍힌다(즉시 무효).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.models import (
    Account,
    AuditLog,
    CollabFriend,
    CollabGrant,
    CollabMessage,
    CollabParticipant,
    CollabSession,
    Hospital,
    Study,
)
from app.services.permissions import (
    COLLAB_CAPS,
    COLLAB_DEFAULT_CAPS,
    sanitize_collab_caps,
)

logger = logging.getLogger("saintview.collab")

# 세션 정원 — P2P mesh WebRTC 기준. 참가자 N 명이면 각자 N-1 개를 업링크로 인코딩하므로
# 정원을 늘리는 순간 참가자 PC 의 CPU·업로드가 먼저 무너진다(서버가 아니라).
# 이 값을 넘기려면 SFU 도입이 선행되어야 한다.
MAX_PARTICIPANTS = 6

# 열람권 백스톱 만료 — 세션이 정상 종료되면 revoked_at 으로 즉시 죽지만,
# 브라우저 크래시·네트워크 단절로 close 가 영영 안 오는 경우가 실제로 있다.
# 그때 PHI 열람권이 무기한 살아 있으면 안 되므로 시간 상한을 둔다.
GRANT_MAX_HOURS = 12

# 제어권 위임 기본 수명 — 무기한 위임은 "잠깐 넘겨준" 것이 영구가 되는 사고를 부른다.
CONTROL_TTL_MIN = 30

DIRECTORY_LIMIT = 50
MESSAGE_PAGE = 50


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    """SQLite 에서 naive 로 돌아온 값 보정 (session_service._aware 와 같은 이유)."""
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


# ── 신원 ────────────────────────────────────────────────────────────────────
def account_of(db: Session, user: dict) -> Account | None:
    """JWT dict → Account. uid 를 우선 쓰고, 없으면(구 토큰) username 으로 찾는다."""
    uid = user.get("uid")
    if uid:
        acc = db.get(Account, int(uid))
        if acc is not None:
            return acc
    sub = user.get("sub")
    if not sub:
        return None
    return db.execute(select(Account).where(Account.username == sub)).scalar_one_or_none()


def display_of(acc: Account | None) -> str:
    if acc is None:
        return "(알 수 없음)"
    return acc.display_name or acc.username


def _hospital_names(db: Session, ids) -> dict[int, str]:
    ids = {int(i) for i in ids if i}
    if not ids:
        return {}
    rows = db.execute(select(Hospital.id, Hospital.name, Hospital.code)
                      .where(Hospital.id.in_(ids))).all()
    return {r[0]: (r[1] or r[2] or "") for r in rows}


def user_brief(db: Session, acc: Account, hosp: dict[int, str] | None = None) -> dict:
    """프론트 공용 사용자 표현 — 친구 목록·참가자·메시지 발신자에 모두 같은 모양을 쓴다."""
    hosp = hosp if hosp is not None else _hospital_names(db, [acc.hospital_id])
    return {
        "id": acc.id,
        "username": acc.username,
        "name": display_of(acc),
        "role": acc.role,
        "title": acc.title or "",
        "hospital_id": acc.hospital_id,
        "hospital": hosp.get(acc.hospital_id or 0, ""),
    }


# ── 디렉터리 검색 ────────────────────────────────────────────────────────────
def directory(db: Session, me: Account, q: str = "", only_other_hospital: bool = False,
              limit: int = DIRECTORY_LIMIT) -> list[dict]:
    """친구 요청 대상 검색 — 같은 병원 + 타 병원 모두.

    노출 범위는 이름·아이디·직책·역할·병원명뿐이다(연락처·생년 등 개인정보는 싣지 않는다).
    제외 대상은 둘뿐이다: **비활성 계정**과 **병원 미소속 시스템 관리자**(협진 상대가 아니다).

    ⚠ 예전에 `hospital_id IS NOT NULL` 로 걸렀는데 그것이 사고였다 —
      원격 PACS(A) 로그인으로 만들어지는 **미러 계정**은 hospital_id 가 없다
      (auth.webpacs-login → ensure_mirror 가 병원을 넘기지 않는다. A 신원에는 병원 개념이 없다).
      그래서 Live 모드 서버에서는 A 계정 사용자끼리 **서로를 절대 검색할 수 없었다**
      ("Sunshin_lee 를 찾아도 결과가 없습니다"). 의도했던 것은 '시스템 관리자 제외' 였으므로
      그 조건만 정확히 쓴다.

    ⚠ `enabled IS TRUE` 가 아니라 `IS NOT FALSE` 다 — 레거시 행(_sync_columns 의 ALTER 로
      추가된 컬럼)은 NULL 이고, auth_service.authenticate 는 그것을 **활성으로 본다**.
      두 곳의 규칙이 갈리면 '로그인은 되는데 친구 검색에는 영원히 안 보이는' 계정이 생긴다.
    """
    stmt = select(Account).where(
        Account.id != me.id,
        Account.enabled.isnot(False),
        ~and_(Account.role == "admin", Account.hospital_id.is_(None)),
    )
    term = (q or "").strip()
    if term:
        like = f"%{term}%"
        stmt = stmt.where(or_(Account.username.ilike(like),
                              Account.display_name.ilike(like),
                              Account.title.ilike(like)))
    if only_other_hospital and me.hospital_id:
        stmt = stmt.where(Account.hospital_id != me.hospital_id)
    rows = db.execute(stmt.order_by(Account.display_name, Account.username).limit(limit)).scalars().all()
    hosp = _hospital_names(db, [a.hospital_id for a in rows])
    # 이미 맺어진(또는 대기 중인) 관계를 함께 실어 준다 — 프론트가 버튼 상태를 결정한다
    rel = {r.low_id if r.high_id == me.id else r.high_id: r
           for r in _pairs_of(db, me.id)}
    out = []
    for a in rows:
        b = user_brief(db, a, hosp)
        link = rel.get(a.id)
        b["relation"] = link.status if link else ""
        b["relation_mine"] = bool(link and link.requester_id == me.id)
        out.append(b)
    return out


# ── 친구 ────────────────────────────────────────────────────────────────────
def _pair(a: int, b: int) -> tuple[int, int]:
    return (a, b) if a < b else (b, a)


def _pairs_of(db: Session, account_id: int) -> list[CollabFriend]:
    return list(db.execute(
        select(CollabFriend).where(or_(CollabFriend.low_id == account_id,
                                       CollabFriend.high_id == account_id))
    ).scalars().all())


def find_link(db: Session, a: int, b: int) -> CollabFriend | None:
    lo, hi = _pair(a, b)
    return db.execute(
        select(CollabFriend).where(CollabFriend.low_id == lo, CollabFriend.high_id == hi)
    ).scalar_one_or_none()


def are_friends(db: Session, a: int, b: int) -> bool:
    link = find_link(db, a, b)
    return bool(link and link.status == "accepted")


def friend_ids(db: Session, account_id: int) -> set[int]:
    """수락된 친구 id 집합 — 프레즌스 팬아웃 대상."""
    out: set[int] = set()
    for r in _pairs_of(db, account_id):
        if r.status != "accepted":
            continue
        out.add(r.high_id if r.low_id == account_id else r.low_id)
    return out


def list_friends(db: Session, me: Account) -> dict:
    """친구 목록 + 받은 요청 + 보낸 요청 — 한 번에 준다(프론트가 화면 한 벌로 그린다)."""
    rows = _pairs_of(db, me.id)
    other_ids = {(r.high_id if r.low_id == me.id else r.low_id) for r in rows}
    accs = {a.id: a for a in db.execute(
        select(Account).where(Account.id.in_(other_ids or {0}))).scalars().all()}
    hosp = _hospital_names(db, [a.hospital_id for a in accs.values()])
    friends, incoming, outgoing, blocked = [], [], [], []
    for r in rows:
        oid = r.high_id if r.low_id == me.id else r.low_id
        acc = accs.get(oid)
        if acc is None:
            continue
        item = user_brief(db, acc, hosp)
        item["link_id"] = r.id
        item["message"] = r.message
        if r.status == "accepted":
            friends.append(item)
        elif r.status == "pending":
            (outgoing if r.requester_id == me.id else incoming).append(item)
        elif r.status == "blocked":
            # 내가 차단한 것만 내 목록에 보인다(상대에겐 그냥 '관계 없음'으로 보인다)
            if r.blocked_by == me.id:
                blocked.append(item)
    friends.sort(key=lambda x: x["name"])
    return {"friends": friends, "incoming": incoming, "outgoing": outgoing, "blocked": blocked}


def request_friend(db: Session, me: Account, target_id: int, message: str = "") -> tuple[CollabFriend, str]:
    """친구 요청 → (관계행, 결과). 결과: created | accepted | exists

    상대가 이미 나에게 요청해 둔 상태라면 **자동 수락**으로 처리한다 —
    서로 요청해 놓고 둘 다 대기 중인 교착이 사용자 눈에는 버그로 보인다.
    """
    if target_id == me.id:
        raise ValueError("자기 자신에게는 친구 요청을 보낼 수 없습니다")
    target = db.get(Account, target_id)
    if target is None or target.enabled is False:
        raise LookupError("사용자를 찾을 수 없습니다")
    link = find_link(db, me.id, target_id)
    if link is not None:
        if link.status == "blocked":
            raise PermissionError("차단된 상대입니다")
        if link.status == "accepted":
            return link, "exists"
        if link.status == "pending":
            if link.requester_id == me.id:
                return link, "exists"
            # 상대가 먼저 보낸 요청이 대기 중 → 이 요청은 곧 '수락'이다
            link.status = "accepted"
            link.responded_at = _now()
            db.commit()
            return link, "accepted"
        # declined 였던 관계 — 다시 요청으로 되살린다
        link.status = "pending"
        link.requester_id = me.id
        link.message = (message or "")[:200]
        link.requested_at = _now()
        link.responded_at = None
        db.commit()
        return link, "created"
    lo, hi = _pair(me.id, target_id)
    link = CollabFriend(low_id=lo, high_id=hi, requester_id=me.id,
                        status="pending", message=(message or "")[:200], requested_at=_now())
    db.add(link)
    db.commit()
    return link, "created"


def respond_friend(db: Session, me: Account, other_id: int, accept: bool) -> CollabFriend:
    link = find_link(db, me.id, other_id)
    if link is None or link.status != "pending":
        raise LookupError("대기 중인 친구 요청이 없습니다")
    if link.requester_id == me.id:
        raise PermissionError("내가 보낸 요청은 내가 수락할 수 없습니다")
    link.status = "accepted" if accept else "declined"
    link.responded_at = _now()
    db.commit()
    return link


def set_block(db: Session, me: Account, other_id: int, blocked: bool) -> None:
    link = find_link(db, me.id, other_id)
    if blocked:
        if link is None:
            lo, hi = _pair(me.id, other_id)
            link = CollabFriend(low_id=lo, high_id=hi, requester_id=me.id, requested_at=_now())
            db.add(link)
        link.status = "blocked"
        link.blocked_by = me.id
        link.responded_at = _now()
    else:
        if link is None or link.status != "blocked":
            return
        if link.blocked_by != me.id:
            raise PermissionError("차단을 해제할 권한이 없습니다")
        link.status = "declined"
        link.blocked_by = None
    db.commit()


def unfriend(db: Session, me: Account, other_id: int) -> None:
    link = find_link(db, me.id, other_id)
    if link is None:
        return
    if link.status == "blocked" and link.blocked_by != me.id:
        raise PermissionError("차단된 관계입니다")
    db.delete(link)
    db.commit()


# ── 메신저 ──────────────────────────────────────────────────────────────────
DM_PREFIX = "dm:"
SESS_PREFIX = "sess:"


def dm_room(a: int, b: int) -> str:
    lo, hi = _pair(a, b)
    return f"{DM_PREFIX}{lo}:{hi}"


def session_room(code: str) -> str:
    return f"{SESS_PREFIX}{code}"


def parse_room(room_key: str) -> tuple[str, tuple] | None:
    """룸 키 해석 — ("dm", (낮은id, 높은id)) | ("sess", (code,)) | None(형식 오류).

    ⚠ 룸 키의 **형식을 아는 유일한 곳**이다. 예전에는 collab_service 3곳 + collab_ws 2곳이
      각자 `split(":")` 로 뜯었고 정작 위 생성자는 호출자가 0이었다. 그 상태로 두면
      "dm 은 항상 3토막" 같은 가정이 한 곳만 바뀌어도 조용히 갈린다(이 저장소에서 실제로
      뷰어 3종의 규칙이 그렇게 갈렸다). 만들 때도 뜯을 때도 반드시 이 파일의 함수를 쓴다.
    """
    if not isinstance(room_key, str):
        return None
    if room_key.startswith(DM_PREFIX):
        parts = room_key[len(DM_PREFIX):].split(":")
        if len(parts) != 2:
            return None
        try:
            return "dm", (int(parts[0]), int(parts[1]))
        except (ValueError, TypeError):
            return None
    if room_key.startswith(SESS_PREFIX):
        code = room_key[len(SESS_PREFIX):]
        return ("sess", (code,)) if code else None
    return None


def dm_peer(room_key: str, me_id: int) -> int | None:
    """DM 룸에서 '상대' id — 내가 당사자가 아니면 None."""
    parsed = parse_room(room_key)
    if parsed is None or parsed[0] != "dm":
        return None
    lo, hi = parsed[1]
    if me_id == lo:
        return hi
    if me_id == hi:
        return lo
    return None


def can_use_room(db: Session, me: Account, room_key: str) -> bool:
    """룸 접근 가드 — DM 은 당사자만, 세션 룸은 그 세션 참가자만."""
    parsed = parse_room(room_key)
    if parsed is None:
        return False
    kind, payload = parsed
    if kind == "dm":
        return me.id in payload
    sess = get_session(db, payload[0])
    if sess is None:
        return False
    p = participant_of(db, sess.id, me.id)
    return bool(p and p.state in ("invited", "joined"))


def post_message(db: Session, sender: Account, room_key: str, body: str,
                 kind: str = "text") -> CollabMessage:
    msg = CollabMessage(room_key=room_key[:96], sender_id=sender.id,
                        kind=kind if kind in ("text", "system", "invite") else "text",
                        body=(body or "")[:4000], created_at=_now())
    db.add(msg)
    db.commit()
    return msg


def message_brief(db: Session, msg: CollabMessage, sender: Account | None = None) -> dict:
    acc = sender or db.get(Account, msg.sender_id)
    return {
        "id": msg.id, "room": msg.room_key, "kind": msg.kind, "body": msg.body,
        "sender_id": msg.sender_id, "sender": display_of(acc),
        "at": _aware(msg.created_at).isoformat() if msg.created_at else "",
        "read": msg.read_at is not None,
    }


def list_messages(db: Session, room_key: str, before_id: int = 0,
                  limit: int = MESSAGE_PAGE) -> list[dict]:
    stmt = select(CollabMessage).where(CollabMessage.room_key == room_key)
    if before_id:
        stmt = stmt.where(CollabMessage.id < before_id)
    rows = list(db.execute(stmt.order_by(CollabMessage.id.desc()).limit(limit)).scalars().all())
    rows.reverse()   # 화면은 오래된 것부터
    accs = {a.id: a for a in db.execute(
        select(Account).where(Account.id.in_({r.sender_id for r in rows} or {0}))).scalars().all()}
    return [message_brief(db, r, accs.get(r.sender_id)) for r in rows]


def mark_read(db: Session, me: Account, room_key: str) -> int:
    """DM 읽음 처리 — 내가 보낸 것은 대상이 아니다."""
    rows = db.execute(
        select(CollabMessage).where(CollabMessage.room_key == room_key,
                                    CollabMessage.sender_id != me.id,
                                    CollabMessage.read_at.is_(None))
    ).scalars().all()
    for r in rows:
        r.read_at = _now()
    if rows:
        db.commit()
    return len(rows)


def unread_counts(db: Session, me: Account) -> dict[str, int]:
    """DM 룸별 안읽음 수 — 친구 목록 배지용. 세션 룸은 세지 않는다(설계 주석 참조)."""
    rows = db.execute(
        select(CollabMessage.room_key, func.count(CollabMessage.id))
        .where(CollabMessage.room_key.like(f"{DM_PREFIX}%"),
               CollabMessage.sender_id != me.id,
               CollabMessage.read_at.is_(None))
        .group_by(CollabMessage.room_key)
    ).all()
    # dm_peer 가 '내가 당사자인가' 까지 판정한다 — 여기서 다시 뜯지 않는다(parse_room 주석)
    return {room: int(n) for room, n in rows if dm_peer(room, me.id) is not None}


# ── 세션 ────────────────────────────────────────────────────────────────────
def get_session(db: Session, code: str) -> CollabSession | None:
    if not code:
        return None
    return db.execute(select(CollabSession).where(CollabSession.code == code)).scalar_one_or_none()


def participant_of(db: Session, session_id: int, account_id: int) -> CollabParticipant | None:
    return db.execute(
        select(CollabParticipant).where(CollabParticipant.session_id == session_id,
                                        CollabParticipant.account_id == account_id)
    ).scalar_one_or_none()


def participants(db: Session, session_id: int) -> list[CollabParticipant]:
    return list(db.execute(
        select(CollabParticipant).where(CollabParticipant.session_id == session_id)
        .order_by(CollabParticipant.id)
    ).scalars().all())


def session_brief(db: Session, sess: CollabSession, online: set[int] | None = None) -> dict:
    rows = participants(db, sess.id)
    accs = {a.id: a for a in db.execute(
        select(Account).where(Account.id.in_({p.account_id for p in rows} or {0}))).scalars().all()}
    hosp = _hospital_names(db, [a.hospital_id for a in accs.values()])
    items = []
    for p in rows:
        acc = accs.get(p.account_id)
        if acc is None:
            continue
        b = user_brief(db, acc, hosp)
        # seat = host|guest (협진 좌석). role 은 계정 등급(radiologist 등)이라 덮으면 안 된다 —
        # 화면이 참가자 옆에 "영상의학과 의사" 를 띄우는 근거가 그 값이다.
        b.update(seat=p.role, state=p.state, control=p.control, caps=list(p.caps or []),
                 online=(p.account_id in online) if online is not None else None)
        items.append(b)
    return {
        "code": sess.code, "status": sess.status, "title": sess.title,
        "host_id": sess.host_id, "study_id": sess.study_id, "study_uid": sess.study_uid,
        "created_at": _aware(sess.created_at).isoformat() if sess.created_at else "",
        "participants": items,
        "max_participants": MAX_PARTICIPANTS,
    }


def open_session(db: Session, host: Account, study_id: int, title: str = "") -> CollabSession:
    """협진 세션 개설 — 호스트(Master)가 자기 검사 1건을 걸고 연다.

    호스트는 그 검사를 볼 수 있어야 한다(자기 병원 검사거나 시스템 관리자).
    이 검사는 곧 게스트에게 열람권이 나갈 대상이므로 여기서 반드시 확인한다.
    """
    study = db.get(Study, int(study_id))
    if study is None:
        raise LookupError("검사를 찾을 수 없습니다")
    is_sys_admin = host.role == "admin" and not host.hospital_id
    if not is_sys_admin and host.hospital_id and study.hospital_id != host.hospital_id:
        raise PermissionError("다른 병원의 검사로는 협진을 열 수 없습니다")
    # 같은 검사로 이미 열어 둔 세션이 있으면 재사용 — 버튼 두 번 눌러 세션이 둘 생기는 것 방지
    existing = db.execute(
        select(CollabSession).where(CollabSession.host_id == host.id,
                                    CollabSession.study_id == int(study_id),
                                    CollabSession.status == "open")
    ).scalars().first()
    if existing is not None:
        return existing
    sess = CollabSession(
        code=uuid.uuid4().hex, host_id=host.id, host_hospital_id=host.hospital_id,
        study_id=int(study_id), study_uid=study.study_uid or "",
        title=(title or "")[:256], status="open", created_at=_now(),
    )
    db.add(sess)
    db.flush()
    # Master 는 처음부터 제어권 보유 + 전 capability (자기 화면이므로 당연하다)
    db.add(CollabParticipant(session_id=sess.id, account_id=host.id, role="host",
                             state="joined", control="granted", joined_at=_now(),
                             caps=sorted(COLLAB_CAPS)))
    _audit(db, host.id, "collab_session_open", "collab_session", sess.code,
           {"study_id": study_id, "study_uid": sess.study_uid})
    db.commit()
    return sess


def default_caps_for(db: Session, host: Account) -> list[str]:
    """초대 시 자동 부여할 cap — Master 의 설정(viewer.prefs.collab.default_caps)을 따른다.

    설정이 없으면 COLLAB_DEFAULT_CAPS(주석·글쓰기). 매번 손으로 승인하게 하면 다학제가
    시작부터 막히므로 기본을 열어 두고, 세부 조정은 협진 페이지에서 사람별로 한다.
    화이트리스트를 한 번 더 통과시키므로 설정에 이상한 값이 들어 있어도 새지 않는다.
    """
    try:
        from app.services.settings_service import get_setting

        prefs = get_setting(db, "viewer.prefs", user=host.username, default={}) or {}
        raw = (prefs.get("collab") or {}).get("default_caps")
    except Exception:  # noqa: BLE001 — 설정 조회 실패는 기본값으로 우아 강등
        raw = None
    return sanitize_collab_caps(raw) if raw is not None else list(COLLAB_DEFAULT_CAPS)


def invite(db: Session, sess: CollabSession, host: Account, target_id: int) -> CollabParticipant:
    if sess.status != "open":
        raise LookupError("종료된 세션입니다")
    if sess.host_id != host.id:
        raise PermissionError("초대는 개설자(Master)만 할 수 있습니다")
    link = find_link(db, host.id, target_id)
    if link is not None and link.status == "blocked":
        raise PermissionError("차단된 상대입니다")
    if not are_friends(db, host.id, target_id):
        raise PermissionError("친구로 등록된 사용자만 초대할 수 있습니다")
    alive = [p for p in participants(db, sess.id) if p.state in ("invited", "joined")]
    p = participant_of(db, sess.id, target_id)
    if p is not None and p.state in ("invited", "joined"):
        return p
    if len(alive) >= MAX_PARTICIPANTS:
        raise PermissionError(f"세션 정원({MAX_PARTICIPANTS}명)을 초과했습니다")
    caps = default_caps_for(db, host)
    if p is None:
        p = CollabParticipant(session_id=sess.id, account_id=target_id, role="guest",
                              state="invited", invited_by=host.id, caps=caps)
        db.add(p)
    else:
        p.state = "invited"
        p.invited_by = host.id
        p.left_at = None
        if not p.caps:                 # 재초대 — 비어 있을 때만 기본값(수동 조정분 보존)
            p.caps = caps
    _audit(db, host.id, "collab_invite", "collab_session", sess.code, {"target_id": target_id})
    db.commit()
    return p


def join(db: Session, sess: CollabSession, me: Account) -> CollabParticipant:
    """초대 수락 → 참가. 참가 순간 현재 공유 검사에 대한 임시 열람권이 발급된다."""
    if sess.status != "open":
        raise LookupError("종료된 세션입니다")
    p = participant_of(db, sess.id, me.id)
    if p is None or p.state == "denied":
        raise PermissionError("초대받지 않은 세션입니다")
    alive = [x for x in participants(db, sess.id)
             if x.state == "joined" and x.account_id != me.id]
    if len(alive) + 1 > MAX_PARTICIPANTS:
        raise PermissionError(f"세션 정원({MAX_PARTICIPANTS}명)을 초과했습니다")
    p.state = "joined"
    p.joined_at = _now()
    p.left_at = None
    ensure_grant(db, sess, me.id, sess.study_id, commit=False)
    _audit(db, me.id, "collab_join", "collab_session", sess.code, {"study_id": sess.study_id})
    db.commit()
    return p


def decline(db: Session, sess: CollabSession, me: Account) -> None:
    p = participant_of(db, sess.id, me.id)
    if p is None:
        return
    p.state = "denied"
    db.commit()


def leave(db: Session, sess: CollabSession, me: Account) -> None:
    """세션 이탈 — 그 사용자의 열람권은 즉시 회수한다(남아 있을 이유가 없다)."""
    p = participant_of(db, sess.id, me.id)
    if p is None:
        return
    p.state = "left"
    p.left_at = _now()
    p.control = "none"
    p.control_expires_at = None
    p.caps = []
    revoke_grants(db, sess.id, account_id=me.id, commit=False)
    _audit(db, me.id, "collab_leave", "collab_session", sess.code, {})
    db.commit()


def close_session(db: Session, sess: CollabSession, by: Account | None = None) -> None:
    """세션 종료 — 전 참가자의 임시 열람권을 즉시 무효화한다.

    이게 "세션 한정" 이라는 약속이 실제로 지켜지는 지점이다.
    """
    if sess.status == "closed":
        return
    sess.status = "closed"
    sess.closed_at = _now()
    for p in participants(db, sess.id):
        if p.state == "joined":
            p.state = "left"
            p.left_at = _now()
        p.control = "none"
        p.control_expires_at = None
        p.caps = []
    n = revoke_grants(db, sess.id, commit=False)
    _audit(db, by.id if by else sess.host_id, "collab_session_close", "collab_session",
           sess.code, {"grants_revoked": n})
    db.commit()


def set_share_study(db: Session, sess: CollabSession, host: Account, study_id: int) -> list[int]:
    """Master 가 공유 검사를 바꿨다 → 참가자 전원에게 그 검사 열람권 발급.

    ⚠ 이 함수는 **다른 환자의 영상이 게스트에게 열리는 순간**이다. 그래서
      (a) 호스트 본인 확인 (b) 호스트가 그 검사를 볼 수 있는지 확인 (c) 감사로그를 모두 남긴다.
      과거 검사의 열람권은 회수하지 않는다 — 협진 중 이전 검사로 되돌아가 비교하는 것이
      정상 동작이고, 어차피 세션 종료 시 전부 무효화된다.
    반환: 새로 열람권이 나간 account_id 목록(프론트 고지용).
    """
    if sess.status != "open":
        raise LookupError("종료된 세션입니다")
    if sess.host_id != host.id:
        raise PermissionError("공유 검사 변경은 개설자(Master)만 할 수 있습니다")
    study = db.get(Study, int(study_id))
    if study is None:
        raise LookupError("검사를 찾을 수 없습니다")
    is_sys_admin = host.role == "admin" and not host.hospital_id
    if not is_sys_admin and host.hospital_id and study.hospital_id != host.hospital_id:
        raise PermissionError("다른 병원의 검사는 공유할 수 없습니다")
    sess.study_id = int(study_id)
    sess.study_uid = study.study_uid or ""
    granted: list[int] = []
    for p in participants(db, sess.id):
        if p.state != "joined" or p.account_id == host.id:
            continue
        if ensure_grant(db, sess, p.account_id, int(study_id), commit=False):
            granted.append(p.account_id)
    _audit(db, host.id, "collab_share_study", "collab_session", sess.code,
           {"study_id": study_id, "granted_to": granted})
    db.commit()
    return granted


def open_sessions_for(db: Session, account_id: int) -> list[CollabSession]:
    """내가 참가 중이거나 초대받은 열린 세션 — 재접속 시 복구용."""
    return list(db.execute(
        select(CollabSession)
        .join(CollabParticipant, CollabParticipant.session_id == CollabSession.id)
        .where(CollabSession.status == "open",
               CollabParticipant.account_id == account_id,
               CollabParticipant.state.in_(("invited", "joined")))
        .order_by(CollabSession.id.desc())
    ).scalars().all())


# ── 제어권(talking stick) ────────────────────────────────────────────────────
def controller_of(db: Session, session_id: int) -> CollabParticipant | None:
    """지금 제어권을 쥔 참가자 — 만료된 위임은 제어자로 치지 않는다."""
    for p in participants(db, session_id):
        if p.control != "granted":
            continue
        exp = _aware(p.control_expires_at)
        if exp is not None and _now() >= exp:
            continue
        return p
    return None


def request_control(db: Session, sess: CollabSession, me: Account, caps) -> CollabParticipant:
    p = participant_of(db, sess.id, me.id)
    if p is None or p.state != "joined":
        raise PermissionError("세션 참가자가 아닙니다")
    if p.role == "host":
        raise PermissionError("Master 는 제어권을 요청할 필요가 없습니다")
    wanted = sanitize_collab_caps(caps) or ["collab.viewport"]
    p.control = "requested"
    p.caps = wanted            # 요청 단계에서는 '희망 목록'이고, 승인 때 Master 가 확정한다
    db.commit()
    return p


def grant_control(db: Session, sess: CollabSession, host: Account, target_id: int,
                  caps=None, minutes: int = CONTROL_TTL_MIN) -> CollabParticipant:
    """Master 승인 — 발표자(뷰포트 송출자)를 넘기고, 그 사람의 cap 을 확정한다.

    ⚠ **다른 참가자의 caps 는 건드리지 않는다.** 예전엔 여기서 전원의 caps 를 비웠는데,
      그러면 '한 명만 작업 가능'(talking stick)이 되어 다학제가 성립하지 않는다.
      뷰포트만 배타(발표자 1명)이고 주석·글쓰기는 동시 보유가 정상이다
      (permissions.COLLAB_CONCURRENT_CAPS 주석 참조).

    caps 는 sanitize_collab_caps 를 통과한 collab.* 만 남는다. 즉 판독 수정·영상 삭제 같은
    권한은 **여기로 들어올 수 없다** — 애초에 화이트리스트에 없기 때문이다.
    """
    if sess.host_id != host.id:
        raise PermissionError("제어권 승인은 Master 만 할 수 있습니다")
    target = participant_of(db, sess.id, target_id)
    if target is None or target.state != "joined":
        raise LookupError("참가자를 찾을 수 없습니다")
    allowed = sanitize_collab_caps(caps if caps is not None else target.caps) or ["collab.viewport"]
    for p in participants(db, sess.id):        # 발표자는 세션당 1명 — 그 축만 비운다
        p.control = "none"
        p.control_expires_at = None
    target.control = "granted"
    target.caps = allowed
    target.control_expires_at = _now() + timedelta(minutes=max(1, int(minutes)))
    _audit(db, host.id, "collab_control_grant", "collab_session", sess.code,
           {"target_id": target_id, "caps": allowed, "minutes": minutes})
    db.commit()
    return target


def set_caps(db: Session, sess: CollabSession, host: Account, target_id: int, caps
             ) -> CollabParticipant:
    """Master 가 참가자 **한 사람의** cap 을 조정한다(발표자는 그대로).

    다학제의 실제 조작면이다 — 협진 페이지에서 사람마다 체크박스를 켜고 끄는 것이 여기로 온다.
    여러 사람이 같은 cap 을 동시에 갖는 것이 정상이므로 남의 것은 절대 건드리지 않는다.
    """
    if sess.host_id != host.id:
        raise PermissionError("권한 조정은 Master 만 할 수 있습니다")
    target = participant_of(db, sess.id, target_id)
    if target is None or target.state != "joined":
        raise LookupError("참가자를 찾을 수 없습니다")
    allowed = sanitize_collab_caps(caps)
    target.caps = allowed
    if target.control == "requested":
        target.control = "none"       # 요청은 이 조정으로 처리된 것으로 본다
    _audit(db, host.id, "collab_caps_set", "collab_session", sess.code,
           {"target_id": target_id, "caps": allowed})
    db.commit()
    return target


def revoke_control(db: Session, sess: CollabSession, by: Account) -> CollabParticipant | None:
    """발표자를 Master 에게 되돌린다. Master 본인 또는 현재 발표자가 부를 수 있다.

    ⚠ caps 는 건드리지 않는다 — 발표를 넘겨받은 것과 '주석을 그릴 수 있는가'는 다른 축이다.
      cap 을 빼려면 set_caps 를 쓴다(협진 페이지의 체크박스).
    """
    cur = controller_of(db, sess.id)
    if cur is not None and by.id not in (sess.host_id, cur.account_id):
        raise PermissionError("제어권을 회수할 권한이 없습니다")
    for p in participants(db, sess.id):
        p.control = "none"
        p.control_expires_at = None
    host_p = participant_of(db, sess.id, sess.host_id)
    if host_p is not None:
        host_p.control = "granted"
    _audit(db, by.id, "collab_control_revoke", "collab_session", sess.code,
           {"from_id": cur.account_id if cur else None})
    db.commit()
    return host_p


def can_control(db: Session, sess: CollabSession, account_id: int, cap: str) -> bool:
    """이 사용자가 지금 그 조작을 할 수 있나 — WS state/anno 릴레이의 게이트.

    축이 둘이다:
      · collab.viewport = **발표자 1명**만. 전원이 뷰포트를 쏘면 마지막 사람으로 화면이
        끌려가 아무도 못 쓴다(10Hz 왕복). 나머지는 각자 자유 보기라 막히는 게 아니다.
      · 그 밖(annotate·text·navigate) = cap 보유자 **누구나 동시**. 이게 다학제다.
    Master 는 자기 세션이므로 전부 가능하다.
    """
    p = participant_of(db, sess.id, account_id)
    if p is None or p.state != "joined":
        return False
    if cap in ("collab.viewport", "collab.present"):
        # ⚠ Master 도 예외가 아니다. 발표를 남에게 넘긴 동안에는 Master 의 뷰포트도 나가면
        #   안 된다 — 그러면 둘이 서로에게 화면을 쏘아 10Hz 로 오간다(발표자를 둔 이유가 사라진다).
        #   되찾으려면 revoke_control(회수)로 명시적으로 가져온다.
        cur = controller_of(db, sess.id)
        return cur is not None and cur.account_id == account_id
    # 나머지(annotate·text·navigate)는 동시 보유가 정상. Master 는 자기 세션이라 항상 가능.
    if p.role == "host":
        return True
    return cap in sanitize_collab_caps(p.caps)


def adopt_annotations(db: Session, sess: CollabSession, host: Account, rows: list,
                      author_name: str = "") -> int:
    """세션 주석 → 정식 Annotation. **Master 만** 부른다(호출부가 확인).

    책임 주체를 흐리지 않는 것이 요점이다: 저장은 Master 이름(created_by)으로 하되
    text 앞에 원 작성자를 남긴다. 협진에서 나온 소견이라는 사실이 판독 기록에 보여야 한다.
    """
    from app.models import Annotation

    n = 0
    for r in rows:
        pts = r.get("points") or []
        if not isinstance(pts, list) or not pts:
            continue
        note = str(r.get("text") or "")
        if author_name:
            note = f"[{author_name}] {note}".strip()
        db.add(Annotation(
            study_id=sess.study_id,
            series_uid=str(r.get("series_uid") or ""),
            sop_uid=str(r.get("sop_uid") or ""),
            kind=str(r.get("kind") or "line"),
            points=pts,
            value=r.get("value"),
            unit=str(r.get("unit") or ""),
            text=note[:512],
            source="user",
            created_by=host.username,
        ))
        n += 1
    if n:
        _audit(db, host.id, "collab_adopt_annos", "collab_session", sess.code,
               {"count": n, "author": author_name, "study_id": sess.study_id})
        db.commit()
    return n


# ── 임시 열람권 ──────────────────────────────────────────────────────────────
def ensure_grant(db: Session, sess: CollabSession, account_id: int, study_id: int,
                 commit: bool = True) -> bool:
    """(세션, 사용자, 검사) 열람권 보장 → 새로 만들었으면 True.

    같은 병원 사용자에게도 행을 만든다: 나중에 병원 정책이 바뀌어도 '누가 언제 무엇을
    협진으로 봤는가'가 한 곳에 남아야 감사가 성립한다(권한 판정에는 어차피 영향 없다).
    """
    if not study_id:
        return False
    row = db.execute(
        select(CollabGrant).where(CollabGrant.session_id == sess.id,
                                  CollabGrant.account_id == account_id,
                                  CollabGrant.study_id == int(study_id))
    ).scalar_one_or_none()
    now = _now()
    if row is not None:
        if row.revoked_at is None:
            return False
        row.revoked_at = None                       # 재참가 — 되살린다
        row.expires_at = now + timedelta(hours=GRANT_MAX_HOURS)
        if commit:
            db.commit()
        return True
    db.add(CollabGrant(session_id=sess.id, account_id=account_id, study_id=int(study_id),
                       granted_by=sess.host_id, created_at=now,
                       expires_at=now + timedelta(hours=GRANT_MAX_HOURS)))
    if commit:
        db.commit()
    return True


def revoke_grants(db: Session, session_id: int, account_id: int | None = None,
                  commit: bool = True) -> int:
    stmt = select(CollabGrant).where(CollabGrant.session_id == session_id,
                                     CollabGrant.revoked_at.is_(None))
    if account_id is not None:
        stmt = stmt.where(CollabGrant.account_id == account_id)
    rows = db.execute(stmt).scalars().all()
    now = _now()
    for r in rows:
        r.revoked_at = now
    if rows and commit:
        db.commit()
    return len(rows)


def has_active_grant(db: Session, account_id: int, study_id: int) -> bool:
    """조회 게이트(worklist._require_study)가 부르는 유일한 판정 함수.

    유효 조건 4가지를 모두 만족해야 한다:
      회수되지 않음 · 만료 전 · 세션이 아직 open · 그 세션에 아직 참가 중.
    마지막 조건이 중요하다 — 세션에서 나간 사람의 행이 남아 있어도 통과하면 안 된다.
    """
    if not account_id or not study_id:
        return False
    now = _now()
    row = db.execute(
        select(CollabGrant.id)
        .join(CollabSession, CollabSession.id == CollabGrant.session_id)
        .join(CollabParticipant,
              and_(CollabParticipant.session_id == CollabSession.id,
                   CollabParticipant.account_id == CollabGrant.account_id))
        .where(CollabGrant.account_id == int(account_id),
               CollabGrant.study_id == int(study_id),
               CollabGrant.revoked_at.is_(None),
               or_(CollabGrant.expires_at.is_(None), CollabGrant.expires_at > now),
               CollabSession.status == "open",
               CollabParticipant.state == "joined")
        .limit(1)
    ).first()
    return row is not None


# ── 감사 ────────────────────────────────────────────────────────────────────
def _audit(db: Session, account_id: int | None, action: str, target_type: str,
           target_id: str, detail: dict) -> None:
    db.add(AuditLog(account_id=account_id, action=action, target_type=target_type,
                    target_id=str(target_id)[:64], detail=detail or {}))
