// 뷰어 설정 공용 정의 — Viewer2D와 SettingsModal이 함께 사용 (경량, cornerstone 미포함)

/** Mammo(MG) view 분류 — series_desc 파싱(laterality R/L + view CC/MLO).
 *  DICOM ImageLaterality/ViewPosition 이 미노출이라 first-cut(검사명 파싱). 정확도 필요 시 백엔드 태그 노출로 강화. */
export function mammoView(desc: string): { lat: "R" | "L" | ""; view: "CC" | "MLO" | "" } {
  const d = (desc || "").toUpperCase().replace(/[_-]/g, " ");
  const view: "CC" | "MLO" | "" = d.includes("MLO") ? "MLO" : d.includes("CC") ? "CC" : "";   // "RCC"(무공백) 도 인식
  let lat: "R" | "L" | "" = "";
  if (/\bR\s?CC\b|\bR\s?MLO\b|\bR\s?ML\b|\bRIGHT\b/.test(d)) lat = "R";
  else if (/\bL\s?CC\b|\bL\s?MLO\b|\bL\s?ML\b|\bLEFT\b/.test(d)) lat = "L";
  if (!lat) { if (/\bRT?\b/.test(d)) lat = "R"; else if (/\bLT?\b/.test(d)) lat = "L"; }
  return { lat, view };
}
/** Mammo 표준 2×2 배치 순서 — [R CC, L CC, R MLO, L MLO]. 없는 뷰는 null(빈 페인). */
export function mammoAssign<T extends { series_desc: string }>(list: T[]): (T | null)[] {
  const pick = (lat: "R" | "L", view: "CC" | "MLO") =>
    list.find((s) => { const v = mammoView(s.series_desc); return v.lat === lat && v.view === view; }) ?? null;
  return [pick("R", "CC"), pick("L", "CC"), pick("R", "MLO"), pick("L", "MLO")];
}

/* ══════════════ 2D 행잉 우선순위 — 뷰어 3종의 단일 규정 ══════════════
   설정 화면(뷰어 공통 > 2D 행잉)의 '이 공통 설정을 모든 뷰어에 우선 적용' 체크박스가 규정 원문이다.
   ① MG(유방촬영)는 2D 행잉 표의 대상이 아니다 — 맘모는 언제나 '뷰어 공통' 단일 규정
      (표준 2×2 4-view + mg_hang 타일). 공통/뷰어별 어느 맵에 MG 값이 남아 있어도 무시한다.
   ② 체크 on(키가 없으면 on): **공통 맵만** 본다. 뷰어별(sv/ty/infi)은 통째로 무시 — 폴백 없음.
   ③ 체크 off: **그 뷰어의 맵만** 본다. 공통은 적용하지 않는다 — 폴백 없음.
   ④ 읽는 맵 **안에서만** '*'(기타 전체) 행이 그 맵의 나머지 모달리티를 받는다. 맵을 건너뛰지 않으므로
      ②③ 과 충돌하지 않는다(공통을 읽는 중이면 공통의 '*', 뷰어별을 읽는 중이면 그 뷰어의 '*').
   어느 쪽이든 해당 모달리티 키도 '*' 도 없으면 null = '설정 없음' → 각 뷰어의 자동 규칙에 맡긴다.

   ⚠ 폴백을 되살리면 안 된다. 편집기는 사용자가 만진 모달리티만 맵에 쓰므로 '키 없음'이 정상 상태다.
   여기서 반대쪽 맵으로 떨어뜨리면 체크 on 인데 뷰어별 값이 먹고(=②위반), 체크 off 인데 공통 값이
   먹는다(=③위반). 실제로 그 버그가 있었다(ddafd93 이 0174cca 시절의 하위호환 폴백을 안 걷어냄). */

/** 2D 행잉 한 칸의 값 — {Series 분할, Image 분할}. 구 형식(문자열=Series 만)도 저장본에 남아 있다. */
export type Hang2dVal = string | { s?: string; i?: string };
/** 2D 행잉 관련 viewer.prefs 키 (통짜 prefs 문서에서 이 세 개만 본다) */
export interface Hang2dPrefs {
  hanging2d?: Record<string, Hang2dVal>;                          // 공통 맵
  hanging2d_common_on?: boolean;                                  // 공통 우선 적용 (미저장=on)
  hanging2d_by_viewer?: Record<string, Record<string, Hang2dVal>>; // 뷰어별 맵 (sv/ty/infi)
}
export type Hang2dViewer = "sv" | "ty" | "infi";

