/* 과거 판독 복사 계약(2026-08-22 사용자 확정).
 *
 * 사용자 요구:
 *   "판독창 History 의 ⇆ 버튼을 누르면 과거 검사의 **Reading 과 Conclusion 모두**가
 *    우측 Reading·Conclusion 항목에 복사되어 입력되게 — 그렇게 되어 있는지 점검하고 아니면 고쳐."
 *
 * 점검 결과(그전 상태)
 *  · `⇆` 는 **클릭 핸들러가 없는 장식**이었다 — 눌러도 아무 일도 없었다.
 *  · 옆 '복사' 는 narrative_text(합쳐진 한 덩어리)를 **마지막으로 포커스했던 칸 하나**에만 붙였다.
 *    그래서 판독 소견이 결론 칸에 들어가기도 했다.
 *
 * 실행: node --test --experimental-strip-types frontend/tests/report_paste_rule.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { appendLine, hasAnyText, splitReport } from "../src/lib/reportText.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (f) => readFileSync(join(ROOT, f), "utf8");
const r = src("src/pages/ReportWindow.tsx");
/** 과거 판독을 보여 주는 화면들 — 같은 기능이 두 곳에 있으므로 **함께** 확인한다.
 *  (2026-08-21 에 한쪽만 고쳐 빠뜨린 전례가 있다 — 리포트 30 참조.) */
const SCREENS = {
  "판독창(ReportWindow)": "src/pages/ReportWindow.tsx",
  "뷰어 도크(ReportDock)": "src/components/ReportDock.tsx",
};

test("★ SR 을 두 칸으로 가른다 — findings→Reading, impression→Conclusion", () => {
  const rep = {
    sr_json: {
      findings: [{ organ: "Lung", observation: "No active lesion" },
                 { organ: "", observation: "Cardiomegaly", severity: "critical" }],
      impression: [{ statement: "No specific bony abnormality" }, { statement: "F/U 권고" }],
    },
  };
  const p = splitReport(rep);
  assert.equal(p.reading, "Lung: No active lesion\nCardiomegaly [CRITICAL]");
  assert.equal(p.conclusion, "No specific bony abnormality\nF/U 권고");
});

test("비교 요약은 Reading 맨 앞에 — 화면이 펼칠 때와 같은 규칙", () => {
  const p = splitReport({ sr_json: { comparison: { summary: "2024-08-22 대비" },
                                     findings: [{ observation: "변화 없음" }] } });
  assert.equal(p.reading, "[비교] 2024-08-22 대비\n변화 없음");
});

test("빈 소견은 건너뛴다 — 빈 줄만 늘리지 않는다", () => {
  const p = splitReport({ sr_json: { findings: [{ organ: "Lung", observation: "" }, { observation: "정상" }],
                                     impression: [{ statement: "" }, { statement: "정상" }] } });
  assert.equal(p.reading, "정상");
  assert.equal(p.conclusion, "정상");
});

test("SR 이 없는 옛 판독문은 **결론 칸**으로 — 소견인지 알 수 없다", () => {
  const p = splitReport({ sr_json: null, narrative_text: "예전 자유 텍스트" });
  assert.equal(p.reading, "", "소견 칸에 넣으면 '내가 쓴 소견'처럼 보여 더 위험하다");
  assert.equal(p.conclusion, "예전 자유 텍스트");
  // 아무것도 없으면 둘 다 빈 값
  assert.deepEqual(splitReport(null), { reading: "", conclusion: "" });
  assert.deepEqual(splitReport({}), { reading: "", conclusion: "" });
});

test("붙일 때는 줄을 바꿔 잇는다 — 기존 내용을 덮지 않는다", () => {
  assert.equal(appendLine("이미 쓴 것", "새 줄"), "이미 쓴 것\n새 줄");
  assert.equal(appendLine("", "새 줄"), "새 줄");
  assert.equal(appendLine("이미 쓴 것", "   "), "이미 쓴 것", "빈 값은 아무 일도 하지 않는다");
});

test("넣을 것이 없으면 버튼을 비활성으로", () => {
  assert.equal(hasAnyText({ reading: "", conclusion: "" }), false);
  assert.equal(hasAnyText({ reading: "  ", conclusion: "\n" }), false);
  assert.equal(hasAnyText({ reading: "", conclusion: "x" }), true);
  assert.equal(hasAnyText(null), false);
});

