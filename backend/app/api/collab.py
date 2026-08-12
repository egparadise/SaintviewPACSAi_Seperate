"""협진 REST — 디렉터리·친구·메신저 백필·세션 CRUD.

실시간 경로는 collab_ws.py 가 담당한다. 여기는 (a) 최초 로드 시 한 번 읽는 목록,
(b) WebSocket 이 끊겼을 때도 되어야 하는 조작(친구 요청 등)을 맡는다.

권한: 협진은 로그인한 Client 사용자면 누구나 쓴다(별도 권한 키를 만들지 않았다).
      "무엇을 볼 수 있나" 는 협진이 아니라 기존 테넌시 게이트가 정한다 —
      게스트의 조회는 CollabGrant, 쓰기는 기존 require_effective 가 그대로 막는다.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.deps import current_user
from app.db import get_db
from app.models import Account
from app.services import collab_service as svc
from app.services.collab_hub import hub
from app.services.permissions import COLLAB_CAPS

logger = logging.getLogger("saintview.collab")

router = APIRouter(prefix="/api/collab", tags=["collab"])


def _me(db: Session, user: dict) -> Account:
    acc = svc.account_of(db, user)
    if acc is None:
        # ⚠ 401 이면 안 된다. 프론트의 전역 401 처리기는 '세션 만료' 로 보고
        #   setToken(null) + 강제 리로드를 한다 — 협진 버튼을 누르는 순간 로그인 화면으로
        #   튕겨 나가는 실제 사고가 이것이었다(A 계정 로그인 + 미러 행 없음 조합).
        #   세션은 멀쩡하고 '이 기능을 쓸 자격 행이 없다' 는 뜻이므로 403 이 맞다.
        raise HTTPException(status_code=403,
                            detail="협진을 쓸 수 없는 계정입니다 — 다시 로그인하면 등록됩니다")
    return acc


def _sess_or_404(db: Session, code: str):
    sess = svc.get_session(db, code)
    if sess is None:
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다")
    return sess


# ── 디렉터리 ────────────────────────────────────────────────────────────────
@router.get("/directory")
def directory(q: str = "", other_only: bool = False,
              db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """친구 요청 대상 검색 — 같은 병원 + 타 병원. 온라인 여부를 함께 준다."""
    me = _me(db, user)
    items = svc.directory(db, me, q=q, only_other_hospital=other_only)
    online = hub.online_ids()
    for it in items:
        it["online"] = it["id"] in online
    return {"items": items, "caps": COLLAB_CAPS}


@router.get("/presence")
def presence(db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """내 친구들의 현재 접속 상태 — WS 가 끊긴 동안의 폴백 조회."""
    me = _me(db, user)
    online = hub.online_ids()
    return {"online": sorted(fid for fid in svc.friend_ids(db, me.id) if fid in online)}


# ── 친구 ────────────────────────────────────────────────────────────────────
@router.get("/friends")
def friends(db: Session = Depends(get_db), user: dict = Depends(current_user)):
    me = _me(db, user)
    data = svc.list_friends(db, me)
    online = hub.online_ids()
    for bucket in ("friends", "incoming", "outgoing", "blocked"):
        for it in data[bucket]:
            it["online"] = it["id"] in online
    data["unread"] = svc.unread_counts(db, me)
    return data


class FriendReq(BaseModel):
    target_id: int
    message: str = Field(default="", max_length=200)


@router.post("/friends/request")
async def friend_request(body: FriendReq, db: Session = Depends(get_db),
                         user: dict = Depends(current_user)):
    me = _me(db, user)
    try:
        link, result = svc.request_friend(db, me, body.target_id, body.message)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    # 상대가 접속 중이면 즉시 알린다(새로고침 없이 요청이 뜬다)
    if result in ("created", "accepted"):
        await hub.send_to(body.target_id, {
            "t": "friend.accepted" if result == "accepted" else "friend.request",
            "from": svc.user_brief(db, me), "message": link.message,
        })
    return {"ok": True, "result": result}


class FriendRespond(BaseModel):
    other_id: int
    accept: bool


@router.post("/friends/respond")
async def friend_respond(body: FriendRespond, db: Session = Depends(get_db),
                         user: dict = Depends(current_user)):
    me = _me(db, user)
    try:
        svc.respond_friend(db, me, body.other_id, body.accept)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    if body.accept:
        await hub.send_to(body.other_id,
                          {"t": "friend.accepted", "from": svc.user_brief(db, me)})
    return {"ok": True}


class FriendTarget(BaseModel):
    other_id: int


@router.post("/friends/block")
def friend_block(body: FriendTarget, blocked: bool = True,
                 db: Session = Depends(get_db), user: dict = Depends(current_user)):
    me = _me(db, user)
    try:
        svc.set_block(db, me, body.other_id, blocked)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    return {"ok": True}


@router.post("/friends/remove")
async def friend_remove(body: FriendTarget, db: Session = Depends(get_db),
                        user: dict = Depends(current_user)):
    """친구 해제 — 관계를 지우고 **둘 사이의 대화를 전부 삭제**한다.

    계정은 건드리지 않으므로 검색(디렉터리)에는 계속 보인다 — 나중에 다시 친구로 추가할 수 있다.
    대화는 룸을 공유하므로 상대 화면에서도 사라진다. 그래서 열려 있는 상대 창에
    dm.purged 를 보내 즉시 비운다 — 안 보내면 이미 없는 메시지를 계속 보고 있게 된다.
    """
    me = _me(db, user)
    try:
        purged = svc.unfriend(db, me, body.other_id)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    room = svc.dm_room(me.id, body.other_id)
    await hub.send_many({me.id, body.other_id},
                        {"t": "dm.purged", "room": room, "by": me.id, "n": purged})
    return {"ok": True, "purged": purged}


# ── 메신저 ──────────────────────────────────────────────────────────────────
@router.get("/messages")
def messages(room: str, before_id: int = 0, db: Session = Depends(get_db),
             user: dict = Depends(current_user)):
    """룸 백필 — WS 로는 신규만 오므로 과거는 여기서 읽는다(무한 스크롤 before_id)."""
    me = _me(db, user)
    if not svc.can_use_room(db, me, room):
        raise HTTPException(status_code=403, detail="이 대화방에 참여할 수 없습니다")
    return {"items": svc.list_messages(db, room, before_id=before_id)}


class ReadBody(BaseModel):
    room: str


@router.post("/messages/read")
def messages_read(body: ReadBody, db: Session = Depends(get_db),
                  user: dict = Depends(current_user)):
    me = _me(db, user)
    if not svc.can_use_room(db, me, body.room):
        raise HTTPException(status_code=403, detail="이 대화방에 참여할 수 없습니다")
    return {"ok": True, "marked": svc.mark_read(db, me, body.room)}


# ── 세션 ────────────────────────────────────────────────────────────────────
class OpenBody(BaseModel):
    study_id: int
    title: str = Field(default="", max_length=256)


@router.post("/sessions")
def session_open(body: OpenBody, db: Session = Depends(get_db),
                 user: dict = Depends(current_user)):
    """협진 세션 개설 — 개설자가 Master 가 된다."""
    me = _me(db, user)
    try:
        # user 를 넘긴다 — Live(vid) 검사는 이 사람의 A 세션(sid)으로 존재를 확인한다
        sess = svc.open_session(db, me, body.study_id, body.title, user=user)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    return svc.session_brief(db, sess, online=hub.online_ids())


@router.get("/sessions")
def session_list(db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """내가 참가 중·초대받은 열린 세션 — 새로고침·재접속 복구용."""
    me = _me(db, user)
    online = hub.online_ids()
    return {"items": [svc.session_brief(db, s, online=online)
                      for s in svc.open_sessions_for(db, me.id)]}


@router.get("/sessions/{code}")
def session_get(code: str, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    me = _me(db, user)
    sess = _sess_or_404(db, code)
    if svc.participant_of(db, sess.id, me.id) is None:
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다")
    return svc.session_brief(db, sess, online=hub.online_ids())


class InviteBody(BaseModel):
    target_id: int


@router.post("/sessions/{code}/invite")
async def session_invite(code: str, body: InviteBody, db: Session = Depends(get_db),
                         user: dict = Depends(current_user)):
    me = _me(db, user)
    sess = _sess_or_404(db, code)
    try:
        svc.invite(db, sess, me, body.target_id)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    await hub.send_to(body.target_id, {
        "t": "invite", "code": sess.code, "from": svc.user_brief(db, me),
        "title": sess.title, "study_uid": sess.study_uid,
    })
    return svc.session_brief(db, sess, online=hub.online_ids())


@router.post("/sessions/{code}/decline")
async def session_decline(code: str, db: Session = Depends(get_db),
                          user: dict = Depends(current_user)):
    me = _me(db, user)
    sess = _sess_or_404(db, code)
    svc.decline(db, sess, me)
    await hub.send_to(sess.host_id, {"t": "declined", "code": code, "id": me.id})
    return {"ok": True}


@router.post("/sessions/{code}/leave")
async def session_leave(code: str, db: Session = Depends(get_db),
                        user: dict = Depends(current_user)):
    me = _me(db, user)
    sess = _sess_or_404(db, code)
    svc.leave(db, sess, me)
    await hub.broadcast_session(code, {"t": "left", "id": me.id})
    return {"ok": True}


@router.post("/sessions/{code}/close")
async def session_close(code: str, db: Session = Depends(get_db),
                        user: dict = Depends(current_user)):
    """세션 종료 — Master 만. 전 참가자의 임시 열람권이 이 시점에 무효화된다."""
    me = _me(db, user)
    sess = _sess_or_404(db, code)
    if sess.host_id != me.id:
        raise HTTPException(status_code=403, detail="세션 종료는 개설자(Master)만 할 수 있습니다")
    svc.close_session(db, sess, by=me)
    members = hub.drop_session(code)
    await hub.send_many(members, {"t": "session.closed", "code": code})
    return {"ok": True}


class CapsBody(BaseModel):
    target_id: int
    caps: list[str] = Field(default_factory=list)


@router.post("/sessions/{code}/caps")
async def session_set_caps(code: str, body: CapsBody, db: Session = Depends(get_db),
                           user: dict = Depends(current_user)):
    """참가자 **한 사람의** 허용 범위 조정 — 협진 페이지의 체크박스가 여기로 온다.

    남의 caps 는 건드리지 않는다(여러 명이 동시에 같은 cap 을 갖는 것이 다학제의 정상 동작).
    caps 는 화이트리스트를 통과하므로 판독 수정·영상 삭제 같은 키는 들어올 수 없다.
    """
    me = _me(db, user)
    sess = _sess_or_404(db, code)
    try:
        svc.set_caps(db, sess, me, body.target_id, body.caps)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    out = svc.session_brief(db, sess, online=hub.online_ids())
    # 권한이 바뀌면 그 사람의 소켓이 즉시 알아야 한다(툴 활성/비활성이 바로 바뀐다)
    hub.bump_control(code)
    await hub.broadcast_session(code, {"t": "ctl.granted", "d": out,
                                       "by": me.id, "target": body.target_id})
    return out


class AdoptBody(BaseModel):
    target_id: int


@router.post("/sessions/{code}/adopt")
async def session_adopt(code: str, body: AdoptBody, db: Session = Depends(get_db),
                        user: dict = Depends(current_user)):
    """Master 가 참가자의 세션 주석을 **정식 판독 주석으로 채택**한다.

    세션 주석은 메모리에만 있다가 세션이 닫히면 사라진다(설계상 "세션 한정").
    남길 가치가 있는 것은 Master 가 자기 책임으로 채택한다 — 저장은 Master 이름으로 하되
    text 앞에 원 작성자를 병기해 누가 낸 소견인지 기록에 남긴다.
    """
    me = _me(db, user)
    sess = _sess_or_404(db, code)
    if sess.host_id != me.id:
        raise HTTPException(status_code=403, detail="채택은 개설자(Master)만 할 수 있습니다")
    rows = hub.annos_of(code, body.target_id)
    if not rows:
        return {"ok": True, "adopted": 0}
    author = db.get(Account, body.target_id)
    name = svc.display_of(author)
    try:
        # Live(vid) 검사면 A 주석 저장소로 쓴다 — Master 의 A 자격(user.sid) 사용
        saved = svc.adopt_annotations(db, sess, me, rows, author_name=name, user=user)
    except LookupError as e:
        raise HTTPException(status_code=502, detail=str(e))
    for r in rows:                       # 채택된 것은 세션 목록에서 뺀다(중복 저장 방지)
        hub.anno_remove(code, str(r.get("id") or ""), body.target_id, force=True)
        await hub.send_session_socket(code, {"t": "anno.remove", "id": r.get("id"),
                                             "by": body.target_id})
    await hub.broadcast_session(code, {"t": "adopted", "target": body.target_id, "n": saved})
    return {"ok": True, "adopted": saved}


# ── 연결 진단 (2026-08-11) ───────────────────────────────────────────────────
#
# 왜 필요한가: 서버가 협진을 막고 있을 때 **우리 시스템 안에는 아무 흔적도 남지 않았다**.
# nginx 가 WebSocket 업그레이드를 거부하면 요청이 백엔드에 도달조차 못 하므로, 백엔드
# 로그를 아무리 뒤져도 "아무 일도 없었던 것처럼" 보인다. 그래서 현장에서는 사용자가
# "연결이 안 돼요" 라고만 말하고 관리자는 확인할 방법이 없었다.
#
# 두 방향으로 채운다:
#   ① 서버가 스스로 아는 것을 보고한다      → GET  /collab/health
#   ② 클라이언트가 내린 판정을 서버에 남긴다 → POST /collab/diag  (조회는 GET)

class DiagReport(BaseModel):
    code: str = Field(max_length=40)          # collabPreflight.BlockCode
    server_side: bool = False
    title: str = Field(default="", max_length=200)
    detail: str = Field(default="", max_length=500)


# 같은 사람이 같은 원인으로 계속 실패하면(재연결 루프) 감사 로그가 폭주한다.
# 원인별로 이 간격 안에는 한 번만 남긴다 — 진단에는 '처음 언제부터'가 중요하지 횟수가 아니다.
_DIAG_TTL = 300.0
_diag_seen: dict[tuple[int, str], float] = {}


@router.get("/health")
def collab_health(request: Request, user: dict = Depends(current_user)):
    """서버 자가 점검 — 백엔드가 **스스로 아는 것**만 보고한다.

    🔴 판정의 핵심은 `ws.accepted` 다. 이 REST 응답을 받았다는 것은 프록시가 HTTP 는
      넘겨 준다는 뜻인데, 그런데도 accepted 가 0 이면 **WebSocket 만** 막혀 있는 것이다
      = nginx 업그레이드 블록 문제로 확정할 수 있다. 백엔드는 그 요청을 본 적도 없으므로
      이 카운터가 없으면 영영 구별되지 않는다.

    proxy_proto 는 nginx 가 넘긴 X-Forwarded-Proto — 앞단이 https 로 받았는지 알려 준다
    (브라우저가 https 로 보였어도 프록시 구간이 http 면 헤더가 http 로 온다).
    """
    stat = hub.stats()
    return {
        "ok": True,
        "proxy_proto": request.headers.get("x-forwarded-proto", ""),
        "proxy_host": request.headers.get("x-forwarded-host", "") or request.headers.get("host", ""),
        "ws": {k: stat[k] for k in
               ("accepted", "rej_auth", "rej_account", "rej_limit", "closed", "errors")},
        "sockets": stat["sockets"],
        "accounts": stat["accounts"],
        # WS 가 한 번도 수락되지 않았다 = 이 REST 는 되는데 업그레이드만 안 온다
        "ws_never_accepted": stat["accepted"] == 0,
        "recent_rejects": stat["recent_rejects"][-10:],
    }


@router.post("/diag")
def collab_diag_report(body: DiagReport, db: Session = Depends(get_db),
                       user: dict = Depends(current_user)):
    """클라이언트가 내린 차단 판정을 서버에 남긴다(감사 로그).

    사용자 화면에만 뜨고 마는 진단은 관리자에게 닿지 않는다. 판독의는 "안 돼요" 라고만
    말하지 원인 코드를 옮겨 적지 않는다 — 그래서 화면이 판정한 순간 서버가 받아 둔다.
    """
    me = _me(db, user)
    import time as _t

    key = (me.id, body.code)
    now = _t.monotonic()
    seen = _diag_seen.get(key, 0.0)
    if now - seen < _DIAG_TTL:
        return {"ok": True, "recorded": False}      # 같은 원인 반복 — 조용히 넘긴다
    _diag_seen[key] = now
    svc.record_diag(db, me, code=body.code, server_side=body.server_side,
                    title=body.title, detail=body.detail)
    logger.warning("협진 연결 문제 보고 [%s] %s (account=%s)", body.code, body.title, me.username)
    return {"ok": True, "recorded": True}


@router.get("/diag")
def collab_diag_list(limit: int = 50, mine: bool = True, db: Session = Depends(get_db),
                     user: dict = Depends(current_user)):
    """최근 연결 문제 목록.

    범위: 기본은 **내 것만**. 전체(mine=false)는 관리자만 — 다른 사람이 언제 어디서
    실패했는지는 운영 정보라 아무나 볼 것이 아니다. 관리자가 아니면 조용히 내 것으로
    되돌린다(403 을 던지면 일반 사용자의 설정 화면이 오류로 보인다).
    """
    me = _me(db, user)
    scope_all = (not mine) and (me.role == "admin")
    return {"items": svc.list_diag(db, None if scope_all else me.id, limit=min(200, max(1, limit))),
            "scope": "all" if scope_all else "mine"}
