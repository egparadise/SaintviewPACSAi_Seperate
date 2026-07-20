"""리포트 워크플로 — draft → in_review → finalized (버전 보존, F-17/F-20)."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AuditLog, Report, Study
from app.rag.retrieval import ingest_report
from app.rag.schemas import has_critical, narrative_from_sr


class WorkflowError(Exception):
    pass


def list_reports(db: Session, study_id: int) -> list[Report]:
    return list(
        db.execute(
            select(Report).where(Report.study_id == study_id).order_by(Report.version.desc())
        ).scalars()
    )


def latest_report(db: Session, study_id: int) -> Report | None:
    rows = list_reports(db, study_id)
    return rows[0] if rows else None


LOCKED_MSG = "판독 확정 잠금(Fixed) 상태입니다. 잠금 해제 후 다시 시도하세요."


def _ensure_not_locked(study: Study) -> None:
    """확정 잠금(study.report_locked) 중이면 모든 판독 변이를 차단한다 (SPEC §C)."""
    if bool(study.report_locked):
        raise WorkflowError(LOCKED_MSG)


def save_draft_from_ai(db: Session, study: Study, sr_json: dict, *, model: str, sources: dict) -> Report:
    # 실행 시점 잠금 검사 — analyze 큐잉 가드만으로는 TOCTOU(큐잉→잠금→워커 실행)에서
    # 잠금 중 새 리포트가 생기고 study.status 가 finalized→draft_ready 로 오염된다(SPEC §C).
    _ensure_not_locked(study)
    version = (latest_report(db, study.id).version + 1) if latest_report(db, study.id) else 1
    report = Report(
        study_id=study.id,
        version=version,
        status="draft",
        sr_json=sr_json,
        narrative_text=narrative_from_sr(sr_json),
        created_by="ai",
        ai_model=model,
        ai_sources=sources,
    )
    db.add(report)
    study.status = "draft_ready"
    if has_critical(sr_json):
        study.emergency = True  # critical → 워크리스트 최우선(설계 §6.2)
    db.commit()
    return report


def update_report(db: Session, report: Report, sr_json: dict, *, username: str) -> Report:
    """판독의 수정 — 확정본은 수정 불가, 새 버전을 만든다."""
    _ensure_not_locked(report.study)
    if report.status == "finalized":
        raise WorkflowError("확정된 판독은 수정할 수 없습니다. 새 버전(addendum)을 생성하세요.")
    report.sr_json = sr_json
    report.narrative_text = narrative_from_sr(sr_json)
    report.status = "in_review"
    report.reviewed_by = username
    report.study.status = "reading"
    db.add(
        AuditLog(
            action="report_update",
            target_type="report",
            target_id=str(report.id),
            detail={"by": username, "version": report.version},
        )
    )
    db.commit()
    return report


def finalize_report(db: Session, report: Report, *, username: str) -> Report:
    """확정: 버전 보존 + 환류 인제스트(설계 §4.1) + 불일치 지표(F-20)."""
    _ensure_not_locked(report.study)
    if report.status == "finalized":
        raise WorkflowError("이미 확정된 판독입니다.")
    report.status = "finalized"
    report.reviewed_by = username
    report.finalized_at = datetime.now(timezone.utc)
    dm = _diff_against_ai_draft(db, report)
    # 전자 서명 — 판독의 이름·면허번호를 확정본에 함께 기록 (설정>판독에서 등록)
    from app.models import Account

    acct = db.execute(select(Account).where(Account.username == username)).scalar_one_or_none()
    dm["signature"] = {
        "by": username,
        "name": (acct.display_name if acct else "") or username,
        "license_no": acct.license_no if acct else "",
        "signed_at": report.finalized_at.isoformat(),
    }
    report.diff_metrics = dm
    report.study.status = "finalized"
    chunks = ingest_report(db, report)  # 환류: 확정본 → RAG 인덱스
    db.add(
        AuditLog(
            action="report_finalize",
            target_type="report",
            target_id=str(report.id),
            detail={"by": username, "version": report.version, "ingested_chunks": chunks},
        )
    )
    db.commit()
    return report


def merge_reports(db: Session, study_ids: list[int], *, username: str) -> Report:
    """묶음판독(report_merge — UBPACS-Z Direct Report 계열).

    동일 환자의 검사 여러 건을 첫 번째 검사(primary)의 판독 하나로 병합한다.
    부속 검사들의 소견·임프레션은 [MOD 검사일] 태그를 붙여 합치고,
    comparison.prior_study_refs에 부속 StudyUID를 기록한다.
    """
    if len(study_ids) < 2:
        raise WorkflowError("묶음판독은 검사 2건 이상이 필요합니다.")
    studies = [db.get(Study, sid) for sid in study_ids]
    if any(s is None for s in studies):
        raise WorkflowError("존재하지 않는 검사가 포함되어 있습니다.")
    if len({s.patient_id for s in studies}) != 1:
        raise WorkflowError("동일 환자의 검사만 묶음판독할 수 있습니다.")
    for s in studies:
        _ensure_not_locked(s)  # 확정 잠금 검사 포함 시 병합 차단 (SPEC §C)

    primary, secondaries = studies[0], studies[1:]
    base_report = latest_report(db, primary.id)
    if base_report and base_report.status == "finalized":
        raise WorkflowError("확정된 판독에는 병합할 수 없습니다. 새 버전(addendum)을 사용하세요.")

    import copy

    if base_report:
        sr = copy.deepcopy(base_report.sr_json or {})
    else:
        sr = {
            "exam": {"modality": primary.modality, "body_part": primary.body_part,
                     "technique": primary.study_desc},
            "comparison": {"prior_study_refs": [], "summary": ""},
            "findings": [],
            "impression": [],
            "recommendations": [],
            "ai_meta": {"caveats": []},
        }
    sr.setdefault("comparison", {"prior_study_refs": [], "summary": ""})
    sr.setdefault("findings", [])
    sr.setdefault("impression", [])
    sr.setdefault("ai_meta", {"caveats": []})

    for s in secondaries:
        tag = f"[{s.modality} {s.study_date}]"
        rep = latest_report(db, s.id)
        if rep and rep.sr_json:
            for fd in rep.sr_json.get("findings", []):
                merged = dict(fd)
                merged["organ"] = f"{tag} {fd.get('organ', '')}".strip()
                sr["findings"].append(merged)
            stmts = [i.get("statement", "") for i in rep.sr_json.get("impression", []) if i.get("statement")]
            if stmts:
                sr["impression"].append({
                    "rank": len(sr["impression"]) + 1,
                    "statement": f"{tag} " + " / ".join(stmts),
                    "confidence": (rep.sr_json.get("impression") or [{}])[0].get("confidence", "low"),
                    "codes": [],
                })
        else:
            sr["findings"].append({
                "organ": tag, "observation": f"{s.study_desc} — 기존 판독 없음(영상 직접 확인 필요)",
                "severity": "normal", "measurements": [],
            })
        if s.study_uid not in sr["comparison"]["prior_study_refs"]:
            sr["comparison"]["prior_study_refs"].append(s.study_uid)

    sr["ai_meta"].setdefault("caveats", []).append(
        f"묶음판독: 검사 {len(study_ids)}건 병합 — 부속 검사 소견은 [MOD 검사일] 태그로 표기"
    )

    report = Report(
        study_id=primary.id,
        version=(base_report.version + 1) if base_report else 1,
        status="in_review",
        sr_json=sr,
        narrative_text=narrative_from_sr(sr),
        created_by=username,
        reviewed_by=username,
        ai_sources={"merged_study_ids": [s.id for s in secondaries]},
    )
    db.add(report)
    primary.status = "reading"
    db.add(
        AuditLog(
            action="report_merge",
            target_type="study",
            target_id=str(primary.id),
            detail={"by": username, "study_ids": study_ids},
        )
    )
    db.commit()
    return report


def _diff_against_ai_draft(db: Session, final: Report) -> dict:
    """F-20: AI 초안(v1, created_by='ai') 대비 확정본 차이 지표."""
    draft = db.execute(
        select(Report)
        .where(Report.study_id == final.study_id, Report.created_by == "ai")
        .order_by(Report.version.asc())
        .limit(1)
    ).scalar_one_or_none()
    if not draft or draft.id == final.id and final.created_by == "ai":
        base = draft.narrative_text if draft else ""
    else:
        base = draft.narrative_text
    if not draft:
        return {"has_ai_draft": False}

    import difflib

    ratio = difflib.SequenceMatcher(None, base, final.narrative_text).ratio()
    draft_critical = has_critical(draft.sr_json or {})
    final_critical = has_critical(final.sr_json or {})
    return {
        "has_ai_draft": True,
        "draft_report_id": draft.id,
        "similarity": round(ratio, 4),
        "modified_ratio": round(1 - ratio, 4),
        # critical 소견 탈락/추가 — 리뷰 알림 대상(F-20)
        "critical_dropped": draft_critical and not final_critical,
        "critical_added": final_critical and not draft_critical,
        "accepted_unmodified": ratio > 0.98,
    }
