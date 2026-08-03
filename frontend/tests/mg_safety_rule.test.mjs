/* 2D-MG 안전 규칙 — lib/mgHang.ts 를 **실제로** 부른다.
 *
 * 사용자 보고(sv70, 스크린샷 3장):
 *   B) 2D-MG 를 켜면 **MLO 행이 잘려** 보인다
 *   C) 같은 화면에 **두 배율**이 공존한다(위 108% / 아래 100%)
 *
 * MG 에서 조직이 잘려 보이는 것은 병변을 놓치는 것과 같고, 좌우 배율이 다르면
 * **없는 비대칭**이 보인다. 그래서 두 규칙을 테스트로 못 박는다:
 *   ① 조직 상자를 타일에 **딱** 채우지 않는다(헤드룸) — 탐지 오차가 곧 잘림이 되면 안 된다
 *   ② 세로 확대에는 상한이 있다 — MLO 는 겨드랑이·대흉근이 밝기 임계에 덜 걸린다
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  MG_HEADROOM, MG_MAX_V_ZOOM, MG_MAX_ZOOM, isMg, mgFit, mgInstView, mgOrderIndexes, mgPaneIs,
  mgRatioBox, mgZoomOf,
} from "../src/lib/mgHang.ts";

const CFG = { margin: 0 };
const TILE = { w: 400, h: 600 };
const IMG = { w: 2000, h: 3000 };          // MG 는 세로로 길다

/** 조직 상자 — 정규화 좌표 */
const box = (x0, y0, x1, y1, wall = "R") => ({ x0, y0, x1, y1, wall });

test("헤드룸 — 상자를 타일에 '딱' 채우지 않는다 (탐지 오차 여유)", () => {
  assert.ok(MG_HEADROOM > 0 && MG_HEADROOM < 1, `MG_HEADROOM=${MG_HEADROOM}`);
  // 상자가 화면 전체(0~1)면 배율은 1 이 아니라 1×헤드룸 이어야 한다
  const z = mgZoomOf(TILE, IMG, box(0, 0, 1, 1), CFG);
  assert.ok(z < 1, `상자가 화면 전체인데 배율 ${z} — 여유가 0 이면 1px 오차가 곧 잘림이다`);
  assert.ok(Math.abs(z - MG_HEADROOM) < 1e-9, `헤드룸이 안 걸렸다: ${z}`);
});

test("세로 확대 상한 — 탐지가 세로로 덜 잡아도 피해가 갇힌다 (MLO 회귀 방어)", () => {
  // 상자가 세로로 절반만 덮은 경우(= 겨드랑이·아래쪽을 놓친 MLO)
  const half = mgZoomOf(TILE, IMG, box(0, 0.25, 1, 0.75), CFG);
  // 상한이 없으면 1/0.5 = 2배까지 확대되어 나머지 절반이 잘린다
  assert.ok(half <= MG_MAX_V_ZOOM * MG_HEADROOM + 1e-9,
            `세로 배율 ${half} — 상한 ${MG_MAX_V_ZOOM} 을 넘었다. MLO 가 잘리는 그 경로다`);
  assert.ok(MG_MAX_V_ZOOM < MG_MAX_ZOOM, "세로 상한이 전체 상한보다 느슨하면 의미가 없다");
});

test("아주 작은 상자에도 배율이 폭주하지 않는다", () => {
  const z = mgZoomOf(TILE, IMG, box(0.45, 0.45, 0.55, 0.55), CFG);
  assert.ok(z <= MG_MAX_ZOOM, `배율 ${z} > 상한 ${MG_MAX_ZOOM}`);
  assert.ok(z <= MG_MAX_V_ZOOM * MG_HEADROOM + 1e-9, "세로 상한이 먼저 걸려야 한다");
});

test("mgZoomOf 와 mgFit 이 **같은** 배율을 낸다 (두 곳에서 따로 계산하면 칸마다 갈린다)", () => {
  const b = box(0.1, 0.15, 0.9, 0.85);
  const z = mgZoomOf(TILE, IMG, b, CFG);
  const fit = mgFit(TILE, IMG, b, CFG, false, false, undefined, "right");
  assert.ok(fit, "fit 이 없다");
  assert.ok(Math.abs(fit.mz - z) < 1e-9,
            `mgZoomOf=${z} vs mgFit=${fit.mz} — 후보와 적용이 다르면 배율이 통일되지 않는다`);
});

