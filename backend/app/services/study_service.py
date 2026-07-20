"""검사(워크리스트) 서비스 — 검색·등록·상태 관리."""
from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models import AiJob, Patient, PatientMerge, Report, Series, Study
from app.services.activity_service import qc_meta


@dataclass
class WorklistFilter:
    patient_query: str = ""       # 통합 검색(ID 또는 이름)
    patient_id: str = ""          # 필드별 검색 (Zetta/PiView 패턴)
    patient_name: str = ""
    sex: str = ""
    study_desc: str = ""
    modality: str = ""
    body_part: str = ""
    status: str = ""
    date_from: str = ""           # YYYYMMDD
    date_to: str = ""
    finding_query: str = ""       # F-2: 소견/임프레션 텍스트 검색
    emergency_only: bool = False
    key_only: bool = False         # 키이미지 등록 검사만 (F-16 — 서치필터 별도 조회)
    hospital_id: int | None = None  # 경량 테넌시 — 소속 병원 검사로 제한(None=전체)
    limit: int = 100
    offset: int = 0


def _op_clause(col, raw: str):
    """07 A.2 검색 연산자: '=K' 정확 / 'K%' 접두 / '!K' 제외 / 기본 포함(%K%)."""
    v = raw.strip()
    if v.startswith("="):
        return col == v[1:]
    if v.startswith("!"):
        return ~col.like(f"%{v[1:]}%")
    if v.endswith("%") and not v.startswith("%"):
        return col.like(v)
    return col.like(f"%{v}%")


def _resolve_hospital_id(db: Session, source_aet: str) -> int | None:
    """수신 AET → 등록 장비(Modality)의 소속 병원. 매칭 없으면 None(전역)."""
    if not source_aet:
        return None
    from app.models import Modality

    m = db.execute(
        select(Modality).where(Modality.ae_title == source_aet.strip().upper())
    ).scalar_one_or_none()
    return m.hospital_id if m else None


def get_or_create_patient(db: Session, patient_key: str, name: str, birth: str, sex: str) -> Patient:
    p = db.execute(select(Patient).where(Patient.patient_key == patient_key)).scalar_one_or_none()
    if p:
        return p
    p = Patient(patient_key=patient_key, name_masked=name, birth_date=birth, sex=sex)
    db.add(p)
    db.flush()
    return p


def register_study(
    db: Session,
    *,
    study_uid: str,
    patient_key: str,
    patient_name: str = "",
    birth_date: str = "",
    sex: str = "",
    accession_no: str = "",
    study_date: str = "",
    study_time: str = "",
    modality: str = "",
    body_part: str = "",
    study_desc: str = "",
    clinical_info: str = "",
    institution: str = "",
    referring_physician: str = "",
    department: str = "",
    source_aet: str = "",
    orthanc_id: str = "",
    series: list[dict] | None = None,
) -> Study:
    """검사 등록(수신 동기화·하네스 공용). 이미 있으면 카운트만 갱신."""
    existing = db.execute(select(Study).where(Study.study_uid == study_uid)).scalar_one_or_none()
    if existing:
        return existing
    patient = get_or_create_patient(db, patient_key, patient_name, birth_date, sex)
    study = Study(
        patient_id=patient.id,
        study_uid=study_uid,
        accession_no=accession_no,
        study_date=study_date,
        study_time=study_time,
        modality=modality,
        body_part=body_part,
        study_desc=study_desc,
        clinical_info=clinical_info,
        institution=institution,
        referring_physician=referring_physician,
        department=department,
        source_aet=source_aet,
        orthanc_id=orthanc_id,
        # 경량 테넌시: 수신 AET → 등록 장비 → 병원으로 자동 귀속
        hospital_id=_resolve_hospital_id(db, source_aet),
        status="received",
    )
    db.add(study)
    db.flush()
    # 활성 병합의 slave 환자 앞으로 수신된 신규 검사 — master 로 자동 귀속(침묵 분열 방지).
    # 병합은 병원 스코프로 동작하므로 검사 병원이 병합 병원과 같을 때만 따라가고,
    # merged_from·moved_study_ids 에 기록해 Unmerge 시 함께 원복되게 한다.
    merge = db.execute(
        select(PatientMerge)
        .where(
            PatientMerge.undone_at.is_(None),
            PatientMerge.slave_patient_id == patient.id,
        )
        .order_by(PatientMerge.id.desc())
        .limit(1)
    ).scalar_one_or_none()
    if merge is not None and merge.hospital_id == study.hospital_id:
        study.patient_id = merge.master_patient_id
        study.merged_from = merge.id
        merge.moved_study_ids = list(merge.moved_study_ids or []) + [study.id]
    for s in series or []:
        db.add(
            Series(
                study_id=study.id,
                series_uid=s["series_uid"],
                modality=s.get("modality", modality),
                series_desc=s.get("series_desc", ""),
                instance_count=s.get("instance_count", 0),
            )
        )
        study.series_count += 1
        study.instance_count += int(s.get("instance_count", 0))
    db.commit()
    return study


