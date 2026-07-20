"""MWL SCP — 장비별 환자·검사 정보 주기(pynetdicom Modality Worklist C-FIND 응답).

병원별 mwl.config(hospital 스코프) = {enabled, port, aet, registered_only} 로 SCP 를 띄우고,
미완료(scheduled) 오더를 병원·장비 AET 필터로 응답한다(기본 off — 명시 기동).
registered_only=True 면 병원 등록 Modality(modality.nodes)의 AET 에서 온 질의만 허용.

기존 app/dicom/mwl.py(파일 기반 Orthanc worklists 내보내기)와 별개의 실시간 SCP 경로다.
"""
from __future__ import annotations

import logging
import threading
from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.models import Order

logger = logging.getLogger("saintview.mwl")

CONFIG_KEY = "mwl.config"


def order_matches(order: Order, query) -> bool:
    """C-FIND 질의 데이터셋과 오더 매칭 — 빈 질의 필드는 와일드카드."""
    modality = ""
    station = ""
    start_date = ""
    sps_seq = getattr(query, "ScheduledProcedureStepSequence", None)
    if sps_seq:
        sps = sps_seq[0]
        modality = str(getattr(sps, "Modality", "") or "")
        station = str(getattr(sps, "ScheduledStationAETitle", "") or "")
        start_date = str(getattr(sps, "ScheduledProcedureStepStartDate", "") or "")
    if modality and order.modality != modality:
        return False
    if station and station != "ANY" and order.station_aet and order.station_aet != station:
        return False
    if start_date and order.scheduled_date:
        if "-" in start_date:  # 범위 질의 YYYYMMDD-YYYYMMDD
            lo, _, hi = start_date.partition("-")
            if lo and order.scheduled_date < lo:
                return False
            if hi and order.scheduled_date > hi:
                return False
        elif order.scheduled_date != start_date:
            return False
    pid = str(getattr(query, "PatientID", "") or "")
    if pid and pid != "*" and order.patient_key != pid:
        return False
    accession = str(getattr(query, "AccessionNumber", "") or "")
    if accession and order.accession_no != accession:
        return False
    return True


def _allowed_aets(db: Session, hospital_id: int) -> set[str]:
    """병원 등록 Modality(modality.nodes)의 AET 집합 — registered_only 검증용."""
    from app.services.settings_service import get_hospital_setting

    stored = get_hospital_setting(db, hospital_id, "modality.nodes", default={}) or {}
    return {str(i.get("ae_title") or "").upper()
            for i in stored.get("items", []) if i.get("ae_title")}


def mark_taken(db: Session, order_ids: list[int], calling: str) -> None:
    """장비가 MWL 로 가져간 오더 기록 — 호출 AET·시각 관찰만, status 는 불변.

    DICOM 관례상 장비는 같은 워크리스트를 재질의하므로 MWL 응답은 계속 제공하고,
    재질의 시 최신 AET/시각으로 갱신한다. calling 이 비면 "(unknown)" 으로 기록.
    """
    if not order_ids:
        return
    db.execute(
        update(Order)
        .where(Order.id.in_(order_ids))
        .values(taken_aet=(calling or "(unknown)")[:32],
                taken_at=datetime.now(timezone.utc))
    )
    db.commit()


def _pending_orders(db: Session, hospital_id: int) -> list[Order]:
    """미완료(scheduled) 오더 — 해당 병원 귀속만(테넌시 격리). 전역 NULL 누출 제거."""
    q = select(Order).where(
        Order.status == "scheduled",
        Order.hospital_id == hospital_id,
    ).order_by(Order.scheduled_date, Order.scheduled_time)
    return list(db.execute(q).scalars())


def _make_handler(hospital_id: int, registered_only: bool):
    """hospital_id 고정 C-FIND 핸들러 생성."""

    def handle_find(event):
        from app.db import SessionLocal
        from app.dicom.mwl import build_mwl_dataset

        try:
            calling = str(event.assoc.requestor.ae_title or "").strip().upper()
        except Exception:  # noqa: BLE001 — AET 추출 실패는 익명 취급
            calling = ""
        with SessionLocal() as db:
            if registered_only:
                allowed = _allowed_aets(db, hospital_id)
                if allowed and calling not in allowed:
                    logger.warning("MWL 질의 거부 — 미등록 AET %s (hospital=%d)", calling, hospital_id)
                    yield 0xA700, None  # Refused: Out of Resources(등록 장비 아님)
                    return
            query = event.identifier
            yielded_ids: list[int] = []  # 장비에 응답(yield)한 오더 — 가져감 기록 대상
            try:
                for order in _pending_orders(db, hospital_id):
                    if event.is_cancelled:
                        yield 0xFE00, None
                        return
                    if order_matches(order, query):
                        ds = build_mwl_dataset(order)
                        yielded_ids.append(order.id)
                        yield 0xFF00, ds
            finally:
                # 취소·연결 끊김(GeneratorExit) 경로 포함 — 이미 응답한 오더만 기록.
                # registered_only 거부 경로는 try 진입 전이라 기록되지 않는다.
                mark_taken(db, yielded_ids, calling)
        # 매칭 순회 종료 — pynetdicom 이 Success(0x0000)로 마감

    return handle_find


class _MwlServer:
    def __init__(self, ae, server, port: int, aet: str) -> None:
        self.ae = ae
        self.server = server
        self.port = port
        self.aet = aet


_servers: dict[int, _MwlServer] = {}  # hospital_id → server
_lock = threading.Lock()


def start_mwl(hospital_id: int, port: int, aet: str = "SAINTVIEW",
              registered_only: bool = False) -> dict:
    """병원별 MWL SCP 기동(비차단). 이미 떠 있으면 재사용."""
    from pynetdicom import AE, evt
    from pynetdicom.sop_class import ModalityWorklistInformationFind

    with _lock:
        if hospital_id in _servers:
            s = _servers[hospital_id]
            return {"hospital_id": hospital_id, "running": True, "port": s.port,
                    "aet": s.aet, "already": True}
        ae = AE(ae_title=aet or "SAINTVIEW")
        ae.add_supported_context(ModalityWorklistInformationFind)
        handlers = [(evt.EVT_C_FIND, _make_handler(hospital_id, registered_only))]
        server = ae.start_server(("0.0.0.0", port), block=False, evt_handlers=handlers)
        _servers[hospital_id] = _MwlServer(ae, server, port, aet)
    logger.info("MWL SCP 시작 — hospital=%d AET=%s Port=%d", hospital_id, aet, port)
    return {"hospital_id": hospital_id, "running": True, "port": port, "aet": aet}


def stop_mwl(hospital_id: int) -> dict:
    with _lock:
        s = _servers.pop(hospital_id, None)
    if s is not None:
        s.server.shutdown()
        logger.info("MWL SCP 종료 — hospital=%d", hospital_id)
    return {"hospital_id": hospital_id, "running": False}


def mwl_status(hospital_id: int) -> dict:
    with _lock:
        s = _servers.get(hospital_id)
    if s is None:
        return {"hospital_id": hospital_id, "running": False}
    return {"hospital_id": hospital_id, "running": True, "port": s.port, "aet": s.aet}
