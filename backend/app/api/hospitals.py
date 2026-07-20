"""병원 선택 → 자원관리 → Client 선택 → PACS Viewer 흐름.

로그인 후 흐름(전체 로직):
  로그인 → /api/my/hospitals(병원 목록) → 병원 선택
        → /api/hospitals/{id}/resources(영상 용량·DB 용량·클라이언트·접속 상태)
        → Client 선택 → /clients/{cid}/enter → PACS Viewer 진입(해당 병원 스코프)
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import current_user
from app.db import get_db
from app.models import Account, AuditLog, Client, Hospital, Modality, Report, Study

router = APIRouter(prefix="/api", tags=["hospitals"])

ONLINE_WINDOW_SEC = 300  # 마지막 접속 5분 이내면 online


def _is_online(last_seen) -> bool:
    if last_seen is None:
        return False
    ls = last_seen if last_seen.tzinfo else last_seen.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - ls).total_seconds() < ONLINE_WINDOW_SEC


def _is_system_admin(user: dict) -> bool:
    """시스템(서버 운영) 관리자 — role=admin이면서 특정 병원 소속이 아닌 계정(전체 병원)."""
    return user.get("role") == "admin" and not user.get("hid")


def _require_access(user: dict, hospital_id: int) -> None:
    """시스템 관리자=전체 병원, 그 외=자기 소속 병원만."""
    if _is_system_admin(user):
        return
    if user.get("hid") == hospital_id:
        return
    raise HTTPException(status_code=403, detail="이 병원에 접근할 권한이 없습니다")


def _require_admin(user: dict, hospital_id: int) -> None:
    """관리자(시스템 or 병원 admin) 전용 — 좌석 비번 조회/변경/리셋. 일반 좌석 사용자 차단."""
    _require_access(user, hospital_id)
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="비밀번호 관리는 관리자만 가능합니다")


def _accessible_hospitals(db: Session, user: dict) -> list[Hospital]:
    q = select(Hospital).where(Hospital.enabled.is_(True)).order_by(Hospital.name)
    if _is_system_admin(user):
        pass  # 전체 병원
    elif user.get("hid"):
        q = q.where(Hospital.id == user["hid"])  # 자기 병원만
    else:
        return []
    return list(db.execute(q).scalars().all())


def _client_counts(db: Session, hospital_id: int) -> tuple[int, int]:
    clients = db.execute(select(Client).where(Client.hospital_id == hospital_id)).scalars().all()
    online = sum(1 for c in clients if c.enabled and _is_online(c.last_seen))
    return len(clients), online


@router.get("/my/hospitals")
def my_hospitals(db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """로그인 사용자가 접근 가능한 병원 목록 + 빠른 상태(접속 클라이언트·검사 수)."""
    out = []
    for h in _accessible_hospitals(db, user):
        total_clients, online = _client_counts(db, h.id)
        studies = db.execute(
            select(func.count()).select_from(Study).where(Study.hospital_id == h.id)
        ).scalar() or 0
        out.append({
            "id": h.id, "code": h.code, "name": h.name, "departments": h.departments,
            "license_clients": h.license_clients, "clients": total_clients, "online_clients": online,
            "studies": studies, "modality_limit": h.modality_limit,
        })
    return {"items": out, "role": user.get("role"), "is_admin": _is_system_admin(user)}


@router.get("/hospitals/{hid}/resources")
def hospital_resources(hid: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """병원별 자원관리 — 영상 용량(추정)·DB 용량·클라이언트·접속 상태·장비."""
    _require_access(user, hid)
    h = db.get(Hospital, hid)
    if not h:
        raise HTTPException(status_code=404, detail="병원을 찾을 수 없습니다")

    studies = db.execute(select(Study).where(Study.hospital_id == hid)).scalars().all()
    n_studies = len(studies)
    n_instances = sum(s.instance_count for s in studies)
    n_series = sum(s.series_count for s in studies)
    study_ids = [s.id for s in studies]

    # DB 용량 — 행 수(검사·판독·주석)
    n_reports = 0
    n_annos = 0
    if study_ids:
        n_reports = db.execute(
            select(func.count()).select_from(Report).where(Report.study_id.in_(study_ids))
        ).scalar() or 0
        from app.models import Annotation

        n_annos = db.execute(
            select(func.count()).select_from(Annotation).where(Annotation.study_id.in_(study_ids))
        ).scalar() or 0

    # 영상 용량 — Orthanc 전체 디스크에서 인스턴스 비율로 추정(Orthanc는 공유 저장)
    image_bytes_est = None
    orthanc_total = None
    total_instances = db.execute(select(func.sum(Study.instance_count))).scalar() or 0
    from app.dicom.orthanc import OrthancClient

    oc = OrthancClient()
    try:
        if oc.alive():
            st = oc.statistics()
            orthanc_total = int(st.get("TotalDiskSize", 0) or 0)
            if total_instances > 0 and orthanc_total:
                image_bytes_est = int(orthanc_total * (n_instances / total_instances))
    finally:
        oc.close()

    # 클라이언트 + 접속 상태
    clients = db.execute(
        select(Client).where(Client.hospital_id == hid).order_by(Client.id)
    ).scalars().all()
    client_rows = [{
        "id": c.id, "name": c.name, "code": c.code, "location": c.location,
        "enabled": c.enabled, "online": _is_online(c.last_seen),
        "last_seen": c.last_seen.isoformat() if c.last_seen else None,
        "last_user": c.last_user,
    } for c in clients]
    online = sum(1 for c in client_rows if c["online"] and c["enabled"])

    n_modalities = db.execute(
        select(func.count()).select_from(Modality).where(Modality.hospital_id == hid)
    ).scalar() or 0
    n_accounts = db.execute(
        select(func.count()).select_from(Account).where(Account.hospital_id == hid)
    ).scalar() or 0

    return {
        "hospital": {"id": h.id, "code": h.code, "name": h.name, "departments": h.departments,
                     "address": h.address, "phone": h.phone},
        "image": {"studies": n_studies, "series": n_series, "instances": n_instances,
                  "bytes_estimate": image_bytes_est, "orthanc_total_bytes": orthanc_total},
        "db": {"studies": n_studies, "reports": n_reports, "annotations": n_annos},
        "clients": {"total": len(client_rows), "online": online,
                    "license": h.license_clients, "items": client_rows},
        "modalities": {"count": n_modalities, "limit": h.modality_limit},
        "accounts": n_accounts,
    }


# ──────────────────────────── Client(좌석) CRUD ────────────────────────────
class ClientBody(BaseModel):
    name: str
    location: str = ""
    enabled: bool = True
    role: str = ""  # 계정 등급 — doctor|radiologist|technologist|staff ("" = 변경 없음/기본 staff)
    password: str = ""  # 발급 시 초기 비번(빈값=기본 "1111"). 로그인 ID = 좌석 코드.


class PasswordBody(BaseModel):
    password: str  # admin 이 지정하는 새 비번(수정)


# Client(좌석)별 계정 등급 — Client 테이블에 컬럼이 없어(스키마 마이그레이션 금지)
# hospital 스코프 setting 'client.roles' 에 {"<client_id>": "<role>"} 로 보관한다.
_CLIENT_ROLES_KEY = "client.roles"


def _client_roles(db: Session, hid: int) -> dict:
    from app.services.settings_service import get_hospital_setting

    stored = get_hospital_setting(db, hid, _CLIENT_ROLES_KEY, default={}) or {}
    return dict(stored) if isinstance(stored, dict) else {}


def _validate_client_role(role: str) -> None:
    from app.services.permissions import CLIENT_ROLES

    if role and role not in CLIENT_ROLES:
        raise HTTPException(status_code=400,
                            detail=f"알 수 없는 등급: {role} ({'|'.join(CLIENT_ROLES)})")


def _client_dict(c: Client, role: str = "staff", acct=None, include_pw: bool = False) -> dict:
    from app.services.permissions import ROLES

    return {"id": c.id, "hospital_id": c.hospital_id, "name": c.name, "code": c.code,
            "location": c.location, "enabled": c.enabled, "online": _is_online(c.last_seen),
            "last_seen": c.last_seen.isoformat() if c.last_seen else None, "last_user": c.last_user,
            "role": role, "role_label": ROLES.get(role, role),
            # 로그인 ID = 좌석 코드. password(복원 평문)는 관리자에게만 노출.
            "login_id": c.code,
            "password": (acct.pw_plain if (acct and include_pw) else ""),
            "must_change": bool(acct.must_change) if acct else False,
            "has_login": acct is not None}


@router.get("/hospitals/{hid}/clients")
def list_clients(hid: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    _require_access(user, hid)
    from app.models import Account

    roles = _client_roles(db, hid)
    rows = db.execute(select(Client).where(Client.hospital_id == hid).order_by(Client.id)).scalars().all()
    ids = [c.id for c in rows]
    accts = {}
    if ids:
        accts = {a.client_id: a for a in
                 db.execute(select(Account).where(Account.client_id.in_(ids))).scalars()}
    is_admin = user.get("role") == "admin"   # 비번 노출은 관리자에게만
    return {"items": [_client_dict(c, roles.get(str(c.id), "staff"), accts.get(c.id), is_admin) for c in rows]}


@router.post("/hospitals/{hid}/clients")
def create_client(hid: int, body: ClientBody, db: Session = Depends(get_db),
                  user: dict = Depends(current_user)):
    _require_access(user, hid)
    h = db.get(Hospital, hid)
    if not h:
        raise HTTPException(status_code=404, detail="병원을 찾을 수 없습니다")
    cur = db.execute(select(func.count()).select_from(Client).where(Client.hospital_id == hid)).scalar() or 0
    if h.license_clients > 0 and cur >= h.license_clients:
        raise HTTPException(status_code=409, detail=f"Client 라이선스 한도 초과({h.license_clients}석)")
    _validate_client_role(body.role)
    c = Client(hospital_id=hid, name=body.name.strip() or f"Client {cur + 1}",
               code=f"{h.code}-C{cur + 1:02d}", location=body.location.strip(), enabled=body.enabled)
    db.add(c)
    db.flush()
    role = body.role or "staff"
    if body.role:
        from app.services.settings_service import set_hospital_setting

        roles = _client_roles(db, hid)
        roles[str(c.id)] = body.role
        set_hospital_setting(db, hid, _CLIENT_ROLES_KEY, roles)
    # 로그인 계정 자동 발급 — username = 좌석 코드, 초기 비번(기본 "1111"), 최초 로그인 강제변경.
    from app.models import Account
    from app.services.auth_service import set_password

    acct = Account(username=c.code, role=role, hospital_id=hid,
                   display_name=c.name, enabled=c.enabled, client_id=c.id)
    set_password(acct, body.password.strip() or "1111", must_change=True)
    db.add(acct)
    db.add(AuditLog(account_id=user.get("uid"), action="client_create",
                    target_type="client", target_id=str(c.id),
                    detail={"hospital": hid, "role": role, "login_id": c.code}))
    db.commit()
    return _client_dict(c, role, acct)


@router.put("/hospitals/{hid}/clients/{cid}")
def update_client(hid: int, cid: int, body: ClientBody, db: Session = Depends(get_db),
                  user: dict = Depends(current_user)):
    _require_access(user, hid)
    c = db.get(Client, cid)
    if not c or c.hospital_id != hid:
        raise HTTPException(status_code=404, detail="Client를 찾을 수 없습니다")
    _validate_client_role(body.role)
    c.name = body.name.strip()
    c.location = body.location.strip()
    c.enabled = body.enabled
    roles = _client_roles(db, hid)
    if body.role:  # "" = 등급 변경 없음(기존 유지)
        from app.services.settings_service import set_hospital_setting

        roles[str(c.id)] = body.role
        set_hospital_setting(db, hid, _CLIENT_ROLES_KEY, roles)
    # 연동 로그인 계정 동기화(등급/사용/이름). 비번은 별도 엔드포인트에서만 변경.
    from app.models import Account

    acct = db.execute(select(Account).where(Account.client_id == c.id)).scalar_one_or_none()
    if acct:
        if body.role:
            acct.role = body.role
        acct.enabled = c.enabled
        acct.display_name = c.name
    db.commit()
    return _client_dict(c, roles.get(str(c.id), "staff"), acct)


@router.delete("/hospitals/{hid}/clients/{cid}")
def delete_client(hid: int, cid: int, db: Session = Depends(get_db),
                  user: dict = Depends(current_user)):
    _require_access(user, hid)
    c = db.get(Client, cid)
    if not c or c.hospital_id != hid:
        raise HTTPException(status_code=404, detail="Client를 찾을 수 없습니다")
    roles = _client_roles(db, hid)
    if roles.pop(str(cid), None) is not None:  # 등급 매핑 정리(고아 키 방지)
        from app.services.settings_service import set_hospital_setting

        set_hospital_setting(db, hid, _CLIENT_ROLES_KEY, roles)
    # 연동 로그인 계정도 함께 삭제(고아 계정 방지). 감사로그 FK 는 NULL 처리 후 삭제.
    from sqlalchemy import update

    from app.models import Account

    acct = db.execute(select(Account).where(Account.client_id == cid)).scalar_one_or_none()
    if acct:
        db.execute(update(AuditLog).where(AuditLog.account_id == acct.id).values(account_id=None))
        db.delete(acct)
    db.delete(c)
    db.commit()
    return {"ok": True}


def _seat_account(db: Session, hid: int, cid: int):
    """좌석의 연동 로그인 계정 조회(admin 비번 관리용). 없으면 404."""
    from app.models import Account

    c = db.get(Client, cid)
    if not c or c.hospital_id != hid:
        raise HTTPException(status_code=404, detail="Client를 찾을 수 없습니다")
    acct = db.execute(select(Account).where(Account.client_id == cid)).scalar_one_or_none()
    if not acct:
        raise HTTPException(status_code=404, detail="연동 로그인 계정이 없습니다")
    return c, acct


@router.put("/hospitals/{hid}/clients/{cid}/password")
def set_client_password(hid: int, cid: int, body: PasswordBody, db: Session = Depends(get_db),
                        user: dict = Depends(current_user)):
    """admin — 좌석 계정 비번 '수정'(지정 값). must_change 해제(admin 이 정한 값 그대로 사용)."""
    _require_admin(user, hid)
    from app.services.auth_service import set_password

    _, acct = _seat_account(db, hid, cid)
    pw = body.password.strip()
    if not pw:
        raise HTTPException(status_code=400, detail="비밀번호를 입력하세요")
    set_password(acct, pw, must_change=False)
    db.add(AuditLog(account_id=user.get("uid"), action="client_pw_set",
                    target_type="client", target_id=str(cid), detail={"hospital": hid}))
    db.commit()
    return {"ok": True, "password": acct.pw_plain}


@router.put("/hospitals/{hid}/clients/{cid}/reset")
def reset_client_password(hid: int, cid: int, db: Session = Depends(get_db),
                          user: dict = Depends(current_user)):
    """admin — 좌석 계정 비번 리셋 → 초기 비번 "1111" + 최초 로그인 강제변경."""
    _require_admin(user, hid)
    from app.services.auth_service import set_password

    _, acct = _seat_account(db, hid, cid)
    set_password(acct, "1111", must_change=True)
    db.add(AuditLog(account_id=user.get("uid"), action="client_pw_reset",
                    target_type="client", target_id=str(cid), detail={"hospital": hid}))
    db.commit()
    return {"ok": True, "password": "1111"}


@router.post("/hospitals/{hid}/clients/reset-all")
def reset_all_client_passwords(hid: int, db: Session = Depends(get_db),
                               user: dict = Depends(current_user)):
    """admin — 이 병원 모든 발급 좌석 계정 비번을 초기 "1111" 로 일괄 리셋(+강제변경)."""
    _require_admin(user, hid)
    from app.models import Account
    from app.services.auth_service import set_password

    accts = db.execute(
        select(Account).where(Account.hospital_id == hid, Account.client_id.isnot(None))
    ).scalars().all()
    for a in accts:
        set_password(a, "1111", must_change=True)
    db.add(AuditLog(account_id=user.get("uid"), action="client_pw_reset_all",
                    target_type="hospital", target_id=str(hid), detail={"count": len(accts)}))
    db.commit()
    return {"ok": True, "count": len(accts), "password": "1111"}


@router.post("/hospitals/{hid}/clients/{cid}/enter")
def enter_client(hid: int, cid: int, db: Session = Depends(get_db),
                 user: dict = Depends(current_user)):
    """Client 선택 → PACS Viewer 진입. 접속 시각·사용자 기록(online 판정)."""
    _require_access(user, hid)
    c = db.get(Client, cid)
    if not c or c.hospital_id != hid:
        raise HTTPException(status_code=404, detail="Client를 찾을 수 없습니다")
    if not c.enabled:
        raise HTTPException(status_code=409, detail="비활성화된 Client입니다")
    c.last_seen = datetime.now(timezone.utc)
    c.last_user = user.get("sub", "")[:64]
    db.add(AuditLog(account_id=user.get("uid"), action="client_enter",
                    target_type="client", target_id=str(c.id), detail={"hospital": hid}))
    db.commit()
    return {"ok": True, "hospital_id": hid, "client_id": cid, "client_name": c.name}


@router.post("/hospitals/{hid}/clients/{cid}/heartbeat")
def heartbeat(hid: int, cid: int, db: Session = Depends(get_db),
              user: dict = Depends(current_user)):
    """뷰어가 주기적으로 호출 → online 유지."""
    _require_access(user, hid)
    c = db.get(Client, cid)
    if c and c.hospital_id == hid:
        c.last_seen = datetime.now(timezone.utc)
        db.commit()
    return {"ok": True}
