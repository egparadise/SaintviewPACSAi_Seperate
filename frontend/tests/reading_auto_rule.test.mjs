/* 판독 자동화 규칙 + 판독창 설정 진입 계약(2026-08-20 사용자 확정).
 *
 * 사용자 요구:
 *  ① "판독창의 그림 영역에 Setting 아이콘을 만들고, 누르면 바로 Setting 의 판독 단축키 부분이
 *     바로 열릴 수 있도록."
 *  ② "'Setting - 판독 - 기본 설정'에 '자동화 규칙' 부분을 만들고
 *       1. Save 버튼을 누르면 바로 다음 Study 열기
 *       2. Save 버튼을 누르면 바로 이전 Study 열기
 *       3. Save : 이후 동작 없음"
 *
 * 실행: node --test --experimental-strip-types frontend/tests/reading_auto_rule.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AUTO_AFTER_SAVE_DEFAULT, AUTO_AFTER_SAVE_ITEMS, navAfterSave, readAutoAfterSave,
} from "../src/lib/readingAuto.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");

test("세 선택지 — 다음 / 이전 / 이후 동작 없음", () => {
  assert.deepEqual(AUTO_AFTER_SAVE_ITEMS.map((i) => i.value), ["next", "prev", "none"]);
  assert.equal(AUTO_AFTER_SAVE_DEFAULT, "none", "기본은 아무 일도 하지 않는다");
  // 사용자가 쓴 문장을 그대로 옮겼는가
  assert.equal(AUTO_AFTER_SAVE_ITEMS[0].label, "Save 버튼을 누르면 바로 다음 Study 열기");
  assert.equal(AUTO_AFTER_SAVE_ITEMS[1].label, "Save 버튼을 누르면 바로 이전 Study 열기");
  assert.equal(AUTO_AFTER_SAVE_ITEMS[2].label, "Save : 이후 동작 없음");
});

test("이동 방향 — 다음은 ▶(1), 이전은 ◀(-1)", () => {
  assert.equal(navAfterSave("next", true), 1);
  assert.equal(navAfterSave("prev", true), -1);
  assert.equal(navAfterSave("none", true), null);
});

test("저장에 실패하면 움직이지 않는다 — 판독문을 잃지 않기 위해", () => {
  assert.equal(navAfterSave("next", false), null);
  assert.equal(navAfterSave("prev", false), null);
});

test("저장값이 깨져 있어도 기본으로 — 모르는 값에 화면이 멋대로 넘어가면 안 된다", () => {
  assert.equal(readAutoAfterSave(undefined), "none");
  assert.equal(readAutoAfterSave(null), "none");
  assert.equal(readAutoAfterSave("nope"), "none");
  assert.equal(readAutoAfterSave(1), "none");
  assert.equal(readAutoAfterSave("next"), "next");
  assert.equal(readAutoAfterSave("prev"), "prev");
});

test("① 판독창 톱니 — 판독 > 단축키 설정이 곧바로 열린다", () => {
  const r = src("src/pages/ReportWindow.tsx");
  assert.match(r, /onClick=\{\(\) => setSetOpen\(true\)\}/, "헤더에 설정 버튼");
  assert.match(r, /initialPage="reading" initialRdTab="shortcut"/,
    "누르면 판독 페이지의 단축키 설정 탭이 바로 열려야 한다(찾아 들어가게 하지 않는다)");
  assert.match(r, /lazy\(\(\) => import\("\.\/SettingsModal"\)/,
    "설정 모듈은 무겁다 — 누를 때만 불러온다");
  // 닫을 때 이 창에도 반영(단축키·자동화 규칙을 바꿔 놓고 창을 다시 열게 하지 않는다)
  assert.match(r, /setSetOpen\(false\);[\s\S]{0,220}getSetting\("report\.prefs"\)/);
});

test("① 설정 모달이 지정된 항목을 받아들인다 — 없는 페이지면 무시", () => {
  const s = src("src/pages/SettingsModal.tsx");
  assert.match(s, /initialPage\?: string;/);
  assert.match(s, /initialRdTab\?: "basic" \| "shortcut" \| "template";/);
  assert.match(s, /\(initialPage && visibleTabs\.some\(\(t\) => t\.key === initialPage\)\)/,
    "이 스코프에서 안 보이는 페이지로 열면 빈 화면이 된다");
  assert.match(s, /useState<"basic" \| "shortcut" \| "template">\(initialRdTab \?\? "basic"\)/);
});

test("② 자동화 규칙 — 판독 > 기본 설정에 라디오 3개", () => {
  const s = src("src/pages/SettingsModal.tsx");
  const i = s.indexOf('<Group title={tr("자동화 규칙")}>');
  assert.ok(i > 0, "'자동화 규칙' 그룹이 있어야 한다");
  const g = s.slice(i, i + 1200);
  assert.match(g, /type="radio"/, "셋 중 하나만 — 체크박스면 '다음도 이전도'가 만들어진다");
  assert.match(g, /AUTO_AFTER_SAVE_ITEMS\.map/, "항목 목록은 lib 한 곳에서 온다");
  // 기본 설정 탭 안에 있어야 한다(단축키·템플릿 탭이 아니라)
  const basic = s.indexOf('{rdTab === "basic" && (');
  assert.ok(basic > 0 && basic < i, "자동화 규칙은 '기본 설정' 탭 안이다");
  assert.match(s, /auto_after_save: autoSave/, "report.prefs 에 저장");
  assert.match(s, /readAutoAfterSave\(\(v as \{ auto_after_save\?: unknown \}\)\.auto_after_save\)/, "로드");
});

test("② Save 성공 뒤에만 이동한다 — 실패 경로(catch)에서는 부르지 않는다", () => {
  const r = src("src/pages/ReportWindow.tsx");
  const i = r.indexOf("const save = async () => {");
  assert.ok(i > 0);
  const body = r.slice(i, r.indexOf("const approve = async ()", i));
  const call = body.indexOf("navAfterSave(");
  const katch = body.indexOf("} catch (e) {");
  assert.ok(call > 0, "저장 경로에 자동화 규칙이 걸려 있어야 한다");
  assert.ok(call < katch, "try 안(성공 지점)에서 불러야 한다 — 실패했는데 넘어가면 판독문을 잃는다");
  assert.match(body, /readAutoAfterSave\(rdOpts\.auto_after_save\)/, "설정값을 읽는다");
});

test("기존 '확정 후 다음' 과 충돌하지 않는다 — 다른 버튼이다", () => {
  const r = src("src/pages/ReportWindow.tsx");
  const s = src("src/pages/SettingsModal.tsx");
  const ap = r.indexOf("const approve = async ()");
  assert.match(r.slice(ap, ap + 1600), /rdOpts\.open_next_after_save/,
    "open_next_after_save 는 확정(Approve) 뒤 동작으로 남는다");
  assert.match(s, /확정\(Approve\) 후 다음 레포트 열기/,
    "라벨도 '저장(확정)'이 아니라 확정 전용임을 밝힌다(같은 버튼으로 오해하지 않게)");
});

/* ── 2026-08-22 전수 점검 — Save 버튼이 있는 화면이 셋이다 ────────────────────
 * 판독창 / 워크리스트 REPORT 패널 / 뷰어 도크. 셋의 Save 가 달리 굴면 사용자는 **어느 화면에서
 * 저장했는지에 따라 다른 결과**를 겪는다. 실제로 도크만 규칙이 빠져 있었다(이 점검에서 발견). */

