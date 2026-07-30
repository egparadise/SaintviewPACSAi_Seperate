/* 사양 6 — 뷰어 '직접설정': 지금 화면을 읽어 HpRule 로 만들고(capture), 규칙을 다시 화면으로 되돌린다(plan).
 * ════════════════════════════════════════════════════════════════════════════════════════
 * 여기는 **순수 모듈**이다(React·DOM·api 없음). 뷰어 3종이 같은 규정을 쓴다:
 *   SaintView·T-View = pages/Viewer2D.tsx (skin 으로 갈린다)   ·   I-View = pages/ViewerInfi.tsx
 * 예전에 두 뷰어가 HP 매칭을 각자 find 로 복사했다가 동작이 갈렸다(하나는 버그였다) —
 * 그래서 '읽기(capture)·되돌리기(plan)' 도 여기 한 곳에만 둔다. UI 는 components/HpMenu.tsx 하나뿐이다.
 *
 * ⚠ 왕복(저장→다시 고르면 그 화면)이 이 모듈의 계약이다.
 *   왕복하지 못하는 것은 **저장하지 않거나**(3D) **경고로 알린다**(칸 순서 ≠ 검사 순서).
 *   저장은 됐는데 복원이 안 되는 것이 가장 나쁘다.
 */

import {
  DEFAULT_HP_SLOT, fitHpCells, hpSlotIsPrior, hpSlotStudies, newHpRule,
  type HpCandidate, type HpCell, type HpRule, type HpScreen, type HpSlot,
  // ⚠ 확장자(.ts)를 붙인 채로 둔다 — tests/*.test.mjs 가 이 파일을 **원본 그대로** import 하는데,
  //   Node ESM 은 확장자 없는 상대 경로를 해석하지 못해 테스트가 통째로 죽는다(ERR_MODULE_NOT_FOUND).
  //   tsconfig.app.json 의 allowImportingTsExtensions 로 tsc·Vite 는 그대로 통과한다.
  //   (같은 이유로 viewerConfig.ts 는 hangingProtocol 재수출을 걷어냈다 — 그 주석 참조)
} from "./hangingProtocol.ts";

/* ══════════ 이 창은 몇 번 모니터인가 ══════════ */

/** 뷰어 창 이름 → 모니터 인덱스. lib/viewerSlots.ts `viewerSlotName()` 의 역함수다.
 *  규약: 최저번호 모니터 = "sv_viewer", 나머지 = "sv_viewer_slot{모니터인덱스}".
 *  ⚠ "sv_viewer" 는 인덱스를 담고 있지 않다 — Setting>모니터(viewer.prefs.monitor.screens)의
 *    **최저 선택 번호**로 역산한다. 선택이 없으면 null(=모니터 미지정 화면으로 저장).
 *    null 로 저장된 화면은 어느 창에서 골라도 적용된다(pickHpScreen 폴백) — 단일 모니터 사용자를
 *    '내 화면이 아닌 규칙'으로 막지 않기 위해서다. */
export function hpMonitorIndex(windowName: string, screens?: readonly number[] | null): number | null {
  const nm = String(windowName ?? "").trim();
  const m = /^sv_viewer_slot(\d+)$/.exec(nm);
  if (m) return Number(m[1]);
  if (nm !== "sv_viewer") return null;
  const sel = [...new Set((screens ?? []).filter((n) => Number.isFinite(n) && n >= 0))].sort((a, b) => a - b);
  return sel.length ? sel[0] : null;
}

/* ══════════ 화면 스냅샷 ══════════ */

/** 과거검사 후보 한 건. hpSlotStudies 가 쓰는 {id, study_date} 에 uid 를 얹은 것 —
 *  페인이 물고 있는 것은 study_uid 뿐이라 uid 로 되찾아야 한다(api.RelatedExam 이 그대로 들어맞는다). */
export interface HpPriorRef extends HpCandidate { study_uid: string }

/** 페인 한 칸의 현재 상태(뷰어가 읽어 넘긴다).
 *  seriesNo = **그 검사 안에서 몇 번째 시리즈인가**(1-base). 구 cells 값과 같은 뜻이라 그대로 저장된다.
 *  studyUid = "" 이면 빈 페인. */
export interface HpPaneSnap { studyUid: string; seriesNo: number | null }

/** 매칭·기간 계산의 기준 맥락. anchorDate 는 **지금 보는 검사의 검사일**이다(오늘이 아니다). */
export interface HpViewCtx {
  currentUid: string;
  anchorDate: string;
  priors: readonly HpPriorRef[];
  currentId?: number;
}

