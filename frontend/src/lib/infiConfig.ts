// In Viewer(INFINITT 스타일) 구성 — 파일 수준 정밀 분석에서 도출한 선언적 설정.
// 근거: docs/ANALYSIS_INFINITT_파일정밀분석.md (C:\INFINITT 전수 분석 — .lda/.win/.lut/PiSTAR2.tbx/exe 문자열)
// 원칙(분석 §10): 컬럼·툴바·W/L·오버레이·행잉을 전부 선언적 설정으로 외부화하고 사용자별 로밍(viewer.prefs).

/** 워크리스트 컬럼 — Layout\SAMPLE1.lda 의 "필드명(픽셀폭)" 체계 등가 */
export const IN_WORKLIST_COLUMNS: { id: string; label: string; width: number }[] = [
  { id: "patient_name", label: "Name", width: 150 },
  { id: "patient_key", label: "ID", width: 150 },
  { id: "age_sex", label: "Age, Sex", width: 150 },
  { id: "birth_date", label: "Birth date", width: 150 },
  { id: "report", label: "REPORT", width: 250 },
  { id: "institution", label: "Hospital", width: 100 },
  { id: "reading", label: "Reading", width: 150 },
  { id: "dx", label: "Dx", width: 150 },
  { id: "fx", label: "Fx", width: 150 },
];

/** 모달리티 탭 — PiView.mol 원본 목록 */
export const IN_MODALITY_TABS = ["ALL", "CR", "CT", "DR", "ES", "MR", "NM", "OT", "RF", "US", "XA"];

/** 이미지 격자 레이아웃 — WEBVIEW.HTM selLayout + "Image Layouts" */
export const IN_LAYOUTS: { r: number; c: number }[] = [
  { r: 1, c: 1 }, { r: 2, c: 2 }, { r: 2, c: 3 }, { r: 3, c: 3 }, { r: 3, c: 4 }, { r: 4, c: 4 },
];

/** 시리즈 정렬 4기준 — "Series Sort" 문자열 */
export const IN_SERIES_SORTS = [
  { key: "image_number", label: "Image number" },
  { key: "image_time", label: "Image time" },
  { key: "slice_position", label: "Slice position" },
  { key: "echo_time", label: "Echo time" },
];

/** CT W/L 프리셋 — PiView.win 프리셋명 + 표준 임상값(center,width) */
export const IN_WL_PRESETS_CT: { key: string; label: string; q: string }[] = [
  { key: "original", label: "Original", q: "" },
  { key: "crane", label: "Crane(두개)", q: "40,80" },
  { key: "abdomen", label: "Abdomen", q: "60,400" },
  { key: "pelvis", label: "Pelvis", q: "40,400" },
  { key: "mediastinum", label: "Mediastinum", q: "40,400" },
  { key: "bone", label: "Bone", q: "300,1500" },
  { key: "lung", label: "Lung", q: "-600,1500" },
];

/** MR W/L 프리셋 — RapidiaMPR Preset\WindowMR.dat 12레코드 (WL/WW 실측값) */
export const IN_WL_PRESETS_MR: { key: string; label: string; q: string }[] = [
  { key: "abd_t1", label: "Abdomen T1", q: "165,200" },
  { key: "abd_t2", label: "Abdomen T2", q: "266,256" },
  { key: "chest_t1", label: "Chest T1 Sag", q: "168,230" },
  { key: "chest_t2", label: "Chest T2 Sag", q: "129,290" },
  { key: "head_t1a", label: "Head T1 Axi", q: "400,858" },
  { key: "head_t1c", label: "Head T1 Cor", q: "776,880" },
  { key: "head_t2a", label: "Head T2 Axi", q: "279,948" },
  { key: "neck_t1", label: "Neck T1 Sag", q: "274,442" },
  { key: "neck_t2", label: "Neck T2 Sag", q: "62,152" },
  { key: "spine_t1", label: "Spine T1 Sag", q: "69,168" },
  { key: "spine_t2", label: "Spine T2 Sag", q: "316,1264" },
  { key: "t1", label: "T1", q: "210,1000" },
];

