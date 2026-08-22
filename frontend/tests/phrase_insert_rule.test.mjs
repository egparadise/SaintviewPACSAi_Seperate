/* 상용구 삽입·저장 규칙 계약(2026-08-22 사용자 확정).
 *
 * 사용자 요구:
 *   "상용구 항목을 선택하고 '삽입' 을 누르면 Report 의 **Reading 과 Conclusion 에 항목별로**
 *    들어가야 한다. 또한 저장을 누르면 Setting>판독>저장 규칙에 따라야 한다."
 *
 * 그전에는 결론 칸에만 한 덩어리로 붙였다 — 판독 소견으로 등록한 문장이 결론에 섞였다.
 *
 * 실행: node --test frontend/tests/phrase_insert_rule.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const w = readFileSync(join(ROOT, "src/pages/Worklist.tsx"), "utf8");

test("★ 판독은 READING(findings), 결론은 CONCLUSION(impression) 으로 나뉜다", () => {
  const i = w.indexOf("const insertText = (p: PhraseParts)");
  assert.ok(i > 0, "항목별 삽입 함수를 찾지 못했다");
  const body = w.slice(i, i + 1400);
  assert.match(body, /n\.findings = \[\.\.\.\(n\.findings \?\? \[\]\), *\r?\n?\s*\{ organ:/,
    "판독 소견은 findings 로");
  assert.match(body, /n\.impression\[0\]\.statement \+=/, "결론은 impression 으로");
  assert.match(body, /if \(!reading && !concl\) return d;/,
    "둘 다 비면 아무것도 하지 않는다(빈 줄만 늘리지 않는다)");
});

test("판독 소견은 줄 단위로 쌓인다 — 이어 붙이면 어느 소견인지 구분되지 않는다", () => {
  const i = w.indexOf("const insertText = (p: PhraseParts)");
  const body = w.slice(i, i + 1400);
  // findings 는 배열에 **추가**한다(문자열 이어 붙이기가 아니다)
  assert.match(body, /observation: reading/);
  assert.ok(!/findings\[0\]\.observation \+=/.test(body));
});

test("'삽입' 버튼·더블클릭·단축키가 **같은 결과**를 낸다", () => {
  assert.match(w, /onInsert\(sel\)/, "삽입 버튼이 항목 전체를 넘긴다");
  assert.match(w, /onDoubleClick=\{\(\) => onInsert\(p\)\}/, "더블클릭도");
  assert.match(w, /\.map\(\(p\) => \[comboLabel\(p\.shortcut\), p\]\)/,
    "단축키 매핑도 항목 전체 — 본문만 나르면 판독 칸이 비어 버린다");
  // 삽입 경로가 한 함수로 모여 있어야 갈리지 않는다
  assert.match(w, /useEffect\(\(\) => \{ insertRef\.current = insertText; \}\);/,
    "예전에는 여기 따로 구현이 있어 결론 칸에만 붙였다");
});

test("음성 전사는 종전대로 결론 칸으로", () => {
  assert.match(w, /insertText\(\{ text: r\.text \}\)/);
  assert.match(w, /insertText\(\{ text \}\)/);
});

test("★ 저장은 Setting>판독>자동화 규칙을 따른다", () => {
  const i = w.indexOf("  const save = async () => {\n    if (!current || !draft) return;");
  assert.ok(i > 0, "리포트 저장 함수를 찾지 못했다");
  const body = w.slice(i, i + 700);
  assert.match(body, /navAfterSave\(readAutoAfterSave\(autoSave\), true\)/,
    "판독창과 **같은 규칙**(lib/readingAuto)을 쓴다");
  assert.match(body, /if \(dir && onNav\) onNav\(dir\)/);
  // 저장 성공 뒤에만 — updateReport 다음에 온다
  assert.ok(body.indexOf("await api.updateReport") < body.indexOf("navAfterSave"),
    "저장이 끝난 뒤에 움직여야 한다(실패했는데 넘어가면 판독문을 잃는다)");
});

test("설정값을 report.prefs 에서 읽는다 — 판독창과 같은 키", () => {
  assert.match(w, /setAutoSave\(readAutoAfterSave\(v\.auto_after_save\)\)/);
  assert.match(w, /const \[autoSave, setAutoSave\] = useState<AutoAfterSave>\(AUTO_AFTER_SAVE_DEFAULT\)/);
});

test("확정(Approve) 후 동작과 섞이지 않는다 — 다른 버튼이다", () => {
  assert.match(w, /if \(openNext && onNav\) onNav\(1\);/, "확정 뒤 동작은 그대로 남는다");
  assert.match(w, /확정\(Approve\) 후 다음 레포트 열기/, "주석도 어느 버튼인지 밝힌다");
});
