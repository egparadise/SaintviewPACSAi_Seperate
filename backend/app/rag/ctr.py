"""S2 자동계측 — 심흉비(CTR, ai_quantify 계열).

- mock: study_uid 기반 결정적 값(개발/테스트) — 해부학적으로 그럴듯한 범위.
- live: rag.generate.generate_ctr(vision) 경유. 이미지는 image_guard를 먼저 통과한다.
모든 결과는 numeric_verify를 거치고(03 스킬 규칙), 라벨링된 초안으로만 제공한다.
"""
from __future__ import annotations

import hashlib
import logging

from app.config import get_settings

logger = logging.getLogger(__name__)


def numeric_verify(result: dict) -> tuple[bool, str]:
    """좌표·비율 타당성 검증 — 통과 못 하면 verified=False로 라벨."""
    try:
        c, t = result["cardiac"], result["thoracic"]
        for seg in (c, t):
            if not (0.0 <= seg["x1"] < seg["x2"] <= 1.0 and 0.0 <= seg["y"] <= 1.0):
                return False, "좌표 범위 이상(0~1 정규화 위반 또는 x1>=x2)"
        cw, tw = c["x2"] - c["x1"], t["x2"] - t["x1"]
        if tw <= 0:
            return False, "흉곽 폭 0"
        ctr = cw / tw
        if not (0.2 <= ctr <= 0.95):
            return False, f"CTR {ctr:.2f} — 해부학적 범위(0.2~0.95) 밖"
        if not (t["x1"] - 0.05 <= c["x1"] and c["x2"] <= t["x2"] + 0.05):
            return False, "심장 폭이 흉곽 밖"
        return True, ""
    except (KeyError, TypeError) as e:
        return False, f"결과 형식 오류: {e}"


def _mock_ctr(study_uid: str) -> dict:
    """결정적 mock — UID 해시로 0.42~0.55 범위 CTR을 재현 가능하게 생성."""
    h = int(hashlib.sha256(study_uid.encode()).hexdigest(), 16)
    ctr = 0.42 + (h % 1000) / 1000 * 0.13
    t_x1, t_x2, y = 0.12, 0.88, 0.58
    tw = t_x2 - t_x1
    cw = tw * ctr
    cx = 0.52  # 심장 중심은 좌측 치우침 가정
    return {
        "cardiac": {"x1": round(cx - cw / 2, 4), "x2": round(cx + cw / 2, 4), "y": round(y + 0.04, 4)},
        "thoracic": {"x1": t_x1, "x2": t_x2, "y": y},
        "confidence": 0.85,
        "note": "mock 모드 결정적 계측",
    }


def measure_ctr(study_uid: str, png_bytes: bytes | None) -> dict:
    """CTR 계측 → {ctr, cardiac, thoracic, confidence, verified, verify_note, source}."""
    if get_settings().ai_mode == "live" and png_bytes:
        try:
            from app.rag.generate import generate_ctr

            raw = generate_ctr(png_bytes)
            source = "live"
        except Exception:
            logger.exception("CTR live 실패 — mock 폴백")
            raw = _mock_ctr(study_uid)
            source = "live_fallback"
    else:
        raw = _mock_ctr(study_uid)
        source = "mock"

    ok, note = numeric_verify(raw)
    cw = raw["cardiac"]["x2"] - raw["cardiac"]["x1"] if ok else 0.0
    tw = raw["thoracic"]["x2"] - raw["thoracic"]["x1"] if ok else 1.0
    return {
        "ctr": round(cw / tw, 3) if ok else None,
        "cardiac": raw.get("cardiac"),
        "thoracic": raw.get("thoracic"),
        "confidence": raw.get("confidence", 0.0),
        "note": raw.get("note", ""),
        "verified": ok,
        "verify_note": note,
        "source": source,
    }
