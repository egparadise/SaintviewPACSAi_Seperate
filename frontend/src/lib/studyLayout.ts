/* Study Layout — 화면을 **검사 단위**로 먼저 나눈다(2026-08-20 사용자 확정).
 *
 * 사용자 요구:
 *   "Series layout, image layout 이라는 개념에 Study Layout 을 더하자. 'OOXOO' 형태로 설정한다.
 *    ① Study Layout 을 설정하면 Image Viewer 상단 탭에 떠 있는 **여러 환자의 Study** 를 조합할 수 있다.
 *    ② 즉 Study Layout > Series Layout > Image Layout 개념.
 *    ③ 영상을 연 다음 Study Layout 을 설정하면 현재 환자에 국한되지 않고, 여러 환자의 Study 와
 *       Series 를 마우스 드래그로 조합해 비교할 수 있다.
 *    ④ 모든 뷰어(SaintView·T·I)의 'Srs' 옆에 'STU 1×1' 을 만든다."
 *
 * ── 왜 '합성 격자' 인가 ─────────────────────────────────────────────────
 * 뷰어의 페인은 원래 **평면 목록**(p0…pN)이고 렌더는 `PANE_IDS[행*열수 + 열]` 로 자리를 잡는다.
 * 여기에 진짜 2단 트리를 넣으면 행잉·Compare·Crosslink·주석 좌표까지 전부 손대야 한다.
 *
 * 그래서 계층을 **곱셈으로 편다**:
 *
 *     전체 격자 = (Study 행 × Series 행) × (Study 열 × Series 열)
 *
 * 예) Study 1×2 · Series 2×2 → 전체 2×4. 왼쪽 2×2 가 검사 A, 오른쪽 2×2 가 검사 B.
 * 각 검사 구획(block)은 자기 Series Layout 을 그대로 가진다 — 즉 Series Layout 의 의미가 변하지
 * 않는다. CLAUDE.md 의 2D 분할 캐스케이드(HP→Mammo→Common→뷰어별)는 **Series Layout 에 대한
 * 규정**이므로 그대로 살아 있고, Study Layout 은 그 위를 한 겹 더 나눌 뿐이다.
 *
 * ★ Study 1×1 이면 매핑이 **기존과 완전히 같다**(아래 테스트가 이걸 못 박는다).
 *   그래서 이 기능을 쓰지 않는 사용자에게는 아무 변화가 없다.
 *
 * react·api 무의존 — node 테스트가 직접 부른다.
 */

export interface Grid { r: number; c: number }

export const STUDY_LAYOUT_DEFAULT: Grid = { r: 1, c: 1 };

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n) || lo));

/** 값 정리 — 저장값이 깨져 있어도 화면이 죽지 않게. 최대 10×10(페인 상한과 같다). */
export function readGrid(v: unknown, fallback: Grid = STUDY_LAYOUT_DEFAULT): Grid {
  const g = v as Partial<Grid> | null | undefined;
  if (!g || typeof g.r !== "number" || typeof g.c !== "number") return { ...fallback };
  return { r: clamp(g.r, 1, 10), c: clamp(g.c, 1, 10) };
}

/** 전체(합성) 격자 — 검사 구획을 펼친 실제 행·열. */
export function composeGrid(study: Grid, series: Grid): Grid {
  return { r: study.r * series.r, c: study.c * series.c };
}

/** 검사 구획 개수. */
export function blockCount(study: Grid): number {
  return study.r * study.c;
}

/** 한 구획이 품는 페인 수 = 그 구획의 Series Layout 칸 수. */
export function panesPerBlock(series: Grid): number {
  return series.r * series.c;
}

/**
 * 합성 격자의 (gr, gc) 자리에 놓일 **페인 인덱스**.
 *
 * 페인 번호는 '구획 우선' 으로 매긴다 — 한 구획의 페인들이 연속 번호를 갖는다.
 * 그래야 구획 하나를 통째로 다루는 일(검사 배치·비우기·결합)이 슬라이스 한 번으로 끝난다.
 *
 *   페인 = 구획번호 × 구획당페인수 + 구획안슬롯
 */
export function paneIndexAt(study: Grid, series: Grid, gr: number, gc: number): number {
  const bi = Math.floor(gr / series.r);          // 구획 행
  const bj = Math.floor(gc / series.c);          // 구획 열
  const lr = gr % series.r;                      // 구획 안 행
  const lc = gc % series.c;                      // 구획 안 열
  return (bi * study.c + bj) * panesPerBlock(series) + (lr * series.c + lc);
}

/** 이 자리가 속한 구획 번호. */
export function blockIndexAt(study: Grid, series: Grid, gr: number, gc: number): number {
  return Math.floor(gr / series.r) * study.c + Math.floor(gc / series.c);
}

/** 구획 b 가 품는 페인 인덱스들(연속). */
export function paneIndexesOfBlock(series: Grid, b: number): number[] {
  const n = panesPerBlock(series);
  return Array.from({ length: n }, (_, i) => b * n + i);
}

/** 페인 인덱스 → 구획 번호. 배치·라벨 표시에서 역참조가 필요하다. */
export function blockOfPane(series: Grid, paneIndex: number): number {
  return Math.floor(paneIndex / panesPerBlock(series));
}

/** 이 자리가 구획의 **경계**인가 — 경계선을 굵게 그려 구획을 눈으로 구분하기 위해. */
export function blockEdge(series: Grid, gr: number, gc: number): { top: boolean; left: boolean } {
  return { top: gr % series.r === 0, left: gc % series.c === 0 };
}

/** 전체 격자를 행별 페인 인덱스 표로 — 렌더가 이걸 그대로 돌면 된다. */
export function paneMatrix(study: Grid, series: Grid): number[][] {
  const g = composeGrid(study, series);
  return Array.from({ length: g.r }, (_, gr) =>
    Array.from({ length: g.c }, (_, gc) => paneIndexAt(study, series, gr, gc)));
}

/** 'OOXOO' 표기 — 사용자가 쓴 형태 그대로 화면에 보여 준다(STU 1×1). */
export function gridLabel(g: Grid): string {
  return `${g.r}×${g.c}`;
}

/** 전체 페인 수가 상한(10×10=100)을 넘지 않는가 — 넘으면 그 조합은 고를 수 없다. */
export const MAX_PANES = 100;
export function fitsPaneLimit(study: Grid, series: Grid): boolean {
  const g = composeGrid(study, series);
  return g.r <= 10 && g.c <= 10 && g.r * g.c <= MAX_PANES;
}

/** 구획에 배치된 검사 — 구획 번호 → 검사. 비어 있으면 주 검사를 쓴다(호출부 판단). */
export type StudyBlocks = Record<number, { examId: number; studyUid: string; label?: string }>;

/** 구획 수가 줄면 넘치는 배치는 버린다(남겨 두면 다시 늘렸을 때 유령 배치가 되살아난다). */
export function pruneBlocks(blocks: StudyBlocks, study: Grid): StudyBlocks {
  const n = blockCount(study);
  const out: StudyBlocks = {};
  for (const [k, v] of Object.entries(blocks ?? {})) {
    const i = Number(k);
    if (Number.isInteger(i) && i >= 0 && i < n) out[i] = v;
  }
  return out;
}