/** 뷰어가 넘기는 '이 창의 화면' 스냅샷. */
export interface HpScreenSnap {
  monitor: number | null;
  resolution?: string;
  s: { r: number; c: number };   // 4-1 Series Layout
  i: { r: number; c: number };   // 4-1 Image Layout
  panes: readonly HpPaneSnap[];  // 칸 순서(행 우선) 그대로
}

const clampRC = (v: { r?: unknown; c?: unknown } | undefined): { r: number; c: number } => {
  const n = (x: unknown) => Math.min(10, Math.max(1, Math.floor(Number(x) || 1)));
  return { r: n(v?.r), c: n(v?.c) };
};

const ymd = (v: unknown): number | null => {
  const d = String(v ?? "").trim();
  if (!/^\d{8}$/.test(d)) return null;
  const y = +d.slice(0, 4), m = +d.slice(4, 6), da = +d.slice(6, 8);
  if (m < 1 || m > 12 || da < 1 || da > 31) return null;
  return Date.UTC(y, m - 1, da);
};

/** anchor 와 과거검사 사이의 일수. 계산 불가면 null. */
export function hpDaysBefore(anchorDate: string, priorDate: string): number | null {
  const a = ymd(anchorDate), p = ymd(priorDate);
  if (a == null || p == null) return null;
  return Math.round((a - p) / 86400000);
}

/** '사실상 하한 없음' 슬롯 — 최신순 정렬·같은 날 포함·미래 제외 규칙을 hpSlotStudies 에서 **그대로**
 *  빌려 쓰기 위한 것이다. 여기서 필터/정렬을 다시 짜면 백엔드 compare_basis 와 또 갈린다. */
const ALL_PRIORS: HpSlot = { kind: "custom", n: 4000, unit: "y" };

/** 후보를 최신순으로 — [0]=바로 이전 검사. */
export function hpPriorsByRecency(ctx: HpViewCtx): HpPriorRef[] {
  return hpSlotStudies(ALL_PRIORS, ctx.anchorDate, ctx.priors, ctx.currentId);
}

/** 이 과거검사를 다시 고를 슬롯. rank = 최신순 순위(0=바로 이전).
 *  · rank 0 → "prev"(바로 이전 영상). 사양 4-2 ①이고 하한이 없어 어느 검사에 적용해도 뜻이 통한다.
 *  · 그 외 → 그 검사를 **포함하는 가장 좁은** 기간(1주/1개월/1년). 넓게 잡으면 다른 검사가 걸려 들어온다.
 *  · 1년을 넘으면 '기간 직접 설정'(년 단위 올림) — 절대 날짜로 저장하지 않는다.
 *    절대 날짜를 넣으면 2019년 검사를 열었을 때 후보가 0건이 된다(규칙은 여러 검사에 반복 적용된다). */
export function hpSlotOfPrior(anchorDate: string, priorDate: string, rank: number): HpSlot {
  if (rank <= 0) return { kind: "prev" };
  const days = hpDaysBefore(anchorDate, priorDate);
  if (days == null) return { kind: "prev" };
  if (days <= 7) return { kind: "1w" };
  if (days <= 30) return { kind: "1m" };
  if (days <= 365) return { kind: "1y" };
  return { kind: "custom", n: Math.max(1, Math.ceil(days / 365)), unit: "y" };
}

/* ══════════ 되돌리기(plan) — 규칙 → 이 화면에 무엇을 넣을까 ══════════ */

/** 칸 하나의 복원 계획. */
export interface HpCellPlan {
  series: number | null;      // 1-base 시리즈 순번(null=자동: 칸 순서대로)
  slot: HpSlot;
  prior: HpPriorRef | null;   // 과거검사 슬롯이 고른 검사(현재 검사 칸이면 null)
  skip?: "3d" | "none";       // 3d=이 트랙이 복원하지 못한다 / none=조건에 맞는 과거검사가 없다
}

/** 화면 하나를 지금 검사 맥락에 대입한다.
 *  ⚠ 고른 과거검사는 **칸 순서대로 소진**한다(같은 검사가 두 칸에 겹쳐 뜨면 비교가 안 된다).
 *    소진은 슬롯 종류를 가리지 않는다 — 1칸이 "prev"(=가장 최근)를 가져가면 다음 "1년 내" 칸은
 *    그다음 검사를 가져간다. 슬롯별로 따로 세면 두 칸에 같은 검사가 뜬다(실제로 그렇게 짜 봤다). */
