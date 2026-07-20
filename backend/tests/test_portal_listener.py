"""서버 포털 리다이렉트 리스너 — 라이프사이클·302·바인드 실패 우아 처리·엔드포인트.

start/stop/status, 이미 사용중 포트 바인드 실패, 302 Location, 잘못된 포트 400,
이중 apply(재기동) 안전을 검증한다.
"""
from __future__ import annotations

import socket
import urllib.error
import urllib.request

import pytest

from app.services import portal_listener


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    portal_listener.stop()


# ════════════════════════════════ 라이프사이클 ════════════════════════════════
def test_start_stop_status_lifecycle():
    assert portal_listener.status()["running"] is False
    port = _free_port()
    res = portal_listener.start("127.0.0.1", port)
    assert res["ok"] is True and res["running"] is True
    st = portal_listener.status()
    assert st["running"] is True and st["host"] == "127.0.0.1" and st["port"] == port
    assert st["since"] is not None
    stopped = portal_listener.stop()
    assert stopped["ok"] is True and stopped["stopped"] is True
    assert portal_listener.status()["running"] is False


def test_empty_host_binds_all_interfaces():
    res = portal_listener.start("", _free_port())
    assert res["ok"] is True and res["host"] == "0.0.0.0"


# ════════════════════════════════ 302 리다이렉트 ════════════════════════════════
def test_redirect_302_with_fixed_target():
    port = _free_port()
    target = "http://192.168.0.10:5173/"
    portal_listener.start("127.0.0.1", port, target_url=target)

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):  # 리다이렉트 따라가지 않음
            return None

    opener = urllib.request.build_opener(_NoRedirect)
    try:
        opener.open(f"http://127.0.0.1:{port}/anything", timeout=3)
        raise AssertionError("302 이어야 하는데 리다이렉트가 발생하지 않음")
    except urllib.error.HTTPError as e:
        assert e.code == 302
        assert e.headers.get("Location") == target


def test_redirect_target_from_host_header_when_no_fixed():
    port = _free_port()
    portal_listener.start("127.0.0.1", port)  # 고정 target 없음 → Host 기반 추정

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    opener = urllib.request.build_opener(_NoRedirect)
    try:
        opener.open(f"http://127.0.0.1:{port}/", timeout=3)
        raise AssertionError("302 이어야 함")
    except urllib.error.HTTPError as e:
        assert e.code == 302
        # Host = 127.0.0.1:{port} → 호스트명 127.0.0.1 + 랜딩 포트 5173 (랜딩은 HTTPS 전용)
        assert e.headers.get("Location") == f"https://127.0.0.1:{portal_listener.DEFAULT_LANDING_PORT}/"


# ════════════════════════════════ 바인드 실패 우아 처리 ════════════════════════════════
def test_bind_failure_on_busy_port():
    # 다른 소켓이 점유한 포트 → 바인드 실패는 예외 대신 {ok:false, detail}
    busy = socket.socket()
    busy.bind(("127.0.0.1", 0))
    busy.listen(1)
    port = busy.getsockname()[1]
    try:
        res = portal_listener.start("127.0.0.1", port)
        assert res["ok"] is False and "바인드 실패" in res["detail"]
        assert portal_listener.status()["running"] is False
    finally:
        busy.close()


def test_invalid_port_rejected():
    assert portal_listener.start("127.0.0.1", 0)["ok"] is False
    assert portal_listener.start("127.0.0.1", 70000)["ok"] is False
    assert portal_listener.start("127.0.0.1", "not-a-port")["ok"] is False


def test_privileged_port_carries_warning():
    # 특권 포트(<1024)는 warning 을 동반 — 바인드는 시도(권한 없으면 ok:false 로 강등)
    res = portal_listener.start("127.0.0.1", 80)
    assert res.get("warning")


def test_bad_host_does_not_crash():
    # 널문자/잘못된 호스트 등 OSError 가 아닌 예외도 우아 처리(서버 본체 불멸)
    res = portal_listener.start("bad\x00host", _free_port())
    assert res["ok"] is False and "바인드 실패" in res["detail"]
    assert portal_listener.status()["running"] is False


# ════════════════════════════════ 오픈 리다이렉트 방지 ════════════════════════════════
def test_resolve_target_rejects_open_redirect():
    # 고정 target 없을 때 Host 헤더 기반 조립 — 외부 도메인/경로/userinfo 주입은 로컬로 폴백
    portal_listener._state["target"] = ""
    land = portal_listener.DEFAULT_LANDING_PORT
    # 정상 호스트는 그대로 사용(스킴 https·포트 고정 — 랜딩은 HTTPS 전용)
    assert portal_listener._resolve_target("192.168.0.10:9000") == f"https://192.168.0.10:{land}/"
    # 오픈 리다이렉트 시도는 모두 127.0.0.1 로 강등
    for hostile in ("evil.com/path", "user@evil.com", "evil.com\\@x", "ho st", "bad\x00x"):
        assert portal_listener._resolve_target(hostile) == f"https://127.0.0.1:{land}/", hostile


# ════════════════════════════════ 이중 apply(재기동) 안전 ════════════════════════════════
def test_double_apply_restarts_cleanly():
    p1, p2 = _free_port(), _free_port()
    r1 = portal_listener.start("127.0.0.1", p1)
    assert r1["ok"] and r1["port"] == p1
    r2 = portal_listener.start("127.0.0.1", p2)  # 재기동 — 기존 리스너 정지 후 새 포트
    assert r2["ok"] and r2["port"] == p2
    assert portal_listener.status()["port"] == p2
    # 이전 포트는 해제되어 재바인드 가능
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1", p1))
    s.close()


# ════════════════════════════════ 엔드포인트(관리자 전용) ════════════════════════════════
def test_portal_endpoints(client, auth_headers):
    port = _free_port()
    r = client.post("/api/maintenance/portal/apply", headers=auth_headers,
                    json={"ip": "127.0.0.1", "port": port})
    assert r.status_code == 200, r.text
    assert r.json()["running"] is True and r.json()["port"] == port
    st = client.get("/api/maintenance/portal/status", headers=auth_headers).json()
    assert st["running"] is True
    stop = client.post("/api/maintenance/portal/stop", headers=auth_headers)
    assert stop.status_code == 200 and stop.json()["running"] is False


def test_portal_apply_bind_failure_returns_400(client, auth_headers):
    busy = socket.socket()
    busy.bind(("127.0.0.1", 0))
    busy.listen(1)
    port = busy.getsockname()[1]
    try:
        r = client.post("/api/maintenance/portal/apply", headers=auth_headers,
                        json={"ip": "127.0.0.1", "port": port})
        assert r.status_code == 400
        assert "바인드 실패" in r.json()["detail"]
    finally:
        busy.close()


def test_portal_requires_admin(client):
    assert client.get("/api/maintenance/portal/status").status_code == 401
