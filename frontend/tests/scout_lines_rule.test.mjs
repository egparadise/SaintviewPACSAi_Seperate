/* Scout Line / All Lines 규칙 — lib/scoutLines.ts 를 **실제로** 부른다.
 *
 * 사용자 확정 규칙:
 *   · All Line 은 전체 절단선을 보여 주되 **지금 스크롤의 기준이 되는 뷰와 같은 축**만.
 *     (기준이 Axial 이면 Axial 전체, Sagittal 이면 Sagittal 전체)
 *   · 그 안에서 **지금 스크롤 중인 영상**의 선은 색을 달리해 몇 번째인지 알 수 있게.
 *   · Crosslink 계열은 I-View 처럼 **독립 토글 5개**(단일 선택 아님) — SaintView·T-View 도 동일.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  AXIS_LABEL, XLINK_DEFAULT, axisOf, geomOf, lineStyle,
  pickLineSources, positionLabel, scoutSegment,
} from "../src/lib/scoutLines.ts";

/* 축별 표본 — orientation 은 DICOM ImageOrientationPatient(row 3 + col 3) */
const AX  = [1, 0, 0, 0, 1, 0];    // 법선 = +z → axis 2 (Axial)
const SAG = [0, 1, 0, 0, 0, -1];   // 법선 = -x → axis 0 (Sagittal)
const COR = [1, 0, 0, 0, 0, -1];   // 법선 = +y → axis 1 (Coronal)

const inst = (orientation, z = 0) => ({
  position: [0, 0, z], orientation,
  pixel_spacing: [1, 1], rows: 512, cols: 512,
});

test("axisOf — 법선의 지배 성분으로 SAG/COR/AX 를 가른다", () => {
  assert.equal(axisOf(geomOf(inst(SAG))), 0);
  assert.equal(axisOf(geomOf(inst(COR))), 1);
  assert.equal(axisOf(geomOf(inst(AX))), 2);
  assert.deepEqual([...AXIS_LABEL], ["SAG", "COR", "AX"]);
});

test("geomOf — 기하 정보가 모자라면 null (없는 값으로 그리지 않는다)", () => {
  assert.equal(geomOf(null), null);
  assert.equal(geomOf({}), null);
  assert.equal(geomOf({ position: [0, 0, 0], orientation: AX }), null);        // spacing 없음
  assert.equal(geomOf({ position: [0, 0], orientation: AX, pixel_spacing: [1, 1] }), null);
  assert.ok(geomOf(inst(AX)));
});

test("scoutSegment — 평행 평면은 교차선이 없다", () => {
  const a = geomOf(inst(AX, 0)), b = geomOf(inst(AX, 10));
  assert.equal(scoutSegment(a, b), null, "Axial 두 장은 평행 — 선이 나오면 안 된다");
});

test("scoutSegment — 직교 평면은 화면을 관통하는 선을 만든다", () => {
  // SAG 영상은 pos z=0 에서 col=[0,0,-1] 로 아래로 뻗는다(행이 늘수록 z 감소).
  // 그래서 교차하는 Axial 은 z<0 이어야 화면 **안**에 선이 생긴다.
  // (처음엔 z=+30 으로 뒀다가 null 이 나왔는데, 코드가 아니라 **테스트 기하가 틀린** 것이었다 —
  //  z=+30 은 그 영상 위쪽 바깥이라 교차선이 화면 밖이다. 클리핑이 옳게 걸러 준 것이다.)
  const seg = scoutSegment(geomOf(inst(AX, -100)), geomOf(inst(SAG)));
  assert.ok(seg, "Axial × Sagittal 은 교차선이 있어야 한다");
  assert.ok(Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1) > 100, "선이 너무 짧다");
  assert.ok(Math.abs(seg.y1 - 100) < 1 && Math.abs(seg.y2 - 100) < 1,
            `z=-100 은 행 100 에 그려져야 한다: ${JSON.stringify(seg)}`);
});

test("scoutSegment — 화면 밖으로 나가는 교차선은 그리지 않는다", () => {
  // 영상 범위 밖(위쪽 30mm)에서 만나는 평면 — 5% 여유를 넘으면 선을 만들지 않는다.
  assert.equal(scoutSegment(geomOf(inst(AX, 30)), geomOf(inst(SAG))), null);
});

