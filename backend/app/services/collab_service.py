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
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.exc import IntegrityError
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
# Live 브리지가 켜진 배치(sv70)에서 사용자의 원천은 **원격 PACS(A)** 다. 로컬 accounts 는
# 'A 로그인을 한 번이라도 한 사람'의 미러 부분집합이라, 로컬만 보여 주면 아직 우리 뷰어에
# 들어온 적 없는 동료가 검색되지 않는다(실증상: sv70 등록자가 찾기에 안 뜸). 그래서 디렉터리는
# A 의 사용자 목록을 병합한다.
#
# ⚠ 매 검색마다 A 를 때리지 않는다 — 30초 TTL + 단일비행(webpacs live_state 와 같은 패턴,
#   §C 동시성 예산 보호). A 순단 시에는 **마지막 성공 목록(stale)** 으로 계속 검색된다 —
#   협진 검색이 A 가용성의 볼모가 되면 안 된다.
_A_USERS_TTL = 30.0
_a_users_cache: dict = {"at": 0.0, "rows": []}
_a_users_lock = threading.Lock()


def _fetch_a_users(db: Session) -> list[dict] | None:
    """A 사용자 목록 1회 조회 — 브리지 미사용/실패는 None(호출부가 stale 캐시로 강등).

    비밀번호는 구조적으로 넘어올 수 없다(account_mirror 모듈 주석 — A 가 목록 응답에서
    user_passwd 를 제거해 준다). 여기서 받는 것은 아이디·이름·구분·등급뿐이다.
    """
    try:
        from app.services.webpacs_bridge import get_bridge_config
        from app.services.webpacs_live import service_client

        cfg = get_bridge_config(db)
        if not cfg.get("enabled") or not cfg.get("base_url"):
            return None
        return service_client(db).list_users()
    except Exception:  # noqa: BLE001 — A 순단이 협진 검색을 죽이면 안 된다
        logger.debug("A 사용자 목록 조회 실패 — stale 캐시로 계속", exc_info=True)
        return None


def _a_users(db: Session) -> list[dict]:
    """캐시된 A 사용자 목록. 실패 시 마지막 성공분(없으면 빈 목록)."""
    now = time.monotonic()
    with _a_users_lock:
        if now - _a_users_cache["at"] < _A_USERS_TTL:
            return list(_a_users_cache["rows"])
        rows = _fetch_a_users(db)
        if rows is None:
            # 실패/브리지 꺼짐 — 5초 뒤에나 재시도(스탬피드 방지), 그동안 stale 로 응답
            _a_users_cache["at"] = now - _A_USERS_TTL + 5.0
            return list(_a_users_cache["rows"])
        _a_users_cache["rows"] = rows
        _a_users_cache["at"] = now
        return list(rows)
