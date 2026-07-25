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
        rec["ts"] = time.time()
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
    with _LOCK:
        rec = _SESSIONS.get(sid)
        if rec is not None:
            rec["token"] = token
            rec["ts"] = time.time()


def clear(sid: str) -> None:
    with _LOCK:
        _SESSIONS.pop(sid, None)


def _prune_locked() -> None:
    now = time.time()
    for k in [k for k, v in _SESSIONS.items() if now - v.get("ts", 0) > _TTL]:
        del _SESSIONS[k]
