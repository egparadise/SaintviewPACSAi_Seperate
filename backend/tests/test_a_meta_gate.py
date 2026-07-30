"""A 조회 상한(a_meta_slot) — 픽셀·프리뷰와 **다른 게이트**여야 한다.

게이트를 하나로 합치면 우선순위가 뒤집힌다: 판독 도크 폴링(5초마다, 창마다)이
판독의가 지금 기다리는 본 영상 취득을 밀어낸다. 그래서 세 개를 따로 둔다.

  픽셀 12(본 영상) · 프리뷰 8(썸네일) · 메타 8(조회)  = 28 < 스레드풀 40
  남는 12 는 로그인·health 몫으로 항상 비워 둔다 — 이 여유가 없어서 로그인이 굶었다.
"""
from __future__ import annotations

import threading
import time

import pytest

from app.services import webpacs_live as live
from app.services.webpacs_live import WebPacsError


def test_three_gates_are_separate_semaphores():
    """★ 설계 원칙 고정 — 합치는 회귀를 막는다."""
    gates = [live._a_gate, live._a_preview_gate, live._a_meta_gate]   # noqa: SLF001
    assert len({id(g) for g in gates}) == 3, "게이트가 합쳐졌다 — 폴링이 본 영상을 밀어낸다"


def test_gate_budget_leaves_room_for_login():
    """세 게이트 합이 스레드풀(40)보다 작아야 로그인·health 가 굶지 않는다."""
    total = live._A_SLOTS + live._A_PREVIEW_SLOTS + live._A_META_SLOTS   # noqa: SLF001
    assert total < 40, f"게이트 합 {total} — 스레드풀을 다 쓰면 로그인 몫이 없다"
    assert 40 - total >= 8, f"여유 {40 - total} — 로그인·health 에 너무 빠듯하다"


def test_meta_fetches_never_exceed_cap(monkeypatch):
    monkeypatch.setattr(live, "_a_meta_gate", threading.BoundedSemaphore(3))
    monkeypatch.setattr(live, "_A_META_WAIT", 5.0)
    live_count, peak = [0], [0]
    lock = threading.Lock()

    def work():
        with live.a_meta_slot():
            with lock:
                live_count[0] += 1
                peak[0] = max(peak[0], live_count[0])
            time.sleep(0.03)
            with lock:
                live_count[0] -= 1

    ts = [threading.Thread(target=work) for _ in range(12)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(10)
    assert peak[0] <= 3, f"동시 {peak[0]} — 상한 3 을 넘었다"


def test_meta_gate_gives_up_fast(monkeypatch):
    """못 얻으면 기다리지 않고 접는다 — 스레드를 놓아 줘야 한다."""
    monkeypatch.setattr(live, "_a_meta_gate", threading.BoundedSemaphore(1))
    monkeypatch.setattr(live, "_A_META_WAIT", 0.05)
    t0 = time.time()
    with live.a_meta_slot():
        with pytest.raises(WebPacsError):
            with live.a_meta_slot():
                pytest.fail("상한을 넘어 슬롯이 발급됐다")
    assert time.time() - t0 < 2, "포기가 너무 느리다 — 스레드를 오래 쥔다"


def test_meta_gate_does_not_starve_pixels(monkeypatch):
    """★ 조회가 몰려도 **본 영상 취득은 즉시** 슬롯을 얻는다."""
    monkeypatch.setattr(live, "_a_meta_gate", threading.BoundedSemaphore(1))
    monkeypatch.setattr(live, "_A_META_WAIT", 0.05)
    with live.a_meta_slot():                    # 메타 슬롯을 전부 점유
        t0 = time.time()
        with live.a_pixel_slot():               # 진단 경로는 막히면 안 된다
            pass
        assert time.time() - t0 < 0.5, "조회가 본 영상 취득을 막고 있다"


def test_caller_can_wait_longer_for_interactive_paths(monkeypatch):
    """뷰어 오픈처럼 사람이 기다리는 것은 더 오래 줄을 설 수 있어야 한다."""
    monkeypatch.setattr(live, "_a_meta_gate", threading.BoundedSemaphore(1))
    monkeypatch.setattr(live, "_A_META_WAIT", 0.02)
    released = threading.Event()

    def holder():
        with live.a_meta_slot():
            time.sleep(0.15)
        released.set()

    th = threading.Thread(target=holder)
    th.start()
    time.sleep(0.02)
    with live.a_meta_slot(wait=5.0):            # 명시 대기 → 기다렸다가 얻는다
        pass
    th.join(5)
    assert released.is_set()
