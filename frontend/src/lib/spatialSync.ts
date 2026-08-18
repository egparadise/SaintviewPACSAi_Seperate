/* 공간 정합 적격성 — Crosslink(슬라이스 동기)·3D Cursor 가 **정합이 성립할 때만** 정합을
 * 주장하도록 막는 순수 모듈(2026-08-12 감사 결과 확정).
 *
 * ── 왜 별도 모듈인가 ────────────────────────────────────────────────────────
 * lib/scoutLines 는 '선을 어디에 그리나'(기하 → 화면 좌표), 이 모듈은 '정합이 성립하나'(적격성)다.
 * 관심사가 다르고 테스트도 따로 서야 한다. 기하 원시 함수(geomOf/axisOf/vdot/vsub)는
 * scoutLines 에서 **가져다 쓴다** — 사본을 만들면 두 벌이 갈린다(이 저장소에서 실제로 겪은 사고).
 *
 * ── 무엇이 문제였나 (감사 확정) ─────────────────────────────────────────────
 * 예전 nearestSliceIndex 는 타깃 시리즈에서 '법선 투영 거리 최소' 슬라이스를 **무조건 하나**
 * 돌려줬다. FrameOfReference 검사도, 거리 상한도, 두 평면이 평행한지 확인도 없었다. 그래서
 *   · 좌표계(FoR)가 다른 과거검사 → 원점 차가 그대로 mm 거리로 취급돼 엉뚱한 레벨에 붙거나 끝단 고정
 *   · Axial 마스터 ↔ Sagittal 타깃 → 투영값이 슬라이스 범위 밖이라 **항상 가장자리 한 장**
 * 인데도 화면은 "◈ Spatial(해부학적 정합)"이라고 단언했다. **틀린 정합을 맞다고 믿게 하는** 것이
 * 판독에서 가장 위험하다 — 그래서 이 모듈은 "모르면 정합을 주장하지 않는다"로 설계한다.
 *
 * ── 설계 원칙(회귀 방지) ────────────────────────────────────────────────────
 * ① 불성립이면 **null + 사유**를 준다. 호출부는 예전 동작(인덱스 1:1 동기)으로 폴백하고
 *    화면에 사유를 알린다 — 기능이 죽지 않고, 사용자는 '정합이 아님'을 안다.
 * ② FoR 은 **양쪽 다 알고 있고 서로 다를 때만** 거부한다. 모르는 것(빈 값)은 '다르다'의 증거가
 *    아니다. 태그를 아직 수집하지 않는 기존 데이터에서 Crosslink 가 통째로 죽으면 그게 더 큰 사고다.
 * ③ 평행성·거리 임계는 **상수 한 곳**에 두고 테스트로 고정한다.
 */
// ⚠ 확장자 .ts 필수 — node --test(ESM)가 상대 import 를 확장자 없이 못 찾는다(저장소 규율).
import { type Geom, type V3, geomOf, vdot, vsub } from "./scoutLines.ts";

/** 두 평면을 '같은 방향'으로 볼 각도 여유 — cos15°. 이보다 기울면 '같은 레벨' 개념이 없다.
 *  15°인 이유: gantry tilt·AC-PC 경사 같은 정상 촬영 편차는 흡수하고(보통 <15°),
 *  축이 다른 조합(90°)은 확실히 거른다. */
export const PARALLEL_COS = Math.cos((15 * Math.PI) / 180);

/** 최근접 슬라이스가 이보다 멀면 정합이 아니다 — 하한(mm). 타깃 슬라이스 간격이 성기면
 *  아래 FACTOR 쪽이 커져 그 값을 쓴다(얇은 슬라이스에서 과민 거부 방지). */
export const MAX_GAP_MM_FLOOR = 20;
/** 타깃 평균 슬라이스 간격의 몇 배까지 허용하나 — 겹치는 범위 안이면 보통 0.5간격 이내다. */
export const MAX_GAP_SPACING_FACTOR = 3;

