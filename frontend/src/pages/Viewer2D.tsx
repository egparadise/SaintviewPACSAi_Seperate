// Saintview 2D 뷰어 — WADO-RS /rendered 기반(픽셀 보장) + Zetta/INFINITT 레이아웃
// 설정 연동: 팔레트/썸네일 방향·크기, 썸네일 모드(시리즈/전체), 행잉(모달리티→분할), 판독 도크
import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, openViewer, type Anno, type InstanceNode, type SeriesNode, type StudyDetail } from "../api";
import { annoLabel, contentRect, measureAnno, refLineOn, screenToImage } from "../lib/annotations";
import { SC_DEFAULTS } from "../lib/shortcutDefs";
import { GridPicker } from "../lib/GridPicker";
import { screenFeatures } from "../lib/screens";
import { onStudySync, onViewerAddTab, onViewerCloseAll, postStudySync, postViewerCloseAll } from "../lib/sync";
import { Splitter, clampSz } from "../lib/Splitter";
import { DEFAULT_WL_PRESETS, mammoAssign, type HpRule } from "../lib/viewerConfig";
import { ToolIconTy } from "../components/ToolIconTy";
import { AnatomyIcon } from "../lib/anatomyIcons";
import { ReportDock } from "../components/ReportDock";
import { useDictation } from "../lib/useDictation";
import { ViewerContextMenu, type CtxItem } from "../components/ViewerContextMenu";
import { IN_MOUSE_OPS } from "../lib/infiConfig";
import { DICOMWEB_ROOT, renderedParams, setImageFormat } from "../lib/cornerstone";
import { isWasmPipeline, onWasmFrame, setWasmPipeline, wasmFrameUrl } from "../lib/wasmPixels";
import { cancelWarm, prefetchAround, warmSeries } from "../lib/framePrefetch";
import { rawAt, samplePixels } from "../lib/pixelTools";

// 내장 MPR/MIP — 새 창 없이 현재 뷰포트 영역에 Axial/Sagittal/Coronal+MIP 표시
const Viewer3DEmbed = lazy(() => import("./Viewer3D").then((m) => ({ default: m.Viewer3D })));
// 뷰어 내 설정 — 워크리스트로 돌아가지 않고 Setting 진입
const SettingsModalLazy = lazy(() => import("./SettingsModal").then((m) => ({ default: m.SettingsModal })));

type ToolKind = "length" | "angle" | "rect" | "ellipse" | "arrow" | "text"
  | "cobb" | "leg" | "pelvis" | "spineCurve"
  // TY-2 이식(In Viewer): 측정·주석·픽셀·셔터 계열
  | "poly" | "circle" | "centerline" | "mctr" | "box" | "spine" | "marking"
  | "lens" | "profile" | "table2d" | "shutRect" | "shutEl" | "shutPoly"
  // TY-3 이식: 3D Cursor — 클릭점을 다른 페인 동일 3D 위치로 (In cursor3d)
  | "cursor3d";
const TOOL_DEFS: [ToolKind, string, string][] = [
  ["length", "Len", "길이 계측 (2점, mm)"],
  ["angle", "Ang", "각도 계측 (3점)"],
  ["rect", "Rect", "사각 ROI (면적)"],
  ["ellipse", "Elps", "타원 ROI (면적)"],
  ["arrow", "Arrw", "화살표"],
  ["text", "Text", "텍스트 주석"],
  ["poly", "Poly", "폴리라인 — 경로 길이(여러 점 클릭, 더블클릭 종료)"],
  ["circle", "Circ", "원 계측 — 중심→가장자리 2점, 반지름"],
  ["centerline", "CLine", "중앙선 — 두 선(4점: 선1 2점 → 선2 2점)의 중앙선 표시"],
  ["mctr", "CTR4", "수동 심흉비 — 4점: 심장 폭 2점 → 흉곽 폭 2점, CTR % (AI CTR 과 별개)"],
  ["box", "Box", "박스 메모 — 두 점 + 제목 입력"],
  ["spine", "SpLbl", "Spine Label — 클릭 연번 라벨(첫 클릭에 시작 라벨 입력, 예: L1)"],
  ["marking", "Mark", "Marking — 클릭 + 짧은 표기 입력(①, R, ✓ 등)"],
];
// 해부학 측정 툴 4종 (Anatomy) — 콥각/다리길이/골반/척추외곡
const ANATOMY_TOOL_DEFS: [ToolKind, string, string][] = [
  ["cobb", "Cobb", "콥 각(척추측만) — 4점: 첫 선 2점 → 둘째 선 2점, 두 직선 사이 예각(°)"],
  ["leg", "Leg", "다리 길이 — 4점: 좌측 라인 2점 → 우측 라인 2점, 각 길이(mm)와 좌우 차이"],
  ["pelvis", "Pelvis", "골반 틀어짐 — 2점: 좌·우 장골능, 수평 대비 각도(°)와 높이차(mm)"],
  ["spineCurve", "Spine", "척추 외곡 — 3점 이상 클릭 후 더블클릭으로 종료, 기준선 대비 최대 편위(mm)"],
];
// 픽셀 도구 3종 (In Viewer 이식) — 렌더 8bit + W/L 역변환 근사('≈' 표기)
const PIXEL_TOOL_DEFS: [ToolKind, string, string][] = [
  ["lens", "Lens", "Lens — 클릭 지점 픽셀값 근사 HU('≈' 표기)"],
  ["profile", "Prof", "Profile — 두 점 선의 픽셀값 그래프"],
  ["table2d", "Tbl", "2D Table — 두 점 영역 픽셀값 표"],
];
// 셔터 3종 (In Viewer 이식) — 페인 표시 가림(evenodd), 주석 저장 대상 아님. Clr/Reset 으로 해제
const SHUTTER_TOOL_DEFS: [ToolKind, string, string][] = [
  ["shutRect", "ShR", "사각 셔터 — 두 점 영역 밖 가림(활성 페인, Clr/Reset 해제)"],
  ["shutEl", "ShE", "타원 셔터 — 두 점 영역 밖 가림(활성 페인, Clr/Reset 해제)"],
  ["shutPoly", "ShP", "다각 셔터 — 여러 점 클릭 후 더블클릭 종료(활성 페인, Clr/Reset 해제)"],
];
// 툴별 필요 점 수 — Infinity=open-ended(더블클릭 종료, In Viewer OPEN_ENDED 동치)
const TOOL_PTS: Record<ToolKind, number> = {
  length: 2, angle: 3, rect: 2, ellipse: 2, arrow: 2, text: 1,
  cobb: 4, leg: 4, pelvis: 2, spineCurve: Infinity,
  poly: Infinity, circle: 2, centerline: 4, mctr: 4, box: 2, spine: 1, marking: 1,
  lens: 1, profile: 2, table2d: 2, shutRect: 2, shutEl: 2, shutPoly: Infinity,
  cursor3d: 1,
};
const OPEN_ENDED = new Set<ToolKind>(["spineCurve", "poly", "shutPoly"]);
// 4점(선 2개) 도구 — 초안에서 선1(p0,p1)만 잇는다(p1→p2 연결선은 오해 소지)
const FOUR_PT_TOOLS = new Set<ToolKind>(["cobb", "leg", "centerline", "mctr"]);
// 드래그로 그리는 2점 도구 — 좌클릭 down=시작점, up=끝점(그 사이 러버밴드 미리보기).
// 나머지(각도 3점·4점선·open-ended·1점 프롬프트)는 기존 클릭 방식 유지
const DRAG_TOOLS = new Set<ToolKind>([
  "length", "rect", "ellipse", "arrow", "circle", "pelvis",
  "profile", "table2d", "shutRect", "shutEl", "box",
]);
// 편집 히트테스트 — 면적형(bbox 내부/경계로 잡기) vs 선형(세그먼트로 잡기) 구분
const AREA_KINDS = new Set(["rect", "ellipse", "box"]);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** 점(px,py)→선분(a→b) 최단거리 (이미지 px 좌표) — 본체(선형) 히트테스트용 */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay;
  const l2 = vx * vx + vy * vy;
  let t = l2 ? ((px - ax) * vx + (py - ay) * vy) / l2 : 0;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

const PANE_IDS = Array.from({ length: 100 }, (_, i) => `p${i}`);  // 최대 10×10 임의 레이아웃
// Related Study 상태 → 색 칩 (theme.css --stat-* 의미 체계와 동일)
const STAT_COLOR: Record<string, string> = {
  received: "var(--stat-received)", draft_ready: "var(--stat-draft)",
  reading: "var(--stat-reading)", finalized: "var(--stat-final)",
  critical: "var(--stat-emergency)", emergency: "var(--stat-emergency)",
};
// Series Layout — 뷰포트 분할(최대 10×10 — GridPicker 직접 지정, UBPACS View Screen Composition)
const LAYOUTS: Record<string, { cols: number; rows: number; count: number }> = {};
for (let r = 1; r <= 10; r++) {
  for (let c = 1; c <= 10; c++) {
    LAYOUTS[`${r}x${c}`] = { rows: r, cols: c, count: r * c };
  }
}
/** ② 자동 최적 W/L (03c Image-Manipulation 의도, v1=결정적 규칙. 추후 AI 추론 교체 지점) */
function autoWL(modality: string, bodyPart: string): { q: string; label: string } | null {
  const bp = (bodyPart || "").toUpperCase();
  if (modality === "CT") {
    if (bp.includes("CHEST") || bp.includes("LUNG")) return { q: "-600,1500", label: "폐" };
    if (bp.includes("BRAIN") || bp.includes("HEAD")) return { q: "40,80", label: "뇌" };
    if (bp.includes("ABD") || bp.includes("PEL")) return { q: "60,400", label: "복부" };
    return { q: "40,400", label: "종격동" };
  }
  return null; // MR/CR 등은 서버 VOI 기본
}

const WL_PRESETS = DEFAULT_WL_PRESETS;  // 기본값 — 실제 목록은 viewer.prefs.wl_presets(설정 편집)

interface PaneState {
  studyUid: string;       // 비교 검사 지원(F-14): 페인마다 다른 검사 가능
  series: SeriesNode | null;
  index: number;
  zoom: number; tx: number; ty: number; rot: number;
  flipH: boolean; flipV: boolean; invert: boolean;
  wl: string;             // window=c,w 쿼리 ("" = 서버 기본)
  fx: "" | "sharpen" | "smooth" | "pseudo";  // 필터 3종(Sharpen/Average/Pseudo — In Viewer 이식)
  // 셔터 — 페인 시각 상태(주석 저장 대상 아님, In Viewer shutter 이식). 좌표는 정규화(0~1)
  shutter: { kind: "rect" | "ellipse" | "poly"; pts: number[][] } | null;
  // TY-3: 페인별 독립 시네(재생 여부·간격 초 — 없으면 ty_cine_sec) + 로컬 미디어(jpg/png/avi/mp4)
  playing?: boolean;
  cineSec?: number;
  media?: { url: string; kind: "image" | "video"; name: string } | null;  /** 페인별 Image Layout(N×M 타일) — 활성 페인에만 적용, 기본 1×1 */
  il?: { r: number; c: number };
}
const initPane = (studyUid: string): PaneState => ({
  studyUid, series: null, index: 0, zoom: 1, tx: 0, ty: 0, rot: 0,
  flipH: false, flipV: false, invert: false, wl: "", fx: "", shutter: null,
  playing: false, media: null,
});

/* ── TY-3: Crosslink 5모드 — 기존 Link 단일 토글을 확장 (In IN_CROSSLINK_MODES 이식, 단일 선택형) ── */
type XlinkMode = "off" | "auto_sync" | "sync_other" | "scout" | "all_lines";
const XLINK_MODES: { key: XlinkMode; label: string; desc: string }[] = [
  { key: "off", label: "Link:Off", desc: "연동 없음" },
  { key: "auto_sync", label: "AutoSync", desc: "같은 검사 페인 동기 스크롤" },
  { key: "sync_other", label: "SyncOther", desc: "다른 검사(과거) 포함 전체 페인 동기 스크롤" },
  { key: "scout", label: "Scout", desc: "활성 페인 현재 이미지의 교차선 표시 (기존 Ref 통합)" },
  { key: "all_lines", label: "AllLines", desc: "활성 시리즈 전체 이미지의 교차선 표시" },
];

/* ── TY-3: 3D Cursor 기하 — DICOM Position/Orientation 평면 계산 (In geomOf 이식, 최소 부분) ── */
type V3 = number[];
const vsub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vdot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vcross = (a: V3, b: V3): V3 =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
interface Geom3 { pos: V3; row: V3; col: V3; rs: number; cs: number; n: V3 }
function geomOf(inst: InstanceNode): Geom3 | null {
  if (inst.position?.length !== 3 || inst.orientation?.length !== 6 || inst.pixel_spacing?.length !== 2) return null;
  const row = inst.orientation.slice(0, 3), col = inst.orientation.slice(3, 6);
  return { pos: inst.position, row, col, rs: inst.pixel_spacing[0], cs: inst.pixel_spacing[1], n: vcross(row, col) };
}
/* YYYYMMDD → Date, 두 검사일 간 기간 문자열 "- 1 Year, 3month, 5day" (Compare 과거영상 얼마전 표시) */
function ymdToDate(s: string): Date | null {
  return /^\d{8}$/.test(s) ? new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) : null;
}
function durText(olderYmd: string, newerYmd: string): string | null {
  const a = ymdToDate(olderYmd), b = ymdToDate(newerYmd);
  if (!a || !b || b < a) return null;
  // a 를 mm 개월 전진(일자는 해당 월 말일로 클램프) → b 까지 남은 일수. 항상 d>=0(음수일 버그 방지)
  const anchorOf = (mm: number) => {
    const dt = new Date(a.getFullYear(), a.getMonth() + mm, 1);
    const dim = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
    dt.setDate(Math.min(a.getDate(), dim));
    return dt;
  };
  let months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (anchorOf(months) > b) months -= 1;
  const d = Math.round((b.getTime() - anchorOf(months).getTime()) / 86400000);
  const y = Math.floor(months / 12), m = months % 12;
  const parts: string[] = [];
  if (y) parts.push(`${y} Year`);
  if (m) parts.push(`${m}month`);
  if (d || (!y && !m)) parts.push(`${d}day`);
  return `- ${parts.join(", ")}`;
}
/* 썸네일 DICOM 태그 — 시퀀스(T1/T2/FLAIR…, series_desc 파싱) + 단면(AX/SAG/COR, ImageOrientation 법선). 초록 표시 */
function seriesTag(s: SeriesNode): string {
  const d = (s.series_desc || "").toUpperCase();
  let seq = "";
  for (const t of ["FLAIR", "T2", "T1", "DWI", "ADC", "STIR", "PD", "SWI", "TOF", "MRA", "TOPO", "SCOUT"]) {
    if (d.includes(t)) { seq = t; break; }
  }
  const inst0 = s.instances[0];
  const g = inst0 ? geomOf(inst0) : null;
  let plane = "";
  if (g) { const x = Math.abs(g.n[0]), y = Math.abs(g.n[1]), z = Math.abs(g.n[2]); plane = z >= x && z >= y ? "AX" : x >= y ? "SAG" : "COR"; }
  return [seq, plane].filter(Boolean).join(" ");
}
/* Spatial cross-reference (Infinitt식) — 마스터 슬라이스의 DICOM 위치를 타깃 시리즈 슬라이스 법선에 투영,
   해부학적으로 가장 가까운 슬라이스 index 반환. 두께·장수·각도가 달라도 정합. 좌표 없으면 null(→ 인덱스 폴백). */
function nearestSliceIndex(masterInst: InstanceNode, target: SeriesNode): number | null {
  const gm = geomOf(masterInst);
  if (!gm) return null;
  let best = -1, bestD = Infinity;
  for (let i = 0; i < target.instances.length; i++) {
    const gt = geomOf(target.instances[i]);
    if (!gt) continue;
    const nn = Math.hypot(gt.n[0], gt.n[1], gt.n[2]) || 1;
    const loc = (p: V3) => (p[0] * gt.n[0] + p[1] * gt.n[1] + p[2] * gt.n[2]) / nn;   // 슬라이스 위치(법선 투영)
    const d = Math.abs(loc(gm.pos) - loc(gt.pos));
    if (d < bestD) { bestD = d; best = i; }
  }
  return best >= 0 ? best : null;
}

/* ── TY-3: 작업 히스토리 스냅샷 — 시각조정(줌/팬/회전/반전/W-L/필터/셔터)+주석 (In takeSnap 이식) ── */
type VisSnap = Pick<PaneState, "zoom" | "tx" | "ty" | "rot" | "flipH" | "flipV" | "invert" | "wl" | "fx" | "shutter">;
type Snap = { vis: Record<string, VisSnap>; annos: Anno[] };
/* 주석 마우스 드래그 상태 — 그리기(draw)/이동(move)/점 크기변경(resize).
   rect/aspect/inst 는 down 시점에 고정(드래그 중 페인은 이동/리사이즈 안 함) */
type AnnoDrag =
  | { type: "draw"; pid: string; tool: ToolKind; sop: string; series: string;
      start: number[]; cur: number[]; rect: DOMRect; aspect: number; inst: InstanceNode }
  | { type: "move"; pid: string; idx: number; startPt: number[]; origPoints: number[][];
      rect: DOMRect; aspect: number; inst: InstanceNode; moved: boolean }
  | { type: "resize"; pid: string; idx: number; ptIdx: number;
      rect: DOMRect; aspect: number; inst: InstanceNode; moved: boolean };
/** 페인 CSS filter — 반전 + 필터 3종 조합 (In Viewer paneFilter 동치, sharpen 은 SVG feConvolveMatrix) */
function paneFilter(p: PaneState): string | undefined {
  const parts: string[] = [];
  if (p.invert) parts.push("invert(1)");
  if (p.fx === "sharpen") parts.push("url(#ty-sharpen)");
  if (p.fx === "smooth") parts.push("blur(1.2px)");
  if (p.fx === "pseudo") parts.push("sepia(1) saturate(5) hue-rotate(175deg)");   // 근사 컬러맵
  return parts.length ? parts.join(" ") : undefined;
}

function renderedUrlAt(p: PaneState, idx: number): string | null {
  const inst = p.series?.instances[idx];
  if (!p.series || !inst) return null;
  const wl = p.wl ? `?window=${p.wl},linear` : "";
  const su = inst.series_uid ?? p.series.series_uid;   // Combine 결합본은 인스턴스마다 원본 시리즈/검사 UID
  const stu = inst.study_uid ?? p.studyUid;
  // WASM 파이프라인(베타) — 준비된 로컬 디코딩 프레임이 있으면 우선, 없으면 서버 렌더링 폴백
  const wasm = wasmFrameUrl(stu, su, inst.sop_uid, p.wl || "");
  if (wasm) return wasm;
  return `${DICOMWEB_ROOT}/studies/${stu}/series/${su}/instances/${inst.sop_uid}/rendered${wl}${renderedParams(!!wl)}`;
}
// Combine — 여러 SeriesNode 를 하나의 논리적 시리즈로 이어붙임(서버 병합 아님, 표시 결합).
// 원본 시리즈(검사+시리즈 UID)별로 그룹화(첫 등장 순서 유지) → 그룹 내 instance_number 정렬·sop 중복 제거 →
// 그룹 순서대로 연결. 각 인스턴스에 원본 series_uid/study_uid 태깅(정확히 요청·다른 검사 결합 안전). 재결합·재추가 멱등.
function buildCombined(list: { s: SeriesNode; studyUid: string }[]): SeriesNode {
  const groups = new Map<string, InstanceNode[]>();
  for (const { s, studyUid } of list) {
    for (const i of s.instances) {
      const su = i.series_uid ?? s.series_uid;
      const stu = i.study_uid ?? studyUid;
      const key = `${stu}|${su}`;
      let arr = groups.get(key);
      if (!arr) { arr = []; groups.set(key, arr); }
      arr.push({ ...i, series_uid: su, study_uid: stu });
    }
  }
  const instances = [...groups.values()].flatMap((arr) => {
    const seen = new Set<string>();
    return [...arr]
      .sort((a, b) => (a.instance_number ?? 0) - (b.instance_number ?? 0))
      .filter((i) => (seen.has(i.sop_uid) ? false : (seen.add(i.sop_uid), true)));
  });
  const origin = [...groups.keys()].map((k) => k.split("|")[1]);
  return {
    series_uid: `combined:${origin.join("+")}`,
    modality: list[0]?.s.modality ?? "",
    series_desc: `Combined · ${origin.length}개 시리즈 · ${instances.length}장`,
    series_number: list[0]?.s.series_number ?? 0,
    instances,
  };
}
function renderedUrl(p: PaneState): string | null {
  return renderedUrlAt(p, p.index);
}

interface ViewerPrefs {
  paletteSide: "left" | "top" | "right" | "bottom";   // Toolbar 위치 (Setting>Viewer·드래그 도킹)
  thumbSide: "left" | "bottom" | "right" | "top";  // Thumbnail 위치 (Setting·드래그 도킹)
  thumbSize: number;        // px
  thumbMode: "series" | "all";
  hanging2d: Record<string, string | { s: string; i: string }>;  // modality → Series 분할(문자열) 또는 {s:Series, i:Image}
  reportDock: boolean;
  paletteW: number;         // 팔레트 폭 (스플리터 조절, 계정 로밍)
  dockW: number;            // 판독 도크 폭
  toolbar: Record<string, boolean>;  // 툴바 버튼 표시 여부 (기본 모두 표시)
  wl_presets: { key: string; label: string; q: string }[];  // W/L Presetting
  close_mode: "ask" | "save_current" | "save_all" | "discard";  // 닫기 동작 (Setting>Viewer)
  // 창별 모니터 배치 — screens(뷰어), worklist/report, max_open(라운드로빈 슬롯 수), close_scope(All Close 범위)
  monitor?: { screens?: number[]; worklist?: number | null; report?: number | null;
              max_open?: number; close_scope?: "all" | "current" };
}
const DEFAULT_PREFS: ViewerPrefs = {
  paletteSide: "left", thumbSide: "left", thumbSize: 128,
  thumbMode: "series", hanging2d: {}, reportDock: false,  // 판독 도크 기본 숨김(Setting>뷰어공통에서 표시)
  paletteW: 200, dockW: 340, toolbar: {}, wl_presets: WL_PRESETS,
  close_mode: "ask",
};

// Exam 탭 영속 — 새 창 뷰어가 재사용/재오픈돼도 ✕/전체닫기 전까지 우측에 계속 쌓인다 (UBPACS)
const TABS_KEY = "sv_viewer_tabs";
function loadPersistedTabs(): { id: number; uid: string; label: string }[] {
  try { return JSON.parse(localStorage.getItem(TABS_KEY) ?? "[]"); } catch { return []; }
}
function savePersistedTabs(tabs: { id: number; uid: string; label: string }[]) {
  try { localStorage.setItem(TABS_KEY, JSON.stringify(tabs)); } catch { /* quota */ }
}

// eslint-disable-next-line react-refresh/only-export-components
/* SAINT VIEW 스킨 상단 가로 메뉴 툴바 — 드롭다운 4종(Image Tool/Measurement/Reading Support/Additional)
   + 좌측 환자 ◀▶ 이동 + 활성 마우스모드/툴 칩. 항목 run 은 기존 툴 함수 그대로 호출(기능=TY 뷰어 동일). */
