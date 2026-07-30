"""원격/인코딩 동시 상한 — **스레드풀이 차서 로그인이 굶는 일**이 다시 없게 고정한다.

실제로 sv70 에서 났다: 정적 페이지는 뜨는데 `/api/health` 가 타임아웃하고 로그인이 안 됐다.
백엔드는 단일 워커고 픽셀 핸들러는 sync 라 anyio 스레드풀(기본 40)에서 돈다. A 가 느려지면
요청 하나가 수십 초씩 스레드를 쥐고, 뷰어는 타일마다 요청을 날리므로 풀이 통째로 찬다.

그때 `a_pixel_slot`(원본 DICOM 취득)만 막았고 **두 경로가 빠져 있었다**:
  · 미리보기·썸네일 (webpacs_live.preview_bytes) — 오히려 이쪽이 요청이 더 많다
  · HTJ2K 온디맨드 인코딩 (api/htj2k_stream.get_frame) — Node 서브프로세스까지 띄운다

계약: 세 경로 모두 상한이 있고, 못 얻으면 **기다리지 않고 접는다**(스레드를 놓아 준다).
"""
from __future__ import annotations

import threading

import pytest

from app.api import htj2k_stream as hs
from app.services import webpacs_live as live
from app.services.webpacs_live import WebPacsError


def test_preview_gate_exists_and_is_smaller_than_threadpool():
    """미리보기 상한이 있어야 하고, 스레드풀(40)보다 확실히 작아야 한다."""
    assert live._A_PREVIEW_SLOTS >= 1                     # noqa: SLF001
    assert live._A_PREVIEW_SLOTS < 40, "스레드풀만큼 크면 상한이 아무 의미가 없다"  # noqa: SLF001
    # 진단 경로와 **다른** 세마포어여야 한다 — 썸네일 폭주가 본 영상 취득을 밀어내면 안 된다
    assert live._a_preview_gate is not live._a_gate        # noqa: SLF001


def test_preview_gate_fails_fast_when_full(monkeypatch):
    """상한이 찼으면 무한정 기다리지 않고 WebPacsError 로 접는다."""
    monkeypatch.setattr(live, "_a_preview_gate", threading.BoundedSemaphore(1))
    monkeypatch.setattr(live, "_A_PREVIEW_WAIT", 0.05)
    with live.a_preview_slot():                            # 1개뿐인 슬롯을 점유
        with pytest.raises(WebPacsError):
            with live.a_preview_slot():
                pytest.fail("상한을 넘어 두 번째 슬롯이 발급됐다")


def test_preview_bytes_takes_the_slot(monkeypatch):
    """preview_bytes 의 원격 호출이 상한 **안**에서 일어난다(예전엔 밖이었다)."""
    inside: list[bool] = []
    real = live.a_preview_slot

    class FakeClient:
        def rendered_preview(self, *a):
            # 이 호출 시점에 슬롯이 잡혀 있어야 한다 — 1개로 줄여 두었으니 재획득이 실패해야 정상
            try:
                with real():
                    inside.append(False)
            except WebPacsError:
                inside.append(True)
            return b"JPEG"

        def thumbnail(self, *a):
            return None

    monkeypatch.setattr(live, "_a_preview_gate", threading.BoundedSemaphore(1))
    monkeypatch.setattr(live, "_A_PREVIEW_WAIT", 0.05)
    monkeypatch.setattr(live, "service_client", lambda db: FakeClient())

    assert live.preview_bytes(None, "1.2", "1.3", "1.4") == b"JPEG"
    assert inside == [True], "원격 호출이 상한 밖에서 일어났다"


def test_encode_gate_exists_and_is_bounded():
    """HTJ2K 온디맨드 인코딩에도 상한이 있다."""
    assert hs._ENC_SLOTS >= 1                              # noqa: SLF001
    assert hs._ENC_SLOTS < 40, "인코딩이 스레드풀을 통째로 먹을 수 있다"   # noqa: SLF001
    assert hs._ENC_WAIT > 0                                # noqa: SLF001


def test_frame_node_timeout_is_much_shorter_than_batch():
    """단일 프레임 인코딩은 짧게 끊는다 — 1800초면 스레드 하나가 30분 묶인다."""
    from app.services import htj2k_service as svc

    assert svc.NODE_TIMEOUT_FRAME <= 60, "프레임 타임아웃이 너무 길다"
    assert svc.NODE_TIMEOUT_FRAME < svc.NODE_TIMEOUT_BATCH


def test_run_node_timeout_returns_empty_instead_of_raising(monkeypatch, tmp_path):
    """인코더가 멈추면 예외로 500 을 내지 않고 빈 결과로 접는다(호출부가 판단)."""
    import subprocess

    from app.services import htj2k_service as svc

    def boom(*a, **kw):
        raise subprocess.TimeoutExpired(cmd="node", timeout=1)

    monkeypatch.setattr(svc.subprocess, "run", boom)
    assert svc._run_node([{"out": "x"}], timeout=0.01) == {}   # noqa: SLF001


def test_transfer_syntax_verdict_is_remembered():
    """기압축 판정은 SOP 에 대해 불변 — 한 번만 확인하고 기억한다.

    예전에는 프레임을 볼 때마다 인스턴스 전체(수 MB)를 내려받아 전송구문만 확인하고 버렸다.
    """
    hs._TS_UNCOMPRESSED.clear()                            # noqa: SLF001
    assert hs._ts_verdict("1.2.3") is None                 # noqa: SLF001
    hs._ts_remember("1.2.3", False)                        # noqa: SLF001
    assert hs._ts_verdict("1.2.3") is False                # noqa: SLF001
    hs._ts_remember("1.2.4", True)                         # noqa: SLF001
    assert hs._ts_verdict("1.2.4") is True                 # noqa: SLF001


def test_verdict_cache_is_bounded():
    """무한정 자라지 않는다 — 상한을 넘으면 비운다(재학습은 저렴하다)."""
    hs._TS_UNCOMPRESSED.clear()                            # noqa: SLF001
    for i in range(hs._TS_MAX + 5):                        # noqa: SLF001
        hs._ts_remember(f"sop{i}", True)                   # noqa: SLF001
    assert len(hs._TS_UNCOMPRESSED) <= hs._TS_MAX          # noqa: SLF001
