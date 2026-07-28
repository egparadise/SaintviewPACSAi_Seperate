// Compare 기준 — 비교할 과거 검사를 **어느 모집단에서** 고르는가.
//
//  · 환자 기준(항상 기본): 같은 환자의 과거 검사. 판독에서 비교의 대부분이 여기다.
//  · 판독의사 기준: **내가 판독했던** 과거 검사 전체. 환자가 달라도 된다.
//    예) Chest CT 를 보는 중 Modality·Bodypart 를 모두 체크 → 내가 판독한 Chest CT 들.
//        Bodypart 만 체크 → Chest X-ray·Chest MRI 까지(같은 환자든 다른 환자든).
//
// 좁히는 축은 **지금 보는 검사 기준**이다(체크를 안 하면 그 축으로는 안 좁힌다).
// 기간의 기준점도 오늘이 아니라 **지금 보는 검사의 검사일**이다 — 서버가 그렇게 계산한다.
//
// 설정 위치: 설정 > 판독 > 기본설정 > Compare (report.prefs.compare)
// 뷰어는 이 값을 **기본값**으로 쓰고 그 자리에서 바꿀 수 있다(그 변경은 저장하지 않는다 —
// 설정은 '늘 이렇게 시작한다'는 뜻이고, 화면에서의 변경은 그 판독 한 번에 대한 것이다).

export type CompareBasisKind = "patient" | "reader";
export type ComparePeriod = "prev" | "1y" | "3y" | "5y" | "all";

export interface CompareCfg {
  basis: CompareBasisKind;
  by_modality: boolean;
  by_body_part: boolean;
  period: ComparePeriod;
}

/** 기본값 — **환자 기준**이고 아무 축으로도 안 좁힌다(그 환자의 과거 검사 전부). */
export const DEFAULT_COMPARE: CompareCfg = {
  basis: "patient",
  by_modality: false,
  by_body_part: false,
  period: "all",
};

export const PERIOD_LABEL: Record<ComparePeriod, string> = {
  prev: "바로 직전",
  "1y": "과거 1년 이내",
  "3y": "과거 3년 이내",
  "5y": "과거 5년 이내",
  all: "전체",
};
export const PERIODS: ComparePeriod[] = ["prev", "1y", "3y", "5y", "all"];

export const BASIS_LABEL: Record<CompareBasisKind, string> = {
  patient: "환자 기준 — 이 환자의 과거 검사",
  reader: "판독의사 기준 — 내가 판독한 과거 검사",
};

/** 저장값 해석 — 모르는 값은 기본으로 떨어뜨린다(설정이 깨져도 화면은 뜬다). */
export function readCompareCfg(v: unknown): CompareCfg {
  const o = (v ?? {}) as Partial<CompareCfg>;
  const basis: CompareBasisKind = o.basis === "reader" ? "reader" : "patient";
  const period = (PERIODS as string[]).includes(String(o.period))
    ? (o.period as ComparePeriod) : DEFAULT_COMPARE.period;
  return {
    basis,
    by_modality: !!o.by_modality,
    by_body_part: !!o.by_body_part,
    period,
  };
}

/** 후보 조회 쿼리스트링 — 서버(로컬/Live)가 같은 계약을 쓴다. */
export function compareQuery(c: CompareCfg): string {
  return `basis=${c.basis}&modality=${c.by_modality ? 1 : 0}`
       + `&body_part=${c.by_body_part ? 1 : 0}&period=${c.period}`;
}

/** 지금 조건을 한 줄로 — 뷰어 Compare 창 머리에 무엇을 보고 있는지 밝힌다. */
export function compareSummary(c: CompareCfg, modality?: string, bodyPart?: string): string {
  const axes: string[] = [];
  if (c.by_modality) axes.push(modality || "같은 모달리티");
  if (c.by_body_part) axes.push(bodyPart || "같은 부위");
  const narrow = axes.length ? ` · ${axes.join(" + ")}` : " · 전체";
  return `${c.basis === "reader" ? "내가 판독한 검사" : "이 환자의 과거 검사"}`
       + `${narrow} · ${PERIOD_LABEL[c.period]}`;
}
