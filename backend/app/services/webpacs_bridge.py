"""WebPACS(SaintViewPACS/webpacs_api) 브리지 — 인계 웹서비스의 검사를 우리 뷰어로.

인계 PACS(FastAPI webpacs_api: MySQL `cloud_pacs` + MinIO(AES-CBC 암호화) + Redis)의
검사를 이 Viewer Suite 로 가져와 자체 뷰어(T-View/In-View/SaintView)로 표시한다.

연동 방식(설계 결정 — docs/INTEGRATION_WEBPACS.md):
  원격 REST(`/api/study/...`)로 검사를 탐색하고, DICOMweb v2 의
  `GET /api/dicomweb/v2/studies/{s}/series/{se}/instances/{sop}` 로 **서버가 이미
  AES 복호화 + HTJ2K→원본 전송구문 정규화한 표준 DICOM 파일**을 받아
  우리 Orthanc 에 주입(POST /instances) → register_study 로 워크리스트 등록.
  - MinIO 직결/CRYPTION_KEY 불필요(인계 자료에 키 누락 — 서버측 복호화 경로만 사용).
  - 우리 뷰어의 픽셀 경로(/rendered?window=)는 Orthanc 의존이라 미러 주입이 정답.
    (인계 v2 에는 rendered 엔드포인트가 없음 — 원본 프레임+클라 WASM 디코드 방식)

인증: 원격 `POST /api/user/auth/login` {user_id, user_passwd, user_overwrite} → JWT.
      모든 원격 호출에 Authorization: Bearer. 만료 시 1회 재로그인 후 재시도.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

logger = logging.getLogger("saintview.webpacs")

SETTING_KEY = "webpacs.bridge"

# 설정 화이트리스트 — GUI(PUT /api/webpacs/config)로 저장 가능한 키만
CONFIG_KEYS = (
    "enabled",         # 브리지 사용
    "base_url",        # 원격 API 베이스 (예: https://api.inviz.co.kr 또는 http://localhost:8014)
    "user_id",         # 원격 PACS 계정 (user_type 에 'P' 포함 필요)
    "password",
    "verify_ssl",
    "hospital_id",     # 가져온 검사를 귀속할 병원 id (0/None=요청자 병원)
    "auto_sync",       # 원격 신규 검사 자동 가져오기 (워커 주기)
    "auto_sync_limit", # 자동 동기화 시 원격 최신 N건만 검사
)

DEFAULT_CONFIG: dict[str, Any] = {
    "enabled": False,
    "base_url": "",
    "user_id": "",
    "password": "",
    "verify_ssl": True,
    "hospital_id": 0,
    "auto_sync": False,
    "auto_sync_limit": 20,
}


class WebPacsError(RuntimeError):
    """원격 WebPACS 호출 실패(로그인 실패·비정상 응답 포함)."""


def get_bridge_config(db: Session) -> dict[str, Any]:
    """전역 설정(webpacs.bridge) + env 오버라이드 병합.

    env(SAINTVIEW_WEBPACS_*)는 하네스/E2E 에서 GUI 설정 없이 구동하기 위한 통로 —
    설정값보다 우선한다(테스트 관례: env > setting).
    """
    from app.services.settings_service import get_setting

    cfg = dict(DEFAULT_CONFIG)
    stored = get_setting(db, SETTING_KEY, default={}) or {}
    for k in CONFIG_KEYS:
        if k in stored:
            cfg[k] = stored[k]
    env_map = {
        "base_url": os.getenv("SAINTVIEW_WEBPACS_BASE_URL"),
        "user_id": os.getenv("SAINTVIEW_WEBPACS_USER"),
        "password": os.getenv("SAINTVIEW_WEBPACS_PASSWORD"),
    }
    for k, v in env_map.items():
        if v:
            cfg[k] = v
    if os.getenv("SAINTVIEW_WEBPACS_ENABLED") in ("0", "1"):
        cfg["enabled"] = os.getenv("SAINTVIEW_WEBPACS_ENABLED") == "1"
    if os.getenv("SAINTVIEW_WEBPACS_VERIFY_SSL") in ("0", "1"):
        cfg["verify_ssl"] = os.getenv("SAINTVIEW_WEBPACS_VERIFY_SSL") == "1"
    return cfg


class WebPacsClient:
    """webpacs_api REST + DICOMweb v2 클라이언트 (Bearer 자동 갱신)."""

    # ⚠ 스칼라 timeout=60.0 은 '총 60초' 가 아니다 — connect/read/write/pool **각각** 60초라
    #   최악의 경우 한 요청이 스레드를 3분 가까이 쥔다. 조회는 짧게 끊고, 대용량 픽셀 취득만
    #   요청 단위로 read 를 늘린다(instance_dicom). 스칼라도 계속 받는다(기존 호출 호환).
    DEFAULT_TIMEOUT = httpx.Timeout(connect=3.0, read=10.0, write=10.0, pool=5.0)
    PIXEL_TIMEOUT = httpx.Timeout(connect=3.0, read=60.0, write=10.0, pool=5.0)
    LOGIN_TIMEOUT = httpx.Timeout(connect=3.0, read=5.0, write=5.0, pool=2.0)

    def __init__(self, base_url: str, user_id: str, password: str = "", *,
                 verify_ssl: bool = True, timeout: "float | httpx.Timeout | None" = None,
                 transport: httpx.BaseTransport | None = None,
                 token: str | None = None, refresh_token: str | None = None,
                 on_token: "callable | None" = None):
        if not base_url:
            raise WebPacsError("WebPACS base_url 이 설정되지 않았습니다")
        self.base_url = base_url.rstrip("/")
        self.user_id = user_id
        self.password = password
        # per-user 모드: 사용자의 A 로그인에서 받은 토큰으로 시작하고, 만료 시 refresh 로 갱신한다.
        # (password 는 없을 수 있음 — 그 경우 refresh 만으로 재인증, 실패 시 재로그인 요구)
        self._token: str | None = token
        self._refresh_token: str | None = refresh_token
        self._on_token = on_token   # 토큰 갱신 시 세션 저장소에 반영하는 콜백(선택)
        # 지금 들고 있는 토큰을 **받은 시각** — adopt_token 이 '더 새 것만 채택' 판정에 쓴다.
        self._token_ts: float = 0.0
        # A 는 단일 유효 토큰(로그인마다 이전 토큰 무효화)이라, 멀티스레드(FastAPI threadpool)에서
        # 병렬 이미지 로드가 각자 재로그인하면 서로의 토큰을 무효화하는 401 폭풍이 난다.
        # → 재인증을 락으로 직렬화 + "내가 쓴 토큰이 아직 유효할 때만" 재인증(중복 재인증 방지).
        self._auth_lock = threading.Lock()
        kw: dict[str, Any] = {"base_url": self.base_url,
                              "timeout": self.DEFAULT_TIMEOUT if timeout is None else timeout}
        if transport is not None:
            kw["transport"] = transport   # 테스트(ASGITransport) 주입
        else:
            kw["verify"] = verify_ssl
            # 연결 풀 — 기본 keepalive 20 은 프리페치 8스레드 + 화면 요청이 겹치면 모자라서
            # 매 요청 TCP+TLS 를 새로 맺었다(원격 A 상대로는 왕복 2~3회 추가). 넉넉히 잡는다.
            kw["limits"] = httpx.Limits(max_keepalive_connections=32, max_connections=64,
                                        keepalive_expiry=60.0)
        self._client = httpx.Client(**kw)

    # ── 인증 ──────────────────────────────────────────────
    def login(self) -> dict:
        """비밀번호 로그인(서비스 계정·미러·초기 검증). per-user 모드는 _reauth 를 통해 refresh."""
        with self._auth_lock:
            return self._password_login_locked()

    def _password_login_locked(self) -> dict:
        r = self._client.post("/api/user/auth/login", json={
            "user_id": self.user_id, "user_passwd": self.password, "user_overwrite": True,
        })
        if r.status_code != 200:
            raise WebPacsError(f"WebPACS 로그인 실패 HTTP {r.status_code}: {r.text[:200]}")
        body = r.json()
        # 원격 응답 봉투: {status: 200|202, token, refresh_token, user_data, message}
        if not body.get("token"):
            raise WebPacsError(f"WebPACS 로그인 거부: {body.get('message', '')} (status={body.get('status')})")
        self._token = body["token"]
        if body.get("refresh_token"):
            self._refresh_token = body["refresh_token"]
        self._emit_token()
        return body

    def _refresh_locked(self) -> bool:
        """refresh 토큰으로 access 갱신(A: POST /api/user/auth/refresh, 헤더 Bearer+바디 refresh_token).
        성공 시 True. refresh 토큰 만료·부재면 False(호출부가 password 폴백 또는 예외)."""
        if not self._refresh_token:
            return False
        try:
            r = self._client.post(
                "/api/user/auth/refresh",
                json={"refresh_token": self._refresh_token},
                headers={"Authorization": f"Bearer {self._token}"} if self._token else {},
            )
            if r.status_code == 200:
                tok = r.json().get("token_access")
                if tok:
                    self._token = tok
                    self._emit_token()
                    return True
        except Exception:  # noqa: BLE001 — refresh 실패는 password 폴백/예외로 처리
            pass
        return False

    def _reauth_locked(self) -> None:
        """재인증 — refresh 우선, 실패 시 password 로그인. 둘 다 불가면 세션 만료 예외."""
        if self._refresh_locked():
            return
        if self.password:
            self._password_login_locked()
            return
        raise WebPacsError("원격 PACS 세션이 만료되었습니다 — 다시 로그인하세요")

    def _emit_token(self) -> None:
        # 내가 방금 받은 토큰이 가장 새 것이다 — adopt_token 이 이 시각과 비교해
        # 옛 세션 레코드의 토큰으로 되돌아가는 것을 막는다(항상 _auth_lock 안에서 호출된다).
        self._token_ts = time.time()
        if self._on_token and self._token:
            try:
                self._on_token(self._token)
            except Exception:  # noqa: BLE001
                pass

    def _ensure_token(self) -> str:
        """유효 토큰 확보(없으면 재인증). 반환: 요청에 사용할 토큰(경합 재시도 비교용)."""
        tok = self._token
        if tok is None:
            with self._auth_lock:
                if self._token is None:
                    self._reauth_locked()
                tok = self._token
        return tok or ""

    def adopt_token(self, token: str | None, token_ts: float) -> bool:
        """외부(세션 저장소)에서 받은 토큰을 **더 새 것일 때만** 채택. 반환: 채택 여부.

        여러 세션(창)이 같은 A 계정 클라이언트를 공유한다. 예전에는 세션 레코드의 토큰을
        무조건 self._token 에 대입했는데, 옛 토큰을 든 창이 요청할 때마다 최신 토큰을
        되덮어 401 이 사용자에게 그대로 새어 나갔다. 시각 비교로 되돌림을 막는다.
        _auth_lock 안에서 바꾼다 — _reauth_locked/_refresh_locked 와 같은 직렬화 구역이라야
        재인증 도중 옛 값이 끼어들지 않는다.
        """
        if not token:
            return False
        with self._auth_lock:
            if self._token == token:
                self._token_ts = max(self._token_ts, token_ts)
                return False
            if self._token is not None and token_ts <= self._token_ts:
                return False        # 더 오래된 토큰 — 무시(되돌림 방지)
            self._token = token
            self._token_ts = token_ts
            return True

    def _relogin_if_stale(self, used_token: str) -> None:
        """401 재시도 전 — 내가 쓴 토큰이 아직 현재 토큰일 때만 재인증.
        다른 스레드가 이미 갱신했으면 그 토큰을 그대로 재사용(중복 재인증·상호 무효화 방지)."""
        with self._auth_lock:
            if self._token == used_token or self._token is None:
                self._reauth_locked()

    def _headers(self, extra: dict[str, str] | None = None,
                 token: str | None = None) -> dict[str, str]:
        tok = token if token is not None else self._token
        h = {"Authorization": f"Bearer {tok}"} if tok else {}
        if extra:
            h.update(extra)
        return h

    def _authed(self, send, *args, **kw) -> httpx.Response:
        """토큰 부착 요청 실행 + 401 시 stale 판정 재로그인 1회 재시도(공용).
        send: self._client.request/get/post 등. args/kw 에 headers 는 주입하지 않는다(여기서 부착)."""
        # ⚠ 헤더에 붙일 토큰은 used 와 **같은 값**이어야 한다. 예전에는 _headers() 가
        #   self._token 을 다시 읽어서, 그 사이 다른 스레드가 토큰을 바꾸면 요청은 새 토큰(Y)으로
        #   나가는데 used 는 옛 토큰(X)이었다. 401 이 나도 _relogin_if_stale(X) 는
        #   self._token(Y) != X 라며 **재인증을 건너뛰어** 401 이 호출자에게 그대로 새어 나갔다.
        used = self._ensure_token()
        extra = kw.pop("headers", None)
        kw["headers"] = self._headers(extra, token=used)
        r = send(*args, **kw)
        if r.status_code == 401:
            self._relogin_if_stale(used)
            kw["headers"] = self._headers(extra)
            r = send(*args, **kw)
        return r

    def _request(self, method: str, path: str, *, params: dict | None = None,
                 headers: dict[str, str] | None = None,
                 timeout: "httpx.Timeout | float | None" = None) -> httpx.Response:
        """Bearer 부착 요청 — 401(토큰 만료/무효)이면 stale 판정 후 재로그인 1회 재시도.

        timeout 을 주면 그 요청에만 적용한다(대용량 픽셀 취득은 read 를 길게 잡아야 한다).
        """
        kw: dict[str, Any] = {"params": params, "headers": headers}
        if timeout is not None:
            kw["timeout"] = timeout
        return self._authed(self._client.request, method, path, **kw)

    def _json(self, path: str, params: dict | None = None) -> dict:
        r = self._request("GET", path, params=params)
        if r.status_code != 200:
            raise WebPacsError(f"WebPACS GET {path} 실패 HTTP {r.status_code}: {r.text[:200]}")
        return r.json()

    # ── 검사 탐색 (원격 REST — 내부 PK study_idx 기반) ──────
    def list_users(self, params: dict | None = None) -> list[dict]:
        """A 사용자 목록 — `GET /api/user/`.

        A 는 이 응답에서 **user_passwd 를 빼고** 전 컬럼을 준다(router/User.py:35
        `users_columns.remove('user_passwd')`). 그래서 이 경로로는 비밀번호가 넘어올 수 없다 —
        미러링이 자격증명 복제가 되지 않는 구조적 근거다.
        관리자 권한 계정으로 호출해야 한다(A 가 관리자용 API 로 규정).
        """
        body = self._json("/api/user/", params=params or {})
        return body.get("users_data") or []

    def list_studies(self, params: dict | None = None) -> list[dict]:
        body = self._json("/api/study/", params=params or {})
        return body.get("study_data") or []

    def study_count(self, params: dict | None = None) -> int:
        body = self._json("/api/study/count", params=params or {})
        return int(body.get("study_count") or 0)

    def study_detail(self, study_idx: int) -> dict:
        body = self._json(f"/api/study/{study_idx}")
        return body.get("study_data") or {}

    def report_shortcuts(self) -> list[dict]:
        """계정별 단축키·상용구 — `GET /api/shortcuts/`(A pacs_shortcuts, per-user 토큰 스코프).

        A(SV70)가 원천이다 — 복사하지 않는다(Live). shortcut_type: workList/viewer/report/template.
        A 응답: {message, status, data:[행…]}.
        """
        body = self._json("/api/shortcuts/")
        data = body.get("data") if isinstance(body, dict) else body
        return data or []

    def report_templates(self) -> list[dict]:
        """계정별 판독문 템플릿 — `GET /api/study/report/template`(A pacs_report_template).

        A 응답: {…, data:{template_data:[행…]}}.
        """
        body = self._json("/api/study/report/template")
        data = body.get("data") if isinstance(body, dict) else {}
        if isinstance(data, dict):
            return data.get("template_data") or []
        return data or []

    def series_viewer(self, study_idx: int) -> list[dict]:
        """시리즈 + SOP 열거 — 각 항목에 series_instance_uid·images[].sop_instance_uid."""
        body = self._json(f"/api/study/{study_idx}/series/viewer")
        return body.get("series_data") or []

    # ── DICOM 취득 (DICOMweb v2 — 서버측 복호화·원본 TS 정규화) ──
    def instance_dicom(self, study_uid: str, series_uid: str, sop_uid: str) -> bytes:
        r = self._request(
            "GET",
            f"/api/dicomweb/v2/studies/{study_uid}/series/{series_uid}/instances/{sop_uid}",
            headers={"Accept": "application/dicom"},
            timeout=self.PIXEL_TIMEOUT,     # 수 MB 전송 — 조회용 read=10s 로는 모자란다
        )
        if r.status_code != 200:
            raise WebPacsError(f"인스턴스 다운로드 실패 {sop_uid}: HTTP {r.status_code}")
        return r.content

    def series_metadata(self, study_uid: str, series_uid: str) -> list[dict]:
        """DICOMweb v2 시리즈 메타데이터(dicom+json) — 인스턴스별 기하 태그(rows/cols/spacing 등)."""
        r = self._request(
            "GET",
            f"/api/dicomweb/v2/studies/{study_uid}/series/{series_uid}/metadata",
            headers={"Accept": "application/dicom+json"},
        )
        if r.status_code != 200:
            raise WebPacsError(f"시리즈 메타데이터 실패 {series_uid}: HTTP {r.status_code}")
        return r.json()

    def thumbnail(self, study_uid: str, series_uid: str, sop_uid: str) -> bytes | None:
        """v2 썸네일(128px JPEG) — 실패 시 None(호출부 폴백).

        A 가 배치로 **미리 만들어 MinIO 에 넣어 둔** thumb/{sop}.jpg 를 그대로 준다
        (평문 JPEG, DICOM 다운로드·디코드 0). 전 인스턴스 커버.
        """
        r = self._request(
            "GET",
            f"/api/dicomweb/v2/studies/{study_uid}/series/{series_uid}/instances/{sop_uid}/thumbnail",
        )
        return r.content if r.status_code == 200 else None

    # A 가 미리 만들어 둔 저해상 렌더(rendered/{sop}_512x512_q80.jpg).
    # ⚠ 이 **정확한 조합**(viewport=512x512 & quality=80 & window 없음)일 때만 사전생성본을 탄다 —
    #    다른 값이면 A 가 그 자리에서 렌더한다(느림). Dicomweb.py 의 is_default_rendered 참조.
    PREVIEW_VIEWPORT = "512x512"
    PREVIEW_QUALITY = 80

    def rendered_preview(self, study_uid: str, series_uid: str, sop_uid: str) -> bytes | None:
        """저해상 미리보기 JPEG(≈40KB) — 첫 화면을 즉시 띄우기 위한 것.

        원본 DICOM(수 MB) 다운로드·디코드·PNG 인코딩을 전부 건너뛴다. v1 경로는
        Redis→MinIO→즉석렌더 폴백이 있어 404 가 나지 않는다. 실패 시 None(호출부 폴백).
        """
        r = self._request(
            "GET",
            f"/api/dicomweb/studies/{study_uid}/series/{series_uid}/instances/{sop_uid}/rendered",
            params={"viewport": self.PREVIEW_VIEWPORT, "quality": self.PREVIEW_QUALITY},
            headers={"Accept": "image/jpeg"},
        )
        if r.status_code == 200 and r.content[:2] == b"\xff\xd8":   # JPEG SOI
            return r.content
        return None

    # ── 판독·상태·주석 (Live 모드 — A DB 가 단일 원본) ─────────────
    def report_get(self, study_idx: int) -> dict | None:
        """판독문 조회 — 없으면 None(A 는 200 + report_data:null)."""
        body = self._json(f"/api/study/{study_idx}/report/")
        data = body.get("report_data")
        if isinstance(data, list):   # 콤마 다중조회 계약 방어
            data = data[0] if data else None
        return data or None

    def report_save(self, payload: dict) -> dict:
        """판독 저장/승인 — POST /api/study/{idx}/report/ (report_idx 있으면 UPDATE).

        A 계약: report_cvr_send 는 미전송 시 서버 500 — 호출부가 반드시 채운다.
        409(재배정)는 WebPacsError 로 승격해 메시지 전달.
        """
        study_idx = payload["study_idx"]
        r = self._authed(self._client.post, f"/api/study/{study_idx}/report/", json=payload)
        if r.status_code == 409:
            raise WebPacsConflict(_msg_of(r) or "다른 판독의에게 재배정된 검사입니다")
        if r.status_code != 200:
            raise WebPacsError(f"판독 저장 실패 HTTP {r.status_code}: {r.text[:200]}")
        return r.json()

    def change_status(self, study_idx: int, kind: str) -> dict:
        """판독 작성중 선점/해제 — kind='report'(RI 선점) | 'end'(해제→E).

        409 = 타 판독의 작성중/판독 완료 — WebPacsConflict 로 메시지 전달.
        """
        r = self._request("GET", f"/api/study/{study_idx}/report/change_status/{kind}")
        if r.status_code == 409:
            raise WebPacsConflict(_msg_of(r) or "이미 다른 판독의가 작성 중입니다")
        if r.status_code != 200:
            raise WebPacsError(f"상태 변경 실패 HTTP {r.status_code}: {r.text[:200]}")
        return r.json()

    def annotation_get(self, study_uid: str) -> list[dict]:
        """주석 조회 — 키는 StudyInstanceUID. 반환: pacs_image_annotation 행 배열."""
        body = self._json(f"/api/study/{study_uid}/annotation")
        return body.get("data") or []

    def annotation_change(self, study_uid: str, tool_name: str, tool_value: str) -> dict:
        """주석 업서트 — (study_uid, tool_name) 1행 전체 덮어쓰기(A 계약)."""
        r = self._authed(self._client.post, "/api/study/annotation/change", json={
            "study_instance_uid": study_uid,
            "annotation_tool_name": tool_name,
            "annotation_tool_value": tool_value,
        })
        if r.status_code != 200:
            raise WebPacsError(f"주석 저장 실패 HTTP {r.status_code}: {r.text[:200]}")
        return r.json()

    def study_keys(self, params: dict | None = None) -> list[dict]:
        """경량 폴링 — study_idx+study_status 만(A GET /api/study/study_keys)."""
        body = self._json("/api/study/study_keys", params=params or {})
        # 응답 키는 배포본에 따라 study_data/keys 다를 수 있어 방어적으로
        return body.get("study_data") or body.get("keys") or body.get("data") or []

    def study_update(self, study_idx: int, fields: dict) -> dict:
        """검사 정보 수정 — POST /api/study/ (study_comment·study_emergency 등, A Study.py)."""
        payload = {"study_idx": study_idx, **fields}
        r = self._authed(self._client.post, "/api/study/", json=payload)
        if r.status_code != 200:
            raise WebPacsError(f"검사 수정 실패 HTTP {r.status_code}: {r.text[:200]}")
        return r.json()

    def study_status_change(self, study_idx: int, fields: dict) -> dict:
        """상태/응급 변경 — POST /api/study/status (study_emergency 등, A Study.py:508)."""
        payload = {"study_idx": study_idx, **fields}
        r = self._authed(self._client.post, "/api/study/status", json=payload)
        if r.status_code != 200:
            raise WebPacsError(f"상태 변경 실패 HTTP {r.status_code}: {r.text[:200]}")
        return r.json()

    def bookmark_toggle(self, study_idx: int, on: bool, book_type: str = "study") -> dict:
        """북마크 토글 — A BookMark.py POST/DELETE /api/bookMark."""
        if on:
            r = self._authed(self._client.post, "/api/bookMark",
                             json={"study_idx": study_idx, "book_type": book_type})
        else:
            r = self._authed(self._client.request, "DELETE", "/api/bookMark",
                             json={"study_idx": study_idx, "book_type": book_type})
        if r.status_code not in (200, 201, 204):
            raise WebPacsError(f"북마크 실패 HTTP {r.status_code}: {r.text[:200]}")
        return {"ok": True}

    def close(self) -> None:
        self._client.close()


class WebPacsConflict(WebPacsError):
    """A 서버 409(작성중 선점·재배정·판독 완료) — 사용자 메시지 그대로 전달."""


def _msg_of(r: httpx.Response) -> str:
    try:
        body = r.json()
        return str(body.get("message") or body.get("detail") or "")
    except Exception:  # noqa: BLE001
        return r.text[:200]


def client_from_config(cfg: dict[str, Any],
                       transport: httpx.BaseTransport | None = None) -> WebPacsClient:
    return WebPacsClient(
        cfg.get("base_url", ""), cfg.get("user_id", ""), cfg.get("password", ""),
        verify_ssl=bool(cfg.get("verify_ssl", True)), transport=transport,
    )


# ── 가져오기(Import) — 원격 검사 → 우리 Orthanc → 워크리스트 등록 ──────────
# 진행 상태는 메모리 레지스트리(단일 프로세스 MVP — 워커/요청 스레드 공유)
IMPORT_JOBS: dict[int, dict[str, Any]] = {}
_JOBS_LOCK = threading.Lock()


def _job_update(remote_idx: int, **fields) -> None:
    with _JOBS_LOCK:
        job = IMPORT_JOBS.setdefault(remote_idx, {})
        job.update(fields)


def get_import_job(remote_idx: int) -> dict[str, Any] | None:
    with _JOBS_LOCK:
        job = IMPORT_JOBS.get(remote_idx)
        return dict(job) if job else None


def find_local_study_id(db: Session, study_uid: str) -> int | None:
    from app.models import Study

    if not study_uid:
        return None
    row = db.execute(select(Study.id).where(Study.study_uid == study_uid)).first()
    return int(row[0]) if row else None


def import_study(db: Session, cfg: dict[str, Any], remote_idx: int, *,
                 hospital_id: int | None = None,
                 transport: httpx.BaseTransport | None = None) -> dict[str, Any]:
    """원격 검사 1건을 내려받아 Orthanc 주입 + 워크리스트 등록(동기).

    반환: {status: exists|done|error, study_id, study_uid, total, done, failed}
    이미 로컬에 있는 study_uid 면 재다운로드 없이 exists 반환(멱등).
    """
    from app.dicom.orthanc import OrthancClient
    from app.services.study_service import register_study

    client = client_from_config(cfg, transport=transport)
    try:
        detail = client.study_detail(remote_idx)
        study_uid = str(detail.get("study_instance_uid") or "")
        existing = find_local_study_id(db, study_uid)
        if existing:
            _job_update(remote_idx, status="exists", study_id=existing, study_uid=study_uid)
            return {"status": "exists", "study_id": existing, "study_uid": study_uid,
                    "total": 0, "done": 0, "failed": 0}

        series = client.series_viewer(remote_idx)
        targets: list[tuple[str, str, str]] = []
        for s in series:
            se_uid = str(s.get("series_instance_uid") or "")
            st_uid = str(s.get("study_instance_uid") or study_uid)
            for img in s.get("images") or []:
                sop = str(img.get("sop_instance_uid") or "")
                if st_uid and se_uid and sop:
                    targets.append((st_uid, se_uid, sop))
        if not targets:
            raise WebPacsError("가져올 인스턴스가 없습니다 (series/viewer 응답 비어 있음)")

        _job_update(remote_idx, status="running", total=len(targets), done=0, failed=0,
                    study_uid=study_uid, error=None, started_at=time.time())

        orthanc = OrthancClient()
        if not orthanc.alive():
            raise WebPacsError("우리 Orthanc 저장소에 연결할 수 없습니다")
        parent_studies: set[str] = set()
        done = failed = 0
        try:
            for st_uid, se_uid, sop in targets:
                try:
                    data = client.instance_dicom(st_uid, se_uid, sop)
                    r = orthanc.upload_dicom(data)
                    if r.get("ParentStudy"):
                        parent_studies.add(r["ParentStudy"])
                    done += 1
                except Exception as e:  # noqa: BLE001 — 인스턴스 단위 실패 격리
                    failed += 1
                    logger.warning("WebPACS 인스턴스 실패 sop=%s: %s", sop, e)
                _job_update(remote_idx, done=done, failed=failed)
            if not parent_studies:
                raise WebPacsError(f"모든 인스턴스 업로드 실패 ({failed}/{len(targets)})")

            # Orthanc 메타데이터 기준으로 등록 — import-dicom 과 동일한 검증된 경로
            study_id: int | None = None
            for sid in parent_studies:
                meta = orthanc.study_metadata(sid)
                tags = meta.get("MainDicomTags", {})
                ptags = meta.get("PatientMainDicomTags", {})
                # 시리즈 레벨 HP 태그 — Orthanc 동기화 경로와 같은 것을 쓴다(부위가 비면 HP·Compare 가 죽는다)
                _htags = orthanc.hanging_tags(sid)
                register_study(
                    db,
                    study_uid=tags.get("StudyInstanceUID", ""),
                    patient_key=ptags.get("PatientID", "UNKNOWN"),
                    patient_name=ptags.get("PatientName", ""),
                    birth_date=ptags.get("PatientBirthDate", ""),
                    sex=ptags.get("PatientSex", ""),
                    accession_no=tags.get("AccessionNumber", ""),
                    study_date=tags.get("StudyDate", ""),
                    study_time=tags.get("StudyTime", ""),
                    modality=tags.get("ModalitiesInStudy", "").split("\\")[0]
                    if tags.get("ModalitiesInStudy") else "",
                    study_desc=tags.get("StudyDescription", ""),
                    body_part=_htags.get("BodyPartExamined", ""),
                    protocol_name=_htags.get("ProtocolName", ""),
                    procedure_code=_htags.get("RequestedProcedureID", ""),
                    step_desc=_htags.get("PerformedProcedureStepDescription", ""),
                    institution=tags.get("InstitutionName", "")
                    or str(detail.get("hospital_name") or ""),
                    referring_physician=str(tags.get("ReferringPhysicianName", "")),
                    department=tags.get("InstitutionalDepartmentName", ""),
                    source_aet="WEBPACS",
                    orthanc_id=sid,
                )
                sid_local = find_local_study_id(db, tags.get("StudyInstanceUID", ""))
                if sid_local:
                    study_id = sid_local
        finally:
            orthanc.close()

        # 병원 귀속 — Import 경로와 동일(장비 AET 매핑이 없으므로 명시 귀속)
        eff_hid = hospital_id or int(cfg.get("hospital_id") or 0) or None
        if study_id and eff_hid:
            from app.models import Study

            st = db.get(Study, study_id)
            if st is not None and st.hospital_id is None:
                st.hospital_id = eff_hid
                db.commit()

        _job_update(remote_idx, status="done", study_id=study_id, done=done, failed=failed)
        return {"status": "done", "study_id": study_id, "study_uid": study_uid,
                "total": len(targets), "done": done, "failed": failed}
    except Exception as e:
        _job_update(remote_idx, status="error", error=str(e)[:300])
        raise
    finally:
        client.close()


# ── 자동 동기화 (워커 주기 — 원격 최신 N건 중 미보유 검사 가져오기) ─────────
_AUTO_SYNC_RUNNING = threading.Event()


def webpacs_sync_once() -> int:
    """원격 최신 검사 자동 가져오기 1회 (설정 enabled+auto_sync 일 때만). 반환: 신규 건수.

    다운로드가 길어져 다음 주기와 겹치지 않게 실행 중이면 스킵.
    """
    if _AUTO_SYNC_RUNNING.is_set():
        return 0
    from app.db import SessionLocal

    _AUTO_SYNC_RUNNING.set()
    try:
        with SessionLocal() as db:
            cfg = get_bridge_config(db)
            if not (cfg.get("enabled") and cfg.get("auto_sync")):
                return 0
            limit = int(cfg.get("auto_sync_limit") or 20)
            client = client_from_config(cfg)
            try:
                rows = client.list_studies({"limit": str(limit), "offset": "0"})
            finally:
                client.close()
            imported = 0
            for row in rows:
                uid = str(row.get("study_instance_uid") or "")
                idx = row.get("study_idx")
                if not uid or idx is None or find_local_study_id(db, uid):
                    continue
                try:
                    result = import_study(db, cfg, int(idx))
                    if result["status"] == "done":
                        imported += 1
                except Exception:
                    logger.exception("WebPACS 자동 동기화 실패 study_idx=%s", idx)
            if imported:
                logger.info("WebPACS 자동 동기화: 신규 검사 %d건", imported)
            return imported
    except Exception:
        logger.exception("WebPACS 자동 동기화 오류")
        return 0
    finally:
        _AUTO_SYNC_RUNNING.clear()
