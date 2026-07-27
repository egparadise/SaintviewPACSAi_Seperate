"""WebPACS Live — A 서버 SSE(`GET /see/stream`) 구독으로 변경을 즉시 감지.

A 는 이미 SSE 를 제공한다(`app/router/SeeEvent.py`, 1초 주기):
  - `message`(id=link_update)  : 검사 상태·응급 변경 (pacs_study_link 트리거 기반)
  - `report_update`            : 판독 변경된 검사 행 전체

우리(B)는 이 스트림을 **백엔드에서 한 번만** 구독하고, 마지막 변경 시각(epoch)을 메모리에
기록한다. 프론트는 폴링 대신 이 값만 보고 "바뀐 게 있을 때만" 실제 데이터를 다시 읽는다.
→ 5초 고정 폴링 대비 (a) 변경 즉시 반영(≤1s) (b) 무변경 시 A 부하 0.

⚠ A 서버 수정은 전혀 필요 없다. 우리가 구독만 하면 된다.
SSE 연결이 끊기거나 A 가 구버전(엔드포인트 없음)이면 자동으로 폴링 폴백으로 돌아간다.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any

import httpx

logger = logging.getLogger("saintview.webpacs_sse")

# 변경 신호 — 프론트가 이 값(rev)이 바뀔 때만 재조회한다
_state: dict[str, Any] = {
    "connected": False,      # SSE 연결 상태(False 면 프론트는 폴링 폴백)
    "rev": 0,                # 변경 카운터(증가할 때마다 재조회 신호)
    "last_event_at": 0.0,    # 마지막 이벤트 수신 시각
    "changed_studies": [],   # 최근 변경된 A study_idx (최대 200)
    "error": "",
}
_lock = threading.Lock()
_thread: threading.Thread | None = None
_stop = threading.Event()


def sse_status() -> dict[str, Any]:
    with _lock:
        return dict(_state)


def _bump(study_idxs: list[int]) -> None:
    with _lock:
        _state["rev"] += 1
        _state["last_event_at"] = time.time()
        if study_idxs:
            merged = (_state["changed_studies"] + study_idxs)[-200:]
            _state["changed_studies"] = merged


def _extract_idxs(payload: str) -> list[int]:
    """이벤트 data(JSON 배열)에서 study_idx 수집 — 형태가 배포본마다 달라 방어적으로."""
    out: list[int] = []
    try:
        rows = json.loads(payload)
        if isinstance(rows, dict):
            rows = [rows]
        for r in rows or []:
            v = (r or {}).get("study_idx")
            if v is not None:
                out.append(int(v))
    except Exception:  # noqa: BLE001 — 파싱 실패는 '변경 있음'만으로 충분
        pass
    return out


def _run(base_url: str, token_provider) -> None:
    """SSE 수신 루프 — 끊기면 백오프 재연결. token_provider() 로 최신 A 토큰 획득."""
    backoff = 1.0
    while not _stop.is_set():
        try:
            headers = {"Accept": "text/event-stream"}
            tok = token_provider()
            if tok:
                headers["Authorization"] = f"Bearer {tok}"
            with httpx.Client(base_url=base_url, timeout=httpx.Timeout(10.0, read=None)) as c:
                with c.stream("GET", "/see/stream", headers=headers) as r:
                    if r.status_code != 200:
                        raise RuntimeError(f"SSE HTTP {r.status_code}")
                    with _lock:
                        _state["connected"] = True
                        _state["error"] = ""
                    logger.info("WebPACS SSE 연결됨 (%s/see/stream)", base_url)
                    backoff = 1.0
                    event, data = "", ""
                    for line in r.iter_lines():
                        if _stop.is_set():
                            break
                        if line.startswith("event:"):
                            event = line[6:].strip()
                        elif line.startswith("data:"):
                            data += line[5:].strip()
                        elif line == "":          # 이벤트 경계
                            if data:
                                _bump(_extract_idxs(data))
                            event, data = "", ""
        except Exception as e:  # noqa: BLE001 — 어떤 실패든 폴백+재연결
            with _lock:
                _state["connected"] = False
                _state["error"] = str(e)[:200]
            if not _stop.is_set():
                _stop.wait(backoff)
                backoff = min(backoff * 2, 30.0)
    with _lock:
        _state["connected"] = False


def start_sse(base_url: str, token_provider) -> bool:
    """SSE 구독 시작(이미 돌고 있으면 무시). 반환: 새로 시작했는지."""
    global _thread
    if _thread is not None and _thread.is_alive():
        return False
    _stop.clear()
    _thread = threading.Thread(target=_run, args=(base_url, token_provider),
                               name="webpacs-sse", daemon=True)
    _thread.start()
    return True


def stop_sse() -> None:
    _stop.set()


def ensure_sse(db) -> dict[str, Any]:
    """설정이 Live 사용 중이면 SSE 를 보장 기동하고 현재 상태를 반환(프론트 폴링 진입점)."""
    from app.services.webpacs_bridge import get_bridge_config
    from app.services.webpacs_live import service_client

    cfg = get_bridge_config(db)
    if not cfg.get("enabled") or not cfg.get("base_url"):
        return {**sse_status(), "enabled": False}

    def _token():
        try:
            cli = service_client(db)
            cli._ensure_token()       # noqa: SLF001 — 내부 토큰 확보(없으면 로그인)
            return cli._token         # noqa: SLF001
        except Exception:  # noqa: BLE001
            return None

    start_sse(str(cfg["base_url"]).rstrip("/"), _token)
    return {**sse_status(), "enabled": True}
