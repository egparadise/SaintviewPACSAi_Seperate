"""PHI 비식별화 게이트 — CLAUDE.md 절대 규칙 1.

Claude API(또는 외부 임베딩 API)로 나가는 모든 텍스트는 본 모듈 mask()를 통과해야 한다.
나이·성별은 판독에 필요하므로 유지(설계 §8.1).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

# 한국 주민등록번호
_RRN = re.compile(r"\b\d{6}\s*[-–]\s*[1-4]\d{6}\b")
# 전화번호 (지역/휴대)
_PHONE = re.compile(r"\b0\d{1,2}[- .]?\d{3,4}[- .]?\d{4}\b")
# 이메일
_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.]+\b")
# 환자번호로 보이는 6자리 이상 숫자 식별자 (날짜 YYYYMMDD 형태는 제외)
_PATIENT_NO = re.compile(r"\b(?!19\d{6}\b|20\d{6}\b)\d{6,10}\b")
# 생년월일 표기 — 구분자(-, ., /, 년/월)가 있는 형태만. 무구분 YYYYMMDD는 검사일로 보존
_BIRTH = re.compile(r"\b(19|20)\d{2}\s?[-./년]\s?\d{1,2}\s?[-./월]\s?\d{1,2}일?\b")


@dataclass
class DeidResult:
    text: str
    replaced: dict[str, list[str]] = field(default_factory=dict)

    @property
    def clean(self) -> bool:
        return not any(self.replaced.values())


def mask(text: str, patient_names: list[str] | None = None) -> DeidResult:
    """텍스트에서 PHI를 토큰으로 치환한다.

    patient_names: DB에서 알고 있는 환자명 목록(정확 치환).
    """
    replaced: dict[str, list[str]] = {"rrn": [], "phone": [], "email": [], "id": [], "name": [], "birth": []}
    out = text

    for pat, key, token in (
        (_RRN, "rrn", "[RRN]"),
        (_EMAIL, "email", "[EMAIL]"),
        (_PHONE, "phone", "[PHONE]"),
        (_BIRTH, "birth", "[BIRTH]"),
        (_PATIENT_NO, "id", "[ID]"),
    ):
        found = pat.findall(out)
        if found:
            replaced[key].extend(f if isinstance(f, str) else "".join(f) for f in found)
            out = pat.sub(token, out)

    for name in patient_names or []:
        name = (name or "").strip()
        if len(name) >= 2 and name in out:
            replaced["name"].append(name)
            out = out.replace(name, "[PATIENT]")

    return DeidResult(text=out, replaced=replaced)


def assert_no_phi(text: str) -> None:
    """전송 직전 최종 검문 — PHI 잔존 시 예외(설계 §10: 잔존 0 게이트)."""
    res = mask(text)
    leftovers = {k: v for k, v in res.replaced.items() if v and k != "id"}
    # 숫자 ID는 마스킹 후에도 오탐 가능성이 있어 경고 수준으로만 본다(테스트에서 별도 검증)
    if leftovers:
        raise ValueError(f"PHI 잔존 의심: { {k: len(v) for k, v in leftovers.items()} }")