export function hpPlanCells(screen: HpScreen | null | undefined, ctx: HpViewCtx): HpCellPlan[] {
  if (!screen) return [];
  const cells = fitHpCells(screen.cells, clampRC(screen.s));
  const used = new Set<number>();
  return cells.map((c) => {
    const slot: HpSlot = c.slot ?? { ...DEFAULT_HP_SLOT };
    if (slot.kind === "3d") return { series: c.series, slot, prior: null, skip: "3d" as const };
    if (!hpSlotIsPrior(slot)) return { series: c.series, slot, prior: null };
    const list = hpSlotStudies(slot, ctx.anchorDate, ctx.priors, ctx.currentId);
    const pick = list.find((p) => !used.has(p.id)) ?? null;
    if (pick) used.add(pick.id);
    return { series: c.series, slot, prior: pick, ...(pick ? {} : { skip: "none" as const }) };
  });
}

/** 이 화면이 '칸에 무엇을 넣을지'를 실제로 담고 있는가.
 *  ⚠ 담고 있지 않으면(모든 칸이 시리즈 미지정 + '현재 검사') **페인을 건드리지 않는다**.
 *    구 규칙(Setting 에서 그리드만 잡은 것)을 골랐을 때 사용자가 잡아 둔 비교 배치를 통째로
 *    갈아엎지 않기 위해서다 — 구 동작(레이아웃만 바뀐다)을 그대로 지킨다. */
export function hpScreenHasPlacement(screen: HpScreen | null | undefined): boolean {
  return (screen?.cells ?? []).some((c) => c?.series != null || (c?.slot?.kind ?? "current") !== "current");
}

/** 이 규칙에서 **이 창이 쓸** 화면. monitor 가 맞는 viewer 화면 → 미지정 화면 → 첫 viewer 화면.
 *  ⚠ 폴백이 있는 이유: 규칙을 1번 모니터에서 저장하고 2번 모니터 창에서 골랐을 때 아무것도 안 걸리면
 *    사용자는 '규칙이 고장났다'고 본다. 구 동작(rule.s/i 하나를 모든 창이 쓰던 것)과도 같다. */
export function pickHpScreen(rule: HpRule | null | undefined, monitor: number | null): HpScreen | null {
  const list = (rule?.screens ?? []).filter((s) => s?.role === "viewer");
  if (!list.length) return null;
  if (monitor != null) {
    const hit = list.find((s) => s.monitor === monitor);
    if (hit) return hit;
  }
  return list.find((s) => s.monitor == null) ?? list[0];
}

/* ══════════ 읽기(capture) — 지금 화면 → 규칙 ══════════ */

export interface HpCaptureResult { screen: HpScreen; warnings: string[] }

/** 지금 화면을 HpScreen 으로. 못 읽거나 왕복하지 못하는 것은 warnings 로 돌려준다(UI 가 그대로 보여 준다).
 *
 *  저장하는 것 : 모니터 인덱스 · Series/Image 레이아웃 · 칸별 시리즈 순번 · 칸별 시간대 슬롯
 *  저장하지 않는 것(정직하게 뺀다):
 *    · 3D/MPR — 뷰어의 3D 는 페인이 아니라 뷰포트 영역 전체를 바꾼다. 칸에 대응시킬 수 없어
 *      복원이 불가능하므로 아예 캡처하지 않는다(설정 화면에서 넣은 "3d" 칸은 plan 이 skip 으로 표시).
 *    · 다른 모니터 창의 구성 — 창끼리 화면 상태를 읽을 수 없다. 같은 프로토콜명으로 각 창에서
 *      저장하면 monitor 별 화면으로 합쳐진다(mergeHpScreen).
 *    · W/L·확대·회전 등 페인 표시상태 — HpRule 에 자리가 없다(wl 만 규칙 전체 값으로 따로 받는다). */