test("★ Save 가 있는 모든 화면이 같은 저장 규칙을 쓴다", () => {
  const SCREENS = {
    "판독창(ReportWindow)": "src/pages/ReportWindow.tsx",
    "워크리스트 REPORT 패널": "src/pages/Worklist.tsx",
    "뷰어 도크(ReportDock)": "src/components/ReportDock.tsx",
  };
  for (const [label, f] of Object.entries(SCREENS)) {
    const t = src(f);
    assert.match(t, /navAfterSave\(/, `${label}: 저장 뒤 동작이 걸려 있어야 한다`);
    assert.match(t, /readAutoAfterSave\(/, `${label}: 같은 설정 키(report.prefs.auto_after_save)`);
    assert.match(t, /from "\.\.\/lib\/readingAuto"/, `${label}: 판정은 lib 한 곳`);
  }
});

test("도크는 검사 전환을 뷰어에서 받는다 — ◀▶ 는 과거검사 로드라 다른 기능이다", () => {
  const d = src("src/components/ReportDock.tsx");
  assert.match(d, /onNav\?: \(dir: 1 \| -1\) => void;/, "상위에서 받는 prop");
  assert.match(d, /if \(dir && onNav\) onNav\(dir\)/);
  // 뷰어가 실제로 연결했는가 — prop 만 만들고 안 넘기면 조용히 아무 일도 안 한다
  const v = src("src/pages/Viewer2D.tsx");
  assert.match(v, /onNav=\{\(d\) => void navPatient\(d\)\}/,
    "prop 을 만들어 두고 넘기지 않으면 도크 저장만 조용히 멈춘다");
});