export type SyncReason =
  | "ok"
  | "no_geometry"    // 좌표 태그가 없다(구형 CR/DX·2차 캡처 등)
  | "for_mismatch"   // 기준 좌표계가 서로 다르다고 **확인**됐다
  | "not_parallel"   // 단면 방향이 다르다 — '같은 레벨'이 성립하지 않는다
  | "too_far";       // 가장 가까운 슬라이스도 너무 멀다(커버리지가 겹치지 않는다)

export interface SyncResult {
  index: number | null;      // null = 정합 불가(호출부가 폴백)
  reason: SyncReason;
  distanceMm: number | null; // 채택/거부된 최근접 거리(진단·표시용)
}

/** 정합 판정에 필요한 최소 인스턴스 정보 — InstanceNode 의 부분집합. */
export interface SyncSource {
  position?: number[];
  orientation?: number[];
  pixel_spacing?: number[];
  rows?: number;
  cols?: number;
  /** (0020,0052) FrameOfReferenceUID — 없으면 빈 값(판정에서 '모름'으로 다룬다) */
  frame_of_reference_uid?: string;
}

export const forOf = (s: SyncSource | null | undefined): string =>
  (s?.frame_of_reference_uid ?? "").trim();

/** 두 FoR 이 **다르다고 확인**되면 true. 하나라도 모르면 false(모름 ≠ 다름). */
export function forConflict(a: SyncSource | null | undefined, b: SyncSource | null | undefined): boolean {
  const x = forOf(a), y = forOf(b);
  return !!x && !!y && x !== y;
}

const unit = (v: V3): V3 => {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
};

/** 평면의 **중심** 환자좌표 — ImagePositionPatient 는 첫 픽셀(좌상단)이라 그대로 쓰면
 *  기울어진 쌍에서 FOV 절반만큼 편향된다(15°·FOV 250mm 에서 약 30mm). 평행 쌍에서는
 *  보정량이 법선과 직교해 투영값이 그대로다 — 즉 이 보정은 기존 정상 케이스를 바꾸지 않는다. */
export function planeCenter(g: Geom): V3 {
  const cx = ((g.cols || 1) - 1) / 2, cy = ((g.rows || 1) - 1) / 2;
  return [0, 1, 2].map((k) => g.pos[k] + cx * g.cs * g.row[k] + cy * g.rs * g.col[k]);
}

/** 법선 방향 위치(mm) — 슬라이스가 놓인 1차원 좌표. */
export const sliceLoc = (n: V3, p: V3): number => vdot(unit(n), p);

/** 타깃 시리즈의 평균 슬라이스 간격(mm). 못 구하면 0. */
export function meanSpacing(insts: SyncSource[]): number {
  const locs: number[] = [];
  for (const it of insts) {
    const g = geomOf(it);
    if (g) locs.push(sliceLoc(g.n, g.pos));
  }
  if (locs.length < 2) return 0;
  locs.sort((a, b) => a - b);
  return Math.abs(locs[locs.length - 1] - locs[0]) / (locs.length - 1);
}

/**
 * 마스터 슬라이스와 **해부학적으로 같은 레벨**인 타깃 슬라이스 index.
 * 정합이 성립하지 않으면 index=null 과 사유를 준다(호출부가 인덱스 폴백 + 사용자 고지).
 */
