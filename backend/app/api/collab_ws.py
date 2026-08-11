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
from app.services.collab_hub import MAX_SESSION_ANNOS, hub

logger = logging.getLogger("saintview.collab.ws")

router = APIRouter(tags=["collab"])

# 정책 close 코드 (4000~4999 = 애플리케이션 정의)
CLOSE_UNAUTHORIZED = 4401
# 토큰은 유효한데 Account 행이 없다(협진 자격 없음) — 인증 만료(4401)와 **다른 코드**여야 한다.
# 4401 로 닫으면 프론트가 "인증이 만료되었습니다" 를 띄우는데 세션은 멀쩡하다(거짓 안내).
CLOSE_NO_ACCOUNT = 4403
CLOSE_TOO_MANY = 4429
CLOSE_INTERNAL = 4500

# 화면 상태는 고빈도라 무조건 DB 0회. WebRTC는 검사 기반 세션이면 허브만
# 확인하고, 1:1 DM 통화면 친구 관계를 짧게 캐시해 검증한다(아래 분기).
_STATE_RELAY_TYPES = frozenset({"state", "cursor"})
_RTC_RELAY_TYPES = frozenset({"rtc.ready", "rtc.offer", "rtc.answer", "rtc.ice", "rtc.leave"})

# 제어권 캐시 수명(초). 짧게 잡는 이유: 만료·회수가 이 시간 안에는 반영되어야 한다.
# 회수는 어차피 즉시 이벤트로 캐시를 깨므로, 이 값은 '이벤트를 놓쳤을 때의 상한'이다.
_CTL_TTL = 3.0

# 세션 주석에서 받아들이는 필드 — 화이트리스트다.
# 클라가 보낸 dict 를 그대로 저장하면 (a) 아무 키나 실어 메모리를 불릴 수 있고
# (b) id·by 를 위조해 남의 이름·색으로 그려 놓을 수 있다. 그 둘은 허브가 직접 박는다.
_ANNO_FIELDS = ("kind", "points", "series_uid", "sop_uid", "text", "value", "unit", "pid",
                "surface", "life")
_ANNO_MAX_POINTS = 512      # open-ended 도구(폴리라인)도 이 안에서 끝난다
_ANNO_TEXT_MAX = 200

# 마크를 얹는 표면. 좌표계가 표면마다 **완전히 다르므로**(이미지 정규화 / 비디오 프레임 /
# 화이트보드) 자유 문자열로 두면 안 된다 — 모르는 값이 오면 pane 으로 떨어져 DICOM 영상
# 위에 엉뚱한 좌표로 그려진다. 프론트 lib/collabSurface.ts 의 Surface 와 같은 집합.
_ANNO_SURFACES = frozenset({"pane", "screen", "wb"})
# 마크 수명. laser = 잠깐 가리키는 것(받는 쪽이 자동 소멸), pin = 남겨 두는 것.
_ANNO_LIVES = frozenset({"laser", "pin"})
# 도착 시각(at)은 **받는 쪽이** 찍는다 — 좌석 간 시계가 어긋나면 레이저가 즉시 사라지거나
# 영원히 안 사라진다. 그래서 서버도 클라도 at 을 전송하지 않는다(화이트리스트에 없다).


def _clean_anno(d) -> dict:
    """세션 주석 정규화 — 화이트리스트 밖은 버리고 크기를 묶는다."""
    if not isinstance(d, dict):
        return {}
    out: dict = {}
    for k in _ANNO_FIELDS:
        if k not in d:
            continue
        v = d[k]
        if k == "points":
            if not isinstance(v, list):
                continue
            pts = []
            for p in v[:_ANNO_MAX_POINTS]:
                if isinstance(p, (list, tuple)) and len(p) >= 2:
                    try:
                        pts.append([float(p[0]), float(p[1])])
                    except (TypeError, ValueError):
                        continue
            out["points"] = pts
        elif k == "surface":
            # 모르는 표면은 **버린다**(pane 으로 강등하지 않는다) — 좌표계가 다른 마크를
            # 뷰포트에 올리는 것보다 안 그리는 편이 낫다. 없으면 수신측이 pane 으로 본다.
            if str(v) in _ANNO_SURFACES:
                out[k] = str(v)
        elif k == "life":
            if str(v) in _ANNO_LIVES:
                out[k] = str(v)
        elif k in ("text", "kind", "series_uid", "sop_uid", "unit", "pid"):
            out[k] = str(v)[:_ANNO_TEXT_MAX]
        elif k == "value":
            try:
                out[k] = float(v) if v is not None else None
            except (TypeError, ValueError):
                out[k] = None
    return out

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


