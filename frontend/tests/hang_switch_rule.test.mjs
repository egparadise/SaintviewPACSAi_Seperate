/* 검사 전환 시 분할 재계산 — lib/viewerConfig.resolveHang2d 를 **실제로** 부른다.
 *
 * 사용자 보고(sv70): CT(Series 2×2)를 보다가 탭으로 DR/MG 검사를 열면
 *   · CT 의 2×2 격자가 그대로 남고
 *   · DR 은 시리즈가 1~2개뿐이라 나머지 칸이 빈 채여서 "영상이 안 뜬다" 처럼 보였고
 *   · DR·MG 자기 설정(Series 1×1)은 무시됐다
 *
 * 원인은 단순했다 — pickHang2d 가 **prefs 로드 시 주 검사 modality 로 한 번만** 불렸고
 * 탭 전환에는 재계산 지점이 아예 없었다. 그래서 '어떤 modality 를 열 때 어떤 분할인가' 를
 * 순수 함수 하나로 못박고, 뷰어가 검사마다 이것을 다시 부르게 했다.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { paneCountOf, resolveHang2d } from "../src/lib/viewerConfig.ts";
import { DEFAULT_MG_CFG, readMgCfg } from "../src/lib/mgHang.ts";

// 사용자 설정 그대로(2번 스크린샷): CR/DR/DX/US 1×1 · CT 2×2 · MR 2×3
const PREFS = {
  hanging2d_common_on: true,
  hanging2d: {
    CR: "1x1", DR: "1x1", DX: "1x1", US: "1x1",
    CT: "2x2", MR: "2x3", XA: "1x1", NM: "1x1", PT: "1x1", "*": "1x1",
  },
};

test("모달리티마다 자기 분할이 나온다 — CT 만 2×2", () => {
  assert.equal(resolveHang2d(PREFS, "ty", "CT").s, "2x2");
  assert.equal(resolveHang2d(PREFS, "ty", "DR").s, "1x1");
  assert.equal(resolveHang2d(PREFS, "ty", "DX").s, "1x1");
  assert.equal(resolveHang2d(PREFS, "ty", "MR").s, "2x3");
});

test("★ CT 를 보다가 DR 로 바꾸면 분할이 **1×1 로 바뀐다** (핵심 회귀 방어)", () => {
  // 예전 버그: 현재 layout(CT 2×2)을 그대로 써서 DR 이 4칸 격자에 들어갔다.
  const cur = resolveHang2d(PREFS, "ty", "CT");
  const next = resolveHang2d(PREFS, "ty", "DR");
  assert.notEqual(next.s, cur.s, "모달리티가 바뀌었는데 분할이 그대로다");
  assert.equal(paneCountOf(next.s), 1, "DR 인데 페인이 1칸이 아니다");
  assert.equal(paneCountOf(cur.s), 4);
});

test("paneCountOf — setLayout 직후 옛 state 를 읽지 않도록 키에서 직접 센다", () => {
  assert.equal(paneCountOf("2x2"), 4);
  assert.equal(paneCountOf("2x3"), 6);
  assert.equal(paneCountOf("1x1"), 1);
  assert.equal(paneCountOf(null, 4), 4, "없으면 폴백");
  assert.equal(paneCountOf("이상한값", 2), 2, "형식이 아니면 폴백");
});

test("모르는 modality 는 '*'(기타 전체) 를 따른다", () => {
  assert.equal(resolveHang2d(PREFS, "ty", "OT").s, "1x1");
});

test("설정이 없으면 강제하지 않는다 — 현재 분할을 유지하게 null", () => {
  assert.equal(resolveHang2d(undefined, "ty", "CT").s, null);
  assert.equal(resolveHang2d({}, "ty", "CT").s, null);
  assert.equal(resolveHang2d(PREFS, "ty", "").s, null);
});

test("공통 체크가 꺼지면 그 뷰어 표만 본다(폴백 없음)", () => {
  const p = {
    hanging2d_common_on: false,
    hanging2d: { CT: "2x2" },                       // 공통 — 보지 않는다
    hanging2d_by_viewer: { ty: { CT: "1x2" } },
  };
  assert.equal(resolveHang2d(p, "ty", "CT").s, "1x2");
  assert.equal(resolveHang2d(p, "in", "CT").s, null, "다른 뷰어 표가 비면 강제하지 않는다");
});

/* ── MG — Image Layout 이 기본, 체크했을 때만 Series ─────────────────────── */