export function nearestSlice(master: SyncSource, targets: SyncSource[]): SyncResult {
  const gm = geomOf(master);
  if (!gm) return { index: null, reason: "no_geometry", distanceMm: null };

  // 타깃 대표 인스턴스 — 기하가 있는 첫 장(FoR·방향 판정의 기준)
  let ref: SyncSource | null = null;
  let gref: Geom | null = null;
  for (const it of targets) {
    const g = geomOf(it);
    if (g) { ref = it; gref = g; break; }
  }
  if (!gref || !ref) return { index: null, reason: "no_geometry", distanceMm: null };

  // ① 기준 좌표계 — 다르다고 **확인**될 때만 거부(모르면 통과)
  if (forConflict(master, ref)) return { index: null, reason: "for_mismatch", distanceMm: null };

  // ② 단면 방향 — 평행하지 않으면 '같은 레벨'이 정의되지 않는다(Axial↔Sagittal)
  const nm = unit(gm.n), nt = unit(gref.n);
  if (Math.abs(vdot(nm, nt)) < PARALLEL_COS) {
    return { index: null, reason: "not_parallel", distanceMm: null };
  }

  // ③ 최근접 — 대표점은 평면 **중심**(코너 편향 제거)
  const mLoc = sliceLoc(gref.n, planeCenter(gm));
  let best = -1, bestD = Infinity;
  for (let i = 0; i < targets.length; i++) {
    const gt = geomOf(targets[i]);
    if (!gt) continue;
    const d = Math.abs(mLoc - sliceLoc(gref.n, planeCenter(gt)));
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0) return { index: null, reason: "no_geometry", distanceMm: null };

  // ④ 거리 상한 — 커버리지가 겹치지 않으면 '가장 가까운 한 장'은 정합이 아니라 끝단이다
  const limit = Math.max(MAX_GAP_MM_FLOOR, MAX_GAP_SPACING_FACTOR * meanSpacing(targets));
  if (bestD > limit) return { index: null, reason: "too_far", distanceMm: bestD };

  return { index: best, reason: "ok", distanceMm: bestD };
}

/** 3D Cursor 투영 결과 — 한 페인에 십자선을 찍을 수 있는가. */
export interface CursorHit {
  index: number;    // 이동할 슬라이스
  x: number;        // 이미지 정규화 좌표 0~1
  y: number;
  distanceMm: number;
}

/**
 * 3D 점 P 를 타깃 시리즈에 투영 — 정의상 **방향이 다른 단면에 찍는 것이 목적**이므로
 * 평행성은 검사하지 않는다(Axial 클릭 → Sagittal 십자선이 정상 동작이다).
 * 대신 ① FoR 충돌 ② 평면까지 거리 상한 ③ 이미지 범위(0~1) 밖이면 거부한다 —
 * 볼륨 밖·무관한 검사에 십자선이 찍히면 '없는 병변 위치'를 지시하는 셈이다.
 */
export function projectPoint(
  P: V3, source: SyncSource, targets: SyncSource[],
): CursorHit | null {
  let ref: SyncSource | null = null;
  for (const it of targets) { if (geomOf(it)) { ref = it; break; } }
  if (!ref) return null;
  if (forConflict(source, ref)) return null;

  let best = -1, bd = Infinity;
  for (let k = 0; k < targets.length; k++) {
    const g = geomOf(targets[k]);
    if (!g) continue;
    const d = Math.abs(vdot(unit(g.n), vsub(P, g.pos)));
    if (d < bd) { bd = d; best = k; }
  }
  if (best < 0) return null;

  const limit = Math.max(MAX_GAP_MM_FLOOR, MAX_GAP_SPACING_FACTOR * meanSpacing(targets));
  if (bd > limit) return null;                      // 볼륨(슬랩) 밖 — 지시할 지점이 없다

  const g = geomOf(targets[best])!;
  const dv = vsub(P, g.pos);
  const x = vdot(dv, g.row) / g.cs / (g.cols || 1);
  const y = vdot(dv, g.col) / g.rs / (g.rows || 1);
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;   // FOV 밖 — 잘린 채 인덱스만 튀는 것 방지
  return { index: best, x, y, distanceMm: bd };
}

/** 정합 불가 사유 → 사용자 문구(한국어 원문 = msgid). 호출부가 tr() 로 감싼다. */
export function syncReasonText(r: SyncReason): string {
  switch (r) {
    case "for_mismatch": return "기준 좌표계(Frame of Reference)가 달라 좌표 정합을 쓸 수 없습니다 — 인덱스로 동기합니다";
    case "not_parallel": return "단면 방향이 달라 '같은 레벨'이 성립하지 않습니다 — 인덱스로 동기합니다";
    case "too_far": return "겹치는 촬영 범위가 없어 좌표 정합을 쓸 수 없습니다 — 인덱스로 동기합니다";
    case "no_geometry": return "좌표 정보(DICOM 위치)가 없어 인덱스로 동기합니다";
    default: return "";
  }
}
