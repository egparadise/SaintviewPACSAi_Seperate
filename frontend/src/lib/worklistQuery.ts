/* 워크리스트 조회 질의(committed query) — 순수 함수 모듈
 *
 * 왜 별도 모듈인가
 * ────────────────
 * 기획(커밋 7c5d360 본문)의 계약은 "기본 **수동** — SEARCH 를 눌러야만 갱신된다. Live 도 같은
 * 규칙을 따른다" 이다. 그런데 구현은 조회 effect 가 filters/searchText(=입력 상태)를 직접
 * 의존하는 바람에, 수동 모드인데도 SEARCH 칸에 한 글자만 쳐도 /api/worklist 가 나가고 그리드가
 * 바뀌었다. 원인은 '입력한 조건'과 '조회에 쓰는 조건'을 구분하지 않은 것이다.
 *
 * 그래서 조회에 쓰는 조건을 **committed(확정 스냅샷)** 로 분리하고, 서버 파라미터를 만드는 일은
 * 여기 순수 함수로 뺐다. React 상태에 묶여 있으면 규칙을 테스트할 수가 없어서, 규정이 조용히
 * 깨진 채 배포되는 사고가 이 저장소에서 이미 있었다(2D 행잉 폴백). 여기 함수들은
 * frontend/tests/worklist_query.test.mjs 가 원본 그대로 import 해 진리표를 검증한다.
 */


import { FAV_SCOPE, favTokens, parseFavQuery } from "./searchFav.ts";

export type WlFilters = Record<string, string>;

/** 확정된(=SEARCH 로 커밋된) 검색 조건. 조회는 오직 이 값으로만 나간다. */
export interface CommittedQuery {
  filters: WlFilters;
  searchText: string;
  /** 검색창이 FAV 모드인가(2026-08-20 사용자 확정 — `#` 유무로 판정하지 않는다).
   *  참이면 입력은 '조건 나열'이므로 **서버 검색어로 보내지 않는다**. */
  favMode?: boolean;
}

/** filters 키 그대로 서버 파라미터가 되는 항목들 (날짜만 별도 변환) */
export const WL_PASSTHROUGH_KEYS = [
  "pid", "pname", "sex", "desc", "modality", "status", "body_part", "finding", "emergency", "key",
] as const;

/** Live(원격 A 직결)에서 지원하는 파라미터 — 나머지 필터는 라이브에선 무시된다 */
export const LIVE_QUERY_KEYS = [
  "q", "pid", "pname", "modality", "date_from", "date_to", "limit", "offset",
] as const;

/**
 * 확정 조건 → /api/worklist 파라미터.
 * 날짜 우선순위: 검색 폴더/기간 프리셋(tree_from)이 직접 입력한 From 을 **덮는다**.
 * (폴더·프리셋은 '이 기간을 보겠다'는 나중의 명시적 액션이므로 그쪽이 이긴다 — 기존 동작 유지)
 */
export function buildWorklistQuery(c: CommittedQuery): Record<string, string> {
  const f = c.filters ?? {};
  const p: Record<string, string> = { q: c.searchText ?? "" };
  // ── FAV(조건 나열) — 토큰 하나가 **전 항목을 OR 로** 훑고, 토큰끼리는 AND (2026-08-20 사용자 확정)
  //   "대자인병원#CT#CHEST = 대자인병원이 어딘가에 있고, CT 가 어딘가에 있고, CHEST 가 어딘가에
  //    있는 검사" — 순서도 필드 지정도 필요 없다.
  //   서버 쿼리 빌더가 이미 그 구조다(study_service._apply_worklist_filters:
  //   토큰 = 범위 필드 OR / 토큰 사이 = qop). 그래서 범위(qf)를 전 항목으로, 결합(qop)을 and 로
  //   넘기기만 하면 된다 — 서버 변경은 검색 범위에 장비·부서를 더한 것뿐이다.
  //   ⚠ 원문을 그대로 q 로 넘기면 안 된다. '#' 이 섞인 한 덩어리를 찾다가 언제나 0건이 된다(실제 사고).
  //   ⚠ 상태(미판독 등)만 예외 — 텍스트로는 절대 안 잡히는 코드값이라 status 필터로 따로 건다.
  if (c.favMode) {
    p.q = favTokens(parseFavQuery(c.searchText ?? "")).join(" ");   // 공백 = 서버의 토큰 구분자
    p.qf = FAV_SCOPE.join(",");
    p.qop = "and";
  }
  for (const k of WL_PASSTHROUGH_KEYS) {
    if (f[k]) p[k] = f[k];
  }
  if (f.date_from_iso) p.date_from = f.date_from_iso.replaceAll("-", "");
  if (f.date_to_iso) p.date_to = f.date_to_iso.replaceAll("-", "");
  if (f.tree_from) p.date_from = f.tree_from;
  return p;
}

