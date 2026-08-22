/* 상용구(STD) 패널 계약(2026-08-22 사용자 지적).
 *
 * 사용자 지적: "T뷰 Worklist 뷰어의 상용구 패널(그림1)에 Setting>판독>단축키(그림2)의 설정이
 *              나타나야 한다." — 설정에는 있는데 패널은 "New로 상용구 등록" 으로 비어 있었다.
 *
 * 원인 셋
 *  ① 패널이 **마운트 때 한 번만** 읽었다. 설정에서 등록해도 워크리스트를 새로 열기 전에는 안 보인다.
 *  ② 패널은 내 계정(api.phrases)만 읽었다. 설정 목록은 **SV70(원 서버) 항목도 함께** 보여 준다.
 *  ③ '맞춤' 이 모달리티 **정확 일치**만 봤다. DR 검사에서 DX/CR 로 등록한 상용구가 통째로 사라진다.
 *
 * 실행: node --test frontend/tests/std_panel_rule.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const w = readFileSync(join(ROOT, "src/pages/Worklist.tsx"), "utf8");
const panel = (() => {
  const i = w.indexOf("function PhrasePanel");
  assert.ok(i > 0, "상용구 패널을 찾지 못했다");
  return w.slice(i, i + 3200);
})();

test("① 설정에서 등록하면 패널도 곧바로 따라간다", () => {
  assert.match(panel, /window\.addEventListener\("sv-settings-saved", load\)/,
    "이 저장소가 이미 쓰는 설정 저장 신호를 구독해야 한다");
  assert.match(panel, /removeEventListener\("sv-settings-saved", load\)/, "정리도 함께");
});

test("② 내 계정 + SV70 을 함께 보여 준다 — 설정 목록과 같은 구성", () => {
  assert.match(panel, /api\.phrases\(\), api\.livePhraseRows\(\)/);
  assert.match(panel, /Promise\.allSettled/,
    "한쪽이 실패해도 나머지는 보여야 한다(SV70 미연결에서 패널이 통째로 비면 안 된다)");
  assert.match(panel, /seen\.has\(key\(p\)\)/, "같은 항목은 내 계정 사본이 원본을 가린다");
});

test("③ '맞춤' 은 같은 계열까지 인정한다 — DR 검사에서 DX/CR 상용구가 사라지지 않게", () => {
  assert.match(panel, /sameFamily\(p\.modality, current\.modality\)/);
  assert.ok(!/p\.modality === current\.modality/.test(panel),
    "정확 일치만 보면 장비·병원마다 다른 표기에서 목록이 빈다");
  // 판정 규칙은 lib 한 곳(뷰어·설정·패널이 각자 들면 갈린다)
  assert.match(w, /import \{ sameFamily \} from "\.\.\/lib\/phraseGroups"/);
});

test("템플릿은 상용구 목록에 섞이지 않는다", () => {
  assert.match(panel, /p\.kind !== "template"/,
    "템플릿은 리포트 전체를 갈아 끼우는 것이라 상용구와 성격이 다르다");
  assert.match(panel, /p\.shortcut && p\.kind !== "template"/,
    "Alt 단축키 매핑에도 템플릿이 들어가면 안 된다");
});
