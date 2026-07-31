"""협진 WebSocket — 프레즌스·채팅·화면 상태 미러·제어권·WebRTC 시그널링.

경로: WS /api/collab/ws   (인증: Sec-WebSocket-Protocol: sv.bearer, <jwt> — deps.ws_user)

⚠ 성능 계약 — 이 파일에서 가장 중요한 규칙:
  뷰어 상태(state)와 커서(cursor)는 **초당 수십 건**이 오간다. 이 두 종류는 DB 를 절대
  건드리지 않고 허브 릴레이로만 처리한다. 제어권 검사조차 매 프레임 DB 를 보면 안 되므로
  소켓별 메모리 캐시(_ctl_cache)에 두고, 제어권이 실제로 바뀔 때만 무효화한다.
  (같은 실수의 전례: 판독 도크 폴링이 anyio 스레드풀을 굶겨 서버 전체가 먹통이 된 커밋 b64854f)

DB 가 필요한 저빈도 메시지(chat·ctl.*·join/leave)만 run_in_threadpool 로 감싼다 —
동기 SQLAlchemy 를 이벤트루프에서 직접 돌리면 그 순간 전 소켓이 멈춘다.
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from starlette.concurrency import run_in_threadpool

from app.api.deps import WS_SUBPROTOCOL, ws_user
from app.db import SessionLocal
from app.services import collab_service as svc
from app.services.collab_hub import hub

logger = logging.getLogger("saintview.collab.ws")

router = APIRouter(tags=["collab"])

# 정책 close 코드 (4000~4999 = 애플리케이션 정의)
CLOSE_UNAUTHORIZED = 4401
CLOSE_TOO_MANY = 4429
CLOSE_INTERNAL = 4500

# 릴레이 전용(무 DB) 메시지 — 이 집합에 있는 타입은 어떤 경우에도 DB 를 타지 않는다
_RELAY_TYPES = frozenset({"state", "cursor", "rtc.offer", "rtc.answer", "rtc.ice", "rtc.leave"})

# 제어권 캐시 수명(초). 짧게 잡는 이유: 만료·회수가 이 시간 안에는 반영되어야 한다.
# 회수는 어차피 즉시 이벤트로 캐시를 깨므로, 이 값은 '이벤트를 놓쳤을 때의 상한'이다.
_CTL_TTL = 3.0

# 한 소켓이 보낼 수 있는 최대 프레임 크기(바이트). 뷰어 상태 스냅샷은 보통 2~8KB 다.
_MAX_FRAME = 256 * 1024


def _sync_context(user: dict) -> dict[str, Any] | None:
    """접속 직후 1회 — 신원·친구·복구할 세션을 한 벌로 만든다(스레드풀에서 실행)."""
    with SessionLocal() as db:
        me = svc.account_of(db, user)
        if me is None:
            return None
        return {
            "account_id": me.id,
            "username": me.username,
            "display_name": svc.display_of(me),
            "hospital_id": me.hospital_id,
            "role": me.role,
            "me": svc.user_brief(db, me),
            "friend_ids": sorted(svc.friend_ids(db, me.id)),
            "sessions": [svc.session_brief(db, s) for s in svc.open_sessions_for(db, me.id)],
        }


async def _announce_presence(account_id: int, friends: list[int], online: bool) -> None:
    """내 온·오프라인을 친구들에게만 알린다 — 전체 브로드캐스트는 하지 않는다."""
    if not friends:
        return
    await hub.send_many([f for f in friends if hub.is_online(f)],
                        {"t": "presence", "id": account_id, "online": online})


@router.websocket("/api/collab/ws")
async def collab_ws(websocket: WebSocket) -> None:
    user = ws_user(websocket)
    if user is None:
        # accept 전 close = 핸드셰이크 거부(HTTP 403). 브라우저에 자격증명이 되돌아가지 않는다.
        await websocket.close(code=CLOSE_UNAUTHORIZED)
        return

    ctx = await run_in_threadpool(_sync_context, user)
    if ctx is None:
        await websocket.close(code=CLOSE_UNAUTHORIZED)
        return

    # 서브프로토콜을 반드시 echo 해야 브라우저가 핸드셰이크를 받아들인다
    await websocket.accept(subprotocol=WS_SUBPROTOCOL)

    aid: int = ctx["account_id"]
    friends: list[int] = list(ctx["friend_ids"])
    ok = hub.attach(websocket, account_id=aid, username=ctx["username"],
                    display_name=ctx["display_name"], hospital_id=ctx["hospital_id"],
                    role=ctx["role"])
    if not ok:
        await websocket.close(code=CLOSE_TOO_MANY)
        return

    # 이 창이 이 계정의 **첫** 협진 소켓인가 — 다중 모니터로 창을 3개 띄웠다고 친구들에게
    # '온라인' 이 세 번 갈 이유는 없다. attach 직후이므로 1이면 내가 첫 창이다.
    was_first = hub.socket_count_of(aid) == 1

    # cap → (만료시각, 제어권 리비전, 허용여부). 리비전이 있어야 **다른 소켓**에서 일어난
    # 제어권 승인·회수가 이 소켓에도 즉시 반영된다(collab_hub._ctl_rev 주석 참조).
    _ctl_cache: dict[str, tuple[float, int, bool]] = {}

    try:
        await websocket.send_json({
            "t": "hello",
            "me": ctx["me"],
            "online": sorted(f for f in friends if hub.is_online(f)),
            "sessions": ctx["sessions"],
        })
        if was_first:
            await _announce_presence(aid, friends, True)

        while True:
            raw = await websocket.receive_text()
            if len(raw) > _MAX_FRAME:
                await websocket.send_json({"t": "error", "detail": "메시지가 너무 큽니다"})
                continue
            try:
                msg = json.loads(raw)
            except (ValueError, TypeError):
                continue
            if not isinstance(msg, dict):
                continue
            t = str(msg.get("t") or "")

            if t == "ping":
                await websocket.send_json({"t": "pong"})
                continue

            # ── 고빈도 릴레이 경로 (DB 접근 0) ────────────────────────────────
            if t in _RELAY_TYPES:
                code = hub.session_of(websocket)
                if not code:
                    continue
                if t in ("state", "cursor"):
                    # 화면을 움직일 수 있는 사람만 송출한다 — 서버가 검증한다.
                    # 커서는 관전자도 보여 주는 편이 협진에 유용하므로 검사하지 않는다.
                    if t == "state" and not await _may_control(_ctl_cache, code, aid, "collab.viewport"):
                        continue
                    payload = {"t": t, "from": aid, "d": msg.get("d")}
                    await hub.send_session_socket(code, payload, exclude_ws=websocket)
                    continue
                # WebRTC 시그널링 — 서버는 내용을 보지 않고 지정 상대에게만 넘긴다(SDP/ICE 는 불투명)
                to = msg.get("to")
                if not isinstance(to, int) or to not in hub.session_members(code):
                    continue
                await hub.send_to(to, {"t": t, "from": aid, "d": msg.get("d")})
                continue

            # ── 저빈도 경로 (DB 사용 — 스레드풀) ─────────────────────────────
            if t == "session.enter":
                code = str(msg.get("code") or "")
                res = await run_in_threadpool(_do_enter, aid, code)
                if res.get("error"):
                    await websocket.send_json({"t": "error", "detail": res["error"]})
                    continue
                hub.join_session(websocket, code)
                _ctl_cache.clear()
                await websocket.send_json({"t": "session", "d": res["session"]})
                await hub.broadcast_session(code, {"t": "joined", "id": aid, "d": res["session"]},
                                            exclude_account=aid)
                continue

            if t == "session.exit":
                code = hub.leave_session(websocket)
                _ctl_cache.clear()
                if code:
                    await hub.broadcast_session(code, {"t": "left", "id": aid})
                continue

            if t == "chat":
                room = str(msg.get("room") or "")
                body = str(msg.get("body") or "").strip()
                if not room or not body:
                    continue
                res = await run_in_threadpool(_do_chat, aid, room, body)
                if res.get("error"):
                    await websocket.send_json({"t": "error", "detail": res["error"]})
                    continue
                out = {"t": "chat", "d": res["message"]}
                await hub.send_many(res["targets"], out)
                await websocket.send_json(out)      # 발신자 본인 확정 에코(낙관적 UI 정정)
                continue

            if t in ("ctl.request", "ctl.grant", "ctl.revoke"):
                code = hub.session_of(websocket)
                if not code:
                    continue
                res = await run_in_threadpool(_do_control, t, aid, code, msg)
                if res.get("error"):
                    await websocket.send_json({"t": "error", "detail": res["error"]})
                    continue
                # 세션 전체의 제어권 캐시를 무효화 — 승인을 받은 **상대 소켓**이 알아야 한다
                hub.bump_control(code)
                _ctl_cache.clear()
                # 제어권은 전 참가자의 UI 를 바꾸므로 세션 전체에 세션 스냅샷을 다시 뿌린다
                await hub.broadcast_session(code, {"t": res["event"], "d": res["session"],
                                                   "by": aid, "target": res.get("target")})
                await websocket.send_json({"t": res["event"], "d": res["session"],
                                           "by": aid, "target": res.get("target")})
                continue

            if t == "exam.switch":
                code = hub.session_of(websocket)
                if not code:
                    continue
                res = await run_in_threadpool(_do_switch, aid, code, int(msg.get("study_id") or 0))
                if res.get("error"):
                    await websocket.send_json({"t": "error", "detail": res["error"]})
                    continue
                await hub.broadcast_session(code, {"t": "exam", "d": res["session"],
                                                   "granted": res["granted"]})
                await websocket.send_json({"t": "exam", "d": res["session"],
                                           "granted": res["granted"]})
                continue

    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001 — 소켓 하나의 사고가 서버를 흔들면 안 된다
        logger.exception("collab WS 처리 중 오류 (account_id=%s)", aid)
    finally:
        code = hub.session_of(websocket)
        hub.detach(websocket)
        still_online = hub.is_online(aid)
        try:
            if code and aid not in hub.session_members(code):
                await hub.broadcast_session(code, {"t": "left", "id": aid})
            if not still_online:
                await _announce_presence(aid, friends, False)
        except Exception:  # noqa: BLE001 — 정리 중 실패는 로그만
            logger.debug("collab WS 정리 실패(무시)", exc_info=True)


async def _may_control(cache: dict[str, tuple[float, int, bool]], code: str,
                       account_id: int, cap: str) -> bool:
    """제어권 확인 — 리비전 + 짧은 TTL 캐시. 매 프레임 DB 를 보지 않기 위한 장치다.

    리비전은 '승인·회수 같은 명시적 변경'을 즉시 반영하고, TTL 은 '시간 만료
    (control_expires_at)'처럼 아무 이벤트도 없이 조용히 바뀌는 경우를 덮는다. 둘 다 필요하다.
    """
    now = time.monotonic()
    rev = hub.control_rev(code)
    hit = cache.get(cap)
    if hit is not None and hit[0] > now and hit[1] == rev:
        return hit[2]
    allowed = await run_in_threadpool(_check_control, code, account_id, cap)
    cache[cap] = (now + _CTL_TTL, rev, allowed)
    return allowed


def _check_control(code: str, account_id: int, cap: str) -> bool:
    with SessionLocal() as db:
        sess = svc.get_session(db, code)
        if sess is None or sess.status != "open":
            return False
        return svc.can_control(db, sess, account_id, cap)


# ── 스레드풀에서 도는 DB 작업들 ──────────────────────────────────────────────
def _do_enter(account_id: int, code: str) -> dict:
    from app.models import Account

    with SessionLocal() as db:
        sess = svc.get_session(db, code)
        if sess is None or sess.status != "open":
            return {"error": "세션을 찾을 수 없습니다"}
        me = db.get(Account, account_id)
        if me is None:
            return {"error": "계정을 찾을 수 없습니다"}
        try:
            svc.join(db, sess, me)
        except (PermissionError, LookupError) as e:
            return {"error": str(e)}
        return {"session": svc.session_brief(db, sess, online=hub.online_ids())}


def _do_chat(account_id: int, room: str, body: str) -> dict:
    from app.models import Account

    with SessionLocal() as db:
        me = db.get(Account, account_id)
        if me is None:
            return {"error": "계정을 찾을 수 없습니다"}
        if not svc.can_use_room(db, me, room):
            return {"error": "이 대화방에 참여할 수 없습니다"}
        msg = svc.post_message(db, me, room, body)
        # 수신 대상 — DM 은 상대 1명, 세션 룸은 참가자 전원(발신자 제외).
        # 룸 키를 여기서 뜯지 않는다: 형식을 아는 곳은 collab_service.parse_room 하나뿐이다.
        targets: list[int] = []
        parsed = svc.parse_room(room)
        if parsed is not None and parsed[0] == "dm":
            peer = svc.dm_peer(room, account_id)
            targets = [peer] if peer is not None else []
        elif parsed is not None:
            sess = svc.get_session(db, parsed[1][0])
            if sess is not None:
                targets = [p.account_id for p in svc.participants(db, sess.id)
                           if p.state == "joined" and p.account_id != account_id]
        return {"message": svc.message_brief(db, msg, me), "targets": targets}


def _do_control(kind: str, account_id: int, code: str, msg: dict) -> dict:
    from app.models import Account

    with SessionLocal() as db:
        sess = svc.get_session(db, code)
        me = db.get(Account, account_id)
        if sess is None or me is None or sess.status != "open":
            return {"error": "세션을 찾을 수 없습니다"}
        try:
            if kind == "ctl.request":
                p = svc.request_control(db, sess, me, msg.get("caps"))
                event, target = "ctl.requested", p.account_id
            elif kind == "ctl.grant":
                p = svc.grant_control(db, sess, me, int(msg.get("target") or 0),
                                      caps=msg.get("caps"))
                event, target = "ctl.granted", p.account_id
            else:
                p = svc.revoke_control(db, sess, me)
                event, target = "ctl.revoked", (p.account_id if p else None)
        except (PermissionError, LookupError, ValueError) as e:
            return {"error": str(e)}
        return {"event": event, "target": target,
                "session": svc.session_brief(db, sess, online=hub.online_ids())}


def _do_switch(account_id: int, code: str, study_id: int) -> dict:
    from app.models import Account

    with SessionLocal() as db:
        sess = svc.get_session(db, code)
        me = db.get(Account, account_id)
        if sess is None or me is None:
            return {"error": "세션을 찾을 수 없습니다"}
        try:
            granted = svc.set_share_study(db, sess, me, study_id)
        except (PermissionError, LookupError) as e:
            return {"error": str(e)}
        return {"granted": granted,
                "session": svc.session_brief(db, sess, online=hub.online_ids())}
