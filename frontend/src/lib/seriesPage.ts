// Series 페이지 — 시리즈 수가 Series 분할(페인 수)보다 많을 때의 페이지 계산.
//
// 왜 분리했나: 세 뷰어(SaintView·T-View·I-View)가 같은 규칙으로 넘겨야 하고,
// off-by-one 이 나면 "마지막 시리즈가 안 보인다"처럼 조용히 틀린다. 순수 함수로 두고 수치 검증한다.
//
// 규칙
//  · 시리즈는 **순서대로** 슬롯에 채운다(첫 페이지 0..S-1, 다음 페이지 S..2S-1 …).
//  · 남는 슬롯은 **빈 페인**으로 둔다 — 마지막 시리즈를 반복해 채우지 않는다.
//  · 끝에서 순환하지 않는다(마지막 페이지에서 더 넘겨도 그대로).
//  · 슬롯 = 화면에 보이는 페인 중 **현재 검사(또는 빈)** 페인. 비교(과거검사) 페인은 제외 —
//    페이지를 넘긴다고 비교 배치를 날려버리면 안 된다.

/** 전체 페이지 수(최소 1) */
export function pageCount(total: number, size: number): number {
  const s = Math.max(1, Math.floor(size));
  return Math.max(1, Math.ceil(Math.max(0, total) / s));
}

/** 마지막 페이지 번호(0-base) */
export function lastPage(total: number, size: number): number {
  return pageCount(total, size) - 1;
}

/** 범위 밖 페이지를 잘라 낸다(순환 없음) */
export function clampPage(page: number, total: number, size: number): number {
  return Math.max(0, Math.min(lastPage(total, size), Math.floor(page)));
}

/** 이 페이지가 보여 줄 시리즈 인덱스 범위 [from, to) — to 는 total 로 잘린다 */
export function pageRange(page: number, total: number, size: number): { from: number; to: number } {
  const s = Math.max(1, Math.floor(size));
  const p = clampPage(page, total, s);
  const from = p * s;
  return { from, to: Math.min(Math.max(0, total), from + s) };
}

/** 상태 표시용 라벨 — "3–5 / 5" (1-base). 총 1페이지면 빈 문자열 */
export function pageLabel(page: number, total: number, size: number): string {
  if (lastPage(total, size) <= 0) return "";
  const { from, to } = pageRange(page, total, size);
  return `${from + 1}–${to} / ${total}`;
}

// ── Image 분할(타일) 인덱스 정렬 ─────────────────────────────────────────
/** 타일 분할에서 페인의 시작 인덱스를 **페이지 경계에 맞춘다**.
 *
 *  왜 필요한가: 타일은 `index, index+1, … index+tiles-1` 을 그린다. index 가 경계에 안 맞으면
 *  마지막 타일이 시리즈 범위를 넘어가 **빈 칸**이 된다.
 *  실제 사례 — 2장짜리 CR 을 1×2 로 걸었는데 index 가 1(가운데)이라 `1,2` 를 그려
 *  두 번째 장만 보였다(2번이 없으므로). 0 으로 맞추면 `0,1` 이 되어 둘 다 보인다.
 *
 *  끝 쪽도 맞춘다: total 이 주어지면 마지막 페이지를 넘지 않게 잘라 낸다. */
export function snapTileIndex(index: number, tiles: number, total?: number): number {
  const t = Math.max(1, Math.floor(tiles));
  if (t <= 1) return Math.max(0, Math.floor(index));
  let i = Math.max(0, Math.floor(index));
  if (typeof total === "number" && total > 0) {
    const lastStart = Math.max(0, Math.floor((total - 1) / t) * t);
    i = Math.min(i, lastStart);
  }
  return Math.floor(i / t) * t;
}
