"""협진 실시간 허브 — 인메모리 asyncio pub/sub (WebSocket 팬아웃).

왜 Redis 가 없나: 이 백엔드는 **단일 워커가 배포 계약**이다(app/services/worker_guard.py,
config.MULTI_WORKER_MESSAGE). 워커가 하나뿐이면 모든 WebSocket 이 같은 프로세스·같은
이벤트루프에 있으므로 프로세스 간 브로커가 필요 없다. 다중 워커로 가는 날엔 이 파일의
send_to/broadcast 두 함수만 브로커 발행으로 바꾸면 되도록 표면을 좁게 유지한다.

⚠ 이 모듈은 **DB 를 절대 만지지 않는다.** 순수 전송 계층이다.
  뷰어 상태 미러(state)·커서(cursor)는 초당 수십 건이 오가는 최고빈도 경로인데,
  여기서 DB 를 한 번이라도 태우면 그 부하가 그대로 판독 화면 지연이 된다.
  (같은 실수의 전례: 판독 도크 폴링이 스레드풀을 굶겨 서버가 통째로 먹통이 된 커밋 b64854f)

동시성 모델: 단일 이벤트루프이므로 async 함수 사이에 await 가 없는 구간은 원자적이다.
따라서 자료구조에 락을 걸지 않는다. 다만 send 는 await 하므로, 순회 중 dict 가 바뀌어도
안전하도록 **스냅샷(list(...))을 뜬 뒤** 보낸다.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger("saintview.collab")

# 한 계정이 동시에 열 수 있는 협진 소켓 수 상한.
# 이 스위트는 다중 모니터로 창을 여러 개 띄우는 것이 정상 사용이라 1 로 묶을 수 없다.
# 다만 무제한이면 창 누수·재연결 폭주가 그대로 메모리가 되므로 상한을 둔다.
MAX_SOCKETS_PER_ACCOUNT = 8


class CollabHub:
    def __init__(self) -> None:
        # account_id → 그 사용자의 살아있는 소켓들(창 여러 개 = 소켓 여러 개)
        self._by_account: dict[int, set[WebSocket]] = {}
        # 소켓 → 신원·소속 세션 (끊길 때 역참조로 정리하기 위해)
        self._meta: dict[WebSocket, dict[str, Any]] = {}
        # 세션 code → 참가 중인 account_id 집합
        self._sessions: dict[str, set[int]] = {}
        # 세션 code → 제어권 변경 리비전. 소켓들이 각자 들고 있는 '내가 지금 화면을 움직일 수
        # 있나' 캐시를 **한꺼번에** 무효화하기 위한 값이다.
        #
        # 왜 필요한가: 제어권 승인은 Master 의 소켓이 처리하는데, 그 결과를 알아야 하는 것은
        # 게스트의 소켓이다. 캐시를 소켓 안에만 두면 게스트 쪽이 "나는 제어권 없음"을 TTL 만큼
        # 계속 믿어서, 승인 직후 몇 초간 화면 조작이 먹지 않는다(실제로 테스트가 이걸 잡았다).
        self._ctl_rev: dict[str, int] = {}

    # ── 연결 수명 ────────────────────────────────────────────────────────────
    def attach(self, ws: WebSocket, *, account_id: int, username: str,
               display_name: str, hospital_id: int | None, role: str) -> bool:
        """소켓 등록. 상한 초과면 False(호출부가 정책 코드로 닫는다)."""
        socks = self._by_account.setdefault(account_id, set())
        if len(socks) >= MAX_SOCKETS_PER_ACCOUNT:
            return False
        socks.add(ws)
        self._meta[ws] = {
            "account_id": account_id, "username": username, "display_name": display_name,
            "hospital_id": hospital_id, "role": role, "session": None,
        }
        return True

    def detach(self, ws: WebSocket) -> dict[str, Any] | None:
        """소켓 해제 → 그 소켓의 meta 반환(없으면 None). 세션 참가도 함께 정리한다."""
        meta = self._meta.pop(ws, None)
        if meta is None:
            return None
        aid = meta["account_id"]
        socks = self._by_account.get(aid)
        if socks is not None:
            socks.discard(ws)
            if not socks:
                self._by_account.pop(aid, None)
        code = meta.get("session")
        # 같은 계정의 **다른 창**이 아직 그 세션에 있으면 세션 참가는 유지한다
        if code and not self._account_in_session(aid, code):
            members = self._sessions.get(code)
            if members is not None:
                members.discard(aid)
                if not members:
                    self._sessions.pop(code, None)
        return meta

    def _account_in_session(self, account_id: int, code: str) -> bool:
        return any(m.get("session") == code
                   for ws, m in self._meta.items() if m["account_id"] == account_id)

    # ── 프레즌스 ─────────────────────────────────────────────────────────────
    def is_online(self, account_id: int) -> bool:
        return bool(self._by_account.get(account_id))

    def online_ids(self) -> set[int]:
        return set(self._by_account.keys())

    def socket_count_of(self, account_id: int) -> int:
        """그 계정이 지금 열어 둔 협진 소켓 수 — 다중 모니터라 1보다 클 수 있다.

        프레즌스 고지를 창 개수만큼 중복해 보내지 않기 위한 판정에 쓴다
        (첫 창에서만 '온라인', 마지막 창이 닫힐 때만 '오프라인').
        """
        return len(self._by_account.get(account_id, ()))

    # ── 세션 멤버십 ──────────────────────────────────────────────────────────
    def join_session(self, ws: WebSocket, code: str) -> None:
        meta = self._meta.get(ws)
        if meta is None:
            return
        prev = meta.get("session")
        if prev and prev != code:
            self.leave_session(ws)
        meta["session"] = code
        self._sessions.setdefault(code, set()).add(meta["account_id"])

    def leave_session(self, ws: WebSocket) -> str | None:
        meta = self._meta.get(ws)
        if meta is None:
            return None
        code = meta.get("session")
        meta["session"] = None
        if not code:
            return None
        if not self._account_in_session(meta["account_id"], code):
            members = self._sessions.get(code)
            if members is not None:
                members.discard(meta["account_id"])
                if not members:
                    self._sessions.pop(code, None)
        return code

    def session_members(self, code: str) -> set[int]:
        return set(self._sessions.get(code, ()))

    def control_rev(self, code: str) -> int:
        return self._ctl_rev.get(code, 0)

    def bump_control(self, code: str) -> int:
        """제어권이 바뀌었다 — 이 세션의 모든 소켓 캐시를 무효화한다."""
        rev = self._ctl_rev.get(code, 0) + 1
        self._ctl_rev[code] = rev
        return rev

    def session_of(self, ws: WebSocket) -> str | None:
        meta = self._meta.get(ws)
        return meta.get("session") if meta else None

    def drop_session(self, code: str) -> set[int]:
        """세션 종료 — 멤버십만 비우고 소켓은 살려 둔다(사용자는 계속 로그인 상태다)."""
        members = self._sessions.pop(code, set())
        self._ctl_rev.pop(code, None)
        for meta in self._meta.values():
            if meta.get("session") == code:
                meta["session"] = None
        return members

    # ── 발신 ─────────────────────────────────────────────────────────────────
    async def _send(self, ws: WebSocket, payload: dict) -> bool:
        try:
            await ws.send_json(payload)
            return True
        except Exception:  # noqa: BLE001 — 끊긴 소켓 하나가 팬아웃 전체를 죽이면 안 된다
            logger.debug("collab 소켓 발신 실패(무시)", exc_info=True)
            return False

    async def send_to(self, account_id: int, payload: dict) -> int:
        """한 사용자의 모든 창에 발신 → 성공한 소켓 수."""
        n = 0
        for ws in list(self._by_account.get(account_id, ())):
            if await self._send(ws, payload):
                n += 1
        return n

    async def send_many(self, account_ids, payload: dict) -> int:
        n = 0
        for aid in list(account_ids):
            n += await self.send_to(aid, payload)
        return n

    async def broadcast_session(self, code: str, payload: dict,
                                exclude_account: int | None = None) -> int:
        """세션 참가자 전원에게. exclude_account 는 보통 발신자 자신(에코 방지)."""
        n = 0
        for aid in list(self._sessions.get(code, ())):
            if aid == exclude_account:
                continue
            n += await self.send_to(aid, payload)
        return n

    async def send_session_socket(self, code: str, payload: dict,
                                  exclude_ws: WebSocket | None = None) -> int:
        """세션 참가 **소켓** 단위 발신 — 같은 계정의 다른 창에도 보내되 발신 창만 뺀다.

        뷰어 상태 미러에 쓴다: 제어자가 모니터 2대를 쓰면 자기 두 번째 창도 따라와야 한다.
        """
        n = 0
        for ws, meta in list(self._meta.items()):
            if meta.get("session") != code or ws is exclude_ws:
                continue
            if await self._send(ws, payload):
                n += 1
        return n


hub = CollabHub()
