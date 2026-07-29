/* 행잉 프로토콜(HP) — 데이터 계약 · 부위 출처(DICOM 필드) · 시간대 슬롯 · 매칭
 * ════════════════════════════════════════════════════════════════════════════
 * 저장 위치: setting `viewer.hp` = { rules: HpRule[], modalities?: string[] }
 * 여기는 **순수 모듈**이다. React·api·DOM 을 부르지 않는다(테스트가 원본을 그대로 import 한다).
 *
 * 사양(사용자 확정) 대응표
 *   1 프로토콜명            → HpRule.name
 *   2 장비명(+사용자 추가)   → HpRule.modality + HpDoc.modalities (고정 목록 금지 → 프리셋+추가분 병합)
 *   3 Body Part 출처 필드    → HpRule.body_part_fields (복수 선택) + HpRule.body_part(자유 입력)
 *   4 모니터 배치            → HpRule.screens[] (모니터·Series/Image 레이아웃)
 *   4-2 칸에 무엇을 띄울지    → HpScreen.cells[].slot (시간대 슬롯)
 *   5 체크박스 5개           → use_on_exam_open / full_link / full_scroll_sync / cross_link / scout_image
 *   6 뷰어에서 직접 설정      → HpRule.source="viewer" + HpRule.priority('가장 우선 적용', 기본 false)
 *
 * ⚠ 기존 저장값을 깨지 않는다 — readHpDoc/readHpRule 이 구 형식을 새 형식으로 읽고,
 *   syncHpLegacy 가 구 필드(s·i·displays)를 새 값으로 되채워 **구 빌드에서도 읽힌다**.
 */

/* ══════════════ 사양 2 — 장비(Modality) ══════════════
   사용자가 확정한 프리셋 순서 그대로(DX, DR, CR, MG, US, CT, MR).
   ⚠ 고정 목록이면 안 된다 — 병원마다 XA/NM/PT/RF/OT/ES … 가 들어온다. 사용자가 추가한 것은
     HpDoc.modalities 에 쌓고, 이미 규칙이 쓰고 있는 값도 옵션에 넣는다(옵션에서 사라지면
     그 규칙을 편집하는 순간 장비가 빈 값으로 떨어진다 = 저장값 파괴). */
export const HP_MODALITY_PRESETS = ["DX", "DR", "CR", "MG", "US", "CT", "MR"] as const;