export function hpCaptureScreen(snap: HpScreenSnap, ctx: HpViewCtx): HpCaptureResult {
  const s = clampRC(snap.s), i = clampRC(snap.i);
  const order = hpPriorsByRecency(ctx);
  const rank = new Map(order.map((p, k) => [p.study_uid, k]));
  const byUid = new Map(order.map((p) => [p.study_uid, p]));
  const warnings: string[] = [];
  const unknown: number[] = [];
  const n = Math.max(1, s.r * s.c);
  const cells: HpCell[] = [];
  for (let k = 0; k < n; k += 1) {
    const p = snap.panes[k];
    const series = p && typeof p.seriesNo === "number" && p.seriesNo > 0 ? Math.floor(p.seriesNo) : null;
    if (!p || !p.studyUid || p.studyUid === ctx.currentUid) {
      cells.push({ series, slot: { ...DEFAULT_HP_SLOT } });
      continue;
    }
    const pr = byUid.get(p.studyUid);
    if (!pr) {                       // 후보 목록에 없는 검사(다른 환자 비교·Stack 등) — 되찾을 방법이 없다
      unknown.push(k + 1);
      cells.push({ series, slot: { ...DEFAULT_HP_SLOT } });
      continue;
    }
    cells.push({ series, slot: hpSlotOfPrior(ctx.anchorDate, pr.study_date, rank.get(p.studyUid) ?? 0) });
  }
  const screen: HpScreen = {
    id: `sc${(snap.monitor ?? 0) + 1}`,
    role: "viewer",
    label: String((snap.monitor ?? 0) + 1),
    monitor: snap.monitor,
    resolution: String(snap.resolution ?? ""),
    s, i,
    cells: fitHpCells(cells, s),
  };
  if (unknown.length) {
    warnings.push(`${unknown.join("·")}번 칸의 검사는 과거검사 후보(관련검사)에 없어 되살릴 수 없다 — `
                + "'현재 검사'로 저장했다");
  }
  warnings.push(...hpRoundTripWarnings(screen, snap, ctx));
  return { screen, warnings };
}

/** 저장 직전 왕복 검증 — 이 화면을 지금 맥락에 되돌리면 각 칸에 **같은 검사**가 오는가.
 *  칸 순서가 검사 순서(최신순)와 다르면 복원이 최신순으로 채워져 자리가 바뀐다. 이것은
 *  슬롯 모델(하한만 있고 상한이 없다)에서 원리적으로 피할 수 없다 — 그래서 막지 않고 알려 준다. */
export function hpRoundTripWarnings(screen: HpScreen, snap: HpScreenSnap, ctx: HpViewCtx): string[] {
  const plan = hpPlanCells(screen, ctx);
  const bad: number[] = [];
  plan.forEach((pl, k) => {
    if (!hpSlotIsPrior(pl.slot)) return;                    // 현재 검사 칸은 항상 재현된다.
    // 과거검사로 저장하지 못한 칸('후보에 없는 검사')은 위에서 이미 알렸다 — 두 번 말하지 않는다.
    const want = snap.panes[k]?.studyUid || "";
    if ((pl.prior?.study_uid ?? "") !== want) bad.push(k + 1);
  });
  return bad.length
    ? [`${bad.join("·")}번 칸의 과거검사는 복원 시 **최신순**으로 다시 채워져 자리가 바뀔 수 있다`
       + " (칸 순서가 검사 날짜 순서와 다르다)"]
    : [];
}

/* ══════════ 규칙 만들기 ══════════ */

/** 같은 모니터의 viewer 화면을 갈아끼운다(없으면 덧붙인다).
 *  같은 프로토콜명으로 여러 모니터 창에서 저장하면 화면이 모니터별로 쌓인다 = 사양 4 의 다중 모니터 배치. */
export function mergeHpScreen(screens: readonly HpScreen[] | undefined, screen: HpScreen): HpScreen[] {
  const list = [...(screens ?? [])];
  const k = list.findIndex((x) => x.role === "viewer"
    && (screen.monitor == null ? x.monitor == null : x.monitor === screen.monitor));
  if (k < 0) return [...list, screen];
  list[k] = { ...screen, id: list[k].id };   // id 는 유지 — 설정 편집기가 화면을 id 로 추적한다
  return list;
}

/** 이름이 같은 규칙을 찾는다(공백·대소문자 무시). 덮어쓸지 새로 만들지 판단용. */
export function findHpRuleByName(rules: readonly HpRule[] | undefined, name: string): HpRule | null {
  const key = String(name ?? "").trim().toUpperCase();
  if (!key) return null;
  return (rules ?? []).find((r) => String(r.name ?? "").trim().toUpperCase() === key) ?? null;
}

/** 이름이 같으면 갈아끼우고(id 유지) 아니면 목록 끝에 붙인다 — 드롭다운 하단에 이어서 나온다(사양 6). */
export function upsertHpRule(rules: readonly HpRule[] | undefined, rule: HpRule): HpRule[] {
  const list = [...(rules ?? [])];
  const key = String(rule.name ?? "").trim().toUpperCase();
  const k = list.findIndex((r) => String(r.name ?? "").trim().toUpperCase() === key);
  if (k < 0) return [...list, rule];
  list[k] = { ...rule, id: list[k].id };
  return list;
}

