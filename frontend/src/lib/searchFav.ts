/* Search Favorite — 워크리스트 검색의 **조건 나열**(2026-08-19 사용자 확정).
 *
 * 사용자 요구: "'센터#MR#병원명#미판독' 처럼 입력하면 조건 값들을 인식해 검색하고,
 *              저장 버튼으로 그 식을 즐겨찾기에 남긴다. 판독 상태(요청·확정·판독중)와
 *              워크리스트 항목 구성의 **모든 값**을 검색 조건으로 쓸 수 있어야 한다."
 *
 * ⚠ **`#` 은 문법이 아니다**(2026-08-20 사용자 확정). 조건을 여러 개 쓸 때 사이를 끊는
 *   **구분자**일 뿐이다. 그러니 `#` 이 있는지로 "이건 Fav 검색"을 판정하면 안 된다 —
 *   조건이 하나뿐이면(`CT`) `#` 이 없고, 그래도 Fav 검색이어야 한다. 판정은 **검색창 모드**가
 *   한다(FAV/일반/AI). 예전에 `#` 유무로 갈랐더니 `CT` 한 조건이 일반 검색어로 나가
 *   환자ID·이름에서 "CT" 를 찾다가 0건이 됐다.
 *
 * 사용자는 **값만 나열**한다. `항목=값` 같은 걸 외우게 하지 않는다 — 어느 항목인지는
 * 프로그램이 알아본다.
 *
 * ── 설계 ────────────────────────────────────────────────────────────────
 * ① `#` 로 토큰을 나누고 각 토큰이 무엇인지 **스스로 판정**한다(순서 무관):
 *      · 상태 낱말(미판독/요청/판독중/확정…)  → 서버 status 필터
 *      · 모달리티 코드(CT·MR·DX…)             → 서버 modality 필터
 *      · 그 밖                                  → 값(워크리스트 항목 전체와 대조)
 * ② 서버가 아는 조건(status·modality)만 질의로 보내고, 나머지는 **받은 목록에서** 거른다.
 *    워크리스트는 상한 1000건이라 이 방식이 실용적이고, 백엔드를 건드리지 않아 회귀면이 없다.
 * ③ 토큰 사이는 **AND** 다 — 조건을 나열한 것이므로 전부 만족해야 한다
 *    (통합 검색의 AND/OR 설정은 '한 칸에 띄어 쓴 낱말'에 적용되는 별개 규칙이라 건드리지 않는다).
 *
 * 이 모듈은 react·api 를 모르는 순수 로직 — node 테스트가 직접 부른다.
 */

/** 상태 낱말 → 서버 status 코드. 화면 표기(요청·확정)와 판독의 말버릇(미판독)을 함께 받는다. */
export const FAV_STATUS_WORDS: Record<string, string> = {
  "미판독": "received", "요청": "received", "대기": "received",
  "판독중": "reading", "읽는중": "reading",
  "확정": "finalized", "판독완료": "finalized", "판독": "finalized", "완료": "finalized",
  "보류": "suspended", "초안": "draft", "ai초안": "draft_ready", "검토중": "in_review",
};

/** 조건 나열 검색이 훑는 범위 — **전 항목**(2026-08-20 사용자 확정).
 *  사용자가 어느 항목인지 지정하지 않으므로 토큰 하나가 이 전부를 OR 로 훑고, 토큰끼리 AND 다.
 *  백엔드 study_service._QUERY_FIELD_COLS 와 1:1 — 한쪽만 늘리면 조용히 갈린다.
 *  ⚠ 통합 검색창의 사용자 설정 범위(SB_FIELDS)와는 다른 것이다. 그건 '일반 검색'의 범위다. */
export const FAV_SCOPE = [
  "pid", "pname", "accession", "desc", "institution", "body_part", "ref_phys", "memo",
  "modality", "dept",
];

/** 서버 q 로 넘길 토큰들 — 상태·장비처럼 **전용 필터로 승격된 것은 빠진다**.
 *  (상태는 텍스트로 절대 안 잡히는 코드값이고, 장비는 정확 일치가 더 옳다.) */
export function favTokens(q: FavQuery): string[] {
  return q.client.map((c) => c.value).filter(Boolean);
}

/** 모달리티 코드 — 대문자 2~3자만으로는 오탐이 나므로 알려진 목록으로 제한한다. */
export const FAV_MODALITIES = [
  "CT", "MR", "MRI", "DX", "CR", "US", "MG", "NM", "PT", "PET", "XA", "RF", "OT", "SC", "ES",
];

export interface FavCond {
  /** 대조할 컬럼 키. 빈 값이면 **모든 항목** 대상(기본) — 사용자는 값만 쓰기 때문이다. */
  field: string;
  value: string;
  /** 정확히 같아야 하는가(기본은 부분 일치). 상태 코드처럼 값이 서로 겹치는 축에 쓴다
   *  — 'draft' 가 'draft_ready' 에 걸리면 안 된다. */
  exact?: boolean;
}

export interface FavQuery {
  /** 서버로 보낼 필터 — 기존 WlFilters 키만 쓴다(status·modality) */
  server: Record<string, string>;
  /** 받은 목록에서 거를 조건들(AND) */
  client: FavCond[];
  /** 인식 결과 요약 — 사용자에게 "무엇으로 읽었는지" 보여 주기 위한 것 */
  notes: string[];
}

const norm = (s: string) => s.trim().toLowerCase();

