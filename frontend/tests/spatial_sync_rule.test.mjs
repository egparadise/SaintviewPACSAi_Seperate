/* 공간 정합 적격성(2026-08-12 감사 → 사용자 수정 지시) — lib/spatialSync 계약.
 *
 * 감사에서 확인된 증상을 그대로 재현해 고정한다:
 *   ① FoR 이 다른 과거검사인데도 '가장 가까운 슬라이스'를 정답처럼 내놓았다 → 이제 거부(사유 포함)
 *   ② Axial 마스터가 Sagittal 타깃을 끌면 항상 끝단 한 장에 고정됐다 → 이제 거부
 *   ③ 커버리지가 겹치지 않아도 무조건 한 장을 골랐다(거리 상한 없음) → 이제 거부
 *   ④ 대표점이 좌상단 코너라 기울어진 쌍에서 FOV 절반만큼 편향됐다 → 중심 보정
 * 그리고 **회귀 방지 계약**:
 *   ⑤ FoR 을 모르면(태그 미수집 기존 데이터) 막지 않는다 — 모름 ≠ 다름
 *   ⑥ 정상(같은 축·겹치는 범위) 케이스는 예전과 같은 슬라이스를 고른다
 *
 * 실행: node --test --experimental-strip-types frontend/tests/spatial_sync_rule.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_GAP_MM_FLOOR, PARALLEL_COS, forConflict, meanSpacing, nearestSlice, planeCenter, projectPoint,
} from "../src/lib/spatialSync.ts";
import { geomOf } from "../src/lib/scoutLines.ts";

const D = Math.PI / 180;
/** 축상(Axial) 슬라이스 — z 위치만 다르다. FOV = size mm (1mm/px) */
const ax = (z, { for: f, size = 256 } = {}) => ({
  position: [-(size - 1) / 2, -(size - 1) / 2, z],
  orientation: [1, 0, 0, 0, 1, 0],
  pixel_spacing: [1, 1], rows: size, cols: size,
  ...(f ? { frame_of_reference_uid: f } : {}),
});
/** 시상(Sagittal) 슬라이스 — x 위치만 다르다 */
const sag = (x, { for: f, size = 256 } = {}) => ({
  position: [x, -(size - 1) / 2, (size - 1) / 2],
  orientation: [0, 1, 0, 0, 0, -1],
  pixel_spacing: [1, 1], rows: size, cols: size,
  ...(f ? { frame_of_reference_uid: f } : {}),
});
const stackAx = (from, to, gap, opt) => {
  const out = [];
  for (let z = from; z <= to; z += gap) out.push(ax(z, opt));
  return out;
};

test("⑥ 회귀 — 같은 축·겹치는 범위는 예전처럼 가장 가까운 슬라이스를 고른다", () => {
  const target = stackAx(0, 100, 10);          // z = 0,10,…,100 (11장)
  const r = nearestSlice(ax(37), target);
  assert.equal(r.reason, "ok");
  assert.equal(r.index, 4, "z=40 이 가장 가깝다");
  assert.ok(r.distanceMm !== null && Math.abs(r.distanceMm - 3) < 1e-6);
});

test("⑤ 회귀 방지 — FoR 을 모르면 막지 않는다(모름 ≠ 다름)", () => {
  const target = stackAx(0, 100, 10);                       // FoR 없음(기존 데이터)
  assert.equal(nearestSlice(ax(50), target).reason, "ok");
  // 한쪽만 아는 경우도 통과 — 태그 수집 전/후 데이터가 섞이는 과도기를 죽이지 않는다
  assert.equal(nearestSlice(ax(50, { for: "1.2.3" }), target).reason, "ok");
  assert.equal(nearestSlice(ax(50), stackAx(0, 100, 10, { for: "1.2.3" })).reason, "ok");
  assert.equal(forConflict({ frame_of_reference_uid: "" }, { frame_of_reference_uid: "1.2.3" }), false);
  assert.equal(forConflict({ frame_of_reference_uid: "1.2.3" }, { frame_of_reference_uid: "9.9.9" }), true);
});

test("① FoR 이 다르다고 확인되면 좌표 정합을 주장하지 않는다", () => {
  const r = nearestSlice(ax(50, { for: "1.2.840.A" }), stackAx(0, 100, 10, { for: "1.2.840.B" }));
  assert.equal(r.index, null);
  assert.equal(r.reason, "for_mismatch");
});

