"""병원별·계정별 설정 백업/복원 — 항목(체크박스) 선택 → JSON export/import.

항목: hospital(병원정보) · network(네트워크·DICOM 노드) · modalities(등록장비 SCP/SCU) ·
      accounts(계정·좌석) · account_settings(계정별 뷰어 설정) · hospital_settings(권한·행잉·상용구·AI 등).
복원은 현재 병원(hid)으로 자연키 upsert(부활). 백업 JSON 은 자격증명(해시/평문)을 포함하므로 안전 보관 필요.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import current_user
from app.db import get_db
from app.models import Account, AppSetting, AuditLog, Client, Hospital, Modality

router = APIRouter(prefix="/api", tags=["backup"])

ITEMS = ["hospital", "network", "modalities", "accounts", "account_settings", "hospital_settings"]
# network 항목으로 분류할 hospital-scoped 설정 키(그 외는 hospital_settings)
NETWORK_KEYS = {
    "hospital.scu", "scp.config", "dicom.nodes", "modality.nodes", "mwl.config",
    "saintview.mwl", "ddns.config", "saintview.infra.ddns", "remote.reading",
}
_HOSPITAL_COLS = ["code", "name", "ae_title", "zip", "address", "address_detail", "phone",
                  "fax", "homepage", "departments", "contact", "license_clients",
                  "modality_limit", "billing_method", "enabled"]
_MODALITY_COLS = ["name", "ae_title", "host", "port", "modality_type", "role", "manufacturer", "allow_receive"]
_ACCOUNT_COLS = ["username", "role", "display_name", "license_no", "email", "title", "sex",
                 "birth6", "phone", "mobile", "enabled", "must_change", "pw_plain", "password_hash", "algo"]
_CLIENT_COLS = ["name", "code", "location", "enabled"]


def _require_admin(user: dict, hid: int) -> None:
    if user.get("role") == "admin" and not user.get("hid"):
        return  # 시스템 관리자
    if user.get("role") == "admin" and user.get("hid") == hid:
        return  # 병원 관리자(자기 병원)
    raise HTTPException(status_code=403, detail="백업/복원은 관리자만 가능합니다")


def _hset(db: Session, hid: int) -> dict:
    return {r.key: r.value for r in db.execute(
        select(AppSetting).where(AppSetting.scope == "hospital", AppSetting.scope_id == str(hid))
    ).scalars()}


def _collect(db: Session, hid: int, items: list[str]) -> dict:
    h = db.get(Hospital, hid)
    if not h:
        raise HTTPException(status_code=404, detail="병원을 찾을 수 없습니다")
    out: dict = {}
    hset = _hset(db, hid)
    if "hospital" in items:
        out["hospital"] = {c: getattr(h, c) for c in _HOSPITAL_COLS}
    if "network" in items:
        out["network"] = {k: v for k, v in hset.items() if k in NETWORK_KEYS}
    if "hospital_settings" in items:
        out["hospital_settings"] = {k: v for k, v in hset.items() if k not in NETWORK_KEYS}
    if "modalities" in items:
        out["modalities"] = [{c: getattr(m, c) for c in _MODALITY_COLS}
                             for m in db.execute(select(Modality).where(Modality.hospital_id == hid)).scalars()]
    accts = db.execute(select(Account).where(Account.hospital_id == hid)).scalars().all()
    if "accounts" in items:
        out["accounts"] = {
            "accounts": [{c: getattr(a, c) for c in _ACCOUNT_COLS} | {"is_seat": a.client_id is not None} for a in accts],
            "clients": [{c: getattr(cl, c) for c in _CLIENT_COLS}
                        for cl in db.execute(select(Client).where(Client.hospital_id == hid)).scalars()],
            "client_roles": hset.get("client.roles", {}),
        }
    if "account_settings" in items:
        names = [a.username for a in accts]
        rows = list(db.execute(select(AppSetting).where(
            AppSetting.scope == "user", AppSetting.scope_id.in_(names))).scalars()) if names else []
        us: dict = {}
        for r in rows:
            us.setdefault(r.scope_id, {})[r.key] = r.value
        out["account_settings"] = [{"username": u, "settings": s} for u, s in us.items()]
    return out


class BackupBody(BaseModel):
    items: list[str] = []   # 선택한 항목(빈값=전체)


@router.post("/hospitals/{hid}/backup")
def make_backup(hid: int, body: BackupBody, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """선택 항목을 모아 백업 JSON 반환(프론트가 '병원이름_날짜_시간.json' 으로 저장)."""
    _require_admin(user, hid)
    h = db.get(Hospital, hid)
    items = [i for i in (body.items or ITEMS) if i in ITEMS]
    data = _collect(db, hid, items)
    db.add(AuditLog(account_id=user.get("uid"), action="backup_export", target_type="hospital",
                    target_id=str(hid), detail={"items": items}))
    db.commit()
    return {
        "meta": {"hospital": h.name, "hospital_id": hid, "code": h.code,
                 "generated_at": datetime.now(timezone.utc).isoformat(), "version": 1, "items": items},
        "data": data,
    }


class RestoreBody(BaseModel):
    backup: dict           # 업로드한 백업 JSON 전체({meta, data})
    items: list[str] = []  # 복원할 항목(빈값=백업에 있는 전체)


def _upsert_settings(db: Session, hid: int, kv: dict) -> None:
    from app.services.settings_service import set_hospital_setting
    for k, v in (kv or {}).items():
        set_hospital_setting(db, hid, k, v)


@router.post("/hospitals/{hid}/restore")
def restore_backup(hid: int, body: RestoreBody, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """백업 JSON 의 선택 항목을 현재 병원(hid)으로 복원(부활) — 자연키 upsert."""
    _require_admin(user, hid)
    from app.services.settings_service import set_setting

    h = db.get(Hospital, hid)
    data = (body.backup or {}).get("data", {})
    avail = list(data.keys())
    items = [i for i in (body.items or avail) if i in avail]
    done: list[str] = []

    if "hospital" in items and isinstance(data.get("hospital"), dict):
        for c, v in data["hospital"].items():
            if c in ("code",) or v is None:   # code(유니크·식별)는 보존
                continue
            if hasattr(h, c):
                setattr(h, c, v)
        done.append("hospital")
    if "network" in items:
        _upsert_settings(db, hid, data.get("network", {})); done.append("network")
    if "hospital_settings" in items:
        _upsert_settings(db, hid, data.get("hospital_settings", {})); done.append("hospital_settings")
    if "modalities" in items and isinstance(data.get("modalities"), list):
        for m in data["modalities"]:
            row = db.execute(select(Modality).where(Modality.name == m.get("name"))).scalar_one_or_none()
            if row is None:
                row = Modality(name=m.get("name", ""), hospital_id=hid); db.add(row)
            for c in _MODALITY_COLS:
                if c in m and c != "name":
                    setattr(row, c, m[c])
            row.hospital_id = hid
        done.append("modalities")
    if "accounts" in items and isinstance(data.get("accounts"), dict):
        acc = data["accounts"]
        for a in acc.get("accounts", []):
            row = db.execute(select(Account).where(Account.username == a.get("username"))).scalar_one_or_none()
            if row is None:
                row = Account(username=a.get("username", "")); db.add(row)
            for c in _ACCOUNT_COLS:
                if c in a and c != "username":
                    setattr(row, c, a[c])
            row.hospital_id = hid
        for cl in acc.get("clients", []):
            crow = db.execute(select(Client).where(Client.code == cl.get("code"), Client.hospital_id == hid)).scalar_one_or_none()
            if crow is None:
                crow = Client(code=cl.get("code", ""), hospital_id=hid); db.add(crow)
            for c in _CLIENT_COLS:
                if c in cl and c != "code":
                    setattr(crow, c, cl[c])
        if acc.get("client_roles"):
            _upsert_settings(db, hid, {"client.roles": acc["client_roles"]})
        done.append("accounts")
    if "account_settings" in items and isinstance(data.get("account_settings"), list):
        for u in data["account_settings"]:
            uname = u.get("username")
            for k, v in (u.get("settings") or {}).items():
                set_setting(db, k, v, scope="user", scope_id=uname)
        done.append("account_settings")

    db.add(AuditLog(account_id=user.get("uid"), action="backup_restore", target_type="hospital",
                    target_id=str(hid), detail={"items": done, "from": (body.backup or {}).get("meta", {})}))
    db.commit()
    return {"ok": True, "restored": done}
