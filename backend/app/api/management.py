"""서버 관리(Admin) — 가입자 병원 · 계정/역할 · 등록 장비(SCU/SCP) · SCP 수신 제어.

요청 사양: Modality 등록·관리, 등록 장비만 수신, SCP 포트 개폐, 병원/계정/권한.
계층: 라우터(검증·감사) → repositories(DB). 도메인 규칙은 permissions/auth_service 재사용.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import current_user, require_perm
from app.db import get_db
from app.models import Account, AuditLog, BackupJob, Hospital, Modality, Study
from app.services.auth_service import hash_password
from app.services.permissions import ROLES, role_catalog
from app.services.settings_service import get_setting, set_setting

router = APIRouter(prefix="/api/admin", tags=["management"])


# ════════════════════════════════ 역할/권한 매트릭스 ════════════════════════════════
@router.get("/roles")
def roles(user: dict = Depends(current_user)):
    """역할·권한 카탈로그 — 계정 생성 화면용."""
    return role_catalog()


# ════════════════════════════════ 가입자 병원 ════════════════════════════════
class HospitalBody(BaseModel):
    code: str
    name: str = ""
    ae_title: str = ""
    address: str = ""
    phone: str = ""
    fax: str = ""
    homepage: str = ""
    departments: str = ""
    contact: str = ""
    max_accounts: int = 0
    license_clients: int = 0
    modality_limit: int = 0
    enforce_isolation: bool = False
    enabled: bool = True
    note: str = ""
    # 병원별 DICOM 네트워크
    server_host: str = ""
    scp_aet: str = ""
    scp_port: int = 0
    qr_aet: str = ""
    qr_port: int = 0


def _hospital_dict(h: Hospital, account_count: int = 0) -> dict:
    return {
        "id": h.id, "code": h.code, "name": h.name, "ae_title": h.ae_title,
        "address": h.address, "phone": h.phone, "fax": h.fax, "homepage": h.homepage,
        "departments": h.departments, "contact": h.contact,
        "max_accounts": h.max_accounts, "license_clients": h.license_clients,
        "modality_limit": h.modality_limit, "enforce_isolation": h.enforce_isolation,
        "enabled": h.enabled, "note": h.note, "account_count": account_count,
        "server_host": h.server_host, "scp_aet": h.scp_aet, "scp_port": h.scp_port,
        "qr_aet": h.qr_aet, "qr_port": h.qr_port,
        "created_at": h.created_at.isoformat() if h.created_at else None,
    }


@router.get("/hospitals")
def list_hospitals(db: Session = Depends(get_db), user: dict = Depends(require_perm("hospitals.manage"))):
    rows = db.execute(select(Hospital).order_by(Hospital.id)).scalars().all()
    counts = dict(
        db.execute(
            select(Account.hospital_id, func.count()).group_by(Account.hospital_id)
        ).all()
    )
    return {"items": [_hospital_dict(h, counts.get(h.id, 0)) for h in rows]}


@router.post("/hospitals")
def create_hospital(body: HospitalBody, db: Session = Depends(get_db),
                    user: dict = Depends(require_perm("hospitals.manage"))):
    code = body.code.strip()
    if not code:
        raise HTTPException(status_code=400, detail="병원 코드는 필수입니다")
    if db.execute(select(Hospital).where(Hospital.code == code)).scalar_one_or_none():
        raise HTTPException(status_code=409, detail="이미 존재하는 병원 코드입니다")
    h = Hospital(
        code=code, name=body.name.strip(), ae_title=body.ae_title.strip().upper(),
        address=body.address.strip(), phone=body.phone.strip(), fax=body.fax.strip(),
        homepage=body.homepage.strip(), departments=body.departments.strip(),
        contact=body.contact.strip(), max_accounts=max(0, body.max_accounts),
        license_clients=max(0, body.license_clients), modality_limit=max(0, body.modality_limit),
        enforce_isolation=body.enforce_isolation, enabled=body.enabled, note=body.note.strip(),
        server_host=body.server_host.strip(), scp_aet=body.scp_aet.strip().upper(),
        scp_port=body.scp_port, qr_aet=body.qr_aet.strip().upper(), qr_port=body.qr_port,
    )
    db.add(h)
    db.flush()
    from app.services.hospital_net import assign_hospital_dicom

    assign_hospital_dicom(h)  # 병원별 포트/AET 자동 배정(미설정 시)
    db.add(AuditLog(account_id=user.get("uid"), action="hospital_create",
                    target_type="hospital", target_id=str(h.id), detail={"code": code}))
    db.commit()
    return _hospital_dict(h)


@router.put("/hospitals/{hid}")
def update_hospital(hid: int, body: HospitalBody, db: Session = Depends(get_db),
                    user: dict = Depends(require_perm("hospitals.manage"))):
    h = db.get(Hospital, hid)
    if not h:
        raise HTTPException(status_code=404, detail="병원을 찾을 수 없습니다")
    if body.code.strip() and body.code.strip() != h.code:
        if db.execute(select(Hospital).where(Hospital.code == body.code.strip())).scalar_one_or_none():
            raise HTTPException(status_code=409, detail="이미 존재하는 병원 코드입니다")
        h.code = body.code.strip()
    h.name = body.name.strip()
    h.ae_title = body.ae_title.strip().upper()
    h.address = body.address.strip()
    h.phone = body.phone.strip()
    h.fax = body.fax.strip()
    h.homepage = body.homepage.strip()
    h.departments = body.departments.strip()
    h.contact = body.contact.strip()
    h.max_accounts = max(0, body.max_accounts)
    h.license_clients = max(0, body.license_clients)
    h.modality_limit = max(0, body.modality_limit)
    h.enforce_isolation = body.enforce_isolation
    h.enabled = body.enabled
    h.note = body.note.strip()
    h.server_host = body.server_host.strip()
    h.scp_aet = body.scp_aet.strip().upper()
    h.scp_port = body.scp_port
    h.qr_aet = body.qr_aet.strip().upper()
    h.qr_port = body.qr_port
    db.add(AuditLog(account_id=user.get("uid"), action="hospital_update",
                    target_type="hospital", target_id=str(hid)))
    db.commit()
    return _hospital_dict(h)


@router.post("/hospitals/{hid}/claim-studies")
def claim_studies(hid: int, db: Session = Depends(get_db),
                  user: dict = Depends(require_perm("hospitals.manage"))):
    """미배정(hospital_id NULL) 검사를 이 병원에 일괄 귀속 — Client 뷰어에서 보이도록.

    수신 AET가 등록 장비와 매칭되지 않아 병원이 비어있는 검사를 운영자가 배정한다.
    """
    from app.models import Study

    h = db.get(Hospital, hid)
    if not h:
        raise HTTPException(status_code=404, detail="병원을 찾을 수 없습니다")
    orphans = db.execute(select(Study).where(Study.hospital_id.is_(None))).scalars().all()
    for s in orphans:
        s.hospital_id = hid
    db.add(AuditLog(account_id=user.get("uid"), action="claim_studies",
                    target_type="hospital", target_id=str(hid), detail={"count": len(orphans)}))
    db.commit()
    return {"ok": True, "assigned": len(orphans)}


@router.post("/hospitals/{hid}/net-test")
def hospital_net_test(hid: int, db: Session = Depends(get_db),
                      user: dict = Depends(require_perm("hospitals.manage"))):
    """병원 DICOM 네트워크 연결 점검 — 수신(SCP)·조회(Q/R) 엔드포인트 TCP+C-ECHO."""
    from app.services.hospital_net import test_endpoint

    h = db.get(Hospital, hid)
    if not h:
        raise HTTPException(status_code=404, detail="병원을 찾을 수 없습니다")
    return {
        "scp": test_endpoint(h.server_host, h.scp_port, h.scp_aet),
        "qr": test_endpoint(h.server_host, h.qr_port, h.qr_aet),
    }


@router.delete("/hospitals/{hid}")
def delete_hospital(hid: int, db: Session = Depends(get_db),
                    user: dict = Depends(require_perm("hospitals.manage"))):
    h = db.get(Hospital, hid)
    if not h:
        raise HTTPException(status_code=404, detail="병원을 찾을 수 없습니다")
    if db.execute(select(func.count()).select_from(Account).where(Account.hospital_id == hid)).scalar():
        raise HTTPException(status_code=409, detail="소속 계정이 있어 삭제할 수 없습니다(먼저 계정을 이전/삭제)")
    db.delete(h)
    db.add(AuditLog(account_id=user.get("uid"), action="hospital_delete",
                    target_type="hospital", target_id=str(hid)))
    db.commit()
    return {"ok": True}


# ════════════════════════════════ 계정/역할 ════════════════════════════════
class AccountCreate(BaseModel):
    username: str
    password: str
    role: str = "radiologist"
    hospital_id: int | None = None
    display_name: str = ""
    license_no: str = ""
    email: str = ""
    enabled: bool = True


class AccountUpdate(BaseModel):
    role: str | None = None
    hospital_id: int | None = None
    display_name: str | None = None
    license_no: str | None = None
    email: str | None = None
    enabled: bool | None = None
    password: str | None = None  # 있으면 비밀번호 재설정


def _account_dict(a: Account, hospital_name: str = "") -> dict:
    return {
        "id": a.id, "username": a.username, "role": a.role,
        "role_label": ROLES.get(a.role, a.role),
        "hospital_id": a.hospital_id, "hospital_name": hospital_name,
        "display_name": a.display_name, "license_no": a.license_no,
        "email": a.email, "enabled": a.enabled,
        "last_login": a.last_login.isoformat() if a.last_login else None,
    }


def _hospital_names(db: Session) -> dict[int, str]:
    return {h.id: (h.name or h.code) for h in db.execute(select(Hospital)).scalars().all()}


@router.get("/accounts")
def list_accounts(db: Session = Depends(get_db), user: dict = Depends(require_perm("users.manage"))):
    names = _hospital_names(db)
    rows = db.execute(select(Account).order_by(Account.id)).scalars().all()
    return {"items": [_account_dict(a, names.get(a.hospital_id, "")) for a in rows]}


def _validate_role_hospital(db: Session, role: str, hospital_id: int | None) -> None:
    if role not in ROLES:
        raise HTTPException(status_code=400, detail=f"알 수 없는 역할: {role}")
    if hospital_id is not None and not db.get(Hospital, hospital_id):
        raise HTTPException(status_code=400, detail="존재하지 않는 병원입니다")


@router.post("/accounts")
def create_account(body: AccountCreate, db: Session = Depends(get_db),
                   user: dict = Depends(require_perm("users.manage"))):
    username = body.username.strip()
    if not username or len(body.password) < 8:
        raise HTTPException(status_code=400, detail="아이디 필수 · 비밀번호는 8자 이상")
    if db.execute(select(Account).where(Account.username == username)).scalar_one_or_none():
        raise HTTPException(status_code=409, detail="이미 존재하는 아이디입니다")
    _validate_role_hospital(db, body.role, body.hospital_id)
    # 관리자 계정 등록은 시스템 관리자만 — users.manage 가 위임되어도 admin 생성은 불가(권한 상승 방지)
    if body.role == "admin" and user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="관리자 계정은 시스템 관리자만 등록할 수 있습니다")
    # 라이선스(병원 계정 수) 검사
    if body.hospital_id is not None:
        h = db.get(Hospital, body.hospital_id)
        if h and h.max_accounts > 0:
            cur = db.execute(
                select(func.count()).select_from(Account).where(Account.hospital_id == h.id)
            ).scalar() or 0
            if cur >= h.max_accounts:
                raise HTTPException(status_code=409,
                                    detail=f"라이선스 한도 초과({h.max_accounts}계정)")
    a = Account(
        username=username, password_hash=hash_password(body.password), role=body.role,
        hospital_id=body.hospital_id, display_name=body.display_name.strip()[:64],
        license_no=body.license_no.strip()[:32], email=body.email.strip()[:128],
        enabled=body.enabled,
    )
    db.add(a)
    db.flush()
    db.add(AuditLog(account_id=user.get("uid"), action="account_create",
                    target_type="account", target_id=username, detail={"role": body.role}))
    db.commit()
    names = _hospital_names(db)
    return _account_dict(a, names.get(a.hospital_id, ""))


@router.put("/accounts/{aid}")
def update_account(aid: int, body: AccountUpdate, db: Session = Depends(get_db),
                   user: dict = Depends(require_perm("users.manage"))):
    a = db.get(Account, aid)
    if not a:
        raise HTTPException(status_code=404, detail="계정을 찾을 수 없습니다")
    # 자기 자신 비활성/강등 방지
    if a.id == user.get("uid"):
        if body.enabled is False:
            raise HTTPException(status_code=400, detail="자기 계정은 비활성화할 수 없습니다")
        if body.role and body.role != "admin":
            raise HTTPException(status_code=400, detail="자기 계정의 관리자 권한은 해제할 수 없습니다")
    if body.role is not None or body.hospital_id is not None:
        new_role = body.role if body.role is not None else a.role
        new_hid = body.hospital_id if body.hospital_id is not None else a.hospital_id
        _validate_role_hospital(db, new_role, new_hid)
        # 관리자 승격도 시스템 관리자만 (생성 가드와 동일한 권한 상승 방지)
        if new_role == "admin" and a.role != "admin" and user.get("role") != "admin":
            raise HTTPException(status_code=403, detail="관리자 승격은 시스템 관리자만 할 수 있습니다")
        # 마지막 관리자 보호
        if a.role == "admin" and new_role != "admin":
            other_admin = db.execute(
                select(func.count()).select_from(Account).where(
                    Account.role == "admin", Account.enabled.is_(True), Account.id != a.id
                )
            ).scalar() or 0
            if other_admin == 0:
                raise HTTPException(status_code=400, detail="마지막 관리자는 강등할 수 없습니다")
        a.role = new_role
        a.hospital_id = new_hid
    if body.display_name is not None:
        a.display_name = body.display_name.strip()[:64]
    if body.license_no is not None:
        a.license_no = body.license_no.strip()[:32]
    if body.email is not None:
        a.email = body.email.strip()[:128]
    if body.enabled is not None:
        if not body.enabled and a.role == "admin":
            other_admin = db.execute(
                select(func.count()).select_from(Account).where(
                    Account.role == "admin", Account.enabled.is_(True), Account.id != a.id
                )
            ).scalar() or 0
            if other_admin == 0:
                raise HTTPException(status_code=400, detail="마지막 관리자는 비활성화할 수 없습니다")
        a.enabled = body.enabled
    if body.password is not None:
        if len(body.password) < 8:
            raise HTTPException(status_code=400, detail="비밀번호는 8자 이상이어야 합니다")
        a.password_hash = hash_password(body.password)
    db.add(AuditLog(account_id=user.get("uid"), action="account_update",
                    target_type="account", target_id=a.username))
    db.commit()
    names = _hospital_names(db)
    return _account_dict(a, names.get(a.hospital_id, ""))


@router.delete("/accounts/{aid}")
def delete_account(aid: int, db: Session = Depends(get_db),
                   user: dict = Depends(require_perm("users.manage"))):
    a = db.get(Account, aid)
    if not a:
        raise HTTPException(status_code=404, detail="계정을 찾을 수 없습니다")
    if a.id == user.get("uid"):
        raise HTTPException(status_code=400, detail="자기 계정은 삭제할 수 없습니다")
    if a.role == "admin":
        other_admin = db.execute(
            select(func.count()).select_from(Account).where(
                Account.role == "admin", Account.enabled.is_(True), Account.id != a.id
            )
        ).scalar() or 0
        if other_admin == 0:
            raise HTTPException(status_code=400, detail="마지막 관리자는 삭제할 수 없습니다")
    username = a.username
    db.delete(a)
    db.add(AuditLog(account_id=user.get("uid"), action="account_delete",
                    target_type="account", target_id=username))
    db.commit()
    return {"ok": True}


# ════════════════════════════════ 등록 장비(Modality) ════════════════════════════════
class ModalityBody(BaseModel):
    name: str
    ae_title: str = ""
    host: str = ""
    port: int = 104
    modality_type: str = ""
    role: str = "scu"
    manufacturer: str = ""
    hospital_id: int | None = None
    allow_receive: bool = True
    enabled: bool = True
    note: str = ""


def _modality_dict(m: Modality, hospital_name: str = "") -> dict:
    return {
        "id": m.id, "name": m.name, "ae_title": m.ae_title, "host": m.host, "port": m.port,
        "modality_type": m.modality_type, "role": m.role, "manufacturer": m.manufacturer,
        "hospital_id": m.hospital_id, "hospital_name": hospital_name,
        "allow_receive": m.allow_receive, "enabled": m.enabled, "note": m.note,
    }


@router.get("/modalities")
def list_modalities(db: Session = Depends(get_db),
                    user: dict = Depends(require_perm("modalities.manage"))):
    names = _hospital_names(db)
    rows = db.execute(select(Modality).order_by(Modality.name)).scalars().all()
    return {"items": [_modality_dict(m, names.get(m.hospital_id, "")) for m in rows]}


def _valid_node(name: str, aet: str, port: int) -> None:
    if not name:
        raise HTTPException(status_code=400, detail="장비 이름은 필수입니다")
    if not (0 < port < 65536):
        raise HTTPException(status_code=400, detail="Port는 1~65535 범위여야 합니다")
    if not aet:
        raise HTTPException(status_code=400, detail="AE Title은 필수입니다")


@router.post("/modalities")
def create_modality(body: ModalityBody, db: Session = Depends(get_db),
                    user: dict = Depends(require_perm("modalities.manage"))):
    name = body.name.strip()
    _valid_node(name, body.ae_title.strip(), body.port)
    if db.execute(select(Modality).where(Modality.name == name)).scalar_one_or_none():
        raise HTTPException(status_code=409, detail="이미 존재하는 장비 이름입니다")
    if body.hospital_id is not None and not db.get(Hospital, body.hospital_id):
        raise HTTPException(status_code=400, detail="존재하지 않는 병원입니다")
    m = Modality(
        name=name, ae_title=body.ae_title.strip().upper(), host=body.host.strip(),
        port=body.port, modality_type=body.modality_type.strip().upper(),
        role=body.role if body.role in ("scu", "scp", "both") else "scu",
        manufacturer=body.manufacturer.strip(), hospital_id=body.hospital_id,
        allow_receive=body.allow_receive, enabled=body.enabled, note=body.note.strip(),
    )
    db.add(m)
    db.flush()
    db.add(AuditLog(account_id=user.get("uid"), action="modality_create",
                    target_type="modality", target_id=name))
    db.commit()
    names = _hospital_names(db)
    return _modality_dict(m, names.get(m.hospital_id, ""))


@router.put("/modalities/{mid}")
def update_modality(mid: int, body: ModalityBody, db: Session = Depends(get_db),
                    user: dict = Depends(require_perm("modalities.manage"))):
    m = db.get(Modality, mid)
    if not m:
        raise HTTPException(status_code=404, detail="장비를 찾을 수 없습니다")
    name = body.name.strip()
    _valid_node(name, body.ae_title.strip(), body.port)
    if name != m.name and db.execute(
        select(Modality).where(Modality.name == name)
    ).scalar_one_or_none():
        raise HTTPException(status_code=409, detail="이미 존재하는 장비 이름입니다")
    if body.hospital_id is not None and not db.get(Hospital, body.hospital_id):
        raise HTTPException(status_code=400, detail="존재하지 않는 병원입니다")
    m.name = name
    m.ae_title = body.ae_title.strip().upper()
    m.host = body.host.strip()
    m.port = body.port
    m.modality_type = body.modality_type.strip().upper()
    m.role = body.role if body.role in ("scu", "scp", "both") else m.role
    m.manufacturer = body.manufacturer.strip()
    m.hospital_id = body.hospital_id
    m.allow_receive = body.allow_receive
    m.enabled = body.enabled
    m.note = body.note.strip()
    db.add(AuditLog(account_id=user.get("uid"), action="modality_update",
                    target_type="modality", target_id=name))
    db.commit()
    names = _hospital_names(db)
    return _modality_dict(m, names.get(m.hospital_id, ""))


@router.delete("/modalities/{mid}")
def delete_modality(mid: int, db: Session = Depends(get_db),
                    user: dict = Depends(require_perm("modalities.manage"))):
    m = db.get(Modality, mid)
    if not m:
        raise HTTPException(status_code=404, detail="장비를 찾을 수 없습니다")
    name = m.name
    db.delete(m)
    db.add(AuditLog(account_id=user.get("uid"), action="modality_delete",
                    target_type="modality", target_id=name))
    db.commit()
    return {"ok": True}


@router.post("/modalities/apply")
def apply_modalities(db: Session = Depends(get_db),
                     user: dict = Depends(require_perm("modalities.manage"))):
    """활성 장비를 Orthanc DicomModalities로 반영 — C-STORE/C-FIND/C-MOVE 대상 등록.

    enabled=False 또는 allow_receive=False 장비는 Orthanc에서 제거(통신 차단).
    """
    from app.dicom.orthanc import OrthancClient

    rows = db.execute(select(Modality)).scalars().all()
    client = OrthancClient()
    try:
        if not client.alive():
            return {"ok": False, "detail": "Orthanc에 연결할 수 없습니다", "applied": 0}
        applied = 0
        removed = 0
        errors: list[str] = []
        for m in rows:
            active = m.enabled and m.allow_receive and m.host and 0 < m.port < 65536
            if active:
                r = client._client.put(f"/modalities/{m.name}", json=[m.ae_title, m.host, m.port])
                if r.status_code in (200, 204):
                    applied += 1
                else:
                    errors.append(f"{m.name}: HTTP {r.status_code}")
            else:
                rd = client._client.delete(f"/modalities/{m.name}")
                if rd.status_code in (200, 204):
                    removed += 1
        db.add(AuditLog(account_id=user.get("uid"), action="modality_apply",
                        target_type="orthanc", target_id="modalities",
                        detail={"applied": applied, "removed": removed, "errors": errors}))
        db.commit()
        return {"ok": True, "applied": applied, "removed": removed, "errors": errors}
    finally:
        client.close()


# ════════════════════════════════ SCP 수신 제어 ════════════════════════════════
SCP_KEY = "scp.config"
SCP_DEFAULT = {
    "receive_enabled": True,   # SCP로서 C-STORE 수신 허용
    "registered_only": False,  # 등록 장비(IP/AET)만 통신 허용 (DicomCheckModalityHost)
    "check_called_aet": False, # Called AE Title 검증
}


def _repo_root() -> Path:
    # backend/app/api/management.py → parents[3] = 저장소 루트
    return Path(__file__).resolve().parents[3]


@router.get("/scp-status")
def scp_status(db: Session = Depends(get_db),
               user: dict = Depends(require_perm("modalities.manage"))):
    """현재 SCP(수신) 상태 — Orthanc DICOM 포트/AET + 등록 장비 수 + 적용 정책."""
    from app.dicom.orthanc import OrthancClient

    cfg = {**SCP_DEFAULT, **(get_setting(db, SCP_KEY, default={}) or {})}
    n_mod = db.execute(select(func.count()).select_from(Modality)).scalar() or 0
    n_active = db.execute(
        select(func.count()).select_from(Modality).where(
            Modality.enabled.is_(True), Modality.allow_receive.is_(True)
        )
    ).scalar() or 0
    from app.config import get_settings

    s = get_settings()
    out = {"config": cfg, "modalities_total": n_mod, "modalities_active": n_active,
           "mpps": {"enabled": s.mpps_enabled, "port": s.mpps_port, "aet": s.mpps_aet},
           "orthanc": None}
    client = OrthancClient()
    try:
        if client.alive():
            sys_info = client._client.get("/system").json()
            registered = client._client.get("/modalities").json()
            out["orthanc"] = {
                "alive": True, "aet": sys_info.get("DicomAet"),
                "dicom_port": sys_info.get("DicomPort"),
                "registered_modalities": registered,
            }
        else:
            out["orthanc"] = {"alive": False}
    finally:
        client.close()
    return out


class ScpConfigBody(BaseModel):
    receive_enabled: bool = True
    registered_only: bool = False
    check_called_aet: bool = False


@router.post("/scp-config")
def scp_config(body: ScpConfigBody, db: Session = Depends(get_db),
               user: dict = Depends(require_perm("modalities.manage"))):
    """SCP 수신 정책 저장 + Orthanc 적용용 설정 파일 생성.

    실동작: 등록 장비를 Orthanc DicomModalities로 즉시 반영(런타임).
    포트 개폐·등록장비 전용 수신(DicomCheckModalityHost) 같은 수신 데몬 설정은
    Orthanc 기동 시 로드되므로 deploy/orthanc-generated.json을 생성하고 재기동을 안내한다.
    """
    import json

    cfg = {"receive_enabled": body.receive_enabled, "registered_only": body.registered_only,
           "check_called_aet": body.check_called_aet}
    set_setting(db, SCP_KEY, cfg, scope="global")

    # 등록 장비 → Orthanc 설정 스니펫(참고용 JSON 프래그먼트)
    mods = db.execute(select(Modality).where(
        Modality.enabled.is_(True), Modality.allow_receive.is_(True)
    )).scalars().all()
    dicom_modalities = {
        m.name: [m.ae_title, m.host, m.port] for m in mods if m.host and 0 < m.port < 65536
    }
    orthanc_conf = {
        "DicomModalities": dicom_modalities,
        "DicomCheckModalityHost": bool(body.registered_only),
        "DicomCheckCalledAet": bool(body.check_called_aet),
        "DicomServerEnabled": bool(body.receive_enabled),
        # 문자셋 태그 없는 한국 DICOM을 EUC-KR(ISO_IR 149)로 해석 — 미설정 시 Latin1 로 한글 깨짐
        "DefaultEncoding": "Korean",
    }
    deploy = _repo_root() / "deploy"
    written: list[str] = []
    errors = ""
    try:
        deploy.mkdir(parents=True, exist_ok=True)
        json_path = deploy / "orthanc-generated.json"
        json_path.write_text(json.dumps(orthanc_conf, indent=2, ensure_ascii=False), encoding="utf-8")
        written.append(json_path.name)
        # orthancteam/orthanc 이미지는 ORTHANC__* 환경변수로 설정을 받는다(설정 파일 마운트 불가).
        # docker-compose가 참조하는 deploy/.env에 그대로 반영할 수 있는 스니펫을 생성.
        env_path = deploy / "scp-policy.env"
        env_lines = [
            "# Saintview SCP 수신 정책 — deploy/.env에 반영 후 `docker compose up -d orthanc`로 적용",
            "# (장비 목록은 백엔드가 런타임으로 Orthanc에 등록하므로 재기동 불필요)",
            f"ORTHANC_CHECK_MODALITY_HOST={'true' if body.registered_only else 'false'}",
            f"ORTHANC_CHECK_CALLED_AET={'true' if body.check_called_aet else 'false'}",
            f"ORTHANC_DICOM_SERVER_ENABLED={'true' if body.receive_enabled else 'false'}",
            "",
        ]
        env_path.write_text("\n".join(env_lines), encoding="utf-8")
        written.append(env_path.name)
    except OSError as e:
        errors = str(e)

    # 런타임 즉시 반영(장비 목록) — 수신 정책 플래그만 재기동 필요
    applied = apply_modalities(db=db, user=user)  # 동일 권한 게이트 통과한 user 재사용

    db.add(AuditLog(account_id=user.get("uid"), action="scp_config",
                    target_type="orthanc", target_id="scp", detail=cfg))
    db.commit()
    return {
        "ok": True, "config": cfg,
        "generated_files": written,
        "write_error": errors or None,
        "runtime_modalities": applied,
        "note": (
            "등록 장비는 Orthanc에 즉시 반영되었습니다(재기동 불필요). "
            "수신 정책(등록장비 전용·포트 개폐·Called AE 검증)은 생성된 deploy/scp-policy.env의 "
            "값을 deploy/.env에 반영한 뒤 `docker compose up -d orthanc`로 컨테이너를 재기동하면 적용됩니다. "
            "데이터는 명명 볼륨에 보존됩니다."
        ),
    }


# ════════════════════════════════ 저장공간 / 백업 / 압축 ════════════════════════════════
def _job_dict(j: BackupJob) -> dict:
    return {
        "id": j.id, "kind": j.kind, "status": j.status, "compression": j.compression,
        "target_dir": j.target_dir, "date_from": j.date_from, "date_to": j.date_to,
        "study_count": j.study_count, "instance_count": j.instance_count,
        "total_bytes": j.total_bytes, "error": j.error,
        "started_at": j.started_at.isoformat() if j.started_at else None,
        "finished_at": j.finished_at.isoformat() if j.finished_at else None,
        "created_at": j.created_at.isoformat() if j.created_at else None,
    }


@router.get("/storage")
def storage(db: Session = Depends(get_db), user: dict = Depends(require_perm("server.manage"))):
    """저장공간 현황 — Orthanc 디스크 사용량 + DB 카운트 + 백업 디스크 여유 + 보존 후보."""
    from app.services.backup_service import storage_overview

    return storage_overview(db)


@router.get("/backup/compressions")
def backup_compressions(user: dict = Depends(require_perm("server.manage"))):
    from app.services.backup_service import COMPRESSION_LABELS

    return {"items": [{"key": k, "label": v} for k, v in COMPRESSION_LABELS.items()]}


@router.get("/backup/policy")
def backup_policy_get(db: Session = Depends(get_db),
                      user: dict = Depends(require_perm("server.manage"))):
    from app.services.backup_service import get_policy

    return get_policy(db)


class BackupPolicyBody(BaseModel):
    enabled: bool = False
    schedule_time: str = "02:00"
    retention_days: int = 0
    compression: str = "none"
    target_dir: str = ""


@router.put("/backup/policy")
def backup_policy_put(body: BackupPolicyBody, db: Session = Depends(get_db),
                      user: dict = Depends(require_perm("server.manage"))):
    from app.services.backup_service import set_policy

    saved = set_policy(db, body.model_dump())
    db.add(AuditLog(account_id=user.get("uid"), action="backup_policy",
                    target_type="setting", target_id="backup.policy", detail=saved))
    db.commit()
    return saved


class BackupRunBody(BaseModel):
    compression: str = ""        # 비우면 정책값
    target_dir: str = ""         # 비우면 정책값
    date_from: str = ""
    date_to: str = ""


def _run_job_in_thread(job_id: int) -> None:
    from app.db import SessionLocal
    from app.services.backup_service import run_backup_job

    with SessionLocal() as db:
        try:
            run_backup_job(db, job_id)
        except Exception:  # noqa: BLE001 — 작업 상태에 기록됨
            pass


@router.post("/backup/run")
def backup_run(body: BackupRunBody, background: BackgroundTasks, db: Session = Depends(get_db),
               user: dict = Depends(require_perm("server.manage"))):
    """수동 백업 실행 — 작업을 생성하고 응답 후 백그라운드로 처리(자체 세션)."""
    from app.services.backup_service import TRANSFER_SYNTAX, get_policy

    policy = get_policy(db)
    comp = body.compression or policy.get("compression", "none")
    if comp not in TRANSFER_SYNTAX:
        raise HTTPException(status_code=400, detail=f"알 수 없는 압축 포맷: {comp}")
    job = BackupJob(
        kind="manual", status="queued", compression=comp,
        target_dir=body.target_dir or policy.get("target_dir", ""),
        date_from=body.date_from.strip(), date_to=body.date_to.strip(),
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    db.add(AuditLog(account_id=user.get("uid"), action="backup_run",
                    target_type="backup_job", target_id=str(job.id),
                    detail={"compression": comp}))
    db.commit()
    background.add_task(_run_job_in_thread, job.id)
    return _job_dict(job)


@router.get("/backup/jobs")
def backup_jobs(limit: int = 30, db: Session = Depends(get_db),
                user: dict = Depends(require_perm("server.manage"))):
    rows = db.execute(
        select(BackupJob).order_by(BackupJob.id.desc()).limit(limit)
    ).scalars().all()
    return {"items": [_job_dict(j) for j in rows]}


@router.get("/backup/jobs/{job_id}")
def backup_job_detail(job_id: int, db: Session = Depends(get_db),
                      user: dict = Depends(require_perm("server.manage"))):
    j = db.get(BackupJob, job_id)
    if not j:
        raise HTTPException(status_code=404, detail="백업 작업을 찾을 수 없습니다")
    return _job_dict(j)


class PurgeBody(BaseModel):
    retention_days: int
    confirm: bool = False


@router.post("/storage/purge-preview")
def purge_preview(body: PurgeBody, db: Session = Depends(get_db),
                  user: dict = Depends(require_perm("server.manage"))):
    """보존 기간 초과 검사 미리보기(삭제 안 함)."""
    from app.services.backup_service import retention_candidates

    cands = retention_candidates(db, body.retention_days)
    return {
        "count": len(cands),
        "items": [
            {"id": s.id, "study_uid": s.study_uid, "study_date": s.study_date,
             "modality": s.modality, "study_desc": s.study_desc}
            for s in cands[:200]
        ],
    }


def _delete_study_rows(db: Session, study: Study) -> None:
    """검사 + 종속 행(리포트·임베딩·시리즈·주석·AI잡) 정리."""
    from sqlalchemy import delete

    from app.models import AiJob, Annotation, Instance, Report, ReportEmbedding, Series

    report_ids = [r for (r,) in db.execute(
        select(Report.id).where(Report.study_id == study.id)
    ).all()]
    if report_ids:
        db.execute(delete(ReportEmbedding).where(ReportEmbedding.report_id.in_(report_ids)))
    db.execute(delete(Report).where(Report.study_id == study.id))
    series_ids = [sid for (sid,) in db.execute(
        select(Series.id).where(Series.study_id == study.id)
    ).all()]
    if series_ids:
        db.execute(delete(Instance).where(Instance.series_id.in_(series_ids)))
    db.execute(delete(Series).where(Series.study_id == study.id))
    db.execute(delete(Annotation).where(Annotation.study_id == study.id))
    db.execute(delete(AiJob).where(AiJob.study_id == study.id))
    db.delete(study)


def _tcp_ok(host: str, port: int, timeout: float = 1.5) -> bool:
    import socket

    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _http_ok(url: str, timeout: float = 2.0) -> tuple[bool, str]:
    import httpx

    try:
        r = httpx.get(url, timeout=timeout, follow_redirects=True)
        return (r.status_code < 500, f"HTTP {r.status_code}")
    except httpx.HTTPError as e:
        return (False, f"연결 실패: {str(e)[:60]}")


@router.get("/server-status")
def server_status_all(db: Session = Depends(get_db),
                      user: dict = Depends(require_perm("server.manage"))):
    """메인 서버 페이지 — 모든 인프라 서비스(API·Orthanc·OHIF·PostgreSQL·MPPS) 통합 상태."""
    from urllib.parse import urlparse

    from app.config import get_settings
    from app.dicom.orthanc import OrthancClient

    s = get_settings()
    services: list[dict] = []

    # 1) 백엔드 API (자기 자신) — container 필드: docker 제어 가능한 서비스는 컨테이너 이름 노출
    services.append({"name": "백엔드 API", "url": s.api_url, "kind": "api", "ok": True,
                     "detail": f"status ok · AI {s.ai_mode}", "manage": s.api_url + "/docs"})

    # 2) DICOM 서버(Orthanc)
    client = OrthancClient()
    try:
        if client.alive():
            info = client._client.get("/system").json()
            cnt = len(client._client.get("/studies").json())
            services.append({"name": "DICOM 서버(Orthanc)", "url": s.orthanc_url, "kind": "orthanc",
                             "ok": True, "manage": s.orthanc_url, "container": "saintview-orthanc",
                             "detail": f"v{info.get('Version','?')} · AET {info.get('DicomAet')} · "
                                       f"DICOM {info.get('DicomPort')} · 검사 {cnt}"})
        else:
            services.append({"name": "DICOM 서버(Orthanc)", "url": s.orthanc_url, "kind": "orthanc",
                             "ok": False, "detail": "연결 안 됨", "manage": s.orthanc_url,
                             "container": "saintview-orthanc"})
    finally:
        client.close()

    # 3) OHIF 뷰어
    ohif_ok, ohif_detail = _http_ok(s.ohif_url)
    services.append({"name": "OHIF 뷰어", "url": s.ohif_url, "kind": "ohif",
                     "ok": ohif_ok, "detail": ohif_detail, "manage": s.ohif_url,
                     "container": "saintview-ohif"})

    # 4) PostgreSQL (docker) — TCP 점검
    pg_ok = _tcp_ok(s.pg_host, s.pg_port)
    services.append({"name": "PostgreSQL", "url": f"{s.pg_host}:{s.pg_port}", "kind": "db",
                     "ok": pg_ok, "detail": "Up" if pg_ok else "연결 안 됨",
                     "container": "saintview-db"})

    # 5) 애플리케이션 DB (현재 엔진) — SELECT 1
    try:
        from sqlalchemy import text

        db.execute(text("SELECT 1"))
        dialect = db.bind.dialect.name if db.bind else "?"
        url = s.database_url
        masked = url.split("@")[-1] if "@" in url else urlparse(url).path or dialect
        services.append({"name": "애플리케이션 DB", "url": f"{dialect}", "kind": "appdb",
                         "ok": True, "detail": f"SELECT 1 OK · {masked[:40]}"})
    except Exception as e:  # noqa: BLE001
        services.append({"name": "애플리케이션 DB", "url": "?", "kind": "appdb",
                         "ok": False, "detail": str(e)[:80]})

    # 6) MPPS 수신(DIMSE)
    mpps_ok = _tcp_ok("127.0.0.1", s.mpps_port) if s.mpps_enabled else False
    services.append({"name": "MPPS 수신(DIMSE)", "url": f"0.0.0.0:{s.mpps_port}", "kind": "mpps",
                     "ok": mpps_ok,
                     "detail": "LISTENING" if mpps_ok else ("비활성(설정)" if not s.mpps_enabled else "리스너 없음")})

    healthy = sum(1 for x in services if x["ok"])
    return {"services": services, "healthy": healthy, "total": len(services)}


@router.get("/overview")
def admin_overview(db: Session = Depends(get_db),
                   user: dict = Depends(require_perm("hospitals.manage"))):
    """관리자 운영 감독 — 병원별 정보·Client(라이선스)·Modality 등록·검사 수 +
    서버/저장공간/로그 상태 집계 (가입 흐름도의 관리자 페이지)."""
    from app.dicom.orthanc import OrthancClient
    from app.models import Study

    hospitals = db.execute(select(Hospital).order_by(Hospital.id)).scalars().all()
    acc_by_h = dict(db.execute(
        select(Account.hospital_id, func.count()).group_by(Account.hospital_id)
    ).all())
    active_by_h = dict(db.execute(
        select(Account.hospital_id, func.count()).where(
            Account.enabled.isnot(False)
        ).group_by(Account.hospital_id)
    ).all())
    mod_by_h = dict(db.execute(
        select(Modality.hospital_id, func.count()).group_by(Modality.hospital_id)
    ).all())
    study_by_h = dict(db.execute(
        select(Study.hospital_id, func.count()).group_by(Study.hospital_id)
    ).all())
    rows = []
    for h in hospitals:
        rows.append({
            "id": h.id, "code": h.code, "name": h.name, "enabled": h.enabled,
            "departments": h.departments, "phone": h.phone,
            "accounts": acc_by_h.get(h.id, 0), "active_accounts": active_by_h.get(h.id, 0),
            "license_clients": h.license_clients,
            "modalities": mod_by_h.get(h.id, 0), "modality_limit": h.modality_limit,
            "studies": study_by_h.get(h.id, 0),
            "billing_method": h.billing_method,
        })
    # 서버/저장/로그 상태
    n_logs = db.execute(select(func.count()).select_from(AuditLog)).scalar() or 0
    orthanc_alive = False
    client = OrthancClient()
    try:
        orthanc_alive = client.alive()
    finally:
        client.close()
    from app.config import get_settings

    s = get_settings()
    return {
        "hospitals": rows,
        "totals": {
            "hospitals": len(rows),
            "accounts": db.execute(select(func.count()).select_from(Account)).scalar() or 0,
            "modalities": db.execute(select(func.count()).select_from(Modality)).scalar() or 0,
            "studies": db.execute(select(func.count()).select_from(Study)).scalar() or 0,
            "audit_logs": n_logs,
        },
        "server": {
            "api": True, "orthanc": orthanc_alive,
            "mpps": {"enabled": s.mpps_enabled, "port": s.mpps_port},
            "ai_mode": s.ai_mode,
        },
    }


@router.post("/storage/purge")
def purge(body: PurgeBody, db: Session = Depends(get_db),
          user: dict = Depends(require_perm("server.manage"))):
    """보존 기간 초과 검사 삭제 — confirm=true 필수(파괴적). Orthanc + DB에서 제거.

    ⚠ 운영 정책: 삭제 전 백업을 먼저 수행할 것. 자동 삭제는 하지 않는다(관리자 수동 실행).
    """
    from app.dicom.orthanc import OrthancClient
    from app.services.backup_service import retention_candidates

    if not body.confirm:
        raise HTTPException(status_code=400, detail="삭제 확인(confirm=true)이 필요합니다")
    if body.retention_days <= 0:
        raise HTTPException(status_code=400, detail="보존 기간(retention_days)은 1 이상이어야 합니다")
    cands = retention_candidates(db, body.retention_days)
    client = OrthancClient()
    orthanc_alive = client.alive()
    deleted = 0
    orthanc_removed = 0
    try:
        for s in cands:
            if orthanc_alive and s.orthanc_id:
                try:
                    r = client._client.delete(f"/studies/{s.orthanc_id}")
                    if r.status_code in (200, 204):
                        orthanc_removed += 1
                except Exception:  # noqa: BLE001
                    pass
            _delete_study_rows(db, s)
            deleted += 1
        db.add(AuditLog(account_id=user.get("uid"), action="storage_purge",
                        target_type="study", target_id=f"{deleted}건",
                        detail={"retention_days": body.retention_days,
                                "deleted": deleted, "orthanc_removed": orthanc_removed}))
        db.commit()
    finally:
        client.close()
    return {"ok": True, "deleted": deleted, "orthanc_removed": orthanc_removed}


# ════════════════════════════ 백엔드 프로세스 자체 제어 (restart|stop) ════════════════════════════
class ServerControlBody(BaseModel):
    action: str  # restart | stop


@router.post("/server-control")
def server_control(body: ServerControlBody, db: Session = Depends(get_db),
                   user: dict = Depends(require_perm("server.manage"))):
    """백엔드 API 프로세스 강제 재시작/중지 — 분리된 cmd 가 2초 뒤 수행(이 응답은 정상 반환).

    restart: 현재 PID 종료 후 동일 인터프리터·인자로 uvicorn 재기동(환경변수 상속).
    stop: 종료만 — 웹 UI 도 함께 내려가므로 재기동은 바탕화면 [Saintview PACS 시작] 아이콘 사용.
    """
    import os
    import subprocess

    if body.action not in ("restart", "stop"):
        raise HTTPException(status_code=400, detail="action은 restart|stop")
    if os.name != "nt":
        raise HTTPException(status_code=501, detail="Windows 서버에서만 지원됩니다")
    pid = os.getpid()
    backend_dir = Path(__file__).resolve().parents[2]
    bat = backend_dir / "server_restart.bat"
    if not bat.is_file():
        raise HTTPException(status_code=500, detail="server_restart.bat 이 없습니다 (backend 폴더)")
    # ⚠ 자식 프로세스(cmd 분리 실행)는 부모 Job 정리에 함께 종료될 수 있어 신뢰 불가 —
    #   작업 스케줄러(schtasks) 일회성 작업으로 실행하면 스케줄러 서비스 소속이라 확실히 살아남는다.
    (backend_dir / "restart.pid").write_text(str(pid), encoding="ascii")
    # 감사 로그는 프로세스가 죽기 전에 커밋
    db.add(AuditLog(account_id=user.get("uid"), action="server_control",
                    target_type="server", target_id=body.action, detail={"pid": pid}))
    db.commit()
    no_win = subprocess.CREATE_NO_WINDOW
    cr = subprocess.run(
        ["schtasks", "/create", "/f", "/tn", "SaintviewServerControl",
         "/tr", f'"{bat}" {body.action}', "/sc", "once", "/st", "23:59"],
        capture_output=True, text=True, timeout=30, creationflags=no_win)
    if cr.returncode != 0:
        raise HTTPException(status_code=500, detail=f"작업 등록 실패: {(cr.stderr or cr.stdout).strip()[:120]}")
    rn = subprocess.run(["schtasks", "/run", "/tn", "SaintviewServerControl"],
                        capture_output=True, text=True, timeout=30, creationflags=no_win)
    if rn.returncode != 0:
        raise HTTPException(status_code=500, detail=f"작업 실행 실패: {(rn.stderr or rn.stdout).strip()[:120]}")
    return {"ok": True, "action": body.action,
            "detail": "2초 후 수행됩니다" + (" — 잠시 후 자동 재접속" if body.action == "restart" else
                                         " — 재기동은 바탕화면 아이콘(saintview_recover.bat) 사용")}
