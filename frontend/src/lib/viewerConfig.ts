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

/** 행잉 프로토콜 — 디스플레이(모니터) 한 개. role=viewer 는 Series 그리드를 가짐,
 *  worklist_report 는 워크리스트+판독 창(뷰어 미사용). 물리적 배치는 정보용(런타임 배치는 추후). */
export interface HpDisplay {
  id: string;
  role: "viewer" | "worklist_report";
  label: string;          // 표시용 인덱스 라벨 ("1-2", "2-1" …)
  resolution: string;     // 정보용 ("2560 * 1080 (100%)")
  grid: { r: number; c: number };   // viewer 그리드(Series 분할)
  cells: (number | null)[];         // 셀별 시리즈 순번(1-base, null=자동) — 길이 r*c
}

/** 행잉 프로토콜 규칙 (Setting>행잉(HP)) — 장비×부위×Projection → 레이아웃·옵션·디스플레이.
 *  s/i/wl 은 하위호환(단일 뷰어 Series/Image 분할). displays 가 있으면 viewer 디스플레이가 우선. */
export interface HpRule {
  id: string;
  name: string;
  modality: string;     // 빈값=모든 장비
  body_part: string;    // 부위 포함 매칭 (빈값=무관)
  projection: string;   // 검사명에 포함 매칭 (PA/AP/LAT…, 빈값=무관)
  description?: string;  // 설명
  s: { r: number; c: number };  // Series layout (하위호환)
  i: { r: number; c: number };  // Image layout
  wl?: string;          // "center,width" (빈값=기본)
  // 옵션 (그림) — 뷰어 런타임 반영
  use_on_exam_open?: boolean;   // Exam 열 때 HP 자동 사용
  full_link?: boolean;          // 전체 링크(페인 동기)
  full_scroll_sync?: boolean;   // 전체 스크롤 동기화
  cross_link?: boolean;         // Cross Link(교차 위치 동기)
  scout_image?: boolean;        // Scout 이미지(교차선) 사용
  displays?: HpDisplay[];       // 디스플레이 레이아웃(멀티모니터)
}

/** HP 디스플레이 기본값 — 그림 등가(뷰어 1 + 워크리스트+판독 1) */
export const DEFAULT_HP_DISPLAYS = (): HpDisplay[] => [
  { id: "d1", role: "viewer", label: "1-2", resolution: "2560 * 1080 (100%)", grid: { r: 1, c: 1 }, cells: [null] },
  { id: "d2", role: "worklist_report", label: "2-1", resolution: "1600 * 1067 (150%)", grid: { r: 1, c: 1 }, cells: [null] },
];

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
    { id: "xlink", label: "Link", desc: "Crosslink 5모드 — Off/AutoSync(같은 검사)/SyncOther(과거 포함)/Scout/AllLines" },
    { id: "cursor3d", label: "3DC", desc: "3D Cursor — 클릭점을 다른 페인의 동일 3D 위치로 이동+십자 마커" },
    { id: "pcine", label: "▶p", desc: "페인별 시네 — 페인 호버 시 재생/정지+간격(초) 미니 컨트롤" },
    { id: "key2d", label: "Key", desc: "키이미지 등록/해제 — 현재 이미지 토글 (워크리스트 🔑 연동)" },
    { id: "media", label: "Media", desc: "미디어 재생 — 로컬 이미지/동영상을 활성 페인에 표시" },
    { id: "dict", label: "Dict", desc: "딕테이션 — 음성 녹음/재생 (세션 보관)" },
    { id: "cmp", label: "⇄", desc: "Compare — 같은 환자 과거검사 다중 선택 비교 오픈 (상단바)" },
  ]},
];
