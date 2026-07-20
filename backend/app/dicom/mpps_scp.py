"""MPPS SCP — 장비의 Modality Performed Procedure Step(N-CREATE/N-SET) 수신.

장비가 검사를 시작/완료하면 보내는 MPPS DIMSE 메시지를 받아 오더(Order) 상태를 갱신한다.
- N-CREATE: 검사 시작(IN PROGRESS)
- N-SET: 검사 완료(COMPLETED) 또는 중단(DISCONTINUED)

pynetdicom AE를 listener(SCP)로 띄운다. FastAPI lifespan에서 백그라운드로 구동.
"""
from __future__ import annotations

import logging

from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditLog, Order

logger = logging.getLogger("saintview.mpps")

# PerformedProcedureStepStatus → Order.status (MPPS 상태 매핑)
_STATUS_MAP = {
    "IN PROGRESS": "in_progress",
    "COMPLETED": "completed",
    "DISCONTINUED": "cancelled",
}


def _extract(ds) -> tuple[str, str, str]:
    """MPPS 데이터셋에서 (accession, study_uid, 상태) 추출."""
    accession = ""
    study_uid = ""
    sps = getattr(ds, "ScheduledStepAttributesSequence", None)
    if sps:
        item = sps[0]
        accession = str(getattr(item, "AccessionNumber", "") or "")
        study_uid = str(getattr(item, "StudyInstanceUID", "") or "")
    status = str(getattr(ds, "PerformedProcedureStepStatus", "") or "").upper()
    return accession, study_uid, _STATUS_MAP.get(status, "")


def apply_mpps(ds) -> bool:
    """MPPS 데이터셋 → 오더 상태 갱신. 매칭/매핑되면 True."""
    accession, study_uid, status = _extract(ds)
    if not status:
        return False
    with SessionLocal() as db:
        order = None
        if accession:
            order = db.execute(
                select(Order).where(Order.accession_no == accession)
            ).scalar_one_or_none()
        if order is None and study_uid:
            order = db.execute(
                select(Order).where(Order.dicom_study_id == study_uid)
            ).scalar_one_or_none()
        if order is None:
            logger.info("MPPS 수신 — 매칭 오더 없음 (accession=%s status=%s)", accession, status)
            return False
        order.status = status
        db.add(AuditLog(action="mpps_update", target_type="order", target_id=str(order.id),
                        detail={"status": status, "accession": accession}))
        db.commit()
        logger.info("MPPS 오더 갱신 order=%s → %s", order.id, status)
        return True


def _handle_n_create(event):
    from pydicom.uid import generate_uid

    from pynetdicom.sop_class import ModalityPerformedProcedureStep

    ds = event.attribute_list
    try:
        apply_mpps(ds)
    except Exception:  # noqa: BLE001 — DIMSE 응답은 정상 반환
        logger.exception("MPPS N-CREATE 처리 오류")
    # SCP가 SOP Instance UID를 부여하고 생성 객체 속성을 회신
    sop = getattr(event.request, "AffectedSOPInstanceUID", None) or generate_uid()
    ds.SOPClassUID = ModalityPerformedProcedureStep
    ds.SOPInstanceUID = sop
    return 0x0000, ds


def _handle_n_set(event):
    ds = event.attribute_list
    try:
        apply_mpps(ds)
    except Exception:  # noqa: BLE001
        logger.exception("MPPS N-SET 처리 오류")
    return 0x0000, ds


def start_mpps_server(port: int, aet: str = "SAINTVIEW"):
    """MPPS SCP 리스너 기동(비차단). 반환: (ae, server) — server.shutdown()으로 종료."""
    from pynetdicom import AE, evt
    from pynetdicom.sop_class import ModalityPerformedProcedureStep

    ae = AE(ae_title=aet)
    ae.add_supported_context(ModalityPerformedProcedureStep)
    handlers = [(evt.EVT_N_CREATE, _handle_n_create), (evt.EVT_N_SET, _handle_n_set)]
    server = ae.start_server(("0.0.0.0", port), block=False, evt_handlers=handlers)
    logger.info("MPPS SCP 리스너 시작 — AET=%s Port=%d", aet, port)
    return ae, server
