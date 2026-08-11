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

# 세션 주석 상한 — 검사당 500개인 DB 주석 상한(worklist.put_annotations)과 같은 값.
# 세션 주석은 메모리에만 있으므로 상한이 없으면 긴 다학제 한 번이 그대로 누수가 된다.
MAX_SESSION_ANNOS = 500


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
        # 세션 code → 세션 주석 목록. **메모리에만 있고 DB 에 절대 안 간다** —
        # 그것이 "세션 한정"(판독 기록의 책임 주체를 흐리지 않는다) 규정의 실체다.
        # Master 가 [채택] 한 것만 별도로 정식 Annotation 으로 저장된다.
        self._annos: dict[str, list[dict[str, Any]]] = {}
        # 세션 code → 주석 id 시퀀스. DB 를 안 쓰므로 여기서 발번한다.
        self._anno_seq: dict[str, int] = {}
        # ── 연결 통계 (프로세스 시작 이후 누적) ──────────────────────────────
        # 🔴 진단의 핵심 증거다: **REST 는 되는데 accepted 가 0** 이면 WebSocket 요청이
        #    백엔드에 도달조차 못 한 것이다 = 앞단(nginx)이 업그레이드를 막고 있다.
        #    이 값이 없으면 "로그를 봐도 아무 일도 없었다" 로만 보인다(실제로 그랬다).
        self._stat: dict[str, int] = {
            "accepted": 0,      # 핸드셰이크 성립
            "rej_auth": 0,      # 4401 토큰 없음·만료
            "rej_account": 0,   # 4403 협진 계정 행 없음
            "rej_limit": 0,     # 4429 창 수 한도
            "closed": 0,        # 정상 종료
            "errors": 0,        # 처리 중 예외
        }
        self._last_reject: list[dict[str, Any]] = []   # 최근 거절 몇 건(원인 추적용)

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

    # ── 세션 주석 (메모리 전용) ──────────────────────────────────────────────
    def annos(self, code: str) -> list[dict[str, Any]]:
        """이 세션의 주석 전체 — 참가 직후 anno.sync 로 한 번에 내려 준다."""
        return list(self._annos.get(code, ()))

    def anno_add(self, code: str, item: dict[str, Any], by: int) -> dict[str, Any] | None:
        """주석 1건 추가 → 서버가 확정한 항목(없으면 상한 초과로 None).

        ⚠ id 와 by 는 **서버가 박는다.** 클라가 보낸 값은 버린다 — 안 그러면 남의 id 로
          주석을 그려 놓을 수 있고(사칭), 그 색이 그 사람 색으로 나가서 오해가 된다.
        """
        rows = self._annos.setdefault(code, [])
        if len(rows) >= MAX_SESSION_ANNOS:
            return None
        seq = self._anno_seq.get(code, 0) + 1
        self._anno_seq[code] = seq
        row = {**item, "id": f"s{seq}", "by": by}
        rows.append(row)
        return row

    def anno_update(self, code: str, anno_id: str, item: dict[str, Any], by: int
                    ) -> dict[str, Any] | None:
        """주석 수정 → 확정 항목. **자기가 그린 것만** 고칠 수 있다(없거나 남의 것이면 None)."""
        for i, r in enumerate(self._annos.get(code, ())):
            if r.get("id") != anno_id:
                continue
            if r.get("by") != by:
                return None
            row = {**item, "id": anno_id, "by": by}
            self._annos[code][i] = row
            return row
        return None

    def anno_remove(self, code: str, anno_id: str, by: int, force: bool = False) -> bool:
        """주석 삭제 — 자기 것만(force=True 는 Master 가 정리할 때)."""
        rows = self._annos.get(code)
        if not rows:
            return False
        for i, r in enumerate(rows):
            if r.get("id") != anno_id:
                continue
            if not force and r.get("by") != by:
                return False
            rows.pop(i)
            return True
        return False

    def annos_of(self, code: str, account_id: int) -> list[dict[str, Any]]:
        """한 사람이 그린 것만 — Master 의 [채택] 이 이 목록을 DB 로 옮긴다."""
        return [r for r in self._annos.get(code, ()) if r.get("by") == account_id]

    # ── 연결 통계 ────────────────────────────────────────────────────────────
    MAX_REJECT_LOG = 30      # 최근 거절만 남긴다 — 무한히 쌓으면 그것도 누수다

    def bump_stat(self, key: str, detail: dict[str, Any] | None = None) -> None:
        """WS 수락·거절 카운트. detail 이 있으면 최근 거절 목록에도 남긴다."""
        if key in self._stat:
            self._stat[key] += 1
        if detail is not None:
            self._last_reject.append(detail)
            if len(self._last_reject) > self.MAX_REJECT_LOG:
                del self._last_reject[: len(self._last_reject) - self.MAX_REJECT_LOG]

    def stats(self) -> dict[str, Any]:
        """자가 점검용 스냅샷. accepted==0 인데 REST 가 살아 있으면 앞단이 막고 있는 것이다."""
        return {
            **self._stat,
            "sockets": len(self._meta),
            "accounts": len(self._by_account),
            "recent_rejects": list(self._last_reject),
        }

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
        """세션 종료 — 멤버십만 비우고 소켓은 살려 둔다(사용자는 계속 로그인 상태다).

        세션 주석도 여기서 사라진다. "세션 한정" 이 지켜지는 지점이다 —
        Master 가 [채택] 한 것은 이미 DB 로 옮겨졌고, 나머지는 남지 않는다.
        """
        members = self._sessions.pop(code, set())
        self._ctl_rev.pop(code, None)
        self._annos.pop(code, None)
        self._anno_seq.pop(code, None)
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
