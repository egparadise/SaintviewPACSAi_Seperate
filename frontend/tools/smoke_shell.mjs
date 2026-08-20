#!/usr/bin/env node
/* 앱 셸 스모크 게이트 — 빌드 산출물이 **실제로 초기화되는가**(2026-08-20).
 *
 * 왜 필요한가
 * ───────────
 * 2026-08-20 에 앱 전체가 검은 화면으로 배포됐다. 원인은 모듈 최상위 초기화 순서(TDZ):
 * 아직 초기화 전인 const 를 함수 너머로 읽어 번들에서 `undefined.map` 이 됐고, 최상위 렌더가
 * 통째로 죽었다. 그런데 **게이트 넷이 전부 초록이었다** —
 *   · tsc -b       : 함수 본문 안의 참조는 실행 시점을 모르므로 TDZ 를 진단하지 않는다
 *   · vite build   : 문법·타입이 아니라 실행 순서 문제라 번들링은 성공한다
 *   · node 테스트  : 이 저장소의 UI 테스트는 소스를 텍스트로 검사한다(실행하지 않는다)
 *   · pytest       : 백엔드 무관
 * 전부 "코드가 말이 되는가"만 보고 "앱이 실제로 그려지는가"는 아무도 안 봤다.
 *
 * 무엇을 하는가
 * ─────────────
 * dist 번들을 node:vm 에서 **모듈 초기화까지** 실제로 평가한다. 브라우저·헤드리스 의존성 없이
 * (새 devDependency 0) 사고와 같은 종류의 오류를 잡는다.
 *
 * 합격선은 **createRoot 도달**이다. main 이 `createRoot(document.getElementById("root"))` 를
 * 부르는 순간 React 가 "container 가 DOM 이 아니다"(#299)로 멈추는데, 거기까지 왔다는 것은
 * **앱의 모든 모듈이 무사히 초기화됐다**는 뜻이다. 그 뒤(실제 렌더)는 진짜 DOM 이 필요하므로
 * 흉내 내지 않는다 — 흉내 내려 들면 셰임을 끝없이 채우다 오탐만 는다.
 *
 * 검증됨: 일부러 TDZ 를 심어 빌드하면 실제 사고와 같은 메시지
 *   `Cannot read properties of undefined (reading 'map')`
 * 로 실패한다(2026-08-20 확인). 방어가 작동함을 확인하지 않은 게이트는 게이트가 아니다.
 *
 * 사용:  node --experimental-vm-modules frontend/tools/smoke_shell.mjs [dist/assets]
 * 종료:  0=통과 · 1=초기화 실패(배포 금지) · 2=번들을 못 찾음
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const DIR = process.argv[2] ?? "dist/assets";

let entry;
try {
  entry = readdirSync(DIR).find((n) => /^index-.*\.js$/.test(n));
} catch {
  console.error(`[smoke] 번들 디렉터리를 찾지 못했습니다: ${DIR} — 먼저 vite build 를 실행하세요`);
  process.exit(2);
}
if (!entry) {
  console.error(`[smoke] 엔트리 번들(index-*.js)이 없습니다: ${DIR}`);
  process.exit(2);
}

/* ── 최소 DOM 셰임 ────────────────────────────────────────────────────────
   '초기화 단계'를 지나가게만 한다. 렌더까지 흉내 내지 않는다(위 주석 참조). */
const noop = () => {};
const el = () => new Proxy({}, {
  get: (t, k) => (k === "style" || k === "dataset" || k === "classList" ? el()
    : typeof k === "string" && /^(append|remove|set|add|insert|replace|attach|scroll|focus|blur|click)/.test(k) ? noop
    : k in t ? t[k] : undefined),
  set: () => true,
});
const store = () => ({ getItem: () => null, setItem: noop, removeItem: noop, clear: noop, key: () => null, length: 0 });

const doc = {
  createElement: el, createElementNS: el, createComment: el, createTextNode: el,
  createDocumentFragment: el, importNode: el, adoptNode: el,
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  getElementsByTagName: () => [], getElementsByClassName: () => [], getElementsByName: () => [],
  addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
  documentElement: el(), head: el(), body: el(), activeElement: null,
  cookie: "", title: "", referrer: "", readyState: "complete", visibilityState: "visible",
  contains: () => false, execCommand: noop, hasFocus: () => false, elementFromPoint: () => null,
};

