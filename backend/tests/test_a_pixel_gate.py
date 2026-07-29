"""원격 A 픽셀 취득 동시 상한 — 로그인·health 를 굶기지 않는다.

실제로 난 사고: sv70 에서 정적 페이지는 200 인데 /api/health 와 로그인만 무응답이었다.
백엔드는 살아 있었다(라우팅 단계에서 끝나는 404·405 는 즉답). **핸들러가 실제로 도는 요청만**
멈췄다 — anyio 스레드풀(단일 워커, sync 핸들러)이 A 를 기다리는 픽셀 요청으로 꽉 찬 것이다.
프레임 하나가 최대 60초씩 스레드를 쥐고, 브라우저를 닫아도 서버 쪽 요청은 타임아웃을
다 채우므로 먹통이 그 뒤까지 이어졌다.

그래서 계약은 둘이다:
  ① A 원격 취득의 동시 실행 수는 상한을 넘지 않는다(= 스레드풀에 여유가 남는다)
  ② 캐시 적중 경로는 상한과 무관하다(있는 걸 꺼내면서 기다리면 안 된다)
"""
from __future__ import annotations

import threading
import time

import pytest

from app.services import webpacs_live as live
from app.services.webpacs_bridge import WebPacsError


@pytest.fixture()
def gate(monkeypatch):
    """상한 3 · 대기 0.3초로 좁혀 재현을 빠르게."""
    monkeypatch.setattr(live, "_a_gate", threading.BoundedSemaphore(3))
    monkeypatch.setattr(live, "_A_GATE_WAIT", 0.3)
    return 3


def test_concurrent_remote_fetches_never_exceed_the_cap(gate):
    """동시에 몰려도 A 를 동시에 때리는 수는 상한을 넘지 않는다."""
    peak = 0
    now = 0
    lock = threading.Lock()
    release = threading.Event()

    def worker():
        nonlocal peak, now
        with live.a_pixel_slot():
            with lock:
                now += 1
                peak = max(peak, now)
            release.wait(2)
            with lock:
                now -= 1

    ts = [threading.Thread(target=worker, daemon=True) for _ in range(12)]
    for t in ts:
        t.start()
    time.sleep(0.15)          # 상한만큼 들어가고 나머지는 대기하도록
    got = peak
    release.set()
    for t in ts:
        t.join(3)
    assert got <= gate, f"동시 원격 취득이 상한을 넘었다: {got} > {gate}"


def test_slot_gives_up_instead_of_holding_a_thread_forever(gate):
    """슬롯을 못 얻으면 **빠르게 실패**한다 — 무한 대기는 스레드를 쥐는 것과 같다."""
    hold = threading.Event()
    started = threading.Barrier(gate + 1)

    def holder():
        with live.a_pixel_slot():
            started.wait(2)
            hold.wait(3)

    for _ in range(gate):
        threading.Thread(target=holder, daemon=True).start()
    started.wait(2)           # 상한만큼 점유된 상태

    t0 = time.monotonic()
    with pytest.raises(WebPacsError):
        with live.a_pixel_slot():
            pass
    waited = time.monotonic() - t0
    hold.set()
    # _A_GATE_WAIT(0.3초) 언저리에서 포기해야 한다 — 60초를 기다리면 그게 사고의 원인이다
    assert waited < 2.0, f"포기까지 {waited:.1f}초 — 너무 오래 스레드를 쥔다"


def test_cache_hit_does_not_touch_the_gate(gate, tmp_path, monkeypatch):
    """이미 받아 둔 프레임은 상한과 무관하게 즉시 나온다."""
    monkeypatch.setattr(live, "CACHE_DIR", tmp_path)
    sop = "1.2.3.cached"
    live._cache_path(sop).write_bytes(b"DICM-cached")   # noqa: SLF001

    blocked = threading.Event()

    def hog():
        with live.a_pixel_slot():
            blocked.wait(3)

    for _ in range(gate):     # 슬롯을 전부 점유
        threading.Thread(target=hog, daemon=True).start()
    time.sleep(0.15)

    class Boom:
        def instance_dicom(self, *a, **k):
            raise AssertionError("캐시 적중인데 원격을 호출했다")

    t0 = time.monotonic()
    got = live.get_instance_bytes(Boom(), "s", "se", sop)
    waited = time.monotonic() - t0
    blocked.set()
    assert got == b"DICM-cached"
    assert waited < 0.2, f"캐시 적중인데 {waited:.2f}초 기다렸다 — 상한이 잘못 걸려 있다"
