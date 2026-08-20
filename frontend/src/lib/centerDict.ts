/* 판독센터 이름 사전 — 조건 나열 검색에서 '이 토큰은 센터다' 를 알아보기 위한 것(2026-08-21).
 *
 * ── 왜 필요한가 ────────────────────────────────────────────────────────
 * 조건 나열 검색은 사용자가 **값만** 준다(`써밋영상의원#CT#CHEST`). 어느 항목인지 말하지 않는
 * 것이 이 기능의 요지다. 그런데 A(원격 PACS)의 free-text 검색이 OR 로 훑는 컬럼은
 *
 *     study_modality · study_description · study_body_part · patient_name · patient_id ·
 *     patient_idx · **hospital_name**            (webpacs_api dependencies/Study.get_study_search)
 *
 * 여기에 **center_name 만 빠져 있다**. 그래서 센터명을 A 에 보내면 못 찾고 0건이 온다 —
 * 그 하나 때문에 자유어를 통째로 A 에 못 보내고, 받은 목록(상한 안)에서만 걸러야 했다.
 *
 * A 는 `center_name` 을 **필드 파라미터로는 받는다**. 그러니 '이 토큰이 센터명이다' 라는 것만
 * 알면 서버가 걸러 줄 수 있고, 건수 상한을 벗어난다.
 *
 * ── 사전은 어디서 오나 ──────────────────────────────────────────────────
 * A 의 `/center/list` 는 **관리자 전용**이다(group_idx=1 이 아니면 빈 배열). 판독의 계정으로는
 * 못 받는다. 병원 목록 API 는 아예 없다.
 *
 * 그래서 **이미 화면에 온 워크리스트 행에서 모은다**. 사용자가 검색하는 센터는 대개 최근에 본
 * 목록에 있는 값이다. 행에서 왔다는 것은 **A 에 실재하는 값**이라는 뜻이라, 승격해도 0건이 되지
 * 않는다(추측이 아니다 — 이 점이 이 설계의 안전 근거다).
 *
 * ── 안전 규칙 ──────────────────────────────────────────────────────────
 * ① **정확 일치만** 승격한다. '써밋' 처럼 일부만 쓰면 사전에 없으므로 종전대로 클라이언트가
 *    거른다. A 의 center_name 매칭이 부분 일치인지 확실하지 않은데 부분 문자열을 넘기면
 *    조용히 0건이 될 수 있다 — 모르면 승격하지 않는다.
 * ② 같은 값이 **병원명으로도** 쓰이면 승격하지 않는다. 센터로 좁혔는데 실은 병원명이었다면
 *    검사가 사라진다. 애매하면 클라이언트가 거르는 쪽이 언제나 안전하다.
 * ③ 사전이 비어 있으면(처음 쓰는 사용자) 아무 일도 하지 않는다 — 기존 동작 그대로.
 *
 * react·api 무의존 — node 테스트가 직접 부른다.
 */

const KEY = "sv_center_dict";
/** 기기에 담아 둘 최대 개수 — 넘으면 오래된 것부터 버린다. */
export const CENTER_DICT_MAX = 400;

export interface CenterDict {
  /** 센터명으로 본 값들 */
  centers: string[];
  /** 병원명으로도 쓰인 값들 — 겹치면 승격하지 않는다(안전 규칙 ②) */
  hospitals: string[];
}

export const EMPTY_DICT: CenterDict = { centers: [], hospitals: [] };

const norm = (v: unknown): string => String(v ?? "").trim();

/** 행 목록에서 센터·병원 이름을 모아 사전을 갱신한다(순수 — 새 객체를 준다). */
export function collectDict(
  prev: CenterDict, rows: { center_name?: string; hospital_name?: string }[],
): CenterDict {
  const centers = new Set(prev?.centers ?? []);
  const hospitals = new Set(prev?.hospitals ?? []);
  for (const r of rows ?? []) {
    const c = norm(r?.center_name);
    const h = norm(r?.hospital_name);
    if (c) centers.add(c);
    if (h) hospitals.add(h);
  }
  // 상한 — 뒤쪽(최근)을 남긴다
  const cut = (s: Set<string>) => [...s].slice(-CENTER_DICT_MAX);
  return { centers: cut(centers), hospitals: cut(hospitals) };
}

/** 이 토큰을 **센터로 확정할 수 있는가**(안전 규칙 ①②). */
export function isCenterName(dict: CenterDict, token: string): boolean {
  const t = norm(token);
  if (!t) return false;
  if (!(dict?.centers ?? []).includes(t)) return false;      // ① 정확 일치만
  if ((dict?.hospitals ?? []).includes(t)) return false;     // ② 병원명과 겹치면 애매하다
  return true;
}

/** 저장값 정리 — 깨져 있어도 화면이 죽지 않게. */
export function readDict(raw?: string | null): CenterDict {
  try {
    const v = JSON.parse(raw ?? "") as Partial<CenterDict>;
    const arr = (x: unknown) =>
      Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && !!s.trim()) : [];
    return { centers: arr(v?.centers), hospitals: arr(v?.hospitals) };
  } catch {
    return { ...EMPTY_DICT };
  }
}

export function loadDict(): CenterDict {
  if (typeof localStorage === "undefined") return { ...EMPTY_DICT };
  return readDict(localStorage.getItem(KEY));
}

export function saveDict(d: CenterDict): void {
  try { localStorage?.setItem(KEY, JSON.stringify(d)); } catch { /* 저장 실패는 무시 */ }
}

/** 사전이 실질적으로 비어 있는가 — 비면 승격 로직을 아예 건너뛴다(규칙 ③). */
export function dictEmpty(d: CenterDict): boolean {
  return !(d?.centers?.length);
}
