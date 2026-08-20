/* 과거검사(Prior Studies) 분류 — SameModality · SameBodyPart · All (2026-08-20 사용자 확정).
 *
 * 사용자 요구:
 *   "History 의 과거 영상 바로 위에 3개의 체크박스 버튼을 만들고, 클릭하면 같은 환자의 과거 검사
 *    History 가 이 세 가지로 분류되어 보이게.
 *      1. SameModality  : 같은 장비에서 촬영한 과거 Study
 *      2. SameBodyPart  : 같은 BodyPart (예: Chest, Abdomen, Brain …)
 *      3. All           : 전부"
 *
 * ── 설계 ────────────────────────────────────────────────────────────────
 * ① **All 은 '필터 없음'이다.** 다른 둘과 함께 켤 수 없다(켜면 나머지가 꺼진다). 반대로 둘 중
 *    하나를 켜면 All 이 꺼진다. 아무것도 안 켜져 있으면 All 로 본다 — 목록이 통째로 비는 상태를
 *    사용자가 실수로 만들 수 없어야 한다.
 * ② SameModality 와 SameBodyPart 를 **둘 다 켜면 AND** 다(같은 장비 && 같은 부위).
 *    "CT 이면서 Chest 인 과거검사"가 자연스러운 해석이고, OR 로 하면 필터를 더 걸수록 목록이
 *    늘어나 조작 감각이 뒤집힌다.
 * ③ 부위·장비 문자열은 **정규화해서** 비교한다. 같은 부위가 'CHEST' / 'Chest' / 'C-SPINE' /
 *    'C SPINE' 처럼 표기만 다르게 들어오는 일이 흔하다(장비·병원마다 다르다).
 * ④ 값이 **비어 있는 과거검사**는 그 축의 필터를 걸 때 제외한다. 모르는 것을 '같다'고 넣으면
 *    다른 부위가 섞여 보이고, 그건 비교 판독에서 위험하다(모르면 안 보여 준다).
 *    ⚠ 그래서 백엔드가 related_exams 에 body_part 를 실어 주어야 한다 — 예전에는 Compare
 *      후보에만 실려서, 이 필터를 켜면 목록이 통째로 비었다.
 *
 * react·api 무의존 — node 테스트가 직접 부른다.
 */

export interface PriorFilter {
  modality: boolean;
  bodyPart: boolean;
}

/** 아무것도 안 켠 상태 = All. */
export const PRIOR_FILTER_OFF: PriorFilter = { modality: false, bodyPart: false };

/** 지금 'All' 인가 — 두 축 모두 꺼져 있으면 전부 보여 준다. */
export function isAll(f: PriorFilter): boolean {
  return !f.modality && !f.bodyPart;
}

/** 체크박스 클릭 → 다음 상태.
 *  key "all" 은 두 축을 모두 끈다. 나머지는 그 축만 토글한다(둘 다 켜면 AND). */
export function nextPriorFilter(cur: PriorFilter, key: "modality" | "bodyPart" | "all"): PriorFilter {
  if (key === "all") return { ...PRIOR_FILTER_OFF };
  return { ...cur, [key]: !cur[key] };
}

/** 비교용 정규화 — 대소문자·공백·하이픈·언더스코어를 지운다.
 *  'C-Spine' / 'C SPINE' / 'c_spine' 이 모두 같은 값이 된다. */
export function normPart(v: unknown): string {
  return String(v ?? "").toLowerCase().replace(/[\s\-_]+/g, "");
}

export interface PriorLike {
  modality?: string;
  body_part?: string;
}

/** 이 과거검사가 지금 필터를 통과하는가. */
export function priorMatches(cur: PriorLike, prior: PriorLike, f: PriorFilter): boolean {
  if (isAll(f)) return true;
  if (f.modality) {
    const a = normPart(cur.modality), b = normPart(prior.modality);
    if (!a || !b || a !== b) return false;      // ④ 모르면 안 보여 준다
  }
  if (f.bodyPart) {
    const a = normPart(cur.body_part), b = normPart(prior.body_part);
    if (!a || !b || a !== b) return false;
  }
  return true;
}

/** 필터를 적용한 **새 배열**. All 이면 원본 그대로(참조 동일 — 불필요한 렌더 방지). */
export function filterPriors<T extends PriorLike>(cur: PriorLike, list: T[], f: PriorFilter): T[] {
  if (isAll(f)) return list;
  return list.filter((p) => priorMatches(cur, p, f));
}

/** 체크박스 라벨 — 사용자가 쓴 이름 그대로(제품 용어라 번역하지 않는다). */
export const PRIOR_FILTER_LABEL = {
  modality: "SameModality",
  bodyPart: "SameBodyPart",
  all: "All",
} as const;

// ── 기기별 기억(localStorage) ───────────────────────────────────────────
// 판독 중 매번 다시 고르게 하지 않는다. 계정 설정이 아니라 기기 저장인 이유: 이건 '이 자리에서
// 지금 어떻게 보고 싶은가'에 가깝고, 서버 왕복 없이 즉시 반영되는 편이 판독 흐름을 끊지 않는다.
const KEY = "sv_prior_filter";

export function readPriorFilter(raw?: string | null): PriorFilter {
  try {
    const v = JSON.parse(raw ?? "") as Partial<PriorFilter>;
    return { modality: !!v?.modality, bodyPart: !!v?.bodyPart };
  } catch {
    return { ...PRIOR_FILTER_OFF };
  }
}

export function loadPriorFilter(): PriorFilter {
  if (typeof localStorage === "undefined") return { ...PRIOR_FILTER_OFF };
  return readPriorFilter(localStorage.getItem(KEY));
}

export function savePriorFilter(f: PriorFilter): void {
  try { localStorage?.setItem(KEY, JSON.stringify(f)); } catch { /* 저장 실패는 무시 */ }
}
