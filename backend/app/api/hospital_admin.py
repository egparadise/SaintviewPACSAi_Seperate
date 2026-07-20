"""등록 병원별 설정·관리 API — 사용량·권한 매트릭스·Modality 노드·SCU·영상 관리 액션.

접근 가드: 시스템 관리자=전체 병원, 그 외=자기 소속 병원만(hospitals._require_access 재사용).
쓰기(PUT/액션)는 관리자(role=admin — 시스템/병원 관리자) 또는 유효 권한으로 강제한다.
"""
from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import current_user
from app.api.hospitals import _is_system_admin, _require_access
from app.db import get_db
from app.models import Annotation, AuditLog, Hospital, Order, Report, Study
from app.services.permissions import (
    CLIENT_ROLES,
    PERMISSIONS,
    ROLES,
    effective_perms,
)
from app.services.settings_service import (
    WL_HOSPITAL_KEYS,
    get_hospital_setting,
    set_hospital_setting,
)

router = APIRouter(prefix="/api", tags=["hospital-admin"])


def _get_hospital(db: Session, hid: int) -> Hospital:
    h = db.get(Hospital, hid)
    if not h:
        raise HTTPException(status_code=404, detail="병원을 찾을 수 없습니다")
    return h


def _require_admin_access(user: dict, hid: int) -> None:
    """관리자 전용 쓰기 가드 — 시스템 관리자 전부, 병원 관리자(role=admin)는 자기 병원만."""
    _require_access(user, hid)
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="관리자 권한이 필요합니다")


# ════════════════════════════════ 병원별 사용량 ════════════════════════════════
_USAGE_CACHE_TTL = 60.0  # Orthanc storage 집계 캐시(초)
_usage_cache: dict[int, tuple[float, dict]] = {}


def _storage_usage(db: Session, hid: int, n_instances: int) -> dict:
    """Orthanc 병원 studies 통계 합산(공유 저장 — 인스턴스 비율 추정). 60초 캐시,
    실패 시 orthanc_ok:false 로 우아 강등."""
    now = time.monotonic()
    cached = _usage_cache.get(hid)
    if cached and now - cached[0] < _USAGE_CACHE_TTL:
        return cached[1]

    out = {"disk_mb": 0, "instances": n_instances, "orthanc_ok": False}
    try:
        from app.dicom.orthanc import OrthancClient

        oc = OrthancClient()
        try:
            if oc.alive():
                st = oc.statistics()
                total_bytes = int(st.get("TotalDiskSize", 0) or 0)
                total_instances = db.execute(
                    select(func.sum(Study.instance_count))
                ).scalar() or 0
                if total_instances > 0 and total_bytes:
                    out["disk_mb"] = round(
                        total_bytes * (n_instances / total_instances) / (1024 * 1024), 1
                    )
                out["orthanc_ok"] = True
        finally:
            oc.close()
    except Exception:  # noqa: BLE001 — Orthanc 미가용은 orthanc_ok=false 로 보고
        pass
    _usage_cache[hid] = (now, out)
    return out