function SaintMenuBar({ menus, activeId, onNav, navPrevDisabled, navNextDisabled, side = "top", onGripDown, quick }: {
  menus: { title: string; items: { id: string; label: string; icon?: string; run: () => void }[] }[];
  activeId: string;                 // 현재 활성 마우스모드/툴 id (드롭다운·칩 하이라이트)
  onNav: (dir: 1 | -1) => void;     // 환자(검사) ◀▶ 이동
  navPrevDisabled: boolean;
  navNextDisabled: boolean;
  side?: "top" | "bottom" | "left" | "right";   // 도킹 위치(설정 툴 팔레트 위치와 연동)
  onGripDown?: (e: React.PointerEvent) => void; // ⠿ 그립 — 드래그 도킹 시작
  quick?: { id: string; label: string; icon?: string; run: () => void }[];  // ★Quick — 세로 모드 2열 그리드(최대 6)
}) {
  const vertical = side === "left" || side === "right";
  // 세로(좌/우) = 모든 섹션 펼침이 기본, 상/하 = 닫힘이 기본. 항목은 헤더 '아래'로 펼쳐진다.
  const [openSet, setOpenSet] = useState<Set<string>>(() => new Set(vertical ? menus.map((m) => m.title) : []));
  useEffect(() => { setOpenSet(new Set(vertical ? menus.map((m) => m.title) : [])); }, [vertical]);  // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (t: string) => setOpenSet((st) => {
    if (vertical) { const n = new Set(st); if (n.has(t)) n.delete(t); else n.add(t); return n; }
    return st.has(t) ? new Set() : new Set([t]);   // 상/하 = 한 번에 하나
  });
  const activeLabel = menus.flatMap((m) => m.items).find((it) => it.id === activeId)?.label ?? activeId;
  return (
    <div style={{ display: "flex", flexDirection: vertical ? "column" : "row",
                  alignItems: vertical ? "stretch" : "center", gap: 2, padding: vertical ? "6px 4px" : "2px 8px",
                  background: "var(--bg-panel)", position: "relative", zIndex: 30, flexShrink: 0,
                  ...(vertical ? { width: 156, overflowY: "auto", minHeight: 0, ...(side === "right" ? { borderLeft: "1px solid var(--border)" }
                                                                     : { borderRight: "1px solid var(--border)" }) }
                               : side === "bottom" ? { borderTop: "1px solid var(--border)" }
                               : { borderBottom: "1px solid var(--border)" }) }}
         onMouseLeave={() => { if (!vertical) setOpenSet(new Set()); }}>
      {/* 위치 그립 — 드래그해서 좌/우/상/하 도킹(설정 툴 팔레트 위치와 동일 저장) */}
      <div title="드래그로 툴 파레트(메뉴바) 위치 이동 — 화면 가장자리로 끌어 놓으세요"
           onPointerDown={onGripDown}
           style={{ cursor: "grab", fontSize: 10, color: "var(--text-secondary)", userSelect: "none",
                    textAlign: "center", padding: vertical ? "0 0 2px" : "0 4px", flexShrink: 0 }}>⠿</div>
      {/* 환자 ◀▶ 이동 — 한 줄 */}
      <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
        <button title="◀ 이전 검사" disabled={navPrevDisabled} onClick={() => onNav(-1)}
                style={{ flex: 1, padding: "4px 9px", fontSize: 13, fontWeight: 700, opacity: navPrevDisabled ? 0.35 : 1 }}>◀</button>
        <button title="▶ 다음 검사" disabled={navNextDisabled} onClick={() => onNav(1)}
                style={{ flex: 1, padding: "4px 9px", fontSize: 13, fontWeight: 700, opacity: navNextDisabled ? 0.35 : 1 }}>▶</button>
      </div>
      {vertical && quick && quick.length > 0 ? (
        /* ★Quick — 2열 그리드, 최대 6개(Save·Rfsh 고정 + 사용 상위) */
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2, flexShrink: 0, padding: "3px 0",
                      borderBottom: "1px solid var(--border)" }}>
          {quick.slice(0, 6).map((q) => (
            <button key={q.id} onClick={q.run} title={q.label}
                    style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                             padding: "5px 4px", fontSize: 10.5, borderRadius: 4, border: "none", cursor: "pointer",
                             background: "var(--bg-elevated)",
                             color: q.id === activeId ? "#facc15" : "var(--text-primary)",
                             fontWeight: q.id === activeId ? 700 : 400 }}>
              <ToolIconTy id={q.icon ?? q.id} size={13} flat />{q.label}
            </button>
          ))}
        </div>
      ) : (
        /* 활성 마우스모드/툴 칩 (상/하 가로 모드) */
        <span title="현재 활성 도구" style={{ margin: "0 8px 0 4px", padding: "3px 10px", fontSize: 11, fontWeight: 700,
                      borderRadius: 12, background: "var(--accent)", color: "#fff", whiteSpace: "nowrap",
                      ...(vertical ? { textAlign: "center", margin: "2px 0" } : {}) }}>
          ● {activeLabel}
        </span>
      )}
      {menus.map((m) => {
        const isOpen = openSet.has(m.title);
        return (
        <div key={m.title} style={{ position: vertical ? "static" : "relative" }}
             onMouseEnter={() => { if (!vertical) setOpenSet((st) => (st.size ? new Set([m.title]) : st)); }}>
          <button onClick={() => toggle(m.title)}
                  style={{ fontSize: 12.5, padding: "6px 12px", fontWeight: 700, borderRadius: 6,
                           width: vertical ? "100%" : undefined, textAlign: vertical ? "left" : "center",
                           color: "var(--text-primary)", cursor: "pointer", margin: vertical ? "3px 0 1px" : undefined,
                           // 3D 입체 — 그룹 헤더임을 명확히: 평시 양각(raised), 펼침 시 눌림(inset)
                           border: "1px solid rgba(0,0,0,0.55)",
                           background: isOpen ? "linear-gradient(180deg, #232933, #2c3440)"
                                              : "linear-gradient(180deg, #3d4657, #272d38)",
                           boxShadow: isOpen ? "inset 0 2px 5px rgba(0,0,0,0.55)"
                                             : "inset 0 1px 0 rgba(255,255,255,0.16), 0 2px 3px rgba(0,0,0,0.45)" }}>
            {m.title} {isOpen ? "▴" : "▾"}
          </button>
          {isOpen && (
            <div style={vertical
              ? { display: "flex", flexDirection: "column", gap: 1, padding: "1px 0 5px 6px" }
              : { position: "absolute", zIndex: 350, minWidth: 190,
                  ...(side === "bottom" ? { bottom: "100%", left: 0 } : { top: "100%", left: 0 }),
                  background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 5,
                  boxShadow: "0 6px 18px rgba(0,0,0,0.5)", maxHeight: 460, overflow: "auto", padding: 3 }}>
              {(vertical ? m.items.filter((x) => x.id !== "report") : m.items).map((it) => {
                const on = it.id === activeId;
                return (
                  <button key={it.id} onClick={() => { it.run(); if (!vertical) setOpenSet(new Set()); }}
                          style={{ display: "flex", justifyContent: "space-between", gap: 10, width: "100%", textAlign: "left",
                                   padding: "6px 12px", fontSize: 12, borderRadius: 3, border: "none", cursor: "pointer",
                                   whiteSpace: "nowrap", background: "transparent",
                                   // on = 노란 아이콘·글자(아이콘은 flat currentColor 라 글자색 따라감), off = 흰색
                                   color: on ? "#facc15" : "var(--text-primary)", fontWeight: on ? 700 : 400 }}
                          onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = "var(--bg-panel)"; }}
                          onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = "transparent"; }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                      <span style={{ width: 15, display: "inline-flex" }}><ToolIconTy id={it.icon ?? it.id} size={13} flat /></span>
                      {it.label}
                    </span>{on && <span>●</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        );
      })}
      {/* Report — 세로 모드에선 스크롤과 무관하게 하단 고정 */}
      {vertical && (() => {
        const rep = menus.flatMap((m) => m.items).find((it) => it.id === "report");
        return rep ? (
          <button onClick={rep.run} title="Report — 판독창 열기 (항상 하단 고정)"
                  style={{ position: "sticky", bottom: 0, marginTop: "auto", zIndex: 5, flexShrink: 0,
                           display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                           padding: "9px 0", fontWeight: 700, fontSize: 12.5, borderRadius: 6, cursor: "pointer",
                           border: "1px solid rgba(0,0,0,0.55)",
                           background: "linear-gradient(180deg, var(--accent), #1d4ed8)", color: "#fff",
                           boxShadow: "inset 0 1px 0 rgba(255,255,255,0.25), 0 -2px 6px rgba(0,0,0,0.4)" }}>
            <ToolIconTy id={rep.icon ?? "report"} size={14} flat />Report
          </button>
        ) : null;
      })()}
    </div>
  );
}

export function Viewer2D({ detail, onClose, addDetail, stackDetail, keySops, withOpen, navFilter, skin = "ty" }: {
  detail: StudyDetail;
  onClose: () => void;
  addDetail?: StudyDetail | null;    // ② Add View: 기존(detail) 유지 + 이 검사를 분할 추가
  stackDetail?: StudyDetail | null;  // ③ Stack View: 기존 유지 + 이 검사를 같은 페인에 중첩
  keySops?: string[] | null;         // ⑤ Key Image View: 이 SOP 목록만 표시 (F-16)
  withOpen?: { mode: "add" | "stack"; ids: number[] } | null;  // Study With Open (p.13)
  navFilter?: Record<string, string>;  // ◀▶ 탐색 목록 필터(모니터 배정 탭) — 없으면 전체 목록
  skin?: "ty" | "saint";             // SAINT VIEW 스킨 — 상단 가로 메뉴 툴바 + 세로 팔레트 숨김 (엔진·기능 동일)
}) {
  const [prefs, setPrefs] = useState<ViewerPrefs>(DEFAULT_PREFS);
  // 병원별 영상 전송 형식 로드 — 관리자 설정(JPEG 품질/PNG)을 rendered 호출에 반영
  useEffect(() => {
    const hid = Number(localStorage.getItem("sv_active_hospital") || 0);
    if (hid) api.hospImageFormat(hid).then(setImageFormat).catch(() => {});
  }, []);
  // OHIF 표시 — 기본 숨김, 설정>뷰어>OHIF 허용 시에만 (viewer.prefs.ohif_enabled)
  const [ohifOn, setOhifOn] = useState(false);
  useEffect(() => {
    api.getSetting("viewer.prefs").then((r) =>
      setOhifOn(!!(r.value as { ohif_enabled?: boolean }).ohif_enabled)).catch(() => {});
  }, []);
  const prefsRef = useRef(prefs);
  useEffect(() => { prefsRef.current = prefs; }, [prefs]);
  const [series, setSeries] = useState<SeriesNode[]>([]);
  const [layout, setLayout] = useState<keyof typeof LAYOUTS>("1x1");
  // Image Layout — 페인 내부 이미지 분할(연속 이미지 N×M 타일, UBPACS)
  const [imgLay, setImgLay] = useState({ r: 1, c: 1 });   // 콤보 표시용 — 실제 적용은 페인별 il
  // 2D 행잉(모달리티→Image 분할) 기본 il — 검사 열 때 페인에 적용(prefs 로드에서 해석)
  const hang2dImgRef = useRef<{ r: number; c: number } | null>(null);
  // 페인 최대화(더블클릭 토글) + 페인 경계 스플리터 분율 (In Viewer 이식)
  const [maximized, setMaximized] = useState<string | null>(null);
  const vpRef = useRef<HTMLDivElement>(null);
  const [colFr, setColFr] = useState<number[]>([1]);
  const [rowFr, setRowFr] = useState<number[]>([1]);
  // 확대경(Magnification) — 마우스 추적 3배 렌즈 (In Viewer 이식, 단일 이미지 페인)
  const [magOn, setMagOn] = useState(false);
  const [magPos, setMagPos] = useState<{ pid: string; mx: number; my: number;
                                         nx: number; ny: number; sc: number } | null>(null);
  // 신규 prefs 계약: ty_sel_color=활성(선택) 페인 테두리 색, ty_cine_sec=시네 간격(초)
  const [tySelColor, setTySelColor] = useState("#d946ef");
  const [tyCineSec, setTyCineSec] = useState(0.15);
  /* 레이아웃 변경 — 최대화 해제 + 경계 분율 초기화 */
  useEffect(() => {
    setMaximized(null);
    setColFr(Array(LAYOUTS[layout].cols).fill(1));
    setRowFr(Array(LAYOUTS[layout].rows).fill(1));
    setSelPanes(new Set());   // 레이아웃 변경 — 멀티 선택 초기화 (In 동일)
  }, [layout]);
  /* 경계 스플리터 — 인접 두 행/열의 flex 분율을 픽셀 이동량만큼 주고받기 (In Viewer adjFr 동치) */
  const adjFr = (set: React.Dispatch<React.SetStateAction<number[]>>, i: number,
                 deltaPx: number, totalPx: number) =>
    set((fr) => {
      const sum = fr.reduce((a, b) => a + b, 0) || 1;
      const d = (deltaPx / Math.max(totalPx, 1)) * sum;
      const next = [...fr];
      next[i] = Math.max(0.15, (next[i] ?? 1) + d);
      next[i + 1] = Math.max(0.15, (next[i + 1] ?? 1) - d);
      return next;
    });
  // HP(행잉 프로토콜) + W/L 프리셋(All 적용) + 타이틀바 드롭다운
  const [hpRules, setHpRules] = useState<HpRule[]>([]);
  const [hpName, setHpName] = useState("기본");
  const [wlAll, setWlAll] = useState(false);  // W/L 프리셋을 전체 페인에 적용 (UBPACS All)
  const [menu, setMenu] = useState<null | "opened" | "related" | "series" | "hp">(null);
  const [mprOn, setMprOn] = useState(false);  // 내장 MPR/MIP (CT/MR — 뷰포트 영역 전환)
  const [mprSeries, setMprSeries] = useState("");  // 3D 모드에서 썸네일 클릭으로 지정한 볼륨 시리즈
  const [settingsOpen, setSettingsOpen] = useState(false);  // 뷰어 내 Setting
  // ◀▶ 환자 이동 — 시간대별 한 단계(워크리스트 정렬: 최신이 위/앞).
  // 방향은 Setting>정책(nav_left)을 따른다: past=◀가 과거(아래 행) / recent=◀가 최신(위 행)
  const [wlIds, setWlIds] = useState<number[]>([]);       // ◀▶ 탐색: 배정 탭(navFilter) 필터 목록
  const [wlIdsAll, setWlIdsAll] = useState<number[]>([]);  // 폴백: 전체(무필터) 목록
  const [navLeft, setNavLeft] = useState<"past" | "recent">("past");
  useEffect(() => {
    const hasFilter = !!(navFilter && Object.keys(navFilter).length);
    // navFilter(모니터 배정 탭)가 있으면 그 필터 목록으로, 없으면 전체 목록으로 ◀▶ 탐색.
    api.worklist({ ...(navFilter ?? {}), limit: "500" }).then((r) => {
      const ids = r.items.map((it) => it.id);
      setWlIds(ids);
      if (!hasFilter) setWlIdsAll(ids);   // 필터 없으면 동일
    }).catch(() => {});
    // 필터가 있으면 전체 목록도 확보 — 현재 검사가 필터 밖일 때 ◀▶가 죽지 않도록 폴백
    if (hasFilter) api.worklist({ limit: "500" }).then((r) => setWlIdsAll(r.items.map((it) => it.id))).catch(() => {});
    api.getSetting("worklist.prefs").then((r) => {
      const nl = (r.value as { nav_left?: "past" | "recent" }).nav_left;
      if (nl) setNavLeft(nl);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(navFilter ?? {})]);
  /** 현재 활성 페인에 보이는 검사 id — ◀▶ 이동의 기준점 */
  const currentNavId = () => {
    const curUid = panes[activePane]?.studyUid || detail.study_uid;
    return openTabsRef.current.find((t) => t.uid === curUid)?.id ?? detail.id;
  };
  /** visual: -1=◀, 1=▶ → 정책에 따른 목록 스텝. 요청 2번: 이미 열린 검사(모든 모니터 공유 탭)는
   *  건너뛰고 워크리스트 시간순으로 '아직 열리지 않은' 다음 검사를 반환.
   *  현재 검사가 배정 탭 필터 밖(라운드로빈으로 다른 모달리티가 이 모니터에 열린 경우)이면 전체 목록으로 폴백. */
  const navTarget = (visual: 1 | -1): number | undefined => {
    const cur = currentNavId();
    const list = wlIds.includes(cur) ? wlIds : wlIdsAll;
    const idx = list.indexOf(cur);
    if (idx < 0) return undefined;
    const leftStep = navLeft === "past" ? 1 : -1;  // 과거 = 목록 아래(idx 증가)
    const step = visual === -1 ? leftStep : -leftStep;
    const opened = new Set(loadPersistedTabs().map((t) => t.id));   // 모든 모니터에 걸쳐 열린 검사
    for (let j = idx + step; j >= 0 && j < list.length; j += step) {
      if (!opened.has(list[j])) return list[j];   // 아직 열리지 않은 다음 검사
    }
    return undefined;   // 방향으로 남은 미열림 검사 없음
  };
  const navPatient = async (visual: 1 | -1) => {
    const target = navTarget(visual);
    if (target === undefined) {
      setStatus(visual === -1 ? "이전 검사가 없습니다 (목록 끝)" : "다음 검사가 없습니다 (목록 끝)");
      return;
    }
    postStudySync(target, "viewer");  // Worklist·Reading 연동
    // 이미 열린 환자(Exam 탭)면 → 그 탭으로 전환
    const opened = openTabsRef.current.find((t) => t.id === target);
    if (opened) { void loadIntoActive(opened.id); return; }
    // 미오픈 → 페이지 리로드 없이 제자리 오픈: Exam 탭 우측 누적 + 활성 화면 전환
    // (다른 환자면 loadIntoActive 의 혼합 방지 규칙이 전체 재행잉)
    try {
      const d = await api.study(target);
      setStudyMeta((m) => ({ ...m, [d.study_uid]: metaOf(d) }));
      addOpenTab(target, d.study_uid, `${d.modality} ${d.patient_name} ${d.study_date} #${d.id}`);
      await loadIntoActive(target);
    } catch { setStatus("검사 이동 실패"); }
  };
  // 다른 창(Worklist/Reading)에서 환자가 바뀌면 — 열린 탭이면 그 탭으로 전환
  const loadIntoActiveRef = useRef<(id: number) => Promise<void>>(async () => {});
  const openTabsRef = useRef<{ id: number; uid: string; label: string }[]>([]);
  useEffect(() => {
    const off = onStudySync("viewer", (id) => {
      const opened = openTabsRef.current.find((t) => t.id === id);
      if (opened) void loadIntoActiveRef.current(opened.id);
    });
    return off;
  }, []);
  // 다중 모니터 라운드로빈 — 다른 모니터에서 검사를 열면 이 창은 리로드/활성 전환 없이 Exam 탭만 추가.
  // (탭 클릭 시 loadIntoActive 로 온디맨드 로드 — "화면 깜빡임 없이 탭만 추가" 요구 충족)
  useEffect(() => {
    const off = onViewerAddTab((id, uid, label) => {
      setOpenTabs((prev) => (prev.some((t) => t.id === id) ? prev : [...prev, { id, uid, label }]));
    });
    return off;
  }, []);
  const [activePane, setActivePane] = useState("p0");
  const [panes, setPanes] = useState<Record<string, PaneState>>(
    Object.fromEntries(PANE_IDS.map((p) => [p, initPane(detail.study_uid)])),
  );
  const [selSeries, setSelSeries] = useState<string | null>(null);
  // 기본 툴은 항상 Select — 시작·해제 공통(In-View 정합). Zoom/Pan/W/L 은 사용자가 명시 선택 시에만
  const [mouseMode, setMouseMode] = useState<"wl" | "zoom" | "pan" | "select" | "scroll">("select");
  // 팔레트 섹션 — 기본 전체 펼침(헤더 클릭으로 개별 접기)
  const [openSecs, setOpenSecs] = useState<Set<string>>(new Set(["common", "anno", "anatomy", "px", "shut", "2d", "etc"]));
  const toggleSec = (k: string) => setOpenSecs((p) => {
    const n = new Set(p);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });
  // TY-3(3): Crosslink 5모드 — 기존 syncScroll(Link 단일)을 확장. off/auto_sync/sync_other/scout/all_lines
  const [xmode, setXmode] = useState<XlinkMode>("off");
  const xmodeRef = useRef(xmode);
  useEffect(() => { xmodeRef.current = xmode; }, [xmode]);
  // 듀얼모드 Stack 동기 — true=Spatial(DICOM 좌표 해부학적 정합, Infinitt식), false=Index(1:1 인덱스, TY식). 'G' 로 토글.
  const [spatialSync, setSpatialSync] = useState(true);
  const spatialSyncRef = useRef(spatialSync);
  useEffect(() => { spatialSyncRef.current = spatialSync; }, [spatialSync]);
  // TY-3(2): 멀티 페인 선택 — Shift=범위/Ctrl=토글/A=전체, 선택 페인 연동 조작 (In selPanes 이식)
  const [selPanes, setSelPanes] = useState<Set<string>>(new Set());
  const selPanesRef = useRef(selPanes);
  useEffect(() => { selPanesRef.current = selPanes; }, [selPanes]);
  // TY-3(4): 3D Cursor 십자 마커 — 페인별 {sop, 정규화 x/y} (In cross3d 이식)
  const [cross3d, setCross3d] = useState<Record<string, { sop: string; x: number; y: number }>>({});
  // 숫자키/상하 화살표 시리즈 선택 — thumbSeries 는 뒤에서 정의되므로 ref 로 최신 함수 참조
  const seriesKeyRef = useRef<{ sel: (n: number) => void; step: (d: 1 | -1) => void }>({ sel: () => {}, step: () => {} });
  // 사용자 단축키(설정>단축키, 계정별) — 액션→키 맵 + 디스패처(함수는 렌더마다 최신화)
  const scKeysRef = useRef<Record<string, string>>({ ...SC_DEFAULTS });
  const scRunRef = useRef<(id: string) => void>(() => {});
  const refreshExamRef = useRef<null | (() => Promise<void>)>(null);  // 휴대폰 촬영 폴링용

  // 3D Cursor 홀드-드래그 — 버튼을 누른 채 움직이면 rAF 스로틀로 연속 재배치(모든 페인 동기 추적)
  const c3DragRef = useRef<{ pid: string } | null>(null);
  const c3RafRef = useRef(0);
  // TY-3(5): 페인별 시네 미니 컨트롤 표시용 호버 페인
  const [hoverPane, setHoverPane] = useState<string | null>(null);
  // 썸네일 시리즈 → 페인 드래그앤드롭: 드롭 대상 페인 하이라이트
  const [dragOverPane, setDragOverPane] = useState<string | null>(null);
  // 드롭 Circle Menu(INFINITT Circle Menu 등가) — 시리즈를 페인에 놓으면 Open/Combine/Combine all 선택
  const [circle, setCircle] = useState<{ pid: string; uid: string; x: number; y: number } | null>(null);
  // 드롭 동작 메뉴 표시 여부(설정>뷰어 drop_menu, 기본 숨김=바로 Open) — 계정별
  const dropMenuRef = useRef(false);
  // 드롭된 series_uid 로 시리즈 객체를 찾아 해당 페인에 로드
  const dropSeriesToPane = (pid: string, seriesUid: string) => {
    const s = thumbSeries.find((x) => x.series_uid === seriesUid) ?? series.find((x) => x.series_uid === seriesUid);
    if (!s) { setStatus("드롭 실패 — 시리즈를 찾을 수 없습니다"); return; }
    patch(pid, { ...initPane(uidOfSeries(s.series_uid)), series: s, index: Math.floor(s.instances.length / 2) });
    setActivePane(pid);
    setStatus(`시리즈 S${s.series_number}(${s.series_desc || s.modality}) → 페인 로드 (드래그앤드롭)`);
  };
  // TY-3(7): 로컬 미디어(jpg/png/bmp/avi/mp4) 파일 선택
  const mediaInputRef = useRef<HTMLInputElement>(null);
  // TY-3(9): Compare 모달 — 같은 환자 과거검사 다중 선택 비교
  const [cmpOpen, setCmpOpen] = useState(false);
  const [cmpSel, setCmpSel] = useState<Set<number>>(new Set());
  // 워크리스트 ⇄ Compare 진입(?cmp=1) — 로드 직후 Compare 모달 자동 오픈(1회)
  const cmpParamRef = useRef(new URLSearchParams(window.location.search).get("cmp") === "1");
  useEffect(() => {
    if (cmpParamRef.current) { cmpParamRef.current = false; setCmpOpen(true); }
  }, []);
  const [thumbOpen, setThumbOpen] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [reportCollapsed, setReportCollapsed] = useState(false);  // 판독창 오른쪽 접기/펼치기
  const [overlayOn, setOverlayOn] = useState(true);
  // 키이미지 마크 — 열린 검사의 key_images SOP 집합(반응형). 페인에 🔑 마크 표시, 토글 시 즉시 갱신
  const [keyMarks, setKeyMarks] = useState<Set<string>>(new Set());
  const [cine, setCine] = useState(false);
  const cineRef = useRef<number | null>(null);
  const [status, setStatus] = useState("");
  // 판독 도크 — 공유 컴포넌트 ReportDock 로 추출(상태·로직 포함 이사, components/ReportDock.tsx)
  // TY 팔레트 개인화 (viewer.prefs — 계정 로밍): 아이콘 크기/라벨/퀵로우/사용패턴/오버레이 폰트
  const [tySize, setTySize] = useState(51);          // ty_tool_size (기본 3배 확대 — 구 기본 17 저장분은 아래서 승격)
  const [tyLabels, setTyLabels] = useState(true);    // ty_tool_labels
  const [tyIcon3d, setTyIcon3d] = useState(true);    // ty_icon_3d — false 면 플랫(평면) 아이콘
  const [tyQuickRow, setTyQuickRow] = useState(true);  // ty_quick_row — ★ Quick 행 표시
  const [tyToolCols, setTyToolCols] = useState(2);     // ty_tool_cols — 팔레트 툴 배열(열 수), 기본 2X2
  const [tyUsageRec, setTyUsageRec] = useState(true);  // ty_usage_rec — 사용 패턴 기록 on/off
  const [tyUsage, setTyUsage] = useState<Record<string, number>>({});  // ty_usage
  const tyUsageRef = useRef<Record<string, number>>({});
  const [tyOvFont, setTyOvFont] = useState(10.5);    // ty_overlay_font — T+스크롤
  const tHeld = useRef(false);   // T 홀드 — T+스크롤=오버레이 글자 크기, T+Del=오버레이 토글
  // viewer.prefs 부분 패치 저장 — 디바운스(연속 조작 병합, 계정 로밍)
  const pendingPrefs = useRef<Record<string, unknown>>({});
  const prefsTimer = useRef<number | null>(null);
  const persistPrefsPatch = (patch: Record<string, unknown>, delay = 600) => {
    pendingPrefs.current = { ...pendingPrefs.current, ...patch };
    if (prefsTimer.current) window.clearTimeout(prefsTimer.current);
    prefsTimer.current = window.setTimeout(() => {
      const p = pendingPrefs.current;
      pendingPrefs.current = {};
      api.getSetting("viewer.prefs").then((r) =>
        api.putSetting("viewer.prefs", { ...r.value, ...p }, "user")).catch(() => {});
    }, delay);
  };
  /* 언마운트 시 디바운스 대기 중인 패치 즉시 저장 — 뷰어 닫힘 직전 조작(사용 카운트 등) 유실 방지.
     페인 로컬 미디어 오브젝트 URL 도 함께 해제(누수 방지) */
  useEffect(() => () => {
    if (prefsTimer.current) window.clearTimeout(prefsTimer.current);
    const p = pendingPrefs.current;
    if (Object.keys(p).length) {
      pendingPrefs.current = {};
      api.getSetting("viewer.prefs").then((r) =>
        api.putSetting("viewer.prefs", { ...r.value, ...p }, "user")).catch(() => {});
    }
    Object.values(panesRef.current).forEach((q) => {
      if (q.media) URL.revokeObjectURL(q.media.url);
    });
  }, []);
  /* 사용 패턴 기록 — 툴·액션 버튼 활성화 시 카운트+1, 상위 50개만 유지, 2초 디바운스 저장 */
  const recordUse = (id: string) => {
    if (!tyUsageRec) return;
    const merged = { ...tyUsageRef.current, [id]: (tyUsageRef.current[id] ?? 0) + 1 };
    const top = Object.fromEntries(Object.entries(merged).sort((a, b) => b[1] - a[1]).slice(0, 50));
    tyUsageRef.current = top;
    setTyUsage(top);
    persistPrefsPatch({ ty_usage: top }, 2000);
  };
  /* 오버레이 표시 토글 — INFO ● 버튼·T+Del 공용, ty_overlay_visible 로밍 */
  const toggleOverlay = () => setOverlayOn((o) => {
    persistPrefsPatch({ ty_overlay_visible: !o });
    return !o;
  });
  const [priorTrees, setPriorTrees] = useState<Record<number, { uid: string; series: SeriesNode[] }>>({});

  /* 검사별 환자·검사 메타(uid 키) — 페인 오버레이가 '그 페인의 검사' 환자 정보를 표기하도록 (타 환자 오표기 방지) */
  type StudyMetaLite = { patient_name: string; sex: string; patient_key: string; modality: string; study_date: string; study_desc: string };
  const [studyMeta, setStudyMeta] = useState<Record<string, StudyMetaLite>>({});
  const metaReqRef = useRef<Set<string>>(new Set());
  const metaOf = (d: StudyMetaLite): StudyMetaLite => ({
    patient_name: d.patient_name, sex: d.sex, patient_key: d.patient_key,
    modality: d.modality, study_date: d.study_date, study_desc: d.study_desc,
  });
  const ensureMeta = (examId: number, uid: string) => {
    if (metaReqRef.current.has(uid)) return;
    metaReqRef.current.add(uid);
    api.study(examId).then((d) => setStudyMeta((m) => ({ ...m, [uid]: metaOf(d) })))
      .catch(() => metaReqRef.current.delete(uid));
  };
  useEffect(() => {
    setStudyMeta((m) => {
      const n = { ...m, [detail.study_uid]: metaOf(detail) };
      if (addDetail) n[addDetail.study_uid] = metaOf(addDetail);
      if (stackDetail) n[stackDetail.study_uid] = metaOf(stackDetail);
      return n;
    });
  }, [detail, addDetail, stackDetail]);
  // 오픈 검사 탭 — 여러 검사가 열리면 좌→우로 탭이 쌓인다(브라우저 창 메타포, UBPACS Opened Study List)
  const [openTabs, setOpenTabs] = useState<{ id: number; uid: string; label: string }[]>([]);
  useEffect(() => { if (openTabs.length) savePersistedTabs(openTabs); }, [openTabs]);  // ✕/전체닫기 전까지 유지
  openTabsRef.current = openTabs;  // 동기 리스너·◀▶ 기준점에서 최신값 사용
  // 뷰어 열림 하트비트(read_state) — 열린 검사 전체를 45s 주기로 서버에 알림(서버 TTL 120s).
  // 최신 id 목록은 ref 로 읽어 인터벌 재생성 없이 openTabs/detail 변경을 반영. 실패는 조용히 무시.
  const hbIdsRef = useRef<number[]>([]);
  hbIdsRef.current = [...new Set([detail.id, ...openTabs.map((t) => t.id)])];
  useEffect(() => {
    const beat = () => { api.activityHeartbeat(hbIdsRef.current, "viewer").catch(() => {}); };
    beat();  // 마운트 즉시 1회
    const timer = window.setInterval(beat, 45_000);
    return () => window.clearInterval(timer);
  }, []);
  const [closeDlg, setCloseDlg] = useState(false);
  // 측정/주석 (07 A.4) + Reference line
  const [tool, setTool] = useState<ToolKind | null>(null);
  // 3D Cursor Off(버튼 재클릭·다른 툴 선택·Esc 포함) → 십자 마커 전부 제거
  useEffect(() => {
    if (tool !== "cursor3d") setCross3d((m) => (Object.keys(m).length ? {} : m));
  }, [tool]);
  // 기능 툴 해제(재클릭·Esc·삭제 시 자동 Off 등 모든 경로) → 기본 툴은 항상 Select 로 복귀.
  // 툴 활성 없이 Zoom/Pan/W/L 버튼만 고른 경우는 tool 변화가 없어 사용자의 선택이 유지된다.
  useEffect(() => {
    if (tool === null) setMouseMode((m) => (m === "select" ? m : "select"));
  }, [tool]);
  const [annos, setAnnos] = useState<Anno[]>([]);
  const [draft, setDraft] = useState<{ pid: string; sop_uid: string; series_uid: string; points: number[][] } | null>(null);
  // 편집 선택 주석 — select 모드(도구 없음)에서 히트테스트로 지정. idx=annos 배열 index, sop=검증 태그
  const [selAnno, setSelAnno] = useState<{ sop: string; idx: number } | null>(null);
  // 마퀴(녹색 점선) 다중 선택 — Select 모드 빈 공간 드래그로 영역 내 주석 일괄 선택 → Del/휴지통/우클릭 삭제
  const [selAnnos, setSelAnnos] = useState<number[] | null>(null);   // annos 배열 index 목록
  const selAnnosRef = useRef(selAnnos);
  useEffect(() => { selAnnosRef.current = selAnnos; }, [selAnnos]);
  const [marquee, setMarquee] = useState<{ a: [number, number]; b: [number, number] } | null>(null);
  const marqueeRef = useRef<{ pid: string; rect: DOMRect; aspect: number; a: [number, number]; b: [number, number] } | null>(null);
  const [refOn, setRefOn] = useState(false);
  // TY-2 이식 상태 — Spine Label 연번, Profile 그래프·2D Table 모달 (In Viewer 이식)
  const spineSeq = useRef<{ base: string; n: number }>({ base: "L", n: 1 });
  const [profileData, setProfileData] = useState<{ title: string; vals: number[] } | null>(null);
  const [tableData, setTableData] = useState<{ title: string; rows: string[][] } | null>(null);
  const paneSizes = useRef<Record<string, { w: number; h: number }>>({});
  const [, setSizeTick] = useState(0);
  const observers = useRef<Record<string, ResizeObserver>>({});
  const paneRefCbs = useRef<Record<string, (el: HTMLDivElement | null) => void>>({});

  const getPaneRef = (pid: string) => {
    if (!paneRefCbs.current[pid]) {
      paneRefCbs.current[pid] = (el) => {
        observers.current[pid]?.disconnect();
        delete observers.current[pid];
        if (el) {
          const ro = new ResizeObserver((es) => {
            const r = es[0].contentRect;
            paneSizes.current[pid] = { w: r.width, h: r.height };
            setSizeTick((t) => t + 1);
          });
          ro.observe(el);
          observers.current[pid] = ro;
        }
      };
    }
    return paneRefCbs.current[pid];
  };

  const patch = useCallback((pid: string, p: Partial<PaneState>) => {
    setPanes((prev) => ({ ...prev, [pid]: { ...prev[pid], ...p } }));
  }, []);

  /* ── TY-3(2): 멀티 페인 연동 조작 공용 — updMany/targetsOf (In 이식, ref 로 항상 최신 선택 집합) ── */
  const updMany = useCallback((pids: string[], f: (p: PaneState) => Partial<PaneState>) => {
    setPanes((prev) => {
      const next = { ...prev };
      for (const id of pids) {
        if (next[id]?.series) next[id] = { ...next[id], ...f(next[id]) };
      }
      return next;
    });
  }, []);
  const targetsOf = (pid: string): string[] => {
    // In Viewer 정합: 멀티 선택 연동 조작은 Crosslink 마스터(xmode≠off)일 때만 (In targetsOf 동일 게이트)
    const s = selPanesRef.current;
    return xmodeRef.current !== "off" && s.size > 1 && s.has(pid) ? [...s] : [pid];
  };

  /* ── TY-3(1): 작업 히스토리 ◀◯▶ — 스냅샷 최대 50, Undo/초기화/Redo (In pushHist/histGo 이식) ── */
  const panesRef = useRef(panes);
  useEffect(() => { panesRef.current = panes; }, [panes]);
  const annosRef = useRef(annos);
  useEffect(() => { annosRef.current = annos; }, [annos]);
  // 저장 기준선 — 서버에 저장된 주석의 JSON 집합. 툴 Off/Rfsh 시 '미저장 작업'만 지우는 판별 기준.
  // Save 성공 시 현재 상태로 갱신(그 시점이 새 초기 상태), 로드 시 서버 주석으로 초기화.
  const savedAnnosRef = useRef<Set<string>>(new Set());
  const isSavedAnno = (a: Anno) => savedAnnosRef.current.has(JSON.stringify(a));
  const histRef = useRef<Snap[]>([]);
  const histIdx = useRef(-1);
  const [histTick, setHistTick] = useState(0);
  const takeSnap = (): Snap => ({
    vis: Object.fromEntries(Object.entries(panesRef.current).map(([k, p]) => [k, {
      zoom: p.zoom, tx: p.tx, ty: p.ty, rot: p.rot, flipH: p.flipH, flipV: p.flipV,
      invert: p.invert, wl: p.wl, fx: p.fx, shutter: p.shutter,
    }])),
    annos: annosRef.current,
  });
  const pushHist = () => {
    const s = takeSnap();
    const h = histRef.current;
    if (h[histIdx.current] && JSON.stringify(h[histIdx.current]) === JSON.stringify(s)) return;
    histRef.current = [...h.slice(0, histIdx.current + 1), s].slice(-50);   // redo 꼬리 절단, 최대 50
    histIdx.current = histRef.current.length - 1;
    setHistTick((t) => t + 1);
  };
  const schedHist = () => { window.setTimeout(pushHist, 50); };   // 상태 반영 후 캡처 (In 동일)
  const applySnap = (s: Snap) => {
    setPanes((prev) => Object.fromEntries(
      Object.entries(prev).map(([k, p]) => [k, s.vis[k] ? { ...p, ...s.vis[k] } : p])));
    setAnnos(s.annos);
    setSelAnno(null); setSelAnnos(null); setMarquee(null);   // 스냅샷 복원 — 인덱스 무효화 → 선택 해제
  };
  const histGo = (d: -1 | 1) => {
    const ni = histIdx.current + d;
    if (ni < 0 || ni >= histRef.current.length) return;
    histIdx.current = ni;
    applySnap(histRef.current[ni]);
    setHistTick((t) => t + 1);
  };
  const histReset = () => {
    if (!histRef.current[0]) return;
    applySnap(histRef.current[0]);
    // 초기화 시 셔터(가림)도 함께 해제
    setPanes((prev) => Object.fromEntries(Object.entries(prev).map(([k, q]) => [k, { ...q, shutter: null }])));
    histIdx.current = 0;
    setHistTick((t) => t + 1);
    setStatus("초기 상태로 되돌렸습니다 (셔터·주석 해제)");
  };
  // 히스토리에 기록할 원샷 조작(act) — 방향 전환/반전/필터/초기화 등 (In HIST_OPS 동일 취지)
  const HIST_OPS = useMemo(() => new Set(
    ["fit", "reset", "invert", "rotL", "rotR", "rot180", "flipH", "flipV", "sharpen", "average", "pseudo"]), []);

  /* ── TY-3(5): 페인별 독립 시네 엔진 — 100ms 틱, 페인 간격(cineSec ?? ty_cine_sec) 경과 시 전진.
        전역 Space 시네(cineRef)와 공존: 페인별 재생 중인 페인은 전역 스텝을 건너뛴다(페인별 우선).
        주의: 간격 판정·cineLastRef 갱신은 updater 밖에서(순수 updater — StrictMode 이중 호출 안전) ── */
  const cineLastRef = useRef<Record<string, number>>({});
  useEffect(() => {
    const t = window.setInterval(() => {
      const now = Date.now();
      const due: string[] = [];
      for (const pid of PANE_IDS) {
        const p = panesRef.current[pid];
        if (!p?.playing || !p.series?.instances.length || p.media) continue;
        const sec = p.cineSec ?? tyCineSec;
        if (now - (cineLastRef.current[pid] ?? 0) < Math.max(0.05, sec) * 1000) continue;
        cineLastRef.current[pid] = now;
        due.push(pid);
      }
      if (!due.length) return;
      setPanes((ps) => {
        const next = { ...ps };
        for (const pid of due) {
          const p = ps[pid];
          if (!p?.playing || !p.series?.instances.length || p.media) continue;
          const stride = Math.max(1, (p.il?.r ?? 1) * (p.il?.c ?? 1));   // 페인별 Image Layout
          next[pid] = { ...p, index: (p.index + stride) % p.series.instances.length };
        }
        return next;
      });
    }, 100);
    return () => window.clearInterval(t);
  }, [tyCineSec]);

  /* HP 규칙 적용 — Series/Image layout + W/L 프리셋 + 옵션(Crosslink/스크롤 동기/Scout) */
  const applyHp = useCallback((rule: HpRule) => {
    // viewer 디스플레이 그리드가 있으면 그것을, 없으면 하위호환 s 를 Series 분할로 사용
    const vd = rule.displays?.find((d) => d.role === "viewer");
    const sg = vd?.grid ?? rule.s;
    const key = `${Math.min(sg.r, 10)}x${Math.min(sg.c, 10)}`;
    if (LAYOUTS[key]) setLayout(key);
    setImgLay({ r: Math.min(rule.i.r, 10), c: Math.min(rule.i.c, 10) });
    if (rule.wl !== undefined) {
      setPanes((prev) => Object.fromEntries(
        Object.entries(prev).map(([k, p]) => [k, { ...p, wl: rule.wl ?? "" }])));
    }
    // 옵션 → 단일 xmode 매핑(우선순위: cross_link>scout>scroll_sync>link). 켜진 옵션 없으면 유지.
    const xm = rule.cross_link ? "all_lines" : rule.scout_image ? "scout"
             : rule.full_scroll_sync ? "sync_other" : rule.full_link ? "auto_sync" : null;
    if (xm) setXmode(xm);
    setHpName(rule.name);
  }, []);

  /* 설정 로드 + 행잉 적용(모달리티→분할) + HP 규칙 자동 매칭 */
  useEffect(() => {
    api.getSetting("viewer.prefs").then((r) => {
      const v = r.value as Partial<ViewerPrefs> & {
        hanging2d?: Record<string, string | { s: string; i: string }>;
        hanging2d_common_on?: boolean;
        hanging2d_by_viewer?: Record<string, Record<string, string | { s: string; i: string }>>;
      };
      const merged = { ...DEFAULT_PREFS, ...v };
      if (!merged.wl_presets?.length) merged.wl_presets = WL_PRESETS;
      // 구 기본값 업그레이드(23차: 팔레트·썸네일 확대) — 직접 조절한 값은 유지
      if (merged.thumbSize === 84) merged.thumbSize = 128;
      // 아이콘 3배 확대(현 차수)에 맞춰 팔레트 폭 승격 — 구 기본 100/138 저장분만
      if (merged.paletteW === 100 || merged.paletteW === 138) merged.paletteW = 200;
      if (merged.dockW === 250) merged.dockW = 340;  // 판독 도크 에디터화(26차)에 맞춰 확대
      setPrefs(merged);
      // 2D 행잉 — 모달리티별 Series 분할(setLayout) + Image 분할(페인 il). 구 형식(문자열=Series만) 호환.
      // 뷰어별(sv/ty) 설정 우선, 없으면 구 공통값(hanging2d) 폴백(하위호환).
      // MG(mammo)는 전용 2×2 4-view 행잉이 우선(결정적) — 2D 행잉 설정 무시(경합·타일 분할 방지).
      const vk = skin === "saint" ? "sv" : "ty";
      const perVMap = v.hanging2d_by_viewer?.[vk] ?? {};
      const commonMap = merged.hanging2d ?? {};
      const pickHang = (m: string) => perVMap[m] ?? commonMap[m];
      const hv = detail.modality === "MG" ? undefined : pickHang(detail.modality);
      const sKey = typeof hv === "string" ? hv : hv?.s;
      const iKey = typeof hv === "string" ? undefined : hv?.i;
      if (sKey && LAYOUTS[sKey]) setLayout(sKey as keyof typeof LAYOUTS);
      const ig = iKey && LAYOUTS[iKey] ? { r: LAYOUTS[iKey].rows, c: LAYOUTS[iKey].cols } : null;
      hang2dImgRef.current = ig && (ig.r > 1 || ig.c > 1) ? ig : null;   // 페인 생성(시리즈 로드)에서 사용
      if (ig) {
        setImgLay(ig);
        // 이미 생성된 페인에도 즉시 적용(prefs 로드가 시리즈 로드보다 늦은 경우)
        setPanes((prev) => Object.fromEntries(Object.entries(prev).map(([k, pp]) => [k, { ...pp, il: ig }])));
      }
      // TY 팔레트·오버레이 개인화 키 소비 (viewer.prefs 통짜 — 계정 로밍)
      const t = r.value as {
        ty_tool_size?: number; ty_tool_labels?: boolean; ty_icon_3d?: boolean; ty_quick_row?: boolean;
        ty_usage_rec?: boolean; ty_usage?: Record<string, number>;
        ty_overlay_font?: number; ty_overlay_visible?: boolean;
        ty_sel_color?: string; ty_cine_sec?: number;
      };
      // 구 기본값(17) 저장분은 새 3배 기본(51)으로 승격 — 직접 키운 값은 유지
      if (t.ty_tool_size && t.ty_tool_size !== 17) setTySize(t.ty_tool_size);
      if (t.ty_tool_labels !== undefined) setTyLabels(t.ty_tool_labels);
      if (t.ty_icon_3d !== undefined) setTyIcon3d(t.ty_icon_3d);
      if (t.ty_quick_row !== undefined) setTyQuickRow(t.ty_quick_row);
      if ((t as { ty_tool_cols?: number }).ty_tool_cols) setTyToolCols((t as { ty_tool_cols?: number }).ty_tool_cols!);
      if (t.ty_usage_rec !== undefined) setTyUsageRec(t.ty_usage_rec);
      if (t.ty_usage) { tyUsageRef.current = t.ty_usage; setTyUsage(t.ty_usage); }
      if (t.ty_overlay_font) setTyOvFont(t.ty_overlay_font);
      if (t.ty_overlay_visible !== undefined) setOverlayOn(t.ty_overlay_visible);
      if (t.ty_sel_color) setTySelColor(t.ty_sel_color);
      if (t.ty_cine_sec) setTyCineSec(Math.min(10, Math.max(0.05, t.ty_cine_sec)));
    }).catch(() => {});
    // HP: 장비×부위×Projection 매칭 — 첫 일치 규칙 자동 적용 (hanging2d보다 우선)
    api.getSetting("viewer.hp").then((r) => {
      const rules = ((r.value as { rules?: HpRule[] }).rules) ?? [];
      setHpRules(rules);
      const up = (s: string) => (s || "").toUpperCase();
      const m = rules.find((x) =>
        (!x.modality || x.modality === detail.modality) &&
        (!x.body_part || up(detail.body_part).includes(up(x.body_part))) &&
        (!x.projection || up(detail.study_desc).includes(up(x.projection))));
      if (m && m.use_on_exam_open !== false) applyHp(m);   // 'Exam 열 때 HP 사용' 꺼진 규칙은 자동적용 제외(수동 메뉴로 적용)
    }).catch(() => {});
  }, [detail.modality, detail.body_part, detail.study_desc, applyHp]);

  /* 시리즈 트리 + 리포트 로드 */
  useEffect(() => {
    // Exam 탭 영속 복원: 기존 탭(좌측) + 새로 연 검사(우측). #id로 동일 라벨 검사 구분
    const main = {
      id: detail.id, uid: detail.study_uid,
      label: `${detail.modality} ${detail.body_part || detail.patient_name} ${detail.study_date} #${detail.id}`,
    };
    setOpenTabs([...loadPersistedTabs().filter((t) => t.id !== detail.id), main]);
    postStudySync(detail.id, "viewer");  // Worklist·Reading 연동
    // TY-3(1): 검사 전환 — 작업 히스토리 재시작 (초기 스냅샷은 로드 완료 후)
    histRef.current = [];
    histIdx.current = -1;
    setHistTick((t) => t + 1);
    Promise.all([
      api.seriesTree(detail.id),
      api.presentation(detail.id).catch(() => ({ series: {} as Record<string, import("../api").PState> })),
    ]).then(([r, ps]) => {
      pstateRef.current = { ...pstateRef.current, ...(ps.series || {}) };   // 저장된 표시상태(W/L·방향·필터·셔터)
      let imgSeries = r.series.filter((s) => !["SR", "KO", "PR", "SEG"].includes(s.modality));
      // ⑤ Key Image View: 키 이미지 SOP만 남긴다 (빈 시리즈 제거)
      if (keySops?.length) {
        const keep = new Set(keySops);
        imgSeries = imgSeries
          .map((s) => ({ ...s, instances: s.instances.filter((i) => keep.has(i.sop_uid)) }))
          .filter((s) => s.instances.length > 0);
        setStatus(`Key Image View — 키 이미지 ${keySops.length}장만 표시`);
      }
      setSeries(imgSeries);
      // Mammo(MG) 전용 행잉 — 표준 2×2 [R CC, L CC, R MLO, L MLO] + 오버레이 텍스트 제거 (전 뷰어 공통 규칙)
      const mammo = detail.modality === "MG";
      const ma = mammo ? mammoAssign(imgSeries) : null;
      const mammoSeries = ma && ma.some(Boolean) ? ma : null;   // 매칭 0이면 순서대로 폴백(빈 페인 방지)
      if (mammo) { setLayout("2x2"); setOverlayOn(false); }
      setSelSeries(null);   // 처음 열 때 썸네일 이미지 목록은 모두 접힘 — 더블클릭으로만 펼침
      if (imgSeries[0]) {
        // ② AI 추천 W/L 자동 적용(수동 변경 가능). 합성/비보정 데이터(PixelSpacing 없음)는
        //    HU 윈도우가 화면을 날리므로 적용하지 않는다(서버 VOI 기본 유지)
        const mod = detail.modality || imgSeries[0].modality;
        const bp = detail.body_part || detail.study_desc;
        const realData = !!imgSeries[0].instances[0]?.pixel_spacing?.length;
        const ai = realData ? autoWL(mod, bp) : null;
        setPanes((prev) => {
          const next = { ...prev };
          PANE_IDS.forEach((pid, i) => {
            // 시리즈가 레이아웃보다 적으면 남는 페인은 빈 칸 유지 — 마지막 시리즈 반복 채움 금지(In Viewer 규칙)
            // Mammo 는 표준 4-view 배치, 그 외는 순서대로
            const s = mammoSeries ? (mammoSeries[i] ?? null) : imgSeries[i];
            next[pid] = s
              ? applyPState({ ...initPane(detail.study_uid), series: s,
                  index: Math.floor(s.instances.length / 2), wl: ai?.q ?? "",
                  il: hang2dImgRef.current ?? undefined })   // 모달리티 기본 Image 분할
              : initPane(detail.study_uid);
          });
          return next;
        });
        if (ai) setStatus(`AI 추천 W/L 적용: ${ai.label} (2D 섹션에서 변경 가능)`);
      }
      // ② Add View / ③ Stack View — 기본 로드 완료 후 추가 검사 로드 (UBPACS-Z Study Open)
      if (addDetail) void loadPrior(addDetail.id);
      if (stackDetail) void loadStack(stackDetail.id);
      // Study With Open (p.13): Related Study List 검사들을 한번에 같이 오픈
      if (withOpen?.ids.length) {
        if (withOpen.mode === "add") void loadAddMany(withOpen.ids);
        else void loadStackMany(withOpen.ids);
      }
      window.setTimeout(pushHist, 300);   // TY-3(1): 로드 완료 후 초기 스냅샷
    }).catch(() => setStatus("시리즈 조회 실패"));
    // 리포트/상용구/판독설정 로드는 ReportDock 내부로 이동 (detail.id 변경 시 자체 재로드)
    api.annotations(detail.id).then((r) => {
      setAnnos(r.items);
      savedAnnosRef.current = new Set(r.items.map((a) => JSON.stringify(a)));  // 서버 주석 = 저장 기준선
      schedHist();
    }).catch(() => {});
    return () => {
      // 검사 전환/언마운트 — 전역 시네 정지 시 ref·표시 상태까지 재정렬(재생 버튼 잔상 방지)
      if (cineRef.current) { window.clearInterval(cineRef.current); cineRef.current = null; }
      setCine(false);
      Object.values(observers.current).forEach((o) => o.disconnect());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id, detail.study_uid, addDetail?.id, stackDetail?.id, keySops?.length]);

  // 키이미지 마크 로드 — 열린 검사(openTabs) 전체의 key_images SOP 집합(합집합). 열림 변화 시 갱신
  useEffect(() => {
    const ids = [...new Set(openTabs.map((t) => t.id))];
    if (!ids.length) return;
    let alive = true;
    Promise.all(ids.map((id) => api.instances(id).then((r) => (r.key_images ?? []).map((k) => k.sop_uid)).catch(() => [])))
      .then((lists) => { if (alive) setKeyMarks(new Set(lists.flat())); });
    return () => { alive = false; };
  }, [openTabs]);

  /* 시리즈 트리 캐시 — 비교/탭 전환 공용 */
  const getTree = async (examId: number) => {
    let tree = priorTrees[examId];
    if (!tree) {
      const r = await api.seriesTree(examId);
      tree = { uid: r.study_uid, series: r.series.filter((s) => !["SR", "KO", "PR", "SEG"].includes(s.modality)) };
      setPriorTrees((p) => ({ ...p, [examId]: tree }));
    }
    ensureMeta(examId, tree.uid);  // 오버레이용 환자 메타 확보(1회)
    return tree;
  };

  /* 시리즈 → 소속 검사 uid (썸네일/시리즈 메뉴 클릭 시 검사 오귀속 방지) */
  const uidOfSeries = (su: string): string => {
    for (const t of Object.values(priorTrees)) if (t.series.some((x) => x.series_uid === su)) return t.uid;
    return detail.study_uid;
  };

  /* 오픈 탭 — 추가 검사가 열릴 때마다 좌→우로 탭이 쌓인다 */
  const tabLabel = (id: number): string => {
    const rel = detail.related_exams.find((x) => x.id === id);
    if (rel) return `${rel.modality} ${rel.study_date}`;
    if (addDetail?.id === id) return `${addDetail.modality} ${addDetail.study_date}`;
    if (stackDetail?.id === id) return `${stackDetail.modality} ${stackDetail.study_date}`;
    return `검사 #${id}`;
  };
  const addOpenTab = (id: number, uid: string, label?: string) =>
    setOpenTabs((prev) => prev.some((t) => t.id === id) ? prev : [...prev, { id, uid, label: label ?? tabLabel(id) }]);

  /* Opened 메뉴 부제 — modality · 검사일 */
  const tabSub = (id: number): string | undefined => {
    if (id === detail.id) return `${detail.modality} · ${detail.study_date}`;
    const rel = detail.related_exams.find((x) => x.id === id);
    if (rel) return `${rel.modality} · ${rel.study_date}`;
    if (addDetail?.id === id) return `${addDetail.modality} · ${addDetail.study_date}`;
    if (stackDetail?.id === id) return `${stackDetail.modality} · ${stackDetail.study_date}`;
    return undefined;
  };

  /* 탭 클릭: 해당 검사를 활성 페인에 표시 (UBPACS Opened Study List 전환) */
  /* 전 페인 재행잉 — 탭 전환으로 다른 환자 검사를 볼 때 화면 전체를 그 검사로 교체(환자 혼합 방지).
     시리즈가 레이아웃보다 적으면 빈 페인 유지(In Viewer 규칙). */
  const hangAll = (uid: string, list: SeriesNode[]) => {
    const vis = PANE_IDS.slice(0, LAYOUTS[layout].count);
    setPanes((prev) => {
      const next = { ...prev };
      for (const pid2 of PANE_IDS) {
        const i = vis.indexOf(pid2);
        const s = i >= 0 ? list[i] : undefined;
        next[pid2] = s
          ? { ...initPane(uid), series: s, index: Math.floor(s.instances.length / 2) }
          : initPane(uid);
      }
      return next;
    });
    setSelPanes(new Set());
  };

  const loadIntoActive = async (id: number) => {
    const isMain = id === detail.id;
    try {
      const tree = isMain ? { uid: detail.study_uid, series } : await getTree(id);
      if (!tree.series[0]) { setStatus("이 검사에 표시할 영상 시리즈가 없습니다"); return; }
      // 대상 검사의 환자 확인(메타 미로드 시 1회 조회) — 탭 전환은 암묵 동선이므로 환자 혼합 금지
      let targetKey = isMain ? detail.patient_key : studyMeta[tree.uid]?.patient_key;
      if (!targetKey && !isMain) {
        try {
          const d = await api.study(id);
          targetKey = d.patient_key;
          setStudyMeta((m) => ({ ...m, [tree.uid]: metaOf(d) }));
        } catch { /* 메타 실패 시 아래 혼합 판정은 보수적으로 통과 */ }
      }
      const vis = PANE_IDS.slice(0, LAYOUTS[layout].count);
      const mixed = !!targetKey && vis.some((pid2) => {
        const u = panes[pid2].studyUid || detail.study_uid;
        const k = (studyMeta[u] ?? (u === detail.study_uid ? detail : undefined))?.patient_key;
        return !!k && k !== targetKey;
      });
      if (mixed) {
        // 다른 환자로의 전환 — 활성 페인만 바꾸면 이전 환자 영상이 격자에 남아 섞이므로 전체 재행잉
        hangAll(tree.uid, tree.series);
        setStatus("검사 전환 — 다른 환자이므로 화면 전체를 이 검사로 표시했습니다 (혼합 비교는 ⇄ Compare/+Add 사용)");
        return;
      }
      const s = tree.series[0];
      patch(activePane, { ...initPane(tree.uid), series: s, index: Math.floor(s.instances.length / 2) });
    } catch { setStatus("검사 전환 실패"); }
  };
  loadIntoActiveRef.current = loadIntoActive;  // 동기 리스너에서 최신 클로저 사용

  /* 탭 닫기: 목록에서 제거 + 해당 검사를 보이던 페인은 주 검사로 복귀 */
  const closeTab = (id: number) => {
    const tab = openTabs.find((t) => t.id === id);
    setOpenTabs((prev) => prev.filter((t) => t.id !== id));
    if (!tab) return;
    setPanes((prev) => {
      const next = { ...prev };
      const main = series[0];
      for (const pid of PANE_IDS) {
        if (next[pid].studyUid === tab.uid && main) {
          next[pid] = { ...initPane(detail.study_uid), series: main, index: Math.floor(main.instances.length / 2) };
        }
      }
      return next;
    });
  };

  /* 과거검사 비교 로드(요청 5): related exam 클릭 → 활성 페인에 */
  const loadPrior = async (examId: number) => {
    const tree = await getTree(examId);
    const s = tree.series[0];
    if (!s) return;
    addOpenTab(examId, tree.uid);
    // ④ 변화강조 비교 동선: 1x1이면 자동 1x2 전환, 현재=좌(p0)·과거=우(p1), Link 동기 on
    if (LAYOUTS[layout].count === 1) {
      setLayout("1x2");
      patch("p1", { ...initPane(tree.uid), series: s, index: Math.floor(s.instances.length / 2) });
      setActivePane("p1");
    } else {
      patch(activePane, { ...initPane(tree.uid), series: s, index: Math.floor(s.instances.length / 2) });
    }
    setXmode("sync_other");
    setStatus("비교 모드: 과거검사 로드 + 동기 스크롤 ON (SyncOther)");
  };

  /* ③ Stack View (UBPACS-Z): 기존 시리즈는 썸네일에 유지 + 선택 검사를 활성 페인에 중첩 로드 */
  const loadStack = async (examId: number) => {
    try {
      const r = await getTree(examId);
      const imgSeries = r.series.map((s) => ({ ...s, series_desc: `[중첩] ${s.series_desc || s.modality}` }));
      if (!imgSeries.length) { setStatus("Stack View: 추가 검사에 영상 시리즈 없음"); return; }
      addOpenTab(examId, r.uid);
      setSeries((prev) => [...prev, ...imgSeries.filter((s) => !prev.some((p) => p.series_uid === s.series_uid))]);
      const s = imgSeries[0];
      patch(activePane, {
        ...initPane(r.uid), series: s, index: Math.floor(s.instances.length / 2),
      });
      setStatus("Stack View: 선택 검사 중첩 — 기존 영상은 썸네일·다른 페인에 유지");
    } catch { setStatus("Stack View 로드 실패"); }
  };

  /* Refresh Exam — 활성 페인의 검사 시리즈를 서버에서 재조회해 갱신 (In Viewer loadSeries 이식) */
  const refreshExam = async () => {
    const uid = panes[activePane]?.studyUid || detail.study_uid;
    const id = openTabsRef.current.find((t) => t.uid === uid)?.id ?? detail.id;
    try {
      const r = await api.seriesTree(id);
      const imgSeries = r.series.filter((s) => !["SR", "KO", "PR", "SEG"].includes(s.modality));
      if (id === detail.id) setSeries(imgSeries);
      else setPriorTrees((prev) => ({ ...prev, [id]: { uid: r.study_uid, series: imgSeries } }));
      // 같은 검사를 보이는 페인들의 시리즈 객체를 새 데이터로 교체(인덱스 범위 보정)
      setPanes((prev) => Object.fromEntries(Object.entries(prev).map(([k, p]) => {
        if (p.studyUid !== uid || !p.series) return [k, p];
        const ns = imgSeries.find((s) => s.series_uid === p.series!.series_uid);
        return [k, ns ? { ...p, series: ns, index: Math.min(p.index, ns.instances.length - 1) } : p];
      })));
      // Rfsh 라이프사이클 — 기능 툴 전부 Off + 미저장 작업 삭제(저장 기준선 복원). ◀ 이전으로 저장 전까지 복원 가능
      setTool(null); setDraft(null); setSelAnno(null); setSelAnnos(null);
      const unsaved = annosRef.current.filter((a) => !isSavedAnno(a)).length;
      if (unsaved > 0) {
        setAnnos((prev) => prev.filter((a) => isSavedAnno(a)));
        schedHist();
      }
      setStatus(`Refresh Exam — 시리즈 재조회${unsaved ? ` · 미저장 작업 ${unsaved}건 삭제(◀ 이전으로 복원)` : ""}`);
    } catch { setStatus("Refresh Exam 실패"); }
  };

  refreshExamRef.current = refreshExam;   // 휴대폰 촬영 폴링에서 최신 참조

  /* Combine all — 현재 검사의 (영상)시리즈 전체를 하나의 논리적 시리즈로 결합해 활성 페인에 표시(연속 스크롤).
     INFINITT 'Combine all' 등가: 서버 병합이 아니라 판독 화면 표시 결합. (레이아웃 그리드는 상단 레이아웃 콤보 사용) */
  // 결합 전 페인 상태 스냅샷 → Combine 재클릭(토글) 시 해제·원복
  const preCombineRef = useRef<Record<string, { series: SeriesNode | null; index: number; studyUid: string }>>({});
  const isCombined = (p?: PaneState): boolean => !!p?.series?.series_uid.startsWith("combined:");
  const snapCombine = (pid: string) => {
    if (!preCombineRef.current[pid] && panes[pid]) {
      const p = panes[pid];
      preCombineRef.current[pid] = { series: p.series, index: p.index, studyUid: p.studyUid };
    }
  };
  const uncombine = (pid: string) => {
    const snap = preCombineRef.current[pid];
    delete preCombineRef.current[pid];
    if (snap) patch(pid, { series: snap.series, index: snap.index, studyUid: snap.studyUid });
    else patch(pid, { series: series[0] ?? null, index: 0, studyUid: detail.study_uid });
    setActivePane(pid);
    setStatus("Combine 해제 — 원래 시리즈로 복원");
  };
  // 툴바 Combine — 토글: 활성 페인이 결합 상태면 해제(원복), 아니면 검사 전체 결합
  const combineSeries = () => { if (isCombined(panes[activePane])) uncombine(activePane); else combineAllInto(activePane); };
  const combineAllInto = (pid: string) => {
    const src = series.filter((s) => !["SR", "KO", "PR", "SEG"].includes(s.modality) && s.instances.length > 0);
    if (!src.length) { setStatus("Combine 취소 — 결합할 영상 시리즈가 없습니다"); return; }
    if (src.length === 1) { setStatus("Combine 취소 — 시리즈가 1개뿐입니다(결합할 대상 없음)"); return; }
    snapCombine(pid);
    const merged = buildCombined(
      [...src].sort((a, b) => a.series_number - b.series_number).map((s) => ({ s, studyUid: detail.study_uid })));
    patch(pid, { series: merged, index: 0, studyUid: detail.study_uid });
    setActivePane(pid);
    setStatus(`Combine all — ${src.length}개 시리즈 ${merged.instances.length}장을 한 시리즈처럼 결합(연속 스크롤 · 다시 누르면 해제)`);
  };
  // Combine(추가) — 드롭/선택한 한 시리즈를 대상 페인의 현재 시리즈에 이어붙임(이미 결합본이면 계속 누적).
  const combineInto = (pid: string, seriesUid: string) => {
    const dropped = thumbSeries.find((x) => x.series_uid === seriesUid) ?? series.find((x) => x.series_uid === seriesUid);
    if (!dropped) { setStatus("Combine 실패 — 시리즈를 찾을 수 없습니다"); return; }
    if (["SR", "KO", "PR", "SEG"].includes(dropped.modality)) { setStatus("Combine 불가 — 비영상 시리즈(SR/KO/PR/SEG)"); return; }
    snapCombine(pid);
    const base = panes[pid]?.series ?? null;
    const merged = buildCombined(
      base ? [{ s: base, studyUid: panes[pid].studyUid }, { s: dropped, studyUid: uidOfSeries(dropped.series_uid) }]
           : [{ s: dropped, studyUid: uidOfSeries(dropped.series_uid) }]);
    patch(pid, { series: merged, index: 0 });
    setActivePane(pid);
    setStatus(`Combine — S${dropped.series_number} ${dropped.instances.length}장 추가 · 총 ${merged.instances.length}장(연속 스크롤)`);
  };

  /* Study With Open — ADD: Related 최대 3건을 p1~p3 분할 오픈 / STACK: 순차 중첩 */
  const loadAddMany = async (ids: number[]) => {
    const take = ids.slice(0, 3);
    setLayout(take.length >= 2 ? "2x2" : "1x2");
    for (let i = 0; i < take.length; i++) {
      try {
        const tree = await getTree(take[i]);
        const s = tree.series[0];
        if (!s) continue;
        addOpenTab(take[i], tree.uid);
        patch(PANE_IDS[i + 1], { ...initPane(tree.uid), series: s, index: Math.floor(s.instances.length / 2) });
      } catch { /* 개별 실패 무시 */ }
    }
    setXmode("sync_other");
    setStatus(`Study With Open (ADD VIEW): Related ${take.length}건 함께 오픈`);
  };
  const loadStackMany = async (ids: number[]) => {
    for (const id of ids) await loadStack(id);
    setStatus(`Study With Open (STACK VIEW): Related ${ids.length}건 중첩 오픈`);
  };

  const step = useCallback((pid: string, dir: number) => {
    setSelAnno(null); setSelAnnos(null); setMarquee(null);   // §B: 이미지 전환 시 편집·마퀴 선택 해제
    setPanes((prev) => {
      const next = { ...prev };
      const stride = Math.max(1, (prev[pid]?.il?.r ?? 1) * (prev[pid]?.il?.c ?? 1));  // 페인별 Image Layout 페이지 단위 이동
      // 무한 순환 — 끝 다음은 처음, 처음 이전은 끝(스크롤·화살표·CINE 공통). 양방향 wrap.
      const clampI = (len: number, i: number) => (len > 0 ? ((i % len) + len) % len : 0);
      // 1) 마스터 이동 — 빈 페인이면 마스터는 안 움직이되 동기 타깃은 계속 스크롤(OLD 인덱스 동작 보존)
      const mp = prev[pid];
      // 1장짜리(스크롤 불가) 페인에서의 스크롤은 전체 no-op — 자기는 못 움직이는데 동기 타깃(다른 검사)만
      // 움직여 "선택은 Chest인데 MRI 가 스크롤" 되는 혼란 방지. (빈 페인은 기존대로 동기 타깃 스크롤 유지)
      if (mp?.series && mp.series.instances.length <= 1) return prev;
      let mIdx = mp?.index ?? 0;
      let mInst: InstanceNode | undefined;
      let mSeriesUid: string | undefined;
      if (mp?.series) {
        mIdx = clampI(mp.series.instances.length, mp.index + dir * stride);
        next[pid] = { ...mp, index: mIdx };
        mInst = mp.series.instances[mIdx];
        mSeriesUid = mp.series.series_uid;
      }
      // 2) 동기 타깃(마스터 제외): auto_sync=같은 검사, sync_other=전체(과거검사 포함), 멀티선택 연동
      const vis = PANE_IDS.slice(0, LAYOUTS[layout].count);
      const targets = new Set<string>();
      if (xmode === "sync_other") vis.forEach((v) => { if (v !== pid) targets.add(v); });
      else if (xmode === "auto_sync") vis.forEach((v) => { if (v !== pid && prev[v]?.studyUid === prev[pid]?.studyUid) targets.add(v); });
      const sel = selPanesRef.current;
      if (sel.size > 1 && sel.has(pid)) sel.forEach((v) => { if (v !== pid) targets.add(v); });
      // 3) 타깃 동기 — 듀얼모드: Spatial(DICOM 좌표 해부학적 최근접) 우선, 좌표 없으면 Index(1:1) 폴백
      targets.forEach((id) => {
        const tp = next[id];
        if (!tp?.series) return;
        let ti: number | null = null;
        if (spatialSyncRef.current && mInst) {
          ti = tp.series.series_uid === mSeriesUid   // 같은 시리즈면 동일 위치(정확·경량)
            ? mIdx : nearestSliceIndex(mInst, tp.series);
        }
        next[id] = { ...tp, index: ti != null ? ti : clampI(tp.series.instances.length, tp.index + dir * stride) };
      });
      return next;
    });
  }, [xmode, layout]);

  // ── 인접 슬라이스 프리페치 — 인덱스/시리즈가 바뀔 때만 진행 방향 앞 8·뒤 3장 선제 로드.
  //    (W/L·zoom 등 다른 페인 상태 변경에는 발동하지 않음 — 드래그 중 요청 폭주 방지) ──
  const lastIdxRef = useRef<Record<string, { idx: number; uid: string }>>({});
  useEffect(() => {
    if (isWasmPipeline()) return;   // WASM 모드는 자체 픽셀 캐시 사용 — 서버 rendered 이중 다운로드 방지
    const vis = PANE_IDS.slice(0, LAYOUTS[layout].count);
    for (const pid of vis) {
      const p = panes[pid];
      if (!p?.series) continue;
      const len = p.series.instances.length;
      const prev = lastIdxRef.current[pid];
      const changed = !prev || prev.idx !== p.index || prev.uid !== p.series.series_uid;
      if (!changed) continue;
      const dir = !prev || prev.uid !== p.series.series_uid ? 1 : (p.index - prev.idx >= 0 ? 1 : -1);
      lastIdxRef.current[pid] = { idx: p.index, uid: p.series.series_uid };
      prefetchAround((i) => renderedUrlAt(p, i), p.index, len, dir);
    }
  }, [panes, layout]);
  // 활성 시리즈 전체 워밍 — 초기 페인트 후 백그라운드 예열(시리즈·W/L 변경 시 토큰으로 이전 워밍 중단).
  // wl 을 의존성에 포함 — W/L 드래그 중엔 1.2s 지연+토큰 취소가 디바운스 역할(구 window URL 낭비 방지).
  const activeP = panes[activePane];
  const activeSeriesUid = activeP?.series?.series_uid;
  const activeWl = activeP?.wl ?? "";
  useEffect(() => {
    if (isWasmPipeline()) return;   // WASM 모드 — 서버 rendered 워밍은 이중 다운로드라 제외
    const p = panesRef.current[activePane];
    if (!p?.series) return;
    // 대형 매트릭스(DX/MG 등)는 장당 수 MB — 시리즈 전체 워밍은 메모리·대역폭상 제외(±프리페치만)
    const i0 = p.series.instances[0];
    if (((i0?.rows ?? 0) * (i0?.cols ?? 0)) > 2_000_000) return;
    warmSeries((i) => renderedUrlAt(p, i), p.series.instances.length, p.index);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSeriesUid, activePane, activeWl]);
  useEffect(() => () => cancelWarm(), []);   // 뷰어 닫기 — 워밍 중단

  // W/L 드래그 스로틀 누적기 — 델타 누적 후 80ms 간격 반영(최종값 동일, 요청 수만 감소)
  const wlThrottleRef = useRef<{ dx: number; dy: number; tg: string[] | null; timer: number }>(
    { dx: 0, dy: 0, tg: null, timer: 0 });

  // ── 휠 rAF 코얼레싱 — 이벤트를 프레임 단위로 모아 스텝 '누적' 적용(요청은 최종 프레임 1장만).
  //    스텝 수를 보존하므로 프리스핀 휠·트랙패드의 주파 속도(조작감)도 기존과 동일. ──
  const wheelRaf = useRef<{ pid: string; net: number; raf: number } | null>(null);
  const wheelStep = useCallback((pid: string, dir: number) => {
    const w = wheelRaf.current;
    if (w) { w.pid = pid; w.net += dir; return; }   // 이번 프레임 예약됨 — 스텝 누적
    wheelRaf.current = {
      pid, net: dir,
      raf: requestAnimationFrame(() => {
        const cur = wheelRaf.current;
        wheelRaf.current = null;
        if (!cur || cur.net === 0) return;
        const s = Math.sign(cur.net);
        // React 18 자동 배칭 — 여러 step 이 한 번의 렌더로 합쳐져 최종 인덱스만 그린다
        for (let k = 0; k < Math.abs(cur.net); k++) step(cur.pid, s);
      }),
    };
  }, [step]);

  /* 뷰어 단축키: ←→=이미지, I=반전, R=회전, F=Fit, L=Link, 1/2/4=분할, Space=Cine, Esc=닫기 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key.toLowerCase() === "t") { tHeld.current = true; return; }  // T 홀드 시작
      if (e.key === "Delete" && tHeld.current) {  // T+Del = 오버레이 토글 (In Viewer 패리티)
        e.preventDefault();
        toggleOverlay();
        return;
      }
      // ── 사용자 단축키(설정>단축키, 계정별) — 재바인딩 가능 액션 우선 조회 ──
      if (!(e.ctrlKey || e.altKey || e.metaKey) && e.key !== "Escape" && !/^[1-9]$/.test(e.key)) {
        const kk = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        const hit = Object.entries(scKeysRef.current).find(([, v]) =>
          !!v && (v.length === 1 ? v.toLowerCase() === kk : v === e.key));
        if (hit) { e.preventDefault(); scRunRef.current(hit[0]); return; }
      }
      switch (e.key) {
        case "Escape":
          // 계층 초기화(§D): 진행중 그리기/이동/리사이즈 → 편집 선택(selAnno) → 도구 → 멀티선택 → 최대화 → 닫기.
          // annoDragRef 는 draft 유무와 무관하게 항상 취소 — move/resize(draft=null) 중 Esc 가 드래그를
          // 멈추지 못해 mouseup 에서 이동이 확정되던 문제 방지(In Esc 정합)
          annoDragRef.current = null; marqueeRef.current = null; setMarquee(null);
          if (menu) setMenu(null);
          else if (draft) setDraft(null);
          else if (selAnnos) setSelAnnos(null);
          else if (selAnno) setSelAnno(null);
          else if (tool) setTool(null);
          else if (selPanes.size) setSelPanes(new Set());  // 멀티 선택 해제 (In 동일)
          else if (maximized) setMaximized(null);   // 최대화 복원
          else requestCloseRef.current();
          break;
        case "Backspace":   // 삭제 보조키(고정) — Delete 는 재바인딩 가능(del_anno)
          e.preventDefault();
          if (selAnnos) deleteSelAnnos();
          else if (selAnno) deleteSelAnno();
          else { setAnnos((pp) => pp.slice(0, -1)); schedHist(); }
          break;
        // 숫자 1~9 = 시리즈 순번 선택(고정) — 활성 페인에 해당 시리즈 표시
        case "1": case "2": case "3": case "4": case "5": case "6": case "7": case "8": case "9":
          e.preventDefault(); seriesKeyRef.current.sel(Number(e.key) - 1); break;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "t") tHeld.current = false;  // T 홀드 해제
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePane, step, tool, draft, menu, maximized, selPanes, layout, selAnno, selAnnos]);

  /* 도구 전환(선택/해제) 시 편집 선택 정리 — 편집은 select 모드(도구 없음)에서만 유효(§D) */
  useEffect(() => { setSelAnno(null); setSelAnnos(null); setMarquee(null); }, [tool]);

  /* 마우스 상호작용 — TY-3(2): Shift=범위 선택/Ctrl=토글, 선택 밖 일반 클릭=해제 (In 이식) */
  const dragRef = useRef<{ pid: string; x: number; y: number; sx: number; sy: number; btn: number; moved: boolean; shift: boolean; acc?: number } | null>(null);
  // 주석 드래그(그리기/이동/리사이즈) — window mousemove/up 엔진이 참조(스테일 방지 ref)
  const annoDragRef = useRef<AnnoDrag | null>(null);
  // 우클릭 컨텍스트 메뉴 + 우드래그 기본 도구(초기 분석 §7: 우드래그=기본 지정 도구, 기본 W/L)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; pid: string } | null>(null);
  const [rdragTool, setRdragTool] = useState<"wl" | "zoom" | "pan">(
    () => ((localStorage.getItem("ty_rdrag") as "wl" | "zoom" | "pan") || "wl"));
  const rdragRef = useRef(rdragTool);
  rdragRef.current = rdragTool;
  const setRdrag = (t: "wl" | "zoom" | "pan") => { setRdragTool(t); try { localStorage.setItem("ty_rdrag", t); } catch { /* 저장 불가 무시 */ } };
  // 설정>단축키(계정별 viewer.prefs.shortcuts) — 우드래그 도구·Shift+우클릭 동작
  const shiftRClickRef = useRef<"zoomout" | "none">("zoomout");
  useEffect(() => {
    api.getSetting("viewer.prefs").then((r) => {
      const sc = (r.value as { shortcuts?: { rdrag?: "wl" | "zoom" | "pan"; shift_rclick?: "zoomout" | "none" } }).shortcuts;
      if (sc?.rdrag) { setRdragTool(sc.rdrag); rdragRef.current = sc.rdrag; }
      if (sc?.shift_rclick) shiftRClickRef.current = sc.shift_rclick;
      const keys = (sc as { keys?: Record<string, string> } | undefined)?.keys;
      if (keys) scKeysRef.current = { ...SC_DEFAULTS, ...keys };
      dropMenuRef.current = !!(r.value as { drop_menu?: boolean }).drop_menu;
      setWasmPipeline(!!(r.value as { wasm_pipeline?: boolean }).wasm_pipeline);
    }).catch(() => {});
  }, []);
  const onPaneMouseDown = (pid: string, e: React.MouseEvent) => {
    const vis = PANE_IDS.slice(0, LAYOUTS[layout].count);
    if (e.shiftKey) {
      const idx = vis.indexOf(pid);
      if (idx >= 0) setSelPanes(new Set(vis.slice(0, idx + 1)));   // 처음~클릭 페인 범위
    } else if (e.ctrlKey) {
      setSelPanes((s) => {
        const n = new Set(s.size ? s : [activePane]);              // 활성+클릭 페인 토글
        if (n.has(pid) && pid !== activePane) n.delete(pid); else n.add(pid);
        return n;
      });
    } else if (selPanes.size && !selPanes.has(pid)) {
      setSelPanes(new Set());   // 선택 집합 밖 일반 클릭 — 해제
    }
    setActivePane(pid);
    if (tool && e.button === 0 && !e.shiftKey && !e.ctrlKey) {
      // 2점 드래그 도구 → 러버밴드 그리기 시작 / 그 외(각도·4점·open-ended·1점) → 기존 클릭 점찍기
      if (DRAG_TOOLS.has(tool)) { startAnnoDraw(pid, e); return; }
      // 3D Cursor — 클릭 배치 + 버튼 홀드 중 이동을 연속 추적(자연스러운 드래그 탐색)
      if (tool === "cursor3d" && e.button === 0) c3DragRef.current = { pid };
      handleAnnoPoint(pid, e); return;
    }
    // select 모드(도구 없음) 좌클릭 — 주석 편집(이동/리사이즈) 히트테스트. 잡히면 편집 시작(dragRef 미설정)
    if (!tool && e.button === 0 && !e.shiftKey && !e.ctrlKey) {
      if (startAnnoEdit(pid, e)) return;
      // 미스 — Select 모드면 마퀴(녹색 점선) 다중 선택 시작(dragRef 미설정), 그 외(zoom/pan/wl)는 기존 mouseMode 드래그
      if (mouseMode === "select") { startMarquee(pid, e); return; }
    }
    if (ctxMenu) setCtxMenu(null);   // 메뉴 열려 있으면 먼저 닫음
    // 우클릭 드래그(W/L) — mousedown 전파 차단: Linkclump 류 브라우저 확장이 document 레벨에서
    // 우드래그를 가로채 빨간 링크선택 박스를 그리는 것을 방지(우리 드래그는 window 리스너라 무영향)
    if (e.button === 2) { e.preventDefault(); e.stopPropagation(); }
    dragRef.current = { pid, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, btn: e.button, moved: false, shift: e.shiftKey };
  };

  // Shift+우드래그 영역 W/L — 빨간 박스(페인 상대 px) + 진행 중 드래그 ref
  const [wlBox, setWlBox] = useState<{ pid: string; left: number; top: number; w: number; h: number } | null>(null);
  const wlRegionRef = useRef<{ pid: string; rect: DOMRect; sx: number; sy: number; cx: number; cy: number } | null>(null);

  // 3DC 홀드-드래그 추적 — pointermove 마다 rAF 스로틀로 커서 재배치, pointerup 에서 종료
  useEffect(() => {
    const mv = (e: PointerEvent) => {
      const d = c3DragRef.current;
      if (!d) return;
      // 창 밖에서 버튼을 놓아 pointerup 이 유실돼도 좌버튼 해제가 감지되면 즉시 종료
      if (!(e.buttons & 1)) { c3DragRef.current = null; return; }
      if (c3RafRef.current) return;   // rAF 스로틀(프레임당 1회)
      const { clientX, clientY } = e;
      c3RafRef.current = requestAnimationFrame(() => {
        c3RafRef.current = 0;
        const el = document.querySelector(`[data-pid="${d.pid}"]`) as HTMLElement | null;
        const p = panesRef.current[d.pid];
        const inst = p?.series?.instances[p.index];
        if (!el || !p?.series || !inst) return;
        const aspect = inst.cols && inst.rows ? inst.cols / inst.rows : 1;
        const pt = screenToImage(clientX, clientY, el.getBoundingClientRect(), p, aspect);
        if (!pt) return;   // 이미지 밖 — 유지
        completeToolRef.current("cursor3d", d.pid, { sop_uid: inst.sop_uid, series_uid: p.series.series_uid }, [pt], inst);
      });
    };
    const up = () => { c3DragRef.current = null; };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up);
                   if (c3RafRef.current) cancelAnimationFrame(c3RafRef.current); };
  }, []);

  // 우클릭 W/L 드래그 — window CAPTURE 단계에서 최우선 가로채기.
  // Linkclump 류 확장이 capture/document 어디에 리스너를 걸어도, window capture 가 가장 먼저 실행되고
  // 여기서 stopImmediatePropagation 하면 이벤트가 document/target 으로 전파되지 않아 빨간 박스가 시작되지 않는다.
  // 대신 우리의 우클릭 드래그 시작(활성 페인 지정·dragRef 세팅)을 여기서 직접 수행(React 핸들러 미도달 보완).
  useEffect(() => {
    const cap = (e: PointerEvent) => {
      if (e.button !== 2) return;
      const target = e.target as HTMLElement | null;
      const el = target?.closest?.("[data-pid]") as HTMLElement | null;
      if (!el?.dataset.pid) {
        // 컨텍스트 메뉴·Circle Menu 오버레이는 fixed 로 페인([data-pid]) 트리 밖에 렌더된다 —
        // 그 위에서 시작한 우클릭(드래그)을 여기서 막지 않으면 compat mousedown 이 생성되어
        // 확장(Linkclump 류)의 빨간 링크박스가 다시 그려진다(직전 우클릭으로 메뉴가 열린 직후가 전형).
        // ※ 한계: 좌드래그 중 우버튼 추가(chord)는 스펙상 pointerdown 이 생성되지 않아 차단 불가.
        if (target?.closest?.("[data-sv-ctxmenu],[data-sv-rshield]")) {
          e.preventDefault(); e.stopImmediatePropagation();
          setCtxMenu(null);
        }
        return;   // 그 외 페인 밖 우클릭은 관여 안 함(입력창 붙여넣기 메뉴 등 보존)
      }
      // pointerdown preventDefault → 스펙상 브라우저가 호환(compat) mousedown/mousemove/mouseup 을
      // 아예 생성하지 않음 — mousedown 을 듣는 확장(Linkclump 류)은 이벤트가 존재하지 않아 무력화.
      e.preventDefault(); e.stopImmediatePropagation();
      const pid = el.dataset.pid;
      setActivePane(pid);
      setCtxMenu(null);
      if (e.shiftKey) {
        // Shift+우드래그 — 황색 점선 박스로 영역 지정 → 놓으면 그 영역 픽셀(min/max) 기준으로 W/L 조정
        // (확장 프로그램의 빨간 링크박스와 혼동되지 않도록 자체 박스는 빨간색을 쓰지 않는다)
        wlRegionRef.current = { pid, rect: el.getBoundingClientRect(), sx: e.clientX, sy: e.clientY,
                                cx: e.clientX, cy: e.clientY };
        return;
      }
      dragRef.current = { pid, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY,
                          btn: 2, moved: false, shift: false };
    };
    const regionMove = (e: PointerEvent) => {
      const r = wlRegionRef.current;
      if (!r) return;
      r.cx = e.clientX; r.cy = e.clientY;
      setWlBox({ pid: r.pid, left: Math.min(r.sx, r.cx) - r.rect.left, top: Math.min(r.sy, r.cy) - r.rect.top,
                 w: Math.abs(r.cx - r.sx), h: Math.abs(r.cy - r.sy) });
    };
    const regionUp = () => {
      const r = wlRegionRef.current;
      if (!r) return;
      wlRegionRef.current = null;
      setWlBox(null);
      const small = Math.abs(r.cx - r.sx) < 6 && Math.abs(r.cy - r.sy) < 6;
      if (small) {   // 드래그 없는 Shift+우클릭 — 설정된 동작(기본 Zoom Out)
        if (shiftRClickRef.current !== "none")
          updMany(targetsOf(r.pid), (p) => ({ zoom: Math.max(0.2, p.zoom * 0.8) }));
        return;
      }
      const p = panesRef.current[r.pid];
      const inst = p?.series?.instances[p.index];
      if (!p?.series || !inst) return;
      const aspect = inst.cols && inst.rows ? inst.cols / inst.rows : 1;
      const a = screenToImage(Math.min(r.sx, r.cx), Math.min(r.sy, r.cy), r.rect, p, aspect);
      const b = screenToImage(Math.max(r.sx, r.cx), Math.max(r.sy, r.cy), r.rect, p, aspect);
      if (!a || !b) { setStatus("영역 W/L — 이미지 안에서 박스를 지정하세요"); return; }
      const exId = openTabsRef.current.find((t) => t.uid === p.studyUid)?.id ?? detail.id;
      void api.roiStats(exId, { sop_uid: inst.sop_uid, kind: "rect", points: [a, b] }).then((st) => {
        if (st.min == null || st.max == null) { setStatus("영역 W/L — 픽셀 통계를 얻지 못했습니다"); return; }
        const ww = Math.max(1, Math.round(st.max - st.min));
        const wc = Math.round((st.max + st.min) / 2);
        patch(r.pid, { wl: `${wc},${ww}` });
        schedHist();
        setStatus(`영역 W/L 적용 — C ${wc} / W ${ww} (박스 픽셀 ${st.min}~${st.max})`);
      }).catch(() => setStatus("영역 W/L 실패"));
    };
    window.addEventListener("pointerdown", cap, true);   // capture 단계(확장 무력화)
    window.addEventListener("pointermove", regionMove);
    window.addEventListener("pointerup", regionUp);
    return () => {
      window.removeEventListener("pointerdown", cap, true);
      window.removeEventListener("pointermove", regionMove);
      window.removeEventListener("pointerup", regionUp);
    };
  }, []);

  /* 드래그 그리기 시작 — 시작 이미지좌표 기록 + draft=[start,start] + annoDrag 세팅(dragRef 미사용) */
  const startAnnoDraw = (pid: string, e: React.MouseEvent) => {
    const p = panes[pid];
    const inst = p.series?.instances[p.index];
    if (!tool || !p.series || !inst) return;
    const aspect = inst.cols && inst.rows ? inst.cols / inst.rows : 1;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const start = screenToImage(e.clientX, e.clientY, rect, p, aspect);
    if (!start) return;
    annoDragRef.current = { type: "draw", pid, tool, sop: inst.sop_uid, series: p.series.series_uid,
                            start, cur: start, rect, aspect, inst };
    setDraft({ pid, sop_uid: inst.sop_uid, series_uid: p.series.series_uid, points: [start, start] });
  };

  /* 마퀴 시작(Select 모드 빈 공간 드래그) — 시작 이미지좌표 기록, 이후 move/up 에서 영역 내 주석 일괄 선택 */
  const startMarquee = (pid: string, e: React.MouseEvent) => {
    const p = panes[pid];
    const inst = p.series?.instances[p.index];
    if (!p.series || !inst) return;
    const aspect = inst.cols && inst.rows ? inst.cols / inst.rows : 1;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const start = screenToImage(e.clientX, e.clientY, rect, p, aspect);
    if (!start) return;
    setSelAnno(null); setSelAnnos(null);
    marqueeRef.current = { pid, rect, aspect, a: start, b: start };
    setMarquee({ a: start, b: start });
  };
  /* 마퀴 다중 선택 삭제 — selAnnosRef 의 index 를 제거(Set 필터) */
  const deleteSelAnnos = (): boolean => {
    const sel = selAnnosRef.current;
    if (!sel || !sel.length) return false;
    const drop = new Set(sel);
    setAnnos((prev) => prev.filter((_, i) => !drop.has(i)));
    setSelAnnos(null); setSelAnno(null);
    setTool(null); setDraft(null);   // 삭제 시 기능 툴 Off (◀ 이전으로 복원 가능)
    schedHist();
    setStatus(`선택한 ${sel.length}개 주석을 지웠습니다`);
    return true;
  };

  /* 편집 히트테스트 — 현재 인스턴스 주석 대상. 점 핸들 근처=resize, 본체 근처=move, 미스=선택 해제.
     반환 true 면 편집 드래그 시작(호출부가 pan/zoom/wl 진입을 건너뛴다) */
  const startAnnoEdit = (pid: string, e: React.MouseEvent): boolean => {
    const p = panes[pid];
    const inst = p.series?.instances[p.index];
    if (!p.series || !inst) return false;
    const aspect = inst.cols && inst.rows ? inst.cols / inst.rows : 1;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const cur = screenToImage(e.clientX, e.clientY, rect, p, aspect);
    if (!cur) return false;
    const cols = inst.cols || 1000, rows = inst.rows || 1000;
    const cx = cur[0] * cols, cy = cur[1] * rows;
    const diag = Math.max(cols, rows);
    const hr = diag * 0.02, br = diag * 0.015;   // 핸들 그랩 반경 / 본체 근접 반경(이미지 px)
    let hit: { type: "move" | "resize"; idx: number; ptIdx?: number } | null = null;
    // 위에 그려진 것(마지막 추가)이 우선 — 역순 탐색
    for (let i = annos.length - 1; i >= 0 && !hit; i--) {
      const a = annos[i];
      const visible = a.sop_uid === inst.sop_uid || (!a.sop_uid && p.studyUid === detail.study_uid);
      if (!visible || !a.points?.length) continue;
      // 1) 점 핸들 — 2점 이하 주석만 개별 점 resize, 다점(>2)은 본체 이동만(SPEC §B)
      for (let k = 0; k < a.points.length; k++) {
        if (Math.hypot(cx - a.points[k][0] * cols, cy - a.points[k][1] * rows) <= hr) {
          hit = a.points.length > 2 ? { type: "move", idx: i } : { type: "resize", idx: i, ptIdx: k };
          break;
        }
      }
      if (hit) break;
      // 2) 본체 — 선형은 세그먼트 거리, 면적형/원은 내부·경계
      if (annoBodyHit(a, cx, cy, cols, rows, br)) hit = { type: "move", idx: i };
    }
    if (!hit) { if (selAnno) setSelAnno(null); return false; }
    setSelAnno({ sop: annos[hit.idx].sop_uid, idx: hit.idx });
    if (hit.type === "resize") {
      annoDragRef.current = { type: "resize", pid, idx: hit.idx, ptIdx: hit.ptIdx!, rect, aspect, inst, moved: false };
    } else {
      annoDragRef.current = { type: "move", pid, idx: hit.idx, startPt: cur,
                              origPoints: annos[hit.idx].points, rect, aspect, inst, moved: false };
    }
    return true;
  };

  /* 본체 근접 판정(이미지 px) — 선형=세그먼트 거리, 면적형=bbox 내부, 원=반지름 내부/경계, 1점=근접 */
  const annoBodyHit = (a: Anno, cx: number, cy: number, cols: number, rows: number, br: number): boolean => {
    const p2 = a.points.map(([x, y]) => [x * cols, y * rows]);
    if (p2.length === 1) return Math.hypot(cx - p2[0][0], cy - p2[0][1]) <= br * 2;
    for (let i = 1; i < p2.length; i++) {
      if (segDist(cx, cy, p2[i - 1][0], p2[i - 1][1], p2[i][0], p2[i][1]) <= br) return true;
    }
    if (AREA_KINDS.has(a.kind) && p2.length >= 2) {
      // 본체(≤br)만 잡기 — bbox 내부 전체가 아니라 4변 근처 (SPEC §B '본체 근처 ≤6px', In annoHit 정합).
      // 내부 전체를 잡으면 select 모드의 pan/zoom/W-L 이 도형 내부 넓은 영역에서 막힌다.
      const x0 = Math.min(p2[0][0], p2[1][0]), x1 = Math.max(p2[0][0], p2[1][0]);
      const y0 = Math.min(p2[0][1], p2[1][1]), y1 = Math.max(p2[0][1], p2[1][1]);
      if (segDist(cx, cy, x0, y0, x1, y0) <= br || segDist(cx, cy, x1, y0, x1, y1) <= br ||
          segDist(cx, cy, x1, y1, x0, y1) <= br || segDist(cx, cy, x0, y1, x0, y0) <= br) return true;
    }
    if (a.kind === "circle" && p2.length >= 2) {
      const r = Math.hypot(p2[1][0] - p2[0][0], p2[1][1] - p2[0][1]);
      if (Math.hypot(cx - p2[0][0], cy - p2[0][1]) <= r + br) return true;
    }
    return false;
  };

  /* 선택 주석 삭제 — 삭제 후 index 재계산 무효화 위해 selAnno=null */
  const deleteSelAnno = () => {
    if (!selAnno) return;
    setAnnos((prev) => prev.filter((_, i) => i !== selAnno.idx));
    setSelAnno(null);
    setTool(null); setDraft(null);   // 삭제 시 기능 툴 Off (◀ 이전으로 복원 가능)
    schedHist();
  };

  /* 측정 도구 — 클릭 점 수집 → 완성 시 주석 생성(계측값 자동 계산)
     open-ended(spineCurve/poly/shutPoly)는 점 수 제한 없이 수집, 더블클릭(finishOpenEnded)으로 종료 */
  const handleAnnoPoint = (pid: string, e: React.MouseEvent) => {
    const p = panes[pid];
    const inst = p.series?.instances[p.index];
    if (!tool || !p.series || !inst) return;
    if (OPEN_ENDED.has(tool) && e.detail > 1) return;  // 더블클릭 2번째 mousedown 은 점 추가 안 함
    const aspect = inst.cols && inst.rows ? inst.cols / inst.rows : 1;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const pt = screenToImage(e.clientX, e.clientY, rect, p, aspect);
    if (!pt) return;
    const need = TOOL_PTS[tool] ?? 2;
    const d = draft && draft.pid === pid
      ? draft
      : { pid, sop_uid: inst.sop_uid, series_uid: p.series.series_uid, points: [] as number[][] };
    const points = [...d.points, pt];
    if (points.length < need) { setDraft({ ...d, points }); return; }
    completeTool(tool, pid, d, points, inst);
  };

  /* 주석 확정 공용 — 계측값/텍스트를 붙여 로컬 주석 목록에 추가 */
  const pushAnno = (
    d: { sop_uid: string; series_uid: string }, kind: string, points: number[][],
    m: { value: number | null; unit: string; text?: string } | null, text = "",
  ) => {
    setAnnos((prev) => [...prev, {
      series_uid: d.series_uid, sop_uid: d.sop_uid, kind, points,
      value: m?.value ?? null, unit: m?.unit ?? "", text: m?.text ?? text, source: "user",
    }]);
    schedHist();   // TY-3(1): 주석 추가 — 히스토리 기록
  };

  /* 필요 점이 모두 모인 툴의 완료 처리 — 주석/셔터/픽셀 도구 분기 (In Viewer finishTool 이식) */
  const completeTool = (
    tk: ToolKind, pid: string,
    d: { sop_uid: string; series_uid: string }, points: number[][], inst: InstanceNode,
  ) => {
    setDraft(null);
    // Calibrate 진행 중이면 length 완료를 가로채 보정 처리(주석 미생성)
    if (calibRef.current && points.length >= 2) {
      calibRef.current = false;
      applyCalibration(pid, points, inst);
      return;
    }
    const p = panes[pid];
    switch (tk) {
      // ── 셔터 3종 — 페인 시각 상태(주석 아님), Clr/Reset 으로 해제 ──
      case "shutRect": case "shutEl": case "shutPoly": {
        const kind = tk === "shutRect" ? "rect" : tk === "shutEl" ? "ellipse" : "poly";
        patch(pid, { shutter: { kind, pts: points } });
        setStatus("셔터 적용 — Clr(주석 전체 삭제) 또는 Reset 으로 해제");
        schedHist();
        return;
      }
      // ── TY-3(4): 3D Cursor — 클릭점의 3D 위치로 다른 페인 인덱스 이동 + 십자 마커 (In cursor3d 이식) ──
      case "cursor3d": {
        const vis = PANE_IDS.slice(0, LAYOUTS[layout].count);
        const g = geomOf(inst);
        const markers: Record<string, { sop: string; x: number; y: number }> = {};
        if (g) {
          // 기하 있음 — 클릭점을 3D 좌표로 → 각 페인 시리즈에서 평면 거리 최소 인스턴스로 이동
          const px = points[0][0] * (inst.cols || 1), py = points[0][1] * (inst.rows || 1);
          const P: V3 = [0, 1, 2].map((k) => g.pos[k] + px * g.cs * g.row[k] + py * g.rs * g.col[k]);
          setPanes((prev) => {
            const next = { ...prev };
            for (const id of vis) {
              const q = prev[id];
              const s = q?.series;
              if (!s) continue;
              let best = -1, bd = Infinity;
              for (let k = 0; k < s.instances.length; k++) {
                const qg = geomOf(s.instances[k]);
                if (!qg) continue;
                const nl = Math.hypot(...qg.n) || 1;
                const dist = Math.abs(vdot(qg.n, vsub(P, qg.pos))) / nl;
                if (dist < bd) { bd = dist; best = k; }
              }
              if (best < 0) continue;
              const bi = s.instances[best];
              const bg = geomOf(bi)!;
              const dv = vsub(P, bg.pos);
              markers[id] = { sop: bi.sop_uid,
                              x: vdot(dv, bg.row) / bg.cs / (bi.cols || 1),
                              y: vdot(dv, bg.col) / bg.rs / (bi.rows || 1) };
              next[id] = { ...q, index: best };
            }
            return next;
          });
        } else {
          // 기하 정보 없음 — 같은 시리즈 index 비율 동기 근사 (마커는 동일 정규화 좌표)
          const src = p.series!;
          const ratio = src.instances.length > 1 ? p.index / (src.instances.length - 1) : 0;
          setPanes((prev) => {
            const next = { ...prev };
            for (const id of vis) {
              const q = prev[id];
              const s = q?.series;
              if (!s) continue;
              const k = Math.round(ratio * (s.instances.length - 1));
              const bi = s.instances[k];
              if (!bi) continue;
              markers[id] = { sop: bi.sop_uid, x: points[0][0], y: points[0][1] };
              next[id] = { ...q, index: k };
            }
            return next;
          });
          setStatus("3D Cursor — 기하 정보 없음: index 비율 근사 동기");
        }
        setCross3d(markers);
        return;
      }
      // ── 텍스트 계열 — 입력 프롬프트 ──
      case "text": {
        const text = window.prompt("주석 텍스트") ?? "";
        if (!text) return;
        pushAnno(d, "text", points, null, text);
        return;
      }
      case "box": {
        const text = window.prompt("메모 제목");
        if (text === null) return;
        pushAnno(d, "box", points, null, text || "");
        return;
      }
      case "marking": {
        const text = window.prompt("Marking (짧은 표기, 예: ①, R, ✓)");
        if (!text) return;
        pushAnno(d, "marking", points, null, text);
        return;
      }
      case "spine": {
        // 첫 클릭에 시작 라벨 입력(예: C1/T1/L1) → 이후 클릭마다 연번 증가
        if (spineSeq.current.n === 1) {
          const base = window.prompt("시작 라벨 (예: C1, T1, L1)", "L1");
          if (!base) return;
          const m = base.match(/^([A-Za-z]+)(\d+)$/);
          spineSeq.current = m ? { base: m[1].toUpperCase(), n: Number(m[2]) } : { base: base.toUpperCase(), n: 1 };
        }
        pushAnno(d, "spine", points, null, `${spineSeq.current.base}${spineSeq.current.n}`);
        spineSeq.current.n += 1;
        return;
      }
      // ── 픽셀 도구 3종 — 렌더 8bit + W/L 역변환 근사('≈'), lib/pixelTools ──
      case "lens": {
        const url = renderedUrlAt(p, p.index);
        const cols = inst.cols || 1000, rows = inst.rows || 1000;
        if (!url) return;
        void samplePixels(url, cols, rows).then((data) => {
          if (!data) { setStatus("픽셀 샘플 실패(CORS)"); return; }
          const v = rawAt(data, points[0][0] * cols, points[0][1] * rows, p.wl);
          pushAnno(d, "lens", points, null, `≈${v.toFixed(0)}`);
        });
        return;
      }
      case "profile": {
        const url = renderedUrlAt(p, p.index);
        const cols = inst.cols || 1000, rows = inst.rows || 1000;
        if (!url) return;
        void samplePixels(url, cols, rows).then((data) => {
          if (!data) { setStatus("픽셀 샘플 실패(CORS)"); return; }
          const N = 80;
          const vals: number[] = [];
          for (let k = 0; k <= N; k++) {
            vals.push(rawAt(data,
              (points[0][0] + (points[1][0] - points[0][0]) * (k / N)) * cols,
              (points[0][1] + (points[1][1] - points[0][1]) * (k / N)) * rows, p.wl));
          }
          const px = (q: number[]) => `(${Math.round(q[0] * cols)},${Math.round(q[1] * rows)})`;
          setProfileData({ title: `Profile ≈픽셀값 ${px(points[0])}→${px(points[1])}`, vals });
        });
        return;
      }
      case "table2d": {
        const url = renderedUrlAt(p, p.index);
        const cols = inst.cols || 1000, rows = inst.rows || 1000;
        if (!url) return;
        void samplePixels(url, cols, rows).then((data) => {
          if (!data) { setStatus("픽셀 샘플 실패(CORS)"); return; }
          const x0 = Math.floor(Math.min(points[0][0], points[1][0]) * cols);
          const x1 = Math.ceil(Math.max(points[0][0], points[1][0]) * cols);
          const y0 = Math.floor(Math.min(points[0][1], points[1][1]) * rows);
          const y1 = Math.ceil(Math.max(points[0][1], points[1][1]) * rows);
          const step = Math.max(1, Math.ceil(Math.max(x1 - x0, y1 - y0) / 14));   // 최대 ~14×14
          const trows: string[][] = [];
          for (let y = y0; y <= y1; y += step) {
            const row: string[] = [];
            for (let x = x0; x <= x1; x += step) {
              row.push(x < 0 || y < 0 || x >= data.width || y >= data.height ? "-"
                : rawAt(data, x, y, p.wl).toFixed(0));
            }
            trows.push(row);
          }
          setTableData({ title: `2D Table ≈픽셀값 (${x0},${y0})~(${x1},${y1}) step ${step}`, rows: trows });
        });
        return;
      }
      // ── 계측 — measureAnno 가 값/단위/복합 라벨 계산 ──
      default: {
        const m = measureAnno(tk, points, inst);
        pushAnno(d, tk, points, m);
      }
    }
  };
  // window mousemove/up 엔진(deps [mouseMode])에서 최신 completeTool 을 호출하기 위한 ref(스테일 방지)
  const completeToolRef = useRef(completeTool);
  completeToolRef.current = completeTool;

  /* open-ended(spineCurve/poly/shutPoly) 종료 — 페인 더블클릭. 최소 점 미만이면 계속 수집 */
  const finishOpenEnded = () => {
    if (!tool || !OPEN_ENDED.has(tool) || !draft) return;
    const points = draft.points;
    const minPts = tool === "poly" ? 2 : 3;
    if (points.length < minPts) {
      setStatus(tool === "poly"
        ? "폴리라인: 2점 이상 클릭 후 더블클릭으로 종료하세요"
        : tool === "shutPoly"
          ? "다각 셔터: 3점 이상 클릭 후 더블클릭으로 종료하세요"
          : "척추 외곡: 3점 이상 클릭 후 더블클릭으로 종료하세요");
      return;
    }
    if (tool === "shutPoly") {
      patch(draft.pid, { shutter: { kind: "poly", pts: points } });
      setStatus("다각 셔터 적용 — Clr(주석 전체 삭제) 또는 Reset 으로 해제");
      setDraft(null);
      schedHist();
      return;
    }
    const p = panes[draft.pid];
    const inst = p.series?.instances.find((i) => i.sop_uid === draft.sop_uid) ?? p.series?.instances[p.index];
    const m = measureAnno(tool, points, inst);
    setAnnos((prev) => [...prev, {
      series_uid: draft.series_uid, sop_uid: draft.sop_uid, kind: tool, points,
      value: m?.value ?? null, unit: m?.unit ?? "", text: m?.text ?? "", source: "user",
    }]);
    setDraft(null);
    schedHist();   // TY-3(1): open-ended 주석 완료 — 히스토리 기록
  };

  /* S2 자동계측 CTR — AI 초안 라벨 필수 */
  const doCtr = async () => {
    setStatus("AI CTR 계측 중…");
    try {
      const r = await api.ctr(detail.id);
      const a = await api.annotations(detail.id);
      setAnnos((prev) => [...prev.filter((x) => x.kind !== "ctr"), ...a.items.filter((x) => x.kind === "ctr")]);
      schedHist();
      setStatus(r.verified && r.ctr != null
        ? `AI CTR ${r.ctr} · 신뢰도 ${(r.confidence * 100).toFixed(0)}% (초안 — 확정 아님)`
        : `CTR 검증 실패: ${r.verify_note || r.note}`);
    } catch (e) { setStatus(e instanceof Error ? e.message : "CTR 실패"); }
  };

  // ── 저장된 표시상태(pstate: 적용 툴 W/L·방향·필터·셔터) — 재오픈 재현 ──
  const pstateRef = useRef<Record<string, import("../api").PState>>({});
  const applyPState = (p: PaneState): PaneState => {
    if (!p.series) return p;
    const ps = pstateRef.current[p.series.series_uid];
    if (!ps) return p;
    return {
      ...p,
      wl: ps.wl ?? p.wl, invert: ps.invert ?? p.invert, flipH: ps.flipH ?? p.flipH,
      flipV: ps.flipV ?? p.flipV, rot: ps.rot ?? p.rot,
      fx: (ps.fx ?? p.fx) as PaneState["fx"],
      shutter: ps.shutter ?? p.shutter,   // TY 셔터 좌표는 이미 정규화(0~1)
    };
  };
  const saveAnnos = async () => {
    try {
      // Combine 결합본 위에 그린 주석은 series_uid 가 'combined:' 합성값 → sop 로 원본 시리즈 UID 재해석(저장 정합)
      const sopToSeries = new Map<string, string>();
      for (const p of Object.values(panes)) {
        if (!p.series) continue;
        for (const i of p.series.instances) sopToSeries.set(i.sop_uid, i.series_uid ?? p.series.series_uid);
      }
      const fixed = annos.map((a) => {
        const su = a.sop_uid ? sopToSeries.get(a.sop_uid) : undefined;
        return su && su !== a.series_uid ? { ...a, series_uid: su } : a;
      });
      await api.saveAnnotations(detail.id, fixed);
      // 표시상태 저장 — 페인들의 검사별 시리즈 pstate 를 수집(스터디 uid → openTabs examId 매핑)
      const pstateByExam = new Map<number, Record<string, import("../api").PState>>();
      for (const p of Object.values(panes)) {
        if (!p.series) continue;
        const exId = openTabsRef.current.find((t) => t.uid === p.studyUid)?.id ?? detail.id;
        if (!pstateByExam.has(exId)) pstateByExam.set(exId, {});
        pstateByExam.get(exId)![p.series.series_uid] = {
          wl: p.wl || undefined, invert: p.invert || undefined, flipH: p.flipH || undefined,
          flipV: p.flipV || undefined, rot: p.rot || undefined, fx: p.fx || undefined,
          shutter: p.shutter,
        };
      }
      await Promise.all([...pstateByExam].map(([id, s]) => api.savePresentation(id, s).catch(() => {})));
      // 저장 시점 = 새 기준선 — 이후 툴 Off/Rfsh 에도 이 상태는 보존(과거 상태로 되돌려 재저장하면 그때가 새 기준선)
      savedAnnosRef.current = new Set(annos.map((a) => JSON.stringify(a)));
      setStatus(`주석 ${annos.length}건 + 표시상태 저장됨 (서버) — 재오픈 시 재현`);
    } catch { setStatus("주석 저장 실패"); }
  };
  // 툴 선택 — 셔터 툴 재클릭 시 적용된 셔터 제거(작업 취소·삭제), 그 외 토글 선택 (In Viewer 동일)
  const pickTool = (tk: ToolKind) => {
    if ((tk === "shutRect" || tk === "shutEl" || tk === "shutPoly") && panes[activePane]?.shutter) {
      patch(activePane, { shutter: null });
      setTool(null); setDraft(null);
      setStatus("셔터 해제 — 적용된 작업이 제거되었습니다");
      schedHist();
      return;
    }
    if (tool === tk) {
      // 툴 Off — 이 툴로 작업한 '미저장' 주석 삭제(저장분은 유지). ◀ 이전 버튼으로 저장 전까지 복원 가능
      const dropped = annosRef.current.filter((a) => a.kind === tk && !isSavedAnno(a)).length;
      if (dropped > 0) {
        setAnnos((prev) => prev.filter((a) => a.kind !== tk || isSavedAnno(a)));
        schedHist();
        setStatus(`${tk} Off — 미저장 작업 ${dropped}건 삭제 (◀ 이전으로 복원, Save 시 보존)`);
      }
      setTool(null); setDraft(null);
      return;
    }
    setTool(tk);
    setDraft(null);
  };

  /* GSPS 내보내기 — 주석 + 현재 W/L을 표준 Presentation State로 */
  const doGsps = async () => {
    const p = panes[activePane];
    const inst = p.series?.instances[p.index];
    if (!p.series || !inst) return;
    const findInst = (sop: string): { i: InstanceNode; s: SeriesNode } | null => {
      for (const s of series) {
        const i = s.instances.find((x) => x.sop_uid === sop);
        if (i) return { i, s };
      }
      return null;
    };
    const images = new Map<string, { sop_uid: string; series_uid: string; rows: number; cols: number }>();
    for (const a of annos) {
      if (!a.sop_uid) continue;
      const f = findInst(a.sop_uid);
      if (f) images.set(a.sop_uid, { sop_uid: a.sop_uid, series_uid: f.s.series_uid, rows: f.i.rows, cols: f.i.cols });
    }
    if (images.size === 0) {
      // Combine 결합본이면 p.series.series_uid 는 'combined:' 합성값 → 현재 인스턴스의 원본 시리즈 UID 사용
      images.set(inst.sop_uid, { sop_uid: inst.sop_uid, series_uid: inst.series_uid ?? p.series.series_uid, rows: inst.rows, cols: inst.cols });
    }
    const [wc, ww] = p.wl ? p.wl.split(",").map(Number) : [null, null];
    // sop 미지정 주석(CTR 등 study 단위)은 현재 이미지에 귀속해 내보냄
    const list = annos.map((a) => a.sop_uid ? a : { ...a, sop_uid: inst.sop_uid, series_uid: inst.series_uid ?? p.series!.series_uid });
    try {
      await api.sendGsps(detail.id, { images: [...images.values()], annotations: list, wc, ww });
      setStatus("GSPS 저장됨 — Orthanc 동일 검사 귀속");
    } catch (e) { setStatus(e instanceof Error ? e.message : "GSPS 실패"); }
  };
  useEffect(() => {
    const move = (e: MouseEvent) => {
      // ── 주석 드래그(그리기/이동/리사이즈) 우선 처리 — pan/zoom/wl 보다 앞 ──
      const ad = annoDragRef.current;
      if (ad) {
        const pp = panesRef.current[ad.pid];
        if (!pp) return;
        const c = screenToImage(e.clientX, e.clientY, ad.rect, pp, ad.aspect);
        if (!c) return;   // 콘텐츠 밖 — 이번 이동 무시(마지막 값 유지)
        if (ad.type === "draw") {
          ad.cur = c;
          setDraft((dr) => (dr && dr.pid === ad.pid ? { ...dr, points: [ad.start, c] } : dr));
        } else if (ad.type === "move") {
          const ndx = c[0] - ad.startPt[0], ndy = c[1] - ad.startPt[1];
          ad.moved = true;
          setAnnos((prev) => prev.map((a, i) => (i === ad.idx
            ? { ...a, points: ad.origPoints.map(([x, y]) => [clamp01(x + ndx), clamp01(y + ndy)]) }
            : a)));
        } else {   // resize — 잡은 점만 이동 + 계측값 재계산
          ad.moved = true;
          setAnnos((prev) => prev.map((a, i) => {
            if (i !== ad.idx) return a;
            const np = a.points.map((q, k) => (k === ad.ptIdx ? [clamp01(c[0]), clamp01(c[1])] : q));
            const m = measureAnno(a.kind, np, ad.inst);
            return { ...a, points: np, value: m?.value ?? a.value ?? null,
                     unit: m?.unit ?? a.unit ?? "", text: m?.text ?? a.text };
          }));
        }
        return;
      }
      // ── 마퀴(녹색 점선) 다중 선택 드래그 ──
      const mq = marqueeRef.current;
      if (mq) {
        const pp = panesRef.current[mq.pid];
        if (!pp) return;
        const c = screenToImage(e.clientX, e.clientY, mq.rect, pp, mq.aspect);
        if (!c) return;
        mq.b = c;
        setMarquee({ a: mq.a, b: c });
        return;
      }
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      d.x = e.clientX; d.y = e.clientY;
      // 이동 임계값(5px) 초과부터 드래그로 간주 — 우클릭 메뉴/우드래그 도구 구분
      if (Math.abs(e.clientX - d.sx) > 5 || Math.abs(e.clientY - d.sy) > 5) d.moved = true;
      if (!d.moved) return;
      // 좌=선택 모드, 우=기본 지정 도구(rdragTool, 기본 W/L), 중=Pan 고정. 멀티 선택 페인이면 함께 조작 (TY-3)
      const mode = d.btn === 2 ? rdragRef.current : d.btn === 1 ? "pan" : mouseMode;
      const tg = targetsOf(d.pid);
      if (mode === "scroll") {   // Scroll 모드 — 세로 드래그로 이미지 넘김(24px/장)
        d.acc = (d.acc ?? 0) + dy;
        while (Math.abs(d.acc) >= 24) { step(d.pid, d.acc > 0 ? 1 : -1); d.acc -= Math.sign(d.acc) * 24; }
      }
      else if (mode === "zoom") updMany(tg, (p) => ({ zoom: Math.max(0.2, p.zoom * (1 - dy * 0.005)) }));
      else if (mode === "pan") updMany(tg, (p) => ({ tx: p.tx + dx, ty: p.ty + dy }));
      else if (mode === "wl") {
        // 드래그 W/L — 80ms 스로틀(leading+trailing)로 서버 /rendered?window 요청 폭주 방지.
        // 델타는 누적되므로 최종 W/L 값은 기존과 동일(조작감 불변, 요청 수만 감소).
        const acc = wlThrottleRef.current;
        acc.dx += dx; acc.dy += dy; acc.tg = tg;
        const apply = () => {
          const a = wlThrottleRef.current;   // 반드시 in-place — 객체 교체 시 timer 플래그가 사장됨
          const adx = a.dx, ady = a.dy, atg = a.tg;
          a.dx = 0; a.dy = 0;
          if (!atg || (adx === 0 && ady === 0)) return;
          updMany(atg, (p) => {
            const cur = p.wl ? p.wl.split(",").map(Number) : null;
            const base = cur && cur.length >= 2 && !Number.isNaN(cur[0])
              ? [cur[0], cur[1]]
              : (p.series?.modality === "CT" ? [40, 400] : [128, 256]);
            const w = Math.max(1, base[1] + adx * 2);
            const c = base[0] - ady * 2;
            return { wl: `${Math.round(c)},${Math.round(w)}` };
          });
        };
        if (!acc.timer) {
          apply();   // leading — 즉시 1회 반영
          acc.timer = window.setTimeout(() => { wlThrottleRef.current.timer = 0; apply(); }, 80);
        }
      }
    };
    const up = (e: MouseEvent) => {
      // ── 주석 드래그 종료 ──
      const ad = annoDragRef.current;
      if (ad) {
        annoDragRef.current = null;
        if (ad.type === "draw") {
          const pp = panesRef.current[ad.pid];
          const c = (pp && screenToImage(e.clientX, e.clientY, ad.rect, pp, ad.aspect)) || ad.cur;
          const dxp = (c[0] - ad.start[0]) * (ad.inst.cols || 1000);
          const dyp = (c[1] - ad.start[1]) * (ad.inst.rows || 1000);
          if (Math.hypot(dxp, dyp) >= 3) {   // 3px(이미지) 이상만 확정 — 클릭 오작동 방지
            completeToolRef.current(ad.tool, ad.pid,
              { sop_uid: ad.sop, series_uid: ad.series }, [ad.start, c], ad.inst);
          } else {
            setDraft(null);   // 취소
          }
        } else if (ad.moved) {
          schedHist();   // 이동/리사이즈 완료 — 히스토리 기록
        }
        return;
      }
      // ── 마퀴 종료 — 현재 인스턴스 주석 중 영역 내(임의 점 포함) 일괄 선택 ──
      const mq = marqueeRef.current;
      if (mq) {
        marqueeRef.current = null;
        const pp = panesRef.current[mq.pid];
        const inst = pp?.series?.instances[pp.index];
        const x0 = Math.min(mq.a[0], mq.b[0]), x1 = Math.max(mq.a[0], mq.b[0]);
        const y0 = Math.min(mq.a[1], mq.b[1]), y1 = Math.max(mq.a[1], mq.b[1]);
        const idxs: number[] = [];
        if (inst && Math.hypot(mq.b[0] - mq.a[0], mq.b[1] - mq.a[1]) >= 0.01) {
          annosRef.current.forEach((a, i) => {
            const vis = a.sop_uid === inst.sop_uid || (!a.sop_uid && pp!.studyUid === detail.study_uid);
            if (vis && a.points?.some(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1)) idxs.push(i);
          });
        }
        setMarquee(null);
        if (idxs.length) { setSelAnnos(idxs); setSelAnno(null); setStatus(`${idxs.length}개 주석 선택 — Del/휴지통/우클릭으로 삭제`); }
        else setSelAnnos(null);
        return;
      }
      const d = dragRef.current;
      if (d?.moved) schedHist();   // 드래그 종료 시점에 히스토리 기록 (In 동일)
      // 우클릭(이동 없음): Shift+우클릭=Zoom Out 한 단계 / 그 외=컨텍스트 메뉴 (초기 분석 §7)
      if (d && d.btn === 2 && !d.moved) {
        if (d.shift) { if (shiftRClickRef.current !== "none") updMany(targetsOf(d.pid), (p) => ({ zoom: Math.max(0.2, p.zoom * 0.8) })); }
        else setCtxMenu({ x: e.clientX, y: e.clientY, pid: d.pid });
      }
      dragRef.current = null;
    };
    // pointer 이벤트 사용 — 우클릭 pointerdown preventDefault 로 compat mouse 이벤트가 억제되어도 드래그 구동
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mouseMode]);

  const act = (a: string) => {
    const p = panes[activePane];
    const tg = targetsOf(activePane);   // TY-3(2): 멀티 선택 페인 연동 조작
    switch (a) {
      case "invert": updMany(tg, (q) => ({ invert: !q.invert })); break;
      case "rotL": updMany(tg, (q) => ({ rot: (q.rot - 90 + 360) % 360 })); break;
      case "rotR": updMany(tg, (q) => ({ rot: (q.rot + 90) % 360 })); break;
      case "rot180": updMany(tg, (q) => ({ rot: (q.rot + 180) % 360 })); break;
      case "flipH": updMany(tg, (q) => ({ flipH: !q.flipH })); break;
      case "flipV": updMany(tg, (q) => ({ flipV: !q.flipV })); break;
      case "sharpen": updMany(tg, (q) => ({ fx: q.fx === "sharpen" ? "" : "sharpen" })); break;
      case "average": updMany(tg, (q) => ({ fx: q.fx === "smooth" ? "" : "smooth" })); break;
      case "pseudo": updMany(tg, (q) => ({ fx: q.fx === "pseudo" ? "" : "pseudo" })); break;
      case "fit": case "reset":
        updMany(tg, () => ({ zoom: 1, tx: 0, ty: 0, rot: 0, flipH: false, flipV: false,
                             ...(a === "reset" ? { invert: false, wl: "", fx: "" as const, shutter: null } : {}) }));
        break;
      case "print": window.print(); break;
      case "rfsh": void refreshExam(); break;
      case "comb": combineSeries(); break;
      case "calib": startCalibrate(); break;   // 기준선 그리기 → mm 입력 → pixel_spacing 재설정
      case "capture": {
        // 현재 모니터의 영상 영역(모든 페인)을 화면 그대로 캡처 — 주석·측정·툴·문자 오버레이 포함.
        const container = vpRef.current;
        if (container) {
          setStatus("캡처 중…");
          void import("../lib/capturePane").then(({ capturePaneToPng }) =>
            capturePaneToPng(container).then(() => setStatus("캡처 저장됨 (PNG)")).catch(() => {
              // 폴백: 화면 캡처 실패 시 서버 렌더 PNG(주석 미포함)
              const url = renderedUrl(p);
              if (url) { const el = document.createElement("a"); el.href = url; el.download = `saintview_${Date.now()}.png`; el.click(); }
              setStatus("화면 캡처 실패 — 서버 렌더 이미지로 저장");
            }));
        }
        break;
      }
      case "cine": {
        if (cineRef.current) { window.clearInterval(cineRef.current); cineRef.current = null; setCine(false); return; }
        setCine(true);
        // 간격 = viewer.prefs.ty_cine_sec (기본 0.15초). 페인별 시네 재생 중인 페인은 건너뜀(페인별 우선)
        cineRef.current = window.setInterval(() => {
          if (panesRef.current[activePane]?.playing) return;
          step(activePane, 1);
        }, Math.max(30, tyCineSec * 1000));
        break;
      }
    }
    if (HIST_OPS.has(a)) schedHist();   // TY-3(1): 원샷 시각조정 — 히스토리 기록
  };

  /* ── TY-3(6): 키이미지 등록/해제 — 현재 이미지 setKeyImages 토글 (In key2d 이식, 워크리스트 🔑 연동) ── */
  const toggleKeyImage = () => {
    const p = panes[activePane];
    const inst = p.series?.instances[p.index];
    if (!p.series || !inst) return;
    const id = openTabsRef.current.find((t) => t.uid === p.studyUid)?.id ?? detail.id;
    api.instances(id).then((r) => {
      const cur = r.key_images ?? [];
      const exists = cur.some((k) => k.sop_uid === inst.sop_uid);
      const next = exists
        ? cur.filter((k) => k.sop_uid !== inst.sop_uid)
        : [...cur, { sop_uid: inst.sop_uid, orthanc_id: inst.orthanc_id,
                     instance_number: inst.instance_number }];
      return api.setKeyImages(id, next).then(() => {
        // 페인 마크 즉시 갱신 (재조회 없이 반응형 반영)
        setKeyMarks((prev) => {
          const n = new Set(prev);
          if (exists) n.delete(inst.sop_uid); else n.add(inst.sop_uid);
          return n;
        });
        setStatus(exists ? `🔑 키이미지 해제 — 남은 ${next.length}장`
                         : `🔑 키이미지 등록 (${next.length}장) — 워크리스트 🔑 표시`);
      });
    }).catch(() => setStatus("키이미지 저장 실패"));
  };

  /* ── Calibrate — 기준선(length) 2점 + 실제 길이(mm) 입력 → 활성 페인 시리즈 pixel_spacing 재설정 ── */
  const calibRef = useRef(false);
  const startCalibrate = () => {
    calibRef.current = true;
    setTool("length");
    setDraft(null);
    setStatus("Calibrate — 실제 길이를 아는 기준선을 그으세요 (예: 자·마커). 완료 후 mm 입력");
  };
  const applyCalibration = (pid: string, points: number[][], inst: InstanceNode) => {
    const dx = (points[1][0] - points[0][0]) * (inst.cols || 1);
    const dy = (points[1][1] - points[0][1]) * (inst.rows || 1);
    const pixLen = Math.hypot(dx, dy);
    if (pixLen < 1) { setStatus("Calibrate 취소 — 기준선이 너무 짧습니다"); return; }
    const mmStr = window.prompt(`기준선의 실제 길이(mm)를 입력하세요\n(화면상 ${pixLen.toFixed(1)}px)`, "10");
    const mm = Number(mmStr);
    if (!mmStr || !Number.isFinite(mm) || mm <= 0) { setStatus("Calibrate 취소"); return; }
    const mmPerPx = mm / pixLen;
    // 활성 페인 시리즈의 모든 인스턴스 pixel_spacing 을 보정값으로 교체 → 이후 측정이 mm 로 계산
    setPanes((prev) => {
      const pane = prev[pid];
      if (!pane.series) return prev;
      const series = { ...pane.series, instances: pane.series.instances.map((i) => ({ ...i, pixel_spacing: [mmPerPx, mmPerPx] })) };
      return { ...prev, [pid]: { ...pane, series } };
    });
    setTool(null);
    setStatus(`✅ Calibrate 완료 — 1px = ${mmPerPx.toFixed(4)}mm (기준 ${mm}mm / ${pixLen.toFixed(1)}px). 이후 측정은 mm 로 표시`);
  };

  /* ── TY-3(8): 딕테이션(Rec) — 서버 STT(OpenAI Whisper/로컬/브라우저) 연동. 전사 텍스트를 판독 도크에 삽입 ── */
  const dict = useDictation((text) => {
    // 판독 도크(ReportDock)가 창 이벤트를 받아 포커스 필드에 삽입
    window.dispatchEvent(new CustomEvent("sv-dictation-insert", { detail: { text } }));
    setStatus(`🎙 음성 판독 → 판독문 삽입: “${text.slice(0, 30)}${text.length > 30 ? "…" : ""}”`);
  });
  const toggleDictation = () => {
    dict.toggle();
    setStatus(dict.recording ? "🎙 녹음 정지 — 전사 중…"
      : dict.engine === "browser" ? "🎙 음성 인식 중(브라우저)… Rec 를 다시 누르면 정지"
      : `🎙 녹음 중(${dict.engine === "openai_api" ? "OpenAI" : "Whisper 로컬"})… Rec 를 다시 누르면 전사`);
  };
  const playDictation = () => {
    if (!dict.playLast()) setStatus("재생할 녹음이 없습니다 (서버 STT 엔진에서 녹음 후 재생 가능)");
  };

  /* ── TY-3(9): Compare — 같은 환자 과거검사 다중 선택 비교 오픈 (In Compare 이식, 페이지 리로드 없이).
        related_exams 만 노출하므로 환자 혼합이 원천 차단된다(다른 환자 비교는 +Add 명시 동선). ── */
  const openCompare = async () => {
    const ids = [...cmpSel].slice(0, 29);           // 3열×10행 상한(주 검사 포함 30) — LAYOUTS 범위 보장
    setCmpOpen(false);
    if (!ids.length) return;
    const n = ids.length + 1;                       // 주 검사(p0) + 선택 검사들
    const c = n <= 2 ? 2 : n <= 4 ? 2 : 3;
    const key = `${Math.ceil(n / c)}x${c}`;
    if (LAYOUTS[key]) setLayout(key as keyof typeof LAYOUTS);
    for (let i = 0; i < ids.length; i++) {
      try {
        const tree = await getTree(ids[i]);
        const s = tree.series[0];
        if (!s) continue;
        addOpenTab(ids[i], tree.uid);
        patch(PANE_IDS[i + 1], { ...initPane(tree.uid), series: s, index: Math.floor(s.instances.length / 2) });
      } catch { /* 개별 실패 무시 */ }
    }
    setXmode("sync_other");
    setStatus(`Compare — 과거검사 ${ids.length}건 비교 오픈 (SyncOther ON)`);
  };

  /* 주석/Reference line SVG 오버레이 — 이미지 콘텐츠 사각형에 정합(viewBox=픽셀 격자) */
  const annoSvg = (pid: string, p: PaneState, inst: InstanceNode) => {
    const size = paneSizes.current[pid];
    if (!size || size.w < 10 || size.h < 10) return null;
    const cols = inst.cols || 1000, rows = inst.rows || 1000;
    const cr = contentRect(size.w, size.h, cols / rows);
    const sx = (v: number) => v * cols, sy = (v: number) => v * rows;
    const fs = Math.max(cols, rows) * 0.022;
    const items = annos.filter((a) =>
      a.sop_uid === inst.sop_uid || (!a.sop_uid && p.studyUid === detail.study_uid));
    const dr = draft && draft.pid === pid ? draft : null;
    // 교차선(Scout) — 기존 Ref 토글 + TY-3(3) Crosslink scout/all_lines 모드 통합.
    // scout/Ref=활성 페인 현재 이미지 1선, all_lines=활성 시리즈 전체(현재 이미지는 진하게)
    const refSegs: { seg: [number, number][]; current: boolean }[] = [];
    if ((refOn || xmode === "scout" || xmode === "all_lines") && pid !== activePane) {
      const act = panes[activePane];
      const actInst = act.series?.instances[act.index];
      if (act.series && actInst) {
        if (xmode === "all_lines") {
          act.series.instances.forEach((si, k) => {
            if (si.sop_uid === inst.sop_uid) return;
            const seg = refLineOn(si, inst);
            if (seg) refSegs.push({ seg, current: k === act.index });
          });
        } else if (actInst.sop_uid !== inst.sop_uid) {
          const seg = refLineOn(actInst, inst);
          if (seg) refSegs.push({ seg, current: true });
        }
      }
    }
    // TY-3(4): 3D Cursor 십자 마커 — 해당 페인의 마커가 현재 이미지에 귀속될 때만
    const c3 = cross3d[pid];
    const c3on = c3 && c3.sop === inst.sop_uid;
    const sh = p.shutter;
    // 편집 선택 주석 — 이 인스턴스에 표시되는 것이면 강조(밝은 테두리 + 점 핸들). 식별은 객체 동일성
    const selA = selAnno ? annos[selAnno.idx] : null;
    const selHere = !!selA && (selA.sop_uid === inst.sop_uid || (!selA.sop_uid && p.studyUid === detail.study_uid)) && !!selA.points?.length;
    const mqHere = !!marquee && pid === activePane;   // 마퀴는 활성 페인에만 표시
    const selSet = selAnnos && selAnnos.length ? new Set(selAnnos) : null;
    if (items.length === 0 && !dr && !refSegs.length && !sh && !c3on && !selHere && !mqHere && !selSet) return null;
    return (
      <svg viewBox={`0 0 ${cols} ${rows}`} preserveAspectRatio="none"
           style={{ position: "absolute", left: cr.left, top: cr.top, width: cr.width, height: cr.height,
                    pointerEvents: "none", overflow: "visible" }}>
        {/* 셔터 — 영역 밖 가림(evenodd, In Viewer 이식). 주석보다 아래에 렌더 */}
        {sh && sh.pts.length >= 2 && (() => {
          const outer = `M0,0 H${cols} V${rows} H0 Z`;
          let inner: string;
          const x0 = sx(sh.pts[0][0]), y0 = sy(sh.pts[0][1]);
          const x1 = sx(sh.pts[1][0]), y1 = sy(sh.pts[1][1]);
          if (sh.kind === "rect") {
            inner = `M${Math.min(x0, x1)},${Math.min(y0, y1)} H${Math.max(x0, x1)} ` +
                    `V${Math.max(y0, y1)} H${Math.min(x0, x1)} Z`;
          } else if (sh.kind === "ellipse") {
            const ecx = (x0 + x1) / 2, ecy = (y0 + y1) / 2;
            const rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
            inner = `M${ecx - rx},${ecy} a${rx},${ry} 0 1,0 ${rx * 2},0 a${rx},${ry} 0 1,0 ${-rx * 2},0 Z`;
          } else {
            inner = "M" + sh.pts.map((q, k) => `${k ? "L" : ""}${sx(q[0])},${sy(q[1])}`).join(" ") + " Z";
          }
          return <path d={`${outer} ${inner}`} fill="#000" fillRule="evenodd" stroke="none" />;
        })()}
        {items.map((a, i) => <AnnoShape key={a.id ?? `local${i}`} a={a} sx={sx} sy={sy} fs={fs} />)}
        {dr && dr.points.map((pt, i) => (
          <circle key={i} cx={sx(pt[0])} cy={sy(pt[1])} r={fs * 0.25} fill="#ffd54a" />
        ))}
        {/* 드래그 그리기 러버밴드 — 2점 드래그 도구의 실시간 도형 미리보기(§A) */}
        {dr && dr.points.length >= 2 && tool && DRAG_TOOLS.has(tool) && (() => {
          const A = { x: sx(dr.points[0][0]), y: sy(dr.points[0][1]) };
          const B = { x: sx(dr.points[1][0]), y: sy(dr.points[1][1]) };
          const col = "#ffd54a", w = fs * 0.08;
          if (tool === "rect" || tool === "shutRect" || tool === "box") {
            return <rect x={Math.min(A.x, B.x)} y={Math.min(A.y, B.y)}
                         width={Math.abs(B.x - A.x)} height={Math.abs(B.y - A.y)}
                         stroke={col} fill="none" strokeWidth={w} />;
          }
          if (tool === "ellipse" || tool === "shutEl") {
            return <ellipse cx={(A.x + B.x) / 2} cy={(A.y + B.y) / 2}
                            rx={Math.abs(B.x - A.x) / 2} ry={Math.abs(B.y - A.y) / 2}
                            stroke={col} fill="none" strokeWidth={w} />;
          }
          if (tool === "circle") {
            const r = Math.hypot(B.x - A.x, B.y - A.y);
            return <circle cx={A.x} cy={A.y} r={r} stroke={col} fill="none" strokeWidth={w} />;
          }
          if (tool === "arrow") {
            const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1;
            const ux = dx / len, uy = dy / len, hs = fs * 0.6;
            return (
              <g stroke={col} strokeWidth={w} fill="none">
                <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} />
                <line x1={B.x} y1={B.y} x2={B.x - hs * (ux + uy * 0.5)} y2={B.y - hs * (uy - ux * 0.5)} />
                <line x1={B.x} y1={B.y} x2={B.x - hs * (ux - uy * 0.5)} y2={B.y - hs * (uy + ux * 0.5)} />
              </g>
            );
          }
          // length / pelvis / profile / table2d — 직선 러버밴드
          return <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} stroke={col} fill="none" strokeWidth={w} />;
        })()}
        {dr && dr.points.length >= 2 && !(tool && DRAG_TOOLS.has(tool)) && (
          tool && FOUR_PT_TOOLS.has(tool) ? (
            // 4점 도구 초안 — 선1(p0,p1)만 잇는다(p1→p2 연결선은 오해 소지)
            <line x1={sx(dr.points[0][0])} y1={sy(dr.points[0][1])}
                  x2={sx(dr.points[1][0])} y2={sy(dr.points[1][1])}
                  stroke="#ffd54a" strokeWidth={fs * 0.08} />
          ) : (
            <polyline points={dr.points.map((q) => `${sx(q[0])},${sy(q[1])}`).join(" ")}
                      stroke="#ffd54a" fill="none" strokeWidth={fs * 0.08} />
          )
        )}
        {/* 편집 선택 강조 — bbox 점선 테두리 + 각 점 사각 핸들(§B) */}
        {selHere && selA && (() => {
          const xs = selA.points.map((q) => sx(q[0])), ys = selA.points.map((q) => sy(q[1]));
          const pad = fs * 0.5;
          const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
          return (
            <g>
              <rect x={minx - pad} y={miny - pad} width={(maxx - minx) + pad * 2} height={(maxy - miny) + pad * 2}
                    fill="none" stroke="#22d3ee" strokeWidth={fs * 0.05}
                    strokeDasharray={`${fs * 0.4} ${fs * 0.3}`} opacity={0.9} />
              {selA.points.map((pt, k) => (
                <rect key={k} x={sx(pt[0]) - fs * 0.28} y={sy(pt[1]) - fs * 0.28}
                      width={fs * 0.56} height={fs * 0.56} fill="#22d3ee" stroke="#000" strokeWidth={fs * 0.05} />
              ))}
            </g>
          );
        })()}
        {/* 마퀴 다중 선택 강조 — 선택된 주석들의 점에 녹색 마커 */}
        {selSet && annos.map((a, ai) => (selSet.has(ai)
          && (a.sop_uid === inst.sop_uid || (!a.sop_uid && p.studyUid === detail.study_uid)) && a.points?.length)
          ? a.points.map((pt, k) => <circle key={`m${ai}-${k}`} cx={sx(pt[0])} cy={sy(pt[1])} r={fs * 0.3}
                                             fill="#22c55e" stroke="#052e16" strokeWidth={fs * 0.04} />)
          : null)}
        {/* 마퀴(녹색 점선 사각형) — 드래그 중 영역 */}
        {mqHere && marquee && (
          <rect x={sx(Math.min(marquee.a[0], marquee.b[0]))} y={sy(Math.min(marquee.a[1], marquee.b[1]))}
                width={sx(Math.abs(marquee.b[0] - marquee.a[0]))} height={sy(Math.abs(marquee.b[1] - marquee.a[1]))}
                fill="rgba(34,197,94,0.10)" stroke="#22c55e" strokeWidth={fs * 0.06} strokeDasharray={`${fs * 0.5} ${fs * 0.3}`} />
        )}
        {refSegs.map((r, i) => (
          <line key={`ref${i}`} x1={sx(r.seg[0][0])} y1={sy(r.seg[0][1])} x2={sx(r.seg[1][0])} y2={sy(r.seg[1][1])}
                stroke="#4dd0e1" strokeDasharray={`${fs * 0.6} ${fs * 0.4}`}
                strokeWidth={fs * (r.current ? 0.08 : 0.05)} opacity={r.current ? 1 : 0.35} />
        ))}
        {c3on && (
          <g stroke="#22d3ee" strokeWidth={fs * 0.1}>
            <line x1={sx(c3.x) - fs} y1={sy(c3.y)} x2={sx(c3.x) + fs} y2={sy(c3.y)} />
            <line x1={sx(c3.x)} y1={sy(c3.y) - fs} x2={sx(c3.x)} y2={sy(c3.y) + fs} />
          </g>
        )}
      </svg>
    );
  };

  /* 판독 도크 동작·상태 — components/ReportDock.tsx 로 이사(리포트 로드/저장/승인/상용구/Ctrl+S 단축키) */

  /* 닫기 동작 — 3종 선택(체크 시 기본 저장 → viewer.prefs.close_mode, Setting>뷰어) */
  // All Close(모든 모니터) 의도는 요청 시점이 아니라 '확정 시점'(doClose)에 브로드캐스트한다.
  // (ask 모드에서 다이얼로그를 취소하면 다른 모니터가 이미 닫혀버리는 비원자적 상태 방지)
  const closeAllMonitorsRef = useRef(false);
  const doClose = async (mode: "save_current" | "save_all" | "discard", remember: boolean) => {
    setCloseDlg(false);
    if (remember) {
      setPrefs((p) => ({ ...p, close_mode: mode }));
      api.getSetting("viewer.prefs").then((r) =>
        api.putSetting("viewer.prefs", { ...r.value, close_mode: mode }, "user")).catch(() => {});
    }
    // 확정된 순간에만 다른 모니터 뷰어에 닫기 전파 + 공유 탭 목록 정리
    if (closeAllMonitorsRef.current) {
      closeAllMonitorsRef.current = false;
      postViewerCloseAll();
      try { localStorage.removeItem(TABS_KEY); } catch { /* 무시 */ }
    }
    try {
      if (mode === "save_current") {
        await api.saveAnnotations(detail.id, annos);
      } else if (mode === "save_all") {
        await api.saveAnnotations(detail.id, annos);
        await doGsps();  // 전체 변경사항 = 주석 + 표시상태(GSPS) 저장
      }
    } catch { /* 저장 실패해도 닫기는 진행 */ }
    onClose();
  };
  const requestClose = (allMonitors = false) => {
    closeAllMonitorsRef.current = allMonitors;
    if (prefs.close_mode === "ask") setCloseDlg(true);   // 확정은 다이얼로그 → doClose 에서 전파
    else void doClose(prefs.close_mode, false);
  };
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;
  const closeAllTabs = () => {
    // All Close — close_scope="all"(기본)이면 확정 시 모든 모니터 닫기, "current"면 이 창만.
    requestClose(prefs.monitor?.close_scope !== "current");
  };
  // 다른 모니터에서 All Close(전체 범위) → 이 창도 대화상자 없이 닫는다(저장은 설정 모드대로, ask면 현재화면 저장)
  const doCloseRef = useRef(doClose);
  doCloseRef.current = doClose;
  useEffect(() => onViewerCloseAll(() => {
    const m = prefsRef.current.close_mode;
    void doCloseRef.current(m === "ask" ? "save_current" : m, false);
  }), []);

  /* 툴바 표시 여부 (Setting>뷰어>Tools bar — 계정 로밍, 기본 모두 표시) */
  const tbOn = (id: string) => prefs.toolbar?.[id] !== false;

  /* W/L 프리셋 적용 — All 모드면 모든 페인에 (UBPACS All), 아니면 활성+멀티 선택 페인 (TY-3) */
  const applyWl = (q: string) => {
    if (wlAll) {
      setPanes((prev) => Object.fromEntries(
        Object.entries(prev).map(([k, p]) => [k, { ...p, wl: q }])));
    } else {
      updMany(targetsOf(activePane), () => ({ wl: q }));
    }
    schedHist();
  };

  /* 패널 크기 영속화 (paletteW/dockW/thumbSize — 계정 로밍) */
  const persistViewerSizes = () => {
    api.getSetting("viewer.prefs").then((r) =>
      api.putSetting("viewer.prefs", {
        ...r.value, paletteW: prefsRef.current.paletteW,
        dockW: prefsRef.current.dockW, thumbSize: prefsRef.current.thumbSize,
      }, "user")).catch(() => {});
  };

  const L = LAYOUTS[layout];
  const paletteHoriz = prefs.paletteSide === "top" || prefs.paletteSide === "bottom";
  const paletteRight = prefs.paletteSide === "right";
  const thumbHoriz = prefs.thumbSide === "bottom" || prefs.thumbSide === "top";
  const thumbRight = prefs.thumbSide === "right";
  const ts = prefs.thumbSize;
  // 활성 페인 전환 시 Image 콤보 표시를 그 페인의 il 로 동기
  const apIl = panes[activePane]?.il;
  useEffect(() => { setImgLay(apIl ?? { r: 1, c: 1 }); }, [activePane, apIl?.r, apIl?.c]);   // eslint-disable-line react-hooks/exhaustive-deps

  /* 페인 1개 렌더 — 경계 스플리터 뷰포트(행×열 flex) 안에서 사용.
     더블클릭=최대화/복원(spineCurve 드래프트 수집 중에는 종료 전용 — 최대화 금지), 확대경=마우스 추적 3배 렌즈 */
  const renderPane = (pid: string) => {
    const p = panes[pid];
    // 페인별 Image Layout — 이 페인에 지정된 il 만 적용(다른 페인은 1×1 유지)
    const pIl = p.il ?? { r: 1, c: 1 };
    const tileCount = pIl.r * pIl.c;
    const url = renderedUrl(p);
    const isPrior = p.studyUid !== detail.study_uid;
    const inst = p.series?.instances[p.index];
    // 페인 테두리 — 멀티 선택=ty_sel_color 2px, 활성=ty_sel_color 1px (TY-3(2))
    const outline = selPanes.has(pid) ? `2px solid ${tySelColor}`
      : activePane === pid ? `1px solid ${tySelColor}` : "1px solid var(--border)";
    // TY-3(7): 로컬 미디어 페인 — jpg/png/bmp/avi/mp4 표시·재생 (In media 분기 이식)
    if (p.media) {
      return (
        // data-sv-rshield — 미디어 페인 우클릭은 차단만(DICOM 컨텍스트 메뉴·W/L 드래그 부적합)
        <div data-sv-rshield="" onMouseDown={() => setActivePane(pid)}
             style={{ position: "relative", overflow: "hidden", minHeight: 0, minWidth: 0, flex: 1,
                      background: "#000", display: "grid", placeItems: "center", outline }}>
          {p.media.kind === "video"
            ? <video src={p.media.url} controls autoPlay loop
                     style={{ maxWidth: "100%", maxHeight: "100%" }} />
            : <img src={p.media.url} alt=""
                   style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />}
          <div style={{ position: "absolute", top: 4, left: 6, fontSize: 10.5, color: "var(--accent)",
                        textShadow: "0 0 3px #000", pointerEvents: "none" }}>
            📂 {p.media.name}
          </div>
          <button title="미디어 닫기 — DICOM 표시로 복귀"
                  onClick={() => { URL.revokeObjectURL(p.media!.url); patch(pid, { media: null }); }}
                  style={{ position: "absolute", top: 3, right: 4, fontSize: 11, padding: "0 6px" }}>✕</button>
        </div>
      );
    }
    return (
      <div ref={getPaneRef(pid)} data-pid={pid}
           onMouseDown={(e) => onPaneMouseDown(pid, e)}
           onMouseEnter={() => setHoverPane(pid)}
           onWheel={(e) => {
             if (tHeld.current) {  // T+스크롤 — 오버레이 글자 크기 (In Viewer 패리티, 계정 저장)
               const nf = Math.min(24, Math.max(6, tyOvFont + (e.deltaY < 0 ? 0.5 : -0.5)));
               setTyOvFont(nf);
               persistPrefsPatch({ ty_overlay_font: nf });
               return;
             }
             wheelStep(pid, e.deltaY > 0 ? 1 : -1);
           }}
           onDoubleClick={() => {
             if (tool && OPEN_ENDED.has(tool)) { finishOpenEnded(); return; }  // 수집 종료 — 최대화 충돌 회피
             if (!tool) setMaximized((m) => (m === pid ? null : pid));   // 더블클릭 = 페인 최대화/복원
           }}
           onMouseMove={(e) => {   // Magnification — 단일 이미지 페인에서 마우스 추적 (In Viewer 이식)
             if (!magOn || !inst || tileCount > 1) return;
             const r = e.currentTarget.getBoundingClientRect();
             const cols = inst.cols || 1, rows = inst.rows || 1;
             const s = Math.min(r.width / cols, r.height / rows) * p.zoom;
             if (!s) return;
             const ix = (e.clientX - (r.left + r.width / 2 + p.tx)) / s + cols / 2;
             const iy = (e.clientY - (r.top + r.height / 2 + p.ty)) / s + rows / 2;
             setMagPos({ pid, mx: e.clientX - r.left, my: e.clientY - r.top,
                         nx: ix / cols, ny: iy / rows, sc: s });
           }}
           onMouseLeave={() => { if (magOn) setMagPos(null); setHoverPane((h) => (h === pid ? null : h)); }}
           // 썸네일 시리즈 드롭 — 이 페인에 로드 (드래그앤드롭)
           onDragOver={(e) => { if (e.dataTransfer.types.includes("application/x-sv-series")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; if (dragOverPane !== pid) setDragOverPane(pid); } }}
           onDragLeave={() => setDragOverPane((d) => (d === pid ? null : d))}
           onDrop={(e) => { e.preventDefault(); setDragOverPane(null); const uid = e.dataTransfer.getData("application/x-sv-series"); if (!uid) return; if (dropMenuRef.current) setCircle({ pid, uid, x: e.clientX, y: e.clientY }); else dropSeriesToPane(pid, uid); }}
           style={{ position: "relative", overflow: "hidden", minHeight: 0, minWidth: 0, flex: 1,
                    background: "#000", cursor: tool ? "copy" : "crosshair",
                    outline: dragOverPane === pid ? "3px solid var(--accent)" : outline,
                    outlineOffset: dragOverPane === pid ? "-3px" : undefined }}>
        {dragOverPane === pid && (
          <div style={{ position: "absolute", inset: 0, zIndex: 6, display: "grid", placeItems: "center",
                        background: "color-mix(in srgb, var(--accent) 18%, transparent)", pointerEvents: "none",
                        color: "var(--accent)", fontSize: 14, fontWeight: 800, textShadow: "0 1px 4px #000" }}>
            ↓ 이 페인에 시리즈 표시
          </div>
        )}
        {url && (
          <div style={{
            position: "absolute", inset: 0,
            transform: `translate(${p.tx}px,${p.ty}px) scale(${p.zoom * (p.flipH ? -1 : 1)},${p.zoom * (p.flipV ? -1 : 1)}) rotate(${p.rot}deg)`,
          }}>
            {tileCount <= 1 ? (
              <>
                <img src={url} alt="" draggable={false}
                     style={{
                       width: "100%", height: "100%", objectFit: "contain", userSelect: "none",
                       filter: paneFilter(p),
                     }} />
                {inst && annoSvg(pid, p, inst)}
              </>
            ) : (
              /* Image Layout — 연속 이미지 N×M 타일 (UBPACS p.14) */
              <div style={{
                width: "100%", height: "100%", display: "grid", gap: 1,
                gridTemplateColumns: `repeat(${pIl.c}, 1fr)`,
                gridTemplateRows: `repeat(${pIl.r}, 1fr)`,
              }}>
                {Array.from({ length: tileCount }, (_, k) => {
                  const u = renderedUrlAt(p, p.index + k);
                  return u ? (
                    <img key={k} src={u} alt="" draggable={false}
                         style={{
                           width: "100%", height: "100%", objectFit: "contain", userSelect: "none",
                           minWidth: 0, minHeight: 0,
                           filter: paneFilter(p),
                         }} />
                  ) : <div key={k} />;
                })}
              </div>
            )}
          </div>
        )}
        {/* 확대경 렌즈 — 마우스 위치 3배 확대 (배경이미지 트릭, In Viewer 동일) */}
        {magOn && magPos && magPos.pid === pid && url && inst && tileCount <= 1 && (
          <div style={{
            position: "absolute", left: magPos.mx - 80, top: magPos.my - 80,
            width: 160, height: 160, borderRadius: "50%", zIndex: 4, pointerEvents: "none",
            border: "2px solid var(--accent)", backgroundColor: "#000", backgroundRepeat: "no-repeat",
            backgroundImage: `url(${url})`,
            backgroundSize: `${(inst.cols || 1) * magPos.sc * 3}px ${(inst.rows || 1) * magPos.sc * 3}px`,
            backgroundPosition:
              `${80 - magPos.nx * (inst.cols || 1) * magPos.sc * 3}px ` +
              `${80 - magPos.ny * (inst.rows || 1) * magPos.sc * 3}px`,
            filter: p.invert ? "invert(1)" : undefined,
          }} />
        )}
        {/* Shift+우드래그 영역 W/L 러버밴드 — 확장(Linkclump 류) 빨간 박스와 구분되게 황색 점선+라벨 */}
        {wlBox?.pid === pid && (
          <div style={{ position: "absolute", left: wlBox.left, top: wlBox.top, width: wlBox.w, height: wlBox.h,
                        border: "2px dashed #f59e0b", background: "rgba(245,158,11,0.10)", zIndex: 6,
                        pointerEvents: "none" }}>
            {/* 페인 상단 근처에서 시작하면 라벨이 overflow:hidden 에 잘리므로 박스 안쪽으로 */}
            <span style={{ position: "absolute", top: wlBox.top < 20 ? 2 : -18, left: wlBox.top < 20 ? 3 : 0,
                           fontSize: 10.5, fontWeight: 700, color: "#f59e0b", textShadow: "0 0 3px #000",
                           whiteSpace: "nowrap" }}>영역 W/L</span>
          </div>
        )}
        {/* 키이미지 마크 — 현재 표시 이미지가 키이미지면 상단 중앙에 🔑 배지 (overlay 토글과 무관) */}
        {p.series?.instances[p.index] && keyMarks.has(p.series.instances[p.index].sop_uid) && (
          <div style={{ position: "absolute", top: 5, left: "50%", transform: "translateX(-50%)", zIndex: 5,
                        display: "flex", alignItems: "center", gap: 3, padding: "1px 9px", borderRadius: 10,
                        background: "rgba(250,204,21,0.94)", color: "#1a1a1a", fontSize: 11, fontWeight: 800,
                        letterSpacing: 0.4, pointerEvents: "none", boxShadow: "0 1px 5px rgba(0,0,0,0.5)" }}>
            🔑 KEY
          </div>
        )}
        {overlayOn && p.series && (() => {
          const meta = studyMeta[p.studyUid] ?? detail;  // 페인의 검사 기준 — 다른 환자 영상에 주검사 환자명 오표기 방지
          const priorMark = isPrior && meta.patient_key === detail.patient_key;  // 같은 환자의 과거검사만 [비교/과거]
          return (
          <>
            <div style={ov("tl", tyOvFont)}>
              {meta.patient_name} ({meta.sex})<br />
              {priorMark ? "[비교/과거] " : ""}{meta.study_desc}<br />{meta.study_date}
              {priorMark && (() => {
                // 현재 판독 검사(detail) 대비 이 과거영상이 얼마전인지 — 노란색
                const t = durText(meta.study_date, detail.study_date);
                return t ? <><br /><span style={{ color: "#fde047", fontWeight: 700 }}>{t}</span></> : null;
              })()}
            </div>
            <div style={ov("tr", tyOvFont)}>
              S{p.series.series_number} {p.series.series_desc || p.series.modality}<br />
              Img: {p.index + 1}{tileCount > 1 && `~${Math.min(p.index + tileCount, p.series.instances.length)}`}/{p.series.instances.length}
            </div>
            <div style={ov("bl", tyOvFont)}>{meta.modality} · {meta.patient_key}</div>
            <div style={ov("br", tyOvFont)}>
              Z: {(p.zoom * 100).toFixed(0)}%{p.wl && <><br />W/L: {p.wl}</>}{p.fx && <><br />{p.fx}</>}
            </div>
          </>
          );
        })()}
        {/* TY-3(5): 페인별 독립 시네 — 호버(또는 재생 중) 시 ▶/⏸+간격(초) 미니 컨트롤 (In 이식) */}
        {tbOn("pcine") && p.series && p.series.instances.length > 1 && (hoverPane === pid || p.playing) && (
          <div onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
               onWheel={(e) => e.stopPropagation()}
               style={{ position: "absolute", bottom: 4, left: "50%", transform: "translateX(-50%)",
                        zIndex: 4, display: "flex", gap: 4, alignItems: "center",
                        background: "rgba(0,0,0,0.72)", borderRadius: 6, padding: "1px 7px" }}>
            <span title={p.playing ? "Pause — 이 페인 정지 (멀티 선택 시 함께)" : "Play — 이 페인만 재생 (멀티 선택 시 함께)"}
                  style={{ cursor: "pointer", fontSize: 12.5,
                           color: p.playing ? "var(--accent)" : "var(--text-secondary)" }}
                  onClick={() => {
                    const nv = !p.playing;
                    for (const k of targetsOf(pid)) cineLastRef.current[k] = 0;
                    updMany(targetsOf(pid), () => ({ playing: nv }));
                  }}>
              {p.playing ? "⏸" : "▶"}
            </span>
            <input type="number" min={0.05} max={10} step={0.05}
                   title="이 페인의 넘김 간격(초) — 기본값은 Setting>뷰어 ty_cine_sec"
                   value={p.cineSec ?? tyCineSec}
                   onChange={(e) => updMany(targetsOf(pid), () => ({
                     cineSec: Math.min(10, Math.max(0.05, Number(e.target.value) || tyCineSec)),
                   }))}
                   style={{ width: 48, fontSize: 10, padding: "0 2px" }} />
            <span style={{ fontSize: 9.5, color: "var(--text-secondary)" }}>초</span>
          </div>
        )}
      </div>
    );
  };

  /* 팔레트 버튼 내부 — 아이콘 크기(ty_tool_size)·라벨 표시(ty_tool_labels) 개인화 반영 */
  const TyInner = ({ id, label, anatomy }: { id: string; label: string; anatomy?: boolean }) => (
    <span style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, lineHeight: 1 }}>
      {anatomy ? <AnatomyIcon id={id} size={tySize} flat={!tyIcon3d} />
               : <ToolIconTy id={id} size={tySize} flat={!tyIcon3d} />}
      {tyLabels && <span style={{ fontSize: 10 }}>{label}</span>}
    </span>
  );
  const ModeBtn = ({ k, label, title }: { k: "wl" | "zoom" | "pan" | "select"; label: string; title: string }) => (
    // 재클릭 = 해제 — 기본(Select)으로 복귀해 버튼 색 원복(SaintView 메뉴 mkMode·In 팔레트와 정합)
    <button onClick={() => { recordUse(k); setMouseMode(mouseMode === k && k !== "select" ? "select" : k); }} title={title}
            style={{ padding: "6px 0", fontSize: 12, width: paletteHoriz ? 60 : "100%",
                     background: mouseMode === k ? "var(--accent)" : undefined }}>
      <TyInner id={k} label={label} />
    </button>
  );
  // 액션 → 아이콘 매핑 (UBPACS 아이콘 표)
  const ACT_ICON: Record<string, string> = {
    fit: "fit", invert: "inv", rotL: "rotL", rotR: "rotR", flipH: "flipH",
    flipV: "flipV", cine: "cine", capture: "cap", reset: "reset",
  };
  const ActBtn = ({ a, label, title, on }: { a: string; label: string; title: string; on?: boolean }) => (
    <button onClick={() => { recordUse(a); act(a); }} title={title}
            style={{ padding: "6px 0", fontSize: 12, width: paletteHoriz ? 60 : "100%",
                     background: on ? "var(--accent)" : undefined }}>
      <TyInner id={ACT_ICON[a] ?? a} label={label} />
    </button>
  );

  /* ★ Quick 행 디스패치 — 기록된 사용 id → 실행 (툴/마우스모드/액션 공용) */
  const quickDefs: Record<string, { icon: string; label: string; anatomy?: boolean; run: () => void }> = {
    // 재클릭 = 해제(Select 복귀) — 팔레트 ModeBtn 과 동일 토글
    zoom: { icon: "zoom", label: "Zoom", run: () => setMouseMode((m) => (m === "zoom" ? "select" : "zoom")) },
    pan: { icon: "pan", label: "Pan", run: () => setMouseMode((m) => (m === "pan" ? "select" : "pan")) },
    wl: { icon: "wl", label: "W/L", run: () => setMouseMode((m) => (m === "wl" ? "select" : "wl")) },
    fit: { icon: "fit", label: "Fit", run: () => act("fit") },
    invert: { icon: "inv", label: "Inv", run: () => act("invert") },
    rotL: { icon: "rotL", label: "⟲90", run: () => act("rotL") },
    rotR: { icon: "rotR", label: "⟳90", run: () => act("rotR") },
    flipH: { icon: "flipH", label: "⇋", run: () => act("flipH") },
    flipV: { icon: "flipV", label: "⇵", run: () => act("flipV") },
    cine: { icon: "cine", label: "Cine", run: () => act("cine") },
    capture: { icon: "cap", label: "Cap", run: () => act("capture") },
    reset: { icon: "reset", label: "Reset", run: () => act("reset") },
    ref: { icon: "ref", label: "Ref", run: () => setRefOn((r) => !r) },
    rot180: { icon: "rot180", label: "⟳180", run: () => act("rot180") },
    sharpen: { icon: "sharpen", label: "Shrp", run: () => act("sharpen") },
    average: { icon: "average", label: "Avg", run: () => act("average") },
    pseudo: { icon: "pseudo", label: "Psd", run: () => act("pseudo") },
    mag: { icon: "mag", label: "Mag", run: () => setMagOn((m) => { if (m) setMagPos(null); return !m; }) },
    rfsh: { icon: "rfsh", label: "Rfsh", run: () => act("rfsh") },
    save: { icon: "save", label: "Save", run: () => { void saveAnnos(); } },
    comb: { icon: "comb", label: "Comb", run: () => act("comb") },
    print: { icon: "print", label: "Print", run: () => act("print") },
    calib: { icon: "calib", label: "Calib", run: () => act("calib") },
    ...Object.fromEntries([...TOOL_DEFS, ...ANATOMY_TOOL_DEFS, ...PIXEL_TOOL_DEFS, ...SHUTTER_TOOL_DEFS]
      .map(([tk, label]) => [tk, {
        icon: tk, label, anatomy: ANATOMY_TOOL_DEFS.some(([k]) => k === tk),
        run: () => { pickTool(tk); },
      }])),
  };
  // ★ Quick 구성 — Save·Rfsh 는 항상 고정, 나머지는 사용 상위(3회 미만 비표시)로 채움(총 6칸).
  // ty_quick_row=false 면 행 자체를 숨김(설정 존중).
  const QUICK_PINNED = ["save", "rfsh"];
  const quickIds = tyQuickRow
    ? [
        ...QUICK_PINNED,
        ...Object.entries(tyUsage)
          .filter(([id, n]) => n >= 3 && quickDefs[id] && !QUICK_PINNED.includes(id))
          .sort((a, b) => b[1] - a[1]).slice(0, 6 - QUICK_PINNED.length).map(([id]) => id),
      ]
    : [];

  // SaintView 모드 하이라이트 — 기본 모드(zoom)는 '선택'으로 표시하지 않고, 사용자가 클릭했을 때만 노랑.
  // 재클릭 = 취소(흰색 복귀, 모드는 중립 select 로).
  const [saintModeOn, setSaintModeOn] = useState(false);
  const SAINT_MODES = ["select", "pan", "zoom", "wl", "scroll"] as const;
  const saintSetMode = (k: "select" | "pan" | "zoom" | "wl" | "scroll") => {
    if (saintModeOn && mouseMode === k) { setSaintModeOn(false); setMouseMode("select"); }
    else { setMouseMode(k); setSaintModeOn(true); }
  };

  /* SAINT VIEW 스킨 상단 메뉴 — 기존 툴 함수(quickDefs/act/pickTool/setMouseMode 등) 재사용, 아이콘 기능 동일 */
  const mkItem = (id: string, label?: string, run?: () => void) => ({
    id, label: label ?? quickDefs[id]?.label ?? id,
    icon: quickDefs[id]?.icon ?? id,
    run: run ?? (() => { recordUse(id); quickDefs[id]?.run(); }),
  });
  const saintMenus: { title: string; items: { id: string; label: string; icon?: string; run: () => void }[] }[] = [
    { title: "Image Tool", items: [
      mkItem("select", "Select", () => saintSetMode("select")),
      mkItem("pan", "Pan", () => saintSetMode("pan")),
      mkItem("zoom", "Zoom", () => saintSetMode("zoom")),
      mkItem("wl", "Window/level", () => saintSetMode("wl")),
      mkItem("scroll", "Scroll", () => saintSetMode("scroll")),
      mkItem("mag", "Magnification"),
      mkItem("fit", "Fit"),
      mkItem("reset", "Reset"),
      mkItem("lens", "Probe", () => pickTool("lens")),
      // 3D Cursor — 클릭/홀드-드래그로 모든 페인을 같은 3D 위치로 동기(T·In 뷰어와 동일 엔진)
      mkItem("cursor3d", "3D Cursor", () => pickTool("cursor3d")),
    ] },
    { title: "Measurement", items: [
      mkItem("length", "Measure", () => pickTool("length")),
      mkItem("arrow", "Arrow", () => pickTool("arrow")),
      mkItem("angle", "Angle", () => pickTool("angle")),
      mkItem("text", "Text", () => pickTool("text")),
      mkItem("ellipse", "Oval ROI", () => pickTool("ellipse")),
      mkItem("rect", "Rectangle ROI", () => pickTool("rect")),
      mkItem("poly", "Free ROI", () => pickTool("poly")),
      mkItem("cobb", "Cobb's Angle", () => pickTool("cobb")),
      mkItem("mctr", "CT Ratio", () => pickTool("mctr")),
      mkItem("leg", "LegLength", () => pickTool("leg")),
      mkItem("centerline", "Bidirectional", () => pickTool("centerline")),
      mkItem("key2d", "Key Image", () => toggleKeyImage()),
      mkItem("shutEl", "Circle Shutter", () => pickTool("shutEl")),
      mkItem("calib", "Calibrate"),
    ] },
    { title: "Reading Support", items: [
      mkItem("flipH", "Flip Horizontal"),
      mkItem("flipV", "Flip Vertical"),
      mkItem("rot180", "Rotate 180"),
      mkItem("rotR", "Rotate Right90"),
      mkItem("rotL", "Rotate Left90"),
      mkItem("invert", "Inverse"),
    ] },
    { title: "Additional", items: [
      mkItem("clr", "Delete All Tools", () => { setAnnos([]); setSelAnno(null); setSelAnnos(null); setTool(null); schedHist(); setStatus("주석 전체 삭제 (◀ 이전으로 복원)"); }),
      mkItem("del", "Delete Tool", () => { if (selAnnos) deleteSelAnnos(); else if (selAnno) deleteSelAnno(); else { setAnnos((pp) => pp.slice(0, -1)); schedHist(); } }),
      mkItem("save", "Save All Tools", () => { void saveAnnos(); }),
      mkItem("print", "Print"),
      mkItem("gsps", "Dicom (GSPS 저장)", () => void doGsps()),
      mkItem("report", "Report", () => { void (async () => {
        const r = await api.getSetting("viewer.prefs").catch(() => ({ value: {} }));
        const mon = (r.value as { monitor?: { report?: number | null } }).monitor?.report;
        const features = await screenFeatures(mon != null && mon >= 0 ? [mon] : null, "width=980,height=800");
        window.open(`${window.location.origin}${window.location.pathname}?report=1&study=${detail.id}`, "sv_report", features);
      })(); }),
    ] },
  ];

  /* SaintView 툴 파레트 = 메뉴바 — 설정 paletteSide(좌/우/상/하) 연동 + ⠿ 드래그 도킹 */
  const saintBar = skin === "saint" && (
    <SaintMenuBar menus={saintMenus} activeId={tool || (saintModeOn ? mouseMode : "")} side={prefs.paletteSide}
                  quick={quickIds.slice(0, 6).filter((id) => quickDefs[id]).map((id) => ({
                    id, label: quickDefs[id].label, icon: quickDefs[id].icon,
                    run: () => {
                      recordUse(id);
                      if ((SAINT_MODES as readonly string[]).includes(id)) saintSetMode(id as typeof SAINT_MODES[number]);
                      else quickDefs[id].run();
                    },
                  }))}
                  onGripDown={(e) => { dockDragRef.current = { kind: "palette", sx: e.clientX, sy: e.clientY }; }}
                  onNav={navPatient}
                  navPrevDisabled={navTarget(-1) === undefined}
                  navNextDisabled={navTarget(1) === undefined} />
  );

  /* 팔레트(방향 전환 가능 — 요청 2). SAINT VIEW 스킨은 상단 가로 메뉴 툴바를 쓰므로 세로 팔레트 숨김 */
  const palette = skin !== "saint" && paletteOpen && (
    <div style={{
      display: "flex", flexDirection: paletteHoriz ? "row" : "column", gap: 3, padding: 4,
      background: "var(--bg-panel)", flexShrink: 0, overflow: paletteHoriz ? "auto" : "hidden",
      minHeight: 0, alignItems: paletteHoriz ? "center" : undefined,
      ...(paletteHoriz ? { borderBottom: "1px solid var(--border)" }
        : { width: prefs.paletteW, ...(paletteRight ? { borderLeft: "1px solid var(--border)" }
                                                    : { borderRight: "1px solid var(--border)" }) }),
    }}>
      {/* 위치 그립 — 드래그해서 화면 가장자리(좌/우/상/하)에 도킹 */}
      <div title="드래그로 툴 팔레트 위치 이동 — 화면 왼쪽/오른쪽/위/아래로 끌어 놓으세요 (설정>뷰어에서도 지정 가능)"
           onPointerDown={(e) => { dockDragRef.current = { kind: "palette", sx: e.clientX, sy: e.clientY }; }}
           style={{ cursor: "grab", textAlign: "center", fontSize: 10, color: "var(--text-secondary)",
                    padding: "1px 4px", flexShrink: 0, userSelect: "none" }}>⠿</div>
      {/* ★ Quick — 사용 상위 6개 툴 자동 추천 (ty_quick_row·ty_usage, 팔레트 최상단) */}
      {quickIds.length > 0 && (
        <div style={paletteHoriz ? { display: "flex", gap: 3, alignItems: "center" } : undefined}>
          <div title="자주 쓰는 툴 자동 추천 — 사용 3회 이상, 상위 6개 (설정>뷰어에서 끌 수 있음)"
               style={{ padding: "4px 6px", fontSize: 11, fontWeight: 700, borderRadius: 3,
                        color: "var(--accent)", background: "var(--bg-elevated)" }}>
            ★ Quick
          </div>
          <div style={{ display: paletteHoriz ? "flex" : "grid", gap: 3,
                        ...(paletteHoriz ? {} : { gridTemplateColumns: `repeat(${tyToolCols}, 1fr)`, padding: "3px 0" }) }}>
            {quickIds.map((id) => {
              const q = quickDefs[id];
              return (
                <button key={id} title={`★ ${q.label} — 사용 ${tyUsage[id]}회`}
                        onClick={() => { recordUse(id); q.run(); }}
                        style={{ padding: "6px 0", fontSize: 12, width: paletteHoriz ? 60 : "100%",
                                 background: tool === id || mouseMode === id ? "var(--accent)" : undefined }}>
                  <TyInner id={q.icon} label={q.label} anatomy={q.anatomy} />
                </button>
              );
            })}
          </div>
        </div>
      )}
      {/* ◀▶ 환자 이동 — 시간대별 한 단계 (방향=Setting>정책, 열려 있으면 그 탭으로 전환) */}
      <div style={{ display: "flex", gap: 3, ...(paletteHoriz ? {} : { width: "100%" }) }}>
        <button title={`◀ ${navLeft === "past" ? "한 단계 과거" : "한 단계 최신"} 검사 — 열려 있으면 그 Exam 탭으로 (정책에서 변경)`}
                onClick={() => navPatient(-1)} disabled={navTarget(-1) === undefined}
                style={{ flex: 1, padding: "5px 0", fontSize: 13, fontWeight: 700 }}>◀</button>
        <button title={`▶ ${navLeft === "past" ? "한 단계 최신" : "한 단계 과거"} 검사 — 열려 있으면 그 Exam 탭으로 (정책에서 변경)`}
                onClick={() => navPatient(1)} disabled={navTarget(1) === undefined}
                style={{ flex: 1, padding: "5px 0", fontSize: 13, fontWeight: 700 }}>▶</button>
      </div>
      <select value={layout} onChange={(e) => setLayout(e.target.value as keyof typeof LAYOUTS)}
              style={{ fontSize: 12, width: paletteHoriz ? 76 : "100%", padding: "4px 2px" }}>
        <option value="1x1">1 X 1</option><option value="1x2">1 X 2</option><option value="2x2">2 X 2</option>
      </select>
      {/* TY-3(3): Crosslink 5모드 — off/AutoSync(같은 검사)/SyncOther(과거 포함)/Scout/AllLines (In §3.3) */}
      {tbOn("xlink") && (
        <>
          <select value={xmode} onChange={(e) => setXmode(e.target.value as XlinkMode)}
                  title={`Crosslink 모드 (L 키=Off↔AutoSync 토글) — ${XLINK_MODES.map((m) => `${m.label}: ${m.desc}`).join(" · ")}`}
                  style={{ fontSize: 11, width: paletteHoriz ? 86 : "100%", padding: "4px 2px",
                           background: xmode !== "off" ? "var(--accent)" : undefined,
                           color: xmode !== "off" ? "#fff" : undefined }}>
            {XLINK_MODES.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
          {/* 듀얼모드 Stack 동기 방식 (G 키) — Spatial=DICOM 좌표 정합 / Index=1:1 */}
          <button title="Stack 동기 방식 (G 키) — Spatial: DICOM 좌표로 해부학적 정합(두께·각도·장수 달라도) / Index: 1:1 인덱스(좌표 없는 로컬 데이터·강제 정합)"
                  onClick={() => setSpatialSync((s) => !s)}
                  style={{ fontSize: 10.5, padding: "4px 2px", width: paletteHoriz ? 62 : "100%",
                           background: spatialSync ? "var(--accent)" : undefined, color: spatialSync ? "#fff" : undefined }}>
            {spatialSync ? "◈ Spatial" : "▤ Index"}
          </button>
        </>
      )}
      <button style={{ padding: "6px 6px", fontSize: 12 }} onClick={() => setThumbOpen((t) => !t)}>Thumb</button>
      <button style={{ padding: "6px 6px", fontSize: 12 }} onClick={() => setPaletteOpen(false)}>Hide</button>
      {/* Common 이하만 스크롤 — ★Quick·이동·레이아웃·Sync·Thumb/Hide 상단 블록은 고정 */}
      <div style={paletteHoriz ? { display: "flex", gap: 3, alignItems: "center" }
                               : { flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
      {([["common", "Common"], ["anno", "Anno"], ["anatomy", "Anatomy(해부)"], ["px", "Pixel"], ["shut", "Shutter"], ["2d", "2D"], ["etc", "ETC"]] as const).map(([k, label]) => (
        <div key={k} style={paletteHoriz ? { display: "flex", gap: 3, alignItems: "center" } : undefined}>
          <div onClick={() => toggleSec(k)}
               title="클릭=섹션 접기/펼치기 (기본 전체 펼침)"
               style={{ padding: "4px 6px", fontSize: 11, fontWeight: 700, cursor: "pointer",
                        color: openSecs.has(k) ? "var(--text-primary)" : "var(--text-secondary)",
                        background: "var(--bg-elevated)", borderRadius: 3, marginTop: 2 }}>
            {openSecs.has(k) ? "▾" : "▸"} {label}
          </div>
          {openSecs.has(k) && (
            <div style={{
              display: paletteHoriz ? "flex" : "grid", gap: 3,
              ...(paletteHoriz ? {} : { gridTemplateColumns: `repeat(${tyToolCols}, 1fr)`, padding: "3px 0" }),
            }}>
              {k === "common" && (<>
                <ModeBtn k="select" label="Select" title="선택 모드 — 주석 클릭 편집 / 빈 공간 드래그=녹색 점선 마퀴 다중선택 → Del 삭제" />
                {tbOn("zoom") && <ModeBtn k="zoom" label="Zoom" title="좌드래그=확대 (우드래그 항상 Zoom)" />}
                {tbOn("pan") && <ModeBtn k="pan" label="Pan" title="좌드래그=이동 (중드래그 항상 Pan)" />}
                {tbOn("fit") && <ActBtn a="fit" label="Fit" title="화면 맞춤" />}
                {tbOn("inv") && <ActBtn a="invert" label="Inv" title="반전" on={panes[activePane].invert} />}
                {tbOn("rotL") && <ActBtn a="rotL" label="⟲90" title="좌회전" />}
                {tbOn("rotR") && <ActBtn a="rotR" label="⟳90" title="우회전" />}
                {tbOn("rot180") && <ActBtn a="rot180" label="⟳180" title="180도 회전" />}
                {tbOn("flipH") && <ActBtn a="flipH" label="⇋" title="좌우반전" />}
                {tbOn("flipV") && <ActBtn a="flipV" label="⇵" title="상하반전" />}
                {tbOn("cine") && <ActBtn a="cine" label={cine ? "■" : "▶"} title={`시네 재생 — 간격 ${tyCineSec}초 (설정>뷰어에서 변경)`} on={cine} />}
                {tbOn("cap") && <ActBtn a="capture" label="Cap" title="PNG 저장" />}
                {tbOn("reset") && <ActBtn a="reset" label="Reset" title="초기화 (W/L·확대·필터 포함)" />}
                {tbOn("sharpen") && <ActBtn a="sharpen" label="Shrp" title="Sharpen 필터 — 윤곽 선명화 (활성 페인 토글)" on={panes[activePane].fx === "sharpen"} />}
                {tbOn("average") && <ActBtn a="average" label="Avg" title="Average 필터 — 부드럽게(블러, 활성 페인 토글)" on={panes[activePane].fx === "smooth"} />}
                {tbOn("pseudo") && <ActBtn a="pseudo" label="Psd" title="Pseudo Color — 의사색 컬러맵 근사 (활성 페인 토글)" on={panes[activePane].fx === "pseudo"} />}
                {tbOn("mag") && (
                  <button title="확대경 — 마우스 위치를 따라다니는 3배 렌즈 (다시 누르면 해제)"
                          onClick={() => { recordUse("mag"); setMagOn((m) => { if (m) setMagPos(null); return !m; }); }}
                          style={{ padding: "6px 0", fontSize: 12, width: paletteHoriz ? 60 : "100%",
                                   background: magOn ? "var(--accent)" : undefined }}>
                    <TyInner id="mag" label={`Mag${magOn ? "●" : ""}`} />
                  </button>
                )}
              </>)}
              {k === "anno" && (<>
                {TOOL_DEFS.filter(([tk]) => tbOn(tk)).map(([tk, label, title]) => (
                  <button key={tk} title={title}
                          onClick={() => { recordUse(tk); pickTool(tk); }}
                          style={{ padding: "6px 0", fontSize: 12, width: paletteHoriz ? 60 : "100%",
                                   background: tool === tk ? "var(--accent)" : undefined }}>
                    <TyInner id={tk} label={label} />
                  </button>
                ))}
                {tbOn("ref") && (
                  <button title="Reference line — 활성 페인 평면을 다른 페인에 투영(scout)"
                          onClick={() => { recordUse("ref"); setRefOn((r) => !r); }}
                          style={{ padding: "6px 0", fontSize: 12, width: paletteHoriz ? 60 : "100%",
                                   background: refOn ? "var(--accent)" : undefined }}>
                    <TyInner id="ref" label={`Ref${refOn ? "●" : ""}`} />
                  </button>
                )}
                {tbOn("cursor3d") && (
                  <button title="3D Cursor — 클릭점을 다른 페인의 동일 3D 위치로 이동+십자 마커 (기하 정보 없으면 index 비율 근사)"
                          onClick={() => { recordUse("cursor3d"); setTool(tool === "cursor3d" ? null : "cursor3d"); setDraft(null); }}
                          style={{ padding: "6px 0", fontSize: 12, width: paletteHoriz ? 60 : "100%",
                                   background: tool === "cursor3d" ? "var(--accent)" : undefined }}>
                    <TyInner id="cursor3d" label="3DC" />
                  </button>
                )}
                {tbOn("ctr") && (detail.modality === "CR" || detail.modality === "DX") && (
                  <button title="AI 심흉비 자동계측 (S2) — 초안, 확정 아님" onClick={doCtr}
                          style={{ padding: "6px 0", fontSize: 12, width: paletteHoriz ? 60 : "100%",
                                   color: "var(--ai)", fontWeight: 700 }}>
                    <TyInner id="ctr" label="CTR" />
                  </button>
                )}
                {tbOn("save") && (
                  <button title="주석 서버 저장 (로밍)" onClick={saveAnnos}
                          style={{ padding: "6px 0", fontSize: 12, width: paletteHoriz ? 60 : "100%" }}>
                    <TyInner id="save" label="Save" />
                  </button>
                )}
                {tbOn("gsps") && (
                  <button title="GSPS 내보내기 — 주석·W/L 표준 저장(Orthanc)" onClick={doGsps}
                          style={{ padding: "6px 0", fontSize: 12, width: paletteHoriz ? 60 : "100%" }}>
                    <TyInner id="gsps" label="GSPS" />
                  </button>
                )}
                {tbOn("gsps") && (
                  <button title="타사 PR(GSPS) 불러오기 — 외부 주석을 녹색으로 표시" onClick={async () => {
                    try {
                      const r = await api.loadGsps(detail.id);
                      const ext = r.items.flatMap((it) => it.annotations.map((a) => ({ ...a, source: "external" as const })));
                      if (ext.length === 0) { alert("불러올 GSPS(PR)가 없습니다"); return; }
                      // 기존 외부 주석 교체(중복 방지) + 사용자/AI 주석 유지
                      setAnnos((p) => [...p.filter((x) => x.source !== "external"), ...ext]);
                      schedHist();
                    } catch (e) { alert(e instanceof Error ? e.message : "GSPS 불러오기 실패"); }
                  }} style={{ padding: "6px 0", fontSize: 12, width: paletteHoriz ? 60 : "100%" }}>
                    <TyInner id="gsps" label="PR↓" />
                  </button>
                )}
                {tbOn("rect") && (
                  <button title="HU ROI 통계 — 마지막 사각형/타원 ROI의 평균·최소·최대 HU" onClick={async () => {
                    const roi = [...annos].reverse().find((a) => (a.kind === "rect" || a.kind === "ellipse") && a.sop_uid);
                    if (!roi) { alert("먼저 사각형 또는 타원 ROI를 그리세요"); return; }
                    try {
                      const s = await api.roiStats(detail.id, { sop_uid: roi.sop_uid, kind: roi.kind, points: roi.points });
                      if (s.error) { alert(s.error); return; }
                      alert(`HU ROI 통계 (${s.count}px${s.area_mm2 ? `, ${s.area_mm2}mm²` : ""})\n평균 ${s.mean} · 최소 ${s.min} · 최대 ${s.max} · 표준편차 ${s.std} (${s.unit})`);
                    } catch (e) { alert(e instanceof Error ? e.message : "ROI 통계 실패"); }
                  }} style={{ padding: "6px 0", fontSize: 12, width: paletteHoriz ? 60 : "100%" }}>
                    <TyInner id="rect" label="HU" />
                  </button>
                )}
                {tbOn("del") && (
                  <button title="선택 주석 삭제(마퀴 다중선택 우선, 없으면 마지막 주석)"
                          onClick={() => { if (selAnnos) deleteSelAnnos(); else if (selAnno) deleteSelAnno(); else { setAnnos((p) => p.slice(0, -1)); schedHist(); } }}
                          style={{ padding: "6px 0", fontSize: 12, width: paletteHoriz ? 60 : "100%" }}>
                    <TyInner id="del" label="Del" />
                  </button>
                )}
                {tbOn("clr") && (
                  <button title="주석·셔터 전체 삭제 (In Viewer 🧹 동일 — 측정/주석/셔터 일괄)" onClick={() => {
                    if (window.confirm(`주석 ${annos.length}건과 셔터를 모두 삭제할까요? (저장 전이면 복구 불가)`)) {
                      setAnnos([]);
                      setDraft(null);
                      setSelAnno(null);
                      setCross3d({});   // 3D Cursor 마커도 함께 해제 (In clrAnno 동일)
                      setPanes((prev) => Object.fromEntries(
                        Object.entries(prev).map(([k, q]) => [k, { ...q, shutter: null }])));
                      schedHist();
                    }
                  }} style={{ padding: "6px 0", fontSize: 12, width: paletteHoriz ? 60 : "100%" }}>
                    <TyInner id="clr" label="Clr" />
                  </button>
                )}
              </>)}
              {k === "anatomy" && (<>
                {ANATOMY_TOOL_DEFS.filter(([tk]) => tbOn(tk)).map(([tk, label, title]) => (
                  <button key={tk} title={title}
                          onClick={() => { recordUse(tk); pickTool(tk); }}
                          style={{ padding: "6px 0", fontSize: 12, width: paletteHoriz ? 60 : "100%",
                                   background: tool === tk ? "var(--accent)" : undefined }}>
                    <TyInner id={tk} label={label} anatomy />
                  </button>
                ))}
              </>)}
              {k === "px" && (<>
                {PIXEL_TOOL_DEFS.filter(([tk]) => tbOn(tk)).map(([tk, label, title]) => (
                  <button key={tk} title={title}
                          onClick={() => { recordUse(tk); pickTool(tk); }}
                          style={{ padding: "6px 0", fontSize: 12, width: paletteHoriz ? 60 : "100%",
                                   background: tool === tk ? "var(--accent)" : undefined }}>
                    <TyInner id={tk} label={label} />
                  </button>
                ))}
              </>)}
              {k === "shut" && (<>
                {SHUTTER_TOOL_DEFS.filter(([tk]) => tbOn(tk)).map(([tk, label, title]) => (
                  <button key={tk} title={title}
                          onClick={() => { recordUse(tk); pickTool(tk); }}
                          style={{ padding: "6px 0", fontSize: 12, width: paletteHoriz ? 60 : "100%",
                                   background: tool === tk ? "var(--accent)" : undefined }}>
                    <TyInner id={tk} label={label} />
                  </button>
                ))}
              </>)}
              {k === "2d" && (<>
                <button title="All — W/L 프리셋을 모든 페인(전체 이미지)에 적용 (UBPACS All)"
                        onClick={() => setWlAll((a) => !a)}
                        style={{ padding: "6px 0", fontSize: 12, width: paletteHoriz ? 60 : "100%",
                                 background: wlAll ? "var(--accent)" : undefined, fontWeight: 700 }}>
                  <TyInner id="all" label={`All${wlAll ? "●" : ""}`} />
                </button>
                {prefs.wl_presets.map((pr) => (
                  <button key={pr.key} title={`W/L ${pr.q || "기본"} (Presetting — 설정>뷰어에서 편집)`}
                          onClick={() => applyWl(pr.q)}
                          style={{ padding: "6px 0", fontSize: 12, width: paletteHoriz ? 60 : "100%",
                                   background: panes[activePane].wl === pr.q ? "var(--accent)" : undefined }}>
                    <TyInner id="wl" label={pr.label} />
                  </button>
                ))}
              </>)}
              {k === "etc" && (<>
                {tbOn("ohif") && ohifOn && (
                  <button style={{ padding: "6px 4px", fontSize: 12, width: paletteHoriz ? 60 : "100%" }}
                          onClick={() => openViewer(detail.study_uid)}>
                    <TyInner id="ohif" label="OHIF" />
                  </button>
                )}
                {tbOn("3d") && (
                  <button title="내장 MPR/MIP — 현재 검사를 Axial/Sagittal/Coronal+MIP로 (새 창 없음)"
                          onClick={() => setMprOn((m) => !m)}
                          style={{ padding: "6px 4px", fontSize: 12, fontWeight: 700, width: paletteHoriz ? 60 : "100%",
                                   background: mprOn ? "var(--accent)" : undefined }}>
                    <TyInner id="mpr" label={`MPR${mprOn ? "●" : ""}`} />
                  </button>
                )}
                {tbOn("rfsh") && <ActBtn a="rfsh" label="Rfsh" title="Refresh Exam — 활성 검사 시리즈 재조회" />}
                {tbOn("comb") && <ActBtn a="comb" label="Comb" on={isCombined(panes[activePane])} title="Combine all — 현재 검사의 전체 영상 시리즈를 한 시리즈처럼 결합해 활성 페인에 연속 스크롤(다시 누르면 해제·원복). 썸네일을 페인에 끌어다 놓으면 Open/Combine/Combine all 선택" />}
                {tbOn("print") && <ActBtn a="print" label="Print" title="인쇄 — 현재 화면을 브라우저 인쇄(window.print)" />}
                {tbOn("calib") && <ActBtn a="calib" label="Calib" title="Calibrate — 현재 이미지 Pixel Spacing 정보 안내" />}
                {tbOn("key2d") && (
                  <button title="Key — 현재 이미지를 키이미지로 등록/해제 (워크리스트 🔑·Key Image View 연동)"
                          onClick={() => { recordUse("key2d"); toggleKeyImage(); }}
                          style={{ padding: "6px 0", fontSize: 12, width: paletteHoriz ? 60 : "100%" }}>
                    <TyInner id="key2d" label="Key" />
                  </button>
                )}
                {tbOn("media") && (
                  <button title="Media — 로컬 이미지(JPG/PNG/BMP)·동영상(AVI/MP4)을 활성 페인에 표시/재생"
                          onClick={() => { recordUse("media"); mediaInputRef.current?.click(); }}
                          style={{ padding: "6px 0", fontSize: 12, width: paletteHoriz ? 60 : "100%" }}>
                    <TyInner id="media" label="Media" />
                  </button>
                )}
                {tbOn("dict") && (
                  <button title={`음성 판독(STT) — 녹음/정지. 엔진: ${dict.engine === "browser" ? "브라우저" : dict.engine === "openai_api" ? "OpenAI" : "Whisper 로컬"} (설정>AI 기능). 전사 텍스트는 판독문에 삽입`}
                          onClick={() => { recordUse("dict"); toggleDictation(); }}
                          disabled={dict.busy}
                          style={{ padding: "6px 0", fontSize: 12, width: paletteHoriz ? 60 : "100%",
                                   background: dict.recording ? "var(--stat-emergency)" : dict.busy ? "var(--accent)" : undefined,
                                   color: dict.recording ? "#fff" : undefined }}>
                    <TyInner id="dict" label={dict.busy ? "전사…" : dict.recording ? "Rec●" : "Rec"} />
                  </button>
                )}
                {tbOn("dict") && (
                  <button title="Play Dictation — 이 검사의 녹음 재생"
                          onClick={playDictation}
                          style={{ padding: "6px 0", fontSize: 12, width: paletteHoriz ? 60 : "100%" }}>
                    <TyInner id="dictplay" label="Play" />
                  </button>
                )}
              </>)}
            </div>
          )}
        </div>
      ))}
      </div>
    </div>
  );

  /* 썸네일(방향·크기·모드 — 요청 2): series 모드=시리즈 카드+선택 전개 / all 모드=전체 개별 나열
     — 활성 페인의 '검사' 기준 목록: Exam 탭 전환 시 이전 환자 시리즈가 남는 버그 수정.
       Stack View 로 병합([중첩])된 검사는 병합 목록을 유지한다. */
  const activeUid = panes[activePane].studyUid || detail.study_uid;
  const thumbSeries = useMemo(() => {
    if (activeUid === detail.study_uid) return series;
    const tree = Object.values(priorTrees).find((t) => t.uid === activeUid);
    if (!tree || !tree.series.length) return series;
    const merged = tree.series.some((ts) => series.some((s) => s.series_uid === ts.series_uid));
    return merged ? series : tree.series;
  }, [activeUid, series, priorTrees, detail.study_uid]);
  const allInstances = useMemo(
    () => thumbSeries.flatMap((s) => s.instances.map((i, idx) => ({ s, i, idx }))),
    [thumbSeries],
  );
  // 숫자키(1~9)=시리즈 순번 선택 · ↑↓=이전/다음 시리즈 — 활성 페인에 표시(썸네일 순서 기준)
  seriesKeyRef.current = {
    sel: (n: number) => {
      const sN = thumbSeries[n];
      if (!sN) { setStatus(`Series ${n + 1} 없음 (총 ${thumbSeries.length}개)`); return; }
      patch(activePane, { ...initPane(uidOfSeries(sN.series_uid)), series: sN, index: 0 });
      setStatus(`Series ${n + 1} — S${sN.series_number} ${sN.series_desc || ""} (${sN.instances.length}장)`);
    },
    step: (d: 1 | -1) => {
      // 레이아웃 단위 그룹 이동 — 1×2 면 2개, 2×2 면 4개씩 다음/이전 시리즈 묶음을 페인들에 표시
      const vis = PANE_IDS.slice(0, LAYOUTS[layout].count);
      const q0 = panes[vis[0]];
      const refUid = q0?.series?.instances[q0.index]?.series_uid ?? q0?.series?.series_uid;
      let idx = thumbSeries.findIndex((x) => x.series_uid === refUid);
      if (idx < 0) idx = 0;
      const base = idx + d * vis.length;
      if (base < 0 || base >= thumbSeries.length) return;
      setPanes((prev) => {
        const next = { ...prev };
        vis.forEach((id, k) => {
          const sN = thumbSeries[base + k];
          if (sN) next[id] = { ...prev[id], ...initPane(uidOfSeries(sN.series_uid)), series: sN, index: 0 };
        });
        return next;
      });
      const last = Math.min(base + vis.length, thumbSeries.length);
      setStatus(`Series ${base + 1}${vis.length > 1 ? `~${last}` : ""} 표시 (↑↓ = ${vis.length}개씩 이동)`);
    },
  };
  // 단축키 디스패처 — 렌더마다 최신 클로저로 갱신(설정>단축키 재바인딩 대상 전체)
  scRunRef.current = (id: string) => {
    switch (id) {
      case "img_next": step(activePane, 1); break;
      case "img_prev": step(activePane, -1); break;
      case "series_next": seriesKeyRef.current.step(1); break;
      case "series_prev": seriesKeyRef.current.step(-1); break;
      case "cine": act("cine"); break;
      case "invert": act("invert"); break;
      case "rotate_r": act("rotR"); break;
      case "fit": act("fit"); break;
      case "crosslink": setXmode((x) => (x === "off" ? "auto_sync" : "off")); break;
      case "spatial":
        setSpatialSync((s0) => { setStatus(!s0 ? "Stack 동기: Spatial(DICOM 좌표 정합)" : "Stack 동기: Index(1:1)"); return !s0; });
        break;
      case "all_panes": setSelPanes(new Set(PANE_IDS.slice(0, LAYOUTS[layout].count))); break;
      case "del_anno":
        if (selAnnos) deleteSelAnnos();
        else if (selAnno) deleteSelAnno();
        else { setAnnos((pp) => pp.slice(0, -1)); schedHist(); }
        break;
      case "save": void saveAnnos(); break;
      case "refresh": act("rfsh"); break;
      case "img_first": patch(activePane, { index: 0 }); break;
      case "img_last": {
        const pl = panes[activePane]?.series?.instances.length ?? 0;
        if (pl > 0) patch(activePane, { index: pl - 1 });
        break;
      }
      case "rotate_l": act("rotL"); break;
      case "flip_h": act("flipH"); break;
      case "flip_v": act("flipV"); break;
      case "reset": act("reset"); break;
      case "zoom_in": updMany(targetsOf(activePane), (p) => ({ zoom: Math.min(20, p.zoom * 1.2) })); break;
      case "zoom_out": updMany(targetsOf(activePane), (p) => ({ zoom: Math.max(0.2, p.zoom * 0.8) })); break;
      case "maximize": setMaximized((m) => (m === null ? activePane : null)); break;
      case "overlay": toggleOverlay(); break;
      case "combine": act("comb"); break;
      case "key_image": void toggleKeyImage(); break;
      case "capture": act("capture"); break;
      case "print": act("print"); break;
      case "report_open":
        void (async () => {
          const r = await api.getSetting("viewer.prefs").catch(() => ({ value: {} }));
          const mon = (r.value as { monitor?: { report?: number | null } }).monitor?.report;
          const features = await screenFeatures(mon != null && mon >= 0 ? [mon] : null, "width=980,height=800");
          window.open(`${window.location.origin}${window.location.pathname}?report=1&study=${detail.id}`, "sv_report", features);
        })();
        break;
      case "m_scroll": setMouseMode("scroll"); break;
      case "m_select": setMouseMode("select"); break;
      case "m_zoom": setMouseMode("zoom"); break;
      case "m_pan": setMouseMode("pan"); break;
      case "m_wl": setMouseMode("wl"); break;
      case "t_mag": setMagOn((m) => { if (m) setMagPos(null); return !m; }); break;
      default:
        if (id.startsWith("t_")) pickTool(id.slice(2) as ToolKind);
    }
  };
  // 현재 표시 이미지의 원본 시리즈/SOP — Combine 결합본 스크롤 시 썸네일에서 위치 추적용
  const curInstAP = panes[activePane]?.series?.instances[panes[activePane].index];
  const curOriginUid = curInstAP?.series_uid ?? panes[activePane]?.series?.series_uid;
  // 휴대폰 촬영(QR) — 다이얼로그 + 업로드 폴링(완료 시 refreshExam → 새 시리즈 표시)
  const [qrCap, setQrCap] = useState<{ token: string; url: string; qr: string } | null>(null);
  // WASM 프레임 준비 알림 — 디코딩 완료 시 재렌더(blob URL 교체 반영)
  const [, setWasmTick] = useState(0);
  useEffect(() => onWasmFrame(() => setWasmTick((t) => t + 1)), []);
  useEffect(() => {
    if (!qrCap) return;
    const iv = setInterval(() => {
      api.mobileCaptureStatus(qrCap.token).then((st) => {
        if (st.done && st.uploaded > 0) {
          clearInterval(iv);
          setQrCap(null);
          void refreshExamRef.current?.();
          setStatus(`휴대폰 사진 ${st.uploaded}장 — 새 시리즈로 등록됨 (썸네일에서 확인)`);
        }
      }).catch(() => { clearInterval(iv); setQrCap(null); setStatus("촬영 세션 만료"); });
    }, 2500);
    return () => clearInterval(iv);
  }, [qrCap]);

  // 팔레트/썸네일 드래그 도킹 — 그립을 잡고 화면 가장자리 쪽으로 끌어 좌/우/상/하 위치 변경(계정 저장)
  const dockDragRef = useRef<{ kind: "palette" | "thumb"; sx: number; sy: number } | null>(null);
  const dockSide = (kind: "palette" | "thumb", side: "left" | "right" | "top" | "bottom") => {
    const key = kind === "palette" ? "paletteSide" : "thumbSide";
    setPrefs((p) => ({ ...p, [key]: side }));
    api.getSetting("viewer.prefs").then((r) =>
      api.putSetting("viewer.prefs", { ...r.value, [key]: side }, "user")).catch(() => {});
    setStatus(`${kind === "palette" ? "툴 팔레트" : "썸네일"} 위치 → ${side === "left" ? "왼쪽" : side === "right" ? "오른쪽" : side === "top" ? "상단" : "하단"} (계정 저장)`);
  };
  useEffect(() => {
    const up = (e: PointerEvent) => {
      const d = dockDragRef.current;
      if (!d) return;
      dockDragRef.current = null;
      if (Math.abs(e.clientX - d.sx) < 40 && Math.abs(e.clientY - d.sy) < 40) return;   // 실수 방지
      const W = window.innerWidth, H = window.innerHeight;
      const dist: [number, "left" | "right" | "top" | "bottom"][] = [
        [e.clientX, "left"], [W - e.clientX, "right"], [e.clientY, "top"], [H - e.clientY, "bottom"]];
      dist.sort((x, y) => x[0] - y[0]);
      dockSide(d.kind, dist[0][1]);
    };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 레이아웃에 표시 중인 모든 페인의 원본 시리즈 — 썸네일에서 주황 테두리(활성 페인은 초록)
  const shownOriginUids = new Set(PANE_IDS.slice(0, LAYOUTS[layout].count).map((id0) => {
    const q = panes[id0]; const ii = q?.series?.instances[q.index];
    return ii?.series_uid ?? q?.series?.series_uid;
  }).filter(Boolean) as string[]);
  // 썸네일 자동 스크롤 — 현재 이미지 타일(SOP 우선, 없으면 원본 시리즈 타일)이 항상 보이게 따라감
  const thumbsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const box = thumbsRef.current;
    if (!box) return;
    const el = (curInstAP?.sop_uid ? box.querySelector(`[data-sop="${CSS.escape(curInstAP.sop_uid)}"]`) : null)
      ?? (curOriginUid ? box.querySelector(`[data-suid="${CSS.escape(curOriginUid)}"]`) : null);
    (el as HTMLElement | null)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [curInstAP?.sop_uid, curOriginUid]);

  const thumbs = thumbOpen && (
    <div ref={thumbsRef} style={{
      display: "flex", flexDirection: thumbHoriz ? "row" : "column", gap: 4, padding: 4,
      background: "var(--bg-panel)", overflow: "auto", flexShrink: 0,
      ...(thumbHoriz ? { borderTop: "1px solid var(--border)", height: ts + 34 }
        : { width: ts + 34, ...(thumbRight ? { borderLeft: "1px solid var(--border)" }
                                           : { borderRight: "1px solid var(--border)" }) }),
    }}>
      {/* 위치 그립 — 드래그해서 화면 가장자리(좌/우/상/하)에 도킹 */}
      <div title="드래그로 썸네일 위치 이동 — 화면 왼쪽/오른쪽/위/아래로 끌어 놓으세요 (설정>뷰어에서도 지정 가능)"
           onPointerDown={(e) => { dockDragRef.current = { kind: "thumb", sx: e.clientX, sy: e.clientY }; }}
           style={{ cursor: "grab", textAlign: "center", fontSize: 10, color: "var(--text-secondary)",
                    padding: "1px 4px", flexShrink: 0, userSelect: "none",
                    position: "sticky", ...(thumbHoriz ? { left: 0 } : { top: 0 }), zIndex: 3,
                    background: "var(--bg-panel)" }}>⠿</div>
      {/* In-View 와 동일 위치 — 썸네일 열 맨 위 Combine 토글(결합 시 파란 강조 + ●) */}
      <button onClick={() => act("comb")}
              title="Combine all — 현재 검사의 전체 영상 시리즈를 한 시리즈처럼 결합해 활성 페인에 연속 스크롤(다시 누르면 해제·원복). 썸네일을 페인에 끌어다 놓으면 Open/Combine/Combine all 선택"
              style={{ fontSize: 10.5, flexShrink: 0,
                       // 썸네일 스크롤과 무관하게 항상 상단(세로)/좌측(가로) 고정
                       position: "sticky", ...(thumbHoriz ? { left: 0 } : { top: 0 }), zIndex: 3,
                       background: "var(--bg-panel)",
                       ...(isCombined(panes[activePane])
                ? { background: "#2563eb", color: "#fff", borderColor: "#2563eb", fontWeight: 700 } : {}) }}>
        Combine{isCombined(panes[activePane]) ? " ●" : ""}
      </button>
      {prefs.thumbMode === "series" ? thumbSeries.map((s) => (
        <div key={s.series_uid} style={{ flexShrink: 0 }}>
          <div draggable data-suid={s.series_uid}
               onDragStart={(e) => {
                 // 시리즈를 페인으로 드래그 — 드롭 시 해당 페인에 로드
                 e.dataTransfer.setData("application/x-sv-series", s.series_uid);
                 e.dataTransfer.effectAllowed = "copy";
               }}
               onClick={(e) => {
                 // In Viewer 정합 — 썸네일에서도 다중 선택: Ctrl=해당 시리즈 표시 페인 토글, Shift=처음~클릭 시리즈의 페인 범위
                 const vis = PANE_IDS.slice(0, LAYOUTS[layout].count);
                 if (e.ctrlKey) {
                   const pid2 = vis.find((id) => panes[id].series?.series_uid === s.series_uid);
                   if (pid2) setSelPanes((prev) => {
                     const n = new Set(prev.size ? prev : [activePane]);
                     if (n.has(pid2) && pid2 !== activePane) n.delete(pid2); else n.add(pid2);
                     return n;
                   });
                   return;
                 }
                 if (e.shiftKey) {
                   const idx = thumbSeries.findIndex((x) => x.series_uid === s.series_uid);
                   const uids = new Set(thumbSeries.slice(0, idx + 1).map((x) => x.series_uid));
                   setSelPanes(new Set(vis.filter((id) => {
                     const su = panes[id].series?.series_uid;
                     return !!su && uids.has(su);
                   })));
                   return;
                 }
                 // 3D(MPR/MIP) 모드 — 클릭한 시리즈로 볼륨 재구성(Axial/Sagittal/Coronal 소스 교체)
                 if (mprOn) {
                   setMprSeries(s.series_uid);
                   setStatus(`3D 볼륨 시리즈 전환 — S${s.series_number} ${s.series_desc || s.modality} (${s.instances.length}장)`);
                   return;
                 }
                 // 클릭 = 활성 페인에 이 시리즈 표시(교체) — 이미지 목록 펼침은 더블클릭
                 patch(activePane, { ...initPane(uidOfSeries(s.series_uid)), series: s, index: Math.floor(s.instances.length / 2) });
               }}
               onDoubleClick={() => setSelSeries(selSeries === s.series_uid ? null : s.series_uid)}
               title={`${s.series_desc || s.modality}\n· 클릭: 활성 페인에 표시 · 더블클릭: 이미지 목록 펼침/접기\n· 드래그 → 원하는 페인에 놓기 (Ctrl=페인 선택 토글 · Shift=범위 선택)`}
               style={{ border: selSeries === s.series_uid ? "2px solid var(--accent)"
                          : s.series_uid === curOriginUid ? "2px solid #4ade80"   // 활성 페인 표시 중
                          : shownOriginUids.has(s.series_uid) ? "2px solid #f97316"   // 다른 페인 표시 중
                          : "1px solid var(--border)",
                        borderRadius: 4, overflow: "hidden", cursor: "pointer", position: "relative", width: ts }}>
            {s.instances[Math.floor(s.instances.length / 2)] && (
              <img src={s.instances[Math.floor(s.instances.length / 2)].preview_url} alt="" loading="lazy" decoding="async"
                   style={{ width: ts, height: ts * 0.78, objectFit: "cover", display: "block" }} />
            )}
            {/* 키이미지 포함 시리즈 — 우상단 🔑 배지(뷰어 페인 KEY 마크와 동기) */}
            {(() => { const kn = s.instances.filter((i2) => keyMarks.has(i2.sop_uid)).length; return kn > 0 && (
              <div title={`키 이미지 ${kn}장`}
                   style={{ position: "absolute", top: 2, right: 2, padding: "0 4px", borderRadius: 6,
                            background: "rgba(250,204,21,0.94)", color: "#1a1a1a", fontSize: 8.5, fontWeight: 800 }}>
                🔑{kn > 1 ? kn : ""}
              </div>
            ); })()}
            <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, fontSize: 9,
                          background: "rgba(0,0,0,0.65)", padding: "1px 3px" }}>
              {seriesTag(s) && <div style={{ color: "#4ade80", fontWeight: 700, fontSize: 8.5, lineHeight: 1.1 }}>{seriesTag(s)}</div>}
              S{s.series_number}·{s.instances.length}장
            </div>
          </div>
          {selSeries === s.series_uid && (
            <div style={{ display: "flex", flexDirection: thumbHoriz ? "row" : "column", gap: 2, padding: 2 }}>
              {s.instances.slice(0, 60).map((inst, idx) => (
                <div key={inst.sop_uid} data-sop={inst.sop_uid} style={{ position: "relative", flexShrink: 0 }}>
                  <img src={inst.preview_url} alt="" loading="lazy" decoding="async" title={`Img ${inst.instance_number}${keyMarks.has(inst.sop_uid) ? " · 🔑 KEY" : ""}`}
                       onClick={() => patch(activePane, { studyUid: uidOfSeries(s.series_uid), series: s, index: idx })}
                       style={{ width: ts * 0.6, height: ts * 0.45, objectFit: "cover", borderRadius: 2, cursor: "pointer", display: "block",
                                border: inst.sop_uid === curInstAP?.sop_uid
                                  ? "2px solid #4ade80"   // 현재 표시 이미지(Combine 포함)
                                  : panes[activePane].series?.series_uid === s.series_uid && panes[activePane].index === idx
                                  ? "2px solid var(--anno-keyimage)"
                                  : keyMarks.has(inst.sop_uid) ? "2px solid rgba(250,204,21,0.9)" : "1px solid var(--border)" }} />
                  {/* 키이미지 — 우상단 🔑 미니 배지(뷰어 KEY 마크와 동기) */}
                  {keyMarks.has(inst.sop_uid) && (
                    <div style={{ position: "absolute", top: 1, right: 1, padding: "0 3px", borderRadius: 5, pointerEvents: "none",
                                  background: "rgba(250,204,21,0.94)", color: "#1a1a1a", fontSize: 8, fontWeight: 800 }}>🔑</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )) : allInstances.slice(0, 200).map(({ s, i, idx }) => (
        <div key={i.sop_uid} data-sop={i.sop_uid} style={{ position: "relative", flexShrink: 0 }}>
          <img src={i.preview_url} alt="" loading="lazy" decoding="async" title={`S${s.series_number} Img${i.instance_number}${keyMarks.has(i.sop_uid) ? " · 🔑 KEY" : ""}`}
               onClick={() => patch(activePane, { studyUid: uidOfSeries(s.series_uid), series: s, index: idx })}
               style={{ width: ts * 0.8, height: ts * 0.6, objectFit: "cover", borderRadius: 2, cursor: "pointer", display: "block",
                        border: i.sop_uid === curInstAP?.sop_uid ? "2px solid #4ade80"
                              : keyMarks.has(i.sop_uid) ? "2px solid rgba(250,204,21,0.9)" : "1px solid var(--border)" }} />
          {/* 키이미지 — 우상단 🔑 미니 배지(뷰어 KEY 마크와 동기) */}
          {keyMarks.has(i.sop_uid) && (
            <div style={{ position: "absolute", top: 1, right: 1, padding: "0 3px", borderRadius: 5, pointerEvents: "none",
                          background: "rgba(250,204,21,0.94)", color: "#1a1a1a", fontSize: 8, fontWeight: 800 }}>🔑</div>
          )}
        </div>
      ))}
    </div>
  );

  // 우클릭 컨텍스트 메뉴 항목 — 전부 기존 함수에 배선(초기 분석 §7 컨텍스트 메뉴)
  const buildCtxItems = (pid: string): CtxItem[] => {
    const pane = panes[pid];
    const presets = prefs.wl_presets?.length ? prefs.wl_presets : WL_PRESETS;
    return [
      { label: "좌드래그 도구", disabled: true },
      { label: "  Zoom", checked: mouseMode === "zoom", onClick: () => setMouseMode("zoom") },
      { label: "  Pan", checked: mouseMode === "pan", onClick: () => setMouseMode("pan") },
      { label: "  W-L", checked: mouseMode === "wl", onClick: () => setMouseMode("wl") },
      { label: "우드래그 도구", icon: "▸", children: [
        { label: "W/L", checked: rdragTool === "wl", onClick: () => setRdrag("wl") },
        { label: "Zoom", checked: rdragTool === "zoom", onClick: () => setRdrag("zoom") },
        { label: "Pan", checked: rdragTool === "pan", onClick: () => setRdrag("pan") },
      ] },
      { kind: "sep" },
      { label: "W/L 프리셋", icon: "▸", children: presets.map((p) => ({
        label: p.label, onClick: () => applyWl(p.q),
      })).concat([{ label: "반전(Invert)", onClick: () => act("invert") }]) },
      { label: "방향", icon: "▸", children: [
        { label: "좌 90°", onClick: () => act("rotL") },
        { label: "우 90°", onClick: () => act("rotR") },
        { label: "180°", onClick: () => act("rot180") },
        { label: "좌우 반전", onClick: () => act("flipH") },
        { label: "상하 반전", onClick: () => act("flipV") },
      ] },
      { label: "보기", icon: "▸", children: [
        { label: "Fit", onClick: () => act("fit") },
        { label: "1:1 (Reset Zoom)", onClick: () => updMany(targetsOf(pid), () => ({ zoom: 1, tx: 0, ty: 0 })) },
        { label: "Reset (전체)", onClick: () => act("reset") },
        { label: maximized === pid ? "최대화 해제" : "최대화", onClick: () => setMaximized((m) => (m === pid ? null : pid)) },
      ] },
      { kind: "sep" },
      { label: "Key Image 지정/해제", onClick: () => { setActivePane(pid); toggleKeyImage(); } },
      { label: "주석 저장", onClick: () => void saveAnnos() },
      { kind: "sep" },
      selAnnos
        ? { label: `선택 ${selAnnos.length}개 주석 지우기`, onClick: () => deleteSelAnnos() }
        : { label: selAnno ? "선택 주석 지우기" : "마지막 주석 지우기",
            onClick: () => { if (selAnno) deleteSelAnno(); else { setAnnos((pp) => pp.slice(0, -1)); schedHist(); } } },
      { label: "셔터 해제", onClick: () => patch(pid, { shutter: null }) },
      { label: "주석 전체 지우기", onClick: () => {
        if (!window.confirm(`주석 ${annos.length}건과 셔터를 모두 삭제할까요? (저장 전이면 복구 불가)`)) return;
        setAnnos([]); setDraft(null); setSelAnno(null); setSelAnnos(null); setMarquee(null); setCross3d({});
        setPanes((prev) => Object.fromEntries(Object.entries(prev).map(([k, q]) => [k, { ...q, shutter: null }])));
        schedHist();
      } },
      { kind: "sep" },
      { label: "마우스 조작", icon: "▸", children: IN_MOUSE_OPS.map((m) => ({
        label: `${m.key} · ${m.action}`, disabled: true,
      })) },
      { label: pane?.series ? `— ${pane.series.modality || ""} ${pane.series.series_desc || ""}`.slice(0, 40) : "", disabled: true },
    ];
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg-canvas)", zIndex: 200, display: "flex", flexDirection: "column" }}
         onContextMenu={(e) => e.preventDefault()}>
      {ctxMenu && (
        <ViewerContextMenu x={ctxMenu.x} y={ctxMenu.y} items={buildCtxItems(ctxMenu.pid)}
                           onClose={() => setCtxMenu(null)} />
      )}
      {/* 드롭 Circle Menu — 시리즈를 페인에 놓으면 Open/Combine/Combine all 선택(INFINITT Circle Menu 등가) */}
      {circle && (() => {
        const c = circle;
        const done = (fn: () => void) => { fn(); setCircle(null); };
        const btn = (label: string, desc: string, fn: () => void, primary = false) => (
          <button onClick={() => done(fn)} title={desc}
                  style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 12px",
                           fontSize: 12, background: primary ? "#1d4ed8" : "transparent",
                           color: "#e2e8f0", border: "none", borderBottom: "1px solid #1e293b", cursor: "pointer" }}>
            {label}<span style={{ color: "#64748b", marginLeft: 6, fontSize: 10.5 }}>{desc}</span>
          </button>
        );
        return (
          <div data-sv-rshield="" style={{ position: "fixed", inset: 0, zIndex: 300 }} onClick={() => setCircle(null)}
               onContextMenu={(e) => { e.preventDefault(); setCircle(null); }}>
            <div onClick={(e) => e.stopPropagation()}
                 style={{ position: "fixed", left: Math.min(c.x, window.innerWidth - 200), top: Math.min(c.y, window.innerHeight - 130),
                          width: 190, background: "#0b1220", border: "1px solid #334155", borderRadius: 8,
                          boxShadow: "0 6px 20px rgba(0,0,0,0.6)", overflow: "hidden" }}>
              <div style={{ padding: "5px 12px", fontSize: 10.5, color: "#7dd3fc", borderBottom: "1px solid #1e293b" }}>
                시리즈 드롭 — 동작 선택
              </div>
              {btn("Open", "이 페인에 표시(교체)", () => dropSeriesToPane(c.pid, c.uid), true)}
              {btn("Combine", "현재 시리즈에 이어붙임", () => combineInto(c.pid, c.uid))}
              {btn("Combine all", "검사 전체 시리즈 결합", () => combineAllInto(c.pid))}
            </div>
          </div>
        );
      })()}
      {/* Sharpen 필터 정의 (feConvolveMatrix — In Viewer 동일 커널) */}
      <svg width="0" height="0" style={{ position: "absolute" }}>
        <filter id="ty-sharpen">
          <feConvolveMatrix order="3" kernelMatrix="0 -1 0 -1 5 -1 0 -1 0" preserveAlpha="true" />
        </filter>
      </svg>
      {/* 상단 검사탭 바 */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px",
                    background: "var(--bg-panel)", borderBottom: "1px solid var(--border)" }}>
        <button onClick={() => requestClose()} style={{ fontWeight: 700 }}>WORKLIST</button>
        {/* 좌상단: Series Layout(뷰포트 분할) · Image Layout(페인 내 이미지 타일) — UBPACS p.14 */}
        <GridPicker label="Srs" max={10}
                    value={{ r: LAYOUTS[layout].rows, c: LAYOUTS[layout].cols }}
                    onPick={(v) => setLayout(`${v.r}x${v.c}`)} />
        <GridPicker label="Img" max={10} value={imgLay}
                    onPick={(v) => { setImgLay(v); patch(activePane, { il: v }); }} />
        {/* 오픈 검사 탭 — 좌→우로 쌓임. 클릭=활성 페인에 표시, ✕=닫기(주 검사로 복귀) */}
        <div style={{ display: "flex", gap: 2, alignSelf: "flex-end", overflowX: "auto", maxWidth: "55%" }}>
          {openTabs.map((t) => {
            const isActive = panes[activePane].studyUid === t.uid;
            return (
              <div key={t.id}
                   onClick={() => {
                     void loadIntoActive(t.id);
                     postStudySync(t.id, "viewer");  // Worklist·Reading 선택 동기
                   }}
                   title={t.id === detail.id ? "주 검사" : "클릭=활성 페인에 표시"}
                   style={{
                     display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap",
                     background: isActive ? "var(--accent)" : "var(--bg-elevated)",
                     color: isActive ? "#fff" : "var(--text-secondary)",
                     borderRadius: "4px 4px 0 0", padding: "4px 11px", fontSize: 11.5,
                     fontWeight: 600, cursor: "pointer", border: "1px solid var(--border)", borderBottom: "none",
                   }}>
                {t.label}
                <span title={t.id === detail.id ? "주 검사 닫기 = 뷰어 닫기" : "이 Exam 닫기"}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (t.id === detail.id) requestClose();
                        else closeTab(t.id);
                      }}
                      style={{ fontSize: 10, opacity: 0.75 }}>✕</span>
              </div>
            );
          })}
        </div>
        {status && <span style={{ fontSize: 11.5, color: "var(--stat-emergency)" }}>{status}</span>}
        <div style={{ flex: 1 }} />
        {/* 3D 뷰어(MPR/MIP) — 내장 Axial/Sagittal/Coronal + MIP 로 뷰포트 전환(재클릭 시 2D 복귀) */}
        <button title="3D 뷰어 — MPR(Axial/Sagittal/Coronal) + MIP 재구성 (CT/MR 볼륨). 다시 누르면 2D 복귀"
                onClick={() => setMprOn((m) => !m)}
                style={{ fontWeight: 800, padding: "3px 10px", marginRight: 4,
                         ...(mprOn ? { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" } : {}) }}>
          3D
        </button>
        {/* TY-3(1): 작업 히스토리 — ◀ Undo · ◯ 초기 상태 · ▶ Redo (시각조정+주석 스냅샷 최대 50) */}
        {tbOn("hist") && (
          <span style={{ display: "flex", gap: 2, alignItems: "center" }} data-hist-tick={histTick}>
            <button title="Undo — 이전 작업 상태로 (시각조정·주석 스냅샷)" onClick={() => histGo(-1)}
                    disabled={histIdx.current <= 0} style={{ padding: "3px 9px", fontWeight: 700 }}>◀</button>
            <button title="초기 상태로 되돌리기 — 모든 조정/주석을 처음으로" onClick={histReset}
                    disabled={histIdx.current < 0}
                    style={{ width: 26, height: 24, borderRadius: "50%", padding: 0,
                             display: "grid", placeItems: "center", fontSize: 11 }}>◯</button>
            <button title="Redo — 다음 작업 상태로" onClick={() => histGo(1)}
                    disabled={histIdx.current >= histRef.current.length - 1}
                    style={{ padding: "3px 9px", fontWeight: 700 }}>▶</button>
          </span>
        )}
        {/* TY-3(9): Compare — 같은 환자 과거검사 다중 선택 비교 (Related [+Add] 와 별개 진입점) */}
        {tbOn("cmp") && (
          <button title="Compare — 같은 환자의 과거검사를 골라 나란히 비교 (동기 스크롤 ON)"
                  onClick={() => { setCmpSel(new Set()); setCmpOpen(true); }}
                  style={{ fontWeight: 700, padding: "3px 8px" }}>
            <ToolIconTy id="cmp" size={15} flat={!tyIcon3d} />
          </button>
        )}
        {/* TY-3(7): 로컬 미디어 파일 선택 (팔레트 ETC>Media 버튼에서 오픈) */}
        <input ref={mediaInputRef} type="file" hidden
               accept="image/*,video/*,.bmp,.avi,.mpg,.mpeg,.mp4"
               onChange={(e) => {
                 const f = e.target.files?.[0];
                 if (!f) return;
                 const kind = f.type.startsWith("video") || /\.(avi|mpe?g|mp4|mov)$/i.test(f.name)
                   ? "video" as const : "image" as const;
                 // 같은 페인의 기존 미디어 URL은 교체 전에 해제(오브젝트 URL 누수 방지)
                 const old = panesRef.current[activePane]?.media?.url;
                 if (old) URL.revokeObjectURL(old);
                 patch(activePane, { media: { url: URL.createObjectURL(f), kind, name: f.name } });
                 e.target.value = "";
               }} />
        <button title="휴대폰 촬영 — QR 을 찍으면 카메라가 열리고, 업로드한 사진이 이 검사의 새 시리즈로 등록됩니다"
                onClick={() => { void (async () => {
                  try { setQrCap(await api.mobileCapture(detail.id, window.location.origin)); }
                  catch { setStatus("QR 세션 생성 실패"); }
                })(); }}>📱</button>
        <button onClick={() => setSettingsOpen(true)} title="설정 — 뷰어에서 바로 Setting 진입">Settings</button>
        <button title="Reading — 전용 판독 창(새 페이지) 열기 · 모니터 배치는 Setting>모니터"
                onClick={() => {
                  const rm = prefs.monitor?.report;
                  void screenFeatures(rm != null ? [rm] : null, "width=440,height=1020").then((features) => {
                    const w = window.open(
                      `${window.location.origin}${window.location.pathname}?report=1&study=${detail.id}`,
                      "sv_report", features);
                    w?.focus();
                  });
                }}>
          Reading
        </button>
        <button onClick={toggleOverlay} title="오버레이 표시 토글 (T+Del) · 글자 크기는 T+마우스스크롤 — 계정 저장">
          {overlayOn ? "INFO ●" : "INFO ○"}
        </button>
        <button onClick={closeAllTabs} className="primary"
                title={`All Close — 모든 Exam 탭을 닫고 뷰어 종료. 저장 동작: ${
                  prefs.close_mode === "ask" ? "항상 묻기"
                  : prefs.close_mode === "save_current" ? "현재 화면 저장"
                  : prefs.close_mode === "save_all" ? "전체 저장" : "저장 안 함"} (Setting>뷰어)`}
                style={{ fontWeight: 700 }}>
          All Close ✕
        </button>
      </div>

      {/* Study/Series Titlebar (UBPACS p.14·p.16 — Opened/Related/Series/HP 드롭다운) */}
      <div style={{
        display: "flex", gap: 8, alignItems: "center", padding: "2px 10px",
        background: "var(--bg-elevated)", borderBottom: "1px solid var(--border)",
        fontSize: 11, color: "var(--text-secondary)", flexShrink: 0,
      }}>
        <TitleMenu id="opened" icon="▤" title="Opened Study List — 열린 검사 전환 · 항목 ✕=그 Exam 탭만 닫기"
                   menu={menu} setMenu={setMenu}
                   items={openTabs.map((t) => ({
                     label: t.label,
                     sub: tabSub(t.id),
                     active: t.uid === panes[activePane].studyUid,
                     onClick: () => void loadIntoActive(t.id),
                     onClose: () => { if (t.id === detail.id) requestClose(); else closeTab(t.id); },
                   }))} />
        <TitleMenu id="related" icon="🗂" title="Related Study List — Open=활성 페인 비교 · +Add=현재 유지+중첩 로드"
                   menu={menu} setMenu={setMenu}
                   items={detail.related_exams.map((e) => ({
                     label: `${e.modality} · ${e.study_date} · ${e.study_desc}`,
                     sub: `${e.status} / ${detail.patient_key}`,
                     chip: STAT_COLOR[e.status] ?? "var(--stat-received)",
                     onClick: () => void loadPrior(e.id),
                     actions: [
                       { label: "Open", title: "활성 페인에 비교 로드 (1x1이면 자동 1x2)", onClick: () => void loadPrior(e.id) },
                       { label: "+Add", title: "현재 화면 유지 + 이 검사를 중첩 로드(Stack View)", onClick: () => void loadStack(e.id) },
                     ],
                   }))} />
        <TitleMenu id="series" icon="≣" title="Open Series — 시리즈 전환 (●=현재 시리즈)" menu={menu} setMenu={setMenu}
                   items={thumbSeries.map((s) => ({
                     label: `S${s.series_number} ${s.series_desc || s.modality} (${s.instances.length}장)`,
                     active: panes[activePane].series?.series_uid === s.series_uid,
                     onClick: () => patch(activePane, {
                       ...initPane(uidOfSeries(s.series_uid)), series: s, index: Math.floor(s.instances.length / 2),
                     }),
                   }))} />
        <TitleMenu id="hp" icon={`HP:${hpName}`} title="Hanging Protocol — 설정>행잉(HP)에서 규칙 관리" menu={menu} setMenu={setMenu}
                   items={[
                     { label: "기본 (HP 해제)", onClick: () => { setHpName("기본"); setImgLay({ r: 1, c: 1 }); setLayout("1x1"); } },
                     ...hpRules.map((r) => ({
                       label: `${r.name} — ${r.modality || "*"}/${r.body_part || "*"}/${r.projection || "*"} · S${r.s.r}×${r.s.c} I${r.i.r}×${r.i.c}${r.wl ? ` · W/L ${r.wl}` : ""}`,
                       onClick: () => applyHp(r),
                     })),
                   ]} />
        <span>[{panes[activePane].index + 1}/{panes[activePane].series?.instances.length ?? 0}]</span>
        <span style={{ color: "var(--text-primary)" }}>
          {detail.status.toUpperCase()}, {detail.patient_name}, {detail.modality}, {detail.study_date}, {detail.study_desc}
        </span>
        {panes[activePane].series && (
          <span>
            │ Srs:{panes[activePane].series!.series_number} {panes[activePane].series!.series_desc || panes[activePane].series!.modality}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {/* SaintView — In-View 크로스링크 바(체크박스)를 상태바에 통합. xmode 5모드 매핑 */}
        {skin === "saint" && (() => {
          const XB: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, fontSize: 11.5,
                                            whiteSpace: "nowrap", cursor: "pointer" };
          const linkOn = xmode !== "off";
          const syncSub = xmode === "auto_sync" || xmode === "sync_other";
          return (
            <span style={{ display: "flex", alignItems: "center", gap: 14, marginRight: 16 }}>
              <label style={XB} title="Crosslink — 페인 간 스크롤 동기 마스터(켜면 Auto Sync 기본)">
                <input type="checkbox" checked={linkOn}
                       onChange={(e) => setXmode(e.target.checked ? "auto_sync" : "off")} />Crosslink
              </label>
              <label style={{ ...XB, opacity: linkOn ? 1 : 0.45 }} title="같은 검사 페인끼리 스크롤 동기">
                <input type="checkbox" checked={xmode === "auto_sync"} disabled={!linkOn && !syncSub}
                       onChange={(e) => setXmode(e.target.checked ? "auto_sync" : "off")} />Auto Sync
              </label>
              <label style={{ ...XB, opacity: linkOn ? 1 : 0.45 }} title="다른 검사(과거검사 포함) 페인까지 스크롤 동기">
                <input type="checkbox" checked={xmode === "sync_other"} disabled={!linkOn && !syncSub}
                       onChange={(e) => setXmode(e.target.checked ? "sync_other" : "auto_sync")} />Sync With Other Exams
              </label>
              <label style={XB} title="Scout Line — 활성 페인 현재 이미지의 교차선을 다른 페인에 표시">
                <input type="checkbox" checked={xmode === "scout"}
                       onChange={(e) => setXmode(e.target.checked ? "scout" : "off")} />Scout Line
              </label>
              <label style={XB} title="All Lines — 활성 시리즈 전체 이미지의 교차선 표시(현재 이미지는 진하게)">
                <input type="checkbox" checked={xmode === "all_lines"}
                       onChange={(e) => setXmode(e.target.checked ? "all_lines" : "off")} />All Lines
              </label>
            </span>
          );
        })()}
        <span>Series {LAYOUTS[layout].rows}×{LAYOUTS[layout].cols} · Image {(panes[activePane]?.il ?? { r: 1, c: 1 }).r}×{(panes[activePane]?.il ?? { r: 1, c: 1 }).c} (활성 페인)</span>
      </div>

      {skin === "saint" && prefs.paletteSide === "top" && saintBar}
      {prefs.paletteSide === "top" && palette}
      {prefs.thumbSide === "top" && thumbs}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {prefs.paletteSide === "left" && palette}
        {skin === "saint" && prefs.paletteSide === "left" && saintBar}
        {skin !== "saint" && prefs.paletteSide === "left" && paletteOpen && (
          <Splitter dir="v" onEnd={persistViewerSizes}
                    onDrag={(dx) => setPrefs((p) => ({ ...p, paletteW: clampSz(p.paletteW + dx, 64, 240) }))} />
        )}
        {skin !== "saint" && !paletteOpen && prefs.paletteSide === "left" && (
          <button onClick={() => setPaletteOpen(true)} style={{ width: 18, borderRadius: 0, padding: 0 }}>▸</button>
        )}
        {prefs.thumbSide === "left" && thumbs}
        {prefs.thumbSide === "left" && thumbOpen && (
          <Splitter dir="v" onEnd={persistViewerSizes}
                    onDrag={(dx) => setPrefs((p) => ({ ...p, thumbSize: clampSz(p.thumbSize + dx, 48, 260) }))} />
        )}

        {/* 뷰포트 영역 — MPR 모드면 내장 3D(Axial/Sagittal/Coronal+MIP)로 전환 */}
        {mprOn ? (
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex" }}>
            <Suspense fallback={
              <div style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--text-secondary)" }}>
                MPR/MIP 로딩…
              </div>
            }>
              <Viewer3DEmbed studyUid={panes[activePane].studyUid || detail.study_uid}
                             seriesUid={mprSeries || undefined}
                             embedded onClose={() => { setMprOn(false); setMprSeries(""); }} />
            </Suspense>
          </div>
        ) : (
        <div ref={vpRef} style={{ flex: 1, display: "flex", flexDirection: "column",
                                  minWidth: 0, minHeight: 0, padding: 2 }}>
          {/* 최대화 시 그 페인만 전체 표시. 평시엔 행×열 flex — 페인 경계 Splitter 로 크기 조절 */}
          {(maximized !== null
            ? [[maximized]]
            : Array.from({ length: L.rows }, (_, ri) =>
                Array.from({ length: L.cols }, (_, ci) => PANE_IDS[ri * L.cols + ci]))
          ).map((rowPids, ri) => (
            <Fragment key={ri}>
              {ri > 0 && (
                <Splitter dir="h" onEnd={() => {}}
                          onDrag={(dy) => adjFr(setRowFr, ri - 1, dy, vpRef.current?.clientHeight ?? 600)} />
              )}
              <div style={{ display: "flex", flex: maximized !== null ? 1 : (rowFr[ri] ?? 1),
                            minHeight: 0, minWidth: 0 }}>
                {rowPids.map((pid, ci) => (
                  <Fragment key={pid}>
                    {ci > 0 && (
                      <Splitter dir="v" onEnd={() => {}}
                                onDrag={(dx) => adjFr(setColFr, ci - 1, dx, vpRef.current?.clientWidth ?? 800)} />
                    )}
                    <div style={{ flex: maximized !== null ? 1 : (colFr[ci] ?? 1),
                                  minWidth: 0, minHeight: 0, display: "flex" }}>
                      {renderPane(pid)}
                    </div>
                  </Fragment>
                ))}
              </div>
            </Fragment>
          ))}
        </div>
        )}

        {thumbRight && thumbOpen && (
          <Splitter dir="v" onEnd={persistViewerSizes}
                    onDrag={(dx) => setPrefs((p) => ({ ...p, thumbSize: clampSz(p.thumbSize - dx, 48, 260) }))} />
        )}
        {thumbRight && thumbs}
        {skin !== "saint" && paletteRight && paletteOpen && (
          <Splitter dir="v" onEnd={persistViewerSizes}
                    onDrag={(dx) => setPrefs((p) => ({ ...p, paletteW: clampSz(p.paletteW - dx, 64, 240) }))} />
        )}
        {skin === "saint" && prefs.paletteSide === "right" && saintBar}
        {paletteRight && palette}
        {skin !== "saint" && !paletteOpen && paletteRight && (
          <button onClick={() => setPaletteOpen(true)} style={{ width: 18, borderRadius: 0, padding: 0 }}>◂</button>
        )}
        {prefs.reportDock && !reportCollapsed && (
          <Splitter dir="v" onEnd={persistViewerSizes}
                    onDrag={(dx) => setPrefs((p) => ({ ...p, dockW: clampSz(p.dockW - dx, 180, 480) }))} />
        )}
        {/* 판독창 접기 버튼 — 오른쪽으로 숨김 */}
        {prefs.reportDock && !reportCollapsed && (
          <button title="판독창 숨기기 (오른쪽으로 접기)" onClick={() => setReportCollapsed(true)}
                  style={{ width: 16, padding: 0, borderRadius: 0, alignSelf: "stretch", fontSize: 12,
                           background: "var(--bg-elevated)", border: "none", borderLeft: "1px solid var(--border)" }}>▸</button>
        )}
        {/* 판독 도크 — 공유 컴포넌트 (리포트 로드/저장/승인/상용구/단축키 내장) */}
        {prefs.reportDock && !reportCollapsed && (
          <ReportDock detail={detail} width={prefs.dockW}
                      onLoadPrior={(id) => void loadPrior(id)} onStatus={setStatus} />
        )}
        {/* 접힘 상태 — 우측 세로 탭으로 다시 펼치기 */}
        {prefs.reportDock && reportCollapsed && (
          <button title="판독창 펼치기" onClick={() => setReportCollapsed(false)}
                  style={{ width: 24, padding: "8px 0", borderRadius: 0, alignSelf: "stretch",
                           writingMode: "vertical-rl", fontSize: 12, fontWeight: 700,
                           background: "var(--bg-elevated)", border: "none", borderLeft: "1px solid var(--border)" }}>◂ 판독</button>
        )}
      </div>
      {prefs.thumbSide === "bottom" && thumbs}
      {prefs.paletteSide === "bottom" && palette}
      {skin === "saint" && prefs.paletteSide === "bottom" && saintBar}
      {/* 휴대폰 촬영 QR 다이얼로그 */}
      {qrCap && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "grid", placeItems: "center", zIndex: 600 }}
             onMouseDown={(e) => { if (e.target === e.currentTarget) setQrCap(null); }}>
          <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10,
                        padding: 20, width: 340, textAlign: "center", display: "flex", flexDirection: "column", gap: 10 }}>
            <b style={{ fontSize: 14 }}>📱 휴대폰으로 사진 촬영</b>
            <img src={qrCap.qr} alt="QR" style={{ width: 220, height: 220, margin: "0 auto", background: "#fff", borderRadius: 8, padding: 6 }} />
            <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6 }}>
              휴대폰 카메라로 QR 을 찍으면 촬영 페이지가 열립니다.<br />
              촬영 → ⬆ 업로드하면 이 검사의 <b>새 시리즈</b>로 등록되고 뷰어에 자동 반영됩니다. (15분 유효)
            </div>
            <code style={{ fontSize: 10, wordBreak: "break-all", color: "var(--text-secondary)" }}>{qrCap.url}</code>
            <button onClick={() => setQrCap(null)}>닫기</button>
          </div>
        </div>
      )}
      {/* ── Profile — 두 점 선의 픽셀값 그래프 모달 (In Viewer 이식, ≈근사값) ── */}
      {profileData && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 500,
                      display: "grid", placeItems: "center" }}
             onMouseDown={(e) => { if (e.target === e.currentTarget) setProfileData(null); }}>
          <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8,
                        padding: 14, maxWidth: "90vw", maxHeight: "85vh", overflow: "auto" }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 8, gap: 10 }}>
              <b style={{ fontSize: 12.5 }}>📈 {profileData.title}</b>
              <button style={{ marginLeft: "auto" }} onClick={() => setProfileData(null)}>✕</button>
            </div>
            {(() => {
              const vals = profileData.vals;
              const W = 440, H = 150, PAD = 6;
              const mn = Math.min(...vals), mx = Math.max(...vals);
              const pl = vals.map((v, k) =>
                `${PAD + (k / Math.max(1, vals.length - 1)) * W},` +
                `${PAD + H - ((v - mn) / Math.max(1, mx - mn)) * H}`).join(" ");
              return (
                <>
                  <svg width={W + PAD * 2} height={H + PAD * 2}
                       style={{ background: "#000", border: "1px solid var(--border)", display: "block" }}>
                    <polyline points={pl} stroke="#facc15" strokeWidth={1.4} fill="none" />
                  </svg>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 6 }}>
                    min {mn.toFixed(0)} · max {mx.toFixed(0)} · {vals.length}표본
                    (≈근사값 — 렌더 8bit + W/L 역변환, 원본 픽셀 아님)
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}
      {/* ── 2D Table — 두 점 영역 픽셀값 표 모달 (In Viewer 이식, ≈근사값) ── */}
      {tableData && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 500,
                      display: "grid", placeItems: "center" }}
             onMouseDown={(e) => { if (e.target === e.currentTarget) setTableData(null); }}>
          <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8,
                        padding: 14, maxWidth: "90vw", maxHeight: "85vh", overflow: "auto" }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 8, gap: 10 }}>
              <b style={{ fontSize: 12.5 }}>▤ {tableData.title}</b>
              <button style={{ marginLeft: "auto" }} onClick={() => setTableData(null)}>✕</button>
            </div>
            <table style={{ borderCollapse: "collapse", fontSize: 10.5, fontFamily: "monospace" }}>
              <tbody>
                {tableData.rows.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((v, ci) => (
                      <td key={ci} style={{ border: "1px solid var(--border)", padding: "1px 5px",
                                            textAlign: "right", color: "var(--text-secondary)" }}>{v}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 6 }}>
              ≈근사값 — 렌더 8bit + W/L 역변환, 원본 픽셀 아님
            </div>
          </div>
        </div>
      )}
      {/* ── TY-3(9): Compare — 같은 환자 과거검사 다중 선택 → 나란히 비교 (In Compare 이식) ── */}
      {cmpOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 500,
                      display: "grid", placeItems: "center" }}
             onMouseDown={(e) => { if (e.target === e.currentTarget) setCmpOpen(false); }}>
          <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8,
                        width: "min(560px, 94vw)", maxHeight: "80vh", overflow: "auto", padding: 16 }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
              <b style={{ fontSize: 13 }}>⇄ Compare — {detail.patient_name} 의 과거검사</b>
              <button style={{ marginLeft: "auto" }} onClick={() => setCmpOpen(false)}>✕</button>
            </div>
            {(detail.related_exams ?? []).length === 0 && (
              <div style={{ fontSize: 12.5, color: "var(--text-secondary)", padding: 8 }}>
                이 환자의 과거검사가 없습니다.<br />
                다른 환자와 비교하려면 워크리스트의 <b>＋Add</b> 버튼을 사용하세요(명시적 비교 — 환자 혼합 방지).
              </div>
            )}
            {(detail.related_exams ?? []).map((re) => (
              <label key={re.id}
                     style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 6px",
                              borderRadius: 4, fontSize: 12.5, cursor: "pointer",
                              background: cmpSel.has(re.id) ? "var(--bg-elevated)" : undefined }}>
                <input type="checkbox" checked={cmpSel.has(re.id)}
                       onChange={(e) => setCmpSel((s) => {
                         const n = new Set(s);
                         if (e.target.checked) n.add(re.id); else n.delete(re.id);
                         return n;
                       })} />
                <span style={{ width: 78 }}>{re.study_date}</span>
                <span style={{ width: 36 }}>{re.modality}</span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {re.study_desc}
                </span>
                <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{re.status}</span>
              </label>
            ))}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
              <button className="primary" disabled={!cmpSel.size} onClick={() => void openCompare()}>
                비교 열기 ({cmpSel.size}건)
              </button>
              <button onClick={() => setCmpOpen(false)}>취소</button>
            </div>
          </div>
        </div>
      )}
      {closeDlg && (
        <CloseDialog onPick={(m, r) => void doClose(m, r)} onCancel={() => setCloseDlg(false)} />
      )}
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModalLazy
            role={localStorage.getItem("sv_role") ?? sessionStorage.getItem("sv_role") ?? "radiologist"}
            onClose={() => setSettingsOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}