test("MG 는 2D 행잉 표 밖 — mg 전용 규정을 따른다", () => {
  // 표에 MG 행이 있어도 무시된다(설정 화면이 MG 행을 안 만드는 이유).
  const p = { hanging2d_common_on: true, hanging2d: { MG: "2x3", "*": "1x1" } };
  assert.equal(resolveHang2d(p, "ty", "MG", "2x2").s, "2x2", "mg_hang 값이 이겨야 한다");
  assert.equal(resolveHang2d(p, "ty", "MG", null).s, null, "2D-MG 가 꺼져 있으면 강제하지 않는다");
  assert.equal(resolveHang2d(p, "ty", "MG", "2x2").i, null, "MG 는 페인 안 타일을 겹치지 않는다");
});

test("★ MG 분할 방식 기본은 Image Layout — series_layout 은 항상 uncheck 로 시작", () => {
  assert.equal(DEFAULT_MG_CFG.series_layout, false, "기본이 체크돼 있으면 요구 위반");
  assert.equal(readMgCfg({}).series_layout, false);
  assert.equal(readMgCfg(undefined).series_layout, false);
  // 구 저장본(키 없음)도 uncheck 로 읽힌다
  assert.equal(readMgCfg({ on: true, layout: "2x2" }).series_layout, false);
});

test("MG 분할 방식 — 켜면 켜진 대로 읽는다", () => {
  assert.equal(readMgCfg({ series_layout: true }).series_layout, true);
  assert.equal(readMgCfg({ series_layout: "네" }).series_layout, false, "타입이 틀리면 기본값");
});

test("MG 기본 타일은 2×2 (CC/MLO 4뷰)", () => {
  assert.equal(DEFAULT_MG_CFG.layout, "2x2");
  assert.equal(paneCountOf(DEFAULT_MG_CFG.layout), 4);
});

/* ── 우선순위 — 사용자가 "결코 변하지 않는다" 고 못박은 규정 ─────────────────
 *   ① 행잉 프로토콜이 **선택**되면 그것이 이긴다 (HP 기본은 해제)
 *   ② HP 해제 + '이 공통 설정을 모든 뷰어에 우선 적용' **체크** → 공통 표
 *   ③ HP 해제 + 그 체크 **해제** → 그 뷰어 개별 표
 *   ④ MG 는 언제나 맘모 규정(mg_hang)
 */

const COMMON_ON = {
  hanging2d_common_on: true,
  hanging2d: { CT: "2x2", DR: "1x1", "*": "1x1" },
  hanging2d_by_viewer: { ty: { CT: "1x2", DR: "2x2" } },   // 체크 상태에서는 무시돼야 한다
};
const COMMON_OFF = { ...COMMON_ON, hanging2d_common_on: false };

test("① HP 가 선택되면 공통·뷰어별을 **무시**한다 (분할을 건드리지 않는다)", () => {
  const r = resolveHang2d(COMMON_ON, "ty", "CT", null, true);
  assert.equal(r.s, null, "HP 가 걸렸는데 공통 표로 덮었다 — 규정 위반");
  assert.equal(r.i, null);
  // MG 도 마찬가지 — HP 가 이긴다
  assert.equal(resolveHang2d(COMMON_ON, "ty", "MG", "2x2", true).s, null);
});

test("② 공통 체크 — 공통 표만 본다(뷰어별 값이 있어도 무시)", () => {
  assert.equal(resolveHang2d(COMMON_ON, "ty", "CT").s, "2x2", "공통 2x2 가 이겨야 한다");
  assert.equal(resolveHang2d(COMMON_ON, "ty", "DR").s, "1x1");
  // 다른 뷰어도 같은 공통 표를 본다
  assert.equal(resolveHang2d(COMMON_ON, "in", "CT").s, "2x2");
  assert.equal(resolveHang2d(COMMON_ON, "saint", "CT").s, "2x2");
});