def _apply_worklist_filters(q, f: WorklistFilter, *, with_status: bool = True, with_emergency: bool = True):
    """워크리스트 필터를 쿼리에 적용 — search_worklist(목록)와 worklist_counts(상태바)가 공유해 드리프트 방지.
    counts 는 상태/응급 칩을 채워야 하므로 with_status/with_emergency=False 로 그 두 필터를 제외한다."""
    if f.patient_query:
        like = f"%{f.patient_query}%"
        q = q.where(or_(Patient.patient_key.like(like), Patient.name_masked.like(like)))
    if f.patient_id:
        q = q.where(_op_clause(Patient.patient_key, f.patient_id))
    if f.patient_name:
        q = q.where(_op_clause(Patient.name_masked, f.patient_name))
    if f.sex:
        q = q.where(Patient.sex == f.sex)
    if f.study_desc:
        q = q.where(_op_clause(Study.study_desc, f.study_desc))
    if f.modality:
        q = q.where(Study.modality == f.modality)
    if f.body_part:
        q = q.where(Study.body_part.like(f"%{f.body_part}%"))
    if with_status and f.status:
        if f.status == "unread":
            # S1 '미판독' — 확정 전 전체(received/draft_ready/reading/suspended)
            q = q.where(Study.status != "finalized")
        else:
            q = q.where(Study.status == f.status)
    if f.date_from:
        q = q.where(Study.study_date >= f.date_from)
    if f.date_to:
        q = q.where(Study.study_date <= f.date_to)
    if with_emergency and f.emergency_only:
        q = q.where(Study.emergency.is_(True))
    if f.key_only:
        # key_images JSON 이 비어있지 않은 검사 — PG/SQLite 공통(텍스트 캐스트 비교)
        from sqlalchemy import String, cast

        q = q.where(Study.key_images.isnot(None), cast(Study.key_images, String) != "[]")
    if f.hospital_id is not None:
        q = q.where(Study.hospital_id == f.hospital_id)
    if f.finding_query:
        # F-2: SR 텍스트 검색 — 최신 리포트 narrative 기준 (단순 LIKE, pg에선 추후 FTS)
        sub = select(Report.study_id).where(Report.narrative_text.like(f"%{f.finding_query}%"))
        q = q.where(Study.id.in_(sub))
    return q


def worklist_counts(db: Session, f: WorklistFilter) -> dict[str, int]:
    """SAINT VIEW 상태 카운트 바용 — 목록과 동일 스코프/필터(상태·응급 제외)에서 상태별 집계.
    단일 집계 쿼리(조건부 SUM)로 전 검사 정확 카운트(페이지 무관)."""
    from sqlalchemy import case

    base = (
        select(Study.status.label("status"), Study.emergency.label("emergency"))
        .join(Patient, Study.patient_id == Patient.id)
    )
    base = _apply_worklist_filters(base, f, with_status=False, with_emergency=False)
    sub = base.subquery()
    total, emergency, unread, reading, draft, finalized = db.execute(
        select(
            func.count(),
            func.coalesce(func.sum(case((sub.c.emergency.is_(True), 1), else_=0)), 0),
            func.coalesce(func.sum(case((sub.c.status != "finalized", 1), else_=0)), 0),
            func.coalesce(func.sum(case((sub.c.status == "reading", 1), else_=0)), 0),
            func.coalesce(func.sum(case((sub.c.status == "draft_ready", 1), else_=0)), 0),
            func.coalesce(func.sum(case((sub.c.status == "finalized", 1), else_=0)), 0),
        ).select_from(sub)
    ).one()
    return {
        "total": int(total or 0), "emergency": int(emergency or 0), "unread": int(unread or 0),
        "reading": int(reading or 0), "draft_ready": int(draft or 0), "finalized": int(finalized or 0),
    }


def search_worklist(db: Session, f: WorklistFilter) -> tuple[list[dict], int]:
    q = (
        select(Study, Patient)
        .join(Patient, Study.patient_id == Patient.id)
    )
    q = _apply_worklist_filters(q, f)

    total = db.execute(select(func.count()).select_from(q.subquery())).scalar() or 0
    # Emergency 최우선 → 검사일 역순 (F-15 / 설계 §6.2)
    q = q.order_by(Study.emergency.desc(), Study.study_date.desc(), Study.id.desc())
    rows = db.execute(q.limit(f.limit).offset(f.offset)).all()

    order_names = _order_names(db, [s.accession_no for s, _ in rows if s.accession_no])
    # QC 메타(read_state/merged/report_locked …) — 페이지 단위 배치 계산(N+1 금지)
    meta = qc_meta(db, [s for s, _ in rows])
    # 최신 리포트도 페이지 단위 배치 1회 조회 — 행당 1쿼리(N+1) 제거
    latest_map = _latest_reports(db, [s.id for s, _ in rows])
    items = []
    for study, patient in rows:
        items.append(_study_row(study, patient, latest_map.get(study.id),
                                order_name=order_names.get(study.accession_no, ""),
                                qc=meta.get(study.id)))
    return items, total


