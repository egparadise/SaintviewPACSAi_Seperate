"""오더/예약 API (RIS — P2) — MWL 내보내기 + MPPS 상태 매핑."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import current_user
from app.config import get_settings
from app.db import get_db
from app.models import AuditLog, Order

router = APIRouter(prefix="/api/orders", tags=["orders"])

# MPPS 상태 전이: 예약 → 진행중(IN PROGRESS) → 완료(COMPLETED) / 취소(DISCONTINUED)
_TRANSITIONS: dict[str, set[str]] = {
    "scheduled": {"in_progress", "cancelled"},
    "in_progress": {"completed", "cancelled"},
    "completed": set(),
    "cancelled": set(),
}


def _scope_hid(user: dict, selected: int = 0) -> int | None:
    """오더 병원 스코프(worklist._scoped_hospital 과 동일 규칙, 테넌시 격리):
    - 시스템 관리자(병원 미소속 admin): 선택 병원 필터, 미선택이면 전체(None).
    - 병원 소속 사용자: 항상 자기 병원으로 고정.
    """
    if user.get("role") == "admin" and not user.get("hid"):
        return selected or None
    return user.get("hid")


def _guard_owner(order: Order, user: dict) -> None:
    """오더 소유 병원 가드 — 병원 소속 사용자는 타 병원 오더 접근 불가(존재 은닉 위해 404)."""
    hid = user.get("hid")
    if hid and order.hospital_id != hid:
        raise HTTPException(status_code=404, detail="오더를 찾을 수 없습니다")


def _order_out(o: Order) -> dict:
    return {
        "id": o.id, "patient_key": o.patient_key, "patient_name": o.patient_name,
        "birth_date": o.birth_date, "sex": o.sex, "accession_no": o.accession_no,
        "modality": o.modality, "scheduled_date": o.scheduled_date,
        "scheduled_time": o.scheduled_time, "procedure_desc": o.procedure_desc,
        "station_aet": o.station_aet, "status": o.status,
        "body_part": o.body_part, "projection": o.projection, "dicom_study_id": o.dicom_study_id,
        "physician": o.physician, "department": o.department, "hospital_id": o.hospital_id,
        # 장비 가져감 관찰 — MWL C-FIND 응답 시 기록(상태 불변)
        "taken_aet": o.taken_aet,
        "taken_at": o.taken_at.isoformat() if o.taken_at else "",
    }


@router.get("")
def list_orders(
    status: str = "", date: str = "", hospital_id: int = 0, taken: str = "", limit: int = 100,
    db: Session = Depends(get_db), user: dict = Depends(current_user),
):
    q = select(Order)
    if status:
        q = q.where(Order.status == status)
    if date:
        q = q.where(Order.scheduled_date == date)
    # 병원 스코프 — JWT 에서 결정(병원 소속 사용자는 자기 병원 고정). NULL(전역) 누출 제거: 엄격 일치.
    scope = _scope_hid(user, hospital_id)
    if scope is not None:
        q = q.where(Order.hospital_id == scope)
    if taken == "yes":   # 장비가 가져간 오더만
        q = q.where(Order.taken_aet != "")
    elif taken == "no":  # 아직 안 가져간 오더만
        q = q.where(Order.taken_aet == "")
    q = q.order_by(Order.scheduled_date.desc(), Order.scheduled_time.desc(), Order.id.desc())
    rows = db.execute(q.limit(min(limit, 500))).scalars().all()
    return {"items": [_order_out(o) for o in rows]}


class OrderBody(BaseModel):
    patient_key: str
    patient_name: str = ""     # DICOM PN: Last^First (프론트 폼에서 조합)
    birth_date: str = ""
    sex: str = ""
    accession_no: str = ""     # 빈값 = 자동 채번
    modality: str = "CR"
    scheduled_date: str = ""   # YYYYMMDD
    scheduled_time: str = ""   # HHMMSS
    procedure_desc: str = ""
    station_aet: str = ""
    body_part: str = ""
    projection: str = ""       # PA/AP/LAT…
    dicom_study_id: str = ""   # 빈값 = 자동 채번
    hospital_id: int | None = None  # 시스템 관리자만 지정(병원 소속 사용자는 무시하고 자기 병원 고정)


@router.post("")
def create_order(body: OrderBody, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    if not body.patient_key.strip():
        raise HTTPException(status_code=400, detail="patient_key는 필수입니다")
    if body.scheduled_date and len(body.scheduled_date) != 8:
        raise HTTPException(status_code=400, detail="scheduled_date는 YYYYMMDD")
    order = Order(
        patient_key=body.patient_key.strip()[:128],
        patient_name=body.patient_name[:128],
        birth_date=body.birth_date[:8],
        sex=body.sex[:8],
        accession_no=body.accession_no[:64],
        modality=body.modality[:16],
        scheduled_date=body.scheduled_date,
        scheduled_time=body.scheduled_time[:6],
        procedure_desc=body.procedure_desc[:256],
        station_aet=body.station_aet[:32],
        body_part=body.body_part.strip().upper()[:64],
        projection=body.projection.strip().upper()[:32],
        dicom_study_id=body.dicom_study_id[:16],
        # 테넌시 — 병원 소속 사용자는 자기 병원으로 고정, 시스템 관리자만 body 로 지정 가능
        hospital_id=user.get("hid") or body.hospital_id,
    )
    db.add(order)
    db.flush()
    if not order.accession_no:
        order.accession_no = f"SV{order.id:08d}"   # Accession 자동 채번
    if not order.dicom_study_id:
        order.dicom_study_id = f"S{order.id:06d}"  # StudyID 자동 채번
    db.add(AuditLog(action="order_create", target_type="order", target_id=str(order.id),
                    detail={"by": user["sub"], "patient": order.patient_key}))
    db.commit()
    return _order_out(order)


class OrderUpdateBody(BaseModel):
    """오더 수정 — 전 필드 옵션(전달된 필드만 반영). scheduled 상태만 허용."""
    patient_name: str | None = None
    birth_date: str | None = None
    sex: str | None = None
    modality: str | None = None
    scheduled_date: str | None = None
    scheduled_time: str | None = None
    procedure_desc: str | None = None
    station_aet: str | None = None
    body_part: str | None = None
    projection: str | None = None
    physician: str | None = None
    department: str | None = None


# 필드별 길이 제한 — create_order 와 동일
_UPDATE_LIMITS = {
    "patient_name": 128, "birth_date": 8, "sex": 8, "modality": 16,
    "scheduled_date": 8, "scheduled_time": 6, "procedure_desc": 256,
    "station_aet": 32, "body_part": 64, "projection": 32,
    "physician": 64, "department": 64,
}


@router.put("/{order_id}")
def update_order(
    order_id: int, body: OrderUpdateBody,
    db: Session = Depends(get_db), user: dict = Depends(current_user),
):
    """오더 수정 — scheduled 상태만 허용(그 외 409). 장비가 이미 진행/완료한 오더 보호."""
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="오더를 찾을 수 없습니다")
    _guard_owner(order, user)
    if order.status != "scheduled":
        raise HTTPException(
            status_code=409, detail=f"'{order.status}' 상태 오더는 수정할 수 없습니다(scheduled만 허용)"
        )
    fields = body.model_dump(exclude_unset=True)
    sd = fields.get("scheduled_date")
    if sd and len(sd) != 8:
        raise HTTPException(status_code=400, detail="scheduled_date는 YYYYMMDD")
    for key, value in fields.items():
        if value is None:
            continue
        value = str(value)
        if key in ("body_part", "projection"):  # create_order 와 동일 정규화
            value = value.strip().upper()
        setattr(order, key, value[:_UPDATE_LIMITS[key]])
    db.add(AuditLog(action="order_update", target_type="order", target_id=str(order_id),
                    detail={"by": user["sub"], "fields": sorted(fields)}))
    db.commit()
    return _order_out(order)


@router.delete("/{order_id}")
def delete_order(
    order_id: int, db: Session = Depends(get_db), user: dict = Depends(current_user),
):
    """오더 삭제 — 상태 무관 허용(MWL 테스트 뷰 정리 용도). 감사 로그에 원본 요약 보존."""
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="오더를 찾을 수 없습니다")
    _guard_owner(order, user)
    db.add(AuditLog(action="order_delete", target_type="order", target_id=str(order_id),
                    detail={"by": user["sub"], "accession": order.accession_no,
                            "patient": order.patient_key, "status": order.status}))
    db.delete(order)
    db.commit()
    return {"ok": True}


class StatusBody(BaseModel):
    status: str  # in_progress | completed | cancelled


@router.put("/{order_id}/status")
def set_order_status(
    order_id: int, body: StatusBody, db: Session = Depends(get_db), user: dict = Depends(current_user)
):
    """MPPS 매핑 상태 전이 — 잘못된 전이는 거부."""
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="오더를 찾을 수 없습니다")
    _guard_owner(order, user)
    if body.status not in _TRANSITIONS.get(order.status, set()):
        raise HTTPException(
            status_code=409, detail=f"'{order.status}' → '{body.status}' 전이는 허용되지 않습니다"
        )
    order.status = body.status
    db.add(AuditLog(action="order_status", target_type="order", target_id=str(order_id),
                    detail={"by": user["sub"], "to": body.status}))
    db.commit()
    return _order_out(order)


@router.post("/export-mwl")
def export_mwl(db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """scheduled 오더를 MWL .wl 파일로 내보내기 — Orthanc worklists 플러그인 폴더."""
    from app.dicom.mwl import export_worklist_files

    q = select(Order).where(Order.status == "scheduled")
    scope = _scope_hid(user)  # 병원 소속 사용자는 자기 병원 오더만 내보내기
    if scope is not None:
        q = q.where(Order.hospital_id == scope)
    orders = db.execute(q).scalars().all()
    out_dir = get_settings().mwl_dir
    count = export_worklist_files(orders, out_dir)
    db.add(AuditLog(action="mwl_export", target_type="order", target_id="*",
                    detail={"by": user["sub"], "count": count, "dir": out_dir}))
    db.commit()
    return {"ok": True, "count": count, "dir": out_dir}
