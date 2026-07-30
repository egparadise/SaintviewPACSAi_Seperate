"""판독 상태 조회(live_state) — **A 왕복을 접되, 실시간이어야 할 것은 절대 캐시하지 않는다.**

실제 증상(sv70): "프로그램이 갑자기 먹통. 영상도 못 열고 로그아웃 후 재로그인도 안 된다.
한참 뒤에는 다시 된다." 원인 중 가장 큰 것이 이 함수였다 —

  · 판독 도크가 창마다 **5초 간격**으로 이 상태를 묻는다
  · live_state 는 A 를 **동기 2회**(study_detail + report_get) 부른다
  · 핸들러는 sync 라 요청 하나가 anyio 스레드(기본 40)를 통째로 쥔다
  · 어떤 상한도 없었다

A 응답이 T 초일 때 창당 상시 점유 = 2T/5. T 가 25초면 창 4개로 스레드풀 40이 찬다.
그러면 DB 도 안 쓰는 로그인이 큐 뒤에서 굶는다.

■ 캐시가 넘지 말아야 할 선
'지금 누가 판독문을 입력 중인가'는 **캐시하면 안 된다.** 경고가 늦으면 두 사람이 같은
검사를 덮어쓴다. A 에서 온 검사상태·판독문 메타만 접는다.
"""
from __future__ import annotations

import threading
import time

import pytest

from app.services import webpacs_live as live


class FakeClient:
    """A 호출 횟수를 세는 가짜 클라이언트."""

    def __init__(self, base_url: str = "https://a.example", delay: float = 0.0):
        self.base_url = base_url
        self.delay = delay
        self.detail_calls = 0
        self.report_calls = 0
        self._lock = threading.Lock()

    def study_detail(self, idx):
        with self._lock:
            self.detail_calls += 1
        time.sleep(self.delay)
        return {"study_status": "R", "user_idx": 1}

    def report_get(self, idx):
        with self._lock:
            self.report_calls += 1
        time.sleep(self.delay)
        return {"report_status": "R", "report_update_datetime": "2026-07-30 10:00:00"}


@pytest.fixture(autouse=True)
def _clean():
    live.invalidate_live_state()
    yield
    live.invalidate_live_state()


def test_concurrent_polls_hit_a_only_once(monkeypatch):
    """여러 창이 동시에 물어도 A 왕복은 **한 번**. 이것이 스레드풀을 살린다."""
    c = FakeClient(delay=0.05)
    monkeypatch.setattr(live, "live_client", lambda db, user=None: c)
    monkeypatch.setattr(live, "_report_typers_of", lambda vid, exclude="": [])
    monkeypatch.setattr(live, "has_user_a_session", lambda u: False)
    monkeypatch.setattr(live, "_bridge_user_idx", lambda db: 1)

    errs = []

    def poll():
        try:
            live.live_state(None, live.to_vid(7))
        except Exception as e:  # noqa: BLE001
            errs.append(e)

    ts = [threading.Thread(target=poll) for _ in range(10)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(10)

    assert not errs, errs
    assert c.detail_calls == 1, f"study_detail 이 {c.detail_calls}회 — 단일비행이 안 걸렸다"
    assert c.report_calls == 1, f"report_get 이 {c.report_calls}회 — 단일비행이 안 걸렸다"


def test_typing_signal_is_never_cached(monkeypatch):
    """★ 캐시가 넘지 말아야 할 선 — '다른 사람이 입력 중' 은 즉시 뒤집혀야 한다.

    이것이 늦으면 두 판독의가 같은 검사를 덮어쓴다. 되돌리면 이 테스트가 깨진다.
    """
    c = FakeClient()
    monkeypatch.setattr(live, "live_client", lambda db, user=None: c)
    monkeypatch.setattr(live, "has_user_a_session", lambda u: False)
    monkeypatch.setattr(live, "_bridge_user_idx", lambda db: 1)

    typers: list[str] = []
    monkeypatch.setattr(live, "_report_typers_of", lambda vid, exclude="": list(typers))

    vid = live.to_vid(8)
    assert live.live_state(None, vid)["other_writing"] is False

    typers.append("kim")                      # 방금 다른 사람이 입력을 시작했다
    out = live.live_state(None, vid)          # TTL 안이지만
    assert out["other_writing"] is True, "입력 중 신호가 캐시에 묻혔다 — 판독 충돌 위험"
    assert out["other_writers"] == ["kim"]
    assert c.detail_calls == 1, "A 는 여전히 한 번만 (캐시는 살아 있어야 한다)"


def test_cache_key_includes_base_url(monkeypatch):
    """A 서버가 다르면 캐시를 공유하지 않는다 — 남의 서버 상태가 나오면 안 된다."""
    a = FakeClient("https://a1.example")
    b = FakeClient("https://a2.example")
    cur = {"c": a}
    monkeypatch.setattr(live, "live_client", lambda db, user=None: cur["c"])
    monkeypatch.setattr(live, "_report_typers_of", lambda vid, exclude="": [])
    monkeypatch.setattr(live, "has_user_a_session", lambda u: False)
    monkeypatch.setattr(live, "_bridge_user_idx", lambda db: 1)

    vid = live.to_vid(9)
    live.live_state(None, vid)
    cur["c"] = b
    live.live_state(None, vid)
    assert a.detail_calls == 1 and b.detail_calls == 1, "다른 A 서버인데 캐시를 공유했다"


def test_ttl_expiry_refetches(monkeypatch):
    """TTL 이 지나면 다시 묻는다."""
    c = FakeClient()
    monkeypatch.setattr(live, "live_client", lambda db, user=None: c)
    monkeypatch.setattr(live, "_report_typers_of", lambda vid, exclude="": [])
    monkeypatch.setattr(live, "has_user_a_session", lambda u: False)
    monkeypatch.setattr(live, "_bridge_user_idx", lambda db: 1)
    monkeypatch.setattr(live, "_STATE_TTL", 0.0)

    vid = live.to_vid(10)
    live.live_state(None, vid)
    live.live_state(None, vid)
    assert c.detail_calls == 2


def test_invalidate_makes_my_own_change_visible_at_once(monkeypatch):
    """내가 저장·선점한 직후에는 3초를 기다리지 않는다."""
    c = FakeClient()
    monkeypatch.setattr(live, "live_client", lambda db, user=None: c)
    monkeypatch.setattr(live, "_report_typers_of", lambda vid, exclude="": [])
    monkeypatch.setattr(live, "has_user_a_session", lambda u: False)
    monkeypatch.setattr(live, "_bridge_user_idx", lambda db: 1)

    vid = live.to_vid(11)
    live.live_state(None, vid)
    assert c.detail_calls == 1
    live.invalidate_live_state(vid)
    live.live_state(None, vid)
    assert c.detail_calls == 2, "무효화 후에도 캐시가 남았다"


def test_cache_is_bounded(monkeypatch):
    """검사를 계속 열어도 캐시가 무한정 자라지 않는다."""
    c = FakeClient()
    monkeypatch.setattr(live, "live_client", lambda db, user=None: c)
    monkeypatch.setattr(live, "_report_typers_of", lambda vid, exclude="": [])
    monkeypatch.setattr(live, "has_user_a_session", lambda u: False)
    monkeypatch.setattr(live, "_bridge_user_idx", lambda db: 1)

    for i in range(live._STATE_MAX + 20):          # noqa: SLF001
        live.live_state(None, live.to_vid(1000 + i))
    assert len(live._STATE_CACHE) <= live._STATE_MAX     # noqa: SLF001
