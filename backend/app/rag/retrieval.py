"""RAG 검색 — 설계 §4.2 2축 검색.

축1(환자): 동일 환자 과거 확정 판독 전체(시간순) — 정확 조회.
축2(유사증례): Modality×BodyPart 1차 필터(화면분석 §5.6 검증 축) → 벡터 top-k.
"""
from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import Patient, Report, ReportEmbedding, Study
from app.rag.embeddings import cosine, embed

SIMILARITY_THRESHOLD = 0.15  # 임계 미달 시 '참고 증례 부족' 처리(§4.4 환각 억제)


@dataclass
class PriorReport:
    study_uid: str
    study_date: str
    modality: str
    study_desc: str
    narrative_text: str
    report_id: int


@dataclass
class SimilarCase:
    report_id: int
    score: float
    chunk_text: str
    modality: str
    body_part: str


def patient_priors(db: Session, study: Study, limit: int = 10) -> list[PriorReport]:
    """축1: 동일 환자의 과거 확정 판독(현재 검사 제외, 최신순)."""
    rows = db.execute(
        select(Report, Study)
        .join(Study, Report.study_id == Study.id)
        .where(
            Study.patient_id == study.patient_id,
            Study.id != study.id,
            Report.status == "finalized",
        )
        .order_by(Study.study_date.desc(), Report.version.desc())
        .limit(limit * 3)
    ).all()
    seen: set[int] = set()
    out: list[PriorReport] = []
    for report, s in rows:  # 검사당 최신 확정본 1건만
        if s.id in seen:
            continue
        seen.add(s.id)
        out.append(
            PriorReport(
                study_uid=s.study_uid,
                study_date=s.study_date,
                modality=s.modality,
                study_desc=s.study_desc,
                narrative_text=report.narrative_text,
                report_id=report.id,
            )
        )
        if len(out) >= limit:
            break
    return out


def similar_cases(db: Session, study: Study, query_text: str, k: int = 5) -> list[SimilarCase]:
    """축2: Modality×BodyPart 필터 후 벡터 유사 검색.

    PostgreSQL: pgvector 연산자 / SQLite 개발: 인메모리 코사인.
    자기 자신 환자의 판독은 축1과 중복되므로 제외하지 않는다(증례 가치) — 단 현재 검사는 제외.
    """
    settings = get_settings()
    qvec = embed(query_text)

    base = select(ReportEmbedding).where(ReportEmbedding.modality == study.modality)
    if study.body_part:
        base = base.where(ReportEmbedding.body_part == study.body_part)

    if settings.is_postgres:
        ordered = base.order_by(ReportEmbedding.embedding.cosine_distance(qvec)).limit(k * 2)
        rows = db.execute(ordered).scalars().all()
        scored = [(r, cosine(list(r.embedding), qvec)) for r in rows]
    else:
        rows = db.execute(base).scalars().all()
        scored = [(r, cosine(r.embedding, qvec)) for r in rows]
        scored.sort(key=lambda t: t[1], reverse=True)

    current_report_ids = {r.id for r in study.reports}
    out: list[SimilarCase] = []
    for r, score in scored:
        if r.report_id in current_report_ids or score < SIMILARITY_THRESHOLD:
            continue
        out.append(
            SimilarCase(
                report_id=r.report_id,
                score=round(score, 4),
                chunk_text=r.chunk_text,
                modality=r.modality,
                body_part=r.body_part,
            )
        )
        if len(out) >= k:
            break
    return out


def ingest_report(db: Session, report: Report) -> int:
    """확정 판독을 임베딩 인제스트(환류 루프, 설계 §4.1). 반환: 생성 청크 수."""
    from app.rag.deid import mask

    study = report.study
    patient = db.get(Patient, study.patient_id)
    names = [patient.name_masked] if patient else []
    sections = {
        "full": report.narrative_text,
        "impression": "\n".join(
            i.get("statement", "") for i in (report.sr_json or {}).get("impression", [])
        ),
    }
    count = 0
    for section, text in sections.items():
        text = (text or "").strip()
        if not text:
            continue
        clean = mask(text, patient_names=names).text
        db.add(
            ReportEmbedding(
                report_id=report.id,
                chunk_seq=count,
                section=section,
                embedding=embed(clean),
                chunk_text=clean[:2000],
                modality=study.modality,
                body_part=study.body_part,
            )
        )
        count += 1
    return count
