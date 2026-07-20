"""FHIR R4 DiagnosticReport 변환 (P2, 설계 §6.1) — EMR 연동 대비."""
from __future__ import annotations

import base64

from sqlalchemy.orm import Session

from app.models import Patient, Report

_STATUS_MAP = {"draft": "preliminary", "in_review": "preliminary", "finalized": "final", "rejected": "entered-in-error"}


def to_diagnostic_report(db: Session, report: Report) -> dict:
    study = report.study
    patient = db.get(Patient, study.patient_id)
    sr = report.sr_json or {}
    conclusion = " ".join(
        i.get("statement", "")
        for i in sorted(sr.get("impression", []), key=lambda x: x.get("rank", 99))
    )
    resource = {
        "resourceType": "DiagnosticReport",
        "status": _STATUS_MAP.get(report.status, "preliminary"),
        "category": [{
            "coding": [{
                "system": "http://terminology.hl7.org/CodeSystem/v2-0074",
                "code": "RAD",
                "display": "Radiology",
            }]
        }],
        "code": {
            "coding": [{
                "system": "http://loinc.org",
                "code": "18748-4",
                "display": "Diagnostic imaging study",
            }],
            "text": study.study_desc or "Imaging report",
        },
        "subject": {
            "identifier": {"value": patient.patient_key if patient else ""},
            "display": patient.name_masked if patient else "",
        },
        "effectiveDateTime": _fhir_date(study.study_date, study.study_time),
        "issued": report.finalized_at.isoformat() if report.finalized_at else None,
        "performer": (
            [{"display": report.reviewed_by}] if report.reviewed_by else []
        ),
        "imagingStudy": [{
            "identifier": {
                "system": "urn:dicom:uid",
                "value": f"urn:oid:{study.study_uid}",
            }
        }],
        "conclusion": conclusion,
        "presentedForm": [{
            "contentType": "text/plain; charset=utf-8",
            "data": base64.b64encode(report.narrative_text.encode("utf-8")).decode(),
            "title": f"판독서 v{report.version}",
        }],
    }
    if report.created_by == "ai":
        resource["extension"] = [{
            "url": "https://saintview.example/fhir/ai-generated",
            "valueBoolean": True,
        }]
    return {k: v for k, v in resource.items() if v is not None}


def _fhir_date(yyyymmdd: str, hhmmss: str = "") -> str | None:
    if not yyyymmdd or len(yyyymmdd) != 8:
        return None
    date = f"{yyyymmdd[:4]}-{yyyymmdd[4:6]}-{yyyymmdd[6:]}"
    if hhmmss and len(hhmmss) >= 6:
        return f"{date}T{hhmmss[:2]}:{hhmmss[2:4]}:{hhmmss[4:6]}+09:00"
    return date
