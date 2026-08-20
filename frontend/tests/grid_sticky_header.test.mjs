/* 워크리스트 제목 줄 고정 계약(2026-08-20 사용자 지적).
 *
 * 증상: 목록을 아래로 내리면 항목 이름 줄(#·상태·의뢰 일시·센터명…)이 같이 밀려 올라가
 *       어느 칸이 무엇인지 알 수 없었다.
 *
 * 원인: theme.css 에 `.grid-table th { position: sticky; top: 0 }` 가 **이미 있었는데**,
 *       StudyGrid 의 <th> 인라인 style 이 `position: "relative"` 로 그걸 덮었다.
 *       (폭 조절 손잡이가 absolute 라 기준 상자가 필요해서 넣은 것이었는데, sticky 도
 *        똑같이 기준 상자가 되므로 relative 일 이유가 없었다.)
 *       인라인 스타일이 없는 '#' 열 헤더만 붙어 있어서 증상이 더 헷갈렸다.
 *
 * 브라우저로 확인한 사실(최소 재현, 실제 theme.css):
 *   position:sticky  → 800px 스크롤해도 헤더 top = 0   (고정)
 *   position:relative→ 800px 스크롤하면 헤더 top = -800 (같이 밀림)
 *
 * 실행: node --test frontend/tests/grid_sticky_header.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");

test("CSS — 그리드 헤더는 sticky 이고 본문 위에 온다", () => {
  const css = src("src/theme.css");
  const i = css.indexOf(".grid-table th {");
  assert.ok(i > 0, ".grid-table th 규칙을 찾지 못했다");
  const rule = css.slice(i, css.indexOf("}", i));
  assert.match(rule, /position:\s*sticky/);
  assert.match(rule, /top:\s*0/);
  assert.match(rule, /z-index:\s*\d/, "배경 있는 본문 행(선택·응급)이 헤더 위로 겹치지 않게");
  assert.match(rule, /background:/, "투명하면 스크롤된 행이 글자 뒤로 비친다");
});

test("인라인 style 이 sticky 를 덮지 않는다 — 이게 실제 사고였다", () => {
  const w = src("src/pages/Worklist.tsx");
  const i = w.indexOf("<th key={c}");
  assert.ok(i > 0, "컬럼 헤더 <th> 를 찾지 못했다");
  const th = w.slice(i, i + 1800);
  assert.match(th, /position:\s*"sticky"/, "헤더 셀은 sticky 여야 한다");
  assert.ok(!/position:\s*"relative"/.test(th),
    "relative 로 덮으면 theme.css 의 sticky 가 죽어 제목 줄이 같이 스크롤된다");
  assert.match(th, /top:\s*0/);
  assert.match(th, /zIndex:\s*\d/);
});

test("폭 조절 손잡이는 그대로 동작한다 — sticky 도 absolute 의 기준 상자다", () => {
  const w = src("src/pages/Worklist.tsx");
  const i = w.indexOf("<th key={c}");
  const th = w.slice(i, i + 2200);
  assert.match(th, /startResize\(c\)/, "손잡이가 붙어 있어야 한다");
  assert.match(th, /position:\s*"absolute",\s*right:\s*0/,
    "손잡이는 헤더 셀 기준 absolute — sticky 부모에서도 같은 자리에 놓인다");
});

test("스크롤 주체가 그리드 상자여야 한다 — 바깥이 스크롤되면 sticky 는 무력하다", () => {
  const w = src("src/pages/Worklist.tsx");
  // StudyGrid 자신의 스크롤 상자
  assert.match(w, /<div style=\{\{ overflow: "auto", flex: 1, minWidth: 0 \}\}>/,
    "그리드가 자기 상자 안에서 스크롤해야 한다");
  // <StudyGrid ...> 를 감싸는 flex 자식은 줄어들 수 있어야 한다.
  // (flex 자식의 기본 min-height 는 auto — 내용만큼 부풀어 스크롤이 바깥에서 일어난다.)
  let n = 0;
  for (const m of w.matchAll(/<StudyGrid /g)) {
    const before = w.slice(Math.max(0, m.index - 400), m.index);
    const open = before.lastIndexOf("<div style={{");
    assert.ok(open >= 0, "그리드를 감싸는 컨테이너를 찾지 못했다");
    const box = before.slice(open);
    assert.ok(/minHeight: (0|[1-9])/.test(box),
      `minHeight 가 없으면 스크롤이 바깥에서 일어나 안쪽 sticky 가 무력해진다 — ${box.slice(0, 120)}`);
    n++;
  }
  assert.ok(n >= 2, `그리드 호출부 두 곳(SaintView·I-View)을 모두 확인해야 한다(찾은 수 ${n})`);
});
