"""API 공통 의존성 — DB 세션, 인증 사용자."""
from __future__ import annotations

import os

import jwt as pyjwt
from fastapi import Cookie, Depends, HTTPException, Response, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.services.auth_service import decode_token

_bearer = HTTPBearer(auto_error=False)


def current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict:
    if creds is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="인증이 필요합니다")
    try:
        return decode_token(creds.credentials)
    except pyjwt.PyJWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="유효하지 않은 토큰입니다")


def download_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    token: str = "",
) -> dict:
    """다운로드 전용 인증 — 헤더가 없으면 ?token= 을 받는다.

    브라우저의 파일 내려받기(location 이동·<a download>)는 Authorization 헤더를 붙일 수 없다.
    그래서 이 통로만 쿼리 토큰을 허용한다. 검증은 current_user 와 같은 decode_token 이고,
    쓰는 곳은 반출 패키지(ZIP/ISO) 하나뿐이다.
    """
    raw = creds.credentials if creds else token
    if not raw:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="인증이 필요합니다")
    try:
        return decode_token(raw)
    except pyjwt.PyJWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="유효하지 않은 토큰입니다")


# ── 픽셀 GET 전용 인증 (HttpOnly 세션 쿠키) ──────────────────────────────────
# 문제: 썸네일·rendered 는 <img src="…"> 가 요청한다. <img> 에는 Authorization 헤더를
#       붙일 방법이 없어서 이 두 엔드포인트만 무인증으로 열려 있었다(PHI 픽셀).
#       (/api/htj2k/* 는 이미 current_user 를 요구한다 — cornerstone 이 fetch/XHR 이라
#        헤더를 붙일 수 있기 때문이다. 즉 문제는 '픽셀'이 아니라 '<img src>' 하나다.)
#
# 왜 쿠키인가 — 버린 대안과 그 이유:
#   (B) 서명 URL(HMAC) / (C) 세션 결합 쿼리 토큰 — 둘 다 자격증명이 URL 에 들어간다.
#       · nginx 기본 combined 로그의 $request 에 쿼리가 그대로 남는다(deploy/nginx-viewer.conf
#         에는 log_format 지시자가 없어 상위 기본을 상속한다). 리퍼러·히스토리도 마찬가지다.
#       · 결정타: webpacs_live._TREE_CACHE 는 series-tree 를 vid 키로 30초 캐시하고
#         ("구조는 사용자 무관"), 썸네일 preview_url 은 그 캐시되는 트리 안에서 만들어진다.
#         URL 에 사용자별 비밀을 실으면 30초 동안 A 사용자의 토큰이 B 사용자에게 배달된다.
#       · liveUids.previewUrlOf 가 renderedUrl.split("?")[0] 로 쿼리를 통째로 버린다 →
#         2단계 저해상 미리보기(preview=1)가 즉시 깨진다.
#       · 브라우저 캐시 키는 URL 전체다 → rendered 의 ETag/304 와 max-age=3600,
#         thumb 의 max-age=86400 이 회전하는 자격증명 때문에 전부 무효화된다.
#   (A) HttpOnly 쿠키 — URL 도 응답 본문도 전혀 바뀌지 않는다. 위 네 문제가 하나도 없고
#       프론트 수정도 사실상 없다. 개발(vite 는 인증서 없으면 기동 거부 = https 고정)과
#       운영(nginx 443) 양쪽 모두 HTTPS 라 Secure 쿠키가 dev 에서도 성립한다.
#
# CSRF 는 설계상 성립하지 않는다: 이 쿠키를 받는 곳은 이 의존성(픽셀 GET) 뿐이고 상태변경
# 엔드포인트는 전부 Bearer 전용이다. 교차 사이트에서 위조한 GET 이 얻는 것은 '읽을 수 없는
# 이미지 한 장'이 전부이며, SameSite=Lax + Path 스코프면 애초에 전송되지도 않는다.
#
# 쿠키 값은 JWT 가 아니라 불투명 sid 다. JWT 를 담으면 유출 시 나머지 API 전체의 만능
# 자격증명이 되고 만료(기본 8시간)까지 취소할 수 없다. sid 는 session_service 가 매 요청
# 조회하므로 로그아웃·중복 로그인 인계가 즉시 반영된다.
PIXEL_COOKIE = "sv_pix"
# Path 스코프 — 이 쿠키는 Live 픽셀 경로 밖으로는 아예 전송되지 않는다(노출·CSRF 표면 축소).
# rendered(/dicom-web/…)·thumb(/thumb/…) 둘 다 이 접두사 아래에 있다.
PIXEL_COOKIE_PATH = "/api/webpacs/live"


def _pixel_cookie_attrs() -> dict:
    """쿠키 속성 — 기본 Secure + SameSite=Lax.

    SameSite=None 스위치가 필요한 이유: VITE_API_BASE 에 절대 URL 을 넣어 API 를 다른
    호스트에 두는 배치(docs/INTEGRATION.md 에 문서화된 지원 옵션)에서는 Lax 쿠키가
    아예 붙지 않는다. 그 배치에서만 SAINTVIEW_PIXEL_COOKIE_SAMESITE=none 으로 내린다
    (기본을 none 으로 두지 않는 이유는 그 순간 CSRF 표면이 생기기 때문).
    포트만 다른 배치(VITE_VIEWER_BASE=5176)는 쿠키가 포트를 구분하지 않아 Lax 로 정상 동작한다.
    """
    samesite = os.getenv("SAINTVIEW_PIXEL_COOKIE_SAMESITE", "lax").strip().lower()
    if samesite not in ("lax", "strict", "none"):
        samesite = "lax"
    secure = os.getenv("SAINTVIEW_PIXEL_COOKIE_SECURE", "1").strip() != "0"
    if samesite == "none":
        secure = True   # 브라우저 규칙 — SameSite=None 은 Secure 없으면 거부된다
    return {"httponly": True, "secure": secure, "samesite": samesite, "path": PIXEL_COOKIE_PATH}


