/* Combine 규칙 — Scout(정위) 시리즈 제외 (2026-08-20 사용자 확정).
 *
 * 사용자 요구:
 *   "Setting 뷰어 공통에 'Combine 규칙' 항목을 만들고, 체크박스 기능 'Scout Image 제외'를 만들어.
 *    체크되면 Scout Image 가 있는 첫 번째 Series 는 제외하고 **두 번째 Series 부터** Combine 이
 *    동작하게. 체크박스는 ① CT Scout Image 제외 ② MRI Scout Image 제외 두 개."
 *
 * ── 왜 판정이 필요한가 ──────────────────────────────────────────────────
 * Scout(정위·localizer·topogram)은 위치를 잡기 위한 1~3장짜리 참고 영상이다. Combine 으로
 * 전체 시리즈를 한 줄로 이으면 이게 **맨 앞에** 붙어, 연속 스크롤을 시작하자마자 진단 영상이
 * 아닌 것부터 보게 된다. 그래서 빼 달라는 요구다.
 *
 * ── 판정 순서(보수적) ───────────────────────────────────────────────────
 * ① 시리즈 설명에 scout/localizer/topogram/scanogram/surview/planning 이 있으면 Scout.
 *    — 가장 확실하고 오탐이 거의 없다.
 * ② **image_type(0008,0008) 에 LOCALIZER 가 있으면 Scout.** 2026-08-21 부터 서버가 시리즈마다
 *    이 태그를 실어 준다(orthanc·Live 양쪽). DICOM 이 스스로 밝힌 값이라 가장 믿을 만하다.
 * ③ ①②로 못 잡았고 **태그도 없을 때만**, 맨 앞 시리즈에 한해 형태로 본다:
 *    장수가 아주 적고(≤ SCOUT_MAX_IMAGES) 검사 안에 그보다 훨씬 큰 시리즈가 있으면 Scout.
 *    ⚠ 이건 추측이다. 그래서 (a) 사용자가 그 모달리티를 명시적으로 켰을 때만 돌고,
 *      (b) **맨 앞 시리즈에만** 적용하며(사용자 요구가 "첫 번째 Series"다),
 *      (c) 뺀 사실을 화면에 알린다(호출부 책임).
 *    ★ **태그를 아는 검사에서는 ③을 아예 쓰지 않는다.** DICOM 이 "이건 LOCALIZER 가 아니다" 라고
 *      말했는데 우리가 형태로 뒤집으면, 짧은 진단 시리즈(2장짜리 촬영 등)를 빼 버린다.
 *      태그가 실리기 전에는 ③ 없이는 사용자 그림의 S1(COR 2장)을 잡을 수 없어 어쩔 수 없었다.
 *
 * ── 안전장치 ────────────────────────────────────────────────────────────
 * 제외하고 나면 결합할 게 없거나 하나만 남는 상황이면 **제외하지 않는다**. 규칙 때문에
 * Combine 자체가 불가능해지는 쪽이 사용자에게 더 나쁘다.
 *
 * react·api 무의존 — node 테스트가 직접 부른다.
 */

export interface CombineRule {
  /** CT 검사에서 Scout 시리즈를 뺀다 */
  skip_scout_ct?: boolean;
  /** MR 검사에서 Scout 시리즈를 뺀다 */
  skip_scout_mr?: boolean;
}

export const COMBINE_RULE_DEFAULT: CombineRule = { skip_scout_ct: false, skip_scout_mr: false };

/** 설명으로 보는 Scout — 장비·병원마다 표기가 다르므로 알려진 낱말을 모아 둔다. */
const SCOUT_DESC_RE = /scout|localiz|topogram|scanogram|surview|smartprep|dose ?report|planning/i;

/** ③ 형태 판정의 상한 — 이보다 많으면 진단 시리즈로 본다. */
export const SCOUT_MAX_IMAGES = 3;
/** ③ 검사 안에 이만큼 큰 시리즈가 따로 있어야 '앞의 몇 장'을 Scout 으로 본다. */
export const SCOUT_BULK_RATIO = 5;