const win = {
  document: doc, localStorage: store(), sessionStorage: store(),
  location: { href: "http://localhost/", search: "", pathname: "/", origin: "http://localhost", hash: "", host: "localhost" },
  navigator: { userAgent: "node", language: "ko", languages: ["ko"], mediaDevices: {}, clipboard: {}, onLine: true },
  addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }),
  requestAnimationFrame: noop, cancelAnimationFrame: noop, requestIdleCallback: noop,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  fetch: () => Promise.resolve({ ok: false, status: 0, json: () => Promise.resolve({}), text: () => Promise.resolve("") }),
  name: "", screen: { width: 1920, height: 1080 }, devicePixelRatio: 1, isSecureContext: true,
  innerWidth: 1920, innerHeight: 1080, scrollX: 0, scrollY: 0,
  performance, console, URL, URLSearchParams, TextEncoder, TextDecoder, crypto: globalThis.crypto,
  atob: globalThis.atob, btoa: globalThis.btoa, structuredClone: globalThis.structuredClone,
  Blob: class {}, File: class {}, FormData: class {}, Worker: class {}, WebSocket: class {},
  BroadcastChannel: class { postMessage() {} addEventListener() {} removeEventListener() {} close() {} },
  Image: class {}, Audio: class {}, AbortController: globalThis.AbortController,
  MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
  IntersectionObserver: class { observe() {} disconnect() {} unobserve() {} },
  HTMLElement: class {}, Element: class {}, Node: class {}, Event: class {}, CustomEvent: class {},
  CSS: { supports: () => false },
  open: () => null, close: noop, focus: noop, alert: noop, confirm: () => false, prompt: () => null,
};
win.window = win; win.self = win; win.globalThis = win; win.top = win; win.parent = win;

const ctx = vm.createContext(win);
const cache = new Map();
const missing = [];

function load(spec) {
  const name = String(spec).replace(/^\.\//, "");
  if (cache.has(name)) return cache.get(name);
  let code;
  try {
    code = readFileSync(join(DIR, name), "utf8");
  } catch {
    // 동적 import 로만 쓰이는 청크는 여기서 안 보일 수 있다 — 빈 모듈로 대체하고 기록만 한다.
    missing.push(name);
    code = "export default {};";
  }
  const m = new vm.SourceTextModule(code, { context: ctx, identifier: name });
  cache.set(name, m);
  return m;
}

/** createRoot 까지 왔는가 = 모든 모듈 초기화 통과. */
const reachedRender = (msg) =>
  /Minified React error #(299|200)/.test(msg)          // container 가 DOM 이 아니다 = 렌더 직전
  || /createRoot|container|Target container/i.test(msg);

const root = load(entry);
try {
  await root.link((spec) => load(spec));
  await root.evaluate();
  console.log(`[smoke] OK — ${entry} 초기화 통과(렌더까지 도달)`);
  process.exit(0);
} catch (e) {
  const msg = String(e?.message ?? e);
  if (reachedRender(msg)) {
    console.log(`[smoke] OK — ${entry} 모든 모듈 초기화 통과(렌더 직전에서 정지: ${msg.slice(0, 60)}…)`);
    if (missing.length) console.log(`[smoke] 참고 — 정적으로 안 보이는 청크 ${missing.length}개는 건너뜀`);
    process.exit(0);
  }
  console.error("[smoke] 실패 — 앱 모듈 초기화 중 오류. 이대로 배포하면 화면이 뜨지 않습니다.");
  console.error(`[smoke] ${msg}`);
  console.error(String(e?.stack ?? "").split("\n").slice(1, 4).map((l) => `[smoke]   ${l.trim()}`).join("\n"));
  console.error("[smoke] 흔한 원인: 모듈 최상위 상수가 **아래에 선언된** const 를 함수 너머로 읽는다(TDZ).");
  console.error("[smoke]           → frontend/tests/module_init_order.test.mjs 도 함께 보세요.");
  process.exit(1);
}