test("★ ⇆ 는 실제 버튼이고 두 칸에 각각 넣는다", () => {
  assert.match(r, /onClick=\{\(ev\) => \{ ev\.stopPropagation\(\); pasteBoth\(pastParts\[e\.id\]\); \}\}/,
    "예전에는 클릭 핸들러가 없는 장식이었다");
  const i = r.indexOf("const pasteBoth =");
  assert.ok(i > 0, "두 칸 복사 함수를 찾지 못했다");
  const body = r.slice(i, i + 900);
  assert.match(body, /setReading\(\(prev\) => appendLine\(prev, p\.reading\)\)/);
  assert.match(body, /setConclusion\(\(prev\) => appendLine\(prev, p\.conclusion\)\)/);
  assert.match(body, /lockedRef\.current \|\| finalizedRef\.current/, "확정·잠금 상태에서는 넣지 않는다");
});

test("'복사' 버튼도 같은 동작 — 두 버튼이 다르게 굴면 헷갈린다", () => {
  const hits = [...r.matchAll(/pasteBoth\(pastParts\[e\.id\]\)/g)];
  assert.equal(hits.length, 2, "⇆ 와 '복사' 가 같은 함수를 쓴다");
  assert.ok(!/pasteReading\(pastTexts\[e\.id\]\)/.test(r),
    "합쳐진 한 덩어리를 한 칸에만 붙이던 옛 경로가 남아 있으면 안 된다");
});

test("가르는 규칙은 lib 한 곳 — 화면 펼침과 복사가 갈리지 않게", () => {
  assert.match(r, /import \{ appendLine, hasAnyText, splitReport, type ReportParts \} from "\.\.\/lib\/reportText"/);
  assert.match(r, /setPastParts\(\(m\) => \(\{ \.\.\.m, \[e\.id\]: splitReport\(fin \?\? null\) \}\)\)/,
    "미리보기용 합친 문자열과 별개로 **원본 SR** 을 갈라 둔다");
});

test("★ 과거 판독을 보여 주는 **모든 화면**에 복사가 있고, 같은 규칙을 쓴다", () => {
  for (const [label, f] of Object.entries(SCREENS)) {
    const t = src(f);
    assert.match(t, /const pasteBoth = /, `${label}: 두 칸 복사 함수`);
    assert.match(t, /setReading\(\(prev\) => appendLine\(prev, p\.reading\)\)/, `${label}: Reading`);
    assert.match(t, /setConclusion\(\(prev\) => appendLine\(prev, p\.conclusion\)\)/, `${label}: Conclusion`);
    assert.match(t, /from "\.\.\/lib\/reportText"/, `${label}: 규칙은 lib 한 곳`);
    // 자체 분리 구현이 남아 있으면 화면마다 같은 판독문이 달라 보인다
    assert.ok(!/\[비교\] \$\{sr\.comparison\.summary\}/.test(t),
      `${label}: 판독문을 가르는 코드를 복제하면 갈린다`);
  }
});

test("도크도 확정 상태에서는 복사하지 않는다", () => {
  const d = src("src/components/ReportDock.tsx");
  const i = d.indexOf("const pasteBoth = ");
  const body = d.slice(i, i + 600);
  assert.match(body, /finalizedDock/, "확정된 판독을 덮어쓰면 안 된다");
  assert.match(body, /hasAnyText\(p\)/, "넣을 것이 없으면 아무 일도 하지 않는다");
});

/* ── 2026-08-22 전수 점검 ──────────────────────────────────────────────────
 * "과거 판독을 가져온다" 는 기능이 **세 곳**에 있었다: 판독창 ⇆ · 도크 ⇆ · 워크리스트
 * 컨텍스트 메뉴 '과거 판독 복사'. 셋째만 impression 만 가져와 **과거 소견이 통째로 사라졌다**.
 * 사용자에겐 같은 기능인데 어디서 눌렀는지에 따라 결과가 달랐다. */

test("★ 워크리스트 '과거 판독 복사' 도 Reading·Conclusion 둘 다 옮긴다", () => {
  const w = src("src/pages/Worklist.tsx");
  const i = w.indexOf('case "copyreport"');
  assert.ok(i > 0, "메뉴 동작을 찾지 못했다");
  const body = w.slice(i, i + 1800);
  assert.match(body, /const p = splitReport\(prior\)/, "규칙은 lib 한 곳(판독창 ⇆ 와 같은 결과)");
  assert.match(body, /sr\.findings = \[\.\.\.\(sr\.findings \?\? \[\]\)/, "과거 소견 → Reading(findings)");
  assert.match(body, /appendLine\(sr\.impression\[0\]\.statement/, "과거 결론 → Conclusion");
  assert.ok(!/prior\.sr_json\.impression\.map\(/.test(w),
    "결론만 긁어 오던 옛 경로가 남아 있으면 소견이 또 사라진다");
});