/** 스킨 → 2D 행잉 맵 키. Viewer2D 는 SaintView(sv)/T-View(ty) 스킨을 공유하지만 맵은 뷰어별로 따로다.
 *  호출부마다 삼항을 쓰면 또 갈리므로 산출을 여기 한 곳으로 모은다. */
export function hang2dViewerKey(skin?: string): Hang2dViewer {
  return skin === "saint" || skin === "sv" ? "sv" : skin === "infi" ? "infi" : "ty";
}

/** '기타(전체)' 행 키 — 그 맵에 행이 없는 나머지 모달리티를 받는다(같은 맵 안에서만, 규정 ④).
 *  구 I-View 'Modality 기본 레이아웃'(ee88de4 에서 삭제)의 마지막 행이 이 값이었다. */
export const HANG2D_ANY = "*";

/** 구/신 형식 정규화 — 값이 없거나 빈 칸이면 null(=설정 없음). */
export function normHang2d(v?: Hang2dVal): { s?: string; i?: string } | null {
  if (!v) return null;
  if (typeof v === "string") return v ? { s: v } : null;
  const s = v.s || undefined, i = v.i || undefined;
  return s || i ? { s, i } : null;
}

/** 2D 행잉 선택 — 위 규정 ①②③④ 의 유일한 구현. 세 뷰어(Viewer2D=sv/ty, ViewerInfi=infi)가 이것만 부른다.
 *  반환 null = '설정 없음' → 호출부의 자동 규칙(1×1, CT/MR 3×3 등)으로 넘어간다. */
export function pickHang2d(prefs: Hang2dPrefs | undefined, viewer: Hang2dViewer, modality: string):
  { s?: string; i?: string } | null {
  if (!prefs || !modality) return null;
  if (modality === "MG") return null;                       // ① 맘모는 공통 mg_hang 규정 — 2D 행잉 표 밖
  const commonOn = prefs.hanging2d_common_on ?? true;       // 미저장 계정 = 체크 on (구 계정 보호)
  const src = commonOn ? (prefs.hanging2d ?? {})            // ② 공통만
                       : (prefs.hanging2d_by_viewer?.[viewer] ?? {});   // ③ 그 뷰어만
  return normHang2d(src[modality]) ?? normHang2d(src[HANG2D_ANY]);      // ④ 같은 맵 안의 '*' 만
}

/** 위 규정에서 '실제로 읽히는' 맵. 편집 대상 키 집합을 좁힐 때 쓴다(반대쪽 맵 키가 섞이면 ②③ 위반). */
export function activeHang2dMap(prefs: Hang2dPrefs | undefined, viewer: Hang2dViewer): Record<string, Hang2dVal> {
  if (!prefs) return {};
  return (prefs.hanging2d_common_on ?? true) ? (prefs.hanging2d ?? {}) : (prefs.hanging2d_by_viewer?.[viewer] ?? {});
}

/** 2D 행잉 편집기에 뜨는 모달리티 — 설정 화면(공통 1 + 뷰어별 3)이 공유한다.
 *  ⚠ MG 는 일부러 뺐다. 맘모는 2D 행잉 표 밖(뷰어 공통 mg_hang 전용 규정)이라 여기 있으면
 *     사용자가 만질 수 있는데 뷰어마다 다르게 반응하는 칸이 된다(Viewer2D 무시 / ViewerInfi 만 반영).
 *  ⚠ DX 는 빼면 안 된다. 일반촬영의 표준 DICOM Modality 코드는 CR/DX 이고(이 저장소도 실제로
 *     ["CR","DX"] 로 묶어 쓴다 — ViewerInfi 오버레이·워크리스트·HP 편집기), 여기 없으면 DX 검사를
 *     보는 계정이 2D 행잉을 지정할 방법 자체가 없다. 구 I-View 표에도 DX 행이 있었다.
 *  ⚠ '*'(기타 전체)도 마찬가지 — 구 I-View 표의 행이었다. 여기 없으면 구 계정의 '*' 값이
 *     '저장본에는 남아 있는데 아무도 안 읽고 다시 지정할 UI 도 없는' 죽은 값이 된다. */