def _order_names(db: Session, accessions: list[str]) -> dict[str, str]:
    """ORDER NAME 컬럼 — accession으로 RIS 오더명 일괄 매칭."""
    if not accessions:
        return {}
    from app.models import Order

    rows = db.execute(
        select(Order.accession_no, Order.procedure_desc).where(Order.accession_no.in_(accessions))
    ).all()
    return {acc: desc for acc, desc in rows if desc}


def _latest_report(db: Session, study_id: int) -> Report | None:
    return db.execute(
        select(Report).where(Report.study_id == study_id).order_by(Report.version.desc()).limit(1)
    ).scalar_one_or_none()


def _latest_reports(db: Session, study_ids: list[int]) -> dict[int, Report]:
    """페이지 검사들의 최신(최대 version) 리포트 — IN 배치 1회 조회 후 파이썬 선별."""
    if not study_ids:
        return {}
    out: dict[int, Report] = {}
    for r in db.execute(select(Report).where(Report.study_id.in_(study_ids))).scalars():
        cur = out.get(r.study_id)
        if cur is None or r.version > cur.version:
            out[r.study_id] = r
    return out


def _study_row(study: Study, patient: Patient, latest: Report | None, *,
               order_name: str = "", qc: dict | None = None) -> dict:
    impression_preview = ""
    has_critical_flag = False
    if latest:
        from app.rag.schemas import has_critical

        imps = (latest.sr_json or {}).get("impression", [])
        if imps:
            impression_preview = imps[0].get("statement", "")[:120]
        has_critical_flag = has_critical(latest.sr_json or {})
    row = {
        "id": study.id,
        "study_uid": study.study_uid,
        "patient_key": patient.patient_key,
        "patient_name": patient.name_masked,
        "sex": patient.sex,
        "birth_date": patient.birth_date,
        "accession_no": study.accession_no,
        "study_date": study.study_date,
        "study_time": study.study_time,
        "modality": study.modality,
        "body_part": study.body_part,
        "study_desc": study.study_desc,
        "status": study.status,
        "emergency": study.emergency,
        "has_key": bool(study.key_images),
        "critical": has_critical_flag,
        "series_count": study.series_count,
        "instance_count": study.instance_count,
        "report_status": latest.status if latest else None,
        "impression_preview": impression_preview,
        # DICOM 헤더 기반 확장 컬럼 (UBPACS-Z Filter Setting)
        "institution": study.institution,
        "referring_physician": study.referring_physician,
        "memo": study.memo,
        "finalized_at": (
            latest.finalized_at.isoformat() if latest and latest.finalized_at else ""
        ),
        "department": study.department,
        "source_aet": study.source_aet,
        "bookmark": study.bookmark,
        "order_name": order_name,
    }
    # QC 메타 병합 — read_state/viewer_open/report_typing/has_report_text/
    # image_changed/merged/report_locked (SPEC §B, qc_meta 배치 계산 결과)
    if qc:
        row.update(qc)
    return row


def study_detail(db: Session, study_id: int) -> dict | None:
    study = db.get(Study, study_id)
    if not study:
        return None
    patient = db.get(Patient, study.patient_id)
    latest = _latest_report(db, study.id)
    names = _order_names(db, [study.accession_no] if study.accession_no else [])
    meta = qc_meta(db, [study])  # 단건 경로도 동일 헬퍼(단건 리스트) — SPEC §B
    row = _study_row(study, patient, latest, order_name=names.get(study.accession_no, ""),
                     qc=meta.get(study.id))
    row["clinical_info"] = study.clinical_info
    row["orthanc_id"] = study.orthanc_id
    row["series"] = [
        {
            "series_uid": s.series_uid,
            "modality": s.modality,
            "series_desc": s.series_desc,
            "instance_count": s.instance_count,
        }
        for s in study.series
        if s.deleted_at is None  # Exam Control 소프트 삭제 제외
    ]
    # F-14 Related Exams: 동일 환자 다른 검사
    related = [
        {
            "id": s.id,
            "study_uid": s.study_uid,
            "study_date": s.study_date,
            "modality": s.modality,
            "study_desc": s.study_desc,
            "status": s.status,
        }
        for s in sorted(patient.studies, key=lambda x: x.study_date, reverse=True)
        # 테넌시 — 같은 환자라도 원 검사와 동일 병원 검사만 노출(교차 병원 메타데이터 누출 차단)
        if s.id != study.id and s.hospital_id == study.hospital_id
    ]
    row["related_exams"] = related
    return row


def queue_ai_job(db: Session, study: Study, kind: str = "draft") -> AiJob | None:
    # AI 판독 보류 스위치 — 자동(Orthanc 동기화·Import)·수동(재생성) 모든 큐잉의 단일 관문.
    # 보류 중이면 None 반환(호출부: 자동 경로는 조용히 건너뛰고, 수동 API 는 409 안내).
    from app.services.settings_service import ai_draft_enabled

    if not ai_draft_enabled(db):
        return None
    job = AiJob(study_id=study.id, kind=kind, status="queued")
    db.add(job)
    db.commit()
    return job
