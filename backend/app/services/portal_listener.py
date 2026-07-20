"""서버 포털 리다이렉트 리스너.

관리자 콘솔 '서버 설정' 패널이 저장하는 server.network.web(IP·Port)은 그 자체로는
리스너가 없어 http://IP:Port 접속이 연결 거부된다. 이 모듈은 관리자가 지정한
web.ip:web.port 에 표준 라이브러리 http.server 기반 경량 리스너를 데몬 스레드로 띄워,
모든 GET/HEAD 요청을 실제 랜딩 포털로 302 리다이렉트한다.

- 단일 인스턴스(모듈 전역 상태 + lock), 이중 기동 가드(재기동은 기존 리스너 정지 후).
- 바인드 실패(포트 사용중/권한)는 예외로 잡아 {ok:false, detail} 반환(크래시 금지).
- DICOM(4242/4301)·API(8000)·뷰어 포털(5173~5175)과는 별개의 리스너.
"""
from __future__ import annotations

import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 랜딩 포털 기본 포트 — 고정 target_url 이 없을 때 요청 Host 호스트명과 조립한다.
DEFAULT_LANDING_PORT = 5173
# 안전한 호스트명(오픈 리다이렉트 방지) — 영숫자·점·하이픈·언더스코어만 허용.
# '/','@','\\',공백,널 등이 섞인 Host 헤더는 외부 URL 주입 시도로 보고 폐기한다.
_SAFE_HOST = re.compile(r"^[A-Za-z0-9._-]+$")

_lock = threading.Lock()
# 모듈 전역 리스너 상태(단일 인스턴스). 핸들러는 _lock 없이 읽기만 한다.
_state: dict = {
    "server": None,   # ThreadingHTTPServer | None
    "thread": None,   # threading.Thread | None
    "host": "",
    "port": 0,
    "target": "",     # 고정 target_url(빈값이면 요청 Host 기반 추정)
    "since": None,    # float epoch | None
    "error": "",
}


def _resolve_target(host_header: str) -> str:
    """리다이렉트 대상 URL — 고정 target 이 있으면 그것, 없으면 요청 Host 호스트명 + 랜딩 포트."""
    fixed = str(_state.get("target") or "").strip()
    if fixed:
        return fixed
    hostname = (host_header or "").split(":")[0].strip()
    # 오픈 리다이렉트 차단 — 허용 문자셋을 벗어난 Host(외부 도메인·경로·userinfo 주입)는 로컬로 폴백.
    if not hostname or not _SAFE_HOST.match(hostname):
        hostname = "127.0.0.1"
    # 랜딩 포털은 HTTPS 전용(vite 자체서명 고정) — 리다이렉트 대상도 https 로 조립한다.
    return f"https://{hostname}:{DEFAULT_LANDING_PORT}/"


class _RedirectHandler(BaseHTTPRequestHandler):
    server_version = "SaintviewPortal/1.0"
    protocol_version = "HTTP/1.1"

    def _redirect(self, include_body: bool) -> None:
        target = _resolve_target(self.headers.get("Host", ""))
        body = (
            "<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\">"
            f"<meta http-equiv=\"refresh\" content=\"0;url={target}\">"
            "<title>Saintview PACS</title></head><body style=\"font-family:sans-serif\">"
            f"<p>로그인 포털로 이동합니다… 자동으로 넘어가지 않으면 "
            f"<a href=\"{target}\">여기</a>를 클릭하세요.</p></body></html>"
        ).encode("utf-8")
        self.send_response(302)
        self.send_header("Location", target)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        if include_body:
            self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 — http.server 규약
        self._redirect(include_body=True)

    def do_HEAD(self) -> None:  # noqa: N802 — http.server 규약
        self._redirect(include_body=False)

    def log_message(self, *args) -> None:  # 표준 stderr 접근 로그 억제
        pass


def _stop_locked() -> bool:
    """_lock 보유 상태에서 현재 리스너 정지(shutdown+close). 정지한 게 있으면 True."""
    httpd = _state.get("server")
    stopped = httpd is not None
    if httpd is not None:
        try:
            httpd.shutdown()
            httpd.server_close()
        except Exception:  # noqa: BLE001 — 정지 실패해도 상태는 비운다
            pass
    _state.update({"server": None, "thread": None, "since": None})
    return stopped


def start(host: str, port, target_url: str = "") -> dict:
    """host:port 에 리스너 (재)기동. 실패는 {ok:false, detail}(크래시 금지).

    host 빈값/"0.0.0.0"/"*" → 0.0.0.0 바인드. 포트 범위(1~65535) 검증,
    특권 포트(<1024)는 warning 을 동반해 허용한다.
    """
    host = str(host or "").strip()
    bind_host = "0.0.0.0" if host in ("", "0.0.0.0", "*") else host
    try:
        port = int(port)
    except (TypeError, ValueError):
        return {"ok": False, "detail": f"포트가 올바르지 않습니다: {port!r}"}
    if not (1 <= port <= 65535):
        return {"ok": False, "detail": f"포트 범위(1~65535)를 벗어났습니다: {port}"}
    warning = f"특권 포트({port}) — 관리자 권한이 필요할 수 있습니다" if port < 1024 else ""

    with _lock:
        _stop_locked()  # 이중 기동 가드 — 재기동은 기존 리스너를 먼저 정지
        try:
            httpd = ThreadingHTTPServer((bind_host, port), _RedirectHandler)
        except (OSError, ValueError, TypeError, UnicodeError) as e:
            # 포트 점유(OSError)뿐 아니라 잘못된 호스트(널문자 TypeError·IDNA UnicodeError 등)도
            # 우아 처리 — 서버 본체(FastAPI)는 죽지 않고 {ok:false, detail} 로 강등.
            detail = f"바인드 실패({bind_host}:{port}) — {getattr(e, 'strerror', None) or e}"
            _state.update({"host": bind_host, "port": port, "error": detail})
            return {"ok": False, "detail": detail, "warning": warning}
        httpd.daemon_threads = True
        t = threading.Thread(target=httpd.serve_forever, name="portal-listener", daemon=True)
        t.start()
        _state.update({
            "server": httpd, "thread": t, "host": bind_host, "port": port,
            "target": str(target_url or "").strip(), "since": time.time(), "error": "",
        })
        result = {"ok": True, "warning": warning}
        result.update(_status_locked())
        return result


def stop() -> dict:
    """리스너 안전 종료. 항상 {ok:true, ...현재 상태}."""
    with _lock:
        stopped = _stop_locked()
        _state["error"] = ""
        out = {"ok": True, "stopped": stopped}
        out.update(_status_locked())
        return out


def _status_locked() -> dict:
    thread = _state.get("thread")
    running = _state.get("server") is not None and thread is not None and thread.is_alive()
    return {
        "running": running,
        "host": _state.get("host", ""),
        "port": _state.get("port", 0),
        "target": _state.get("target", ""),
        "since": _state.get("since"),
        "error": _state.get("error", ""),
    }


def status() -> dict:
    """현재 상태 — {running, host, port, target, since, error}."""
    with _lock:
        return _status_locked()
