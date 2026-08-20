/* 워크리스트 그리드 정렬(2026-08-19 사용자 확정) — 헤더를 누를 때마다 순/역순이 바뀐다.
 *
 * 사용자 요구: "의뢰 일시는 한 번 클릭하면 최신 시간별로, 다시 누르면 역순, 다시 누르면 최신순.
 *              이름은 ㄱ·ㄴ / a·b 순 또는 역순. 모든 항목이 그렇게 되게."
 *
 * ── 설계 ────────────────────────────────────────────────────────────────
 * ① **첫 클릭의 방향은 컬럼 성격이 정한다.** 날짜·시각·수량은 '최신·많은 것부터'(desc)가
 *    판독 현장에서 기대하는 첫 화면이고, 이름·ID 같은 글자는 ㄱ·a 부터(asc)가 자연스럽다.
 *    같은 규칙을 모든 컬럼에 억지로 적용하면 "왜 오래된 것부터 나오지?"가 된다.
 * ② 한글은 코드포인트 순서가 사전 순서와 어긋나므로 **localeCompare("ko")** 로 비교한다
 *    ("가" < "나" 는 맞지만 정렬 안정성·자모 결합 때문에 로케일 비교가 옳다).
 * ③ 빈 값은 **항상 뒤로** — 방향을 뒤집어도 빈 칸이 위로 올라오지 않는다(빈 줄이 먼저 보이면
 *    목록을 잘못 읽는다).
 * ④ 정렬은 순수 함수 — 원본 배열을 건드리지 않고 새 배열을 준다.
 *
 * react·api 무의존 — node 테스트가 직접 부른다.
 */

export type SortDir = "asc" | "desc";
export interface SortState { key: string; dir: SortDir }

/** 큰 값이 먼저 보여야 자연스러운 컬럼 — 첫 클릭이 내림차순이 된다. */
export const DESC_FIRST_KEYS = new Set([
  "study_date", "study_time", "study_datetime", "request_datetime", "finalized_at", "birth_date",
  "age", "series_count", "instance_count", "priority",
]);

/** 정렬에 쓸 원본 값 — 화면 렌더(ReactNode)가 아니라 **데이터**를 본다.
 *  일부 컬럼은 표시용 키와 데이터 키가 달라 여기서 이어 준다. */
export function sortValue(row: Record<string, unknown>, key: string): string | number {
  const raw = (() => {
    switch (key) {
      // 표시 컬럼 ↔ 데이터 필드가 다른 것들
      case "priority": return row.emergency ? 1 : 0;          // 응급이 위로
      case "read_state": return row.read_state ?? row.status;
      case "ai": return row.report_status ?? "";
      case "impression": return row.impression_preview ?? "";
      case "hospital_name": return row.hospital_name ?? row.institution;
      case "order_name": return row.order_name ?? row.study_desc;
      default: return row[key];
    }
  })();
  if (typeof raw === "number") return raw;
  if (typeof raw === "boolean") return raw ? 1 : 0;
  const s = String(raw ?? "").trim();
  // 순수 숫자 문자열(Img 수량 등)은 숫자로 — "9" 가 "10" 뒤에 오는 사고 방지
  if (s && /^\d+$/.test(s)) return Number(s);
  return s;
}

/** 이 컬럼을 처음 눌렀을 때의 방향. */
export function firstDir(key: string): SortDir {
  return DESC_FIRST_KEYS.has(key) ? "desc" : "asc";
}

/** 헤더 클릭 → 다음 정렬 상태. 같은 컬럼이면 방향만 뒤집는다(순 ↔ 역, 무한 반복). */
export function nextSort(cur: SortState | null, key: string): SortState {
  if (cur?.key === key) return { key, dir: cur.dir === "asc" ? "desc" : "asc" };
  return { key, dir: firstDir(key) };
}

const collator = typeof Intl !== "undefined"
  ? new Intl.Collator("ko", { numeric: true, sensitivity: "base" })
  : null;

/** 두 값 비교(오름차순 기준). 빈 값은 언제나 뒤로 간다. */
export function compareValues(a: string | number, b: string | number): number {
  const aEmpty = a === "" || a === null || a === undefined;
  const bEmpty = b === "" || b === null || b === undefined;
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;      // ③ 빈 값은 뒤로 — 방향과 무관하게
  if (bEmpty) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const as = String(a), bs = String(b);
  return collator ? collator.compare(as, bs) : (as < bs ? -1 : as > bs ? 1 : 0);
}

/** 정렬된 **새 배열**. 상태가 없으면 원본 순서 그대로(서버가 준 순서 = 기본 정렬). */
export function sortRows<T>(rows: T[], sort: SortState | null): T[] {
  if (!sort?.key) return rows;
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((x, y) => {
    const a = sortValue(x as Record<string, unknown>, sort.key);
    const b = sortValue(y as Record<string, unknown>, sort.key);
    // ③ 빈 값은 **부호를 곱하기 전에** 뒤로 보낸다 — compareValues 결과에 sign 을 곱하면
    //    역순일 때 빈 칸이 맨 위로 올라온다(목록을 잘못 읽게 되는 실제 함정).
    const aE = a === "";
    const bE = b === "";
    if (aE || bE) return aE && bE ? 0 : aE ? 1 : -1;
    const c = compareValues(a, b);
    if (c !== 0) return c * sign;
    return 0;   // 동률은 원래 순서 유지(Array.prototype.sort 는 안정 정렬)
  });
}

/** 헤더에 붙일 방향 표식 — 정렬 중인 컬럼만. */
export function sortMark(sort: SortState | null, key: string): string {
  if (sort?.key !== key) return "";
  return sort.dir === "asc" ? " ▲" : " ▼";
}