def directory(db: Session, me: Account, q: str = "", only_other_hospital: bool = False,
              limit: int = DIRECTORY_LIMIT, _retried: bool = False) -> list[dict]:
    """친구 요청 대상 검색 — 로컬 계정 + **원격 PACS(A) 등록 사용자**(브리지 사용 시).

    노출 범위는 이름·아이디·직책·역할·병원명뿐이다(연락처·생년 등 개인정보는 싣지 않는다).
    제외 대상은 둘뿐이다: **비활성 계정**과 **우리 시스템 관리자 서비스 계정**.

    ⚠ 예전에 `hospital_id IS NOT NULL` 로 걸렀는데 그것이 사고였다 —
      원격 PACS(A) 로그인으로 만들어지는 **미러 계정**은 hospital_id 가 없다
      (auth.webpacs-login → ensure_mirror 가 병원을 넘기지 않는다. A 신원에는 병원 개념이 없다).
      그래서 Live 모드 서버에서는 A 계정 사용자끼리 **서로를 절대 검색할 수 없었다**.
      시스템 관리자 판정은 a_user_idx 없음까지 봐야 한다 — A 의 관리자급(group_level≥98)
      미러는 role='admin'+병원 없음이지만 **실사용자**다.

    ⚠ `enabled IS TRUE` 가 아니라 `IS NOT FALSE` 다 — 레거시 행(_sync_columns 의 ALTER 로
      추가된 컬럼)은 NULL 이고, auth_service.authenticate 는 그것을 **활성으로 본다**.
      두 곳의 규칙이 갈리면 '로그인은 되는데 친구 검색에는 영원히 안 보이는' 계정이 생긴다.

    only_other_hospital 은 로컬 계정에만 의미가 있다(미러는 병원 개념이 없다).
    """
    stmt = select(Account).where(
        Account.id != me.id,
        Account.enabled.isnot(False),
        ~and_(Account.role == "admin", Account.hospital_id.is_(None),
              or_(Account.a_user_idx.is_(None), Account.a_user_idx == 0)),
    )
    term = (q or "").strip()
    if term:
        like = f"%{term}%"
        stmt = stmt.where(or_(Account.username.ilike(like),
                              Account.display_name.ilike(like),
                              Account.title.ilike(like)))
    if only_other_hospital and me.hospital_id:
        stmt = stmt.where(Account.hospital_id != me.hospital_id)
    rows = list(db.execute(
        stmt.order_by(Account.display_name, Account.username).limit(limit)).scalars().all())

    # ── A(sv70) 등록 사용자 병합 — 위 캐시 주석 참조 ──────────────────────────
    # 목록에 올리는 사람은 **미러 행을 보장**한다(ensure_mirror, 멱등). 행이 있어야
    # 친구 요청(target_id=Account.id)이 성립한다. 차단(user_status='D')은 올리지 않는다.
    a_added = False
    try:
        from app.services.account_mirror import ensure_mirror, is_active, map_role

        have = {a.username for a in rows} | {me.username}
        term_l = term.lower()
        for r in _a_users(db):
            if len(rows) >= limit:
                break
            uid = str(r.get("user_id") or "").strip()
            if not uid or uid in have or not is_active(r):
                continue
            name = str(r.get("user_name") or "").strip()
            if term_l and term_l not in uid.lower() and term_l not in name.lower():
                continue
            try:
                a_idx = int(r.get("user_idx"))
            except (TypeError, ValueError):
                a_idx = 0
            acc = ensure_mirror(db, user_id=uid, name=name,
                                role=map_role(r.get("user_type"), r.get("group_level")),
                                a_user_idx=a_idx)
            if acc.enabled is False:      # 동명 로컬 계정이 비활성 — 목록에 올리지 않는다
                continue
            have.add(uid)
            rows.append(acc)
            a_added = True
        if a_added:
            # 커밋해야 한다 — 안 하면 세션 종료 시 롤백되어, 방금 응답한 id 로 보낸
            # 친구 요청이 "사용자를 찾을 수 없습니다" 가 된다.
            db.commit()
    except IntegrityError:
        # 두 창이 동시에 같은 미러를 만들었다 — 남이 이겼다. 커밋된 행으로 다시 읽는다.
        db.rollback()
        if not _retried:
            return directory(db, me, q=q, only_other_hospital=only_other_hospital,
                             limit=limit, _retried=True)
    except Exception:  # noqa: BLE001 — A 병합 실패가 로컬 검색까지 죽이면 안 된다
        db.rollback()
        logger.debug("A 사용자 병합 실패 — 로컬 결과만 반환", exc_info=True)
        # 롤백으로 미커밋 미러는 transient(id=None)로 되돌아간다 — 응답에서 뺀다
        rows = [a for a in rows if a.id is not None]

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


def dm_allowed(db: Session, a_id: int, b_id: int) -> bool:
    """1:1 대화·통화 허용 — **차단만 아니면 허용**(2026-08-10 사용자 확정).

    '초대' 기능의 근거: 친구가 되지 않았어도 등록 사용자를 대화·통화로 초대할 수 있어야
    한다. 친구 관계는 목록·프레즌스 편의일 뿐 **자격이 아니다**. 차단(blocked)만 거부한다.
    (DM 채팅은 원래부터 can_use_room 이 당사자 검사만 했다 — 통화 시그널도 같은 정책으로.)"""
    link = find_link(db, a_id, b_id)
    return not (link is not None and link.status == "blocked")


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


