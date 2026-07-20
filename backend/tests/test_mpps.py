"""36차 — 실 MPPS: 장비의 N-CREATE/N-SET 수신 → 오더 상태 갱신(실 DIMSE)."""
from __future__ import annotations

import time

from app.db import SessionLocal
from app.models import Order


def _free_port() -> int:
    import socket

    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _mpps_dataset(accession: str, status: str):
    from pydicom.dataset import Dataset

    ds = Dataset()
    ds.PerformedProcedureStepStatus = status
    step = Dataset()
    step.AccessionNumber = accession
    step.StudyInstanceUID = "1.2.3.4.5"
    ds.ScheduledStepAttributesSequence = [step]
    return ds


def test_mpps_n_create_and_set_updates_order(db):
    from pydicom.uid import generate_uid
    from pynetdicom import AE
    from pynetdicom.sop_class import ModalityPerformedProcedureStep

    from app.dicom.mpps_scp import start_mpps_server

    # 오더 생성(scheduled)
    order = Order(patient_key="MPPS-P1", accession_no="ACC-MPPS-1", modality="CT",
                  status="scheduled")
    db.add(order); db.commit(); db.refresh(order)
    oid = order.id

    port = _free_port()
    ae_srv, server = start_mpps_server(port, "TESTMPPS")
    try:
        # 장비(SCU) 역할로 N-CREATE(IN PROGRESS) 전송
        scu = AE()
        scu.add_requested_context(ModalityPerformedProcedureStep)
        assoc = scu.associate("127.0.0.1", port, ae_title="TESTMPPS")
        assert assoc.is_established, "MPPS SCP 연관 수립 실패"
        sop_uid = generate_uid()
        st, _ = assoc.send_n_create(_mpps_dataset("ACC-MPPS-1", "IN PROGRESS"),
                                    ModalityPerformedProcedureStep, sop_uid)
        assert st and st.Status == 0x0000
        # N-SET(COMPLETED)
        st2, _ = assoc.send_n_set(_mpps_dataset("ACC-MPPS-1", "COMPLETED"),
                                  ModalityPerformedProcedureStep, sop_uid)
        assert st2 and st2.Status == 0x0000
        assoc.release()
    finally:
        server.shutdown()

    # 상태 갱신 확인(핸들러는 별도 세션 — 새 세션으로 재조회)
    for _ in range(20):
        with SessionLocal() as s:
            cur = s.get(Order, oid)
            if cur.status == "completed":
                break
        time.sleep(0.05)
    with SessionLocal() as s:
        assert s.get(Order, oid).status == "completed"


def test_mpps_discontinued_maps_to_cancelled(db):
    from app.dicom.mpps_scp import apply_mpps

    order = Order(patient_key="MPPS-P2", accession_no="ACC-MPPS-2", modality="MR",
                  status="in_progress")
    db.add(order); db.commit(); db.refresh(order)
    oid = order.id
    # 핸들러 핵심 로직 직접 검증(상태 매핑)
    assert apply_mpps(_mpps_dataset("ACC-MPPS-2", "DISCONTINUED")) is True
    with SessionLocal() as s:
        assert s.get(Order, oid).status == "cancelled"
    # 매칭 오더 없으면 False
    assert apply_mpps(_mpps_dataset("NO-SUCH-ACC", "COMPLETED")) is False
