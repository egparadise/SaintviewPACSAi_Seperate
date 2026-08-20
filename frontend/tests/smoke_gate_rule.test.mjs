/* 앱 셸 스모크 게이트 계약(2026-08-20 신설).
 *
 * 배경: 2026-08-20 에 앱 전체가 검은 화면으로 배포됐다(모듈 최상위 TDZ). 그때
 *       tsc -b · vite build · node 테스트 · pytest 가 **전부 초록**이었다 —
 *       넷 다 "코드가 말이 되는가"만 보고 "앱이 실제로 그려지는가"는 아무도 안 봤다.
 *
 * 이 파일은 그 구멍을 메운 게이트가 **제자리에 붙어 있는지** 지킨다.
 * (게이트 자체의 동작은 일부러 TDZ 를 심은 빌드로 확인했다 — 실제 사고와 같은 메시지
 *  `Cannot read properties of undefined (reading 'map')` 로 실패하는 것을 보았다.)
 *
 * 실행: node --test frontend/tests/smoke_gate_rule.test.mjs
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(ROOT, "..");
const smoke = readFileSync(join(ROOT, "tools/smoke_shell.mjs"), "utf8");
const dist = readFileSync(join(REPO, "deploy/make_dist.py"), "utf8");

test("스모크 스크립트가 존재하고 새 의존성을 요구하지 않는다", () => {
  assert.ok(existsSync(join(ROOT, "tools/smoke_shell.mjs")));
  // node 내장만 쓴다 — 헤드리스 브라우저를 devDependency 로 들이면 설치·배포가 무거워진다
  for (const m of [...smoke.matchAll(/from "([^"]+)"/g)].map((m) => m[1])) {
    assert.match(m, /^node:/, `내장 모듈만 써야 한다 — ${m}`);
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  for (const bad of ["playwright", "puppeteer", "jsdom", "@playwright/test"]) {
    assert.ok(!pkg.devDependencies?.[bad] && !pkg.dependencies?.[bad],
      `${bad} 없이 동작해야 한다`);
  }
});

test("모듈 초기화까지 실제로 '평가'한다 — 텍스트 검사가 아니다", () => {
  assert.match(smoke, /vm\.SourceTextModule/, "번들을 실제로 실행한다");
  assert.match(smoke, /root\.link\(/, "청크를 이어 붙인다");
  assert.match(smoke, /await root\.evaluate\(\)/);
});

test("합격선은 createRoot 도달 — 렌더까지 흉내 내지 않는다", () => {
  assert.match(smoke, /const reachedRender = /);
  assert.match(smoke, /Minified React error #\(299\|200\)/,
    "container 가 DOM 이 아니라는 오류 = 모든 모듈 초기화 통과 지점");
  // 통과/실패가 종료 코드로 갈린다(포장 스크립트가 이 값으로 막는다)
  assert.match(smoke, /process\.exit\(0\)/);
  assert.match(smoke, /process\.exit\(1\)/);
  assert.match(smoke, /process\.exit\(2\)/, "번들을 못 찾은 것과 초기화 실패를 구분한다");
});

test("실패하면 포장을 막는다 — 배포로 새어 나가지 않게", () => {
  assert.match(dist, /def smoke_shell_ok\(\) -> bool:/);
  assert.match(dist, /if not smoke_shell_ok\(\):\s*\n\s*return 1/,
    "스모크가 실패하면 make_dist 가 그 자리에서 멈춰야 한다");
  assert.match(dist, /--experimental-vm-modules/);
  // node 가 없거나 번들을 못 찾는 등 '판정 불가'는 막지 않는다(반출본 재실행 등)
  assert.match(dist, /FileNotFoundError/, "node 없는 환경에서는 건너뛴다");
  assert.match(dist, /returncode == 2/, "번들 미발견은 실패로 취급하지 않는다");
  assert.match(dist, /TimeoutExpired/, "무한정 기다리지 않는다");
});

test("왜 필요한지가 코드에 적혀 있다 — 다음 사람이 지우지 않도록", () => {
  assert.match(smoke, /검은 화면/);
  assert.match(smoke, /TDZ/);
  assert.match(smoke, /게이트 넷이 전부 초록/, "무엇이 이 게이트를 만들었는지");
  assert.match(dist, /검은 화면/);
});
