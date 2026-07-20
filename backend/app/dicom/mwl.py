"""MWL(Modality Worklist) 파일 생성 — Orthanc worklists 플러그인 연동(P2).

오더(orders 테이블)를 DICOM MWL 데이터셋(.wl)으로 내보내면 Orthanc의
ModalityWorklists 플러그인이 장비의 C-FIND(MWL) 질의에 응답한다.
MPPS는 P2 범위에서 오더 status 매핑(scheduled→in_progress→completed)으로 대체한다.
"""
from __future__ import annotations

import io
from pathlib import Path

from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

MWL_FIND_SOP_CLASS = "1.2.840.10008.5.1.4.31"  # Modality Worklist Information Model - FIND


def build_mwl_dataset(order) -> Dataset:
    """Order ORM 객체 → MWL 데이터셋."""
    fm = FileMetaDataset()
    fm.MediaStorageSOPClassUID = MWL_FIND_SOP_CLASS
    fm.MediaStorageSOPInstanceUID = generate_uid()
    fm.TransferSyntaxUID = ExplicitVRLittleEndian

    ds = Dataset()
    ds.file_meta = fm
    ds.SpecificCharacterSet = "ISO_IR 192"

    ds.PatientID = order.patient_key
    ds.PatientName = order.patient_name or order.patient_key
    ds.PatientBirthDate = order.birth_date or ""
    ds.PatientSex = order.sex or ""
    ds.AccessionNumber = order.accession_no or f"SV{order.id:08d}"
    ds.StudyInstanceUID = generate_uid()
    ds.StudyID = order.dicom_study_id or f"S{order.id:06d}"  # (0020,0010)
    ds.RequestedProcedureID = f"RP{order.id}"
    ds.RequestedProcedureDescription = order.procedure_desc or ""
    # 의뢰의/진료과 — RIS 오더 입력(가상 생성기 명시 모드) 값 노출 (없으면 빈 값 유지)
    ds.ReferringPhysicianName = getattr(order, "physician", "") or ""
    dept = getattr(order, "department", "") or ""
    if dept:
        ds.InstitutionalDepartmentName = dept  # (0008,1040)

    sps = Dataset()
    sps.Modality = order.modality or "OT"
    sps.ScheduledStationAETitle = order.station_aet or "ANY"
    sps.ScheduledProcedureStepStartDate = order.scheduled_date or ""
    sps.ScheduledProcedureStepStartTime = order.scheduled_time or ""
    sps.ScheduledPerformingPhysicianName = ""
    # 부위·촬영방향 — 장비 프로토콜 매칭용
    desc_parts = [order.procedure_desc or "", order.projection or ""]
    sps.ScheduledProcedureStepDescription = " ".join(p for p in desc_parts if p).strip()
    if order.body_part:
        sps.BodyPartExamined = order.body_part  # (0018,0015)
    sps.ScheduledProcedureStepID = f"SPS{order.id}"
    ds.ScheduledProcedureStepSequence = [sps]
    return ds


def mwl_bytes(ds: Dataset) -> bytes:
    buf = io.BytesIO()
    ds.save_as(buf, write_like_original=False)
    return buf.getvalue()


def export_worklist_files(orders: list, out_dir: str) -> int:
    """scheduled 오더들을 {out_dir}/svNNN.wl 파일로 내보낸다(기존 sv*.wl 교체)."""
    path = Path(out_dir)
    path.mkdir(parents=True, exist_ok=True)
    for old in path.glob("sv*.wl"):
        old.unlink()
    count = 0
    for order in orders:
        ds = build_mwl_dataset(order)
        (path / f"sv{order.id:06d}.wl").write_bytes(mwl_bytes(ds))
        count += 1
    return count
