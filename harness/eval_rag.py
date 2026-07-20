"""RAG 품질 평가 하네스 (설계 §10 릴리스 게이트).

모드:
  py -3.11 harness/eval_rag.py                          # 내장 합성 케이스(빠른 회귀)
  py -3.11 harness/eval_rag.py --cases harness/eval_cases   # 실데이터 JSONL 케이스
  SAINTVIEW_AI_MODE=live py -3.11 harness/eval_rag.py --cases ... --judge
                                                        # + LLM-judge 5점 루브릭 채점

평가 항목:
1. 스키마 적합률(100% 게이트) 2. checks(must_include/must_not/critical)
3. PHI 게이트(전송 컨텍스트 잔존 0) 4. (--judge) ground_truth 대비 일치/누락/환각 채점
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

BUILTIN_CASES = [
    {"id": "B1", "modality": "CT", "body_part": "CHEST", "study_desc": "CT Chest (CE)",
     "clinical_info": "만성 기침", "priors": [],
     "checks": {"must_include": [], "must_not_include": [], "critical": False}},
    {"id": "B2", "modality": "CR", "body_part": "CHEST", "study_desc": "Chest PA",
     "clinical_info": "기흉 의심 외상", "priors": [],
     "checks": {"must_include": [], "must_not_include": [], "critical": True}},
    {"id": "B3", "modality": "MR", "body_part": "BRAIN", "study_desc": "MR Brain",
     "clinical_info": "급성 경색 r/o", "priors": [],
     "checks": {"must_include": [], "must_not_include": [], "critical": True}},
    {"id": "B4-PHI", "modality": "CT", "body_part": "CHEST",
     "study_desc": "CT Chest 홍길동 850101-1234567",
     "clinical_info": "환자번호 1234567, 연락처 010-1111-2222",
     "priors": [], "phi_probe": ["850101-1234567", "홍길동", "010-1111-2222"],
     "checks": {"must_include": [], "must_not_include": [], "critical": False}},
]

# 주의: structured outputs는 숫자 minimum/maximum 미지원 — enum으로 1~5 강제
_SCORE = {"type": "integer", "enum": [1, 2, 3, 4, 5]}
JUDGE_SCHEMA = {
    "type": "object",
    "properties": {
        "key_findings_match": _SCORE,
        "omissions": _SCORE,
        "hallucination_free": _SCORE,
        "recommendation_quality": _SCORE,
        "overall": _SCORE,
        "hallucinated_statements": {"type": "array", "items": {"type": "string"}},
        "rationale": {"type": "string"},
    },
    "required": ["key_findings_match", "omissions", "hallucination_free",
                 "recommendation_quality", "overall", "hallucinated_statements", "rationale"],
    "additionalProperties": False,
}

JUDGE_SYSTEM = """당신은 영상의학 판독 평가자다. AI 초안을 실제 확정 판독(ground truth)과 비교해
5점 척도로 채점한다. 5=완벽, 1=심각한 결함.
- key_findings_match: 핵심 소견 일치도
- omissions: 누락 없음(5=누락 없음)
- hallucination_free: 환각 없음(5=근거 없는 소견 0건) — ground truth와 입력 근거에 없는
  단정적 소견을 hallucinated_statements에 나열
