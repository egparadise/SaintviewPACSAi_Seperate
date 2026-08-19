/* SpLbl(Spine Label — 클릭 연번 라벨) 3뷰어 계약(2026-08-19 사용자 확정).
 *
 * 요청: "T-View 에 있는 '클릭 지점에 자동 번호 넣기' 툴을 I-View 와 SaintView 에도.
 *        다만 각 뷰어 스타일에 맞게 아이콘 디자인은 다르게."
 *
 * 계약:
 *   · 동작 로직은 뷰어마다 **한 곳**씩만 — Viewer2D(SaintView·T-View 공용) case "spine",
 *     ViewerInfi case "spine". 첫 클릭에 시작 라벨(L1) 을 묻고 이후 클릭마다 연번 증가.
 *   · 노출: T-View 팔레트(TOOL_DEFS) · SaintView 메뉴(saintMenus) · I-View 팔레트(IN_PALETTE).
 *   · 아이콘은 **뷰어마다 다른 디자인** — 같은 그림을 돌려쓰지 않는다.
 *
 * 실행: node --test frontend/tests/splbl_tool_rule.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");

test("동작 로직 — 첫 클릭에 시작 라벨, 이후 연번 증가(두 엔진 모두)", () => {
  for (const f of ["src/pages/Viewer2D.tsx", "src/pages/ViewerInfi.tsx"]) {
    const s = src(f);
    assert.match(s, /case "spine": \{/, `${f} — spine 처리`);
    assert.match(s, /spineSeq\.current\.n \+= 1/, `${f} — 클릭마다 연번 증가`);
    assert.match(s, /\$\{spineSeq\.current\.base\}\$\{spineSeq\.current\.n\}/, `${f} — 라벨 = base+n`);
  }
});

test("노출 — 3뷰어 전부(T-View 팔레트·SaintView 메뉴·I-View 팔레트)", () => {
  const v2 = src("src/pages/Viewer2D.tsx");
  assert.match(v2, /\["spine", "SpLbl",/, "T-View TOOL_DEFS");
  assert.match(v2, /mkItem\("spine", "Spine Label", \(\) => pickTool\("spine"\)\)/, "SaintView 메뉴");
  assert.match(src("src/lib/infiConfig.ts"), /id: "spine",[\s\S]{0,160}impl: true/, "I-View IN_PALETTE(구현됨)");
});

test("아이콘 — 뷰어마다 다른 디자인(같은 그림 돌려쓰기 금지)", () => {
  const ty = src("src/components/ToolIconTy.tsx");
  assert.match(ty, /^\s{2}spine: \{/m, "T-View 판 — 추체 점 + 라벨 틱");
  assert.match(ty, /^\s{2}spineSaint: \{/m, "SaintView 전용 판");
  // SaintView 메뉴 항목이 실제로 전용 아이콘 id 를 쓴다(기본값 'spine' 로 새지 않는다)
  assert.match(src("src/pages/Viewer2D.tsx"), /icon: "spineSaint"/, "SaintView 아이콘 분리 배선");
  // 두 판의 실루엣이 실제로 다르다 — 같은 body 를 복사하면 이 단언이 깨진다
  const bodyOf = (key) => {
    const m = ty.match(new RegExp(`\\r?\\n  ${key}: \\{[\\s\\S]*?\\r?\\n  \\},`));
    assert.ok(m, `${key} 정의`);
    return m[0].replace(/\s+/g, "");
  };
  assert.notEqual(bodyOf("spine"), bodyOf("spineSaint"), "T-View·SaintView 아이콘이 서로 달라야 한다");

  // I-View 는 자체 컬러 아이콘 세트 — 번호 라벨 칩(노랑)이 있어야 '연번' 기능이 읽힌다
  const infi = src("src/pages/ViewerInfi.tsx");
  const m = infi.match(/spine: \([\s\S]*?\r?\n  \),/);
  assert.ok(m, "I-View spine 아이콘");
  assert.match(m[0], /#facc15/, "번호 라벨 칩 색(실제 화면 마커와 같은 노랑)");
});
