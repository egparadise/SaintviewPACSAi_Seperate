"""가상 환자 생성기 — 설정 규칙(testgen.config)으로 가상 환자+오더 생성(MWL 조회 대상).

옵션 '합성 DICOM 생성·Orthanc 등록': pydicom Secondary Capture 를 만들어 생성된
환자ID/Accession 을 반영해 Orthanc 에 업로드한다(Orthanc 미가용 시 경고만, 오더는 유지).
"""
from __future__ import annotations

import logging
import random
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AuditLog, Order, Patient, Study

logger = logging.getLogger("saintview.testgen")

CONFIG_KEY = "testgen.config"

# 생성 규칙 기본값 — testgen.config 로 병원별 오버라이드
DEFAULT_CONFIG = {
    "pid_prefix": "TP",        # 가상 환자ID 프리픽스
    "pid_digits": 6,           # 시퀀스 자릿수
    "acc_prefix": "TA",        # Accession 프리픽스
    "sexes": ["M", "F"],
    "age_min": 20,
    "age_max": 80,
    "modalities": ["CR", "CT", "MR", "US"],
    "body_parts": ["CHEST", "ABDOMEN", "SKULL", "SPINE"],
    "projections": ["PA", "AP", "LAT"],
}

_FAMILY = ["KIM", "LEE", "PARK", "CHOI", "JUNG", "KANG", "CHO", "YOON"]
_GIVEN = ["MINSU", "JIWOO", "SEOYEON", "HAJUN", "DOYUN", "SOMIN", "YEJIN", "JUNHO"]


def merged_config(stored: dict | None) -> dict:
    cfg = dict(DEFAULT_CONFIG)
    for k, v in (stored or {}).items():
        if k in cfg and v not in (None, "", []):
            cfg[k] = v
    return cfg


def _next_seq(db: Session, cfg: dict) -> int:
    """기존 가상 환자ID 최대 시퀀스 + 1 — 재기동/반복 호출에도 유일성 보장.

    오더뿐 아니라 실환자(Patient) 테이블도 함께 스캔 — 동일 프리픽스 실환자 ID 와의
    충돌(가상 ID 가 기존 환자를 덮어쓰는 사고)을 방지한다.
    """
    prefix = str(cfg["pid_prefix"])
    rows = list(db.execute(select(Order.patient_key)
                           .where(Order.patient_key.like(f"{prefix}%"))).scalars())
    rows += list(db.execute(select(Patient.patient_key)
                            .where(Patient.patient_key.like(f"{prefix}%"))).scalars())
    top = 0
    for pk in rows:
        tail = pk[len(prefix):]
        if tail.isdigit():
            top = max(top, int(tail))
    return top + 1


def _uniquify_accession(db: Session, base: str, order_id: int) -> str:
    """Accession 충돌 방지 — 기존 오더(HL7 ORM 등)·검사(Study)와 겹치면 R{n} 접미사."""
    acc, n = base, 0
    while (db.execute(select(Order.id).where(
               Order.accession_no == acc, Order.id != order_id)).first() is not None
           or db.execute(select(Study.id).where(Study.accession_no == acc)).first() is not None):
        n += 1
        acc = f"{base}R{n}"
    return acc[:64]


def _unique_accession(db: Session, cfg: dict, order_id: int) -> str:
    """생성 규칙 기반 Accession — acc_prefix + 오더ID(8자리), 충돌 시 R{n} 접미사."""
    return _uniquify_accession(db, f"{cfg['acc_prefix']}{order_id:08d}", order_id)


def _random_birth(cfg: dict, rng: random.Random) -> str:
    age = rng.randint(int(cfg["age_min"]), int(cfg["age_max"]))
    d = date.today() - timedelta(days=age * 365 + rng.randint(0, 364))
    return d.strftime("%Y%m%d")


