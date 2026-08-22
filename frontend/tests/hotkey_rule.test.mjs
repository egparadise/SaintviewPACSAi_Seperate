/* 단축키 조합 계약(2026-08-22 사용자 확정).
 *
 * 사용자 요구:
 *   "판독-단축키 설정은 Alt, Control, 숫자, 알파벳, Alt+알파벳(혹은 숫자), Control+알파벳(혹은 숫자),
 *    Alt+Shift+알파벳(혹은 숫자), Control+Shift+알파벳(혹은 숫자) — **모든 조합이 가능**하도록."
 *
 * 그전에는 상용구 단축키가 **Alt 고정**이었다(저장값이 글자 하나, 화면은 `Alt+X` 로 하드코딩).
 *
 * 실행: node --test --experimental-strip-types frontend/tests/hotkey_rule.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  comboLabel, comboOf, findConflict, hasModifier, isModifierKey, isValidCombo, matchesCombo,
  normalizeCombo, storeCombo, targetIsTyping,
} from "../src/lib/hotkey.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");
const ev = (key, mods = {}) => ({ key, ...mods });

test("사용자가 요구한 조합이 전부 표현된다", () => {
  assert.equal(comboOf(ev("d", { altKey: true })), "Alt+D");
  assert.equal(comboOf(ev("1", { ctrlKey: true })), "Ctrl+1");
  assert.equal(comboOf(ev("a")), "A", "알파벳 단독");
  assert.equal(comboOf(ev("7")), "7", "숫자 단독");
  assert.equal(comboOf(ev("d", { altKey: true, shiftKey: true })), "Shift+Alt+D");
  assert.equal(comboOf(ev("2", { ctrlKey: true, shiftKey: true })), "Ctrl+Shift+2");
});

test("표기 순서는 Ctrl+Shift+Alt+KEY 로 고정 — 같은 조합이 두 문자열이 되면 안 된다", () => {
  assert.equal(normalizeCombo("alt+shift+d"), "Shift+Alt+D");
  assert.equal(normalizeCombo("Shift+Alt+D"), "Shift+Alt+D");
  assert.equal(normalizeCombo("D+Alt+Shift"), "Shift+Alt+D", "적는 순서가 달라도 같은 값");
  assert.equal(normalizeCombo("control+1"), "Ctrl+1", "Control 도 Ctrl 로");
});

test("★ 구 저장값(글자 하나)은 Alt+X 로 읽는다 — 쓰던 단축키가 그대로 동작해야 한다", () => {
  assert.equal(normalizeCombo("D"), "Alt+D");
  assert.equal(normalizeCombo("d"), "Alt+D");
  assert.equal(normalizeCombo("1"), "Alt+1");
  assert.equal(comboLabel("D"), "Alt+D", "화면 표기도 같은 규칙");
  // 실제 매칭도 통해야 한다
  assert.equal(matchesCombo(ev("d", { altKey: true }), "D"), true);
});

test("수식어만 있거나 빈 값은 조합이 아니다", () => {
  assert.equal(normalizeCombo(""), "");
  assert.equal(normalizeCombo(null), "");
  assert.equal(normalizeCombo("Alt"), "", "수식어만으로는 등록할 수 없다");
  assert.equal(normalizeCombo("Ctrl+Shift"), "");
  assert.equal(isValidCombo("Alt+"), false);
  assert.equal(isValidCombo("Alt+D"), true);
});

test("등록 중 수식어 키 자체는 무시한다 — 아직 확정이 아니다", () => {
  for (const k of ["Control", "Shift", "Alt", "Meta"]) assert.equal(isModifierKey(k), true);
  assert.equal(isModifierKey("d"), false);
  assert.equal(matchesCombo(ev("Alt", { altKey: true }), "Alt+D"), false);
});

test("★ 수식어 없는 단독 키는 **글자를 치는 중에는** 발동하지 않는다", () => {
  const typing = { tagName: "TEXTAREA" };
  const notTyping = { tagName: "DIV" };
  // 단독 키의 **저장 형식**은 'Key+A' 다 — 글자 하나로 저장하면 구값(Alt+A)과 구분되지 않는다
  const bare = storeCombo("A");
  assert.equal(bare, "Key+A");
  assert.equal(comboLabel(bare), "A", "화면에는 접두사가 보이지 않는다");
  assert.equal(hasModifier(bare), false);
  assert.equal(matchesCombo(ev("a"), bare, notTyping), true, "목록에서는 동작");
  assert.equal(matchesCombo(ev("a"), bare, typing), false,
    "판독문을 쓰는 중에 글자마다 상용구가 끼어들면 안 된다");
  // 수식어가 있으면 입력 중에도 동작한다(Alt+D 로 삽입하는 것이 본래 쓰임)
  assert.equal(matchesCombo(ev("d", { altKey: true }), "Alt+D", typing), true);
  assert.equal(targetIsTyping({ isContentEditable: true }), true);
  assert.equal(targetIsTyping({ tagName: "INPUT" }), true);
  assert.equal(targetIsTyping(null), false);
});

test("다른 조합은 서로 발동하지 않는다", () => {
  assert.equal(matchesCombo(ev("d", { altKey: true }), "Ctrl+D"), false);
  assert.equal(matchesCombo(ev("d", { altKey: true, shiftKey: true }), "Alt+D"), false,
    "Shift 가 더 눌렸으면 다른 조합이다");
  assert.equal(matchesCombo(ev("d", { ctrlKey: true }), "Ctrl+D"), true);
});

test("중복 검사 — 같은 조합이 이미 있으면 알려 준다(자기 자신은 제외)", () => {
  const list = [{ id: 1, name: "A", shortcut: "D" }, { id: 2, name: "B", shortcut: "Ctrl+1" }];
  assert.equal(findConflict(list, "Alt+D")?.id, 1, "구 저장값과도 비교된다");
  assert.equal(findConflict(list, "Ctrl+1")?.id, 2);
  assert.equal(findConflict(list, "Ctrl+1", 2), null, "수정 중인 자기 자신은 충돌이 아니다");
  assert.equal(findConflict(list, "Alt+Z"), null);
  assert.equal(findConflict(list, ""), null);
});

test("배선 — Alt 하드코딩이 사라지고 세 화면이 같은 판정을 쓴다", () => {
  const files = {
    "Worklist(상용구 패널·루트 핸들러)": "src/pages/Worklist.tsx",
    "ReportDock(판독 도크)": "src/components/ReportDock.tsx",
    "ReportWindow(판독창)": "src/pages/ReportWindow.tsx",
  };
  for (const [label, f] of Object.entries(files)) {
    const s = src(f);
    assert.match(s, /matchesCombo\(/, `${label}: 판정은 lib/hotkey 로`);
    assert.ok(!/Alt\+\{p\.shortcut\}/.test(s), `${label}: 화면 표기의 Alt 하드코딩이 남아 있다`);
    assert.ok(!/e\.altKey && !e\.ctrlKey && e\.key\.length === 1/.test(s),
      `${label}: Alt 고정 분기가 남아 있다`);
  }
  // 설정 화면 — 조합을 눌러 등록
  const st = src("src/pages/SettingsModal.tsx");
  assert.match(st, /const combo = comboOf\(e\);/, "누른 조합을 그대로 받는다");
  assert.match(st, /findConflict\(list, f\.shortcut, sel\?\.id\)/, "중복을 알려 준다");
  assert.ok(!/단축키 코드 \(Alt\+키\)/.test(st), "'Alt+키' 라는 옛 안내가 남아 있으면 안 된다");
});

test("저장 형식 — 수식어가 있으면 그대로, 없으면 Key+ 를 붙인다", () => {
  assert.equal(storeCombo("Alt+D"), "Alt+D");
  assert.equal(storeCombo("Ctrl+Shift+2"), "Ctrl+Shift+2");
  assert.equal(storeCombo("A"), "Key+A", "구값(글자 하나 = Alt+A)과 구분되어야 한다");
  assert.equal(storeCombo("7"), "Key+7");
  assert.equal(storeCombo(""), "");
  // 왕복 — 저장했다 읽으면 화면에 쓰던 그 조합이 그대로 나온다
  for (const c of ["Alt+D", "Ctrl+1", "Shift+Alt+D", "A", "7"]) {
    assert.equal(comboLabel(storeCombo(c)), c, `왕복 실패: ${c}`);
  }
});

test("구값과 새 단독 키가 서로 섞이지 않는다", () => {
  assert.equal(comboLabel("A"), "Alt+A", "구 저장값");
  assert.equal(comboLabel("Key+A"), "A", "새 단독 키");
  assert.equal(matchesCombo(ev("a", { altKey: true }), "A"), true);
  assert.equal(matchesCombo(ev("a"), "A", null), false, "구값은 Alt 없이 발동하지 않는다");
  assert.equal(matchesCombo(ev("a"), "Key+A", null), true);
});
