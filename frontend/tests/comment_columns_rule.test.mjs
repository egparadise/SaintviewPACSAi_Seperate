/* SV70 코멘트 2종 워크리스트 연동(2026-08-12 사용자 확정) — 소스 계약.
 *
 *  A 원천 확정(핸드오버 정독): 검사 코멘트 = PacsStudyView.study_comment,
 *  병원 코멘트 = PacsStudyView.original_comments (A 클라이언트 workList.json 라벨 매핑).
 *
 *  · Live 행은 두 값을 원천 그대로 싣는다(들어오는 값 확인 목적 — 가공 금지).
 *  · 로컬 행은 공란(원천이 A 전용 — 4항목과 같은 '추정 기입 금지' 원칙).
 *  · 기본 컬럼 순서는 A 화면과 같게: … 검사명(검사 내용) → 응급여부 → 검사 코멘트 →
 *    병원 코멘트 → (메모) → Accession. 설정>워크리스트 항목 구성은 COLUMN_DEFS 순회라
 *    자동 노출된다(별도 배선 없음 — 그게 계약이다).
 *
 * 실행: node --test frontend/tests/comment_columns_rule.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");

test("Live 행 — A 원천 필드명 그대로 매핑(study_comment/original_comments)", () => {
  const s = src("../backend/app/services/webpacs_live.py");
  assert.match(s, /"exam_comment": str\(r\.get\("study_comment"\) or ""\)/);
  assert.match(s, /"hospital_comment": str\(r\.get\("original_comments"\) or ""\)/);
});

test("로컬 행 — 공란(추정 기입 금지)", () => {
  const s = src("../backend/app/services/study_service.py");
  assert.match(s, /"exam_comment": "",\s*\n\s*"hospital_comment": "",/);
});

test("컬럼 정의·기본 순서 — A 화면 순서(응급여부 다음 두 코멘트)", () => {
  const w = src("src/pages/Worklist.tsx");
  assert.ok(w.includes('exam_comment: { label: "검사 코멘트"'));
  assert.ok(w.includes('hospital_comment: { label: "병원 코멘트"'));
  assert.match(w, /"priority", "exam_comment", "hospital_comment",\s*\n\s*"memo"/,
               "기본 컬럼: 응급여부 → 검사 코멘트 → 병원 코멘트 → 메모");
  assert.match(w, /exam_comment: 150, hospital_comment: 150/, "기본 폭");
  const api = src("src/api.ts");
  assert.ok(api.includes("exam_comment?: string") && api.includes("hospital_comment?: string"));
});

test("mock A — 행마다 두 코멘트(백엔드 테스트 근거)", () => {
  const m = src("../harness/mock_webpacs_api.py");
  assert.match(m, /"study_comment": f"검사코멘트\{n\}", "original_comments": f"-\/-\/병원메모\{n\}"/);
});
