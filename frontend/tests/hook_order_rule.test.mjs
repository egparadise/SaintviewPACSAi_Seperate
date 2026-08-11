/* 훅 순서 규정 — 컴포넌트의 **조기 return 뒤에 훅을 두지 않는다**.
 *
 * 실제 사고(2026-08-12): 판독창을 열면 화면이 통째로 죽고 ErrorBoundary 가
 *   "Rendered more hooks than during the previous render" 를 띄웠다.
 * 원인: ReportWindow 의 wcVocab(useMemo)이 `if (!detail) return` **뒤**에 있었다.
 *   detail 은 비동기로 온다 — 첫 렌더는 조기 반환이라 훅이 N개, detail 이 도착한 다음
 *   렌더는 N+1개. React 는 훅을 **호출 순서로** 짝짓기 때문에 개수가 늘면 그 화면을 버린다.
 *
 * ⚠ 이 결함은 타입 검사·빌드·기존 테스트를 **전부 통과한다**. 눈으로도 안 보인다
 *   (조기 반환과 훅이 수십 줄 떨어져 있다). 그래서 소스 스캔이 유일한 방어선이다.
 *
 * 판정: 중괄호 깊이를 추적해 컴포넌트 본문 최상위(깊이 1)의 훅만 보고,
 *   조기 반환은 깊이 1 의 `return` 과 **최상위 `if` 블록 안(깊이 2)의 `return`** 을 센다
 *   (실제 코드는 `if (!detail) { return (...) }` 꼴이라 후자를 빠뜨리면 아무것도 못 잡는다).
 *   문자열·주석 안의 중괄호는 세지 않는다.
 *
 * 실행: node --test --experimental-strip-types frontend/tests/hook_order_rule.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const COMP_START = /^(?:export\s+)?(?:default\s+)?function\s+([A-Z]\w*)\s*[(<]/;
const HOOK_CALL = /(?:^|[\s=(,{])(use[A-Z]\w*)\s*\(/;
const IF_OPEN = /^\s*(?:\}\s*else\s+)?if\s*\(/;
const RET = /^\s*return\b/;

/** 문자열·주석을 공백으로 지운 코드만 — 중괄호 계수가 리터럴에 속지 않게 */
function stripCode(line, inBlock) {
  let out = "", i = 0;
  while (i < line.length) {
    if (inBlock) {
      const j = line.indexOf("*/", i);
      if (j < 0) return [out, true];
      i = j + 2; inBlock = false; continue;
    }
    const c = line[i];
    if (c === "/" && line[i + 1] === "/") break;
    if (c === "/" && line[i + 1] === "*") { i += 2; inBlock = true; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const q = c; i++;
      while (i < line.length) {
        if (line[i] === "\\") { i += 2; continue; }
        if (line[i] === q) { i++; break; }
        i++;
      }
      out += " "; continue;
    }
    out += c; i++;
  }
  return [out, inBlock];
}

/** 파일 하나에서 위반 목록 — [{comp, line, hook, retLine}] */
export function scanHookOrder(text) {
  const lines = text.split(/\r?\n/);
  const hits = [];
  let comp = "", armed = false, retAt = 0, inBlock = false;
  let stack = [];                       // 여는 중괄호마다 "if" 또는 "x"
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    let code;
    [code, inBlock] = stripCode(raw, inBlock);
    if (!armed) {
      const m = COMP_START.exec(raw);
      if (!m) continue;
      comp = m[1]; armed = true; retAt = 0; stack = [];
    }
    const depth = stack.length;         // 줄 **시작 시점**의 깊이
    if (!retAt && RET.test(code) && (depth === 1 || (depth === 2 && stack[depth - 1] === "if"))) {
      retAt = n + 1;
    }
    if (retAt && n + 1 > retAt && depth === 1) {
      const h = HOOK_CALL.exec(code);
      if (h) hits.push({ comp, line: n + 1, hook: h[1], retLine: retAt });
    }
    const kind = IF_OPEN.test(code) ? "if" : "x";
    for (const ch of code) {
      if (ch === "{") stack.push(kind);
      else if (ch === "}") {
        stack.pop();
        if (!stack.length) { comp = ""; armed = false; retAt = 0; break; }
      }
    }
  }
  return hits;
}

function tsxFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    if (e === "node_modules") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (e.endsWith(".tsx")) out.push(p);
  }
  return out;
}

test("★ 조기 return 뒤에 훅이 없다 — 있으면 그 화면이 통째로 죽는다", () => {
  const bad = [];
  for (const f of tsxFiles(SRC)) {
    for (const h of scanHookOrder(readFileSync(f, "utf8"))) {
      bad.push(`${relative(SRC, f)}:${h.line}  ${h.comp}() — ${h.hook}() 이 ${h.retLine}행 조기 return 뒤`);
    }
  }
  assert.deepEqual(bad, [],
    "훅은 조기 return **위로** 올려라(로직 변경 없이 위치만).\n  " + bad.join("\n  "));
});

test("판정기 자체 검증 — 실제로 죽었던 모양을 잡아내는가", () => {
  // 사고 당시의 최소 재현: 조기 반환이 `if (…) { return … }` 안에 있다(깊이 2)
  const broken = `
export function Bad() {
  const [a, setA] = useState(0);
  if (!detail) {
    return (<div>loading</div>);
  }
  const v = useMemo(() => 1, []);
  return <div>{a}{v}</div>;
}
`;
  const hits = scanHookOrder(broken);
  assert.equal(hits.length, 1, "깊이 2 의 조기 return 을 놓치면 이 규칙은 아무것도 못 잡는다");
  assert.equal(hits[0].hook, "useMemo");
  assert.equal(hits[0].comp, "Bad");

  // 고친 모양(훅이 위) 은 잡지 않는다 — 거짓 양성이면 아무도 이 테스트를 안 믿는다
  const fixed = `
export function Good() {
  const [a, setA] = useState(0);
  const v = useMemo(() => 1, []);
  if (!detail) {
    return (<div>loading</div>);
  }
  return <div>{a}{v}</div>;
}
`;
  assert.deepEqual(scanHookOrder(fixed), []);

  // 콜백 안의 return 은 조기 반환이 아니다(effect cleanup 등) — 오탐 방지
  const nested = `
export function Fine() {
  useEffect(() => {
    if (x) return;
    return () => cleanup();
  }, []);
  const v = useMemo(() => 1, []);
  return <div>{v}</div>;
}
`;
  assert.deepEqual(scanHookOrder(nested), []);
});
