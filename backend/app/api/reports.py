from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import current_user, require_effective
from app.db import get_db
from app.models import Report, Study
from app.services.report_service import (
    LOCKED_MSG,
    WorkflowError,
    finalize_report,
    list_reports,
    merge_reports,
    update_report,
)

router = APIRouter(prefix="/api", tags=["reports"])


def _report_out(r: Report) -> dict:
    return {
        "id": r.id,
        "study_id": r.study_id,
        "version": r.version,
        "status": r.status,
        "sr_json": r.sr_json,
        "narrative_text": r.narrative_text,
        "created_by": r.created_by,
        "reviewed_by": r.reviewed_by,
        "finalized_at": r.finalized_at.isoformat() if r.finalized_at else None,
        "ai_model": r.ai_model,
        "ai_sources": r.ai_sources,
        "diff_metrics": r.diff_metrics,
    }


def _require_study_scope(db: Session, study_id: int, user: dict) -> Study:
    """검사 병원 스코프 가드(테넌시 IDOR 차단) — 시스템관리자=전체, 병원소속=자기 병원만. 아니면 404."""
    st = db.get(Study, study_id)
    if not st:
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    is_sys = user.get("role") == "admin" and not user.get("hid")
    if not is_sys and user.get("hid") and st.hospital_id != user.get("hid"):
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    return st


def _require_report(db: Session, report_id: int, user: dict) -> Report:
    """리포트 소속 검사의 병원 스코프 가드 → 통과 시 Report 반환."""
    report = db.get(Report, report_id)
    if not report:
        raise HTTPException(status_code=404, detail="리포트를 찾을 수 없습니다")
    _require_study_scope(db, report.study_id, user)
    return report