/** 툴바 워크스페이스 — PiSTAR2.tbx 6그룹(Default/Display/Annotation/Etc/Diagnose/Verify)에
 *  exe 문자열 전수 툴 카탈로그(분석 §3)의 P0/P1 툴을 배치. impl=false 는 In Viewer 미구현(개발 대상). */
export const IN_TOOLBAR: {
  workspace: string; items: { id: string; label: string; desc: string; impl: boolean }[];
}[] = [
  { workspace: "Default", items: [
    { id: "zoom", label: "Zoom", desc: "확대 1%~3000% · 100%/Fit", impl: true },
    { id: "pan", label: "Pan", desc: "이동", impl: true },
    { id: "magnifier", label: "Mag", desc: "돋보기 (Ctrl+M)", impl: false },
    { id: "wl", label: "W/L", desc: "드래그 Window/Level + 모달리티별 프리셋", impl: true },
    { id: "wl_all", label: "W/L All", desc: "Apply Window level — 전체 이미지 적용", impl: false },
    { id: "inv", label: "Inv", desc: "Invert 반전", impl: true },
    { id: "rot", label: "⟳", desc: "Rotate CW/CCW/180 · Flip", impl: true },
    { id: "reset", label: "Reset", desc: "원본 픽셀값 초기화 (Ctrl+Z)", impl: true },
  ]},
  { workspace: "Display", items: [
    { id: "layout", label: "Layout", desc: "이미지 격자 1x1~4x4", impl: true },
    { id: "series_sort", label: "Sort", desc: "시리즈 정렬(번호/시간/위치/TE)", impl: false },
    { id: "crosslink", label: "XLink", desc: "CrossLink — 시리즈 동기 스크롤", impl: true },
    { id: "scout", label: "Scout", desc: "참조선(Scout line) 표시", impl: false },
    { id: "overlay", label: "Ovl", desc: "DICOM 오버레이 4코너 (Ctrl+T)", impl: true },
    { id: "cine", label: "Cine", desc: "Auto Play/Loop/FPS (Space)", impl: true },
    { id: "filter", label: "Filter", desc: "Sharpen/Smooth/Edge/Gamma", impl: false },
    { id: "lut", label: "LUT", desc: "Presentation LUT(linear/lighten/darken/midtone)", impl: false },
  ]},
  { workspace: "Annotation", items: [
    { id: "caliper", label: "Len", desc: "Caliper 거리 (Ctrl+L)", impl: true },
    { id: "angle", label: "Ang", desc: "각도 · Double Angle", impl: true },
    { id: "cobb", label: "Cobb", desc: "Cobb's Angle(척추측만)", impl: false },
    { id: "ctr", label: "CTR", desc: "CT Ratio 심흉비", impl: true },
    { id: "roi", label: "ROI", desc: "Rect/Oval/Free + 면적·픽셀통계", impl: true },
    { id: "text", label: "Text", desc: "텍스트/펜/화살표/Post-it (Alt+A)", impl: true },
    { id: "scalebar", label: "Scale", desc: "Scale Bar (Alt+S)", impl: false },
    { id: "shutter", label: "Shut", desc: "Rect/Oval/Free 셔터", impl: false },
  ]},
  { workspace: "Etc", items: [
    { id: "keyimage", label: "Key", desc: "Key Image Note(DICOM KO) 저장", impl: true },
    { id: "gsps", label: "GSPS", desc: "Presentation State 저장/로드", impl: false },
    { id: "capture", label: "Cap", desc: "PNG 내보내기/클립보드", impl: true },
    { id: "print", label: "Print", desc: "인쇄 레이아웃/실물크기 (Ctrl+P)", impl: false },
    { id: "header", label: "Hdr", desc: "DICOM 헤더 뷰어(Text/Tree)", impl: false },
    { id: "mpr", label: "3D", desc: "MPR/MIP 3D 뷰어 호출", impl: true },
  ]},
  { workspace: "Diagnose", items: [
    { id: "report", label: "Rpt", desc: "판독창 열기 (Ctrl+R)", impl: true },
    { id: "prior", label: "Prior", desc: "Related Exam — 과거검사 비교", impl: true },
    { id: "dictate", label: "Dict", desc: "음성 딕테이션 (Ctrl+D)", impl: false },
    { id: "sr", label: "SR", desc: "판독→DICOM SR 변환·서버 전송", impl: true },
  ]},
  { workspace: "Verify", items: [
    { id: "approve", label: "Appr", desc: "승인(Approved 1·2차)", impl: true },
    { id: "save_verified", label: "SaveV", desc: "검증 완료 저장", impl: false },
  ]},
];

