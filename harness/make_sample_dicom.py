"""합성 DICOM 생성 — 스모크 하네스용 (SaintRouter 하네스 철학 승계)."""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

CT_SOP = "1.2.840.10008.5.1.4.1.1.2"  # CT Image Storage


def make_ct_instance(
    *,
    patient_id: str = "SMOKE001",
    patient_name: str = "SMOKE^TEST",
    study_uid: str | None = None,
    series_uid: str | None = None,
    study_date: str = "20260611",
    study_desc: str = "CT Chest (smoke)",
    body_part: str = "CHEST",
    instance_number: int = 1,
) -> Dataset:
    file_meta = FileMetaDataset()
    file_meta.MediaStorageSOPClassUID = CT_SOP
    file_meta.MediaStorageSOPInstanceUID = generate_uid()
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian

    ds = Dataset()
    ds.file_meta = file_meta
    ds.SOPClassUID = CT_SOP
    ds.SOPInstanceUID = file_meta.MediaStorageSOPInstanceUID
    ds.PatientID = patient_id
    ds.PatientName = patient_name
    ds.PatientBirthDate = "19600101"
    ds.PatientSex = "M"
    ds.StudyInstanceUID = study_uid or generate_uid()
    ds.SeriesInstanceUID = series_uid or generate_uid()
    ds.StudyDate = study_date
    ds.StudyTime = "120000"
    ds.AccessionNumber = f"ACC{patient_id[-3:]}"
    ds.Modality = "CT"
    ds.StudyDescription = study_desc
    ds.SeriesDescription = "Axial"
    ds.BodyPartExamined = body_part
    ds.InstanceNumber = instance_number
    ds.is_little_endian = True
    ds.is_implicit_VR = False

    rows = cols = 64
    pixel = (np.random.default_rng(instance_number).integers(0, 1000, (rows, cols))).astype(
        np.uint16
    )
    ds.Rows, ds.Columns = rows, cols
    ds.BitsAllocated, ds.BitsStored, ds.HighBit = 16, 12, 11
    ds.PixelRepresentation = 0
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.PixelData = pixel.tobytes()
    return ds


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="harness/out_dicom")
    parser.add_argument("--count", type=int, default=3)
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    study_uid = generate_uid()
    series_uid = generate_uid()
    for i in range(1, args.count + 1):
        ds = make_ct_instance(study_uid=study_uid, series_uid=series_uid, instance_number=i)
        path = out / f"smoke_{i:03d}.dcm"
        ds.save_as(path, write_like_original=False)
        print(f"생성: {path}")
    print(f"StudyInstanceUID: {study_uid}")


if __name__ == "__main__":
    main()
