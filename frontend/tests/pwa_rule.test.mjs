/* 전체 화면 + PWA 설치(2026-08-10 사용자 확정) — 소스 계약.
 *
 *  · 헤더 로그아웃 오른쪽 ⛶ = Fullscreen API 토글(브라우저 UI 없이, Esc 복귀).
 *  · 워크리스트 하단 상태바(시계 왼쪽) Download = 크롬 '페이지를 앱으로 설치'와 동일 —
 *    manifest.webmanifest(standalone·아이콘 192/512) + beforeinstallprompt 캡처.
 *    미지원/이미 설치면 브라우저 메뉴 안내로 폴백(조용히 실패 금지).
 *
 * 실행: node --test frontend/tests/pwa_rule.test.mjs
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");

test("manifest — standalone·시작 경로·아이콘 192/512 이 실제 파일로 존재", () => {
  const m = JSON.parse(src("public/manifest.webmanifest"));
  assert.equal(m.display, "standalone", "브라우저 탭 없는 독립 창");
  assert.equal(m.start_url, "/");
  const sizes = m.icons.map((i) => i.sizes);
  assert.ok(sizes.includes("192x192") && sizes.includes("512x512"), "크롬 설치 최소 요건");
  for (const i of m.icons) {
    const p = join(ROOT, "public", i.src.replace(/^\//, ""));
    assert.ok(existsSync(p) && statSync(p).size > 0, `${i.src} 아이콘 실파일`);
  }
  const html = src("index.html");
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/, "index.html 링크");
  assert.match(html, /name="theme-color"/);
});

test("pwa.ts — beforeinstallprompt 를 부팅 시 캡처하고, 설치 결과를 구분해 돌려준다", () => {
  const s = src("src/lib/pwa.ts");
  assert.match(s, /addEventListener\("beforeinstallprompt"/, "설치 이벤트 캡처");
  assert.match(s, /e\.preventDefault\(\)/, "기본 미니 인포바 억제 — 버튼 시점에 프롬프트");
  assert.match(s, /"accepted" \| "dismissed" \| "installed" \| "unavailable"/, "결과 4분류");
  assert.match(s, /display-mode: standalone/, "이미 앱 창인지 판정");
  assert.match(s, /requestFullscreen/, "전체 화면 토글");
  const main = src("src/main.tsx");
  assert.match(main, /initPwa\(\)/, "부팅 직후 1회 — 늦게 등록하면 이벤트를 놓친다");
});

test("헤더 ⛶ — 로그아웃 오른쪽 전체 화면 토글, fullscreenchange 구독", () => {
  const s = src("src/App.tsx");
  assert.match(s, /\{tr\("logout"\)\}<\/button>\s*\{\/\*[\s\S]{0,200}\*\/\}\s*<FullscreenBtn \/>/,
               "로그아웃 바로 오른쪽");
  assert.match(s, /fullscreenchange/, "F11·Esc 등 외부 변화에도 아이콘 동기");
  assert.match(s, /toggleFullscreen/, "구현은 lib/pwa 한 곳");
});

test("워크리스트 하단 Download — 시계 왼쪽, installApp 결과별 안내(조용한 실패 금지)", () => {
  const s = src("src/pages/Worklist.tsx");
  const m = s.match(/⬇ Download[\s\S]{0,80}<\/button>\s*<span>\{new Date\(\)/);
  assert.ok(m, "Download 버튼이 시계 바로 왼쪽에 있다");
  assert.match(s, /await installApp\(\)/, "PWA 설치 트리거");
  for (const key of ["앱으로 설치했습니다", "이미 앱으로 설치되어", "설치를 취소했습니다", "페이지를 앱으로 설치'를 이용하세요"])
    assert.ok(s.includes(key), `결과 안내: ${key}`);
});
