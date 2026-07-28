"""WebPACS Live — 사용자별 A(webpacs_api) 세션 저장소 (per-user 로그인 키스톤).

요구사항: "그 서버의 로그인 계정으로 로그인" + "판독이 실제 판독의 이름으로 A DB 에 기록".
B 사용자가 자기 A 계정으로 로그인하면, 그 사용자의 A 토큰·신원(user_idx·이름·권한)을
sid(=B JWT 의 sid) 키로 여기 보관한다. Live 의 데이터/판독 호출은 이 세션의 A 토큰을 써서
**실제 판독의 A 계정**으로 A 에 접근·기록한다(이미지 검색은 서비스 계정 — <img> 인증 불가).

단일 프로세스 인메모리(기존 워커/presence 와 동일 모델). TTL 로 만료 정리.
"""
from __future__ import annotations

import threading
import time
from typing import Any

_SESSIONS: dict[str, dict[str, Any]] = {}   # sid → {base_url, token, refresh, a_user_id, a_user_idx, a_user_name, group_level, verify_ssl, ts}
_LOCK = threading.Lock()
_TTL = 60 * 60 * 12   # 12h — A refresh 토큰 유효기간(24h)보다 짧게, JWT 만료와 함께 정리


def put(sid: str, data: dict[str, Any]) -> None:
    if not sid:
        return
    with _LOCK:
        rec = dict(data)
        now = time.time()
        rec["ts"] = now
        # token_ts = **그 토큰을 받은 시각**. ts(마지막 접근)와 분리해서 들고 있어야
        # 공유 클라이언트가 '어느 쪽 토큰이 더 새 것인가'를 판정할 수 있다(webpacs_live.user_client).
        rec["token_ts"] = now
        _SESSIONS[sid] = rec
        _prune_locked()


def get(sid: str) -> dict[str, Any] | None:
    if not sid:
        return None
    with _LOCK:
        rec = _SESSIONS.get(sid)
        if rec is None:
            return None
        if time.time() - rec.get("ts", 0) > _TTL:
            del _SESSIONS[sid]
            return None
        return rec


def update_token(sid: str, token: str) -> None:
    """A 토큰 갱신(refresh 성공 시) — 세션에 최신 access 토큰 반영."""
    now = time.time()
    with _LOCK:
        rec = _SESSIONS.get(sid)
        if rec is not None:
            rec["token"] = token
            rec["token_ts"] = now
            rec["ts"] = now


def update_token_by_account(base_url: str, a_user_id: str, token: str) -> int:
    """같은 A 계정을 쓰는 **모든 활성 세션**에 새 토큰 반영. 반환: 갱신된 세션 수.

    왜 sid 하나가 아니라 계정 전체인가 — webpacs_live 의 per-user 클라이언트 풀은
    (base_url, a_user_id) 로 **공유**된다(A 는 계정당 단일 유효 토큰이라 그래야 401 폭풍이 없다).
    그런데 갱신 콜백을 '클라이언트를 처음 만든 sid' 에 못박아 두면, 나중에 같은 A 계정으로
    들어온 다른 창의 세션은 갱신을 영원히 못 받는다. 그 세션은 만료 토큰을 계속 들고 있다가
    매 요청마다 401+refresh 왕복을 내고, 공유 클라이언트에 그 옛 토큰을 되써 넣어
    두 창이 서로의 토큰을 밀어내는 왕복(=막으려던 401 폭풍)을 만든다.
    토큰은 계정 단위 자원이므로 반영도 계정 단위여야 한다.
    """
    a_user_id = str(a_user_id or "")
    now = time.time()
    n = 0
    with _LOCK:
        for rec in _SESSIONS.values():
            if rec.get("base_url") == base_url and str(rec.get("a_user_id") or "") == a_user_id:
                rec["token"] = token
                rec["token_ts"] = now
                rec["ts"] = now
                n += 1
    return n


def clear(sid: str) -> None:
    with _LOCK:
        _SESSIONS.pop(sid, None)


def _prune_locked() -> None:
    now = time.time()
    for k in [k for k, v in _SESSIONS.items() if now - v.get("ts", 0) > _TTL]:
        del _SESSIONS[k]