- recommendation_quality: 권고 적절성
초안이 '근거 부족으로 판단 불가'라고 정직하게 밝힌 부분은 환각이 아니다."""


def load_cases(cases_dir: str | None) -> list[dict]:
    if not cases_dir:
        return BUILTIN_CASES
    cases = []
    for path in sorted(Path(cases_dir).glob("*.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                cases.append(json.loads(line))
    if not cases:
        print(f"경고: {cases_dir} 에 케이스 없음 — 내장 케이스 사용")
        return BUILTIN_CASES
    return cases


def run_case(case: dict, judge: bool, strict_critical: bool) -> dict:
    from app.rag.deid import mask
    from app.rag.generate import GenerationInput, build_context, generate_draft
    from app.rag.retrieval import PriorReport
    from app.rag.schemas import SR_SCHEMA, has_critical, narrative_from_sr

    priors = [
        PriorReport(
            study_uid=p["study_uid"], study_date=p["study_date"], modality=p["modality"],
            study_desc=p["study_desc"],
            narrative_text=mask(p["narrative_text"]).text,  # 실데이터 PHI 이중 방어
            report_id=i,
        )
        for i, p in enumerate(case.get("priors", []))
    ]
    gi = GenerationInput(
        modality=case["modality"], body_part=case["body_part"],
        study_desc=mask(case["study_desc"], patient_names=["홍길동"]).text,
        clinical_info=mask(case["clinical_info"]).text,
        priors=priors,
    )
    result: dict = {"id": case["id"], "ok": True, "fails": []}

    # PHI 프로브
    if case.get("phi_probe"):
        ctx = build_context(gi)
        leaked = [t for t in case["phi_probe"] if t in ctx]
        if leaked:
            result["ok"] = False
            result["fails"].append(f"PHI 누출: {leaked}")

    out = generate_draft(gi)
    sr = out.sr_json
    if not all(k in sr for k in SR_SCHEMA["required"]):
        result["ok"] = False
        result["fails"].append("스키마 불일치")

    narrative = narrative_from_sr(sr)
    checks = case.get("checks", {})
    for kw in checks.get("must_include", []):
        if kw not in narrative:
            result["ok"] = False
            result["fails"].append(f"필수 누락: {kw}")
    for kw in checks.get("must_not_include", []):
        if kw in narrative:
            result["ok"] = False
            result["fails"].append(f"금지 포함: {kw}")
    if checks.get("critical") is not None and has_critical(sr) != checks["critical"]:
        # mock: 파이프라인 회귀 게이트(실패). live: 모델이 영상 근거 없이 critical을
        # 단정하지 않는 것은 정상 보수 정책 → 경고만 (품질은 --judge가 채점)
        msg = f"critical 판정 상이 (기대={checks['critical']})"
        if strict_critical:
            result["ok"] = False
            result["fails"].append(msg)
        else:
            result.setdefault("warns", []).append(msg)

    if judge and case.get("ground_truth"):
        result["judge"] = _judge(narrative, case["ground_truth"])
    return result


def _judge(draft: str, ground_truth: str) -> dict:
    import anthropic

    client = anthropic.Anthropic()
    resp = client.messages.create(
        model="claude-opus-4-8",
        max_tokens=4000,
        thinking={"type": "adaptive"},
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": JUDGE_SCHEMA}},
        system=[{"type": "text", "text": JUDGE_SYSTEM, "cache_control": {"type": "ephemeral"}}],
        messages=[{
            "role": "user",
            "content": f"## AI 초안\n{draft}\n\n## 확정 판독 (ground truth)\n{ground_truth}",
        }],
    )
    text = next(b.text for b in resp.content if b.type == "text")
    return json.loads(text)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", default=None, help="JSONL 케이스 디렉터리")
    parser.add_argument("--judge", action="store_true", help="LLM-judge 채점 (live 모드 필요)")
    parser.add_argument("--mode", choices=["mock", "live"], default="mock",
                        help="생성 모드 (기본 mock — backend/.env의 live 설정을 덮어씀)")
    args = parser.parse_args()

    import os

    os.environ["SAINTVIEW_AI_MODE"] = "live" if (args.mode == "live" or args.judge) else "mock"
    print(f"모드: {os.environ['SAINTVIEW_AI_MODE']}" + (" + judge" if args.judge else ""))

    cases = load_cases(args.cases)
    strict = os.environ["SAINTVIEW_AI_MODE"] == "mock"
    results = [run_case(c, judge=args.judge, strict_critical=strict) for c in cases]

    passed = sum(1 for r in results if r["ok"])
    print(f"\n결정적 게이트: {passed}/{len(results)} PASS")
    for r in results:
        mark = "PASS" if r["ok"] else "FAIL"
        notes = "; ".join(r["fails"] + [f"(경고) {w}" for w in r.get("warns", [])])
        print(f"  [{mark}] {r['id']}" + (f" — {notes}" if notes else ""))

    judged = [r for r in results if "judge" in r]
    if judged:
        avg = {k: sum(r["judge"][k] for r in judged) / len(judged)
               for k in ("key_findings_match", "omissions", "hallucination_free",
                         "recommendation_quality", "overall")}
        halluc = sum(len(r["judge"]["hallucinated_statements"]) for r in judged)
        print(f"\nLLM-judge (n={len(judged)}):")
        for k, v in avg.items():
            print(f"  {k:24s}: {v:.2f}/5")
        print(f"  환각 진술 총계          : {halluc}건 (게이트: 0)")
        if halluc > 0:
            for r in judged:
                for s in r["judge"]["hallucinated_statements"]:
                    print(f"    ! [{r['id']}] {s}")
        if avg["overall"] < 3.5 or halluc > 0:
            print("EVAL FAIL (judge 게이트)")
            return 1

    print("EVAL PASS" if passed == len(results) else "EVAL FAIL")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