/** 장비 콤보에 뜰 목록 — 프리셋 → 사용자 추가분 → 규칙이 실제로 쓰는 값 순, 중복 제거(대문자 정규화). */
export function hpModalityOptions(extra?: readonly string[], rules?: readonly HpRule[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (v: unknown) => {
    const m = String(v ?? "").trim().toUpperCase();
    if (!m || seen.has(m)) return;
    seen.add(m); out.push(m);
  };
  HP_MODALITY_PRESETS.forEach(push);
  (extra ?? []).forEach(push);
  (rules ?? []).forEach((r) => push(r.modality));
  return out;
}

/* ══════════════ 사양 3 — Body Part 를 '어느 DICOM 필드에서' 찾는가 ══════════════
   ⚠ 없는 필드를 늘어놓으면 '골라도 안 걸리는' 설정이 된다. 이 저장소가 **실제로 값을 담고 있는**
     필드만 넣는다(backend 확인 결과, 2026-07 기준):

     body_part   Body Part Examined (0018,0015)
                 · Live(A) : study_body_part 로 채워진다 → 값 있음
                 · 로컬(Orthanc) : register_study 호출부(orthanc.py·worklist.py·maintenance.py·
                   mobile.py·webpacs_bridge.py) 중 **아무도 body_part 를 넘기지 않는다** → 항상 ""
     study_desc  Study Description (0008,1030)
                 · 로컬 : Orthanc MainDicomTags.StudyDescription  · Live : study_description
                 → **유일하게 양쪽 다 값이 있는 필드**. 그래서 새 규칙의 기본 출처에 포함한다.
     order_name  RIS 오더의 Procedure Description (≈ Requested Procedure Description (0032,1060))
                 · 로컬 : Order.procedure_desc 를 accession 으로 매칭(study_service._order_names)
                 · Live : "" 고정
     series_desc Series Description (0008,103E) — 시리즈 목록이 있을 때만(뷰어 안에서는 항상 있다)
                 · 로컬 : Series.series_desc  · Live : series_description

   사양이 예로 든 Protocol Code / Procedure Code / Procedure Step Description 은
   **우리 데이터 어디에도 없다**(백엔드가 그 태그를 읽지도, 저장하지도, 내려주지도 않는다).
   넣으려면 백엔드에서 태그 추출·컬럼 추가가 먼저다 — 그 전에는 UI 에 올리지 않는다. */
export type HpPartField = "body_part" | "study_desc" | "order_name" | "series_desc";

export const HP_PART_FIELDS: {
  key: HpPartField; label: string; tag: string; local: boolean; live: boolean; note: string;
}[] = [
  { key: "body_part",  label: "Body Part Examined", tag: "(0018,0015)", local: false, live: true,
    note: "Live 전용 — 로컬(Orthanc) 검사는 이 값이 비어 있어 절대 걸리지 않는다" },
  { key: "study_desc", label: "Study Description",  tag: "(0008,1030)", local: true,  live: true,
    note: "로컬·Live 양쪽 다 값이 있다 (권장)" },
  { key: "order_name", label: "Procedure Description (RIS 오더명)", tag: "(0032,1060)", local: true, live: false,
    note: "로컬에서 accession 이 오더와 매칭될 때만 — Live 검사는 비어 있다" },
  { key: "series_desc", label: "Series Description", tag: "(0008,103E)", local: true, live: true,
    note: "검사의 모든 시리즈 설명을 합쳐서 본다" },
];

/** 새로 만드는 규칙의 기본 출처 — 로컬·Live 어느 쪽에서도 최소 하나는 값이 있게 둘을 켠다. */
export const DEFAULT_HP_PART_FIELDS: HpPartField[] = ["body_part", "study_desc"];

/** 고른 출처 조합이 '그쪽 검사에서는 절대 값이 없어 규칙이 안 걸리는' 상태인가 — 편집기 경고용.
 *  ⚠ 이 판정이 있어야 하는 이유: body_part 하나만 고른 규칙은 **로컬(Orthanc) 검사에서 절대 안 걸린다**
 *    (register_study 호출부 어디도 body_part 를 넘기지 않아 항상 ""). 화면이 아무 말도 안 하면
 *    사용자는 '설정을 했는데 왜 적용이 안 되나'를 영원히 알 수 없다 — 구 저장본이 정확히 이 상태다.
 *  빈 배열 = 구 저장본과 같은 취급(LEGACY_HP_PART_FIELDS). */
export function hpPartFieldGaps(fields?: readonly HpPartField[]): { local: boolean; live: boolean } {
  const use = (fields && fields.length ? fields : LEGACY_HP_PART_FIELDS);
  const defs = HP_PART_FIELDS.filter((f) => use.includes(f.key));
  return { local: !defs.some((f) => f.local), live: !defs.some((f) => f.live) };
}

/** **구 저장본**의 출처 — 구현이 detail.body_part 만 봤다(Viewer2D:1185 / ViewerInfi:656).
 *  마이그레이션에서 이 값을 쓴다: 필드를 넓히면 지금까지 안 걸리던 규칙이 갑자기 걸려
 *  '어제와 다른 레이아웃'이 된다. 넓히는 것은 사용자가 설정에서 직접 고르는 일이다. */
export const LEGACY_HP_PART_FIELDS: HpPartField[] = ["body_part"];

/* ══════════════ 사양 4-2 — 시간대 슬롯 ══════════════
   그 칸에 무엇을 띄울지. 기준점은 **지금 보는 검사의 검사일**이다(오늘이 아니다) —
   lib/compareBasis.ts 와 backend/app/services/compare_basis.py 의 규칙과 같다.
   · 과거만, 같은 날은 포함(오전/오후 촬영 비교가 흔하다)
   · 하한은 anchor 에서 일수를 뺀 값의 문자열 비교(study_date 가 'YYYYMMDD' 고정폭)
   · 'prev' 는 하한 없이 가장 최근 1건 — 백엔드 period='prev' 와 동일 */
export type HpSlotKind = "current" | "prev" | "1w" | "1m" | "1y" | "custom" | "3d";
export type HpSlotUnit = "d" | "w" | "m" | "y";
export interface HpSlot { kind: HpSlotKind; n?: number; unit?: HpSlotUnit }

export const HP_SLOTS: HpSlotKind[] = ["current", "prev", "1w", "1m", "1y", "custom", "3d"];
export const HP_SLOT_LABEL: Record<HpSlotKind, string> = {
  current: "현재 검사",
  prev: "바로 이전 영상",
  "1w": "1주 내",
  "1m": "1개월 내",
  "1y": "1년 내",
  custom: "기간 직접 설정",
  "3d": "3D 영상",
};
export const HP_SLOT_UNIT_LABEL: Record<HpSlotUnit, string> = { d: "일", w: "주", m: "개월", y: "년" };

/** 칸의 기본값 = 현재 검사. (기본이 과거검사면 검사를 열자마자 남의 날짜가 뜬다) */
export const DEFAULT_HP_SLOT: HpSlot = { kind: "current" };

/** 일수 환산 — 백엔드 _cutoff 가 '365일 = 1년' 으로 빼므로 같은 방식을 쓴다.
 *  달력 월/년이 아니라 일수인 이유: 윤년·말일(1/31→2/31) 예외를 만들지 않기 위해서다.
 *  경계 하루 차이는 판독에 무해하다는 판단이 백엔드에 이미 주석으로 박혀 있다. */
const HP_UNIT_DAYS: Record<HpSlotUnit, number> = { d: 1, w: 7, m: 30, y: 365 };
const HP_SLOT_DAYS: Partial<Record<HpSlotKind, number>> = { "1w": 7, "1m": 30, "1y": 365 };

/** 슬롯이 '과거 검사를 고르는' 슬롯인가. current(현재 검사)·3d(현재 검사의 3D)는 아니다. */
export function hpSlotIsPrior(slot?: HpSlot): boolean {
  const k = slot?.kind ?? DEFAULT_HP_SLOT.kind;
  return k !== "current" && k !== "3d";
}

/** 이 슬롯이 거슬러 올라가는 일수. 0 = 하한 없음(prev·current·3d). */
export function hpSlotDays(slot?: HpSlot): number {
  const s = readHpSlot(slot);
  if (s.kind === "custom") {
    const n = Math.max(1, Math.floor(s.n ?? 1));       // 0·음수·소수는 1 로 — 하한이 미래가 되면 후보가 0 건이 된다
    return n * HP_UNIT_DAYS[s.unit ?? "m"];
  }
  return HP_SLOT_DAYS[s.kind] ?? 0;
}

function ymdToUtc(ymd: string): number | null {
  const d = String(ymd ?? "").trim();
  if (!/^\d{8}$/.test(d)) return null;
  const y = +d.slice(0, 4), m = +d.slice(4, 6), da = +d.slice(6, 8);
  if (m < 1 || m > 12 || da < 1 || da > 31) return null;
  return Date.UTC(y, m - 1, da);
}
function utcToYmd(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/** 기간 하한(YYYYMMDD). "" = 하한 없음.
 *  ⚠ anchor 가 비었거나 형식이 깨졌으면 **"" 를 돌려준다**(오늘로 자르지 않는다).
 *    오늘로 자르면 과거 검사를 판독할 때 후보가 통째로 사라진다 — 없는 것보다 나쁘다. */
export function hpSlotCutoff(anchorDate: string, slot?: HpSlot): string {
  const days = hpSlotDays(slot);
  if (!days) return "";
  const a = ymdToUtc(anchorDate);
  if (a == null) return "";
  return utcToYmd(a - days * 86400000);
}

/** 최소 후보 모양 — Compare 후보(api.compareCandidates)·related_exams 가 그대로 들어맞는다. */
export interface HpCandidate { id: number; study_date: string }

/** 슬롯이 고를 과거 검사들 — 최신순. 호출부는 칸 순서대로 [0],[1],… 을 쓴다.
 *  · current/3d 는 과거 검사를 고르지 않으므로 [] (hpSlotIsPrior 로 먼저 갈라라)
 *  · prev 는 1건만
 *  · currentId 를 주면 그 검사는 뺀다(지금 보는 검사가 후보에 섞여 들어오는 경로가 있다) */
export function hpSlotStudies<T extends HpCandidate>(
  slot: HpSlot | undefined, anchorDate: string, candidates: readonly T[], currentId?: number,
): T[] {
  if (!hpSlotIsPrior(slot)) return [];
  const s = readHpSlot(slot);
  const lo = hpSlotCutoff(anchorDate, s);
  const hi = /^\d{8}$/.test(String(anchorDate ?? "").trim()) ? String(anchorDate).trim() : "";
  const out = (candidates ?? []).filter((c) => {
    if (!c || (currentId != null && c.id === currentId)) return false;
    const d = String(c.study_date ?? "").trim();
    if (!/^\d{8}$/.test(d)) return false;              // 날짜를 모르는 검사는 기간 슬롯에 넣지 않는다
    if (hi && d > hi) return false;                    // 미래(=지금 검사보다 나중)는 '과거 비교'가 아니다
    if (lo && d < lo) return false;
    return true;
  }).slice();
  // 최신순 — 같은 날이면 id 큰 쪽(나중에 등록된 검사)이 앞
  out.sort((a, b) => (a.study_date === b.study_date ? b.id - a.id
                                                    : (a.study_date < b.study_date ? 1 : -1)));
  return s.kind === "prev" ? out.slice(0, 1) : out;
}

/** 한 칸이 쓸 검사 1건 (nth = 같은 슬롯을 쓰는 칸들 중 몇 번째 칸인가, 0-base). 없으면 null. */
export function hpSlotPick<T extends HpCandidate>(
  slot: HpSlot | undefined, anchorDate: string, candidates: readonly T[], nth = 0, currentId?: number,
): T | null {
  const list = hpSlotStudies(slot, anchorDate, candidates, currentId);
  return list[Math.max(0, Math.floor(nth))] ?? null;
}

/** 슬롯 한 줄 표기 — 편집기·툴팁 공용(기간 직접 설정은 값까지 보여야 무엇인지 안다). */
export function hpSlotLabel(slot?: HpSlot): string {
  const s = readHpSlot(slot);
  if (s.kind !== "custom") return HP_SLOT_LABEL[s.kind];
  return `${Math.max(1, Math.floor(s.n ?? 1))}${HP_SLOT_UNIT_LABEL[s.unit ?? "m"]} 내`;
}

/** 저장값 → 슬롯. 모르는 값은 기본(현재 검사)으로 — 설정이 깨져도 화면은 뜬다. */
export function readHpSlot(v: unknown): HpSlot {
  if (typeof v === "string") return HP_SLOTS.includes(v as HpSlotKind) ? { kind: v as HpSlotKind } : { ...DEFAULT_HP_SLOT };
  const o = (v ?? {}) as Partial<HpSlot>;
  const kind = HP_SLOTS.includes(o.kind as HpSlotKind) ? (o.kind as HpSlotKind) : DEFAULT_HP_SLOT.kind;
  if (kind !== "custom") return { kind };
  const unit: HpSlotUnit = (["d", "w", "m", "y"] as const).includes(o.unit as HpSlotUnit) ? (o.unit as HpSlotUnit) : "m";
  return { kind, n: Math.max(1, Math.floor(Number(o.n) || 1)), unit };
}

/* ══════════════ 사양 4 — 모니터 배치 ══════════════ */

/** 행잉 프로토콜 — 디스플레이(모니터) 한 개. **구 형식**(displays). 새 저장은 screens 를 쓴다.
 *  구 빌드가 읽는 필드라 지우지 않는다(syncHpLegacy 가 계속 채운다). */
export interface HpDisplay {
  id: string;
  role: "viewer" | "worklist_report";
  label: string;                    // 표시용 인덱스 라벨 ("1-2", "2-1" …)
  resolution: string;               // 정보용 ("2560 * 1080 (100%)")
  grid: { r: number; c: number };   // viewer 그리드(Series 분할)
  cells: (number | null)[];         // 셀별 시리즈 순번(1-base, null=자동) — 길이 r*c
}

/** HP 디스플레이 기본값 — 그림 등가(뷰어 1 + 워크리스트+판독 1) */
export const DEFAULT_HP_DISPLAYS = (): HpDisplay[] => [
  { id: "d1", role: "viewer", label: "1-2", resolution: "2560 * 1080 (100%)", grid: { r: 1, c: 1 }, cells: [null] },
  { id: "d2", role: "worklist_report", label: "2-1", resolution: "1600 * 1067 (150%)", grid: { r: 1, c: 1 }, cells: [null] },
];

/** 화면 한 칸 — 시리즈 순번(구 cells 값)과 '무엇을 띄울지'(사양 4-2). */
export interface HpCell {
  series: number | null;   // 1-base 시리즈 순번, null=자동(구 형식 그대로)
  slot: HpSlot;            // 기본 { kind: "current" }
}

/** 화면(모니터) 하나 — 사양 4 · 4-1 · 4-2.
 *  monitor 는 Setting>모니터(viewer.prefs.monitor.screens)의 **화면 인덱스(0-base)**.
 *  null = 미지정(연 순서대로 배정). 해상도 문자열은 정보용이라 인덱스와 별개로 남긴다. */
export interface HpScreen {
  id: string;
  role: "viewer" | "worklist_report";
  label: string;
  monitor: number | null;
  resolution: string;
  s: { r: number; c: number };   // 4-1 Series Layout
  i: { r: number; c: number };   // 4-1 Image Layout
  cells: HpCell[];               // 길이 s.r*s.c
}

const clampRC = (v: unknown, d = 1): { r: number; c: number } => {
  const o = (v ?? {}) as { r?: unknown; c?: unknown };
  const n = (x: unknown, f: number) => Math.min(10, Math.max(1, Math.floor(Number(x) || f)));
  return { r: n(o.r, d), c: n(o.c, d) };
};

/** 칸 배열을 r*c 길이로 맞춘다(늘리면 기본 칸, 줄이면 잘라낸다). */
export function fitHpCells(cells: readonly HpCell[] | undefined, grid: { r: number; c: number }): HpCell[] {
  const n = Math.max(1, grid.r * grid.c);
  return Array.from({ length: n }, (_, k) => {
    const c = cells?.[k];
    return { series: c?.series ?? null, slot: readHpSlot(c?.slot) };
  });
}

/** Setting>모니터에서 고른 화면 인덱스로 기본 배치를 만든다(사양 4 — '지금 설정된 모니터를 보여 준다').
 *  첫 화면 = viewer, 나머지 = viewer, 화면이 하나면 워크리스트+판독 화면을 하나 덧붙인다. */
export function hpScreensFromMonitors(
  monitorSel: readonly number[] | undefined,
  s: { r: number; c: number } = { r: 1, c: 1 },
  i: { r: number; c: number } = { r: 1, c: 1 },
): HpScreen[] {
  const sel = (monitorSel ?? []).filter((n) => Number.isFinite(n) && n >= 0);
  const mk = (idx: number | null, k: number, role: HpScreen["role"]): HpScreen => {
    const g = role === "viewer" ? clampRC(s) : { r: 1, c: 1 };
    return { id: `sc${k + 1}`, role, label: String(idx == null ? k + 1 : idx + 1),
             monitor: idx, resolution: "", s: g, i: role === "viewer" ? clampRC(i) : { r: 1, c: 1 },
             cells: fitHpCells(undefined, g) };
  };
  if (!sel.length) return [mk(null, 0, "viewer"), mk(null, 1, "worklist_report")];
  const out = sel.map((idx, k) => mk(idx, k, "viewer"));
  if (out.length === 1) out.push(mk(null, 1, "worklist_report"));
  return out;
}

/* ══════════════ 규칙(HpRule) ══════════════ */

/** 행잉 프로토콜 규칙 (Setting>행잉(HP)).
 *  s/i/wl/displays 는 **구 형식**이다 — screens 가 정본이고, syncHpLegacy 가 구 필드를 되채운다. */
export interface HpRule {
  id: string;
  name: string;                      // 1 프로토콜명
  modality: string;                  // 2 장비 (빈값=모든 장비)
  body_part: string;                 // 3 부위 자유 입력 (빈값=무관, 쉼표/| 로 여러 값 = OR)
  body_part_fields?: HpPartField[];  // 3 부위를 찾을 DICOM 출처(복수). 없으면 구 동작(body_part 만)
  projection: string;                // 검사명(study_desc) 포함 매칭 (PA/AP/LAT…, 빈값=무관)
  description?: string;
  s: { r: number; c: number };       // 구: Series layout
  i: { r: number; c: number };       // 구: Image layout
  wl?: string;                       // "center,width" (빈값=기본)
  // 5 체크박스 5개 — 뷰어 런타임 반영
  use_on_exam_open?: boolean;        // Exam 열 때 HP 사용
  full_link?: boolean;               // 전체 링크
  full_scroll_sync?: boolean;        // 전체 스크롤 동기화
  cross_link?: boolean;              // Cross Link
  scout_image?: boolean;             // Scout 이미지 사용
  displays?: HpDisplay[];            // 구: 디스플레이 레이아웃
  screens?: HpScreen[];              // 4: 모니터 배치(정본)
  priority?: boolean;                // 6: '가장 우선 적용' — ⚠ 기본 false
  source?: "settings" | "viewer";    // 6: 뷰어 '직접설정'에서 저장된 규칙인지(설정 화면 표시용)
}

/** viewer.hp 설정 문서 */
export interface HpDoc { rules: HpRule[]; modalities: string[] }

/** 새 규칙 한 건 — 기본값을 여기 한 곳에만 둔다(설정 화면·뷰어 '직접설정' 저장이 같은 것을 쓴다).
 *  ⚠ priority(가장 우선 적용)는 **반드시 false** 로 시작한다 — 사양이 "기본은 언체크".
 *  ⚠ use_on_exam_open 만 true — 나머지 4개 체크박스는 사용자가 켜는 것이다. */
export function newHpRule(patch?: Partial<HpRule>): HpRule {
  const s = clampRC(patch?.s), i = clampRC(patch?.i);
  return {
    id: `hp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    name: "새 프로토콜", modality: "", body_part: "",
    body_part_fields: [...DEFAULT_HP_PART_FIELDS],
    projection: "", description: "", s, i, wl: "",
    use_on_exam_open: true, full_link: false, full_scroll_sync: false,
    cross_link: false, scout_image: false,
    displays: DEFAULT_HP_DISPLAYS(),
    screens: hpScreensFromMonitors(undefined, s, i),
    priority: false, source: "settings",
    ...patch,
  };
}

const str = (v: unknown) => String(v ?? "");
const partField = (v: unknown): HpPartField | null =>
  HP_PART_FIELDS.some((f) => f.key === v) ? (v as HpPartField) : null;

/** 구 displays → 새 screens. 구 규칙은 Image layout 이 규칙 전체에 하나뿐이라 그것을 모든 viewer 화면에 준다. */
function screensFromDisplays(ds: readonly HpDisplay[], i: { r: number; c: number }): HpScreen[] {
  return ds.map((d, k) => {
    const g = d.role === "viewer" ? clampRC(d.grid) : { r: 1, c: 1 };
    return {
      id: str(d.id) || `sc${k + 1}`,
      role: d.role === "worklist_report" ? "worklist_report" : "viewer",
      label: str(d.label) || String(k + 1),
      monitor: null,                       // 구 형식에는 모니터 인덱스가 없다 — 사용자가 고르기 전까지 미지정
      resolution: str(d.resolution),
      s: g,
      i: d.role === "viewer" ? clampRC(i) : { r: 1, c: 1 },
      cells: fitHpCells((d.cells ?? []).map((c) => ({
        series: typeof c === "number" && c > 0 ? Math.floor(c) : null,
        slot: { ...DEFAULT_HP_SLOT },      // 구 저장본의 칸은 전부 '현재 검사' — 과거검사 슬롯은 새 기능이다
      })), g),
    };
  });
}

/** 저장본 한 규칙 → 새 형식. **값이 사라지지 않는 것**이 이 함수의 계약이다.
 *  ① body_part_fields 없음 → LEGACY_HP_PART_FIELDS(=body_part 만). 구 구현이 그것만 봤다.
 *     넓히면 어제 안 걸리던 규칙이 오늘 걸린다 — 넓히는 것은 사용자가 설정에서 하는 일이다.
 *  ② priority 없음 → false. 사양이 "기본은 언체크" 라고 못 박았다.
 *  ③ screens 없음 → displays 에서 만든다. displays 도 없으면 DEFAULT_HP_DISPLAYS 에서.
 *     (구 규칙의 s/i 를 여기서 잃으면 레이아웃이 통째로 1×1 이 된다)
 *  ④ use_on_exam_open 은 **undefined 를 true 로 읽지 않는다** — 뷰어 두 곳이 `!== false` 로 비교하므로
 *     그대로 두어야 값의 뜻이 바뀌지 않는다. 나머지 체크박스는 undefined=false 로 굳혀도 뜻이 같다. */
export function readHpRule(v: unknown): HpRule {
  const o = (v ?? {}) as Partial<HpRule> & Record<string, unknown>;
  const s = clampRC(o.s), i = clampRC(o.i);
  const fields = Array.isArray(o.body_part_fields)
    ? (o.body_part_fields.map(partField).filter(Boolean) as HpPartField[])
    : null;
  const displays: HpDisplay[] = Array.isArray(o.displays) && o.displays.length
    ? (o.displays as HpDisplay[]) : DEFAULT_HP_DISPLAYS();
  const screens: HpScreen[] = Array.isArray(o.screens) && o.screens.length
    ? (o.screens as HpScreen[]).map((sc, k) => {
        const role: HpScreen["role"] = sc?.role === "worklist_report" ? "worklist_report" : "viewer";
        const g = role === "viewer" ? clampRC(sc?.s, 1) : { r: 1, c: 1 };
        return {
          id: str(sc?.id) || `sc${k + 1}`, role, label: str(sc?.label) || String(k + 1),
          monitor: typeof sc?.monitor === "number" && sc.monitor >= 0 ? Math.floor(sc.monitor) : null,
          resolution: str(sc?.resolution),
          s: g, i: role === "viewer" ? clampRC(sc?.i) : { r: 1, c: 1 },
          cells: fitHpCells(sc?.cells, g),
        };
      })
    : screensFromDisplays(displays, i);
  return {
    id: str(o.id) || `hp${Math.random().toString(36).slice(2, 8)}`,
    name: str(o.name),
    modality: str(o.modality).trim().toUpperCase(),
    body_part: str(o.body_part),
    body_part_fields: fields && fields.length ? Array.from(new Set(fields)) : [...LEGACY_HP_PART_FIELDS],
    projection: str(o.projection),
    description: str(o.description),
    s, i,
    wl: o.wl === undefined ? undefined : str(o.wl),
    use_on_exam_open: o.use_on_exam_open,          // ④ undefined 보존
    full_link: !!o.full_link,
    full_scroll_sync: !!o.full_scroll_sync,
    cross_link: !!o.cross_link,
    scout_image: !!o.scout_image,
    displays,
    screens,
    priority: !!o.priority,                        // ②
    source: o.source === "viewer" ? "viewer" : "settings",
  };
}

/** 새 값(screens) → 구 필드(s·i·displays) 되채우기.
 *  ⚠ 저장 직전에 반드시 부른다. 구 빌드(및 아직 안 고친 호출부: Viewer2D.applyHp / ViewerInfi.applyHpIn)
 *    는 rule.s / rule.i / rule.displays 만 읽는다 — 안 채우면 새로 만든 규칙이 구 경로에서 1×1 로 보인다. */
export function syncHpLegacy(rule: HpRule): HpRule {
  const screens = rule.screens ?? [];
  const v = screens.find((x) => x.role === "viewer");
  return {
    ...rule,
    s: v ? clampRC(v.s) : clampRC(rule.s),
    i: v ? clampRC(v.i) : clampRC(rule.i),
    displays: screens.length
      ? screens.map((sc) => ({
          id: sc.id, role: sc.role, label: sc.label, resolution: sc.resolution,
          grid: sc.role === "viewer" ? clampRC(sc.s) : { r: 1, c: 1 },
          cells: (sc.role === "viewer" ? fitHpCells(sc.cells, clampRC(sc.s)) : [{ series: null, slot: DEFAULT_HP_SLOT }])
                   .map((c) => c.series),
        }))
      : rule.displays,
  };
}

/** setting `viewer.hp` 저장본 → 정규 문서. 모양이 깨져 있어도 던지지 않는다(설정 화면은 떠야 한다). */
export function readHpDoc(v: unknown): HpDoc {
  const o = (v ?? {}) as { rules?: unknown; modalities?: unknown };
  const rules = Array.isArray(o.rules) ? o.rules.map(readHpRule) : [];
  const mods: string[] = [];
  const seen = new Set<string>(HP_MODALITY_PRESETS as readonly string[]);
  if (Array.isArray(o.modalities)) {
    for (const m of o.modalities) {
      const k = str(m).trim().toUpperCase();
      if (k && !seen.has(k)) { seen.add(k); mods.push(k); }
    }
  }
  return { rules, modalities: mods };
}

/** 저장 직전 정규화 — 모든 규칙에 syncHpLegacy 를 걸고, 규칙이 쓰는 비프리셋 장비를 modalities 에 남긴다
 *  (규칙만 저장하고 장비 목록을 안 남기면 다음에 편집기를 열었을 때 그 장비가 콤보에서 사라진다). */
export function writeHpDoc(doc: HpDoc): { rules: HpRule[]; modalities: string[] } {
  const preset = new Set<string>(HP_MODALITY_PRESETS as readonly string[]);
  const mods = new Set(doc.modalities.map((m) => m.trim().toUpperCase()).filter(Boolean));
  for (const r of doc.rules) {
    const m = (r.modality || "").trim().toUpperCase();
    if (m && !preset.has(m)) mods.add(m);
  }
  return { rules: doc.rules.map(syncHpLegacy), modalities: [...mods] };
}

/* ══════════════ 매칭 ══════════════ */

/** 매칭에 쓰는 검사 정보 — StudyDetail 의 부분집합 + 시리즈 설명. */
export interface HpExam {
  modality?: string;
  body_part?: string;
  study_desc?: string;
  order_name?: string;
  series_descs?: readonly string[];
  study_date?: string;
}

const up = (s: unknown) => String(s ?? "").toUpperCase();

/** 고른 출처 필드들의 값을 합친 '건초더미'. 필드 사이에 개행을 넣어 값이 서로 이어붙지 않게 한다
 *  (study_desc "CHEST" + order_name "PA" 가 "CHESTPA" 가 되면 있지도 않은 부위가 걸린다). */
export function hpHaystack(exam: HpExam, fields?: readonly HpPartField[]): string {
  const use = (fields && fields.length ? fields : LEGACY_HP_PART_FIELDS);
  const parts: string[] = [];
  for (const f of use) {
    if (f === "body_part") parts.push(up(exam.body_part));
    else if (f === "study_desc") parts.push(up(exam.study_desc));
    else if (f === "order_name") parts.push(up(exam.order_name));
    else if (f === "series_desc") parts.push(up((exam.series_descs ?? []).join("\n")));
  }
  return parts.filter(Boolean).join("\n");
}

/** 부위 자유 입력 → OR 목록. 쉼표·`|`·줄바꿈 구분(공백은 구분자가 아니다 — "L SPINE" 이 한 값이다). */
export function hpPartTerms(bodyPart: string): string[] {
  return up(bodyPart).split(/[,|\n]/).map((t) => t.trim()).filter(Boolean);
}

/** 규칙 한 건이 이 검사에 걸리는가.
 *  · modality  빈값=모든 장비, 아니면 대문자 완전일치
 *  · body_part 빈값=무관, 아니면 고른 출처들에서 **포함 매칭**(여러 값이면 OR)
 *  · projection 빈값=무관, 아니면 study_desc 포함 매칭 — 구 구현 그대로 둔다(출처 선택은 부위 전용 사양이다) */
export function hpRuleMatches(rule: HpRule, exam: HpExam): boolean {
  const rm = (rule.modality || "").trim().toUpperCase();
  if (rm && rm !== up(exam.modality).trim()) return false;
  const terms = hpPartTerms(rule.body_part || "");
  if (terms.length) {
    const hay = hpHaystack(exam, rule.body_part_fields);
    if (!hay) return false;
    if (!terms.some((t) => hay.includes(t))) return false;
  }
  const proj = up(rule.projection).trim();
  if (proj && !up(exam.study_desc).includes(proj)) return false;
  return true;
}

/** (검사 정보, 규칙 목록) → 적용할 규칙. 없으면 null(=HP 해제).
 *
 *  우선순위 — 사양 6:
 *    ① priority('가장 우선 적용')가 켜진 규칙을 **먼저** 본다(저장 순서 유지)
 *    ② 그다음 나머지 규칙(저장 순서 유지)
 *    ③ 아무것도 안 걸리면 null = HP 해제
 *
 *  forExamOpen=true 면 use_on_exam_open === false 인 규칙을 **건너뛰고 다음 규칙을 본다**.
 *  ⚠ 이 지점이 두 뷰어에서 갈려 있었다: ViewerInfi 는 find 조건에 넣어 건너뛰었고(→ 다음 규칙 적용),
 *    Viewer2D 는 먼저 찾은 뒤 `use_on_exam_open !== false` 로 막아 **아무 규칙도 적용하지 않았다**.
 *    '이 규칙은 수동 전용' 이라는 뜻이므로 다음 규칙을 막을 이유가 없다 → 건너뛰기로 통일한다. */
export function matchHpRule(
  exam: HpExam, rules: readonly HpRule[] | undefined, opts?: { forExamOpen?: boolean },
): HpRule | null {
  const list = rules ?? [];
  const ok = (r: HpRule) =>
    (!opts?.forExamOpen || r.use_on_exam_open !== false) && hpRuleMatches(r, exam);
  return list.find((r) => r.priority && ok(r)) ?? list.find((r) => !r.priority && ok(r)) ?? null;
}

/** 뷰어 드롭다운에 뜨는 순서 — 매칭 순서와 같아야 사용자가 '왜 저게 걸렸지'를 이해한다. */
export function hpRuleOrder(rules: readonly HpRule[] | undefined): HpRule[] {
  const list = rules ?? [];
  return [...list.filter((r) => r.priority), ...list.filter((r) => !r.priority)];
}