export const HANG2D_MODS = ["CR", "DR", "DX", "US", "CT", "MR", "XA", "NM", "PT", "*"];

/** 편집기 행 라벨 — '*' 는 사람이 읽는 이름으로. */
export function hang2dModLabel(m: string): string { return m === HANG2D_ANY ? "기타(전체)" : m; }
/** 뷰어 키 → 표기명 (설정 트리와 동일: SaintView → I-View → T-View) */
export function hang2dViewerLabel(v: string): string {
  return v === "sv" ? "SaintView" : v === "infi" ? "I-View" : v === "ty" ? "T-View" : v;
}

export const H2D_VIEWERS = ["sv", "infi", "ty"] as const;
/** 2D 행잉 한 칸(편집기·마이그레이션이 다루는 정규 형식 — 구 문자열 형식은 로드 시 여기로 정규화). */
export interface Hang2dCell { s: string; i: string }
/** 자동으로 옮기지 않은 값 — 옮기면 '손대지 않은 다른 뷰어'의 화면이 바뀌므로 사용자가 정해야 한다. */
export interface Hang2dPending {
  m: string;                                                   // 모달리티 ('*' = 기타 전체)
  cur: { v: Hang2dViewer; s: string; i: string }[];             // 값을 가진 뷰어 (설정 트리 순서)
  auto: Hang2dViewer[];                                        // 값이 없어 '자동'이던 뷰어
}
export interface Hang2dMigration {
  common: Record<string, Hang2dCell>;
  byViewer: Record<string, Record<string, Hang2dCell>>;
  moved: number;                 // 실제로 옮긴 칸 수 (안내 문구의 N)
  pending: Hang2dPending[];      // 옮기지 않은 값 — 안내에 모달리티·뷰어·값을 그대로 찍는다
  dropped: string[];             // 2D 행잉 표에 행이 없어 어떤 뷰어도 읽지 않는 구 키
}

/** 저장본 정리 — 규정(pickHang2d)이 읽지 않는 값을 규정 안으로 접는다. 저장 시 확정.
 *
 *  ⚠ **로드 때 한 번이 아니라 저장 직전에도 돌려야 한다.** commonOn 은 같은 다이얼로그에서 사용자가
 *     뒤집을 수 있는 값이라, 로드 시점 값으로만 계산하면 체크를 토글하고 OK 를 누른 순간
 *     '읽히는 쪽 맵'이 통째로 비어 세 뷰어의 행잉이 전부 초기화된다(폴백을 없앴으므로 구제 불가).
 *     SettingsModal 은 체크박스 onChange 와 save() 양쪽에서 부른다 — 멱등이라 두 번 돌아도 무해하다.
 *
 *  ① MG 키 제거: 맘모는 2D 행잉 표 밖(mg_hang 전용 블록)이다. 남겨 두면 다음 사람이 또 헷갈린다.
 *  ② 구 infi_default_layout(편집 UI 가 ee88de4 에서 삭제된 유령 값)을 뷰어별 infi 맵으로 접는다.
 *     DX·'*' 도 함께 접는다 — HANG2D_MODS 에 행이 생겼다(그 전에는 값만 남고 아무도 안 읽었다).
 *  ③ 폴백 실효값 굳히기: 예전 구현은 키가 없으면 반대쪽 맵으로 떨어졌다. 폴백을 없애면 그 배치가
 *     '자동'으로 돌아가 "멀쩡하던 행잉이 초기화됐다"가 된다 → 실제로 적용되던 값을 읽히는 쪽에 굳힌다.
 *     · 체크 off(각 뷰어를 읽음): 공통 값을 그 값이 없는 뷰어에 복사 — 어느 뷰어도 화면이 안 바뀐다.
 *     · 체크 on(공통만 읽음): **세 뷰어의 실효값이 전부 같을 때만** 공통으로 승격한다.
 *       한 뷰어에만 있던 값을 올리면 원래 '자동'이던 나머지 두 뷰어의 화면까지 바뀐다 —
 *       구 I-View 전용 값(infi_default_layout)이 SaintView·T-View 로 번지는 경로가 정확히 이거였다.
 *       승격하지 않은 값은 지우지 않고 뷰어별 맵에 그대로 두고(체크를 해제하면 다시 산다)
 *       pending 으로 돌려준다 — 설정 화면이 모달리티·뷰어·값을 찍고 사용자가 직접 올린다.
 *
 *  legacyInfi 는 구 infi_default_layout 을 "RxC" 문자열로 정규화한 것. 저장 직전 재실행에서는 {}.
 */
