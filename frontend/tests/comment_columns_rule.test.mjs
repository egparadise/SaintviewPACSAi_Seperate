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

/* ── 2026-08-22 사용자 확정 — 그리드의 두 코멘트를 패널에서 전문으로 읽는다 ──────────
 * "1번 그림의 '병원코멘트'·'검사코멘트'는 2번 그림(Comment 패널)에 내용이 보여야 해.
 *  또한 이름을 'Comment / MEMO' 에서 'Comment' 로 해줘." */

test("패널 이름은 'Comment'", () => {
  const w = src("src/pages/Worklist.tsx");
  assert.match(w, /<PanelBox title="Comment" right=/);
  assert.ok(!/title="Comment \/ MEMO"/.test(w), "옛 이름이 남아 있으면 안 된다");
});

test("패널이 병원·검사 코멘트를 보여 준다 — 그리드와 같은 값", () => {
  const w = src("src/pages/Worklist.tsx");
  const i = w.indexOf("function CommentMemoPanel");
  assert.ok(i > 0);
  const body = w.slice(i, i + 2600);
  assert.match(body, /detail\.hospital_comment/, "병원 코멘트");
  assert.match(body, /detail\.exam_comment/, "검사 코멘트");
  // 긴 코멘트가 한 줄로 뭉치지 않게
  assert.match(body, /whiteSpace: "pre-wrap"/, "줄바꿈을 살려 읽는다");
  // 값이 없으면 빈 제목 줄을 만들지 않는다
  assert.match(body, /\(v \? \(/, "값이 있을 때만 그 줄을 그린다");
});

test("그리드 — 잘린 값을 툴팁으로 읽을 수 있다", () => {
  const w = src("src/pages/Worklist.tsx");
  assert.match(w, /const cell = COLUMN_DEFS\[c\]\?\.render\(row\);/);
  assert.match(w, /title=\{typeof cell === "string" && cell \? cell : undefined\}/,
    "코멘트처럼 긴 값은 한 줄에 다 담기지 않는다 — ReactNode 를 그리는 컬럼은 제외");
});

test("패널은 detail 을 쓰고, Live detail 에는 두 값이 실린다", () => {
  // 패널이 보는 것은 StudyDetail 이다 — 단건 조회에 값이 없으면 패널이 늘 비어 보인다
  const api = src("src/api.ts");
  assert.match(api, /exam_comment\?: string;/);
  assert.match(api, /hospital_comment\?: string;/);
  const live = src("../backend/app/services/webpacs_live.py");
  const i = live.indexOf("def live_detail");
  assert.ok(i > 0);
  assert.match(live.slice(i, i + 1200), /row = _row_of\(r\)/,
    "detail 이 행 매핑을 그대로 쓰므로 두 코멘트가 함께 실린다");
});

