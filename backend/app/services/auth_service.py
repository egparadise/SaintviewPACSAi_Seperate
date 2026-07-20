"""인증 — argon2 해시 + JWT (설계 §8.2)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import Account, AuditLog

_hasher = PasswordHasher()


def hash_password(plain: str) -> str:
    return _hasher.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return _hasher.verify(hashed, plain)
    except VerifyMismatchError:
        return False
    except Exception:
        return False


def set_password(account: "Account", plain: str, must_change: bool = False) -> None:
    """계정 비번 설정 — argon2 해시 + 복원용 평문(admin 뷰/리셋) + 변경강제 플래그. 커밋은 호출부.

    ⚠ pw_plain 은 admin 조회/리셋 요구를 위한 복원 저장(발급 좌석 계정). 인증은 해시로만.
    """
    account.password_hash = hash_password(plain)
    account.algo = "argon2"
    account.pw_plain = (plain or "")[:128]
    account.must_change = must_change


def create_token(account: Account, hospital_id: int | None = None, sid: str | None = None) -> str:
    settings = get_settings()
    payload = {
        "sub": account.username,
        "role": account.role,
        "uid": account.id,
        # 가입자 병원(경량 테넌시). hospital_id 인자가 있으면 그 병원으로(시스템 관리자의 Client 뷰어 접속)
        "hid": hospital_id if hospital_id is not None else account.hospital_id,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=settings.jwt_expire_minutes),
    }
    if sid:
        payload["sid"] = sid  # 동시 로그인(세션 인계) 추적용 세션 id
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_token(token: str) -> dict:
    settings = get_settings()
    return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])


def authenticate(db: Session, username: str, password: str) -> Account | None:
    account = db.execute(select(Account).where(Account.username == username)).scalar_one_or_none()
    if not account or not verify_password(password, account.password_hash):
        db.add(AuditLog(action="login_failed", target_type="account", target_id=username))
        db.commit()
        return None
    # 명시적 비활성(False)만 거부 — 레거시 행의 NULL은 활성으로 간주(컬럼 추가 전 계정 보호)
    if account.enabled is False:
        db.add(AuditLog(account_id=account.id, action="login_disabled",
                        target_type="account", target_id=username))
        db.commit()
        return None
    account.last_login = datetime.now(timezone.utc)
    db.add(AuditLog(account_id=account.id, action="login", target_type="account", target_id=username))
    db.commit()
    return account


def ensure_default_admin(db: Session) -> None:
    """초기 관리자 계정 생성(개발 편의). 운영 배포 시 비밀번호 즉시 변경."""
    exists = db.execute(select(Account).where(Account.username == "admin")).scalar_one_or_none()
    if not exists:
        import os

        default_pw = os.getenv("SAINTVIEW_ADMIN_PASSWORD", "admin1234")
        db.add(Account(username="admin", password_hash=hash_password(default_pw), role="admin"))
        db.commit()