/** 판독 상태 전이 — "Set Dictated/Transcribed/Verified/Approved/Approved2" → 워크리스트 상태색 */
export const IN_READING_STATES = [
  { key: "dictated", label: "Dictated", color: "#eab308" },
  { key: "transcribed", label: "Transcribed", color: "#38bdf8" },
  { key: "verified", label: "Verified", color: "#a78bfa" },
  { key: "approved", label: "Approved", color: "#4ade80" },
  { key: "approved2", label: "Approved2", color: "#22c55e" },
];

/** 오버레이 4코너 — DemographicManager 모델: DICOM 필드 토큰 + prefix/suffix, 표시/인쇄 분리 */
export const IN_OVERLAY_CORNERS: Record<string, string[]> = {
  TOPLEFT: ["%pn", "%pid", "%age %sex"],
  TOPRIGHT: ["%inst", "%mo %bp", "%sd %st"],
  BOTTOMLEFT: ["%sn/%in", "W:%ww L:%wl"],
  BOTTOMRIGHT: ["%zoom%", "%desc"],
};

/** 단축키 — exe 문자열 확인분(웹 예약키 Ctrl+W/C/P 등은 대체 바인딩) */
export const IN_SHORTCUTS: { key: string; action: string }[] = [
  { key: "Ctrl+←/→", action: "이전/다음 검사" },
  { key: "Ctrl+M", action: "돋보기" },
  { key: "Ctrl+L", action: "Caliper 거리" },
  { key: "Ctrl+R", action: "판독창" },
  { key: "Ctrl+T", action: "오버레이 토글" },
  { key: "Ctrl+Z", action: "Reset(원본)" },
  { key: "Alt+A", action: "주석" },
  { key: "Alt+I", action: "정보" },
  { key: "Alt+S", action: "Scale Bar" },
  { key: "Space", action: "Cine 재생" },
];

/** 검사 상태 12단계 — User Guide p.5 "Exam Status of INFINITT Pacs server" */
export const IN_EXAM_STATUSES: { key: string; label: string; desc: string; color: string }[] = [
  { key: "examined", label: "Examined", desc: "Unread exam (미판독)", color: "#94a3b8" },
  { key: "verified", label: "Verified", desc: "After changes saved", color: "#a78bfa" },
  { key: "dictating", label: "Dictating", desc: "After voice recording (녹음 중)", color: "#f472b6" },
  { key: "dictated", label: "Dictated", desc: "After voice recorded", color: "#fb923c" },
  { key: "transcribing", label: "Transcribing", desc: "After reporting (작성 중)", color: "#38bdf8" },
  { key: "transcribed", label: "Transcribed", desc: "After reported", color: "#eab308" },
  { key: "approved", label: "Approved", desc: "Confirmed report by Approver", color: "#4ade80" },
  { key: "add_dictating", label: "Addendum Dictating", desc: "추가판독 녹음 중", color: "#f472b6" },
  { key: "add_dictated", label: "Addendum Dictated", desc: "추가판독 녹음 완료", color: "#fb923c" },
  { key: "add_transcribing", label: "Addendum Transcribing", desc: "추가판독 작성 중", color: "#38bdf8" },
  { key: "add_transcribed", label: "Addendum Transcribed", desc: "추가판독 작성 완료", color: "#eab308" },
  { key: "add_approved", label: "Addendum Approved", desc: "추가판독 승인", color: "#22c55e" },
];