def set_pixel_cookie(response: Response, sid: str) -> None:
    """로그인 성공 경로에서 픽셀 쿠키 발급. 수명은 JWT 만료와 동일하게 맞춘다."""
    if not sid:
        return
    response.set_cookie(PIXEL_COOKIE, sid,
                        max_age=max(1, get_settings().jwt_expire_minutes) * 60,
                        **_pixel_cookie_attrs())


def clear_pixel_cookie(response: Response) -> None:
    """로그아웃 — 쿠키 폐기. HttpOnly 라 JS 로는 못 지우므로 서버가 반드시 지워야 한다."""
    attrs = _pixel_cookie_attrs()
    response.delete_cookie(PIXEL_COOKIE, path=attrs["path"], httponly=True,
                           secure=attrs["secure"], samesite=attrs["samesite"])


def pixel_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    sv_pix: str | None = Cookie(default=None),
    db: Session = Depends(get_db),
) -> dict:
    """픽셀 GET 전용 인증 — Bearer 우선, 없으면 픽셀 쿠키(sv_pix = 불투명 sid).

    Bearer 를 먼저 받는 이유: 기존 호출자(fetch/XHR 로 rendered 를 받는 경로, 테스트,
    타 클라이언트)가 그대로 동작해야 한다. 쿠키는 <img> 를 위한 가산적 통로일 뿐이다.

    ⚠ 재사용 금지 — 이 의존성은 GET 픽셀 엔드포인트에만 붙인다. 다른 라우터에 붙이는
      순간 '쿠키를 받는 표면'이 늘어나 지금은 0 인 CSRF 표면이 생긴다.
    """
    if creds is not None:
        try:
            return decode_token(creds.credentials)
        except pyjwt.PyJWTError:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                                detail="유효하지 않은 토큰입니다")
    if sv_pix:
        from app.services import session_service

        found = session_service.pixel_session(db, sv_pix)
        if found is not None:
            return found
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="세션이 만료되었거나 종료되었습니다")
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="인증이 필요합니다")


# ── WebSocket 인증 (협진) ────────────────────────────────────────────────────
# 브라우저 WebSocket API 는 요청 헤더를 못 붙인다 — Authorization 을 실을 방법이 없다.
# 그래서 표준 우회로인 **서브프로토콜**에 토큰을 싣는다: `Sec-WebSocket-Protocol: sv.bearer, <jwt>`.
#
# 왜 ?token= 쿼리가 아닌가 — 이 파일 위쪽(픽셀 쿠키 주석)이 이미 답을 적어 뒀다:
#   nginx 기본 combined 로그의 $request 에 쿼리가 그대로 남고, 리퍼러·히스토리도 마찬가지다.
#   WS 는 연결이 몇 시간씩 살아 있어 그 한 줄이 오래 남는 로그가 된다.
# JWT 의 문자 집합(base64url + '.')은 RFC 7230 token 문자에 모두 포함되므로 서브프로토콜
# 값으로 적법하다. 서버는 선택한 서브프로토콜(sv.bearer)을 반드시 echo 해야 브라우저가
# 핸드셰이크를 받아들인다.
WS_SUBPROTOCOL = "sv.bearer"


def ws_token(websocket) -> str | None:
    """핸드셰이크 헤더에서 JWT 추출 — 형식이 아니면 None."""
    raw = websocket.headers.get("sec-websocket-protocol", "")
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    if len(parts) < 2 or parts[0] != WS_SUBPROTOCOL:
        return None
    return parts[1]


def ws_user(websocket) -> dict | None:
    """WS 핸드셰이크 인증 → 사용자 dict, 실패면 None(호출부가 close 코드를 정한다).

    검증은 HTTP 경로와 **완전히 같은** decode_token 이다 — 인증 규칙이 두 벌로 갈리지 않게.
    """
    tok = ws_token(websocket)
    if not tok:
        return None
    try:
        return decode_token(tok)
    except pyjwt.PyJWTError:
        return None


def admin_user(user: dict = Depends(current_user)) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="관리자 권한이 필요합니다")
    return user


def require_perm(perm: str):
    """역할 기반 권한 게이트 — app.services.permissions 매트릭스 사용."""
    from app.services.permissions import has_perm

    def _dep(user: dict = Depends(current_user)) -> dict:
        if not has_perm(user.get("role", ""), perm):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="이 작업에 대한 권한이 없습니다"
            )
        return user

    return _dep


def require_effective(perm: str):
    """병원별 오버라이드('perm.matrix')를 반영한 유효 권한 게이트.

    require_perm 과 달리 사용자의 소속 병원(hid) 매트릭스를 반영한다
    (판독 작성/확정, 영상 관리 등 병원별 등급 권한 강제 지점용).
    """
    from app.services.permissions import effective_perms

    def _dep(db: Session = Depends(get_db), user: dict = Depends(current_user)) -> dict:
        if perm not in effective_perms(db, user.get("role", ""), user.get("hid")):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="이 작업에 대한 권한이 없습니다"
            )
        return user

    return _dep


DbSession = Depends(get_db)
__all__ = ["current_user", "download_user", "pixel_user", "admin_user", "require_perm",
           "require_effective", "get_db", "Session",
           "PIXEL_COOKIE", "PIXEL_COOKIE_PATH", "set_pixel_cookie", "clear_pixel_cookie",
           "WS_SUBPROTOCOL", "ws_token", "ws_user"]
