"""가입(공개) — 병원 + 초기 관리자 계정 + 라이선스/결재 등록.

흐름: 홈(소개) → 가입 → 로그인 → 병원별 페이지.
가입 시 병원(Hospital)과 그 병원의 초기 관리자(Account, role=admin)를 함께 생성한다.
⚠ 주민번호는 앞 6자리(생년월일)만 저장. 카드 전체번호 저장 금지(마지막 4자리만).
"""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.models import Account, AuditLog, Hospital
from app.services.auth_service import hash_password

router = APIRouter(prefix="/api/signup", tags=["signup"])


class HospitalInfo(BaseModel):
    name: str
    zip: str = ""                # 우편번호(주소 검색)
    address: str = ""
    address_detail: str = ""     # 상세주소(직접 입력)
    departments: str = ""        # 진료과(콤마 구분)
    phone: str = ""
    fax: str = ""
    homepage: str = ""
    license_clients: int = 1     # Client(뷰어) 수
    modality_limit: int = 0      # 연결할 Modality 수(0=무제한)


class Registrant(BaseModel):
    name: str                    # 이름(표시명)
    title: str = ""              # 직책
    sex: str = ""
    birth6: str = ""             # 주민번호 앞 6자리
    phone: str = ""
    mobile: str = ""
    email: str = ""
    username: str                # ID
    password: str
    password_confirm: str


class Billing(BaseModel):
    method: str = "monthly_transfer"   # monthly_transfer(월별이체·계산서) | card
    card_last4: str = ""               # 카드 등록 시 마지막 4자리만


class SignupBody(BaseModel):
    hospital: HospitalInfo
    registrant: Registrant
    billing: Billing = Field(default_factory=Billing)


def _slug_code(db: Session, name: str) -> str:
    """병원 코드 자동 생성 — 이름 영숫자 축약 + 일련번호."""
    base = re.sub(r"[^A-Za-z0-9]", "", name).upper()[:6] or "HOSP"
    n = db.execute(select(func.count()).select_from(Hospital)).scalar() or 0
    code = f"{base}{n + 1:03d}"
    while db.execute(select(Hospital).where(Hospital.code == code)).scalar_one_or_none():
        n += 1
        code = f"{base}{n + 1:03d}"
    return code


@router.post("")
def signup(body: SignupBody, db: Session = Depends(get_db)):
    if not get_settings().signup_enabled:
        raise HTTPException(status_code=403, detail="현재 온라인 가입이 비활성화되어 있습니다(관리자 문의)")
    r = body.registrant
    h = body.hospital
    if not h.name.strip():
        raise HTTPException(status_code=400, detail="병원 이름은 필수입니다")
    if not r.username.strip():
        raise HTTPException(status_code=400, detail="관리자 ID는 필수입니다")
    if r.password != r.password_confirm:
        raise HTTPException(status_code=400, detail="비밀번호 확인이 일치하지 않습니다")
    if len(r.password) < 8:
        raise HTTPException(status_code=400, detail="비밀번호는 8자 이상이어야 합니다")
    if r.birth6 and not re.fullmatch(r"\d{6}", r.birth6):
        raise HTTPException(status_code=400, detail="주민번호 앞자리는 숫자 6자리(생년월일)여야 합니다")
    if db.execute(select(Account).where(Account.username == r.username.strip())).scalar_one_or_none():
        raise HTTPException(status_code=409, detail="이미 존재하는 ID입니다")

    hospital = Hospital(
        code=_slug_code(db, h.name), name=h.name.strip(),
        zip=h.zip.strip()[:8], address=h.address.strip(), address_detail=h.address_detail.strip()[:256],
        departments=h.departments.strip(), phone=h.phone.strip(), fax=h.fax.strip(),
        homepage=h.homepage.strip(), contact=r.name.strip(),
        license_clients=max(0, h.license_clients), modality_limit=max(0, h.modality_limit),
        max_accounts=0, billing_method=body.billing.method,
        billing_card_last4=re.sub(r"\D", "", body.billing.card_last4)[-4:],
        enabled=True,
    )
    db.add(hospital)
    db.flush()
    from app.services.hospital_net import assign_hospital_dicom

    assign_hospital_dicom(hospital)  # 병원별 DICOM 포트/AET 자동 배정
    admin = Account(
        username=r.username.strip(), password_hash=hash_password(r.password),
        role="admin",  # 초기 가입자 = admin (요청 사양)
        hospital_id=hospital.id, display_name=r.name.strip()[:64], email=r.email.strip()[:128],
        title=r.title.strip()[:64], sex=r.sex.strip()[:8], birth6=r.birth6.strip()[:6],
        phone=r.phone.strip()[:32], mobile=r.mobile.strip()[:32], enabled=True,
    )
    db.add(admin)
    db.flush()
    db.add(AuditLog(account_id=admin.id, action="signup", target_type="hospital",
                    target_id=str(hospital.id),
                    detail={"hospital": hospital.name, "code": hospital.code,
                            "admin": admin.username, "license_clients": hospital.license_clients}))
    db.commit()
    return {
        "ok": True, "hospital_id": hospital.id, "hospital_code": hospital.code,
        "username": admin.username,
        "message": f"가입 완료 — '{hospital.name}'({hospital.code}) 관리자 계정 '{admin.username}'로 로그인하세요.",
    }


@router.get("/enabled")
def signup_enabled():
    """홈/가입 화면이 가입 가능 여부를 확인."""
    return {"enabled": get_settings().signup_enabled}


# 가입 환경 설정(관리자 콘솔 ⑦)의 공개 조회 — 가입 화면은 무인증이므로 /api/settings 대신 여기서 읽는다.
# 노출 정보는 입력 항목의 표시/필수 플래그뿐(민감정보 없음). 미설정=빈 목록 → 화면은 기존 기본 폼 유지.
SIGNUP_FIELD_KINDS = ("hospital", "client", "modality")


@router.get("/fields/{kind}")
def signup_fields(kind: str, db: Session = Depends(get_db)):
    if kind not in SIGNUP_FIELD_KINDS:
        raise HTTPException(status_code=404, detail="kind는 hospital|client|modality")
    from app.services.settings_service import get_setting

    value = get_setting(db, f"signup.fields.{kind}", default={}) or {}
    fields = value.get("fields")
    return {"kind": kind, "fields": fields if isinstance(fields, list) else []}
