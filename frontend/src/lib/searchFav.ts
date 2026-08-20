/* Search Favorite — 워크리스트 통합 검색의 **조건 나열 문법**(2026-08-19 사용자 확정).
 *
 * 사용자 요구: "'센터#MR#병원명#미판독' 처럼 입력하면 조건 값들을 인식해 검색하고,
 *              저장 버튼으로 그 식을 즐겨찾기에 남긴다. 판독 상태(요청·확정·판독중)와
 *              워크리스트 항목 구성의 **모든 값**을 검색 조건으로 쓸 수 있어야 한다."
 *
 * ── 설계 ────────────────────────────────────────────────────────────────
 * ① `#` 로 토큰을 나누고 각 토큰이 무엇인지 **스스로 판정**한다(순서 무관):
 *      · 상태 낱말(미판독/요청/판독중/확정…)  → 서버 status 필터
 *      · 모달리티 코드(CT·MR·DX…)             → 서버 modality 필터
 *      · `필드=값` / `필드:값` 명시형          → 그 컬럼만 대조(그림4 '워크리스트 항목 구성' 전부)
 *      · 그 밖                                  → 자유어(모든 표시 값 대상)
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

/** 모달리티 코드 — 대문자 2~3자만으로는 오탐이 나므로 알려진 목록으로 제한한다. */
export const FAV_MODALITIES = [
  "CT", "MR", "MRI", "DX", "CR", "US", "MG", "NM", "PT", "PET", "XA", "RF", "OT", "SC", "ES",
];

export interface FavCond {
  /** 컬럼 키(명시형 `필드=값`). 빈 값이면 자유어(모든 표시 값 대상) */
  field: string;
  value: string;
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

/**
 * `센터#MR#병원명#미판독` → 조건.
 * labelToKey: 한글 컬럼 라벨 → 컬럼 키(호출부가 COLUMN_DEFS 로 만들어 넘긴다 — 순수성 유지).
 */
export function parseFavQuery(text: string, labelToKey: Record<string, string> = {}): FavQuery {
  const out: FavQuery = { server: {}, client: [], notes: [] };
  for (const raw of (text ?? "").split("#")) {
    const tok = raw.trim();
    if (!tok) continue;

    // ① 명시형 — `필드=값` / `필드:값`
    const m = tok.match(/^([^=:]+)\s*[=:]\s*(.+)$/);
    if (m) {
      const key = labelToKey[m[1].trim()] ?? labelToKey[norm(m[1])] ?? m[1].trim();
      const val = m[2].trim();
      if (val) {
        out.client.push({ field: key, value: val });
        out.notes.push(`${m[1].trim()}=${val}`);
      }
      continue;
    }

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

    // ④ 자유어 — 모든 표시 값 대상
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

/** 한 조건이 행에 맞는가. 명시형은 그 컬럼만, 자유어는 표시 값 전체. */
export function matchesCond(row: Record<string, unknown>, c: FavCond): boolean {
  const want = norm(c.value);
  if (!want) return true;
  if (c.field) {
    const v = row?.[c.field];
    return String(v ?? "").toLowerCase().includes(want);
  }
  return rowHaystack(row).includes(want);
}

/** 조건 전부(AND)를 만족하는 행만 남긴다. 조건이 없으면 원본 그대로(=필터 없음). */
// 제네릭 제약을 두지 않는다 — StudyRow 같은 **인터페이스**는 인덱스 시그니처가 없어
// Record<string, unknown> 에 할당되지 않는다(호출부가 캐스팅을 흩뿌리게 되는 흔한 함정).
export function applyFavFilter<T>(rows: T[], conds: FavCond[]): T[] {
  if (!conds?.length) return rows;
  return rows.filter((r) => conds.every((c) => matchesCond(r as Record<string, unknown>, c)));
}

/** 이 입력을 Search Favorite 문법으로 볼 것인가 — `#` 가 있으면 조건 나열로 읽는다. */
export function looksLikeFavQuery(text: string): boolean {
  return (text ?? "").includes("#");
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
