"""보안 강화 API (레인 S) — Defender·무결성 감시·접근 보안. 전부 방어적 기능.

파일명 계약: main.py(레인 H)가 `from app.api import security` 를 guarded try-import 로 등록한다.
모든 엔드포인트는 관리자 전용 + IP allowlist(security.policy.admin_allowlist) 게이트를 거친다.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import admin_user
from app.db import get_db
from app.services import security_service

router = APIRouter(prefix="/api/security", tags=["security"])


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else ""


def guarded_admin(
    request: Request, db: Session = Depends(get_db), user: dict = Depends(admin_user)
) -> dict:
    """관리자 + IP allowlist 게이트 — 통합 단계에서 deps.admin_user 로 승격 가능(주석 계약)."""
    security_service.enforce_admin_allowlist(db, _client_ip(request))
    return user


# ════════════════════════════ ① 바이러스 / Defender ════════════════════════════
@router.get("/defender")
def get_defender(user: dict = Depends(guarded_admin)):
    """Windows Defender 상태 — 실시간 보호·서명 날짜·마지막 스캔 (미가용 시 available=False)."""
    return security_service.defender_status()


@router.post("/defender/scan")
def post_defender_scan(db: Session = Depends(get_db), user: dict = Depends(guarded_admin)):
    """빠른 스캔(QuickScan) 비동기 시작 — 완료를 기다리지 않는다."""
    return security_service.start_defender_scan(db, actor_id=user.get("uid"))


# ════════════════════════════ ② 랜섬 방지 / 무결성 감시 ════════════════════════════
@router.get("/integrity")
def get_integrity(db: Session = Depends(get_db), user: dict = Depends(guarded_admin)):
    """최근 스냅샷·경고 이력 — 자동 차단 없음(탐지·경고 전용)."""
    return security_service.get_integrity_state(db)


@router.post("/integrity/scan")
def post_integrity_scan(db: Session = Depends(get_db), user: dict = Depends(guarded_admin)):
    """즉시 무결성 검사 — 스냅샷 기록 + 대량 변화·의심 확장자·백업 변조 감지."""
    return security_service.run_integrity_scan(db, actor_id=user.get("uid"))


# ════════════════════════════ ③ 접근 보안 — 정책·잠금 ════════════════════════════
class PolicyBody(BaseModel):
    value: dict


@router.get("/policy")
def get_policy(db: Session = Depends(get_db), user: dict = Depends(guarded_admin)):
    return {"key": security_service.POLICY_KEY, "value": security_service.get_policy(db)}


@router.put("/policy")
def put_policy(
    body: PolicyBody, request: Request,
    db: Session = Depends(get_db), user: dict = Depends(guarded_admin),
):
    """정책 저장 — allowlist 에 현재 IP 미포함이면 저장하되 warning 반환(자기 잠금 방지)."""
    policy, warning = security_service.set_policy(
        db, body.value, client_ip=_client_ip(request), actor_id=user.get("uid"))
    return {"ok": True, "value": policy, "warning": warning}


class LockoutResetBody(BaseModel):
    key: str = ""  # "user:이름" | "ip:주소" | 빈 값 = 전체 해제


@router.post("/lockouts/reset")
def post_lockouts_reset(
    body: LockoutResetBody, db: Session = Depends(get_db), user: dict = Depends(guarded_admin)
):
    """잠금 해제(관리자) — 감사 로그 기록."""
    from app.models import AuditLog

    n = security_service.clear_lockout(body.key)
    db.add(AuditLog(account_id=user.get("uid"), action="security_lockout_reset",
                    target_type="security", target_id=body.key or "(전체)", detail={"cleared": n}))
    db.commit()
    return {"ok": True, "cleared": n, "lockouts": security_service.lockout_overview()}


# ════════════════════════════ ④ 종합 요약 ════════════════════════════
@router.get("/summary")
def get_summary(db: Session = Depends(get_db), user: dict = Depends(guarded_admin)):
    """보안 대시보드 종합 — defender·무결성·잠금 현황·allowlist·로그인 실패 통계."""
    return security_service.security_summary(db)