def generate(db: Session, hospital_id: int | None, stored_cfg: dict | None,
             count: int = 1, *, with_dicom: bool = False, station_aet: str = "",
             by: str = "") -> dict:
    """가상 환자·오더 count 건 생성. 반환: {items: [...], dicom: {uploaded, warning}}."""
    cfg = merged_config(stored_cfg)
    rng = random.Random()
    seq = _next_seq(db, cfg)
    today = datetime.now(timezone.utc).strftime("%Y%m%d")
    items: list[dict] = []
    orders: list[Order] = []
    for i in range(count):
        n = seq + i
        pid = f"{cfg['pid_prefix']}{n:0{int(cfg['pid_digits'])}d}"
        name = f"{rng.choice(_FAMILY)}^{rng.choice(_GIVEN)}"
        order = Order(
            patient_key=pid, patient_name=name,
            birth_date=_random_birth(cfg, rng), sex=rng.choice(list(cfg["sexes"])),
            modality=rng.choice(list(cfg["modalities"])),
            body_part=rng.choice(list(cfg["body_parts"])),
            projection=rng.choice(list(cfg["projections"])),
            scheduled_date=today,
            scheduled_time=datetime.now(timezone.utc).strftime("%H%M%S"),
            procedure_desc="가상 검사(테스트 생성기)", station_aet=station_aet[:32],
            hospital_id=hospital_id,
        )
        db.add(order)
        db.flush()
        order.accession_no = _unique_accession(db, cfg, order.id)
        order.dicom_study_id = f"T{order.id:06d}"
        orders.append(order)
        items.append({"order_id": order.id, "patient_key": pid, "patient_name": name,
                      "accession_no": order.accession_no, "modality": order.modality,
                      "body_part": order.body_part, "sex": order.sex,
                      "birth_date": order.birth_date})
    db.add(AuditLog(action="testgen_create", target_type="order", target_id="*",
                    detail={"by": by, "hospital_id": hospital_id, "count": count,
                            "with_dicom": with_dicom}))
    db.commit()

    dicom_result = {"requested": with_dicom, "uploaded": 0, "warning": ""}
    if with_dicom:
        dicom_result = _upload_synthetic(orders)
    return {"items": items, "dicom": dicom_result}


def generate_explicit(db: Session, hospital_id: int | None, stored_cfg: dict | None,
                      patient: dict, exams: list[dict], *, by: str = "") -> dict:
    """오더 입력형(RIS 스타일) 생성 — 환자 1명 + 검사 항목(exams)별 오더 1건씩.

    - patient: {patient_id, accession, sex, last_name, first_name, physician,
      department, modality}. patient_id/accession 미입력 시 생성 규칙(testgen.config)으로 채움.
    - accession 제공 시 항목별 '-1,-2…' 접미사로 유일화(기존 오더/검사와 충돌하면 R{n} 추가).
    - physician/department 는 Order 컬럼에 저장(MWL ReferringPhysicianName 노출) + 감사 로그 보존.
    반환: {orders: [{order_id, accession_no, body_part, projection}], patient_key}
    """
    cfg = merged_config(stored_cfg)
    last = str(patient.get("last_name") or "").strip()
    first = str(patient.get("first_name") or "").strip()
    name = f"{last}^{first}" if first else last
    pid = str(patient.get("patient_id") or "").strip()
    if not pid:
        pid = f"{cfg['pid_prefix']}{_next_seq(db, cfg):0{int(cfg['pid_digits'])}d}"
    base_acc = str(patient.get("accession") or "").strip()
    sex = str(patient.get("sex") or "").strip().upper()[:8]
    modality = str(patient.get("modality") or "").strip().upper()[:16]
    physician = str(patient.get("physician") or "").strip()[:64]
    department = str(patient.get("department") or "").strip()[:64]
    # 오더 입력 확장 필드 — 미입력 시 오늘/현재시각/빈값(자동 채번)으로 폴백
    birth_date = str(patient.get("birth_date") or "").strip()[:8]
    station_aet = str(patient.get("station_aet") or "").strip()[:32]
    base_sid = str(patient.get("dicom_study_id") or "").strip()[:16]
    now = datetime.now(timezone.utc)
    sched_date = str(patient.get("scheduled_date") or "").strip() or now.strftime("%Y%m%d")
    sched_time = str(patient.get("scheduled_time") or "").strip() or now.strftime("%H%M%S")
    orders_out: list[dict] = []
    for idx, exam in enumerate(exams, 1):
        body_part = str(exam.get("body_part") or "").strip().upper()[:64]
        projection = str(exam.get("projection") or "").strip()[:32]
        desc = " ".join(p for p in (body_part, projection) if p) or "가상 검사(오더 입력)"
        order = Order(
            patient_key=pid[:128], patient_name=name[:128],
            birth_date=birth_date, sex=sex, modality=modality,
            body_part=body_part, projection=projection,
            scheduled_date=sched_date[:8], scheduled_time=sched_time[:6],
            procedure_desc=desc, station_aet=station_aet, hospital_id=hospital_id,
            physician=physician, department=department,
        )
        db.add(order)
        db.flush()
        if base_acc:
            order.accession_no = _uniquify_accession(db, f"{base_acc}-{idx}"[:60], order.id)
        else:
            order.accession_no = _unique_accession(db, cfg, order.id)
        # StudyID: 입력 시 다건이면 -1/-2 접미, 미입력 시 T{id} 자동 채번
        order.dicom_study_id = (f"{base_sid}-{idx}" if len(exams) > 1 else base_sid)[:16] if base_sid else f"T{order.id:06d}"
        orders_out.append({"order_id": order.id, "accession_no": order.accession_no,
                           "body_part": order.body_part, "projection": order.projection})
    db.add(AuditLog(action="testgen_order_entry", target_type="order", target_id="*",
                    detail={"by": by, "hospital_id": hospital_id, "patient_key": pid,
                            "exam_count": len(exams),
                            "physician": physician, "department": department}))
    db.commit()
    return {"orders": orders_out, "patient_key": pid}