/* 닫기 옵션 다이얼로그 — 체크박스 선택 시 해당 동작이 기본이 되어 다음부터 묻지 않음 (Setting>뷰어 저장) */
function CloseDialog({ onPick, onCancel }: {
  onPick: (mode: "save_current" | "save_all" | "discard", remember: boolean) => void;
  onCancel: () => void;
}) {
  const [chk, setChk] = useState<Record<string, boolean>>({});
  const Row = ({ mode, label, desc, primary }: {
    mode: "save_current" | "save_all" | "discard"; label: string; desc: string; primary?: boolean;
  }) => (
    <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
      <button className={primary ? "primary" : ""} onClick={() => onPick(mode, !!chk[mode])}
              style={{ flex: 1, textAlign: "left", padding: "8px 12px" }}>
        <b style={{ fontSize: 12.5 }}>{label}</b>
        <div style={{ fontSize: 11, color: primary ? undefined : "var(--text-secondary)", marginTop: 2 }}>{desc}</div>
      </button>
      <label title="체크하고 닫으면 다음부터 묻지 않고 이 동작으로 닫습니다 (Setting>뷰어>닫기 동작에서 변경)"
             style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 11, color: "var(--text-secondary)", flexShrink: 0 }}>
        <input type="checkbox" checked={!!chk[mode]}
               onChange={(e) => setChk((p) => ({ ...p, [mode]: e.target.checked }))} />
        기본으로
      </label>
    </div>
  );
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "grid", placeItems: "center", zIndex: 500 }}
         onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8,
                    width: 430, padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
        <b style={{ fontSize: 13 }}>뷰어 닫기 — 변경사항을 저장할까요?</b>
        <Row mode="save_current" primary label="현재 화면 저장하고 닫기"
             desc="현재 검사의 주석/측정을 서버에 저장합니다" />
        <Row mode="save_all" label="전체 화면 변경사항 저장하고 닫기"
             desc="주석/측정 저장 + 표시 상태(W/L·주석)를 GSPS로 Orthanc에 보존합니다" />
        <Row mode="discard" label="어떤 것도 저장하지 않고 닫기"
             desc="저장하지 않은 주석/측정은 사라집니다" />
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button onClick={onCancel}>취소 (계속 판독)</button>
        </div>
      </div>
    </div>
  );
}