/** Saintview 상태 → INFINITT 상태 매핑 (워크리스트 상태 배지 색·툴팁) */
export const IN_STATUS_MAP: Record<string, string> = {
  received: "examined",
  draft_ready: "transcribed",
  reading: "transcribing",
  draft: "dictated",
  in_review: "verified",
  finalized: "approved",
};

/** Crosslink 5모드 — User Guide §3.3 */
export const IN_CROSSLINK_MODES = [
  { key: "crosslink", label: "Crosslink", desc: "다중 이미지 동기" },
  { key: "auto_sync", label: "Auto Sync", desc: "같은 검사 시리즈 동기" },
  { key: "sync_other", label: "Sync With Other Exams", desc: "같은 환자 과거검사와 동기" },
  { key: "scout", label: "Scout Line", desc: "참조선 표시" },
  { key: "all_lines", label: "All Lines", desc: "활성 시리즈의 모든 참조선" },
];

/** 마우스 조작 — User Guide §3.5 (우드래그=기본 도구(W/L), 더블클릭=최대화) */
export const IN_MOUSE_OPS = [
  { key: "lclick", action: "이미지/객체 선택" },
  { key: "ctrl_lclick", action: "다중 선택" },
  { key: "shift_lclick", action: "연속 다중 선택 · MPR Zoom In" },
  { key: "ldrag", action: "툴바 지정 도구 실행" },
  { key: "dblclick", action: "이미지 최대화/해제" },
  { key: "rclick", action: "컨텍스트 메뉴" },
  { key: "rdrag", action: "기본 지정 도구(W/L)" },
  { key: "ctrl_wheel", action: "Zoom in/out" },
];

/** INFINITT 라이트 테마 토큰 — piviewskin.ini 실측(보조 테마, 기본은 다크) */
export const IN_LIGHT_THEME = {
  dialogBk: "rgb(114,130,139)",
  dialogBk2: "rgb(142,155,161)",
  hilight: "rgb(201,211,215)",
  shadow: "rgb(55,59,62)",
  listStripe1: "rgb(238,246,249)",
  listStripe2: "rgb(230,239,245)",
  editBk: "rgb(238,246,249)",
  listBk: "rgb(255,255,255)",
  text: "rgb(0,0,0)",
};

