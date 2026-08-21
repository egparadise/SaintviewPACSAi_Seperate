/* 단축키·템플릿의 **모달리티별 분류**(2026-08-21 사용자 확정).
 *
 * 사용자 요구:
 *   "그림1 — Setting>판독>단축키 설정: 모달리티별 분류. 선택하면 확장하여 하위에 나타남.
 *    그림2 — 판독창의 단축키: 모달리티별로 분류하되 **현재 판독해야 될 모달리티가 확장**되며
 *            하단에 단축키들이 나타남."
 *
 * ── 설계 ────────────────────────────────────────────────────────────────
 * ① **그룹 키는 등록된 모달리티 그대로** 쓴다(CR·MG·CT·MR…). 임의로 합치지 않는다 —
 *    사용자가 CR 과 DX 를 따로 등록했다면 그건 그렇게 쓰겠다는 뜻이다.
 * ② 다만 **자동 확장 판정에서는 동류를 인정**한다. 일반촬영은 장비·병원마다 CR/DX/DR 로 제각각
 *    들어오는데(A 는 같은 검사를 DR 로 주고 단축키는 CR 로 등록돼 있는 일이 흔하다), 그때
 *    아무것도 안 열리면 "왜 내 단축키가 안 보이지"가 된다.
 * ③ 모달리티가 비어 있는 항목은 **'공통'** 그룹으로 모아 **맨 앞**에 둔다. 어느 검사에서나
 *    쓰는 것이므로 늘 보이는 편이 낫다.
 * ④ 그룹 순서는 등록이 많은 순이 아니라 **판독 현장에서 흔한 순**(CR·DX·MG·CT·MR·US…)으로
 *    고정한다 — 매번 자리가 바뀌면 손이 기억하지 못한다. 목록에 없는 것은 뒤에 알파벳순.
 *
 * react·api 무의존 — node 테스트가 직접 부른다.
 */

export interface PhraseLike {
  id?: number;
  name?: string;
  modality?: string;
  kind?: string;
}

export interface PhraseGroup<T> {
  /** 그룹 키 — 등록된 모달리티 대문자. 빈 모달리티는 "" (공통) */
  key: string;
  /** 화면 표기 */
  label: string;
  items: T[];
}

/** 공통 그룹(모달리티 미지정)의 표기. */
export const COMMON_LABEL = "공통";

/** ④ 판독 현장에서 흔한 순서. 여기 없는 모달리티는 뒤에 알파벳순으로 붙는다. */
export const MODALITY_ORDER = ["CR", "DX", "DR", "MG", "CT", "MR", "US", "NM", "PT", "XA", "RF", "OT"];

/** ② 동류 — 자동 확장 판정에서만 쓴다(그룹을 합치지는 않는다). */
const FAMILIES: string[][] = [
  ["CR", "DX", "DR"],     // 일반촬영 — 장비·병원마다 표기가 다르다
  ["MR", "MRI"],
  ["PT", "PET"],
];

const up = (v: unknown): string => String(v ?? "").trim().toUpperCase();

/** 같은 계열인가(대소문자·표기 차이 흡수). */
export function sameFamily(a: string, b: string): boolean {
  const x = up(a), y = up(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return FAMILIES.some((f) => f.includes(x) && f.includes(y));
}

function orderOf(key: string): number {
  if (!key) return -1;                     // ③ 공통이 맨 앞
  const i = MODALITY_ORDER.indexOf(key);
  return i >= 0 ? i : MODALITY_ORDER.length;
}

/** 모달리티별로 묶는다. 빈 그룹은 만들지 않는다. */
export function groupByModality<T extends PhraseLike>(rows: T[]): PhraseGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const r of rows ?? []) {
    const k = up(r?.modality);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r);
  }
  return [...map.entries()]
    .map(([key, items]) => ({ key, label: key || COMMON_LABEL, items }))
    .sort((a, b) => {
      const d = orderOf(a.key) - orderOf(b.key);
      return d !== 0 ? d : a.key.localeCompare(b.key);
    });
}

/**
 * 판독창에서 **처음에 열어 둘 그룹**(그림2 — 현재 판독할 모달리티가 확장).
 *
 * 정확히 같은 것 → 같은 계열 → (없으면) 아무것도 열지 않는다.
 * '아무거나 첫 그룹을 연다' 로 하지 않는 이유: 지금 검사와 상관없는 단축키가 펼쳐져 있으면
 * 그걸 이 검사용이라고 오해한다.
 */
export function autoOpenKey<T>(groups: PhraseGroup<T>[], currentModality: string): string | null {
  const m = up(currentModality);
  if (!m || !groups?.length) return null;
  const exact = groups.find((g) => g.key === m);
  if (exact) return exact.key;
  const fam = groups.find((g) => g.key && sameFamily(g.key, m));
  return fam ? fam.key : null;
}

/** 처음 펼쳐 둘 그룹 집합 — 현재 모달리티 + 공통(어느 검사에서나 쓰는 것).
 *  Set 을 돌려주므로 호출부는 그대로 화면 상태로 쓰면 된다. */
export function initialOpenKeys<T>(groups: PhraseGroup<T>[], currentModality: string): Set<string> {
  const out = new Set<string>();
  const k = autoOpenKey(groups, currentModality);
  if (k !== null) out.add(k);
  if (groups?.some((g) => g.key === "")) out.add("");   // ③ 공통은 늘 펼쳐 둔다
  return out;
}