/* 타이틀바 드롭다운 메뉴 (Opened/Related/Series/HP — UBPACS p.16)
   기능 강화: 히트영역·아이콘 약 1.4배, 항목 수 배지, 부제(modality·날짜)/상태 색 칩,
   항목별 ✕(Exam 탭 닫기)·[Open]/[+Add] 액션, 호버 하이라이트, Esc(뷰어 키 핸들러)·외부클릭 닫기 */
type TitleMenuItem = {
  label: string;
  sub?: string;                       // 부제 — modality · 검사일 등
  active?: boolean;                   // ● 현재 항목 표시
  chip?: string;                      // 상태 색 칩 (CSS 색상)
  onClick?: () => void;               // 항목 클릭 기본 동작
  onClose?: () => void;               // 항목별 ✕ — 그 Exam 탭만 닫기
  actions?: { label: string; title?: string; onClick: () => void }[];  // [Open]/[+Add]
};
function TitleMenu({ id, icon, title, items, menu, setMenu }: {
  id: "opened" | "related" | "series" | "hp";
  icon: string; title: string;
  items: TitleMenuItem[];
  menu: string | null;
  setMenu: (m: "opened" | "related" | "series" | "hp" | null) => void;
}) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const open = menu === id;
  // 외부 클릭 닫기 — Esc 는 뷰어 전역 키 핸들러가 menu 우선으로 처리
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, setMenu]);
  return (
    <span ref={wrapRef} style={{ position: "relative" }}>
      <button onClick={() => setMenu(open ? null : id)} title={title}
              style={{ padding: "3px 10px", fontSize: 15.5, display: "inline-flex", alignItems: "center",
                       gap: 5, background: open ? "var(--accent)" : undefined }}>
        {icon}
        <span style={{ fontSize: 10, fontWeight: 700, padding: "0 5px", borderRadius: 8, lineHeight: "14px",
                       background: open ? "rgba(255,255,255,0.25)" : "var(--bg-elevated)",
                       color: open ? "#fff" : "var(--text-secondary)", border: "1px solid var(--border)" }}>
          {items.length}
        </span>
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, zIndex: 360, minWidth: 280, maxHeight: 320,
          overflow: "auto", background: "var(--bg-elevated)", border: "1px solid var(--border)",
          borderRadius: 5, boxShadow: "0 6px 20px rgba(0,0,0,0.5)", padding: "3px 0",
        }}>
          {items.map((it, i) => (
            <div key={i}
                 onClick={() => { if (it.onClick) { it.onClick(); setMenu(null); } }}
                 style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 12px",
                          fontSize: 11.5, cursor: it.onClick ? "pointer" : "default", whiteSpace: "nowrap" }}
                 onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
                 onMouseLeave={(e) => (e.currentTarget.style.background = "")}>
              {it.chip && <span style={{ width: 8, height: 8, borderRadius: "50%", background: it.chip, flexShrink: 0 }} />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: it.active ? 700 : 400,
                              color: it.active ? "var(--text-primary)" : undefined }}>
                  {it.active ? "● " : ""}{it.label}
                </div>
                {it.sub && <div style={{ fontSize: 10, color: "var(--text-secondary)", marginTop: 1 }}>{it.sub}</div>}
              </div>
              {it.actions?.map((a, j) => (
                <button key={j} title={a.title}
                        onClick={(e) => { e.stopPropagation(); a.onClick(); setMenu(null); }}
                        style={{ fontSize: 10, padding: "1px 7px", flexShrink: 0 }}>
                  {a.label}
                </button>
              ))}
              {it.onClose && (
                <span title="이 Exam 탭만 닫기"
                      onClick={(e) => { e.stopPropagation(); it.onClose!(); }}
                      style={{ fontSize: 11, opacity: 0.7, cursor: "pointer", padding: "0 3px", flexShrink: 0 }}>✕</span>
              )}
            </div>
          ))}
          {items.length === 0 && (
            <div style={{ padding: "6px 12px", fontSize: 11, color: "var(--text-secondary)" }}>항목 없음</div>
          )}
        </div>
      )}
    </span>
  );
}