@router.get("/hospitals/{hid}/usage")
def hospital_usage(hid: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """병원별 DB·Storage 사용량 — {db:{studies,reports,annotations}, storage:{...}}."""
    _require_access(user, hid)
    _get_hospital(db, hid)
    studies = db.execute(select(Study.id, Study.instance_count)
                         .where(Study.hospital_id == hid)).all()
    study_ids = [sid for sid, _ in studies]
    n_instances = sum(cnt or 0 for _, cnt in studies)
    n_reports = 0
    n_annos = 0
    if study_ids:
        n_reports = db.execute(
            select(func.count()).select_from(Report).where(Report.study_id.in_(study_ids))
        ).scalar() or 0
        n_annos = db.execute(
            select(func.count()).select_from(Annotation).where(Annotation.study_id.in_(study_ids))
        ).scalar() or 0
    return {
        "db": {"studies": len(study_ids), "reports": n_reports, "annotations": n_annos},
        "storage": _storage_usage(db, hid, n_instances),
    }


# ════════════════════════════════ 병원별 권한 매트릭스 ════════════════════════════════
def _matrix_payload(db: Session, hid: int) -> dict:
    return {
        "roles": [{"key": r, "label": ROLES[r]} for r in CLIENT_ROLES],
        "permissions": [{"key": k, "label": v} for k, v in PERMISSIONS.items()],
        # 기본 매트릭스 폴백 병합 — 오버라이드 없는 역할은 기본값
        "matrix": {r: sorted(effective_perms(db, r, hid)) for r in CLIENT_ROLES},
    }


@router.get("/hospitals/{hid}/perm-matrix")
def get_perm_matrix(hid: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    _require_access(user, hid)
    _get_hospital(db, hid)
    return _matrix_payload(db, hid)


class PermMatrixBody(BaseModel):
    matrix: dict[str, list[str]]


@router.put("/hospitals/{hid}/perm-matrix")
def put_perm_matrix(hid: int, body: PermMatrixBody, db: Session = Depends(get_db),
                    user: dict = Depends(current_user)):
    """병원별 등급 권한 매트릭스 저장 — 관리자 전용(hospital 스코프 'perm.matrix')."""
    _require_admin_access(user, hid)
    _get_hospital(db, hid)
    clean: dict[str, list[str]] = {}
    for role, perms in body.matrix.items():
        if role not in CLIENT_ROLES:
            raise HTTPException(status_code=400, detail=f"알 수 없는 역할: {role} (admin 은 편집 불가)")
        bad = [p for p in perms if p not in PERMISSIONS]
        if bad:
            raise HTTPException(status_code=400, detail=f"알 수 없는 권한 키: {', '.join(bad)}")
        clean[role] = sorted(set(perms))
    set_hospital_setting(db, hid, "perm.matrix", {"matrix": clean})
    db.add(AuditLog(account_id=user.get("uid"), action="perm_matrix_update",
                    target_type="hospital", target_id=str(hid), detail={"matrix": clean}))
    db.commit()
    return _matrix_payload(db, hid)


@router.get("/perm/me")
def my_effective_perms(db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """로그인 사용자의 유효 권한(병원 매트릭스 반영) — 워크리스트/뷰어 게이트용."""
    role = user.get("role", "")
    hid = user.get("hid")
    return {"role": role, "hospital_id": hid,
            "perms": sorted(effective_perms(db, role, hid))}


# ════════════════════════════════ 병원별 SCP Modality 노드 ════════════════════════════════
_NODE_KINDS = ("scp", "scu")


@router.get("/hospitals/{hid}/modalities")
def get_hospital_modalities(hid: int, db: Session = Depends(get_db),
                            user: dict = Depends(current_user)):
    """병원 SCP Modality 등록 목록 — hospital 스코프 setting 'modality.nodes'."""
    _require_access(user, hid)
    _get_hospital(db, hid)
    stored = get_hospital_setting(db, hid, "modality.nodes", default={}) or {}
    return {"items": stored.get("items", [])}


class ModalityNode(BaseModel):
    name: str
    ae_title: str = ""
    ip: str = ""
    port: int = 104
    kind: str = "scp"  # scp | scu


class ModalityNodesBody(BaseModel):
    items: list[ModalityNode]


@router.put("/hospitals/{hid}/modalities")
def put_hospital_modalities(hid: int, body: ModalityNodesBody, db: Session = Depends(get_db),
                            user: dict = Depends(current_user)):
    _require_admin_access(user, hid)
    _get_hospital(db, hid)
    items = []
    for n in body.items:
        name = n.name.strip()
        aet = n.ae_title.strip().upper()
        if not name:
            raise HTTPException(status_code=400, detail="장비 이름은 필수입니다")
        if not aet:
            raise HTTPException(status_code=400, detail=f"{name}: AE Title은 필수입니다")
        if not (0 < n.port < 65536):
            raise HTTPException(status_code=400, detail=f"{name}: Port는 1~65535 범위여야 합니다")
        if n.kind not in _NODE_KINDS:
            raise HTTPException(status_code=400, detail=f"{name}: kind는 scp|scu")
        items.append({"name": name[:64], "ae_title": aet[:32],
                      "ip": n.ip.strip()[:128], "port": n.port, "kind": n.kind})
    set_hospital_setting(db, hid, "modality.nodes", {"items": items})
    db.add(AuditLog(account_id=user.get("uid"), action="hospital_modalities_update",
                    target_type="hospital", target_id=str(hid), detail={"count": len(items)}))
    db.commit()
    return {"items": items}


class NodeTestBody(BaseModel):
    ip: str
    port: int = 0
    ae_title: str = ""
    mode: str = "ping"  # ping | echo


@router.post("/hospitals/{hid}/modalities/test")
def test_hospital_modality(hid: int, body: NodeTestBody, db: Session = Depends(get_db),
                           user: dict = Depends(current_user)):
    """Modality 연결 테스트(초록●/빨강● 상태용) — admin net-test 로직 재사용."""
    _require_access(user, hid)  # 해당 병원 접근 가드(상태 표시는 병원 사용자에게도 필요)
    _get_hospital(db, hid)
    from app.api.admin import net_dicom_echo, net_ping

    if body.mode == "echo":
        return net_dicom_echo({"ip": body.ip, "port": body.port, "ae_title": body.ae_title},
                              user=user)
    if body.mode == "ping":
        return net_ping({"ip": body.ip, "port": body.port or None}, user=user)
    raise HTTPException(status_code=400, detail="mode는 ping|echo")


# ════════════════════════════════ 병원 설정(SCU/병원명) ════════════════════════════════
@router.get("/hospitals/{hid}/scu")
def get_hospital_scu(hid: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """병원 설정 — 병원명·SCU AE(Hospital 컬럼) + IP/Port(setting 'hospital.scu')."""
    _require_access(user, hid)
    h = _get_hospital(db, hid)
    stored = get_hospital_setting(db, hid, "hospital.scu", default={}) or {}
    return {"name": h.name, "ae_title": h.ae_title,
            "ip": stored.get("ip", ""), "port": int(stored.get("port", 0) or 0)}


class ScuBody(BaseModel):
    name: str = ""
    ae_title: str = ""
    ip: str = ""
    port: int = 0


@router.put("/hospitals/{hid}/scu")
def put_hospital_scu(hid: int, body: ScuBody, db: Session = Depends(get_db),
                     user: dict = Depends(current_user)):
    _require_admin_access(user, hid)
    h = _get_hospital(db, hid)
    if body.port and not (0 < body.port < 65536):
        raise HTTPException(status_code=400, detail="Port는 1~65535 범위여야 합니다")
    # 병원명·AE Title 은 Hospital 컬럼 갱신(스키마 변경 없음), IP/Port 는 hospital 스코프 setting
    if body.name.strip():
        h.name = body.name.strip()[:128]
    h.ae_title = body.ae_title.strip().upper()[:32]
    set_hospital_setting(db, hid, "hospital.scu",
                         {"ip": body.ip.strip()[:128], "port": body.port})
    db.add(AuditLog(account_id=user.get("uid"), action="hospital_scu_update",
                    target_type="hospital", target_id=str(hid),
                    detail={"name": h.name, "ae_title": h.ae_title}))
    db.commit()
    return {"name": h.name, "ae_title": h.ae_title, "ip": body.ip.strip(), "port": body.port}


# ════════════════════════════════ 영상 관리 액션(삭제·이동·매칭·언매칭·복제) ════════════════════════════════
_ACTION_PERM = {
    "delete": "study.delete",
    "move": "study.move",
    "match": "study.match",
    "unmatch": "study.unmatch",
    "copy": "study.copy",
}


class AdminActionBody(BaseModel):
    action: str  # delete | move | match | unmatch | copy
    target_hid: int | None = None  # move: 이동할 병원 / copy: 사본 귀속 병원(생략=동일 병원)
    order_id: int | None = None    # match: 연결할 오더


def _orthanc_delete_study(orthanc_id: str) -> bool:
    """Orthanc 검사 삭제 — 미가용/실패는 False 로 보고(우아 강등)."""
    if not orthanc_id:
        return False
    try:
        from app.dicom.orthanc import OrthancClient

        oc = OrthancClient()
        try:
            if not oc.alive():
                return False
            r = oc._client.delete(f"/studies/{orthanc_id}")
            return r.status_code in (200, 204)
        finally:
            oc.close()
    except Exception:  # noqa: BLE001 — 삭제 결과로 보고
        return False


@router.post("/studies/{study_id}/admin-action")
def study_admin_action(study_id: int, body: AdminActionBody, db: Session = Depends(get_db),
                       user: dict = Depends(current_user)):
    """영상 관리 액션 — 유효 권한(병원 매트릭스 반영) 강제 + 감사 로그."""
    perm = _ACTION_PERM.get(body.action)
    if not perm:
        raise HTTPException(status_code=400, detail="action은 delete|move|match|unmatch|copy")
    study = db.get(Study, study_id)
    if not study:
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    # 병원 접근 가드 — 소속 병원 검사만(미배정 검사는 시스템 관리자만)
    if study.hospital_id is not None:
        _require_access(user, study.hospital_id)
    elif not _is_system_admin(user):
        raise HTTPException(status_code=403, detail="미배정 검사는 시스템 관리자만 관리할 수 있습니다")
    # 유효 권한 강제(병원별 매트릭스 반영)
    if perm not in effective_perms(db, user.get("role", ""), user.get("hid")):
        raise HTTPException(status_code=403, detail=f"이 작업({PERMISSIONS[perm]})에 대한 권한이 없습니다")

    detail: dict = {"by": user.get("sub", ""), "action": body.action}
    result: dict = {"ok": True, "action": body.action, "study_id": study_id}

    if body.action == "delete":
        removed = _orthanc_delete_study(study.orthanc_id)
        from app.api.management import _delete_study_rows  # 기존 삭제 로직 재사용

        _delete_study_rows(db, study)
        detail["orthanc_removed"] = removed
        result["orthanc_removed"] = removed

    elif body.action == "move":
        if body.target_hid is None:
            raise HTTPException(status_code=400, detail="move에는 target_hid가 필요합니다")
        target = _get_hospital(db, body.target_hid)
        detail["from_hid"] = study.hospital_id
        detail["to_hid"] = target.id
        study.hospital_id = target.id
        result["hospital_id"] = target.id

    elif body.action == "match":
        if body.order_id is None:
            raise HTTPException(status_code=400, detail="match에는 order_id가 필요합니다")
        order = db.get(Order, body.order_id)
        if not order:
            raise HTTPException(status_code=404, detail="오더를 찾을 수 없습니다")
        # 최소 구현: accession 링크(워크리스트 ORDER NAME 조인 축) — study.order_id 컬럼 없음(스키마 불변)
        detail["order_id"] = order.id
        detail["accession_no"] = order.accession_no
        study.accession_no = order.accession_no
        result["accession_no"] = order.accession_no

    elif body.action == "unmatch":
        detail["accession_no"] = study.accession_no
        study.accession_no = ""
        result["accession_no"] = ""

    elif body.action == "copy":
        # 사본 등록(DB 행 복제 — 영상은 동일 Orthanc 검사 공유).
        # target_hid 지정 시 해당 병원으로 귀속(타병원 복제), 미지정 시 동일 병원.
        dest_hid = study.hospital_id
        if body.target_hid is not None:
            dest_hid = _get_hospital(db, body.target_hid).id
            detail["to_hid"] = dest_hid
        n = 1
        while db.execute(
            select(Study.id).where(Study.study_uid == f"{study.study_uid}.C{n}")
        ).first():
            n += 1
        dup = Study(
            patient_id=study.patient_id,
            study_uid=f"{study.study_uid}.C{n}",
            accession_no=study.accession_no,
            study_date=study.study_date, study_time=study.study_time,
            modality=study.modality, body_part=study.body_part,
            study_desc=f"{study.study_desc} (사본)".strip(),
            clinical_info=study.clinical_info,
            institution=study.institution, referring_physician=study.referring_physician,
            department=study.department, source_aet=study.source_aet,
            orthanc_id=study.orthanc_id,
            hospital_id=dest_hid,
            status="received",
            series_count=study.series_count, instance_count=study.instance_count,
        )
        db.add(dup)
        db.flush()
        detail["copy_study_id"] = dup.id
        result["copy_study_id"] = dup.id
        result["copy_study_uid"] = dup.study_uid
        result["hospital_id"] = dest_hid

    db.add(AuditLog(account_id=user.get("uid"), action=f"study_{body.action}",
                    target_type="study", target_id=str(study_id), detail=detail))
    db.commit()
    return result


# ════════════ 병원 기본 워크리스트·뷰어 설정 (설정>워크리스트와 동일 구현 — 어디서나 작업) ════════════
# 관리 콘솔 [뷰어·워크리스트 설정] 탭이 병원 스코프로 저장하고, 계정별 설정이 없는
# 사용자는 /api/settings 조회 시 이 병원 기본값으로 폴백된다(user > hospital > 빈값).
WL_SETTING_KEYS = set(WL_HOSPITAL_KEYS)  # 사용자 폴백(settings.py)과 단일 소스 공유


class WlSettingBody(BaseModel):
    value: dict


@router.get("/hospitals/{hid}/wl-setting/{key}")
def get_wl_setting(hid: int, key: str, db: Session = Depends(get_db),
                   user: dict = Depends(current_user)):
    _require_access(user, hid)
    if key not in WL_SETTING_KEYS:
        raise HTTPException(status_code=404, detail="알 수 없는 워크리스트 설정 키")
    _get_hospital(db, hid)
    return {"key": key, "value": get_hospital_setting(db, hid, key, default={})}


@router.put("/hospitals/{hid}/wl-setting/{key}")
def put_wl_setting(hid: int, key: str, body: WlSettingBody, db: Session = Depends(get_db),
                   user: dict = Depends(current_user)):
    _require_admin_access(user, hid)
    if key not in WL_SETTING_KEYS:
        raise HTTPException(status_code=404, detail="알 수 없는 워크리스트 설정 키")
    _get_hospital(db, hid)
    if key == "worklist.tabs":
        items = body.value.get("items", [])
        if not isinstance(items, list) or len(items) > 10:
            raise HTTPException(status_code=400, detail="워크리스트 페이지는 리스트 최대 10개입니다 (UBPACS-Z 규격)")
    set_hospital_setting(db, hid, key, body.value)
    db.add(AuditLog(account_id=user.get("uid"), action="hospital_wl_setting",
                    target_type="hospital", target_id=str(hid), detail={"key": key}))
    db.commit()
    return {"ok": True, "key": key, "scope": "hospital"}