export interface SeriesLike {
  modality?: string;
  series_desc?: string;
  series_number?: number;
  image_type?: string;
  instances?: unknown[];
}

const count = (s: SeriesLike): number => s.instances?.length ?? 0;

/** 이 모달리티에 규칙이 켜져 있는가. CT/MR 만 대상(사용자가 그 둘을 지정했다). */
export function ruleOnFor(modality: string, rule: CombineRule): boolean {
  const m = String(modality ?? "").toUpperCase();
  if (m === "CT") return !!rule.skip_scout_ct;
  if (m === "MR" || m === "MRI") return !!rule.skip_scout_mr;
  return false;
}

/** ①② — 이름·태그로 확실히 Scout 인가. */
export function looksScoutByName(s: SeriesLike): boolean {
  if (SCOUT_DESC_RE.test(String(s.series_desc ?? ""))) return true;
  return /localizer/i.test(String(s.image_type ?? ""));
}

/** 이 검사가 ImageType 을 알고 있는가 — 하나라도 실려 있으면 '아는 검사' 로 본다.
 *  아는 검사에서는 형태 추측(③)을 쓰지 않는다(위 판정 순서 ★). */
export function knowsImageType(list: SeriesLike[]): boolean {
  return (list ?? []).some((s) => String(s.image_type ?? "").trim() !== "");
}

/**
 * 결합에서 뺄 시리즈들. **원본 순서를 유지한 새 배열**을 돌려준다.
 *
 * @param list  결합 후보(이미 SR/KO/PR/SEG 등은 걸러진 상태여야 한다)
 * @param modality 이 검사의 모달리티
 * @param rule 사용자가 설정한 규칙
 */
export function dropScoutSeries<T extends SeriesLike>(
  list: T[], modality: string, rule: CombineRule,
): { kept: T[]; dropped: T[] } {
  const none = { kept: list, dropped: [] as T[] };
  if (!list?.length || !ruleOnFor(modality, rule)) return none;

  // 시리즈 번호 순으로 '맨 앞'을 정한다 — 화면 순서와 배열 순서가 다를 수 있다.
  const ordered = [...list].sort((a, b) => (a.series_number ?? 0) - (b.series_number ?? 0));
  const biggest = Math.max(...list.map(count));
  // ★ DICOM 이 ImageType 을 밝힌 검사에서는 형태 추측을 쓰지 않는다 — 태그가 "LOCALIZER 아님"
  //   이라고 말했는데 우리가 장수로 뒤집으면 짧은 진단 시리즈를 빼 버린다.
  const tagged = knowsImageType(list);

  const drop = new Set<T>();
  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i];
    if (looksScoutByName(s)) { drop.add(s); continue; }
    if (tagged) break;              // 태그를 아는 검사 — 앞쪽 형태 추측 구간 없음
    // ③ 형태 판정은 **앞에서 연속으로** 걸리는 동안만 — 사용자 요구가 "첫 번째 Series"다.
    //   이미 진단 시리즈를 하나 지났으면 그 뒤의 작은 시리즈는 건드리지 않는다.
    if (drop.size === i && count(s) > 0 && count(s) <= SCOUT_MAX_IMAGES
        && biggest >= count(s) * SCOUT_BULK_RATIO) {
      drop.add(s);
      continue;
    }
    break;   // 앞쪽 Scout 구간이 끝났다
  }
  // 이름으로 확실한 것은 위치와 무관하게 뺀다(중간에 끼어 있어도 진단 영상이 아니다)
  for (const s of list) if (looksScoutByName(s)) drop.add(s);

  const kept = list.filter((s) => !drop.has(s));
  // 안전장치 — 규칙 때문에 결합 자체가 불가능해지면 적용하지 않는다
  if (kept.length < 2) return none;
  return { kept, dropped: list.filter((s) => drop.has(s)) };
}

/** 저장값 정리 — 깨져 있어도 화면이 죽지 않게 불리언으로만 통과시킨다. */
export function readCombineRule(v: unknown): CombineRule {
  const o = (v ?? {}) as CombineRule;
  return { skip_scout_ct: !!o.skip_scout_ct, skip_scout_mr: !!o.skip_scout_mr };
}