/** `센터#MR#병원명#미판독` → 조건. `CT` 한 개짜리도 그대로 통한다(`#` 은 구분자일 뿐). */
export function parseFavQuery(text: string): FavQuery {
  const out: FavQuery = { server: {}, client: [], notes: [] };
  for (const raw of (text ?? "").split("#")) {
    const tok = raw.trim();
    if (!tok) continue;

    // ② 상태 낱말
    const st = FAV_STATUS_WORDS[tok] ?? FAV_STATUS_WORDS[norm(tok)];
    if (st) {
      out.server.status = st;
      out.notes.push(`${tok}(상태)`);
      continue;
    }

    // ③ 모달리티 코드
    if (FAV_MODALITIES.includes(tok.toUpperCase())) {
      const mod = tok.toUpperCase() === "MRI" ? "MR" : tok.toUpperCase() === "PET" ? "PT" : tok.toUpperCase();
      out.server.modality = mod;
      out.notes.push(`${mod}(장비)`);
      continue;
    }

    // ④ 그 밖 — 워크리스트 항목 전체와 대조(사용자는 값만 쓴다)
    out.client.push({ field: "", value: tok });
    out.notes.push(tok);
  }
  return out;
}

/** 행에서 검색 대상이 되는 문자열들 — 표시 값 전부(숫자 포함). */
export function rowHaystack(row: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const v of Object.values(row ?? {})) {
    if (typeof v === "string") parts.push(v);
    else if (typeof v === "number") parts.push(String(v));
  }
  return parts.join(" ").toLowerCase();
}

/** 한 조건이 행에 맞는가. field 가 지정된 경우만 그 컬럼, 기본은 항목 전체. */
export function matchesCond(row: Record<string, unknown>, c: FavCond): boolean {
  const want = norm(c.value);
  if (!want) return true;
  if (c.field) {
    const v = norm(String(row?.[c.field] ?? ""));
    return c.exact ? v === want : v.includes(want);
  }
  return rowHaystack(row).includes(want);
}

/**
 * 실제로 **받은 목록에서 걸러야 할** 조건들.
 *
 * 서버가 아는 축(status·modality)은 질의로 승격하는 것이 기본이지만, **Live(원격 A 직결)는
 * status 파라미터 자체가 없다**(worklistQuery 의 LIVE_QUERY_KEYS: q·pid·pname·modality·기간만).
 * 그래서 승격만 하고 끝내면 '센터#MR#병원명#미판독' 의 마지막 조건이 **아무 데서도 걸리지 않고
 * 증발한다** — 사용자는 미판독만 보려 했는데 확정된 검사까지 섞여 나온다.
 *
 * 여기서 그 축을 클라이언트 조건으로 돌려놓는다. Live 행의 status 값은
 * received / reading / finalized 로 이 파일의 상태 낱말 매핑과 같은 코드다(webpacs_live._map_status).
 */
export function clientCondsFor(
  q: FavQuery, opts: { liveMode?: boolean; statusOnServer?: (s: string) => boolean } = {},
): FavCond[] {
  // 일반(로컬 DB) 모드 — 토큰을 q·qf·qop 로 넘겨 **서버가 전부 걸렀다**. 여기서 또 거르면
  // 서버가 어떤 컬럼에서 맞혔는지에 따라 멀쩡한 행이 사라진다(이중 필터로 0건이 되는 사고).
  if (!opts.liveMode) return [];
  // Live(원격 A 직결) — A 의 study_search 는 센터명·병원명을 훑지 않아 q 를 보내지 않는다.
  // 그래서 값 조건은 여기서 건다.
  const out = [...q.client];
  // 상태는 A 가 **일부만** 걸러 줄 수 있다(판독중·확정). 걸러 주는 상태는 여기서 또 거르지 않고,
  // 못 거르는 상태(미판독 — AI 가 섞일 수 있다)만 클라이언트가 맡는다.
  // 판정은 호출부가 넘긴다(이 모듈은 Live 파라미터 목록을 모른다 — 그건 worklistQuery 의 몫).
  if (q.server.status && !(opts.statusOnServer?.(q.server.status) ?? false)) {
    out.push({ field: "status", value: q.server.status, exact: true });
  }
  return out;
}

/** 조건 전부(AND)를 만족하는 행만 남긴다. 조건이 없으면 원본 그대로(=필터 없음). */
// 제네릭 제약을 두지 않는다 — StudyRow 같은 **인터페이스**는 인덱스 시그니처가 없어
// Record<string, unknown> 에 할당되지 않는다(호출부가 캐스팅을 흩뿌리게 되는 흔한 함정).
export function applyFavFilter<T>(rows: T[], conds: FavCond[]): T[] {
  if (!conds?.length) return rows;
  return rows.filter((r) => conds.every((c) => matchesCond(r as Record<string, unknown>, c)));
}

// ── 저장 목록(계정 로밍: worklist.prefs.search_favs) ─────────────────────
export interface SearchFav {
  name: string;    // 표시 이름
  query: string;   // 원문 식(예: 센터#MR#병원명#미판독)
}

/** 저장·수정 공용 — 같은 이름이면 덮어쓰고, 없으면 뒤에 붙인다(원본은 건드리지 않는다). */
export function upsertFav(list: SearchFav[], item: SearchFav): SearchFav[] {
  const name = item.name.trim();
  if (!name) return list;
  const next = [...(list ?? [])];
  const i = next.findIndex((f) => f.name === name);
  if (i >= 0) next[i] = { name, query: item.query };
  else next.push({ name, query: item.query });
  return next;
}

export function removeFav(list: SearchFav[], name: string): SearchFav[] {
  return (list ?? []).filter((f) => f.name !== name);
}

/** 저장된 값이 깨져 있어도 화면이 죽지 않게 — 배열·필수 필드만 통과시킨다. */
export function readFavs(value: unknown): SearchFav[] {
  const arr = (value as { search_favs?: unknown })?.search_favs;
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x): x is SearchFav =>
      !!x && typeof (x as SearchFav).name === "string" && typeof (x as SearchFav).query === "string")
    .map((x) => ({ name: x.name, query: x.query }));
}
