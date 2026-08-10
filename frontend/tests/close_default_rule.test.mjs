/* 뷰어 닫기 '기본으로' 기억 + WORKLIST 전면(2026-08-10 사용자 확정) — 소스 계약.
 *
 * 증상의 뿌리: "기본으로"를 체크해도 매번 다이얼로그가 다시 떴다.
 *   · Viewer2D — close_mode 저장이 fire-and-forget 이라, 곧 닫히는 창과 함께 PUT 이 중단됐다.
 *   · I-View  — persistPrefs 가 600ms 디바운스라, 창이 닫히면 타이머가 영영 돌지 않았다.
 * → 두 뷰어 모두 닫기 확정(doClose) 안에서 **await 로 저장을 끝낸 뒤** 창을 닫는다.
 *
 * WORKLIST 전면: 창이 닫히는 모든 출구에서 워크리스트 창을 최전면으로 —
 * 구현은 lib/worklistFocus.focusWorklistWindow **한 곳**(뷰어별 복사 금지).
 *
 * 실행: node --test frontend/tests/close_default_rule.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");

test("Viewer2D — '기본으로' 저장은 창이 닫히기 전에 await 로 끝낸다", () => {
  const s = src("src/pages/Viewer2D.tsx");
  const m = s.match(/if \(remember\) \{[\s\S]{0,900}?\}\r?\n/);
  assert.ok(m, "doClose 의 remember 블록");
  assert.match(m[0], /await api\.getSetting\("viewer\.prefs"\)/, "RMW 읽기를 기다린다");
  assert.match(m[0], /await api\.putSetting\("viewer\.prefs", \{ \.\.\.r\.value, close_mode: mode \}/,
               "close_mode 쓰기를 기다린다 — fire-and-forget 은 닫히는 창과 함께 중단된다");
});

test("I-View — infi_close_mode 저장은 디바운스(persistPrefs) 금지, 즉시 RMW + await", () => {
  const s = src("src/pages/ViewerInfi.tsx");
  const m = s.match(/if \(remember && mode !== "ask"\) \{[\s\S]{0,900}?\}\r?\n/);
  assert.ok(m, "doCloseAction 의 remember 블록");
  assert.ok(!m[0].includes("persistPrefs({"), "600ms 디바운스 호출은 창이 닫히면 영영 안 돈다");
  assert.match(m[0], /await api\.putSetting\("viewer\.prefs", \{ \.\.\.r\.value, infi_close_mode: mode \}/);
});

test("설정>뷰어(공통) — '뷰어 닫기 설정': 저장 상태 표시 + 체크 해제 = 다이얼로그 복귀", () => {
  const s = src("src/pages/SettingsModal.tsx");
  assert.ok(s.includes('tr("뷰어 닫기 설정")'), "요청된 항목 이름");
  assert.match(s, /checked=\{closeMode !== "ask"\}/, "체크 상태 = 기본 동작 저장됨");
  assert.match(s, /e\.target\.checked \? "save_current" : "ask"/,
               "체크 해제 → ask → 닫기 다이얼로그가 다시 나타난다");
  assert.ok(s.includes("close_mode: closeMode"), "save() 가 계정(user 스코프)으로 저장");
});

test("WORKLIST 전면 — 구현은 lib/worklistFocus 한 곳, 세 뷰어가 같은 헬퍼를 탄다", () => {
  const lib = src("src/lib/worklistFocus.ts");
  assert.match(lib, /window\.open\("", "sv_worklist"\)/, "named window 재-open 이 그 창을 raise");
  assert.match(lib, /window\.opener[\s\S]{0,80}focus\(\)/, "opener 폴백");

  const wl = src("src/pages/Worklist.tsx");
  assert.match(wl, /window\.name = "sv_worklist"/, "워크리스트 창이 자기 이름을 등록해야 raise 가 성립");

  const v2 = src("src/pages/Viewer2D.tsx");
  assert.match(v2, /focusWorklistWindow\(\);\r?\n\s*onClose\(\);/, "닫기 확정(doClose) 후 워크리스트 전면");
  assert.ok(!v2.includes('window.open("", "sv_worklist")'), "뷰어에 구현 복사 금지(한 곳 규율)");

  const vi = src("src/pages/ViewerInfi.tsx");
  assert.match(vi, /const gotoWorklist = \(\) => focusWorklistWindow\(\);/, "I-View 도 같은 헬퍼 위임");
  assert.ok(!vi.includes('window.open("", "sv_worklist")'), "뷰어에 구현 복사 금지(한 곳 규율)");
});