/* ── All Lines 축 필터 — 이번 요구의 핵심 ─────────────────────────────────── */

test("All Lines — 기준이 Axial 이면 Axial 전체만, 다른 축은 제외", () => {
  // 스카우트(SAG/COR)가 섞인 시리즈. 기준(index 1)은 Axial.
  const list = [inst(SAG), inst(AX, 0), inst(COR), inst(AX, 5), inst(AX, 10)];
  const got = pickLineSources(list, 1, { scout: false, all_lines: true });
  assert.deepEqual(got.map((s) => s.index), [1, 3, 4], "Axial 만 남아야 한다");
  assert.deepEqual(got.map((s) => s.current), [true, false, false]);
});

test("All Lines — 기준이 Sagittal 이면 Sagittal 전체만", () => {
  const list = [inst(SAG, 0), inst(AX), inst(SAG, 5), inst(COR)];
  const got = pickLineSources(list, 2, { scout: false, all_lines: true });
  assert.deepEqual(got.map((s) => s.index), [0, 2]);
  assert.equal(got.find((s) => s.current).index, 2);
});

test("All Lines — 현재 영상이 '몇 번째'인지 축 필터 **뒤** 기준으로 센다", () => {
  // 축 필터 전 5장이지만 Axial 은 3장 → 라벨은 3장 기준이어야 한다.
  const list = [inst(SAG), inst(AX, 0), inst(COR), inst(AX, 5), inst(AX, 10)];
  const got = pickLineSources(list, 3, { scout: false, all_lines: true });
  assert.equal(positionLabel(got), "2/3", "전체 5가 아니라 같은 축 3 중 2번째");
});

test("Scout 만 켜면 지금 이미지 1장", () => {
  const list = [inst(AX, 0), inst(AX, 5), inst(AX, 10)];
  const got = pickLineSources(list, 1, { scout: true, all_lines: false });
  assert.equal(got.length, 1);
  assert.equal(got[0].index, 1);
  assert.equal(got[0].current, true);
});

test("둘 다 꺼지면 아무 선도 안 그린다", () => {
  const list = [inst(AX, 0), inst(AX, 5)];
  assert.deepEqual(pickLineSources(list, 0, { scout: false, all_lines: false }), []);
});

test("기준 기하를 못 읽으면 전부 그리지 않고 1장만 (화면을 선으로 덮지 않는다)", () => {
  const list = [{ rows: 512, cols: 512 }, inst(AX, 5)];   // 0번은 기하 없음
  const got = pickLineSources(list, 0, { scout: false, all_lines: true });
  assert.equal(got.length, 1);
  assert.equal(got[0].current, true);
});

test("빈 시리즈·범위 밖 index 는 빈 배열", () => {
  assert.deepEqual(pickLineSources([], 0, { scout: true, all_lines: true }), []);
  assert.deepEqual(pickLineSources([inst(AX)], 9, { scout: true, all_lines: true }), []);
});

test("현재 선은 색이 다르다", () => {
  const cur = lineStyle("current"), other = lineStyle("other");
  assert.notEqual(cur.color, other.color, "현재 영상 선이 나머지와 같은 색이면 구분이 안 된다");
  assert.ok(cur.width > other.width);
  assert.ok(cur.opacity > other.opacity);
});

/* ── Crosslink 모델 — I-View 기준(독립 토글) ──────────────────────────────── */

test("독립 토글 — Crosslink 와 Scout 를 동시에 켤 수 있다", () => {
  // Viewer2D 의 옛 모델(단일 선택 union)에서는 이 조합이 **불가능**했다. 그게 두 뷰어가
  // 다르게 동작한 근본 원인이다.
  const x = XLINK_DEFAULT;
  assert.equal(x.crosslink, true);
  assert.equal(x.scout, true);
  assert.equal(x.all_lines, false, "All Lines 기본은 꺼짐");
});

/* 옛 값 이관 테스트는 지웠다 — 옛 xmode 는 저장된 적이 없어 이관할 대상이 없다.
   호출자 0인 함수를 테스트로 덮으면 '있는 기능' 으로 착각하게 된다(lib/scoutLines.ts 주석 참조). */
