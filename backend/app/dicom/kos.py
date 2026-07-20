"""Key Object Selection Document (F-16) — 키이미지를 DICOM 표준 객체로 보존.

분석 문서 §4: 주석·키이미지를 뷰어 내부 포맷이 아닌 표준 객체로 저장하는 것이
PACS 상호운용성의 핵심. KOS는 동일 Study에 귀속되어 어느 뷰어에서든 키이미지로 인식된다.
"""
from __future__ import annotations

from datetime import datetime, timezone

from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

KOS_SOP = "1.2.840.10008.5.1.4.1.1.88.59"  # Key Object Selection Document
CT_IMAGE = "1.2.840.10008.5.1.4.1.1.2"


def _code(value: str, meaning: str, scheme: str = "DCM") -> Dataset:
    d = Dataset()
    d.CodeValue = value
    d.CodingSchemeDesignator = scheme
    d.CodeMeaning = meaning
    return d


def build_kos_dataset(*, study, patient, key_images: list[dict], creator: str = "") -> Dataset:
    """key_images: [{"sop_uid", "sop_class_uid"?, "series_uid"?}] → KOS Dataset."""
    now = datetime.now(timezone.utc)

    fm = FileMetaDataset()
    fm.MediaStorageSOPClassUID = KOS_SOP
    fm.MediaStorageSOPInstanceUID = generate_uid()
    fm.TransferSyntaxUID = ExplicitVRLittleEndian

    ds = Dataset()
    ds.file_meta = fm
    ds.SpecificCharacterSet = "ISO_IR 192"
    ds.SOPClassUID = KOS_SOP
    ds.SOPInstanceUID = fm.MediaStorageSOPInstanceUID
    ds.Modality = "KO"

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
    ds.SeriesNumber = 990
    ds.InstanceNumber = 1
    ds.SeriesDescription = "Saintview Key Images"
    ds.Manufacturer = "Saintview PACS AI"
    ds.ContentDate = now.strftime("%Y%m%d")
    ds.ContentTime = now.strftime("%H%M%S")

    # 루트: (113000, DCM, "Of Interest")
    ds.ValueType = "CONTAINER"
    ds.ConceptNameCodeSequence = [_code("113000", "Of Interest")]
    ds.ContinuityOfContent = "SEPARATE"

    content = []
    evidence_series: dict[str, list[Dataset]] = {}
    for ki in key_images:
        sop_class = ki.get("sop_class_uid") or CT_IMAGE
        ref = Dataset()
        ref.ReferencedSOPClassUID = sop_class
        ref.ReferencedSOPInstanceUID = ki["sop_uid"]

        item = Dataset()
        item.RelationshipType = "CONTAINS"
        item.ValueType = "IMAGE"
        item.ReferencedSOPSequence = [ref]
        content.append(item)

        series_uid = ki.get("series_uid") or generate_uid()
        evidence_series.setdefault(series_uid, []).append(ref)
    ds.ContentSequence = content

    # Current Requested Procedure Evidence — 참조 무결성
    ev_study = Dataset()
    ev_study.StudyInstanceUID = study.study_uid
    ev_series_list = []
    for series_uid, refs in evidence_series.items():
        s = Dataset()
        s.SeriesInstanceUID = series_uid
        s.ReferencedSOPSequence = refs
        ev_series_list.append(s)
    ev_study.ReferencedSeriesSequence = ev_series_list
    ds.CurrentRequestedProcedureEvidenceSequence = [ev_study]
    return ds
