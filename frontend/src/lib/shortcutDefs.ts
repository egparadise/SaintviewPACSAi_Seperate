// 뷰어 단축키 레지스트리 — 설정>단축키(재바인딩 UI)와 Viewer2D(디스패치)가 공유.
// 저장: viewer.prefs.shortcuts.keys = { [actionId]: key } (계정별 scope=user, 기본값과 다른 것만)
export type ScDef = { id: string; label: string; group: string; def: string };

export const SC_ACTIONS: ScDef[] = [
  // 탐색
  { id: "img_next", label: "다음 이미지", group: "탐색", def: "ArrowRight" },
  { id: "img_prev", label: "이전 이미지", group: "탐색", def: "ArrowLeft" },
  { id: "series_next", label: "다음 시리즈", group: "탐색", def: "ArrowDown" },
  { id: "series_prev", label: "이전 시리즈", group: "탐색", def: "ArrowUp" },
  { id: "cine", label: "Cine 재생/정지", group: "탐색", def: " " },
  { id: "img_first", label: "첫 이미지로", group: "탐색", def: "Home" },
  { id: "img_last", label: "마지막 이미지로", group: "탐색", def: "End" },
  // 조작
  { id: "invert", label: "반전 (Invert)", group: "조작", def: "i" },
  { id: "rotate_r", label: "90° 회전", group: "조작", def: "r" },
  { id: "rotate_l", label: "⟲90° 회전(반대)", group: "조작", def: "" },
  { id: "flip_h", label: "좌우 반전 (Flip H)", group: "조작", def: "" },
  { id: "flip_v", label: "상하 반전 (Flip V)", group: "조작", def: "" },
  { id: "reset", label: "Reset (초기화)", group: "조작", def: "" },
  { id: "zoom_in", label: "확대 (+)", group: "조작", def: "" },
  { id: "zoom_out", label: "축소 (−)", group: "조작", def: "" },
  { id: "maximize", label: "페인 최대화/복원", group: "조작", def: "" },
  { id: "overlay", label: "오버레이 표시 토글", group: "조작", def: "" },
  { id: "combine", label: "Combine all 토글", group: "조작", def: "" },
  { id: "key_image", label: "키 이미지 등록/해제", group: "조작", def: "" },
  { id: "capture", label: "캡처 (Capture)", group: "조작", def: "" },
  { id: "print", label: "Print", group: "조작", def: "" },
  { id: "report_open", label: "판독창 열기", group: "조작", def: "" },
  { id: "fit", label: "Fit (화면맞춤)", group: "조작", def: "f" },
  { id: "crosslink", label: "Crosslink 토글", group: "조작", def: "l" },
  { id: "spatial", label: "Stack 동기 (Spatial↔Index)", group: "조작", def: "g" },
  { id: "all_panes", label: "전체 페인 선택", group: "조작", def: "a" },
  { id: "del_anno", label: "주석 삭제", group: "조작", def: "Delete" },
  { id: "save", label: "주석 서버 저장 (Save)", group: "조작", def: "" },
  { id: "refresh", label: "Refresh Exam", group: "조작", def: "" },
  // 마우스 모드
  { id: "m_select", label: "Select 모드", group: "마우스 모드", def: "" },
  { id: "m_zoom", label: "Zoom 모드", group: "마우스 모드", def: "" },
  { id: "m_pan", label: "Pan 모드", group: "마우스 모드", def: "" },
  { id: "m_wl", label: "W/L 모드", group: "마우스 모드", def: "" },
  { id: "m_scroll", label: "Scroll 모드", group: "마우스 모드", def: "" },
  // 측정·주석 툴
  { id: "t_length", label: "길이 측정 (Len)", group: "툴", def: "" },
  { id: "t_angle", label: "각도 (Ang)", group: "툴", def: "" },
  { id: "t_rect", label: "사각 ROI (Rect)", group: "툴", def: "" },
  { id: "t_ellipse", label: "타원 ROI (Elps)", group: "툴", def: "" },
  { id: "t_arrow", label: "화살표 (Arrw)", group: "툴", def: "" },
  { id: "t_text", label: "텍스트 (Text)", group: "툴", def: "" },
  { id: "t_poly", label: "폴리라인 (Poly)", group: "툴", def: "" },
  { id: "t_circle", label: "원 계측 (Circ)", group: "툴", def: "" },
  { id: "t_cursor3d", label: "3D Cursor (3DC)", group: "툴", def: "" },
  { id: "t_mag", label: "확대경 (Mag)", group: "툴", def: "" },
];

export const SC_DEFAULTS: Record<string, string> =
  Object.fromEntries(SC_ACTIONS.map((a) => [a.id, a.def]));

export const displayKey = (k: string) =>
  k === " " ? "Space" : k === "" ? "—" : k.length === 1 ? k.toUpperCase() : k;
