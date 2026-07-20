"""API 공통 의존성 — DB 세션, 인증 사용자."""
from __future__ import annotations

import jwt as pyjwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

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
__all__ = ["current_user", "admin_user", "require_perm", "require_effective", "get_db", "Session"]