def _can_relay_dm_rtc(account_id: int, target_id: int, room: str) -> bool:
    """1:1 WebRTC 시그널 — 당사자 검증 + **차단만 아니면 허용**(2026-08-10 사용자 확정).

    예전에는 accepted 친구 사이에서만 허용했지만, '초대'(친구가 아니어도 대화·통화)가
    계약이 되면서 dm_allowed(차단 검사)로 바꿨다. room 문자열만 믿지 않고 두 ID가 실제
    당사자인지 함께 검증한다. SDP/ICE 내용은 열어 보지 않는다.
    """
    from app.models import Account

    with SessionLocal() as db:
        me = db.get(Account, account_id)
        return bool(
            me is not None
            and svc.dm_peer(room, account_id) == target_id
            and svc.dm_allowed(db, account_id, target_id)
        )


async def _announce_presence(account_id: int, friends: list[int], online: bool) -> None:
    """내 온·오프라인을 친구들에게만 알린다 — 전체 브로드캐스트는 하지 않는다."""
    if not friends:
        return
    await hub.send_many([f for f in friends if hub.is_online(f)],
                        {"t": "presence", "id": account_id, "online": online})


def _peer(websocket: WebSocket) -> str:
    """요청 출처 — 프록시 뒤라 X-Forwarded-For 가 실제 클라이언트다.
    거절 로그에서 "누가 계속 튕기는가" 를 가리는 유일한 단서라 함께 남긴다."""
    fwd = websocket.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()[:45]
    return (websocket.client.host if websocket.client else "?")[:45]