/* 주석 1건 SVG 도형 — 사용자=노랑, AI=보라(생성물 전용 색) */
function AnnoShape({ a, sx, sy, fs }: {
  a: Anno; sx: (v: number) => number; sy: (v: number) => number; fs: number;
}) {
  // 보라(#a78bfa)=AI 전용 · 녹색=타사 PR(GSPS 불러오기) · 노랑=사용자
  const color = a.source === "ai" ? "#a78bfa" : a.source === "external" ? "#67e8a0" : "#ffd54a";
  const sw = fs * 0.08;
  const pts = a.points;
  if (!pts?.length) return null;
  const P = (i: number) => ({ x: sx(pts[i][0]), y: sy(pts[i][1]) });
  const label = annoLabel(a);
  const mid = pts.length >= 2
    ? { x: (P(0).x + P(1).x) / 2, y: (P(0).y + P(1).y) / 2 }
    : P(0);
  let labelAt = mid;  // 라벨 기준점 — 해부학 도구는 케이스별로 재지정
  let shape: React.ReactNode = null;
  switch (a.kind) {
    case "length": case "line": case "ctr":
      if (pts.length < 2) return null;
      shape = <line x1={P(0).x} y1={P(0).y} x2={P(1).x} y2={P(1).y} stroke={color} strokeWidth={sw} />;
      break;
    case "arrow": {
      if (pts.length < 2) return null;
      const dx = P(1).x - P(0).x, dy = P(1).y - P(0).y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len, hs = fs * 0.6;
      shape = (
        <g stroke={color} strokeWidth={sw} fill="none">
          <line x1={P(0).x} y1={P(0).y} x2={P(1).x} y2={P(1).y} />
          <line x1={P(1).x} y1={P(1).y} x2={P(1).x - hs * (ux + uy * 0.5)} y2={P(1).y - hs * (uy - ux * 0.5)} />
          <line x1={P(1).x} y1={P(1).y} x2={P(1).x - hs * (ux - uy * 0.5)} y2={P(1).y - hs * (uy + ux * 0.5)} />
        </g>
      );
      break;
    }
    case "angle":
      if (pts.length < 3) return null;
      shape = <polyline points={pts.map((q) => `${sx(q[0])},${sy(q[1])}`).join(" ")}
                        stroke={color} fill="none" strokeWidth={sw} />;
      break;
    case "rect":
      if (pts.length < 2) return null;
      shape = <rect x={Math.min(P(0).x, P(1).x)} y={Math.min(P(0).y, P(1).y)}
                    width={Math.abs(P(1).x - P(0).x)} height={Math.abs(P(1).y - P(0).y)}
                    stroke={color} fill="none" strokeWidth={sw} />;
      break;
    case "ellipse":
      if (pts.length < 2) return null;
      shape = <ellipse cx={(P(0).x + P(1).x) / 2} cy={(P(0).y + P(1).y) / 2}
                       rx={Math.abs(P(1).x - P(0).x) / 2} ry={Math.abs(P(1).y - P(0).y) / 2}
                       stroke={color} fill="none" strokeWidth={sw} />;
      break;
    case "text":
      break;
    // ── TY-2 이식 (In Viewer 측정·주석·픽셀) ──
    case "poly":
      // 폴리라인 — 경로 길이(라벨=값), 끝점에 라벨
      if (pts.length < 2) return null;
      shape = <polyline points={pts.map((q) => `${sx(q[0])},${sy(q[1])}`).join(" ")}
                        stroke={color} fill="none" strokeWidth={sw} />;
      labelAt = P(pts.length - 1);
      break;
    case "circle": {
      // 원 — 중심(p0)→가장자리(p1), 반지름 라벨
      if (pts.length < 2) return null;
      const r = Math.hypot(P(1).x - P(0).x, P(1).y - P(0).y);
      shape = (
        <g stroke={color} strokeWidth={sw} fill="none">
          <circle cx={P(0).x} cy={P(0).y} r={r} />
          <circle cx={P(0).x} cy={P(0).y} r={sw * 1.2} fill={color} stroke="none" />
        </g>
      );
      labelAt = { x: P(0).x + r, y: P(0).y };
      break;
    }
    case "centerline": {
      // 중앙선 — 두 선(p0-p1, p2-p3)의 중점 연결(점선)
      if (pts.length < 4) return null;
      const m1 = { x: (P(0).x + P(1).x) / 2, y: (P(0).y + P(1).y) / 2 };
      const m2 = { x: (P(2).x + P(3).x) / 2, y: (P(2).y + P(3).y) / 2 };
      shape = (
        <g stroke={color} strokeWidth={sw} fill="none">
          <line x1={P(0).x} y1={P(0).y} x2={P(1).x} y2={P(1).y} />
          <line x1={P(2).x} y1={P(2).y} x2={P(3).x} y2={P(3).y} />
          <line x1={m1.x} y1={m1.y} x2={m2.x} y2={m2.y}
                strokeDasharray={`${fs * 0.5} ${fs * 0.35}`} />
        </g>
      );
      labelAt = { x: (m1.x + m2.x) / 2, y: (m1.y + m2.y) / 2 };
      break;
    }
    case "mctr":
      // 수동 심흉비 — 심장 폭(p0-p1) + 흉곽 폭(p2-p3), 라벨=CTR %(text)
      if (pts.length < 4) return null;
      shape = (
        <g stroke={color} strokeWidth={sw} fill="none">
          <line x1={P(0).x} y1={P(0).y} x2={P(1).x} y2={P(1).y} />
          <line x1={P(2).x} y1={P(2).y} x2={P(3).x} y2={P(3).y} />
        </g>
      );
      labelAt = P(3);
      break;
    case "box": {
      // 박스 메모 — 사각 + 제목(text)을 좌상단에
      if (pts.length < 2) return null;
      const bx = Math.min(P(0).x, P(1).x), by = Math.min(P(0).y, P(1).y);
      shape = <rect x={bx} y={by} width={Math.abs(P(1).x - P(0).x)} height={Math.abs(P(1).y - P(0).y)}
                    stroke={color} fill="none" strokeWidth={sw} />;
      labelAt = { x: bx, y: by };
      break;
    }
    case "spine":
      // Spine Label — 점 + 연번 라벨(text)
      shape = <circle cx={P(0).x} cy={P(0).y} r={fs * 0.22} fill={color} stroke="none" />;
      break;
    case "marking":
      // Marking — 짧은 표기(text)만 표시
      break;
    case "lens":
      // Lens — 십자 마커 + 근사 픽셀값(text, '≈')
      shape = (
        <g stroke={color} strokeWidth={sw} fill="none">
          <line x1={P(0).x - fs * 0.5} y1={P(0).y} x2={P(0).x + fs * 0.5} y2={P(0).y} />
          <line x1={P(0).x} y1={P(0).y - fs * 0.5} x2={P(0).x} y2={P(0).y + fs * 0.5} />
        </g>
      );
      break;
    // ── 해부학 측정 4종 ──
    case "cobb":
      // 두 실선(선1 p0-p1, 선2 p2-p3) 사이 예각
      if (pts.length < 4) return null;
      shape = (
        <g stroke={color} strokeWidth={sw} fill="none">
          <line x1={P(0).x} y1={P(0).y} x2={P(1).x} y2={P(1).y} />
          <line x1={P(2).x} y1={P(2).y} x2={P(3).x} y2={P(3).y} />
        </g>
      );
      labelAt = { x: (P(1).x + P(2).x) / 2, y: (P(1).y + P(2).y) / 2 };
      break;
    case "leg":
      // 좌(p0-p1)·우(p2-p3) 라인 + 끝점 표시
      if (pts.length < 4) return null;
      shape = (
        <g stroke={color} strokeWidth={sw} fill="none">
          <line x1={P(0).x} y1={P(0).y} x2={P(1).x} y2={P(1).y} />
          <line x1={P(2).x} y1={P(2).y} x2={P(3).x} y2={P(3).y} />
          {[0, 1, 2, 3].map((i) => (
            <circle key={i} cx={P(i).x} cy={P(i).y} r={sw * 1.3} fill={color} stroke="none" />
          ))}
        </g>
      );
      labelAt = { x: (P(1).x + P(3).x) / 2, y: (P(1).y + P(3).y) / 2 };
      break;
    case "pelvis":
      // 좌우 장골능 실선 + 수평 기준 점선(좌측 점 기준)
      if (pts.length < 2) return null;
      shape = (
        <g stroke={color} strokeWidth={sw} fill="none">
          <line x1={P(0).x} y1={P(0).y} x2={P(1).x} y2={P(1).y} />
          <line x1={P(0).x} y1={P(0).y} x2={P(1).x} y2={P(0).y}
                strokeDasharray={`${fs * 0.5} ${fs * 0.35}`} opacity={0.8} />
        </g>
      );
      break;
    case "spineCurve": {
      // 기준선(첫점→끝점, 점선) + 경유 폴리라인 + 최대 수직 편차 지점 마커
      if (pts.length < 3) return null;
      const A = P(0), B = P(pts.length - 1);
      const abx = B.x - A.x, aby = B.y - A.y;
      const ab2 = abx * abx + aby * aby || 1;
      let mi = 1, md = -1, fx2 = A.x, fy2 = A.y;
      for (let i = 1; i < pts.length - 1; i++) {
        const Q = P(i);
        const t = ((Q.x - A.x) * abx + (Q.y - A.y) * aby) / ab2;
        const px2 = A.x + t * abx, py2 = A.y + t * aby;
        const d = Math.hypot(Q.x - px2, Q.y - py2);
        if (d > md) { md = d; mi = i; fx2 = px2; fy2 = py2; }
      }
      shape = (
        <g stroke={color} strokeWidth={sw} fill="none">
          <line x1={A.x} y1={A.y} x2={B.x} y2={B.y}
                strokeDasharray={`${fs * 0.5} ${fs * 0.35}`} opacity={0.85} />
          <polyline points={pts.map((q) => `${sx(q[0])},${sy(q[1])}`).join(" ")} />
          <line x1={P(mi).x} y1={P(mi).y} x2={fx2} y2={fy2}
                strokeDasharray={`${fs * 0.25} ${fs * 0.2}`} />
          <circle cx={P(mi).x} cy={P(mi).y} r={fs * 0.3} strokeWidth={sw * 1.5} />
        </g>
      );
      labelAt = P(mi);
      break;
    }
    default:
      return null;
  }
  return (
    <g>
      {shape}
      {label && (
        <text x={labelAt.x + fs * 0.3} y={labelAt.y - fs * 0.3} fill={color} fontSize={fs}
              stroke="#000" strokeWidth={fs * 0.1} style={{ paintOrder: "stroke" }}>
          {label}
        </text>
      )}
    </g>
  );
}

function ov(pos: "tl" | "tr" | "bl" | "br", fontSize = 10.5): React.CSSProperties {
  return {
    position: "absolute", zIndex: 1, fontSize, lineHeight: 1.45, pointerEvents: "none",
    color: "var(--text-primary)", textShadow: "0 0 4px #000", padding: 5,
    ...(pos === "tl" ? { top: 0, left: 0 } : {}),
    ...(pos === "tr" ? { top: 0, right: 0, textAlign: "right" } : {}),
    ...(pos === "bl" ? { bottom: 0, left: 0 } : {}),
    ...(pos === "br" ? { bottom: 0, right: 0, textAlign: "right" } : {}),
  };
}