test("forceZoom 을 주면 그 값을 그대로 쓴다 (좌우 통일의 근거)", () => {
  const b = box(0.1, 0.1, 0.9, 0.9);
  const fit = mgFit(TILE, IMG, b, CFG, false, false, 1.11, "right");
  assert.ok(fit);
  assert.equal(fit.mz, 1.11, "강제 배율이 무시됐다 — 좌우 크기 비교가 깨진다");
});

test("CC 와 MLO 가 **같은** forceZoom 을 받으면 배율이 같다", () => {
  // CC: 세로로 짧고 넓다 / MLO: 세로로 길다 — 상자가 달라도 강제 배율은 같아야 한다
  const cc = mgFit(TILE, IMG, box(0.05, 0.2, 0.95, 0.8), CFG, false, false, 1.2, "right");
  const mlo = mgFit(TILE, IMG, box(0.05, 0.02, 0.95, 0.98), CFG, false, false, 1.2, "left");
  assert.ok(cc && mlo);
  assert.equal(cc.mz, mlo.mz, "같은 검사인데 행마다 배율이 다르다 — 없는 비대칭이 보인다");
});

test("공유 배율은 **최소값**이어야 한다 — 최대를 쓰면 좁은 칸이 잘린다", () => {
  const wide = mgZoomOf(TILE, IMG, box(0.05, 0.2, 0.95, 0.8), CFG);   // 넓은 상자 → 작은 배율
  const tight = mgZoomOf(TILE, IMG, box(0.3, 0.35, 0.7, 0.65), CFG);  // 좁은 상자 → 큰 배율
  assert.ok(tight > wide, "표본 전제가 깨졌다");
  // 호출부는 min 을 취한다. max 를 쓰면 넓은 상자 칸이 타일을 넘쳐 잘린다.
  const shared = Math.min(wide, tight);
  const applied = mgFit(TILE, IMG, box(0.05, 0.2, 0.95, 0.8), CFG, false, false, shared, "right");
  assert.ok(applied);
  assert.ok(applied.mz <= wide + 1e-9, "공유 배율이 넓은 상자를 넘쳤다");
});

test("상자가 없으면 null — 보정하지 않는다(원본 유지)", () => {
  assert.equal(mgZoomOf(TILE, IMG, null, CFG), null);
  assert.equal(mgFit(TILE, IMG, null, CFG, false, false, undefined, "right"), null);
  assert.equal(mgZoomOf(TILE, IMG, undefined, CFG), null);
});

test("퇴화 상자(너무 얇음)는 보정하지 않는다", () => {
  assert.equal(mgZoomOf(TILE, IMG, box(0.5, 0.5, 0.505, 0.9), CFG), null);
  assert.equal(mgZoomOf(TILE, IMG, box(0.1, 0.5, 0.9, 0.505), CFG), null);
});

test("mgRatioBox 폴백도 헤드룸을 받는다 (근거 없는 추정 크롭이 더 위험하다)", () => {
  const z = mgZoomOf(TILE, IMG, mgRatioBox("R", 0.7), CFG);
  assert.ok(z !== null && z <= MG_MAX_V_ZOOM * MG_HEADROOM + 1e-9);
});

/* ── MG 판정 술어 — 체크박스와 보정 엔진이 **같은 근거**를 쓰는지 ────────────── */

test("시리즈 modality 가 비면 검사 modality 로 보강한다 (Live 메타데이터 실패 대비)", () => {
  // 실제 사고: Live 경로에서 (0008,0060) 조회가 실패하면 시리즈 modality 가 조용히 "" 가 되고
  // 2D-MG 체크박스도, 보정 엔진도 통째로 죽었다 — 4-view 는 걸리는데 2D-MG 만 없었다.
  assert.equal(mgPaneIs("", "MG"), true, "검사가 MG 인데 보강되지 않았다");
  assert.equal(mgPaneIs(null, "MG"), true);
  assert.equal(mgPaneIs(undefined, "MG"), true);
});

test("시리즈가 자기 modality 를 말했으면 그것이 최종 — MG 검사의 US 시리즈가 새어 나오면 안 된다", () => {
  assert.equal(mgPaneIs("US", "MG"), false, "MG 검사 안의 US 시리즈에 2D-MG 가 걸렸다");
  assert.equal(mgPaneIs("CT", "MG"), false);
  assert.equal(mgPaneIs("MG", "CR"), true, "시리즈가 MG 면 검사가 무엇이든 MG 다");
});