export function migrateHang2d(
  common: Record<string, Hang2dCell>,
  byViewer: Record<string, Record<string, Hang2dCell>>,
  commonOn: boolean,
  legacyInfi: Record<string, Hang2dCell>,
): Hang2dMigration {
  const c: Record<string, Hang2dCell> = { ...common };
  const bv: Record<string, Record<string, Hang2dCell>> = {};
  for (const vk of H2D_VIEWERS) bv[vk] = { ...(byViewer[vk] ?? {}) };
  for (const [vk, m] of Object.entries(byViewer)) if (!bv[vk]) bv[vk] = { ...m };
  let moved = 0;
  const pending: Hang2dPending[] = [];
  const dropped: string[] = [];
  delete c.MG;                                                    // ①
  for (const vk of Object.keys(bv)) if (bv[vk].MG) { delete bv[vk].MG; moved++; }

  // 구 값 정규화 — 빈 칸은 '설정 없음'(1x1 로 굳히면 없던 설정이 생긴다), 표에 행이 없는 키는 dropped
  const legacy: Record<string, Hang2dCell> = {};
  for (const [m, cfg] of Object.entries(legacyInfi ?? {})) {
    if (m === "MG" || !cfg || (!cfg.s && !cfg.i)) continue;
    if (!HANG2D_MODS.includes(m)) { dropped.push(m); continue; }
    legacy[m] = { s: cfg.s || "1x1", i: cfg.i || "1x1" };
  }
  // ② — 뷰어별 infi 에 값이 없는 모달리티만(사용자가 나중에 지정한 값을 되돌리지 않는다)
  const foldLegacy = () => {
    for (const [m, cfg] of Object.entries(legacy)) {
      if (bv.infi[m]) continue;
      bv.infi[m] = cfg; moved++;
    }
  };
  /** 이 정리 **전에** 그 뷰어 화면에 실제로 적용되던 값(배포본의 폴백 식 그대로).
   *  sv/ty 는 뷰어별 맵만, infi 는 뷰어별 맵 → 구 infi_default_layout 순. 공통은 호출부에서 이미 걸렀다. */
  const effOld = (vk: Hang2dViewer, m: string): Hang2dCell | null =>
    byViewer[vk]?.[m] ?? (vk === "infi" ? legacy[m] ?? null : null);
  const same = (a: Hang2dCell, b: Hang2dCell) => a.s === b.s && a.i === b.i;

  if (commonOn) {                                               // ③ 공통만 읽힌다
    foldLegacy();
    const mods = new Set<string>();
    for (const vk of H2D_VIEWERS) for (const m of Object.keys(bv[vk] ?? {})) mods.add(m);
    for (const m of mods) {
      if (c[m] || !HANG2D_MODS.includes(m)) continue;
      const all = H2D_VIEWERS.map((v) => ({ v, val: effOld(v, m) }));
      const have = all.filter((x) => x.val) as { v: Hang2dViewer; val: Hang2dCell }[];
      if (!have.length) continue;
      if (have.length === H2D_VIEWERS.length && have.every((x) => same(x.val, have[0].val))) {
        c[m] = have[0].val; moved++;      // 세 뷰어가 같은 값 → 승격해도 어느 화면도 바뀌지 않는다
      } else {
        pending.push({ m,
          cur: have.map((x) => ({ v: x.v, s: x.val.s, i: x.val.i })),
          auto: all.filter((x) => !x.val).map((x) => x.v) });
      }
    }
  } else {                                                      // ③ 각 뷰어 맵만 읽힌다
    // 순서가 규칙이다 — 배포본의 infi 폴백은 `뷰어별 → 공통 → 구 infi_default_layout` 이었다.
    // 구 값을 먼저 접으면 공통보다 구 값이 이겨서 I-View 만 다른 행잉이 된다.
    for (const vk of H2D_VIEWERS) {
      for (const [m, cfg] of Object.entries(c)) {
        if (bv[vk][m] || !HANG2D_MODS.includes(m)) continue;
        bv[vk][m] = cfg; moved++;
      }
    }
    foldLegacy();
  }
  return { common: c, byViewer: bv, moved, pending, dropped };
}