test("③ 공통 해제 — 그 뷰어 개별 표만 본다(공통으로 폴백하지 않는다)", () => {
  assert.equal(resolveHang2d(COMMON_OFF, "ty", "CT").s, "1x2", "뷰어별 1x2 가 이겨야 한다");
  assert.equal(resolveHang2d(COMMON_OFF, "ty", "DR").s, "2x2");
  // 개별 표가 없는 뷰어는 **강제하지 않는다** — 공통으로 새면 규정 위반
  assert.equal(resolveHang2d(COMMON_OFF, "in", "CT").s, null);
});

test("④ MG 는 어느 표에도 안 걸리고 맘모 규정만 따른다", () => {
  const p = { ...COMMON_ON, hanging2d: { ...COMMON_ON.hanging2d, MG: "2x3" } };
  assert.equal(resolveHang2d(p, "ty", "MG", "1x2").s, "1x2", "mg_hang 이 이겨야 한다");
  assert.equal(resolveHang2d({ ...p, hanging2d_common_on: false }, "ty", "MG", "1x2").s, "1x2");
});

test("HP 해제가 기본 — hpActive 를 안 넘기면 ②③ 규칙이 그대로 돈다", () => {
  assert.equal(resolveHang2d(COMMON_ON, "ty", "CT").s, "2x2");
  assert.equal(resolveHang2d(COMMON_ON, "ty", "CT", null, false).s, "2x2");
});

/* ── 탭 전환은 **예외가 없다** ────────────────────────────────────────────────
 * 사용자 재확인: "뷰어 모니터의 현재 열려있는 layout 구조로 이후 Exam 탭을 전환하더라도
 *                같이 적용된다. 이 부분이 항상 Setting 의 Modality별 Layout 을 따르게 하라."
 *
 * 그래서 코드에서 '검사별 화면 구성 기억/복원' 을 없앴다. 그것이 옛 격자를 되살려
 * 규정을 무력화했기 때문이다. 아래는 그 규정을 값으로 고정한다.
 */

test("★ 어떤 조합으로 전환해도 **대상 모달리티의 설정값**이 나온다", () => {
  const seq = ["CT", "DR", "MR", "DX", "CT", "US"];
  for (const mod of seq) {
    const r = resolveHang2d(PREFS, "ty", mod);
    const expected = PREFS.hanging2d[mod] ?? PREFS.hanging2d["*"];
    assert.equal(r.s, expected, `${mod} 전환 시 ${expected} 가 아니라 ${r.s}`);
  }
});

test("★ 직전에 무엇을 보고 있었는지는 결과에 영향이 없다 (상태 무관)", () => {
  // resolveHang2d 는 '현재 화면' 을 인자로 받지 않는다 — 그것이 이 규정을 구조적으로 보장한다.
  const a = resolveHang2d(PREFS, "ty", "DR");
  const b = resolveHang2d(PREFS, "ty", "DR");
  assert.deepEqual(a, b);
  assert.equal(a.s, "1x1", "CT 를 보다 왔든 MR 을 보다 왔든 DR 은 1x1");
});

test("모달리티를 못 읽으면 **분할을 강제하지 않는다** (옛 격자를 남기지도 않는다)", () => {
  // 호출부는 메타가 없으면 1회 조회한다. 그래도 모르면 s=null → 현재 분할 유지.
  // ⚠ 이것이 '이전 검사 분할이 남는' 유일한 정당한 경우다. 그 외에는 없어야 한다.
  assert.equal(resolveHang2d(PREFS, "ty", "").s, null);
  assert.equal(resolveHang2d(PREFS, "ty", "   ").s, null);
});

test("소문자 modality 도 같은 설정을 찾는다 (A 가 어떻게 주든)", () => {
  assert.equal(resolveHang2d(PREFS, "ty", "ct").s, "2x2");
  assert.equal(resolveHang2d(PREFS, "ty", "dr").s, "1x1");
});
