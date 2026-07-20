"""SR JSON 스키마 — 설계 §6.2. Claude structured outputs의 json_schema로도 사용."""
from __future__ import annotations

SR_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "exam": {
            "type": "object",
            "properties": {
                "modality": {"type": "string"},
                "body_part": {"type": "string"},
                "technique": {"type": "string"},
            },
            "required": ["modality", "body_part", "technique"],
            "additionalProperties": False,
        },
        "comparison": {
            "type": "object",
            "properties": {
                "prior_study_refs": {"type": "array", "items": {"type": "string"}},
                "summary": {"type": "string"},
            },
            "required": ["prior_study_refs", "summary"],
            "additionalProperties": False,
        },
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "organ": {"type": "string"},
                    "observation": {"type": "string"},
                    "severity": {
                        "type": "string",
                        "enum": ["normal", "minor", "significant", "critical"],
                    },
                    "measurements": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "value": {"type": "number"},
                                "unit": {"type": "string"},
                            },
                            "required": ["name", "value", "unit"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["organ", "observation", "severity", "measurements"],
                "additionalProperties": False,
            },
        },
        "impression": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "rank": {"type": "integer"},
                    "statement": {"type": "string"},
                    "confidence": {"type": "string", "enum": ["low", "moderate", "high"]},
                    "codes": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["rank", "statement", "confidence", "codes"],
                "additionalProperties": False,
            },
        },
        "recommendations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "action": {"type": "string"},
                    "timeframe": {"type": "string"},
                },
                "required": ["action", "timeframe"],
                "additionalProperties": False,
            },
        },
        "ai_meta": {
            "type": "object",
            "properties": {
                "caveats": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["caveats"],
            "additionalProperties": False,
        },
    },
    "required": ["exam", "comparison", "findings", "impression", "recommendations", "ai_meta"],
    "additionalProperties": False,
}


# S2 자동계측 CTR(심흉비) — vision 구조화 출력. 좌표는 이미지 정규화(0~1)
CTR_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "cardiac": {
            "type": "object",
            "properties": {
                "x1": {"type": "number"}, "x2": {"type": "number"}, "y": {"type": "number"},
            },
            "required": ["x1", "x2", "y"],
            "additionalProperties": False,
        },
        "thoracic": {
            "type": "object",
            "properties": {
                "x1": {"type": "number"}, "x2": {"type": "number"}, "y": {"type": "number"},
            },
            "required": ["x1", "x2", "y"],
            "additionalProperties": False,
        },
        "confidence": {"type": "number"},
        "note": {"type": "string"},
    },
    "required": ["cardiac", "thoracic", "confidence", "note"],
    "additionalProperties": False,
}


# S1 자연어 검색(nl_to_query) — 자연어 → 워크리스트 필터 구조화 출력 스키마
NL_QUERY_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "filter": {
            "type": "object",
            "properties": {
                "patient_id": {"type": "string"},
                "patient_name": {"type": "string"},
                "sex": {"type": "string", "enum": ["", "M", "F", "O"]},
                "modality": {"type": "string"},
                "body_part": {"type": "string"},
                "study_desc": {"type": "string"},
                "status": {
                    "type": "string",
                    "enum": ["", "unread", "received", "draft_ready", "reading", "finalized", "suspended"],
                },
                "date_from": {"type": "string"},  # YYYYMMDD 또는 ""
                "date_to": {"type": "string"},
                "finding": {"type": "string"},
                "emergency": {"type": "boolean"},
            },
            "required": [
                "patient_id", "patient_name", "sex", "modality", "body_part",
                "study_desc", "status", "date_from", "date_to", "finding", "emergency",
            ],
            "additionalProperties": False,
        },
        "explanation": {"type": "string"},
    },
    "required": ["filter", "explanation"],
    "additionalProperties": False,
}


def has_critical(sr_json: dict) -> bool:
    return any(f.get("severity") == "critical" for f in (sr_json or {}).get("findings", []))


def narrative_from_sr(sr_json: dict) -> str:
    """SR JSON → 전문 텍스트(Reading/Conclusion/Recommend — 디자인 §3.2 매핑)."""
    lines: list[str] = []
    comp = (sr_json or {}).get("comparison", {})
    if comp.get("summary"):
        lines.append(f"[Comparison] {comp['summary']}")
    lines.append("[Findings]")
    for f in (sr_json or {}).get("findings", []):
        sev = f.get("severity", "")
        lines.append(f"- {f.get('organ', '')}: {f.get('observation', '')} ({sev})")
    lines.append("[Conclusion]")
    for i in sorted((sr_json or {}).get("impression", []), key=lambda x: x.get("rank", 99)):
        lines.append(f"{i.get('rank', '')}. {i.get('statement', '')}")
    recs = (sr_json or {}).get("recommendations", [])
    if recs:
        lines.append("[Recommend]")
        for r in recs:
            tf = f" ({r['timeframe']})" if r.get("timeframe") else ""
            lines.append(f"- {r.get('action', '')}{tf}")
    return "\n".join(lines)