/** Client 뷰어 레지스트리 — Setting>뷰어>선택 뷰어.
 *  현행 자체 뷰어(Viewer2D) = TY Viewer. 신규 뷰어는 여기 등록 + ViewerWindow의 컴포넌트 맵에 연결.
 *  available=false 면 설정 콤보에서 비활성(개발 중) 표시. */
// 표기·순서 규약: SaintView → I-View → T-View (설정 트리·모드 프로파일 콤보와 동일)
export const CLIENT_VIEWERS: { id: string; label: string; desc: string; available: boolean }[] = [
  { id: "sv", label: "SaintView", desc: "SaintView 스타일 뷰어 — 상단 가로 메뉴 툴바(Image Tool·Measurement·Reading Support·Additional). 엔진·기능은 T-View 재사용", available: true },
  { id: "infi", label: "I-View", desc: "INFINITT 스타일 뷰어 — 세로 툴바·격자 1x1~4x4·우드래그 W/L·Auto Sync·Combine Series", available: true },
  { id: "ty", label: "T-View", desc: "자체 Client 뷰어 (현행 — 세로 팔레트·2단 썸네일)", available: true },
];
export const DEFAULT_CLIENT_VIEWER = "ty";

/* 행잉 프로토콜(HP) 의 계약(HpRule·HpDisplay·DEFAULT_HP_DISPLAYS·매칭·시간대 슬롯·마이그레이션)은
   **lib/hangingProtocol.ts** 에 있다. 여기에 다시 두지 마라 — 정의가 갈린다.
   ⚠ 여기서 re-export 도 하지 않는다: tests/*.test.mjs 가 Node 의 타입 스트리핑으로 이 .ts 를 직접
     import 하는데, 확장자 없는 상대 import 는 Node ESM 이 해석하지 못해 테스트가 통째로 죽는다
     (실제로 그렇게 hang2d_rule.test.mjs 가 ERR_MODULE_NOT_FOUND 로 깨졌다). */

/** W/L 프리셋 (Presetting — Setting>뷰어에서 편집, 계정 로밍) */
export interface WlPreset { key: string; label: string; q: string }

export const DEFAULT_WL_PRESETS: WlPreset[] = [
  { key: "auto", label: "Auto", q: "" },
  { key: "lung", label: "폐", q: "-600,1500" },
  { key: "medi", label: "종격동", q: "40,400" },
  { key: "bone", label: "뼈", q: "300,1500" },
  { key: "brain", label: "뇌", q: "40,80" },
  { key: "abd", label: "복부", q: "60,400" },
];

