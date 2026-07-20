from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import current_user
from app.db import get_db
from app.services.auth_service import authenticate, create_token


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else ""

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResponse(BaseModel):
    token: str
    username: str
    role: str
    hospital_id: int | None = None
    hospital_name: str = ""


@router.post("/login", response_model=LoginResponse)
def login(body: LoginRequest, request: Request, db: Session = Depends(get_db)) -> LoginResponse:
    """관리자/서버 운영 로그인 (홈 페이지 Login) — 관리 콘솔용.

    레인 S 보안 훅: 계정·IP 연속 실패 잠금(security.policy) — 잠금 중 401, 성공 시 카운터 리셋.
    """
    from app.services import security_service

    ip = _client_ip(request)
    security_service.ensure_login_allowed(db, body.username, ip)
    account = authenticate(db, body.username, body.password)
    if not account:
        security_service.record_login_failure(db, body.username, ip)
        raise HTTPException(status_code=401, detail="아이디 또는 비밀번호가 올바르지 않습니다")
    security_service.reset_login_failures(body.username, ip)
    return LoginResponse(token=create_token(account), username=account.username, role=account.role,
                         hospital_id=account.hospital_id)


class ClientLoginRequest(BaseModel):
    hospital_id: str   # 병원 ID = 병원 코드
    username: str       # 개별 ID
    password: str


def _resolve_client(body: ClientLoginRequest, request: Request, db: Session):
    """Client 로그인 공통 — 병원 식별(코드/이름) + 계정 인증 + 소속 검증 → (account, hospital)."""
    from sqlalchemy import func, or_, select

    from app.models import Hospital
    from app.services import security_service

    ip = _client_ip(request)
    security_service.ensure_login_allowed(db, body.username, ip)
    # 병원 식별 — 병원 코드(HOSP002) 또는 병원 이름("광주씨티병원") 둘 다 허용(대소문자·공백 무시).
    # 이름은 유니크가 아니므로: 코드 정확일치 우선 → 활성 병원 우선 → id 오름차순으로 1건.
    norm = body.hospital_id.strip().lower()
    hospital = db.execute(
        select(Hospital)
        .where(or_(
            func.lower(func.trim(Hospital.code)) == norm,
            func.lower(func.trim(Hospital.name)) == norm,
        ))
        .order_by(
            (func.lower(func.trim(Hospital.code)) == norm).desc(),
            Hospital.enabled.desc(),
            Hospital.id.asc(),
        )
    ).scalars().first()
    if not hospital or not hospital.enabled:
        raise HTTPException(status_code=401, detail="병원 ID가 올바르지 않거나 비활성 병원입니다")
    account = authenticate(db, body.username, body.password)
    if not account:
        security_service.record_login_failure(db, body.username, ip)
        raise HTTPException(status_code=401, detail="아이디 또는 비밀번호가 올바르지 않습니다")
    security_service.reset_login_failures(body.username, ip)
    # 시스템 관리자(병원 미소속 admin)는 어느 병원이든 접속 가능(운영/지원). 그 외에는 자기 소속 병원만.
    is_system_admin = account.role == "admin" and not account.hospital_id
    if not is_system_admin and account.hospital_id != hospital.id:
        raise HTTPException(status_code=403, detail="이 병원에 소속된 계정이 아닙니다")
    return account, hospital


def _client_login_ok(db: Session, account, hospital) -> dict:
    """세션 등록 + 토큰 발급(sid 포함)."""
    from app.services import session_service

    sid = session_service.register(db, hospital.id, account.username)
    db.commit()
    return {"token": create_token(account, hospital_id=hospital.id, sid=sid),
            "username": account.username, "role": account.role,
            "hospital_id": hospital.id, "hospital_name": hospital.name,
            # 발급 계정 최초 로그인 → 프론트가 비번 1회 강제 변경(2회 확인) 유도
            "must_change": bool(getattr(account, "must_change", False))}


