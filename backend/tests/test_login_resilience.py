"""A 가 아플 때 **로그인이 어떻게 실패하는가** — 사용자가 본 그 화면.

증상: "로그인 화면은 뜨는데 버튼을 눌러도 아무 일이 없다. 한참 뒤에는 된다."

원인 세 겹:
  ① Live 로그인은 B DB 인증이 아니라 **A 로 나가는 HTTP 호출**이다. A 가 느리면 직접 막힌다.
  ② 타임아웃이 스칼라 60.0 이었다 — httpx 에서 이것은 '총 60초' 가 아니라
     connect/read/write/pool **각각** 60초라, 최악의 경우 한 스레드가 3분 가까이 묶인다.
  ③ `except WebPacsError` 만 잡아서 httpx.TimeoutException 이 그대로 올라갔다. 결과:
     · 사용자에게 60초 뒤 **500**(원인을 알 수 없는 오류)
     · 잠금 카운터도 안 올라 재시도 폭주를 막을 브레이크가 없었다
     · 게다가 A 장애로 카운터를 올리면 A 복구 후 **전원이 잠긴다** — 그래서 카운터는
       올리지 않고 503 으로 '서버 문제' 임을 분명히 해야 한다

계약: A 장애 = 503(빠르게) · 자격 실패 = 401(카운터 +1) · 500 은 나오지 않는다.
"""
from __future__ import annotations

import time

import httpx
import pytest

from app.services.webpacs_bridge import WebPacsClient


def test_default_timeout_is_phase_split():
    """스칼라 60.0 회귀 방어 — 단계별로 나뉘어 있어야 한다."""
    t = WebPacsClient.DEFAULT_TIMEOUT
    assert t.connect == 3.0, f"connect={t.connect}"
    assert t.read == 10.0, f"read={t.read} — 조회가 10초를 넘게 스레드를 쥐면 안 된다"
    assert t.write == 10.0
    assert t.pool == 5.0


def test_login_timeout_is_shorter_than_queries():
    """로그인은 조회보다 더 빨리 포기한다 — 기다리면 사용자가 버튼을 다시 누른다."""
    assert WebPacsClient.LOGIN_TIMEOUT.read <= 5.0
    assert WebPacsClient.LOGIN_TIMEOUT.read < WebPacsClient.DEFAULT_TIMEOUT.read


def test_pixel_fetch_keeps_a_long_read():
    """대용량 원본 전송만 read 를 길게 — 조회 기준(10초)으로는 수 MB 를 못 받는다."""
    assert WebPacsClient.PIXEL_TIMEOUT.read == 60.0
    assert WebPacsClient.PIXEL_TIMEOUT.connect == 3.0, "연결은 여전히 빨리 포기한다"


def test_client_applies_the_split_timeout_by_default():
    c = WebPacsClient("https://a.example", "u", "p",
                      transport=httpx.MockTransport(lambda r: httpx.Response(200, json={})))
    try:
        assert c._client.timeout.read == 10.0        # noqa: SLF001
        assert c._client.timeout.connect == 3.0      # noqa: SLF001
    finally:
        c.close()


def test_scalar_timeout_still_accepted():
    """기존 호출 호환 — 숫자를 넘기던 코드가 깨지면 안 된다."""
    c = WebPacsClient("https://a.example", "u", "p", timeout=7.0,
                      transport=httpx.MockTransport(lambda r: httpx.Response(200, json={})))
    try:
        assert c._client.timeout.read == 7.0         # noqa: SLF001
    finally:
        c.close()


def test_slow_a_fails_fast_not_after_a_minute():
    """A 가 응답을 안 주면 **로그인 타임아웃 언저리**에 끝난다 — 60초를 기다리지 않는다."""

    def hang(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("A 가 응답하지 않는다", request=request)

    c = WebPacsClient("https://a.example", "u", "p",
                      timeout=WebPacsClient.LOGIN_TIMEOUT,
                      transport=httpx.MockTransport(hang))
    t0 = time.time()
    with pytest.raises(httpx.HTTPError):
        c.login()
    took = time.time() - t0
    c.close()
    assert took < 10, f"{took:.1f}초 걸렸다 — 스레드를 그만큼 쥔다"