/** 툴바 기능 카탈로그 (UBPACS p.18~21) — Setting>뷰어>Tools bar에서 표시 여부 설정(계정 로밍) */
export const TOOLBAR_DEFS: { section: string; items: { id: string; label: string; desc: string }[] }[] = [
  { section: "Common Tools", items: [
    { id: "zoom", label: "Zoom", desc: "확대/축소 (좌드래그)" },
    { id: "pan", label: "Pan", desc: "이동" },
    { id: "fit", label: "Fit", desc: "화면맞춤 — 영상 Layout에 이미지 크기를 맞춤" },
    { id: "inv", label: "Inv", desc: "화면 반전" },
    { id: "rotL", label: "⟲90", desc: "반시계방향 90도 회전" },
    { id: "rotR", label: "⟳90", desc: "90도 회전" },
    { id: "rot180", label: "⟳180", desc: "180도 회전" },
    { id: "flipH", label: "⇋", desc: "좌우변경" },
    { id: "flipV", label: "⇵", desc: "상하변경" },
    { id: "cine", label: "▶", desc: "시네 재생 (녹음 재생 계열)" },
    { id: "cap", label: "Cap", desc: "내보내기 — 이미지를 PNG 파일로 저장" },
    { id: "reset", label: "Reset", desc: "초기화 — 조작된 W/L·확대축소 등 초기화" },
    { id: "sharpen", label: "Shrp", desc: "Sharpen 필터 — 윤곽 선명화 (활성 페인 토글)" },
    { id: "average", label: "Avg", desc: "Average 필터 — 부드럽게(블러, 활성 페인 토글)" },
    { id: "pseudo", label: "Psd", desc: "Pseudo Color — 의사색 컬러맵 근사 (활성 페인 토글)" },
    { id: "mag", label: "Mag", desc: "확대경 — 마우스 위치를 따라다니는 3배 렌즈" },
  ]},
  { section: "Annotation Tools", items: [
    { id: "length", label: "Len", desc: "선/길이 측정 (Caliper)" },
    { id: "angle", label: "Ang", desc: "각도 측정" },
    { id: "rect", label: "Rect", desc: "사각형 + 영역정보(ROI 측정값)" },
    { id: "ellipse", label: "Elps", desc: "원/타원 + 영역정보(ROI 측정값)" },
    { id: "arrow", label: "Arrw", desc: "화살표" },
    { id: "text", label: "Text", desc: "Text/Memo 입력" },
    { id: "poly", label: "Poly", desc: "폴리라인 — 경로 길이 측정(여러 점 클릭, 더블클릭 종료)" },
    { id: "circle", label: "Circ", desc: "원 계측 — 중심→가장자리 2점, 반지름" },
    { id: "centerline", label: "CLine", desc: "Center Line — 두 선(4점)의 중앙선 표시" },
    { id: "mctr", label: "CTR4", desc: "수동 심흉비 — 심장 2점+흉곽 2점 → CTR % (AI CTR 과 별개)" },
    { id: "box", label: "Box", desc: "박스 메모 — 두 점 + 제목 입력" },
    { id: "spine", label: "SpLbl", desc: "Spine Label — 클릭 연번 라벨(첫 클릭에 시작 라벨 입력)" },
    { id: "marking", label: "Mark", desc: "Marking — 클릭 + 짧은 표기 입력(①, R, ✓ 등)" },
    { id: "ref", label: "Ref", desc: "Cross link — Scout 라인 확인" },
    { id: "ctr", label: "CTR", desc: "CT Ratio — 폐·심장 비율 측정(AI 초안)" },
    { id: "save", label: "Save", desc: "저장 — 영상에 조작된 작업(주석) 저장" },
    { id: "gsps", label: "GSPS", desc: "표시 상태 표준 저장(Presentation State)" },
    { id: "del", label: "Del", desc: "마지막 주석 삭제" },
    { id: "clr", label: "Clr", desc: "주석·셔터 전체 삭제 (초기화)" },
  ]},
  // TY 해부학 측정 4종 — Viewer2D ANATOMY_TOOL_DEFS 와 id/label 1:1 (tbOn 기본 표시, 여기서 끄기 가능)
  { section: "Anatomy Tools", items: [
    { id: "cobb", label: "Cobb", desc: "콥 각(척추측만) — 4점: 두 직선 사이 예각(°)" },
    { id: "leg", label: "Leg", desc: "다리 길이 — 4점: 좌/우 라인 각 길이(mm)와 좌우 차이" },
    { id: "pelvis", label: "Pelvis", desc: "골반 틀어짐 — 좌·우 장골능 2점, 수평 대비 각도(°)·높이차(mm)" },
    { id: "spineCurve", label: "Spine", desc: "척추 외곡 — 3점 이상 더블클릭 종료, 기준선 대비 최대 편위(mm)" },
  ]},
  { section: "Pixel & Shutter Tools", items: [
    { id: "lens", label: "Lens", desc: "Lens — 클릭 지점 픽셀값 근사 HU('≈' 표기)" },
    { id: "profile", label: "Prof", desc: "Profile — 두 점 선의 픽셀값 그래프" },
    { id: "table2d", label: "Tbl", desc: "2D Table — 두 점 영역 픽셀값 표" },
    { id: "shutRect", label: "ShR", desc: "사각 셔터 — 영역 밖 가림(페인별, Clr/Reset 해제)" },
    { id: "shutEl", label: "ShE", desc: "타원 셔터 — 영역 밖 가림(페인별, Clr/Reset 해제)" },
    { id: "shutPoly", label: "ShP", desc: "다각 셔터 — 여러 점 클릭, 더블클릭 종료" },
  ]},
  { section: "ETC Tools", items: [
    { id: "ohif", label: "OHIF", desc: "Advanced View — OHIF 뷰어 호출" },
    { id: "3d", label: "3D", desc: "3D MPR/MIP 뷰어" },
    { id: "rfsh", label: "Rfsh", desc: "Refresh Exam — 활성 검사 시리즈 재조회" },
    { id: "comb", label: "Comb", desc: "Combine Series — 같은 검사의 모든 시리즈를 한 스택으로 결합" },
    { id: "print", label: "Print", desc: "인쇄 — 현재 화면을 브라우저 인쇄(window.print)" },
    { id: "calib", label: "Calib", desc: "Calibrate — 현재 이미지 Pixel Spacing 정보 안내" },
  ]},
  // TY-3: 워크플로·연동 계열 (In Viewer 이식)
  { section: "Workflow Tools", items: [
    { id: "hist", label: "◀◯▶", desc: "작업 히스토리 — Undo/초기화/Redo (시각조정+주석 스냅샷 최대 50, 상단바)" },
    { id: "xlink", label: "Link", desc: "Crosslink — 독립 토글 5개: Crosslink(마스터)/AutoSync(같은 검사)/SyncOther(과거 포함)/Scout/AllLines(기준 축 전체)" },
    { id: "cursor3d", label: "3DC", desc: "3D Cursor — 클릭점을 다른 페인의 동일 3D 위치로 이동+십자 마커" },
    { id: "pcine", label: "▶p", desc: "페인별 시네 — 페인 호버 시 재생/정지+간격(초) 미니 컨트롤" },
    { id: "key2d", label: "Key", desc: "키이미지 등록/해제 — 현재 이미지 토글 (워크리스트 🔑 연동)" },
    { id: "media", label: "Media", desc: "미디어 재생 — 로컬 이미지/동영상을 활성 페인에 표시" },
    { id: "dict", label: "Dict", desc: "딕테이션 — 음성 녹음/재생 (세션 보관)" },
    { id: "cmp", label: "⇄", desc: "Compare — 같은 환자 과거검사 다중 선택 비교 오픈 (상단바)" },
  ]},
];