export interface HpRuleFromScreenInput {
  name: string;                       // 사양 1 프로토콜명
  screen: HpScreen;                   // 이 창에서 읽은 화면
  modality?: string;                  // 사양 2 — 지금 검사의 장비(대문자). 빈값이면 모든 장비
  wl?: string;                        // 구 필드(규칙 전체 W/L). 활성 페인 값을 그대로 쓴다
  // ⚠ 아래 6개는 **undefined 를 '지정 안 함' 으로 구분한다** — base(덮어쓸 기존 규칙)가 있으면 그 값을
  //   그대로 둔다. 예전엔 !!input.x 로 눌러 버려서, 설정에서 'Exam 열 때 HP 사용'·'전체 링크'를 켜 둔
  //   규칙을 뷰어에서 같은 이름으로 다시 저장하면 **자동 적용되던 프로토콜이 조용히 수동 전용이 됐다**.
  useOnExamOpen?: boolean;            // 사양 5 ①  ⚠ 새 규칙(base 없음)은 **기본 false**(아래 주석)
  priority?: boolean;                 // 사양 6 '가장 우선 적용' — 새 규칙은 기본 false
  options?: { full_link?: boolean; full_scroll_sync?: boolean; cross_link?: boolean; scout_image?: boolean };
  base?: HpRule | null;               // 같은 이름의 기존 규칙(덮어쓰기) — 부위·출처 등 사용자가 설정에서 넣은 값 보존
}

/** 뷰어 '직접설정' → HpRule.
 *  ⚠ use_on_exam_open 기본값이 **false** 인 이유: 사양 6 이 "기본은 '해제' — 등록된 항목을 골라야
 *    적용된다" 라고 못 박았다. true 로 만들면 뷰어에서 한 번 저장한 순간부터 그 장비의 **모든** 검사가
 *    이 배치로 열린다(사용자가 시킨 적이 없다). 자동 적용은 체크로 켠다.
 *  ⚠ priority 기본 false — 사양 6 '가장 우선 적용'은 언체크가 기본이다.
 *  ⚠ body_part 는 비워 둔다 — 사양 3 은 **자유 입력**이고, 검사 헤더에서 부위를 추측해 넣으면
 *    사용자가 의도하지 않은 좁은 규칙이 된다. 부위는 Setting>행잉에서 넣는다. */
export function hpRuleFromScreen(input: HpRuleFromScreenInput): HpRule {
  const base = input.base ?? null;
  const name = String(input.name ?? "").trim() || "내 프로토콜";
  const screens = mergeHpScreen(base?.screens, input.screen);
  const opt = input.options ?? {};
  /** 지정 안 하면(undefined) base 값을 유지하고, base 도 없으면 새 규칙 기본값(false). */
  const keep = (v: boolean | undefined, prev: boolean | undefined): boolean => (v === undefined ? !!prev : !!v);
  const patch: Partial<HpRule> = {
    name,
    modality: String(input.modality ?? "").trim().toUpperCase(),
    s: clampRC(input.screen.s),
    i: clampRC(input.screen.i),
    wl: input.wl ?? "",
    screens,
    // 체크박스 6종 — 호출자가 **명시한 것만** 바뀐다(위 인터페이스 주석의 사고 참조).
    // ⚠ use_on_exam_open 만 `!== false` 로 읽히는 3-값 필드다(readHpRule ④). base 가 undefined 면
    //   undefined 그대로 둬야 '미지정=자동 적용'이라는 뜻이 안 바뀐다.
    use_on_exam_open: input.useOnExamOpen === undefined
      ? (base ? base.use_on_exam_open : false)
      : !!input.useOnExamOpen,
    priority: keep(input.priority, base?.priority),
    full_link: keep(opt.full_link, base?.full_link),
    full_scroll_sync: keep(opt.full_scroll_sync, base?.full_scroll_sync),
    cross_link: keep(opt.cross_link, base?.cross_link),
    scout_image: keep(opt.scout_image, base?.scout_image),
    source: "viewer",
  };
  // 덮어쓰기면 사용자가 Setting 에서 넣은 값(부위·출처·Projection·설명·id)을 **그대로 둔다**.
  // 뷰어가 갱신하는 것: 화면 배치(screens·s·i) · 장비 · W/L · **호출자가 명시한 체크박스**.
  // 여기서 base 를 버리면 설정에서 채운 매칭 조건이 사라진다.
  return base ? { ...base, ...patch } : newHpRule(patch);
}
