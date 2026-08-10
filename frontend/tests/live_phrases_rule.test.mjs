/* SV70 계정별 단축키·판독 템플릿 Live 연동(2026-08-10 사용자 확정) — 소스 계약.
 *
 *  "이 기능 또한 SV70 DB 에 대한 Live 모드와 같이 하나처럼 동작되어야 해"
 *  → 가져오기(1회 복사)가 아니라 **읽기 경유**: A DB 에 추가되면 다음 갱신에 그대로.
 *
 *  · A→PhraseRow 변환은 api.livePhraseRows **한 곳** — 판독창·설정이 같은 변환을 쓴다.
 *  · 판독창 Shortcuts/Templates 패널에 병합(60초 갱신) · 설정>판독 단축키/템플릿 탭에
 *    'SV70(원 서버)' 읽기 전용 섹션(클릭=불러오기, 저장=내 사본).
 *  · 음수 id — 로컬 항목과 충돌 방지. workList/viewer 타입(기능키)은 문구로 쓰지 않는다.
 *
 * 실행: node --test frontend/tests/live_phrases_rule.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");

test("백엔드 — /live/phrases 정규화 경로(bridge 2 메서드 + 서비스 + 라우터)", () => {
  const br = src("../backend/app/services/webpacs_bridge.py");
  assert.match(br, /def report_shortcuts/, "A GET /api/shortcuts/");
  assert.match(br, /def report_templates/, "A GET /api/study/report/template");
  const sv = src("../backend/app/services/webpacs_live.py");
  assert.match(sv, /def live_phrases/, "정규화는 서비스 한 곳");
  assert.match(sv, /"default"/, "A 의 default 모달리티 → 공통('') 정규화");
  const rt = src("../backend/app/api/webpacs_live.py");
  assert.match(rt, /@router\.get\("\/phrases"\)/, "라우터");
});

test("api.livePhraseRows — A→PhraseRow 변환 한 곳(음수 id·기능키 제외)", () => {
  const s = src("src/api.ts");
  assert.match(s, /livePhraseRows: async \(\): Promise<PhraseRow\[\]>/, "공용 변환");
  assert.match(s, /s\.type === "report" \|\| s\.type === "template"/,
               "workList/viewer 기능키는 문구가 아니다");
  assert.match(s, /id: -\(s\.idx \|\| 0\)/, "음수 id — 로컬과 충돌 방지");
  assert.match(s, /id: -\(100000 \+ \(t\.idx \|\| 0\)\)/, "템플릿 id 대역 분리");
});

test("판독창 — Shortcuts/Templates 패널에 SV70 병합 + 60초 갱신(하나처럼)", () => {
  const s = src("src/pages/ReportWindow.tsx");
  assert.match(s, /api\.livePhraseRows\(\)/, "같은 변환 사용");
  assert.match(s, /window\.setInterval\(tick, 60_000\)/, "A 추가분 자동 반영");
  assert.match(s, /\[\.\.\.phrases, \.\.\.localPhrases, \.\.\.svPhrases\]/, "패널 병합");
});

test("설정>판독 — 단축키/템플릿 탭 SV70 섹션(읽기 전용·클릭=불러오기)", () => {
  const s = src("src/pages/SettingsModal.tsx");
  assert.match(s, /liveItems=\{svRows\}/, "두 탭 모두 전달");
  assert.match(s, /liveItems\?: PhraseRow\[\];/, "에디터 계약");
  assert.ok(s.includes('tr("(원 서버 — 자동 연동)")'), "SV70 섹션 표기");
  assert.match(s, /api\.livePhraseRows\(\)\.then\(setSvRows\)/, "같은 변환 사용");
});

test("mock A — 계정별 스코프 데이터(테스트 근거)", () => {
  const m = src("../harness/mock_webpacs_api.py");
  assert.match(m, /@app\.get\("\/api\/shortcuts\/"\)/);
  assert.match(m, /@app\.get\("\/api\/study\/report\/template"\)/);
  assert.match(m, /s\["user_idx"\] == acc\["user_idx"\]/, "per-user 스코프");
});