def unfriend(db: Session, me: Account, other_id: int, purge: bool = True) -> int:
    """친구 해제 — 관계 행을 지우고, 기본적으로 **둘 사이의 대화를 전부 삭제**한다.

    2026-08-10 사용자 확정: "친구 삭제하면 과거 대화는 모두 지워지게 해줘."

    ⚠ DM 룸은 두 사람이 **공유**한다(room_key = dm:<낮은id>:<높은id>). 즉 삭제는
      한쪽만의 일이 아니라 **양쪽에서** 사라진다. 한쪽 사본만 남기려면 사용자별 팬아웃
      테이블이 필요한데, 그건 이 메신저의 설계(룸 하나에 행 하나)를 뒤집는 일이다.
      그래서 UI 가 "상대에게서도 지워집니다" 를 반드시 알린 뒤 부른다.

    ⚠ 관계 행만 지우고 계정은 건드리지 않는다 — 그래서 **검색 목록에는 계속 보인다**
      (directory 는 친구 여부로 거르지 않는다). 나중에 다시 친구로 추가할 수 있다는
      요구가 여기서 성립한다. tests/test_collab.py 가 이 성질을 고정한다.

    반환: 지운 메시지 수.
    """
    link = find_link(db, me.id, other_id)
    if link is None and not purge:
        return 0
    if link is not None:
        if link.status == "blocked" and link.blocked_by != me.id:
            raise PermissionError("차단된 관계입니다")
        db.delete(link)
    n = 0
    if purge:
        # 요청 취소(outgoing)로도 이 경로가 오지만, 그때는 애초에 대화가 없어 0 건이다.
        n = db.execute(
            delete(CollabMessage).where(CollabMessage.room_key == dm_room(me.id, other_id)),
        ).rowcount or 0
    db.commit()
    if n:
        _audit(db, me.id, "collab_dm_purge", "collab_friend", str(other_id), {"messages": n})
        db.commit()
    return n


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


def _study_uid_for_host(db: Session, host: Account, study_id: int,
                        user: dict | None = None,
                        deny_msg: str = "다른 병원의 검사로는 협진을 열 수 없습니다") -> str:
    """호스트가 이 검사를 협진에 걸 수 있는지 확인하고 study_uid 를 돌려준다.

    🔴 Live(vid) 검사는 로컬 Study 테이블에 **없다**. sv70 처럼 A 브리지를 쓰는 배치에서
      뷰어의 검사 id 는 vid(=VID_BASE+A study_idx)라, 로컬만 보면 협진 개설이 전부
      '검사를 찾을 수 없습니다'로 죽는다 — 세션이 안 만들어지니 **초대 자체가 안 나가서**
      상대방 화면에는 아무것도 안 뜬다(실사고 2026-08-12: 채팅·화상은 되는데 협진만 불통,
      연결 진단은 전부 초록 — 전송 계층이 아니라 자료 모델 문제였기 때문).

    Live 검사는 **호스트 본인의 A 자격**으로 존재를 확인한다(뷰어가 여는 경로 그대로 —
    live_client 가 user.sid 로 그 사용자의 A 세션을 찾고, 없으면 서비스 계정 폴백).
    A 가 자기 규칙으로 열람을 판정하므로 호스트가 못 보는 검사는 여기서도 안 열린다.
    """
    from app.services import webpacs_live as live

    sid = int(study_id)
    if live.is_live_id(sid):
        try:
            row = live.live_detail(db, sid, user=user, with_related=False)
        except Exception as e:  # noqa: BLE001 — A 오류는 종류와 무관하게 '확인 불가'로 수렴
            raise LookupError(f"원격 검사를 확인할 수 없습니다 — {e}")
        return str(row.get("study_uid") or "")
    study = db.get(Study, sid)
    if study is None:
        raise LookupError("검사를 찾을 수 없습니다")
    is_sys_admin = host.role == "admin" and not host.hospital_id
    if not is_sys_admin and host.hospital_id and study.hospital_id != host.hospital_id:
        raise PermissionError(deny_msg)
    return study.study_uid or ""


def open_session(db: Session, host: Account, study_id: int, title: str = "",
                 user: dict | None = None) -> CollabSession:
    """협진 세션 개설 — 호스트(Master)가 자기 검사 1건을 걸고 연다.

    호스트는 그 검사를 볼 수 있어야 한다(자기 병원 검사거나 시스템 관리자, Live 는 A 판정).
    이 검사는 곧 게스트에게 열람권이 나갈 대상이므로 여기서 반드시 확인한다.
    user: 호출자의 JWT dict — Live 검사 확인 시 그 사람의 A 세션(sid)을 쓰기 위해 받는다.
    """
    study_uid = _study_uid_for_host(db, host, study_id, user=user)
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
        study_id=int(study_id), study_uid=study_uid,
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


