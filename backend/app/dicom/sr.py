"""DICOM SR 변환 (F-9/D-4) — 판독을 Basic Text SR로 생성.

같은 StudyInstanceUID로 만들어 Orthanc에 저장하면 PACS 생태계에서
검사에 판독 문서가 붙는다(상호운용성 — 분석 문서 §4 P1 항목).
"""
from __future__ import annotations

import io
from datetime import datetime, timezone

from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

BASIC_TEXT_SR = "1.2.840.10008.5.1.4.1.1.88.11"


def _code(value: str, meaning: str, scheme: str = "DCM") -> Dataset:
    d = Dataset()
    d.CodeValue = value
    d.CodingSchemeDesignator = scheme
    d.CodeMeaning = meaning
    return d


def _text_item(concept: Dataset, text: str) -> Dataset:
    item = Dataset()
    item.RelationshipType = "CONTAINS"
    item.ValueType = "TEXT"
    item.ConceptNameCodeSequence = [concept]
    item.TextValue = text[:1024]  # UT 아닌 SR TextValue 보수적 절단
    return item


def build_sr_dataset(*, report, study, patient) -> Dataset:
    """reports/studies/patients ORM 객체 → Basic Text SR Dataset."""
    now = datetime.now(timezone.utc)
    sr_json = report.sr_json or {}

    fm = FileMetaDataset()
    fm.MediaStorageSOPClassUID = BASIC_TEXT_SR
    fm.MediaStorageSOPInstanceUID = generate_uid()
    fm.TransferSyntaxUID = ExplicitVRLittleEndian

    ds = Dataset()
    ds.file_meta = fm
    ds.SpecificCharacterSet = "ISO_IR 192"  # UTF-8 (한글)
    ds.SOPClassUID = BASIC_TEXT_SR
    ds.SOPInstanceUID = fm.MediaStorageSOPInstanceUID
    ds.Modality = "SR"

    # 환자·검사 — 동일 Study에 귀속
    ds.PatientID = patient.patient_key if patient else ""
    ds.PatientName = patient.name_masked if patient else ""
    ds.PatientBirthDate = patient.birth_date if patient else ""
    ds.PatientSex = patient.sex if patient else ""
    ds.StudyInstanceUID = study.study_uid
    ds.AccessionNumber = study.accession_no or ""
    ds.StudyDate = study.study_date or ""
    ds.StudyTime = study.study_time or ""
    ds.StudyID = ""
    ds.ReferringPhysicianName = ""
    ds.SeriesInstanceUID = generate_uid()
    ds.SeriesNumber = 900  # SR 시리즈 관례적 고번호
    ds.InstanceNumber = report.version
    ds.SeriesDescription = "Saintview AI Report"
    ds.Manufacturer = "Saintview PACS AI"

    ds.ContentDate = now.strftime("%Y%m%d")
    ds.ContentTime = now.strftime("%H%M%S")
    ds.CompletionFlag = "COMPLETE" if report.status == "finalized" else "PARTIAL"
    ds.VerificationFlag = "VERIFIED" if report.status == "finalized" else "UNVERIFIED"
    if report.status == "finalized" and report.reviewed_by:
        v = Dataset()
        v.VerifyingObserverName = report.reviewed_by
        v.VerifyingOrganization = "Saintview"
        v.VerificationDateTime = (
            report.finalized_at.strftime("%Y%m%d%H%M%S") if report.finalized_at else ds.ContentDate
        )
        ds.VerifyingObserverSequence = [v]

    # 루트 컨테이너
    ds.ValueType = "CONTAINER"
    ds.ConceptNameCodeSequence = [_code("18748-4", "Diagnostic Imaging Report", "LN")]
    ds.ContinuityOfContent = "SEPARATE"

    content: list[Dataset] = []
    comp = sr_json.get("comparison", {})
    if comp.get("summary"):
        content.append(_text_item(_code("121060", "History"), comp["summary"]))
    findings_text = "\n".join(
        f"- {f.get('organ', '')}: {f.get('observation', '')}"
        + (" [CRITICAL]" if f.get("severity") == "critical" else "")
        for f in sr_json.get("findings", [])
    )
    if findings_text:
        content.append(_text_item(_code("121070", "Findings"), findings_text))
    impression_text = "\n".join(
        f"{i.get('rank', '')}. {i.get('statement', '')}"
        for i in sorted(sr_json.get("impression", []), key=lambda x: x.get("rank", 99))
    )
    if impression_text:
        content.append(_text_item(_code("121072", "Impressions"), impression_text))
    rec_text = "\n".join(
        f"- {r.get('action', '')}" + (f" ({r['timeframe']})" if r.get("timeframe") else "")
        for r in sr_json.get("recommendations", [])
    )
    if rec_text:
        content.append(_text_item(_code("121074", "Recommendations"), rec_text))
    ds.ContentSequence = content
    return ds


def sr_bytes(ds: Dataset) -> bytes:
    buf = io.BytesIO()
    ds.save_as(buf, write_like_original=False)
    return buf.getvalue()
