/* Tools 패널 접기/펴기 — lib/toolPanel.ts 를 **실제로** 부른다.
 *
 * 요구: 모든 뷰어(I·T·SaintView)에서 Tools 를 왼쪽으로 감췄다 다시 나타낼 수 있게.
 * 여기서 고정하는 계약:
 *   · 접힘 상태는 **뷰어별로** 남고 다시 열어도 유지된다
 *   · 접어도 **다시 펼 띠**가 남는다(RAIL_PX > 0) — 없으면 되돌릴 방법이 사라진다
 *   · localStorage 가 막혀도(시크릿 모드) 던지지 않는다 — 화면이 안 뜨면 안 된다
 */
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  RAIL_PX, railSpec, railStyle, readToolPanelOpen, toolPanelKey, writeToolPanelOpen,
} from "../src/lib/toolPanel.ts";

/** 브라우저 없이 도는 최소 localStorage */
function fakeStorage(broken = false) {
  const m = new Map();
  return {
    getItem: (k) => { if (broken) throw new Error("blocked"); return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => { if (broken) throw new Error("blocked"); m.set(k, String(v)); },
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

beforeEach(() => { globalThis.localStorage = fakeStorage(); });

test("저장한 접힘 상태가 그대로 돌아온다 — 매번 다시 접게 하지 않는다", () => {
  writeToolPanelOpen("infi", false);
  assert.equal(readToolPanelOpen("infi"), false);
  writeToolPanelOpen("infi", true);
  assert.equal(readToolPanelOpen("infi"), true);
});

test("뷰어마다 따로 기억한다 — I-View 를 접어도 T-View 는 그대로", () => {
  writeToolPanelOpen("infi", false);
  assert.equal(readToolPanelOpen("infi"), false);
  assert.equal(readToolPanelOpen("ty"), true, "다른 뷰어까지 접히면 안 된다");
  assert.equal(readToolPanelOpen("saint"), true);
  assert.notEqual(toolPanelKey("infi"), toolPanelKey("ty"));
  assert.notEqual(toolPanelKey("ty"), toolPanelKey("saint"));
});

test("저장된 적이 없으면 펼침 — 기본 동작은 지금까지와 같다", () => {
  assert.equal(readToolPanelOpen("saint"), true);
  assert.equal(readToolPanelOpen("saint", false), false, "폴백을 지정하면 그것을 쓴다");
});

test("localStorage 가 막혀도 던지지 않는다 (시크릿 모드)", () => {
  globalThis.localStorage = fakeStorage(true);
  assert.doesNotThrow(() => writeToolPanelOpen("ty", false));
  assert.equal(readToolPanelOpen("ty"), true, "읽지 못하면 기본값(펼침)");
});

test("localStorage 자체가 없어도 던지지 않는다", () => {
  delete globalThis.localStorage;
  assert.doesNotThrow(() => writeToolPanelOpen("ty", false));
  assert.equal(readToolPanelOpen("ty"), true);
});

test("접어도 다시 펼 띠가 남는다 — RAIL_PX 는 0 일 수 없다", () => {
  assert.ok(RAIL_PX > 0, "0 이면 패널을 되돌릴 방법이 사라진다");
});

test("왼쪽 도킹은 왼쪽으로 감춘다(요구 그대로)", () => {
  const s = railSpec("left");
  assert.equal(s.hideArrow, "◂");
  assert.equal(s.showArrow, "▸");
  assert.equal(s.horizontal, false);
  assert.match(s.hideTitle, /왼쪽/);
});

test("도킹 방향마다 감추는 쪽이 다르다", () => {
  assert.equal(railSpec("right").hideArrow, "▸");
  assert.equal(railSpec("top").hideArrow, "▴");
  assert.equal(railSpec("bottom").hideArrow, "▾");
  assert.equal(railSpec("top").horizontal, true);
  assert.equal(railSpec("bottom").horizontal, true);
});

test("감추기·보이기 화살표는 늘 반대 방향", () => {
  for (const side of ["left", "right", "top", "bottom"]) {
    const s = railSpec(side);
    assert.notEqual(s.hideArrow, s.showArrow, `${side}: 같으면 어느 쪽인지 알 수 없다`);
  }
});

test("띠 스타일 — 세로 띠는 폭만, 가로 띠는 높이만 고정", () => {
  assert.equal(railStyle("left").width, RAIL_PX);
  assert.equal(railStyle("left").height, "100%");
  assert.equal(railStyle("top").height, RAIL_PX);
  assert.equal(railStyle("top").width, "100%");
});

test("모르는 도킹 값이 와도 왼쪽으로 동작한다 (화면이 깨지지 않는다)", () => {
  assert.deepEqual(railSpec("이상한값"), railSpec("left"));
});
