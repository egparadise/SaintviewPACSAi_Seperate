/* 모듈 초기화 순서 계약 — "검은 화면" 사고 방어(2026-08-20).
 *
 * 실제 사고: Worklist.tsx 에서 모듈 최상위 상수(DEFAULT_SVINFI_PANELS)가
 *   `...defaultSearchUi()` 를 부르는데, 그 함수가 읽는 SEARCH_UI_KEYS 는 **아래쪽**에
 *   선언돼 있었다. 표준 JS 라면 TDZ ReferenceError 지만 번들에서는 undefined 로 접혀
 *   "Cannot read properties of undefined (reading 'map')" 가 되고 **앱 전체가 검은 화면**이 됐다.
 *
 * 무서운 점: `tsc -b` 무오류 · vite build 성공 · node/pytest 전부 통과였다.
 *   타입 검사도 번들러도 이걸 못 잡는다 — 순서 자체를 테스트로 고정해야 한다.
 *
 * 여기서는 **모듈 최상위에서 즉시 실행되는 헬퍼**가 자기보다 뒤에 선언된 const 를
 * 읽지 않는지 확인한다.
 *
 * 실행: node --test frontend/tests/module_init_order.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");

/** 소스에서 어떤 패턴이 처음 나타나는 문자 위치(없으면 -1). */
const at = (s, re) => { const m = re.exec(s); return m ? m.index : -1; };

test("Worklist — SEARCH_UI_KEYS 는 defaultSearchUi() 첫 호출보다 먼저 선언된다", () => {
  const w = src("src/pages/Worklist.tsx");
  const decl = at(w, /export const SEARCH_UI_KEYS = \[/);
  const fn = at(w, /^function defaultSearchUi\(\)/m);
  const use = at(w, /\.\.\.defaultSearchUi\(\)/);
  assert.ok(decl > 0 && fn > 0 && use > 0, "세 지점을 모두 찾아야 한다");
  assert.ok(decl < use,
    "SEARCH_UI_KEYS 선언이 첫 사용보다 뒤면 번들에서 undefined 가 된다 → 앱 전체 검은 화면");
  assert.ok(fn < use, "defaultSearchUi 정의도 첫 호출보다 앞이어야 한다(호이스팅에 기대지 않는다)");
});

test("Worklist — 모듈 최상위에서 즉시 부르는 헬퍼들이 뒤늦게 선언된 const 를 읽지 않는다", () => {
  const w = src("src/pages/Worklist.tsx");
  // 모듈 최상위 객체 리터럴에서 펼치는 헬퍼 호출 전부를 훑는다
  const spreads = [...w.matchAll(/\.\.\.(\w+)\(\)/g)].map((m) => ({ name: m[1], at: m.index }));
  assert.ok(spreads.length > 0, "검사 대상을 찾지 못했다(패턴이 바뀌었으면 이 테스트를 갱신하라)");
  for (const { name, at: useAt } of spreads) {
    const defAt = at2(w, new RegExp(`^(?:export )?(?:function ${name}\\(|const ${name}\\s*=)`, "m"));
    if (defAt < 0) continue;              // 다른 모듈에서 가져온 헬퍼 — 여기서 볼 수 없다
    // 그 헬퍼 본문이 참조하는 모듈 상수들이 사용 지점보다 앞에 선언됐는지
    const body = w.slice(defAt, defAt + 400);
    for (const id of new Set([...body.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)].map((m) => m[1]))) {
      const idDecl = at2(w, new RegExp(`^(?:export )?const ${id}\\b`, "m"));
      if (idDecl < 0) continue;           // 임포트한 상수
      assert.ok(idDecl < useAt,
        `${name}() 이 모듈 최상위(${useAt})에서 불리는데 ${id} 선언은 ${idDecl} — 뒤에 있으면 undefined 다`);
    }
  }
});

function at2(s, re) { const m = re.exec(s); return m ? m.index : -1; }

test("빌드 산출물이 앱 셸을 실제로 그리는지 — index.html 이 최신 번들을 가리킨다", () => {
  // dist 가 없으면(빌드 전) 건너뛴다 — CI/로컬 어느 쪽에서도 실패로 만들지 않는다
  let html;
  try { html = src("dist/index.html"); } catch { return; }
  const m = /src="\/assets\/(index-[\w-]+\.js)"/.exec(html);
  assert.ok(m, "index.html 이 엔트리 번들을 가리켜야 한다");
  const bundle = src(`dist/assets/${m[1]}`);
  assert.ok(bundle.length > 1000, "엔트리 번들이 비어 있다");
});