def _reject(websocket: WebSocket, stat: str, reason: str) -> dict:
    """거절 사실을 **남긴다**. 예전엔 조용히 close 만 해서, 왜 끊겼는지 사후에 알 길이
    전혀 없었다(사용자는 '연결이 안 된다'만 말하고 서버에는 아무 흔적도 없었다)."""
    detail = {"reason": stat, "at": _now_iso(), "ip": _peer(websocket),
              "ua": websocket.headers.get("user-agent", "")[:120]}
    hub.bump_stat(stat, detail)
    logger.warning("collab WS 거절 [%s] %s ip=%s", stat, reason, detail["ip"])
    return detail


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@router.websocket("/api/collab/ws")
async def collab_ws(websocket: WebSocket) -> None:
    user = ws_user(websocket)
    if user is None:
        # accept 전 close = 핸드셰이크 거부(HTTP 403). 브라우저에 자격증명이 되돌아가지 않는다.
        _reject(websocket, "rej_auth", "토큰 없음·만료(서브프로토콜 sv.bearer 미도달 포함)")
        await websocket.close(code=CLOSE_UNAUTHORIZED)
        return

    ctx = await run_in_threadpool(_sync_context, user)
    if ctx is None:
        _reject(websocket, "rej_account", f"협진 계정 행 없음 (sub={user.get('sub')})")
        await websocket.close(code=CLOSE_NO_ACCOUNT)
        return

    # 서브프로토콜을 반드시 echo 해야 브라우저가 핸드셰이크를 받아들인다
    await websocket.accept(subprotocol=WS_SUBPROTOCOL)
    # 🔴 여기까지 왔다 = 앞단(nginx)이 업그레이드를 통과시켰다는 **증거**다.
    #    이 값이 0 인데 REST 는 살아 있으면 프록시가 막고 있는 것이다(자가 점검의 근거).
    hub.bump_stat("accepted")

    aid: int = ctx["account_id"]
    friends: list[int] = list(ctx["friend_ids"])
    ok = hub.attach(websocket, account_id=aid, username=ctx["username"],
                    display_name=ctx["display_name"], hospital_id=ctx["hospital_id"],
                    role=ctx["role"])
    if not ok:
        _reject(websocket, "rej_limit", f"계정당 창 수 한도 초과 (account_id={aid})")
        await websocket.close(code=CLOSE_TOO_MANY)
        return

    # 이 창이 이 계정의 **첫** 협진 소켓인가 — 다중 모니터로 창을 3개 띄웠다고 친구들에게
    # '온라인' 이 세 번 갈 이유는 없다. attach 직후이므로 1이면 내가 첫 창이다.
    was_first = hub.socket_count_of(aid) == 1

    # cap → (만료시각, 제어권 리비전, 허용여부). 리비전이 있어야 **다른 소켓**에서 일어난
    # 제어권 승인·회수가 이 소켓에도 즉시 반영된다(collab_hub._ctl_rev 주석 참조).
    _ctl_cache: dict[str, tuple[float, int, bool]] = {}
    # (room, target) -> (만료시각, 허용). 친구 차단/삭제가 3초 안에 반영되도록 짧게 둔다.
    _dm_rtc_cache: dict[tuple[str, int], tuple[float, bool]] = {}

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
            if t in _STATE_RELAY_TYPES:
                code = hub.session_of(websocket)
                if not code:
                    continue
                # 화면을 움직일 수 있는 사람만 송출한다. 커서는 관전자도 허용한다.
                if t == "state" and not await _may_control(_ctl_cache, code, aid, "collab.viewport"):
                    continue
                payload = {"t": t, "from": aid, "d": msg.get("d")}
                await hub.send_session_socket(code, payload, exclude_ws=websocket)
                continue

            # WebRTC 시그널링 — 검사 협진 세션과 1:1 친구 DM 통화를 모두 지원한다.
            if t in _RTC_RELAY_TYPES:
                to = msg.get("to")
                if not isinstance(to, int) or to == aid:
                    continue
                room = str(msg.get("room") or "")
                # ⚠ 경로는 **프레임의 room** 으로 고른다(소켓의 세션 소속이 아니라).
                #   소켓 상태로 고르면, 협진 초대를 수락해 세션에 들어간 창에서는
                #   1:1 DM 통화 시그널이 전부 세션 분기로 빨려 들어가 조용히 버려진다 —
                #   워크리스트 창은 CollabGlobal 이 초대 수락 시 session.enter 를 보내므로
                #   그 창의 DM 음성·화상·화면공유가 새로고침 전까지 죽어 있었다.
                #   dm_peer 는 내가 그 DM 룸의 당사자일 때만 상대 id 를 준다(룸 위조 차단).
                if svc.dm_peer(room, aid) is not None:
                    key = (room, to)
                    now = time.monotonic()
                    cached = _dm_rtc_cache.get(key)
                    if cached is None or cached[0] <= now:
                        allowed = await run_in_threadpool(_can_relay_dm_rtc, aid, to, room)
                        _dm_rtc_cache[key] = (now + _CTL_TTL, allowed)
                    else:
                        allowed = cached[1]
                    if not allowed:
                        continue
                    payload = {"t": t, "from": aid, "d": msg.get("d"), "room": room}
                else:
                    # 검사 협진 세션 경로 — 같은 세션 참가자에게만. 세션 mesh 는 room 없이
                    # 보내고 room 없이 받으므로(webrtcMesh.signalRoom=null) payload 도 그대로.
                    code = hub.session_of(websocket)
                    if not code or to not in hub.session_members(code):
                        continue
                    payload = {"t": t, "from": aid, "d": msg.get("d")}
                await hub.send_to(to, payload)
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
                # 지금까지 그려진 세션 주석을 한 번에 — 늦게 들어와도 남들 작업이 다 보인다
                await websocket.send_json({"t": "anno.sync", "d": hub.annos(code)})
                await hub.broadcast_session(code, {"t": "joined", "id": aid, "d": res["session"]},
                                            exclude_account=aid)
                continue

            # ── 세션 주석 — 다학제의 핵심. 여러 명이 **동시에** 그린다 ──────────
            # DB 를 타지 않는다(허브 메모리). 그래서 고빈도여도 안전하고,
            # "세션 한정"(판독 기록의 책임 주체를 흐리지 않는다) 규정이 구조로 지켜진다.
            if t in ("anno.add", "anno.update", "anno.remove"):
                code = hub.session_of(websocket)
                if not code:
                    continue
                if not await _may_control(_ctl_cache, code, aid, "collab.annotate"):
                    await websocket.send_json(
                        {"t": "error", "detail": "주석 권한이 없습니다 — Master 에게 요청하세요"})
                    continue
                if t == "anno.add":
                    row = hub.anno_add(code, _clean_anno(msg.get("d")), aid)
                    if row is None:
                        await websocket.send_json(
                            {"t": "error", "detail": f"세션 주석이 상한({MAX_SESSION_ANNOS}건)을 넘었습니다"})
                        continue
                    out = {"t": "anno.add", "d": row}
                elif t == "anno.update":
                    row = hub.anno_update(code, str(msg.get("id") or ""),
                                          _clean_anno(msg.get("d")), aid)
                    if row is None:
                        continue          # 없거나 남의 것 — 조용히 무시(경합에서 흔하다)
                    out = {"t": "anno.update", "d": row}
                else:
                    if not hub.anno_remove(code, str(msg.get("id") or ""), aid):
                        continue
                    out = {"t": "anno.remove", "id": str(msg.get("id") or ""), "by": aid}
                # 발신 창까지 포함해 세션 전 소켓에 — 다중 모니터의 내 다른 창도 따라와야 한다
                await hub.send_session_socket(code, out)
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

            if t in ("ctl.request", "ctl.grant", "ctl.revoke", "ctl.take"):
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
        hub.bump_stat("closed")
    except Exception:  # noqa: BLE001 — 소켓 하나의 사고가 서버를 흔들면 안 된다
        hub.bump_stat("errors", {"reason": "errors", "at": _now_iso(),
                                 "ip": _peer(websocket), "ua": f"account_id={aid}"})
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
            elif kind == "ctl.take":
                p = svc.take_control(db, sess, me)
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