@router.get("/studies/{study_id}/reports")
def get_reports(study_id: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    _require_study_scope(db, study_id, user)
    return {"items": [_report_out(r) for r in list_reports(db, study_id)]}


class ReportUpdate(BaseModel):
    sr_json: dict


@router.put("/reports/{report_id}")
def put_report(
    report_id: int,
    body: ReportUpdate,
    db: Session = Depends(get_db),
    user: dict = Depends(require_effective("report.write")),
):
    report = _require_report(db, report_id, user)
    if not report:
        raise HTTPException(status_code=404, detail="리포트를 찾을 수 없습니다")
    try:
        report = update_report(db, report, body.sr_json, username=user["sub"])
    except WorkflowError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return _report_out(report)


@router.post("/reports/{report_id}/finalize")
def finalize(report_id: int, db: Session = Depends(get_db),
             user: dict = Depends(require_effective("report.finalize"))):
    report = _require_report(db, report_id, user)
    if not report:
        raise HTTPException(status_code=404, detail="리포트를 찾을 수 없습니다")
    try:
        report = finalize_report(db, report, username=user["sub"])
    except WorkflowError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return _report_out(report)


@router.post("/reports/{report_id}/suspend")
def suspend(report_id: int, db: Session = Depends(get_db),
            user: dict = Depends(require_effective("report.write"))):
    """판독 보류(07 A.5 suspended — UBPACS Suspend): 확정 전 상태 유지·후순위 표시."""
    from app.models import AuditLog

    report = _require_report(db, report_id, user)
    if not report:
        raise HTTPException(status_code=404, detail="리포트를 찾을 수 없습니다")
    if report.study.report_locked:
        raise HTTPException(status_code=409, detail=LOCKED_MSG)
    if report.status == "finalized":
        raise HTTPException(status_code=409, detail="확정된 판독은 보류할 수 없습니다")
    report.status = "suspended" if report.status != "suspended" else "in_review"
    report.study.status = "reading"
    db.add(AuditLog(action="report_suspend", target_type="report", target_id=str(report_id),
                    detail={"by": user["sub"], "to": report.status}))
    db.commit()
    return _report_out(report)


@router.post("/reports/{report_id}/confirm2")
def confirm2(report_id: int, db: Session = Depends(get_db),
             user: dict = Depends(require_effective("report.confirm2"))):
    """F-17 2차 승인(Conf2): 확정본에 2차 확인자 기록. 1차 확정자와 동일 계정이면 경고만."""
    from datetime import datetime, timezone

    from app.models import AuditLog

    report = _require_report(db, report_id, user)
    if not report:
        raise HTTPException(status_code=404, detail="리포트를 찾을 수 없습니다")
    if report.status != "finalized":
        raise HTTPException(status_code=409, detail="확정된 판독만 2차 승인할 수 있습니다")
    dm = dict(report.diff_metrics or {})
    dm["confirm2"] = {"by": user["sub"], "at": datetime.now(timezone.utc).isoformat(),
                      "same_as_reader": user["sub"] == report.reviewed_by}
    report.diff_metrics = dm
    db.add(AuditLog(action="report_confirm2", target_type="report", target_id=str(report_id),
                    detail=dm["confirm2"]))
    db.commit()
    return _report_out(report)


@router.get("/reports/{report_id}/export")
def export_report(
    report_id: int,
    format: str = "pdf",
    db: Session = Depends(get_db),
    user: dict = Depends(require_effective("report.print")),
):
    """판독서 출력 (F-9/D-4: PDF 우선). 출력 행위는 감사 로그 기록."""
    from fastapi.responses import Response

    from app.models import AuditLog
    from app.services.pdf_service import render_report_pdf

    report = _require_report(db, report_id, user)
    if not report:
        raise HTTPException(status_code=404, detail="리포트를 찾을 수 없습니다")
    if format == "pdf":
        payload = render_report_pdf(db, report)
        media, ext = "application/pdf", "pdf"
    elif format == "dicom-sr":
        from app.dicom.sr import build_sr_dataset, sr_bytes
        from app.models import Patient

        patient = db.get(Patient, report.study.patient_id)
        payload = sr_bytes(build_sr_dataset(report=report, study=report.study, patient=patient))
        media, ext = "application/dicom", "dcm"
    elif format == "fhir":
        import json

        from app.services.fhir_service import to_diagnostic_report

        payload = json.dumps(to_diagnostic_report(db, report), ensure_ascii=False, indent=2).encode(
            "utf-8"
        )
        media, ext = "application/fhir+json", "json"
    else:
        raise HTTPException(status_code=400, detail="지원 형식: pdf | dicom-sr | fhir")
    db.add(AuditLog(action="report_export", target_type="report", target_id=str(report_id),
                    detail={"by": user["sub"], "format": format}))
    db.commit()
    filename = f"report_{report.study.accession_no or report.study_id}_v{report.version}.{ext}"
    return Response(
        content=payload,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/reports/{report_id}/send-sr")
def send_sr(report_id: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """확정 판독을 DICOM SR로 Orthanc(검사 동일 Study)에 저장 — PACS에서 판독 표시."""
    from app.dicom.orthanc import OrthancClient
    from app.dicom.sr import build_sr_dataset, sr_bytes
    from app.models import AuditLog, Patient

    report = _require_report(db, report_id, user)
    if not report:
        raise HTTPException(status_code=404, detail="리포트를 찾을 수 없습니다")
    if report.status != "finalized":
        raise HTTPException(status_code=409, detail="확정된 판독만 SR로 전송할 수 있습니다")
    client = OrthancClient()
    try:
        if not client.alive():
            raise HTTPException(status_code=503, detail="Orthanc에 연결할 수 없습니다")
        patient = db.get(Patient, report.study.patient_id)
        ds = build_sr_dataset(report=report, study=report.study, patient=patient)
        result = client.upload_dicom(sr_bytes(ds))
        db.add(AuditLog(action="report_send_sr", target_type="report", target_id=str(report_id),
                        detail={"by": user["sub"], "orthanc": result.get("ID", "")}))
        db.commit()
        return {"ok": True, "sop_instance_uid": ds.SOPInstanceUID, "orthanc_id": result.get("ID", "")}
    finally:
        client.close()


@router.get("/batch-review")
def batch_review_candidates(
    limit: int = 50, db: Session = Depends(get_db), user: dict = Depends(current_user)
):
    """F-22: 일괄 검토 대상 — AI 초안(draft) 중 critical 없음."""
    from sqlalchemy import select

    from app.models import Patient, Study
    from app.rag.schemas import has_critical

    q = (
        select(Report, Study, Patient)
        .join(Study, Report.study_id == Study.id)
        .join(Patient, Study.patient_id == Patient.id)
        .where(Report.status == "draft", Report.created_by == "ai")
    )
    # 테넌시 — 병원 소속 사용자는 자기 병원 후보만(교차 병원 AI 초안 누출 차단)
    is_sys = user.get("role") == "admin" and not user.get("hid")
    if not is_sys and user.get("hid"):
        q = q.where(Study.hospital_id == user["hid"])
    rows = db.execute(
        q.order_by(Study.study_date.desc())
        .limit(limit * 2)
    ).all()
    items = []
    for report, study, patient in rows:
        if has_critical(report.sr_json or {}):
            continue  # critical은 개별 검토 강제
        imps = (report.sr_json or {}).get("impression", [])
        items.append({
            "report_id": report.id,
            "study_id": study.id,
            "patient_key": patient.patient_key,
            "patient_name": patient.name_masked,
            "modality": study.modality,
            "study_date": study.study_date,
            "study_desc": study.study_desc,
            "impression": imps[0].get("statement", "") if imps else "",
            "confidence": imps[0].get("confidence", "") if imps else "",
        })
        if len(items) >= limit:
            break
    return {"items": items}


class ExternalAiResult(BaseModel):
    label: str
    observation: str = ""
    severity: str = "normal"      # normal|minor|significant|critical
    confidence: float = 0.0       # 0~1


class ExternalAiBody(BaseModel):
    vendor: str
    model: str = ""
    results: list[ExternalAiResult]


@router.post("/studies/{study_id}/external-ai")
def external_ai(
    study_id: int, body: ExternalAiBody, db: Session = Depends(get_db), user: dict = Depends(current_user)
):
    """F-12 외부 AI 결과 병합 — 외부 엔진 결과를 초안 findings에 [외부AI] 라벨로 병합.

    03b 입력 신뢰: 화이트리스트 필드만 수용, 건수·범위 검증, 항상 라벨링(ai_result_label).
    """
    from app.models import AuditLog, Study
    from app.rag.schemas import narrative_from_sr
    from app.services.report_service import latest_report

    study = _require_study_scope(db, study_id, user)
    if not study:
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    if study.report_locked:
        raise HTTPException(status_code=409, detail=LOCKED_MSG)
    if not body.vendor.strip():
        raise HTTPException(status_code=400, detail="vendor는 필수입니다")
    if not (1 <= len(body.results) <= 50):
        raise HTTPException(status_code=400, detail="results는 1~50건이어야 합니다")
    for r in body.results:
        if not (0.0 <= r.confidence <= 1.0):
            raise HTTPException(status_code=400, detail="confidence는 0~1 범위")
        if r.severity not in ("normal", "minor", "significant", "critical"):
            raise HTTPException(status_code=400, detail=f"severity 값 오류: {r.severity}")

    report = latest_report(db, study_id)
    if report and report.status == "finalized":
        raise HTTPException(status_code=409, detail="확정된 판독에는 병합할 수 없습니다")

    import copy

    vendor = body.vendor.strip()[:64]
    if report:
        sr = copy.deepcopy(report.sr_json or {})
    else:
        sr = {
            "exam": {"modality": study.modality, "body_part": study.body_part,
                     "technique": study.study_desc},
            "comparison": {"prior_study_refs": [], "summary": ""},
            "findings": [], "impression": [], "recommendations": [],
            "ai_meta": {"caveats": []},
        }
    sr.setdefault("findings", [])
    sr.setdefault("ai_meta", {"caveats": []})
    for r in body.results:
        sr["findings"].append({
            "organ": f"[외부AI {vendor}] {r.label}"[:128],
            "observation": f"{r.observation} (신뢰도 {r.confidence:.2f})".strip(),
            "severity": r.severity,
            "measurements": [],
        })
    sr["ai_meta"].setdefault("caveats", []).append(
        f"외부 AI({vendor} {body.model}) 결과 {len(body.results)}건 병합 — 검증되지 않은 외부 산출물, 판독의 확인 필수"
    )

    if report:
        report.sr_json = sr
        report.narrative_text = narrative_from_sr(sr)
        ai_sources = dict(report.ai_sources or {})
        ext = list(ai_sources.get("external_ai", []))
        ext.append({"vendor": vendor, "model": body.model[:64], "count": len(body.results)})
        ai_sources["external_ai"] = ext
        report.ai_sources = ai_sources
        merged_into = report
    else:
        merged_into = Report(
            study_id=study_id, version=1, status="draft",
            sr_json=sr, narrative_text=narrative_from_sr(sr),
            created_by="ai", ai_model=f"external:{vendor}",
            ai_sources={"external_ai": [{"vendor": vendor, "model": body.model[:64],
                                         "count": len(body.results)}]},
        )
        db.add(merged_into)
        study.status = "draft_ready"

    # critical 외부 소견 → 응급 플래그 (F-15와 동일 정책)
    if any(r.severity == "critical" for r in body.results):
        study.emergency = True
    db.add(AuditLog(action="external_ai_merge", target_type="study", target_id=str(study_id),
                    detail={"by": user["sub"], "vendor": vendor, "count": len(body.results)}))
    db.commit()
    return _report_out(merged_into)


class MergeBody(BaseModel):
    study_ids: list[int]  # [0]=primary(현재 선택), 나머지=부속


@router.post("/reports/merge")
def merge(body: MergeBody, db: Session = Depends(get_db),
          user: dict = Depends(require_effective("report.write"))):
    """묶음판독(report_merge) — 동일 환자 다검사를 primary 검사 판독 하나로 병합."""
    try:
        report = merge_reports(db, body.study_ids, username=user["sub"])
    except WorkflowError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return _report_out(report)


class BatchFinalize(BaseModel):
    report_ids: list[int]


@router.post("/reports/batch-finalize")
def batch_finalize(
    body: BatchFinalize, db: Session = Depends(get_db),
    user: dict = Depends(require_effective("report.finalize")),
):
    """F-22: 일괄 확정. critical 포함 초안은 거부(개별 검토 강제)."""
    from app.rag.schemas import has_critical

    results = []
    is_sys = user.get("role") == "admin" and not user.get("hid")
    for rid in body.report_ids:
        report = db.get(Report, rid)
        if not report:
            results.append({"report_id": rid, "ok": False, "detail": "없음"})
            continue
        # 병원 스코프 — 타 병원 리포트는 존재 은닉(없음 처리, IDOR 차단)
        st = db.get(Study, report.study_id)
        if not is_sys and user.get("hid") and (not st or st.hospital_id != user.get("hid")):
            results.append({"report_id": rid, "ok": False, "detail": "없음"})
            continue
        if has_critical(report.sr_json or {}):
            results.append({"report_id": rid, "ok": False, "detail": "critical 소견 — 개별 검토 필요"})
            continue
        try:
            finalize_report(db, report, username=user["sub"])
            results.append({"report_id": rid, "ok": True})
        except WorkflowError as e:
            results.append({"report_id": rid, "ok": False, "detail": str(e)})
    ok = sum(1 for r in results if r["ok"])
    return {"finalized": ok, "total": len(results), "results": results}


class ReportLockBody(BaseModel):
    locked: bool


@router.post("/studies/{study_id}/report-lock")
def report_lock(
    study_id: int, body: ReportLockBody, db: Session = Depends(get_db),
    user: dict = Depends(require_effective("report.finalize")),
):
    """판독 확정(Fixed) 잠금 토글 (SPEC §C) — 잠금 중엔 모든 판독 변이가 409 차단된다.

    잠금은 확정(finalized)된 판독이 있는 검사만 가능. 해제는 동일 엔드포인트 locked=false.
    """
    from sqlalchemy import select

    from app.models import AuditLog

    study = db.get(Study, study_id)
    if not study:
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    # 병원 스코프(테넌시) — 시스템 관리자=전체, 그 외는 타 병원 검사 잠금/해제 불가
    # (잠금은 차단·해제 효과가 병원 워크플로 전체에 미친다 — examctl 접근 가드와 동일 취지)
    is_sys_admin = user.get("role") == "admin" and not user.get("hid")
    if (not is_sys_admin and study.hospital_id is not None
            and study.hospital_id != user.get("hid")):
        raise HTTPException(status_code=403, detail="이 병원의 검사에 접근할 권한이 없습니다")
    if body.locked:
        finalized = db.execute(
            select(Report.id).where(
                Report.study_id == study_id, Report.status == "finalized"
            ).limit(1)
        ).first()
        if not finalized:
            raise HTTPException(status_code=400, detail="확정된 판독이 없습니다")
    study.report_locked = body.locked
    db.add(AuditLog(
        action="report_lock" if body.locked else "report_unlock",
        target_type="study", target_id=str(study_id),
        detail={"by": user["sub"], "locked": body.locked},
    ))
    db.commit()
    return {"locked": bool(study.report_locked)}