def set_share_study(db: Session, sess: CollabSession, host: Account, study_id: int,
                    user: dict | None = None) -> list[int]:
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
    # Live(vid) 검사 분기 포함 — open_session 과 같은 판정(_study_uid_for_host 주석 참조)
    study_uid = _study_uid_for_host(db, host, study_id, user=user,
                                    deny_msg="다른 병원의 검사는 공유할 수 없습니다")
    sess.study_id = int(study_id)
    sess.study_uid = study_uid
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
      · 그 밖(annotate·text·navigate·present) = cap 보유자 **누구나 동시**. 이게 다학제다.
    Master 는 자기 세션이므로 전부 가능하다.

    ⚠ collab.present 는 viewport 와 **같이 두면 안 된다**. present 는 '발표자가 될 수 있는
      자격'이고 viewport 는 '지금 발표자인가'다. 예전엔 둘을 한 분기에 묶어서
      can_control("collab.present") 가 "이미 발표자인가"를 되묻는 순환이 됐고, 그 결과
      발표자가 아닌 사람은 영원히 발표권을 가져올 수 없었다(Master 승인만이 유일한 길).
    """
    p = participant_of(db, sess.id, account_id)
    if p is None or p.state != "joined":
        return False
    if cap == "collab.viewport":
        # ⚠ Master 도 예외가 아니다. 발표를 남에게 넘긴 동안에는 Master 의 뷰포트도 나가면
        #   안 된다 — 그러면 둘이 서로에게 화면을 쏘아 10Hz 로 오간다(발표자를 둔 이유가 사라진다).
        #   되찾으려면 revoke_control(회수) 또는 take_control 로 명시적으로 가져온다.
        cur = controller_of(db, sess.id)
        return cur is not None and cur.account_id == account_id
    # 나머지(annotate·text·navigate·present)는 동시 보유가 정상. Master 는 자기 세션이라 항상 가능.
    if p.role == "host":
        return True
    return cap in sanitize_collab_caps(p.caps)


def take_control(db: Session, sess: CollabSession, actor: Account) -> CollabParticipant:
    """참가자가 **스스로** 발표권을 가져온다 — Master 승인을 기다리지 않는다.

    "판독 작성·영상 삭제만 빼고 전부"(사용자 확정) 에서 발표 전환도 예외가 아니다. 승인을
    거쳐야만 발표할 수 있으면 Master 가 자리를 비운 순간 다학제가 멈춘다.

    역할은 여전히 1명이므로 '요청'이 아니라 '가져오기'로 구현한다 — 마지막에 누른 사람이
    발표자가 되고 호출부가 전원에게 알린다. 회의에서 발언권이 넘어가는 방식 그대로다.
    Master 는 언제든 revoke_control 로 회수할 수 있다.

    ⚠ grant_control 과 달리 **caps 를 건드리지 않는다**. 발표권을 가져오는 것과 그 사람이
      무엇을 할 수 있는가는 별개 축이고, 여기서 caps 를 덮으면 Master 가 개별 조정해 둔
      설정이 발표 전환 한 번에 날아간다.
    """
    p = participant_of(db, sess.id, actor.id)
    if p is None or p.state != "joined":
        raise LookupError("참가자를 찾을 수 없습니다")
    if p.role != "host" and "collab.present" not in sanitize_collab_caps(p.caps):
        raise PermissionError("발표 권한이 없습니다")
    for other in participants(db, sess.id):        # 발표자는 세션당 1명 — 그 축만 비운다
        other.control = "none"
        other.control_expires_at = None
    p.control = "granted"
    p.control_expires_at = _now() + timedelta(minutes=CONTROL_TTL_MIN)
    _audit(db, actor.id, "collab_control_take", "collab_session", sess.code, {})
    db.commit()
    return p


def adopt_annotations(db: Session, sess: CollabSession, host: Account, rows: list,
                      author_name: str = "", user: dict | None = None) -> int:
    """세션 주석 → 정식 판독 주석. **Master 만** 부른다(호출부가 확인).

    책임 주체를 흐리지 않는 것이 요점이다: 저장은 Master 이름으로 하되
    text 앞에 원 작성자를 남긴다. 협진에서 나온 소견이라는 사실이 판독 기록에 보여야 한다.

    ⚠ **뷰포트(pane) 마크만 채택한다.** 화이트보드·공유 화면 마크는 좌표계가 완전히 다르다
      (화이트보드 정규화 / 비디오 프레임 정규화 vs 이미지 정규화). 그대로 저장하면 영상
      위 엉뚱한 자리에 도형이 박히고, sop_uid 도 없어서 어느 슬라이스 것인지조차 없다.
      '남길 가치가 있는 것'은 영상 위에 그린 것뿐이다 — 화이트보드는 논의용 스케치다.

    ⚠ 저장소가 검사 종류에 따라 **둘**이다:
      · 로컬 검사 → Annotation 테이블 (created_by=Master)
      · Live(vid) 검사 → **A 서버의 주석 저장소**(live_annotations_*). 로컬 Annotation 에
        넣으면 study_id FK(studies.id)가 vid 를 참조해 **저장 자체가 터진다** — 그리고
        설령 들어가도 뷰어는 Live 검사의 주석을 A 에서 읽으므로 아무에게도 안 보인다.
    """
    adoptable = []
    for r in rows:
        if str(r.get("surface") or "pane") != "pane":
            continue
        pts = r.get("points") or []
        if not isinstance(pts, list) or not pts:
            continue
        note = str(r.get("text") or "")
        if author_name:
            note = f"[{author_name}] {note}".strip()
        adoptable.append({
            "series_uid": str(r.get("series_uid") or ""),
            "sop_uid": str(r.get("sop_uid") or ""),
            "kind": str(r.get("kind") or "line"),
            "points": pts,
            "value": r.get("value"),
            "unit": str(r.get("unit") or ""),
            "text": note[:512],
            "source": "user",
        })
    if not adoptable:
        return 0

    from app.services import webpacs_live as live

    if live.is_live_id(sess.study_id):
        # A 저장소는 '검사당 주석 목록 JSON 한 벌'이다 — 읽어서 덧붙이고 되쓴다.
        # Master 의 A 자격(user.sid)으로 쓴다: A 쪽 기록도 Master 계정으로 귀속된다.
        try:
            cur = live.live_annotations_get(db, sess.study_id, user).get("items") or []
            live.live_annotations_put(db, sess.study_id, [*cur, *adoptable], user)
        except Exception as e:  # noqa: BLE001 — A 실패는 종류와 무관하게 사용자 문구로
            raise LookupError(f"원격 판독 주석 저장에 실패했습니다 — {e}")
    else:
        from app.models import Annotation

        for a in adoptable:
            db.add(Annotation(study_id=sess.study_id, created_by=host.username, **a))
    n = len(adoptable)
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


# ── 연결 진단 기록 (2026-08-11) ──────────────────────────────────────────────
#
# 별도 테이블을 만들지 않고 AuditLog 를 쓴다. 이유:
#   · 마이그레이션이 필요 없다 — 진단 기능 때문에 스키마를 늘리는 것은 과하다
#   · 관리자 화면의 감사 로그와 **같은 자리에서** 보인다(운영자가 두 곳을 안 봐도 된다)
#   · 보존·정리 정책이 이미 있다
# action 접두사 collab_diag 로 구분한다.
DIAG_ACTION = "collab_diag"


def record_diag(db: Session, me: Account, code: str, server_side: bool,
                title: str = "", detail: str = "") -> None:
    """클라이언트가 내린 차단 판정을 남긴다. 실패해도 조용히 넘긴다 —
    진단 기록이 안 됐다고 협진 자체가 막히면 본말이 전도된다."""
    try:
        _audit(db, me.id, DIAG_ACTION, "collab", code[:64], {
            "server_side": bool(server_side),
            "title": title[:200],
            "detail": detail[:500],
            "username": me.username,
        })
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.debug("협진 진단 기록 실패(무시)", exc_info=True)


def list_diag(db: Session, account_id: int | None, limit: int = 50) -> list[dict]:
    """최근 연결 문제. account_id=None 이면 전체(관리자 조회)."""
    from app.models import AuditLog

    stmt = select(AuditLog).where(AuditLog.action == DIAG_ACTION)
    if account_id is not None:
        stmt = stmt.where(AuditLog.account_id == account_id)
    rows = db.execute(stmt.order_by(AuditLog.id.desc()).limit(limit)).scalars().all()
    return [{
        "id": r.id,
        "at": r.created_at.isoformat() if r.created_at else None,
        "code": r.target_id,
        "server_side": bool((r.detail or {}).get("server_side")),
        "title": (r.detail or {}).get("title", ""),
        "detail": (r.detail or {}).get("detail", ""),
        "who": (r.detail or {}).get("username", ""),
    } for r in rows]


# ── ICE(STUN/TURN) 서버 설정 (2026-08-12) ───────────────────────────────────
#
# 왜 서버 설정인가: sv70(클라우드 배치)에서 1:1 통화가 "연결 중…" 뒤 조용히 실패했다.
# 신호는 정상, ICE(미디어 경로) 실패 — 기본 ICE 가 빈 배열이라 서로 다른 망 사이에 길이
# 없었다. 좌석마다 localStorage 에 넣게 하는 것은 운영이 안 된다(누가 어느 PC 에 넣었는지
# 아무도 모른다) — 기관 전체 값은 서버가 한 곳에서 정하고 hello 로 배달한다.
ICE_SETTING_KEY = "collab.ice_servers"
_ICE_URL_OK = ("stun:", "turn:", "turns:")


def sanitize_ice_servers(value) -> list[dict]:
    """설정으로 들어온 ICE 목록 정규화 — 프론트 lib/collabIce.sanitizeIceServers 와 같은 규칙.

    stun:/turn:/turns: 외 URL 과 모르는 키를 버린다. 오타 하나가 RTCPeerConnection 생성
    예외로 이어지면 통화가 통째로 죽으므로, 저장 시점에 거른다(읽기 쪽은 신뢰).
    """
    if not isinstance(value, (list, tuple)):
        return []
    out: list[dict] = []
    for it in value:
        if not isinstance(it, dict):
            continue
        urls = it.get("urls")
        urls = urls if isinstance(urls, (list, tuple)) else [urls]
        good = [str(u).strip() for u in urls
                if isinstance(u, str) and str(u).strip().lower().startswith(_ICE_URL_OK)]
        if not good:
            continue
        row: dict = {"urls": good}
        if isinstance(it.get("username"), str) and it["username"]:
            row["username"] = it["username"][:128]
        if isinstance(it.get("credential"), str) and it["credential"]:
            row["credential"] = it["credential"][:256]
        out.append(row)
    return out


def get_ice_servers(db: Session) -> list[dict] | None:
    """서버 설정 ICE. **None = 미설정**(클라이언트 기본 로직), [] = 명시적 끔(폐쇄망).

    이 구분이 무너지면 안 된다 — 폐쇄망 관리자가 '끔'으로 저장했는데 None 으로 읽히면
    클라이언트가 기본 STUN 을 되살려 매 통화 외부 질의를 하게 된다.
    """
    try:
        from app.services.settings_service import get_setting

        v = get_setting(db, ICE_SETTING_KEY, default=None)
    except Exception:  # noqa: BLE001 — 설정 조회 실패가 협진 접속을 막으면 안 된다
        return None
    if v is None:
        return None
    servers = v.get("servers") if isinstance(v, dict) else v
    if servers is None:
        return None
    return sanitize_ice_servers(servers)


def set_ice_servers(db: Session, admin: Account, servers: list | None) -> list[dict] | None:
    """관리자 저장. None = 설정 삭제(미설정으로 되돌림). 반환 = 저장된 정규화 목록."""
    from app.services.settings_service import set_setting

    clean = None if servers is None else sanitize_ice_servers(servers)
    set_setting(db, ICE_SETTING_KEY, {"servers": clean})
    _audit(db, admin.id, "collab_ice_set", "setting", ICE_SETTING_KEY,
           {"count": len(clean) if clean is not None else -1})
    db.commit()
    return clean
