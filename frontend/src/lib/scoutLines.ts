// Scout Line / All Lines / Crosslink 기하 — **3뷰어(SaintView·T-View·I-View) 공용**.
//
// 왜 뽑아내나: 같은 계산이 ViewerInfi 와 Viewer2D 에 **따로** 들어 있어서 두 뷰어의 동작이
// 갈렸다(Viewer2D 는 5개 중 하나만 고르는 단일선택이라 Crosslink+Scout 조합이 아예 불가능했다).
// 규칙을 한 벌만 두고 순수 함수로 빼면 ① 어긋남이 다시 안 생기고 ② 브라우저 없이 테스트할 수 있다.
//
// ■ All Lines 규칙 (사용자 확정)
//   전체 절단선을 보여 주되 **지금 스크롤의 기준이 되는 뷰와 같은 축**만 보여 준다.
//   (기준이 Axial 이면 Axial 전체, Sagittal 이면 Sagittal 전체.)
//   그 안에서 **지금 스크롤 중인 영상**의 선은 색을 달리해 몇 번째인지 알 수 있게 한다.
//   ⚠ 축 필터가 없으면 시리즈에 여러 방향이 섞였을 때(예: 스카우트 + 본 스캔) 관계없는 방향의
//     선까지 전부 겹쳐 그려져 화면이 읽히지 않는다.

export type V3 = number[];

export interface Geom {
  pos: V3; row: V3; col: V3;
  rs: number; cs: number;      // row/col spacing (mm)
  n: V3;                       // 평면 법선
  rows: number; cols: number;
}

/** 기하를 만들 수 있는 최소 인스턴스 정보(뷰어의 InstanceNode 부분집합). */
export interface GeomSource {
  position?: number[];
  orientation?: number[];
  pixel_spacing?: number[];
  rows?: number;
  cols?: number;
}

export const vsub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vdot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a: V3, b: V3): V3 =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** 평면의 지배 축 — 0=Sagittal, 1=Coronal, 2=Axial 근사(법선의 최대 성분).
 *  All Lines 의 '기준 뷰와 같은 축만' 판정과 Crosslink 의 '축별 1개' 제한이 모두 이걸 쓴다. */
export function axisOf(g: Geom): number {
  const a = [Math.abs(g.n[0]), Math.abs(g.n[1]), Math.abs(g.n[2])];
  return a.indexOf(Math.max(...a));
}

export const AXIS_LABEL = ["SAG", "COR", "AX"] as const;

export function geomOf(inst: GeomSource | null | undefined): Geom | null {
  if (!inst) return null;
  if (inst.position?.length !== 3 || inst.orientation?.length !== 6 || inst.pixel_spacing?.length !== 2) {
    return null;
  }
  const row = inst.orientation.slice(0, 3), col = inst.orientation.slice(3, 6);
  return {
    pos: inst.position, row, col,
    rs: inst.pixel_spacing[0], cs: inst.pixel_spacing[1],
    n: vcross(row, col), rows: inst.rows || 1, cols: inst.cols || 1,
  };
}

export interface Segment { x1: number; y1: number; x2: number; y2: number }

/** 소스 평면(src)과 타깃(tgt) 평면의 **정확한 교차선**을 타깃 픽셀좌표로.
 *  타깃 경계를 5% 넘는 범위로 클리핑해 화면을 관통하는 풀 레인지 선을 만든다.
 *  평행 평면이면 null(교차선이 없다).
 *  ⚠ 모서리 투영 근사는 대각선에서 틀려 폐기했다 — 평면 방정식을 그대로 푼다. */
export function scoutSegment(src: Geom, tgt: Geom): Segment | null {
  const nsLen = Math.hypot(...src.n), ntLen = Math.hypot(...tgt.n);
  if (nsLen < 1e-9 || ntLen < 1e-9) return null;
  if (Math.abs(vdot(src.n, tgt.n) / (nsLen * ntLen)) > 0.999) return null;   // 평행
  // 타깃 평면 위 점 Q(x,y) = pos + (x·cs)·row + (y·rs)·col 가 소스 평면 위에 있을 조건:
  //   A·x + B·y + C = 0   (x=열 px, y=행 px)
  const A = vdot(src.n, tgt.row) * tgt.cs;
  const B = vdot(src.n, tgt.col) * tgt.rs;
  const C = vdot(src.n, vsub(tgt.pos, src.pos));
  const mx = Math.max(2, (tgt.cols - 1) * 0.05), my = Math.max(2, (tgt.rows - 1) * 0.05);
  const X0 = -mx, X1 = (tgt.cols - 1) + mx, Y0 = -my, Y1 = (tgt.rows - 1) + my;
  const pts: { x: number; y: number }[] = [];
  const add = (x: number, y: number) => {
    if (x >= X0 - 1e-6 && x <= X1 + 1e-6 && y >= Y0 - 1e-6 && y <= Y1 + 1e-6) pts.push({ x, y });
  };
  if (Math.abs(B) > 1e-9) { add(X0, (-C - A * X0) / B); add(X1, (-C - A * X1) / B); }
  if (Math.abs(A) > 1e-9) { add((-C - B * Y0) / A, Y0); add((-C - B * Y1) / A, Y1); }
  if (pts.length < 2) return null;
  let bi: [number, number] = [0, 1], bd = -1;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      if (d > bd) { bd = d; bi = [i, j]; }
    }
  }
  if (bd < 1e-6) return null;
  return { x1: pts[bi[0]].x, y1: pts[bi[0]].y, x2: pts[bi[1]].x, y2: pts[bi[1]].y };
}