test("MG 가 아닌 검사에는 새어 나오지 않는다", () => {
  assert.equal(mgPaneIs("", "CR"), false);
  assert.equal(mgPaneIs("", ""), false);
  assert.equal(mgPaneIs("", null), false);
});

test("isMg — A 가 다중값을 줘도 판정한다", () => {
  assert.equal(isMg("MG"), true);
  assert.equal(isMg("mg"), true);
  // DICOM 다중값 구분자는 역슬래시다. 소스에 직접 쓰면 이스케이프가 자꾸 어긋나므로
  // 문자코드로 만든다(92 = '\').
  const BS = String.fromCharCode(92);
  assert.equal(isMg(`MG${BS}CR`), true, "다중값 첫 항목");
  assert.equal(isMg(`CR${BS}MG`), true, "다중값 뒤 항목");
  assert.equal(isMg("MG, CT"), true);
  assert.equal(isMg("CR"), false);
  assert.equal(isMg(""), false);
  assert.equal(isMg(null), false);
  assert.equal(isMg("MGX"), false, "부분일치로 걸리면 안 된다");
});

/* ── MG 4-view 표준 순서 — R 이 화면 왼쪽, 흉벽이 가운데 ─────────────────────
 * 실제 증상(sv70): 4뷰가 한 시리즈에 든 검사가 저장 순서(LCC,RCC,LMLO,RMLO)대로 깔려
 * **L 유방이 화면 왼쪽**에 왔다. 표준은 환자를 마주 본 배치 — [RCC, LCC, RMLO, LMLO].
 * 화면의 큰 LCC/RCC 글자는 픽셀에 구워진 것이라 코드가 읽을 수 없다 — 근거는 태그뿐이다.
 */

const V = (laterality, view_position) => ({ laterality, view_position });

test("★ 저장 순서 [LCC,RCC,LMLO,RMLO] → 표준 [RCC,LCC,RMLO,LMLO] (핵심 회귀 방어)", () => {
  const stored = [V("L", "CC"), V("R", "CC"), V("L", "MLO"), V("R", "MLO")];
  assert.deepEqual(mgOrderIndexes(stored), [1, 0, 3, 2]);
});

test("이미 표준 순서면 그대로", () => {
  const ok = [V("R", "CC"), V("L", "CC"), V("R", "MLO"), V("L", "MLO")];
  assert.deepEqual(mgOrderIndexes(ok), [0, 1, 2, 3]);
});

test("태그가 하나라도 없으면 **손대지 않는다** — 확신 없이 섞으면 더 위험하다", () => {
  const partial = [V("L", "CC"), V("R", "CC"), V("", "MLO"), V("R", "MLO")];
  assert.deepEqual(mgOrderIndexes(partial), [0, 1, 2, 3], "판정 불가인데 재배열했다");
  const none = [{}, {}, {}, {}];
  assert.deepEqual(mgOrderIndexes(none), [0, 1, 2, 3]);
});

test("뷰가 중복이면(RCC 두 장 등) 손대지 않는다", () => {
  const dup = [V("R", "CC"), V("R", "CC"), V("R", "MLO"), V("L", "MLO")];
  assert.deepEqual(mgOrderIndexes(dup), [0, 1, 2, 3]);
});

test("4장이 아니면 손대지 않는다 (토모신테시스·추가 촬영 혼재)", () => {
  const five = [V("R", "CC"), V("L", "CC"), V("R", "MLO"), V("L", "MLO"), V("R", "XCCL")];
  assert.deepEqual(mgOrderIndexes(five), [0, 1, 2, 3, 4]);
  assert.deepEqual(mgOrderIndexes([]), []);
});

test("mgInstView — 태그 정규화(소문자·공백·MLO 변형)", () => {
  assert.deepEqual(mgInstView(V(" r ", " mlo ")), { lat: "R", view: "MLO" });
  assert.deepEqual(mgInstView(V("L", "CC")), { lat: "L", view: "CC" });
  // XCCL(확대 CC 변형)은 CC 로 새면 안 된다 — 배치가 틀어진다
  assert.deepEqual(mgInstView(V("R", "XCCL")), { lat: "R", view: "" });
  assert.deepEqual(mgInstView(V("B", "CC")).lat, "", "R/L 이 아닌 laterality 는 버린다");
  assert.deepEqual(mgInstView(null), { lat: "", view: "" });
});
