"""휴대폰 사진 촬영 연동 — QR 세션 → 모바일 카메라 페이지 → 사진 업로드 → 검사의 새 시리즈(DICOM SC).

토큰이 자격증명(15분 만료, 검사·병원 바인딩). 업로드 시 대상 검사의 StudyInstanceUID 로
Secondary Capture 를 생성해 Orthanc 에 넣고 DB 재등록 → 뷰어 폴링이 감지해 새 시리즈 표시.
"""
from __future__ import annotations

import base64
import io
import secrets
import time

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import current_user
from app.db import get_db
from app.models import Study

router = APIRouter(prefix="/api", tags=["mobile"])

TOKEN_TTL = 15 * 60
# token → 세션(단일 프로세스 메모리 — 재시작 시 소멸, 촬영 세션 용도로 충분)
_SESS: dict[str, dict] = {}


def _gc() -> None:
    now = time.time()
    for t in [t for t, v in _SESS.items() if v["exp"] < now]:
        _SESS.pop(t, None)


class CaptureBody(BaseModel):
    origin: str  # 프론트 오리진(핸드폰이 접근 가능한 주소) — QR URL 구성용


@router.post("/studies/{study_id}/mobile-capture")
def create_capture(study_id: int, body: CaptureBody, db: Session = Depends(get_db),
                   user: dict = Depends(current_user)):
    """QR 세션 생성 — 검사·병원 바인딩 토큰 + QR(PNG data URL) 반환."""
    import qrcode

    _gc()
    st = db.get(Study, study_id)
    if not st:
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    is_sys = user.get("role") == "admin" and not user.get("hid")
    if not is_sys and user.get("hid") and st.hospital_id != user.get("hid"):
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    token = secrets.token_urlsafe(24)
    _SESS[token] = {"study_id": study_id, "hid": st.hospital_id, "exp": time.time() + TOKEN_TTL,
                    "uploaded": 0, "done": False}
    url = f"{body.origin.rstrip('/')}/?capture={token}"
    img = qrcode.make(url)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    qr = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    return {"token": token, "url": url, "qr": qr, "expires_in": TOKEN_TTL}


def _sess(token: str) -> dict:
    _gc()
    v = _SESS.get(token)
    if not v:
        raise HTTPException(status_code=404, detail="세션이 만료되었거나 없습니다 — 뷰어에서 QR 을 다시 생성하세요")
    return v


@router.get("/mobile-capture/{token}")
def capture_meta(token: str, db: Session = Depends(get_db)):
    """모바일 페이지 초기 정보 — 토큰 유효성 + 검사 표시(환자명 마스킹)."""
    v = _sess(token)
    st = db.get(Study, v["study_id"])
    name = (st.patient.name if st and st.patient else "") or ""
    masked = name[:1] + "*" * max(0, len(name) - 1) if name else "-"
    return {"ok": True, "patient": masked, "study_desc": st.study_desc if st else "",
            "modality": st.modality if st else "", "uploaded": v["uploaded"]}


@router.post("/mobile-capture/{token}/upload")
async def capture_upload(token: str, files: list[UploadFile], db: Session = Depends(get_db)):
    """휴대폰 사진 업로드 → 대상 검사의 '새 시리즈'(SC) 로 변환·등록."""
    from datetime import datetime

    import numpy as np  # noqa: F401  (PIL 경유용 — 미사용이어도 pydicom 픽셀 경로 안전)
    from PIL import Image
    from pydicom.dataset import Dataset, FileMetaDataset
    from pydicom.uid import ExplicitVRLittleEndian, SecondaryCaptureImageStorage, generate_uid

    from app.dicom.orthanc import OrthancClient
    from app.services.study_service import register_study

    v = _sess(token)
    st = db.get(Study, v["study_id"])
    if not st:
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    series_uid = v.get("series_uid") or generate_uid()
    v["series_uid"] = series_uid
    now = datetime.now()
    client = OrthancClient()
    orthanc_sid = ""
    try:
        if not client.alive():
            raise HTTPException(status_code=503, detail="Orthanc 에 연결할 수 없습니다")
        for f in files:
            raw = await f.read()
            try:
                img = Image.open(io.BytesIO(raw)).convert("RGB")
            except Exception:
                continue
            v["uploaded"] += 1
            meta = FileMetaDataset()
            meta.MediaStorageSOPClassUID = SecondaryCaptureImageStorage
            meta.MediaStorageSOPInstanceUID = generate_uid()
            meta.TransferSyntaxUID = ExplicitVRLittleEndian
            ds = Dataset()
            ds.file_meta = meta
            ds.SOPClassUID = meta.MediaStorageSOPClassUID
            ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
            ds.StudyInstanceUID = st.study_uid          # 대상 검사에 귀속
            ds.SeriesInstanceUID = series_uid           # 세션당 1개 새 시리즈
            ds.PatientID = st.patient.patient_key if st.patient else "UNKNOWN"
            ds.PatientName = (st.patient.name if st.patient else "") or "UNKNOWN"
            ds.Modality = "OT"
            ds.StudyDate = st.study_date or now.strftime("%Y%m%d")
            ds.StudyTime = st.study_time or now.strftime("%H%M%S")
            ds.SeriesDate = now.strftime("%Y%m%d")
            ds.SeriesTime = now.strftime("%H%M%S")
            ds.StudyDescription = st.study_desc or ""
            ds.SeriesDescription = f"Mobile Photo {now.strftime('%m/%d %H:%M')}"
            ds.SeriesNumber = 900
            ds.InstanceNumber = v["uploaded"]
            ds.SamplesPerPixel = 3
            ds.PhotometricInterpretation = "RGB"
            ds.PlanarConfiguration = 0
            ds.Rows, ds.Columns = img.height, img.width
            ds.BitsAllocated = 8
            ds.BitsStored = 8
            ds.HighBit = 7
            ds.PixelRepresentation = 0
            ds.PixelData = img.tobytes()
            buf = io.BytesIO()
            ds.save_as(buf, write_like_original=False)
            r = client.upload_dicom(buf.getvalue())
            orthanc_sid = r.get("ParentStudy", orthanc_sid)
        # DB 재등록 — 시리즈/인스턴스 수 갱신(뷰어 refreshExam 이 새 시리즈 표시)
        if orthanc_sid:
            m = client.study_metadata(orthanc_sid)
            tags = m.get("MainDicomTags", {})
            ptags = m.get("PatientMainDicomTags", {})
            register_study(
                db, study_uid=st.study_uid,
                patient_key=ptags.get("PatientID", "UNKNOWN"),
                patient_name=ptags.get("PatientName", ""),
                study_date=tags.get("StudyDate", ""), study_time=tags.get("StudyTime", ""),
                modality=st.modality, study_desc=tags.get("StudyDescription", ""),
                source_aet="MOBILE", orthanc_id=orthanc_sid, hospital_id=v["hid"],
            )
        v["done"] = True
        return {"ok": True, "uploaded": v["uploaded"], "series_uid": series_uid}
    finally:
        client.close()


@router.get("/mobile-capture/{token}/status")
def capture_status(token: str):
    """뷰어 폴링 — 업로드 수·완료 여부·새 시리즈 UID."""
    v = _sess(token)
    return {"uploaded": v["uploaded"], "done": v["done"], "series_uid": v.get("series_uid", "")}