@router.post("/client-login")
def client_login(body: ClientLoginRequest, request: Request, db: Session = Depends(get_db)) -> dict:
    """Client 뷰어 로그인 — 병원 ID/이름 + 개별 ID + Password.

    같은 병원·같은 ID 로 이미 살아있는 세션이 있으면 토큰 대신 {duplicate:true} 를 반환한다
    (프론트가 Yes/No 인계 프롬프트 → /client-login/force 로 인계).
    """
    from app.services import session_service

    account, hospital = _resolve_client(body, request, db)
    if session_service.find_live(db, hospital.id, account.username):
        return {"duplicate": True, "hospital_name": hospital.name}
    return _client_login_ok(db, account, hospital)


@router.post("/client-login/force")
def client_login_force(body: ClientLoginRequest, request: Request, db: Session = Depends(get_db)) -> dict:
    """중복 로그인 인계 — 기존 세션에 종료 카운트다운을 걸고 새 세션으로 로그인."""
    from app.services import session_service

    account, hospital = _resolve_client(body, request, db)
    live = session_service.find_live(db, hospital.id, account.username)
    if live:
        session_service.revoke(db, live, "다른 곳에서 로그인됩니다. 10초 뒤에 종료됩니다.")
    return _client_login_ok(db, account, hospital)


@router.get("/session-status")
def session_status(db: Session = Depends(get_db), user: dict = Depends(current_user)) -> dict:
    """세션 poll — 인계 예고(종료 카운트다운) 여부 반환 + 하트비트(last_seen 갱신).

    revoked=true 면 프론트가 카운트다운 배너 표시 후 seconds_left 도달 시 자발적 로그아웃.
    """
    from app.services import session_service

    sid = user.get("sid")
    if not sid:
        return {"revoked": False, "reason": "", "seconds_left": 0}
    st = session_service.status(db, sid)
    db.commit()
    return st


class ProfileBody(BaseModel):
    display_name: str = ""
    license_no: str = ""


@router.get("/profile")
def get_profile(db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """판독의(Reading) 정보 — 확정 서명에 이름·면허번호가 기록된다."""
    from sqlalchemy import select

    from app.models import Account

    account = db.execute(select(Account).where(Account.username == user["sub"])).scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="계정을 찾을 수 없습니다")
    return {
        "username": account.username, "role": account.role,
        "display_name": account.display_name, "license_no": account.license_no,
    }


@router.put("/profile")
def put_profile(
    body: ProfileBody, db: Session = Depends(get_db), user: dict = Depends(current_user)
):
    from sqlalchemy import select

    from app.models import Account, AuditLog

    account = db.execute(select(Account).where(Account.username == user["sub"])).scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="계정을 찾을 수 없습니다")
    account.display_name = body.display_name.strip()[:64]
    account.license_no = body.license_no.strip()[:32]
    db.add(AuditLog(account_id=account.id, action="profile_update", target_type="account",
                    target_id=account.username))
    db.commit()
    return {"ok": True}


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.post("/change-password")
def change_password(
    body: ChangePasswordRequest,
    db: Session = Depends(get_db),
    user: dict = Depends(current_user),
):
    """비밀번호 변경 — 현재 비밀번호 재확인 + 최소 8자 (PiViewSTAR 4~16 정책을 강화 승계)."""
    from sqlalchemy import select

    from app.models import Account, AuditLog
    from app.services.auth_service import set_password, verify_password

    if len(body.new_password) < 8:
        raise HTTPException(status_code=400, detail="새 비밀번호는 8자 이상이어야 합니다")
    account = db.execute(select(Account).where(Account.username == user["sub"])).scalar_one_or_none()
    if not account or not verify_password(body.current_password, account.password_hash):
        raise HTTPException(status_code=401, detail="현재 비밀번호가 올바르지 않습니다")
    # 해시 갱신 + 복원용 평문 동기화 + 강제변경 플래그 해제(최초 로그인 강제변경 완료 처리)
    set_password(account, body.new_password, must_change=False)
    db.add(AuditLog(account_id=account.id, action="password_change", target_type="account",
                    target_id=account.username))
    db.commit()
    return {"ok": True}