/** Live 워크리스트 파라미터 — 지원 키만 추린다(빈 값 제외).
 *  ⚠ FAV(조건 나열)에서는 **q 를 보내지 않는다**. A 의 study_search 가 어떤 컬럼을 훑는지
 *    우리가 정할 수 없어서, 보냈다가 A 가 못 찾으면 그 행은 아예 오지 않는다(되돌릴 수 없는 누락).
 *    Live 는 장비·기간으로만 좁히고 나머지 조건은 받은 목록에서 건다(clientCondsFor). */
export function toLiveParams(q: Record<string, string>,
                             opts: { favMode?: boolean } = {}): Record<string, string | number> {
  const lp: Record<string, string | number> = {};
  for (const k of LIVE_QUERY_KEYS) {
    if (k === "q" && opts.favMode) continue;
    const v = q[k];
    if (v) lp[k] = v;
  }
  return lp;
}

/** 두 조건이 실질적으로 같은가 — 빈 값은 무시(키 순서·빈 문자열 차이로 오탐 나지 않게). */
export function sameFilters(a: WlFilters, b: WlFilters): boolean {
  const ka = Object.keys(a ?? {}).filter((k) => a[k]);
  const kb = Object.keys(b ?? {}).filter((k) => b[k]);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

/**
 * 입력했지만 아직 SEARCH 로 커밋되지 않은 조건이 있는가.
 * 목록을 바꾸지는 않고(그건 계약 위반), 버튼/필터바에 '● 조건 변경됨' 을 띄우는 데만 쓴다 —
 * 안 눌러도 바뀌는 것만큼이나 '왜 안 바뀌지?' 로 헤매는 것도 문제이기 때문이다.
 */
export function isQueryDirty(committed: CommittedQuery, filters: WlFilters, searchText: string): boolean {
  return !sameFilters(committed.filters ?? {}, filters ?? {})
    || (committed.searchText ?? "").trim() !== (searchText ?? "").trim();
}

/** worklist.prefs 의 default_status 를 상태필터에 주입할지 여부 + 주입할 값. */
export interface DefaultStatusDecision {
  inject: boolean;
  /** 주입할 값이자 다음 비교의 기준. "" = *Any 상태 */
  next: string;
}

/**
 * 설정의 '기본 상태 필터'(worklist.prefs.default_status)를 지금 주입해야 하는가.
 *
 * 이 판정이 양쪽으로 한 번씩 기울어 두 번 지적을 받았다 —
 *   · 로드할 때마다 무조건 주입: 사용자가 카운트칩으로 바꿔 둔 상태필터가, 설정에서 아무것도
 *     안 바꾸고 [저장]만 눌러도 병원 기본값으로 되돌아갔다.
 *   · '최초 1회만' 래치: 반대로 설정에서 기본 상태 필터를 **실제로 고쳐** 저장해도 그 세션에서는
 *     필터바도 목록도 그대로여서, 새로고침해야 반영됐다.
 * 두 요구를 동시에 만족시키는 기준은 '한 번이라도 읽었는가' 가 아니라 '마지막으로 반영한 값과
 * 달라졌는가' 다. last=null 은 아직 한 번도 못 읽은 상태(=최초 로드)를 뜻한다.
 */
export function defaultStatusInjection(
  last: string | null, incoming: string | null | undefined,
): DefaultStatusDecision {
  const next = incoming ?? "";
  return { inject: last !== next, next };
}

/**
 * SSE `changed_studies` → **다운로드 모드 무효화에 넘길 워크리스트 행 id(vid) 목록**.
 *
 * 두 가지가 동시에 틀려 있었다(둘 다 '무효화가 아무 일도 안 함'으로 귀결됐다):
 *   ① ID 공간 불일치 — `changed_studies` 는 A 원본 **study_idx**(작은 정수)이고, 스케줄러 큐의
 *      studyId 는 워크리스트 행 id = **vid = VID_BASE + study_idx** 다. 그대로 넘기면
 *      `ids.has(q.studyId)` 가 구조적으로 절대 참이 될 수 없어, A 에서 픽셀이 교체된 검사의
 *      로컬 저장본이 폐기되지 않고 **낡은 영상이 만료 없이 계속 판독 화면에 뜬다**.
 *   ② 누적 목록 — 백엔드가 `(기존 + 신규)[-200:]` 로 쌓기만 하고 소비 후 비우지 않는다. 오프셋만
 *      고치면 rev 가 오를 때마다 누적 200건을 매번 다시 폐기해 '지우고 다시 받기' 폭주가 된다.
 *
 * 그래서 이전 스냅샷과 **등장 횟수**를 비교해 새로 늘어난 것만 고른다(같은 검사가 두 번 바뀌면
 * 목록에 두 번 들어오므로 '봤는가'(Set)로 비교하면 두 번째 변경을 통째로 놓친다).
 * vidBase 를 인자로 받는 이유: 이 모듈은 api.ts(무거운 모듈)를 import 하지 않는다.
 */
export function freshChangedVids(
  prev: Map<number, number>, list: number[] | undefined, vidBase: number,
): { vids: number[]; next: Map<number, number> } {
  const next = new Map<number, number>();
  for (const i of list ?? []) next.set(i, (next.get(i) ?? 0) + 1);
  const vids: number[] = [];
  for (const [idx, n] of next) if (n > (prev.get(idx) ?? 0)) vids.push(idx + vidBase);
  return { vids, next };
}

/* ── 다운로드 모드 대상 결정 ─────────────────────────────────────────────────
 * 사용자 규칙(확정): **무조건 받지 않는다.**
 *   ① Search Filter 에 조건이 있으면 → 그 조건의 **최신 데이터**를 기준으로 받는다.
 *   ② 조건이 하나도 없으면 → **첫 이미지를 연 시각**을 기준으로, 그 이후 것만 받는다.
 *
 * 왜 ② 가 '아무것도 안 받음' 이 아니라 '연 시각 기준' 인가: 조건 없는 워크리스트는 곧
 * 전체 아카이브다. 그걸 통째로 받으면 디스크·회선·원격 PACS 를 다 때리면서 정작 지금
 * 판독할 검사는 뒤로 밀린다. 판독을 시작한 시점부터가 '이 세션에서 볼 것' 이므로
 * 그때를 기준선으로 삼는다. 아직 아무것도 안 열었으면 기준선이 없으니 받지 않는다.
 */

/** 사용자가 실제로 건 조건이 있는가.
 *  ⚠ status 는 **설정의 기본 상태 필터**가 자동 주입될 수 있다(defaultStatusInjection).
 *     자동 주입까지 '조건' 으로 세면 사용자가 아무것도 안 걸어도 ① 로 빠져 전체를 받는다.
 *     그래서 자동 주입된 값과 같으면 조건으로 세지 않는다. */
export function hasUserConditions(c: CommittedQuery, autoStatus = ""): boolean {
  if (c.searchText.trim()) return true;
  return Object.entries(c.filters).some(([k, v]) => {
    const s = String(v ?? "").trim();
    if (!s) return false;
    if (k === "status" && s === String(autoStatus ?? "").trim()) return false;
    return true;
  });
}

export interface DlScopeInput {
  committed: CommittedQuery;
  autoStatus?: string;
  /** 첫 이미지를 연 시각(epoch ms). 아직 안 열었으면 0 */
  openedAt: number;
  /** 워크리스트 행 — 서버가 준 최신순 그대로 */
  rows: { studyDate: string; studyTime?: string }[];
}

export interface DlScopeDecision {
  /** 받을 행의 인덱스(rows 기준). 비어 있으면 받지 않는다 */
  take: number[];
  reason: "filtered" | "since-open" | "idle";
}

/** 'YYYYMMDD' + 'HHMM(SS)' → epoch ms. 값이 부실하면 0(=비교에서 제외). */
export function studyEpoch(date: string, time?: string): number {
  const d = String(date ?? "").trim();
  if (!/^\d{8}$/.test(d)) return 0;
  const t = String(time ?? "").replace(/\D/g, "").padEnd(6, "0").slice(0, 6);
  const ms = Date.parse(
    `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T`
    + `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`);
  return Number.isFinite(ms) ? ms : 0;
}

/** 다운로드 대상 결정 — 위 규칙 ①②를 그대로 옮긴 것. */
export function decideDlScope(i: DlScopeInput): DlScopeDecision {
  if (hasUserConditions(i.committed, i.autoStatus)) {
    // ① 조건이 있다 — 그 조건의 결과가 곧 대상이다(정렬은 서버가 최신순 보장).
    return { take: i.rows.map((_, n) => n), reason: "filtered" };
  }
  if (!i.openedAt) return { take: [], reason: "idle" };   // 아직 아무것도 안 열었다
  // ② 조건이 없다 — 첫 이미지를 연 시각 이후 검사만.
  //    검사시각을 못 읽는 행은 제외한다(모르면 안 받는다 — 전체를 받는 쪽으로 기울면 안 된다).
  const take: number[] = [];
  i.rows.forEach((r, n) => {
    const e = studyEpoch(r.studyDate, r.studyTime);
    if (e && e >= i.openedAt) take.push(n);
  });
  return { take, reason: "since-open" };
}