def build_synthetic_sc(order: Order) -> bytes:
    """오더 정보 반영 합성 Secondary Capture DICOM(64×64 그라디언트) 바이트."""
    import io

    from pydicom.dataset import Dataset, FileMetaDataset
    from pydicom.uid import ExplicitVRLittleEndian, SecondaryCaptureImageStorage, generate_uid

    fm = FileMetaDataset()
    fm.MediaStorageSOPClassUID = SecondaryCaptureImageStorage
    fm.MediaStorageSOPInstanceUID = generate_uid()
    fm.TransferSyntaxUID = ExplicitVRLittleEndian

    ds = Dataset()
    ds.file_meta = fm
    ds.SOPClassUID = SecondaryCaptureImageStorage
    ds.SOPInstanceUID = fm.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID = generate_uid()
    ds.SeriesInstanceUID = generate_uid()
    ds.SpecificCharacterSet = "ISO_IR 192"
    ds.PatientID = order.patient_key
    ds.PatientName = order.patient_name or order.patient_key
    ds.PatientBirthDate = order.birth_date
    ds.PatientSex = order.sex
    ds.AccessionNumber = order.accession_no
    ds.StudyID = order.dicom_study_id or ""
    ds.Modality = order.modality or "OT"
    ds.BodyPartExamined = order.body_part or ""
    ds.StudyDescription = order.procedure_desc or "SYNTHETIC"
    ds.SeriesDescription = "Synthetic SC (testgen)"
    ds.StudyDate = order.scheduled_date
    ds.StudyTime = order.scheduled_time
    ds.InstanceNumber = 1
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.Rows = 64
    ds.Columns = 64
    ds.BitsAllocated = 8
    ds.BitsStored = 8
    ds.HighBit = 7
    ds.PixelRepresentation = 0
    ds.PixelData = bytes((x + y) % 256 for y in range(64) for x in range(64))

    buf = io.BytesIO()
    ds.save_as(buf, write_like_original=False)
    return buf.getvalue()


def _upload_synthetic(orders: list[Order]) -> dict:
    """합성 DICOM → Orthanc 업로드. 실패는 경고로만(오더 생성은 이미 확정)."""
    from app.dicom.orthanc import OrthancClient

    uploaded = 0
    warning = ""
    client = OrthancClient()
    try:
        if not client.alive():
            return {"requested": True, "uploaded": 0,
                    "warning": "Orthanc 미가용 — 합성 DICOM 등록 생략(오더는 생성됨)"}
        for order in orders:
            try:
                client.upload_dicom(build_synthetic_sc(order))
                uploaded += 1
            except Exception as e:  # noqa: BLE001 — 건별 격리
                warning = f"일부 업로드 실패: {e}"
                logger.warning("합성 DICOM 업로드 실패 (order=%s): %s", order.id, e)
    finally:
        client.close()
    return {"requested": True, "uploaded": uploaded, "warning": warning}
