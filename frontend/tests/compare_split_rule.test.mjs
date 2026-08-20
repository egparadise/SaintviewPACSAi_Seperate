/* Compare 화면 분할·Combine 계약(2026-08-19 사용자 확정).
 *
 * 사용자 요구 원문:
 *  "설정에 Layout 띄우기 — 한 화면 1:2 분할로 되어 있으면 Modality 관계 없이 모두 1:2 분할이 되게 해.
 *   CT나 MRI가 별도의 Series Layout 이 되어 있다 하더라도 이 기능은 Series Layout 과 관계없이
 *   화면 자체 분할 기능이다. 더불어 이 분할에서는 Combine 을 누르면 특정 선택한 영역이 아니라
 *   1:2 두 영역 모두(M=master, S=slave) Combine 이 동작하여 마우스 스크롤과 플레이 버튼 등으로
 *   영상을 비교할 수 있도록 해."
 *
 * Viewer2D 는 렌더 없이 부를 수 없는 큰 컴포넌트라, 여기서는 **배선 계약**을 소스에서 확인한다
 * (분할 규칙 자체는 CLAUDE.md 대로 resolveHang2d 한 곳에 남아 있어야 하므로 로직 복제도 함께 막는다).
 *
 * 실행: node --test frontend/tests/compare_split_rule.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const v2 = readFileSync(join(ROOT, "src/pages/Viewer2D.tsx"), "utf8");

test("① 비교 중에는 모달리티 Series Layout 이 분할을 덮지 못한다", () => {
  assert.match(v2, /const compareOwnsLayout = \(\): boolean =>/,
               "'지금 분할을 Compare 가 쥐고 있는가' 판정이 한 곳에 있어야 한다");
  // applyHangFor 본문 첫머리에서 곧바로 빠져나가야 한다 — setLayout 까지 흘러가면 1:2 가 풀린다
  const i = v2.indexOf("const applyHangFor = (modality: string");
  assert.ok(i > 0, "applyHangFor 를 찾지 못했다");
  const head = v2.slice(i, i + 900);
  assert.match(head, /if \(compareOwnsLayout\(\)\) return LAYOUTS\[layout\]\.count;/,
               "비교 중이면 분할·Image layout 을 건드리지 않고 현재 페인 수를 그대로 돌려줘야 한다");
  assert.ok(head.indexOf("if (compareOwnsLayout())") < head.indexOf("resolveHang2d"),
            "resolveHang2d 로 내려가기 **전에** 막아야 한다");
});

test("② prior_mode = layout 이면 모니터 창이 아니라 이 화면을 1:2 로 나눈다", () => {
  const i = v2.indexOf("const openCompare = async ()");
  assert.ok(i > 0);
  const body = v2.slice(i, i + 3000);
  assert.match(body, /\(prefs\.compare\?\.prior_mode \?\? "layout"\) === "monitor"[\s\S]{0,120}placeCompareSlaves/,
               "'모니터 띄우기'로 설정했을 때만 옆 모니터 창 — 기본(layout)은 화면 분할");
  assert.match(body, /await compareInPlace\(ids\)/, "그 외에는 화면 안 분할로 떨어진다");
});

test("③ 한 건 비교는 모달리티와 무관하게 1×2", () => {
  const i = v2.indexOf("const compareInPlace = async (ids: number[])");
  assert.ok(i > 0);
  const body = v2.slice(i, i + 1600);
  assert.match(body, /n === 2 && \(prefs\.compare\?\.prior_mode \?\? "layout"\) !== "monitor"\s*\r?\n?\s*\? "1x2"/,
               "주 검사 + 과거 1건이면 언제나 1×2");
  assert.match(body, /cmpActiveRef\.current = true;/,
               "뒤따르는 patch 들이 지나기 전에 분할 소유권을 세워야 한다(비동기 state 로는 늦다)");
  assert.match(body, /setImgLay\(\{ r: 1, c: 1 \}\)/, "페인 안 타일 분할은 비교에서 걷어낸다");
});

test("④ 과거검사 열기(1:2 분할 설정)는 지금 격자가 무엇이든 1×2 로", () => {
  const i = v2.indexOf("const loadPrior = async (examId: number)");
  assert.ok(i > 0);
  const body = v2.slice(i, i + 1200);
  assert.match(body, /LAYOUTS\[layout\]\.count === 1 \|\| \(prefsRef\.current\.compare\?\.prior_mode \?\? "layout"\) !== "monitor"/,
               "1×1 일 때만 1×2 로 가던 옛 조건에 '분할 설정이면 언제나'가 더해져야 한다");
  assert.match(body, /cmpTreesRef\.current\.p1 = tree\.series/,
               "Combine 이 쓸 그 검사 전체 시리즈를 보관해야 한다");
});

test("⑤ Combine 은 비교 화면의 두 영역 모두에 걸린다", () => {
  const i = v2.indexOf("const combineSeries = (");   // 시그니처는 창 간 동기로 (remote) 인자를 받게 됐다
  assert.ok(i > 0);
  const body = v2.slice(i, i + 900);
  assert.match(body, /cmpActive && vis\.length > 1 \? vis : \[activePane\]/,
               "비교 중이면 보이는 페인 전부, 아니면 예전처럼 활성 페인 하나만");
  assert.match(body, /targets\.some\(\(id\) => isCombined\(panes\[id\]\)\)[\s\S]{0,400}targets\.forEach\(uncombine\)/,
               "한 쪽이라도 결합돼 있으면 두 쪽 모두 해제(토글이 어긋나지 않게)");
});

test("⑥ 각 영역은 **자기 검사**의 시리즈로 결합한다", () => {
  const i = v2.indexOf("const combineAllInto = (pid: string");
  assert.ok(i > 0);
  const body = v2.slice(i, i + 1400);
  assert.match(body, /const paneUid = panes\[pid\]\?\.studyUid \|\| detail\.study_uid/,
               "페인이 물고 있는 검사를 기준으로");
  assert.match(body, /paneUid === detail\.study_uid \? series : \(cmpTreesRef\.current\[pid\] \?\? \[\]\)/,
               "과거검사 페인에 현재 검사 시리즈를 넣으면 엉뚱한 영상이 결합된다");
  assert.match(body, /studyUid: paneUid/, "결합본의 studyUid 도 그 페인 것이어야 픽셀을 옳게 받는다");
});

test("⑦ 사용자가 직접 분할을 고르면 소유권을 돌려준다 — 영구 잠김 금지", () => {
  assert.match(v2, /const releaseCompareLayout = \(\) => \{ cmpActiveRef\.current = false; \};/);
  // 툴바 select · Srs 그리드 피커 · HP 해제 — 세 곳 모두
  assert.ok(v2.split("releaseCompareLayout()").length - 1 >= 3,
            "사용자가 분할을 직접 고르는 지점마다 붙어 있어야 한다(안 그러면 모달리티 Layout 이 영영 안 걸린다)");
});

test("⑧ CLAUDE.md 규정 — 분할 판정 로직을 뷰어에 복제하지 않았다", () => {
  // 판정 함수는 **lib/viewerConfig 에서 가져다 쓰기만** 한다 — 뷰어 안에서 다시 정의하면 갈린다.
  assert.match(v2, /pickHang2d,?[\s\S]{0,200}from "\.\.\/lib\/viewerConfig"/,
               "pickHang2d 는 lib 에서 임포트해 쓴다");
  assert.ok(!/(function|const)\s+(pickHang2d|resolveHang2d)\s*[=(]/.test(v2),
            "뷰어 안에서 캐스케이드를 다시 정의하면 안 된다(실제 사고 2회)");
  const calls = v2.split("resolveHang2d(").length - 1;
  assert.ok(calls >= 1 && calls <= 2, `resolveHang2d 호출은 소수여야 한다(현재 ${calls})`);
});