/* ── 검사 전환 시 분할 재계산 ───────────────────────────────────────────────
 * ⚠ 실제로 났던 사고: CT(Series 2×2)를 보다가 탭으로 DR/MG 검사를 열면 **CT 의 2×2 가 그대로
 *   남았다.** 화면은 4칸인데 DR 은 시리즈가 1~2개라 나머지 칸이 빈 채로 있어 "영상이 안 뜬다"
 *   처럼 보였고, DR·MG 자기 설정(Series 1×1)은 무시됐다.
 *
 *   원인은 단순했다 — pickHang2d 가 **prefs 로드 effect 안에서 주 검사 modality 로 한 번만**
 *   불렸다. 탭 전환에는 재계산 지점이 아예 없었다.
 *
 * 그래서 '어떤 modality 를 열 때 어떤 분할인가' 를 이 순수 함수 하나로 못박고, 뷰어는 검사가
 * 바뀔 때마다 이것을 다시 부른다. 규칙이 두 군데로 갈리지 않게 하는 것이 목적이다.
 */
export interface Hang2dResolved {
  /** Series 분할 키(LAYOUTS 의 키, 예 "2x2") — 없으면 뷰어가 현재 값을 유지한다 */
  s: string | null;
  /** Image(페인 내 타일) 분할 — 없으면 1×1 */
  i: { r: number; c: number } | null;
}