/* ── Crosslink 토글 5종 — I-View 모델이 기준 ─────────────────────────────────
 * 독립 토글이다(단일 선택 아님). Viewer2D 는 union 한 개만 고르는 구조라
 * 'Crosslink + Scout' 같은 조합이 애초에 불가능했다 — 그래서 두 뷰어가 다르게 동작했다. */
export interface XlinkState {
  crosslink: boolean;      // 마스터 — 다중 이미지 연동
  auto_sync: boolean;      // 같은 검사 페인 동기 스크롤
  sync_other: boolean;     // 다른 검사(과거) 페인 동기 스크롤
  scout: boolean;          // 활성 페인 **현재 이미지**의 절단선
  all_lines: boolean;      // 기준 축의 **전체** 절단선
}

export const XLINK_DEFAULT: XlinkState = {
  crosslink: true, auto_sync: true, sync_other: false, scout: true, all_lines: false,
};

/* 이관 함수는 두지 않는다 — **옮길 값이 없다.**
 * 옛 Viewer2D 의 단일선택 xmode 는 useState 로만 살던 화면 상태였고 viewer.prefs 어디에도
 * 저장되지 않았다(뷰어를 열 때마다 "off" 로 시작했다). 그래서 fromLegacyXmode/readXlink 를
 * 만들어 뒀다가 지웠다 — 호출자가 0인 채로 테스트만 초록이면, 없는 기능을 있다고 믿게 된다.
 * 나중에 이 토글을 계정에 저장하기로 하면 그때 읽기 함수를 만들면 된다. */

/* ── All Lines / Scout 소스 선택 ──────────────────────────────────────────── */

export interface LineSource<T> {
  inst: T;
  index: number;       // 시리즈 내 순번(0-base)
  current: boolean;    // 지금 스크롤 중인 영상인가 — 색을 달리한다
}

/**
 * 절단선을 그릴 **소스 이미지들**을 고른다.
 *
 *  · scout 만      → 지금 이미지 1장
 *  · all_lines     → **기준 이미지와 같은 축**의 전체(사용자 확정 규칙)
 *  · 둘 다 꺼짐    → 없음
 *
 * 축 필터가 핵심이다: 기준이 Axial 이면 Axial 전체, Sagittal 이면 Sagittal 전체.
 * 시리즈에 여러 방향이 섞여 있을 때(스카우트가 함께 든 시리즈 등) 관계없는 방향까지
 * 전부 그리면 화면이 선으로 덮여 읽을 수 없다.
 */
export function pickLineSources<T extends GeomSource>(
  instances: T[], activeIndex: number, x: Pick<XlinkState, "scout" | "all_lines">,
): LineSource<T>[] {
  if (!instances?.length) return [];
  if (!x.scout && !x.all_lines) return [];
  const cur = instances[activeIndex];
  if (!cur) return [];
  if (!x.all_lines) return [{ inst: cur, index: activeIndex, current: true }];

  const curG = geomOf(cur);
  // 기준 기하를 못 읽으면 축을 말할 수 없다 → 지금 1장만(전부 그려 화면을 덮지 않는다)
  if (!curG) return [{ inst: cur, index: activeIndex, current: true }];
  const axis = axisOf(curG);

  const out: LineSource<T>[] = [];
  instances.forEach((inst, index) => {
    const g = geomOf(inst);
    if (!g || axisOf(g) !== axis) return;      // ★ 기준 뷰와 같은 축만
    out.push({ inst, index, current: index === activeIndex });
  });
  return out;
}

/** 선 스타일 — 현재 영상은 색·굵기로 구분한다(I-View 기존 규칙 유지). */
export function lineStyle(kind: "current" | "cross" | "other"):
  { color: string; width: number; opacity: number } {
  if (kind === "current") return { color: "#facc15", width: 1.6, opacity: 1 };     // 노랑
  if (kind === "cross")   return { color: "#22d3ee", width: 1.1, opacity: 0.85 };  // 청록(상호참조)
  return { color: "#38bdf8", width: 0.7, opacity: 0.65 };                          // 파랑
}

/** "현재/전체" 라벨 — 전체 중 몇 번째인지. all_lines 에서 축 필터 뒤의 개수를 쓴다. */
export function positionLabel(sources: LineSource<unknown>[], seriesTotal?: number): string {
  const i = sources.findIndex((s) => s.current);
  if (i < 0) return "";
  // ⚠ Scout Line 만 켠 경우 sources 는 **현재 이미지 1장**이라 그대로 세면 언제나 "1/1" 이
  //   된다. 스크롤을 내려도 1/1 이면 라벨이 아무것도 알려 주지 않는다(실제 사용자 지적).
  //   그럴 때는 시리즈 전체를 분모로 삼아 '지금 몇 번째 슬라이스인가' 를 보여 준다.
  //   All Lines 는 선이 여러 개이므로 **축으로 거른 그 집합**이 분모다(그것이 화면에 보이는 전체다).
  if (sources.length <= 1 && seriesTotal && seriesTotal > 1) {
    return `${sources[i].index + 1}/${seriesTotal}`;
  }
  return `${i + 1}/${sources.length}`;
}