// ── User Guide p.11~14 툴 카탈로그 (표 순서 유지) — impl=false 는 반투명(개발 대상) ──
export const IN_PALETTE: { id: string; icon: string; label: string; impl: boolean; mode?: boolean; group: string }[] = [
  // p.11 §3.4 기본 6종
  { id: "select", icon: "⬆", label: "Select — 이미지 선택/해제(초기 상태)", impl: true, mode: true, group: "영상 조정" },
  { id: "pan", icon: "✥", label: "Pan — 이미지 이동(창보다 클 때 유용)", impl: true, mode: true, group: "영상 조정" },
  { id: "zoom", icon: "🔍", label: "Zoom — 드래그로 확대/축소 (Ctrl+휠)", impl: true, mode: true, group: "영상 조정" },
  { id: "wl", icon: "◐", label: "Windowing — W/L 적용(우드래그 기본)", impl: true, mode: true, group: "영상 조정" },
  { id: "magnify", icon: "⌕", label: "Magnification — 마우스를 올리면 부분 확대경", impl: true, mode: true, group: "영상 조정" },
  { id: "fit", icon: "▣", label: "Fit — 창 크기에 맞춤", impl: true, group: "영상 조정" },
  // p.12 상단
  { id: "capture", icon: "📷", label: "Capture All — 현재 이미지 저장", impl: true, group: "기타" },
  { id: "reset", icon: "↺", label: "Reset — 초기값 복원", impl: true, group: "영상 조정" },
  { id: "print", icon: "🖨", label: "Print — 리포트/이미지 인쇄", impl: true, group: "기타" },
  { id: "cursor3d", icon: "✛", label: "3D Cursor — 클릭 지점을 모든 페인에서 동일 위치로 표시·이동", impl: true, mode: true, group: "선택·연동" },
  { id: "dictation", icon: "🎙", label: "Dictation — 음성 녹음 시작/정지 (세션 보관)", impl: true, group: "기타" },
  { id: "playdict", icon: "🔊", label: "Play Dictation — 녹음 재생", impl: true, group: "기타" },
  { id: "refreshExam", icon: "🔄", label: "Refresh Exam — 검사 정보 갱신", impl: true, group: "선택·연동" },
  // p.12 중단 — 선택/방향
  { id: "selAll", icon: "⊞", label: "Select All — 모든 페인 선택 (A)", impl: true, group: "선택·연동" },
  { id: "selInv", icon: "⊟", label: "Select All Inverse — 선택 반전", impl: true, group: "선택·연동" },
  { id: "flipV", icon: "⇵", label: "Flip Vertical — 상하 반전", impl: true, group: "영상 조정" },
  { id: "flipH", icon: "⇋", label: "Flip Horizontal — 좌우 반전", impl: true, group: "영상 조정" },
  { id: "rotL", icon: "⟲", label: "Rotate Left 90 — 반시계 90도", impl: true, group: "영상 조정" },
  { id: "rotR", icon: "⟳", label: "Rotate Right 90 — 시계 90도", impl: true, group: "영상 조정" },
  { id: "rot180", icon: "◒", label: "Rotate 180", impl: true, group: "영상 조정" },
  { id: "invert", icon: "◑", label: "B/W Inverse — 흑백 반전", impl: true, group: "영상 조정" },
  { id: "shutEl", icon: "◙", label: "Ellipse Shutter — 두 점(박스)으로 타원 밖 가림", impl: true, mode: true, group: "셔터" },
  { id: "shutRect", icon: "▣", label: "Rectangle Shutter — 두 점으로 사각 밖 가림", impl: true, mode: true, group: "셔터" },
  { id: "shutPoly", icon: "⬠", label: "Polyline Shutter — 점 클릭, 더블클릭 완료", impl: true, mode: true, group: "셔터" },
  // p.13 상단 — 필터/스크롤
  { id: "sharpen", icon: "◮", label: "Sharpens Filter — 선예화", impl: true, group: "영상 조정" },
  { id: "smooth", icon: "◍", label: "Average Filter — 평활화", impl: true, group: "영상 조정" },
  { id: "pseudo", icon: "🎨", label: "Pseudo — 의사 컬러(핵의학)", impl: true, group: "영상 조정" },
  { id: "cine", icon: "▶", label: "Auto Scroll — 이미지 자동 스크롤", impl: true, group: "영상 조정" },
  // p.13 측정/분석
  { id: "ctr", icon: "♥", label: "CT Ratio 심흉비 — 심장 2점 + 흉곽 2점", impl: true, mode: true, group: "측정" },
  { id: "ctrAi", icon: "🤖", label: "AI CTR — 심흉비 자동계측 초안 (CR/DX 전용, AI 초안·확정 아님)", impl: true, group: "측정" },
  { id: "limb", icon: "🦵", label: "Leg Length — 다리 길이: 좌 라인(2점)+우 라인(2점) 각 길이·Δ차이(mm)", impl: true, mode: true, group: "측정" },
  { id: "centerline", icon: "╂", label: "Center Line — 두 선(4점)의 중앙선 표시", impl: true, mode: true, group: "측정" },
  { id: "profile", icon: "📈", label: "Profile — 두 점 선의 픽셀값 그래프", impl: true, mode: true, group: "측정" },
  { id: "table2d", icon: "▤", label: "2D Table — 두 점 영역의 픽셀값 표", impl: true, mode: true, group: "측정" },
  { id: "calibrate", icon: "📐", label: "Calibrate — Pixel Spacing 정보", impl: true, group: "측정" },
  { id: "spine", icon: "🦴", label: "Spine Label — 클릭마다 라벨(첫 클릭에 시작 라벨 입력)", impl: true, mode: true, group: "주석" },
  { id: "anno3d", icon: "🧊", label: "3D 뷰어 열기 — Crosshair 로 3D 위치 표시", impl: true, group: "기타" },
  // p.13~14 — 2D 주석/측정
  { id: "arrow2d", icon: "↗", label: "2D Arrow — 꼬리→머리 두 점", impl: true, mode: true, group: "주석" },
  { id: "text2d", icon: "T", label: "2D Text — 클릭 후 문구 입력", impl: true, mode: true, group: "주석" },
  { id: "box2d", icon: "▭", label: "2D Box 메모 — 두 점 + 제목 입력", impl: true, mode: true, group: "주석" },
  { id: "key2d", icon: "🔑", label: "Key — 현재 이미지를 키이미지로 등록/해제 (워크리스트 🔑·Key 필터 조회)", impl: true, group: "주석" },
  { id: "circle", icon: "◯", label: "Circle — 중심→가장자리 두 점", impl: true, mode: true, group: "주석" },
  { id: "polyline", icon: "〰", label: "Polyline — 점 클릭, 더블클릭 완료", impl: true, mode: true, group: "측정" },
  { id: "mline", icon: "📏", label: "Measure 2D Line — 두 점 클릭 = 거리(mm)", impl: true, mode: true, group: "측정" },
  { id: "mangle", icon: "∠", label: "Measure 2D Angle — 세 점 클릭 = 각도", impl: true, mode: true, group: "측정" },
  { id: "mellipse", icon: "⬭", label: "Measure Ellipse ROI — 두 점(박스), 평균/편차/면적", impl: true, mode: true, group: "측정" },
  { id: "mrect", icon: "⬜", label: "Measure Rect ROI — 두 점, 평균/편차/면적", impl: true, mode: true, group: "측정" },
  { id: "cobb", icon: "⟁", label: "Cobb Angle — 척추측만각: 선1(2점)+선2(2점) 사이 예각(0~90°)", impl: true, mode: true, group: "측정" },
  { id: "spineCurve", icon: "⌇", label: "Spine Curve — 척추 외곡: 3점 이상 클릭 후 더블클릭 종료, 기준선 대비 최대 편위(mm)", impl: true, mode: true, group: "측정" },
  { id: "pelvis", icon: "⏛", label: "Pelvic Tilt — 골반 틀어짐: 좌우 장골능 2점, 수평 대비 각도(°)·Δ높이차(mm)", impl: true, mode: true, group: "측정" },
  { id: "marking", icon: "M", label: "Marking — 클릭 후 짧은 표기 입력", impl: true, mode: true, group: "주석" },
  { id: "lens", icon: "🎯", label: "Lens — 클릭 지점 픽셀값(서버 HU, 실패 시 근사)", impl: true, mode: true, group: "측정" },
  // IN-1 서버 연동 — 주석 영속화(Save) + GSPS 저장/불러오기
  { id: "saveAnno", icon: "💾", label: "Save — 주석·계측을 서버에 저장(계정 로밍)", impl: true, group: "기타" },
  { id: "gsps", icon: "🗂", label: "GSPS 저장 — 현재 주석+활성 페인 W/L 을 DICOM Presentation State 로 서버 저장", impl: true, group: "기타" },
  { id: "gspsLoad", icon: "📥", label: "PR↓ — 검사에 귀속된 GSPS(타사 PR 포함) 불러오기, 외부 주석은 녹색 표시", impl: true, group: "기타" },
  // IN-2 ⑦: OHIF 연동 — 설정>뷰어>OHIF(ohif_enabled) 켠 계정만 노출 (TY ETC 게이트 패턴)
  { id: "ohif", icon: "🌐", label: "OHIF — 고급 웹뷰어(OHIF)로 활성 검사 열기 (설정>뷰어>OHIF 허용 시)", impl: true, group: "기타" },
  { id: "clrAnno", icon: "🧹", label: "측정 전체 지우기", impl: true, group: "기타" },
];

/** 툴 팔레트 구획 순서 — 기능별 섹션 구분 */
export const IN_PALETTE_GROUPS = ["영상 조정", "측정", "주석", "셔터", "선택·연동", "기타"];
