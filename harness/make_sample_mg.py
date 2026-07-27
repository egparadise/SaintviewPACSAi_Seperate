"""합성 MG(유방촬영) 검사 생성 — 2D-MG(좌우 여백 제거) 모드 검증용.

실 환자 데이터 없이 2D-MG 를 확인할 수 있어야 한다. 실제 MG 프레임의 핵심 성질을
그대로 재현한다:
  · 세로로 긴 프레임(예: 1914×2294) — 가로로 넓은 페인에 contain 으로 넣으면 레터박스가 생김
  · 조직이 **흉벽 쪽 가장자리에 닿고**, 유두 쪽에는 공기(≈0)가 넓게 남음
  · R 유방은 흉벽이 프레임 오른쪽, L 유방은 왼쪽 (back-to-back 행잉 관례)
  · 한 시리즈에 RCC/LCC/RMLO/LMLO 4장 (대부분의 실검사가 이 형태 — Image 타일 행잉 대상)

사용:
    py -3.11 harness/make_sample_mg.py --out out/mg           # 파일만 생성
    py -3.11 harness/make_sample_mg.py --push http://127.0.0.1:8043   # Orthanc 로 업로드
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

MG_SOP = "1.2.840.10008.5.1.4.1.1.1.2"   # Digital Mammography X-Ray Image Storage (For Presentation)

ROWS, COLS = 2294, 1914


def _breast(rows: int, cols: int, wall: str, view: str, seed: int) -> np.ndarray:
    """흉벽(wall='L'|'R') 쪽에 붙은 반타원형 유방 + 내부 조직 텍스처. 나머지는 공기(0)."""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:rows, 0:cols].astype(np.float32)
    # 흉벽을 x=0 기준으로 계산한 뒤 필요하면 좌우 뒤집는다
    cy = rows * (0.5 if view == "CC" else 0.55)
    ry = rows * (0.42 if view == "CC" else 0.46)      # 세로 반지름
    rx = cols * 0.58                                   # 유두까지의 가로 길이(프레임의 58%)
    d = ((x / rx) ** 2 + ((y - cy) / ry) ** 2)
    img = np.zeros((rows, cols), dtype=np.float32)
    inside = d <= 1.0
    # 가장자리로 갈수록 얇아지는 감쇠(피부선) + 내부 실질 텍스처
    img[inside] = 700 + 500 * (1.0 - d[inside]) ** 0.6
    tex = rng.normal(0, 55, size=(rows, cols)).astype(np.float32)
    k = 9
    ker = np.ones((k,), dtype=np.float32) / k
    tex = np.apply_along_axis(lambda r: np.convolve(r, ker, mode="same"), 1, tex)
    img[inside] += tex[inside]
    # 섬유선 조직 몇 덩어리(밝은 결절 포함) — 창(W/L) 확인용
    for _ in range(14):
        by = rng.uniform(cy - ry * 0.7, cy + ry * 0.7)
        bx = rng.uniform(cols * 0.03, rx * 0.8)
        br = rng.uniform(cols * 0.02, cols * 0.07)
        m = ((x - bx) ** 2 + (y - by) ** 2) <= br ** 2
        img[m & inside] += rng.uniform(120, 420)
    img = np.clip(img, 0, 4095)
    if wall == "R":
        img = img[:, ::-1]
    return np.ascontiguousarray(img.astype(np.uint16))


def make_mg_instance(*, laterality: str, view: str, study_uid: str, series_uid: str,
                     instance_number: int, patient_id: str, patient_name: str,
                     study_date: str) -> Dataset:
    file_meta = FileMetaDataset()
    file_meta.MediaStorageSOPClassUID = MG_SOP
    file_meta.MediaStorageSOPInstanceUID = generate_uid()
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian

    ds = Dataset()
    ds.file_meta = file_meta
    ds.SOPClassUID = MG_SOP
    ds.SOPInstanceUID = file_meta.MediaStorageSOPInstanceUID
    ds.PatientID = patient_id
    ds.PatientName = patient_name
    ds.PatientBirthDate = "19750101"
    ds.PatientSex = "F"
    ds.StudyInstanceUID = study_uid
    ds.SeriesInstanceUID = series_uid
    ds.StudyDate = study_date
    ds.StudyTime = "093000"
    ds.AccessionNumber = f"ACC{patient_id[-4:]}"
    ds.Modality = "MG"
    ds.StudyDescription = "Mammography Bilateral (synthetic)"
    ds.SeriesDescription = "MG Bilateral 4-view"
    ds.SeriesNumber = 1
    ds.InstanceNumber = instance_number
    ds.BodyPartExamined = "BREAST"
    ds.ImageLaterality = laterality        # 'R' | 'L'
    ds.Laterality = laterality
    ds.ViewPosition = view                 # 'CC' | 'MLO'
    ds.InstitutionName = "SAINTVIEW SYNTH"

    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.Rows = ROWS
    ds.Columns = COLS
    ds.BitsAllocated = 16
    ds.BitsStored = 12
    ds.HighBit = 11
    ds.PixelRepresentation = 0
    ds.PixelSpacing = [0.07, 0.07]         # 실제 MG 급 화소 크기(mm)
    ds.WindowCenter = 1200
    ds.WindowWidth = 2200
    # 흉벽 관례: R 유방은 프레임 오른쪽, L 유방은 왼쪽에 흉벽
    wall = "R" if laterality == "R" else "L"
    ds.PixelData = _breast(ROWS, COLS, wall, view, seed=hash((laterality, view)) & 0xFFFF).tobytes()
    return ds


def build_study(patient_id: str, patient_name: str, study_date: str) -> list[Dataset]:
    study_uid, series_uid = generate_uid(), generate_uid()
    views = [("R", "CC"), ("L", "CC"), ("R", "MLO"), ("L", "MLO")]
    return [
        make_mg_instance(laterality=lat, view=v, study_uid=study_uid, series_uid=series_uid,
                         instance_number=i + 1, patient_id=patient_id,
                         patient_name=patient_name, study_date=study_date)
        for i, (lat, v) in enumerate(views)
    ]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="", help="DICOM 파일 저장 폴더")
    ap.add_argument("--push", default="", help="Orthanc 주소(예: http://127.0.0.1:8043)")
    ap.add_argument("--patient-id", default="MG0001")
    ap.add_argument("--patient-name", default="MAMMO^TEST")
    ap.add_argument("--study-date", default="20260727")
    args = ap.parse_args()

    datasets = build_study(args.patient_id, args.patient_name, args.study_date)
    if args.out:
        d = Path(args.out)
        d.mkdir(parents=True, exist_ok=True)
        for ds in datasets:
            p = d / f"MG_{ds.ImageLaterality}{ds.ViewPosition}.dcm"
            ds.save_as(p, write_like_original=False)
            print(f"  저장 {p}")
    if args.push:
        import io

        import httpx
        with httpx.Client(base_url=args.push.rstrip("/"), timeout=60) as c:
            for ds in datasets:
                buf = io.BytesIO()
                ds.save_as(buf, write_like_original=False)
                r = c.post("/instances", content=buf.getvalue(),
                           headers={"Content-Type": "application/dicom"})
                print(f"  업로드 {ds.ImageLaterality}{ds.ViewPosition} → {r.status_code}")
        print(f"검사 UID: {datasets[0].StudyInstanceUID}")
    if not args.out and not args.push:
        print("--out 또는 --push 를 지정하세요.")


if __name__ == "__main__":
    main()
