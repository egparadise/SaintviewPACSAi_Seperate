/* 비교세트 후보 — **내가 판독한 과거 검사**에서 고른다(2026-08-22 사용자 확정).
 *
 * 사용자 요구:
 *   "T뷰 워크리스트의 비교세트는, Compare 가 '판독의 중심'(판독의사 기준)으로 설정되어 있지
 *    않더라도 **이 부분만큼은 현재 로그인한 사람의 과거 판독문에서** 'Modality·BodyPart·All'
 *    체크박스로 골라 보여 준다. 비교세트 옆에 그 체크박스를 만들고,
 *    Setting>워크리스트>T-View 에 그림1(Compare 기준)과 이 설정을 넣되
 *    **워크리스트 공통과 별도로 T-View 에서만** 동작하게."
 *
 * ── 설계 ────────────────────────────────────────────────────────────────
 * ① **후보 모집단은 언제나 '판독의사 기준'(basis=reader)** 이다. 설정>판독의 Compare 기준이
 *    '환자 기준' 이어도 이 패널은 reader 로 묻는다 — 사용자가 그렇게 못 박았다.
 *    (설정>판독의 Compare 는 **뷰어 Compare 창**의 기본값이고, 이건 워크리스트 비교세트다.)
 * ② 좁히는 축은 priorFilter 와 **같은 모양**(modality·bodyPart, 둘 다 끄면 All)이다.
 *    다만 라벨은 사용자가 쓴 대로 'Modality'·'Bodypart'·'All' 이다(Same 접두사 없음).
 * ③ 저장은 **T-View 전용 그릇**이다. 워크리스트 공통 설정과 섞지 않는다 —
 *    `worklist.prefs.compare_by_viewer.ty`. 다른 뷰어를 건드리지 않는 것이 요구의 핵심이다.
 * ④ 이 값은 화면이 **시작할 때의 기본값**이다. 패널에서 그 자리에서 바꿀 수 있고,
 *    그 변경은 저장하지 않는다(설정>판독 Compare 와 같은 규약).
 *
 * react·api 무의존 — node 테스트가 직접 부른다.
 */

import { type CompareCfg, DEFAULT_COMPARE, readCompareCfg } from "./compareBasis.ts";
import { type PriorFilter, PRIOR_FILTER_OFF, isAll } from "./priorFilter.ts";

/** 체크박스 라벨 — 사용자가 쓴 그대로(제품 용어라 번역하지 않는다). */
export const COMPARE_SET_LABEL = {
  modality: "Modality",
  bodyPart: "Bodypart",
  all: "All",
} as const;

/** T-View 워크리스트 전용 설정. */
export interface TvCompareCfg {
  /** 그림1 — Compare 기준(뷰어 Compare 창의 기본값과 같은 모양) */
  basis: CompareCfg;
  /** 비교세트 후보를 좁히는 축(체크박스 3개) */
  set: PriorFilter;
}

export const DEFAULT_TV_COMPARE: TvCompareCfg = {
  basis: { ...DEFAULT_COMPARE },
  set: { ...PRIOR_FILTER_OFF },
};

/** worklist.prefs 에서 T-View 전용 설정을 읽는다(없으면 기본값 — 다른 뷰어와 섞지 않는다). */
export function readTvCompare(prefs: unknown): TvCompareCfg {
  const v = (prefs as { compare_by_viewer?: { ty?: Partial<TvCompareCfg> } })?.compare_by_viewer?.ty;
  return {
    basis: readCompareCfg(v?.basis),
    set: {
      modality: !!v?.set?.modality,
      bodyPart: !!v?.set?.bodyPart,
    },
  };
}

/** 저장할 형태로 — 기존 worklist.prefs 를 보존하며 T-View 칸만 갈아 끼운다. */
export function writeTvCompare(prefs: unknown, cfg: TvCompareCfg): Record<string, unknown> {
  const base = (prefs ?? {}) as Record<string, unknown>;
  const by = (base.compare_by_viewer ?? {}) as Record<string, unknown>;
  return { ...base, compare_by_viewer: { ...by, ty: cfg } };
}

/**
 * 후보 조회 쿼리 — **basis 는 언제나 reader** 다(①).
 *
 * 기간은 설정>워크리스트>T-View 의 Compare 기준에서 가져온다. 좁히는 축은 패널 체크박스가
 * 정한다 — 설정의 by_modality/by_body_part 는 **뷰어 Compare 창**의 축이라 여기서 쓰지 않는다
 * (같은 이름의 다른 축을 섞으면 화면과 결과가 어긋난다).
 */
export function candidateQuery(cfg: TvCompareCfg, filter: PriorFilter): string {
  const p = new URLSearchParams();
  p.set("basis", "reader");
  p.set("period", cfg?.basis?.period ?? "all");
  p.set("by_modality", String(!!filter?.modality));
  p.set("by_body_part", String(!!filter?.bodyPart));
  return p.toString();
}

/** 지금 'All' 인가 — 두 축 모두 꺼져 있으면 좁히지 않는다(priorFilter 와 같은 규칙). */
export const isAllSet = isAll;

/** 이미 비교세트에 담긴 것은 후보에서 뺀다 — 같은 줄이 두 번 보이면 담긴 것인지 헷갈린다. */
export function pickFresh<T extends { study_uid?: string }>(
  candidates: T[], picked: { study_uid: string }[],
): T[] {
  const have = new Set((picked ?? []).map((x) => x.study_uid));
  return (candidates ?? []).filter((c) => c.study_uid && !have.has(c.study_uid));
}