/**
 * 이 검사(modality)를 열 때 걸 분할.
 *
 * MG 는 2D 행잉 표 밖이라 pickHang2d 가 null 을 준다 — 대신 **mg 전용 규정**을 쓴다.
 * mgLayout 을 넘기지 않으면(2D-MG 꺼짐 등) MG 도 분할을 강제하지 않는다.
 */
/** MG 분할 지정 — layout("2x2") + 방식. series=false(기본)가 Image 분할이다.
 *  문자열만 주면 구 호출(Series 분할)로 취급한다. */
export type MgLayoutSpec = string | { layout: string; series: boolean } | null | undefined;

export function resolveHang2d(
  prefs: Hang2dPrefs | undefined,
  viewer: Hang2dViewer,
  modality: string,
  mgLayout?: MgLayoutSpec,
  /** 지금 **행잉 프로토콜이 걸려 있는가**. 걸려 있으면 분할은 HP 가 정한다(사용자 확정 규정). */
  hpActive = false,
): Hang2dResolved {
  // ── 우선순위 (사용자가 '결코 변하지 않는다' 고 못박은 규정) ──────────────
  //   ① 행잉 프로토콜이 **선택**되어 있으면 그것이 이긴다. HP 기본은 해제다.
  //   ② HP 해제 상태에서 '이 공통 설정을 모든 뷰어에 우선 적용' 이 **체크**면 공통 표.
  //   ③ 그 체크가 **해제**면 그 뷰어(SaintView/I-View/T-View) 개별 표.
  //   ④ MG 는 위 표 밖 — 언제나 맘모 규정(mg_hang).
  //   ②③ 판정은 pickHang2d 한 곳에만 있다(폴백 없음). 여기서 다시 분기하지 않는다.
  if (hpActive) return { s: null, i: null };      // ① HP 가 정한다 — 건드리지 않는다
  // ⚠ trim 이 필요하다 — 공백만 있는 값은 '모른다' 이지 '   ' 라는 모달리티가 아니다.
  //   trim 없이 넘기면 pickHang2d 가 '*'(기타 전체)로 폴백해, 모달리티를 못 읽은 상황에서
  //   엉뚱한 분할을 **강제**한다. 모르면 강제하지 않는 것이 규정이다.
  const mod = String(modality || "").trim().toUpperCase();
  if (mod === "MG") {
    // MG 는 mg_hang 규정. ⚠ 분할 **방식**을 반영해야 한다 — 기본(Image 분할)은
    //   Series 1×1 + 페인 안 타일이다. 예전에 이 분기가 layout 을 Series 로만 돌려줘서,
    //   탭으로 MG 에 오면 Image 모드인데 Series 2×2 가 걸리는 어긋남이 있었다.
    if (!mgLayout) return { s: null, i: null };          // 2D-MG 꺼짐 — 강제하지 않는다
    const m = typeof mgLayout === "string" ? { layout: mgLayout, series: true } : mgLayout;
    if (!m.layout) return { s: null, i: null };
    if (m.series) return { s: m.layout, i: null };       // Series 분할 — 뷰당 페인 1칸
    const rc = rcOf(m.layout);
    return { s: "1x1", i: rc && (rc.r > 1 || rc.c > 1) ? rc : null };   // Image 분할(기본)
  }
  const hv = pickHang2d(prefs, viewer, mod);
  const s = hv?.s || null;
  const i = hv?.i ? rcOf(hv.i) : null;
  return { s, i: i && (i.r > 1 || i.c > 1) ? i : null };
}

/** "2x3" → {r:2,c:3}. 형식이 아니면 null. */
function rcOf(key: string): { r: number; c: number } | null {
  const m = /^(\d+)x(\d+)$/.exec(String(key).trim());
  if (!m) return null;
  const r = Number(m[1]), c = Number(m[2]);
  return r > 0 && c > 0 ? { r, c } : null;
}

/** 분할 키의 페인 수. ⚠ setLayout 직후에는 state 가 아직 옛값이라, 새 분할로 페인을 채울 때는
 *  **이 값**을 써야 한다(그 혼동이 빈 칸 사고의 절반이었다). */
export function paneCountOf(layoutKey: string | null | undefined, fallback = 1): number {
  const rc = layoutKey ? rcOf(layoutKey) : null;
  return rc ? rc.r * rc.c : fallback;
}
