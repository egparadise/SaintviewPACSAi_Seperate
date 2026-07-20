"""AI 초안 생성 서비스 — 검색(2축) → 컨텍스트(deid) → 생성 → 저장."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models import AiJob, Patient, Report, Study
from app.rag.deid import mask
from app.rag.generate import GenerationInput, generate_draft
from app.rag.retrieval import patient_priors, similar_cases
from app.services.report_service import save_draft_from_ai


def run_draft_job(db: Session, job: AiJob) -> Report:
    job.status = "running"
    job.started_at = datetime.now(timezone.utc)
    db.commit()
    try:
        study = db.get(Study, job.study_id)
        report = generate_for_study(db, study)
        job.status = "done"
        job.finished_at = datetime.now(timezone.utc)
        db.commit()
        return report
    except Exception as e:
        job.status = "failed"
        job.error = str(e)[:2000]
        job.finished_at = datetime.now(timezone.utc)
        db.commit()
        raise


def generate_for_study(db: Session, study: Study) -> Report:
    patient = db.get(Patient, study.patient_id)
    names = [patient.name_masked] if patient and patient.name_masked else []

    priors = patient_priors(db, study)
    query_text = mask(f"{study.study_desc} {study.clinical_info}", patient_names=names).text
    similars = similar_cases(db, study, query_text)

    # F-11: 키이미지 vision — ai.policy.vision 토글(기본 off) + Orthanc 가용 시
    key_image = None
    from app.services.settings_service import get_setting

    policy = get_setting(db, "ai.policy", default={}) or {}
    if policy.get("vision") and study.orthanc_id:
        from app.dicom.orthanc import OrthancClient

        client = OrthancClient()
        try:
            if client.alive():
                key_image = client.study_preview_png(study.orthanc_id)
                if key_image:
                    # P2 가드: 번인 PHI 관례 영역(상·하단) 마스킹 후 전송 (설계 §8.1)
                    from app.rag.image_guard import mask_burn_in

                    key_image = mask_burn_in(key_image)
        finally:
            client.close()

    gi = GenerationInput(
        modality=study.modality,
        body_part=study.body_part,
        study_desc=mask(study.study_desc, patient_names=names).text,
        clinical_info=mask(study.clinical_info, patient_names=names).text,
        priors=priors,
        similars=similars,
        key_image_png=key_image,
    )
    result = generate_draft(gi)
    return save_draft_from_ai(db, study, result.sr_json, model=result.model, sources=result.sources)