test("② 단면 방향이 다르면 '같은 레벨'이 없다 — Axial 마스터 ↔ Sagittal 타깃", () => {
  const target = [];
  for (let x = -60; x <= 60; x += 5) target.push(sag(x));
  const r = nearestSlice(ax(30), target);
  assert.equal(r.index, null, "예전에는 항상 끝단 한 장을 돌려줬다");
  assert.equal(r.reason, "not_parallel");
  // 임계 자체도 고정 — 15° 이내는 허용, 그 밖은 거부
  assert.ok(Math.abs(PARALLEL_COS - Math.cos(15 * D)) < 1e-12);
});

test("③ 겹치는 촬영 범위가 없으면 거부한다(거리 상한)", () => {
  const target = stackAx(0, 100, 10);
  const far = nearestSlice(ax(400), target);     // 300mm 밖
  assert.equal(far.index, null);
  assert.equal(far.reason, "too_far");
  assert.ok(far.distanceMm > 200, "얼마나 멀었는지 보고한다");
  // 경계 — 상한(=max(20, 3*간격)=30) 안쪽은 통과
  assert.equal(nearestSlice(ax(125), target).reason, "ok");
  assert.equal(nearestSlice(ax(135), target).reason, "too_far");
  assert.equal(MAX_GAP_MM_FLOOR, 20);
  assert.equal(meanSpacing(target), 10);
});

test("④ 대표점 중심 보정 — 기울어진 쌍(gantry tilt)에서 코너 편향을 없앤다", () => {
  // 마스터: 10° 기운 axial, FOV 250mm. 평면 **중심**이 z=100 에 오도록 배치한다.
  const size = 250, c = (size - 1) / 2;
  const row = [1, 0, 0], col = [0, Math.cos(10 * D), Math.sin(10 * D)];
  const master = {
    position: [0 - c * row[0] - c * col[0], 0 - c * row[1] - c * col[1], 100 - c * row[2] - c * col[2]],
    orientation: [...row, ...col], pixel_spacing: [1, 1], rows: size, cols: size,
  };
  const g = geomOf(master);
  assert.ok(Math.abs(planeCenter(g)[2] - 100) < 1e-9, "중심의 z 는 100");
  assert.ok(Math.abs(master.position[2] - 78.3) < 1.0, "코너의 z 는 약 78 — 21mm 편향");

  const target = stackAx(0, 200, 10);                    // z = 0,10,…,200
  const r = nearestSlice(master, target);
  assert.equal(r.reason, "ok", "10° 는 평행 허용 범위 안");
  assert.equal(r.index, 10, "중심 기준 z=100 (코너 기준이면 z=80 인 index 8 로 20mm 어긋난다)");
});

test("④-b 평행 쌍에서는 중심 보정이 결과를 바꾸지 않는다(무해함 보장)", () => {
  // 면내 변위는 법선과 직교 → 투영값 불변. 예전 동작과 100% 같아야 한다.
  const target = stackAx(0, 100, 10);
  for (const z of [0, 7, 23, 51, 88, 100]) {
    assert.equal(nearestSlice(ax(z), target).index, Math.round(z / 10));
  }
});

test("3D Cursor 투영 — FoR 충돌·볼륨 밖·FOV 밖이면 십자선을 찍지 않는다", () => {
  const target = stackAx(0, 100, 10);
  // 정상 — 볼륨 안의 점
  const hit = projectPoint([10, 20, 50], ax(0), target);
  assert.ok(hit, "정상 케이스는 히트");
  assert.equal(hit.index, 5, "z=50");
  assert.ok(hit.x > 0 && hit.x < 1 && hit.y > 0 && hit.y < 1);
  // FoR 이 다르다고 확인되면 아예 찍지 않는다
  assert.equal(projectPoint([10, 20, 50], ax(0, { for: "A" }), stackAx(0, 100, 10, { for: "B" })), null);
  // 볼륨(슬랩) 밖 — 예전에는 끝 슬라이스에 찍혔다
  assert.equal(projectPoint([10, 20, 900], ax(0), target), null);
  // FOV 밖 — 예전에는 잘려 안 보이는데 인덱스만 조용히 튀었다
  assert.equal(projectPoint([9999, 20, 50], ax(0), target), null);
});

test("3D Cursor 는 방향이 다른 단면에도 찍는다 — 평행성 검사를 하면 안 된다(정의)", () => {
  const sagStack = [];
  for (let x = -60; x <= 60; x += 5) sagStack.push(sag(x));
  const hit = projectPoint([25, 10, 20], ax(0), sagStack);
  assert.ok(hit, "Axial 클릭 → Sagittal 십자선은 3D Cursor 의 존재 이유다");
  assert.equal(hit.index, sagStack.findIndex((s) => s.position[0] === 25));
});
