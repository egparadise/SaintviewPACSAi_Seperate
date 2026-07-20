"""S1 자연어 검색(nl_to_query) — 자연어 → 워크리스트 필터 변환.

- mock: 한국어 휴리스틱 파서(결정적 — 개발/테스트, 키·네트워크 불필요).
- live: rag.generate.generate_nl_query 경유(절대 규칙 3 — LLM 단일 진입점).
결과는 항상 미리보기로 사용자에게 보여준 뒤 적용한다(07 시나리오 S1).
"""
from __future__ import annotations

import logging
import re
from datetime import date, timedelta

from app.config import get_settings

logger = logging.getLogger(__name__)

# 모달리티 키워드 → DICOM 약어 (긴 키워드 우선 매칭)
_MODALITY_KEYWORDS: list[tuple[str, str]] = [
    ("mri", "MR"), ("초음파", "US"), ("유방촬영", "MG"), ("맘모", "MG"),
    ("엑스레이", "CR"), ("x-ray", "CR"), ("xray", "CR"),
    ("ct", "CT"), ("mr", "MR"), ("us", "US"), ("cr", "CR"),
    ("mg", "MG"), ("dx", "DX"), ("xa", "XA"), ("nm", "NM"),
]

# 부위 키워드 → BodyPartExamined 표기
_BODYPART_KEYWORDS: list[tuple[str, str]] = [
    ("흉부", "CHEST"), ("가슴", "CHEST"), ("chest", "CHEST"),
    ("복부", "ABDOMEN"), ("abdomen", "ABDOMEN"),
    ("두부", "BRAIN"), ("뇌", "BRAIN"), ("머리", "BRAIN"), ("brain", "BRAIN"), ("head", "BRAIN"),
    ("척추", "SPINE"), ("spine", "SPINE"),
    ("골반", "PELVIS"), ("pelvis", "PELVIS"),
]

_RECENT_DAYS = re.compile(r"최근\s*(\d+)\s*일")


def _empty_filter() -> dict:
    return {
        "patient_id": "", "patient_name": "", "sex": "", "modality": "",
        "body_part": "", "study_desc": "", "status": "",
        "date_from": "", "date_to": "", "finding": "", "emergency": False,
    }


def _parse_mock(text: str, today: date) -> dict:
    """결정적 휴리스틱 파서 — live와 동일한 filter 스키마를 반환한다."""
    low = text.lower()
    f = _empty_filter()
    parts: list[str] = []

    # 기간
    ymd = lambda d: d.strftime("%Y%m%d")  # noqa: E731
    m = _RECENT_DAYS.search(low)
    if m:
        f["date_from"], f["date_to"] = ymd(today - timedelta(days=int(m.group(1)))), ymd(today)
    elif "오늘" in low:
        f["date_from"] = f["date_to"] = ymd(today)
    elif "어제" in low:
        f["date_from"] = f["date_to"] = ymd(today - timedelta(days=1))
    elif "지난주" in low or "지난 주" in low or "일주일" in low or "1주" in low:
        f["date_from"], f["date_to"] = ymd(today - timedelta(days=7)), ymd(today)
    elif "지난달" in low or "한달" in low or "한 달" in low or "1개월" in low:
        f["date_from"], f["date_to"] = ymd(today - timedelta(days=30)), ymd(today)
    if f["date_from"]:
        parts.append(f"기간 {f['date_from']}~{f['date_to']}")

    # 모달리티 / 부위
    for kw, mod in _MODALITY_KEYWORDS:
        if kw in low:
            f["modality"] = mod
            parts.append(f"Modality {mod}")
            break
    for kw, bp in _BODYPART_KEYWORDS:
        if kw in low:
            f["body_part"] = bp
            parts.append(f"부위 {bp}")
            break

    # 상태 — '미판독'이 '판독'을 포함하므로 순서 중요
    if "미판독" in low or "안 읽" in low or "unread" in low:
        f["status"] = "unread"
        parts.append("상태 미판독")
    elif "판독완료" in low or "확정" in low:
        f["status"] = "finalized"
        parts.append("상태 확정")
    elif "보류" in low:
        f["status"] = "suspended"
        parts.append("상태 보류")
    elif "판독중" in low:
        f["status"] = "reading"
        parts.append("상태 판독중")
    elif "초안" in low:
        f["status"] = "draft_ready"
        parts.append("상태 AI초안")

    # 성별 / 응급
    if "남성" in low or "남자" in low:
        f["sex"] = "M"
        parts.append("남성")
    elif "여성" in low or "여자" in low:
        f["sex"] = "F"
        parts.append("여성")
    if "응급" in low or "emergency" in low or "stat" in low:
        f["emergency"] = True
        parts.append("⚠ Emergency")

    explanation = " · ".join(parts) if parts else "해석된 조건 없음 — 전체 검색"
    return {"filter": f, "explanation": explanation}


def nl_to_query(text: str, today: date | None = None) -> dict:
    """자연어 → {filter, explanation, source}. live 실패 시 휴리스틱 폴백."""
    today = today or date.today()
    if get_settings().ai_mode == "live":
        try:
            from app.rag.generate import generate_nl_query

            result = generate_nl_query(text, today.isoformat())
            return {**result, "source": "live"}
        except Exception:
            logger.exception("nl_to_query live 실패 — 휴리스틱 폴백")
            return {**_parse_mock(text, today), "source": "live_fallback"}
    return {**_parse_mock(text, today), "source": "mock"}
