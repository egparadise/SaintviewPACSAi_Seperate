// 설정 — INFINITT Setting options 패턴(좌측 트리 + 우측 페이지, 화면분석 §5)
import { useEffect, useRef, useState } from "react";
import { VIEWER_BASE, api, sttStatus, type AiQuality, type OrthancStatus, type PhraseRow, type SttStatus } from "../api";
import {
  COLUMN_DEFS, COL_FIND_MAP, DEFAULT_COLUMNS, DEFAULT_FIND_FIELDS, DEFAULT_SEARCH_BOX,
  FIND_FIELDS, FIND_ONLY_FIELDS, PhraseEditModal, REQ_DT_FMTS, SEARCH_SCOPE_FIELDS,
  SVINFI_PANELS, SVINFI_PANEL_LABEL, type ViewerKey,
} from "./Worklist";
import { GridPicker } from "../lib/GridPicker";
import { MediaPermPanel } from "../components/MediaPermPanel";
// UI 언어 — 지역 변수 t(트리 map 파라미터)와 충돌하므로 tr 로 들여온다
import { LANGS, coverage, setLang, t as tr, useLang } from "../lib/i18n";
import { DL_DEFAULTS, readDlPrefs, type DlPrefs } from "../lib/dlPrefs";
import { dlSupportReason, opfsLimitBytes, opfsUsage, opfsWipe, type DlUsage } from "../lib/opfsStore";
import { dlForgetDone, dlProgress, type DlProgress } from "../lib/dlScheduler";
import { dlInvalidateCache } from "../lib/dlCache";
import {
  BASIS_LABEL, DEFAULT_COMPARE, PERIODS, PERIOD_LABEL, readCompareCfg,
  type CompareBasisKind, type CompareCfg, type ComparePeriod,
} from "../lib/compareBasis";
import {
  HP_OPTION_FIELDS, HP_OPTION_ROW, HP_PART_FIELDS, HP_PART_FIELDS_UNAVAILABLE, HP_SLOTS, HP_SLOT_LABEL,
  HP_SLOT_UNIT_LABEL, fitHpCells, hpModalityOptions,
  hpPartFieldGaps, hpRuleOrder, hpScreensFromMonitors, hpSettingsMinWidth, hpSlotLabel, newHpRule,
  readHpDoc, readHpSlot,
  writeHpDoc, type HpCell, type HpPartField, type HpRule, type HpScreen, type HpSlotUnit,
} from "../lib/hangingProtocol";
import { CLIENT_VIEWERS, DEFAULT_CLIENT_VIEWER, DEFAULT_WL_PRESETS, HANG2D_MODS, TOOLBAR_DEFS, hang2dModLabel, hang2dViewerLabel, migrateHang2d, type Hang2dCell, type Hang2dPending, type WlPreset } from "../lib/viewerConfig";
import { IN_PALETTE } from "../lib/infiConfig";
import { DEFAULT_MG_CFG, MG_LAYOUTS, readMgCfg, type MgCfg } from "../lib/mgHang";
import { OverlayLayoutEditor } from "../components/OverlayLayoutEditor";
import { normCorners, type CornerMap } from "../lib/overlayFields";
import { screenApiIssue } from "../lib/screens";
import { SC_ACTIONS, SC_DEFAULTS, displayKey } from "../lib/shortcutDefs";
import { ToolIconTy } from "../components/ToolIconTy";
import { BUILD_DATE, PRODUCT_NAME, VENDOR, VERSION_LABEL } from "../lib/appVersion";
import { clearCrashLog, readCrashLog, type CrashEntry } from "../components/ErrorBoundary";
import { SpeedTestPanel } from "./SpeedTestPanel";
import { AnatomyIcon } from "../lib/anatomyIcons";
import { HospitalsPanel, ModalityPanel, OverviewPanel, ServerPanel, StoragePanel, UsersPanel } from "./admin/ServerAdmin";
import {
  FolderEditModal,
  FolderTreeEditor,
  folderSummary,
  loadTabs,
  loadTree,
  newId,
  saveTabs,
  saveTree,
  type TreeNode,
  type WorklistTab,
} from "./WorklistTree";

/** 05 Mode Profile — 백엔드 mode.profiles JSON 항목 (07 A.7 v1) */
interface ModeProfile {
  label?: string;
  worklist?: Record<string, unknown>;
  viewer?: Record<string, unknown>;
}

// 설정 스코프(단계별 분리): system(병원선택 화면) · hospital(자원관리 화면) · viewer(PACS Viewer)
export type SettingsScope = "system" | "hospital" | "viewer";
/** 파란 모던 폴더 아이콘 — 노란 이모지(📁) 대체 (뒷판+탭 진한 파랑, 앞판 밝은 파랑) */
function FolderIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={Math.round(size * 0.84)} viewBox="0 0 24 20"
         style={{ flexShrink: 0, display: "block" }}>
      <path d="M2 4 a2 2 0 0 1 2-2 h5.4 l2.3 2.6 h8.3 a2 2 0 0 1 2 2 v1.4 H2 Z" fill="#0284c7" />
      <rect x="2" y="7" width="20" height="11.5" rx="2" fill="#38bdf8" />
      <rect x="2" y="7" width="20" height="2.6" fill="#67d3fa" />
    </svg>
  );
}

/** 협진에서 **위임 가능한** capability — 백엔드 permissions.COLLAB_CAPS 와 같은 키.
 *  collab.viewport·collab.present 는 여기 없다: 화면 조작은 '발표자 1명' 축이라
 *  체크박스가 아니라 세션 중 [발표자 넘기기] 로 정한다.
 *  판독 수정·영상 삭제는 COLLAB_NEVER_DELEGATE 라 애초에 목록에 오를 수 없다. */
const COLLAB_CAP_ROWS: [string, string][] = [
  ["collab.annotate", "계측·주석 그리기 (세션 한정 — 판독에는 Master 채택 시에만 저장)"],
  ["collab.text", "텍스트·글쓰기 (세션 한정)"],
  ["collab.navigate", "검사 탭 전환·과거 검사 열기"],
];

// labelKey 가 있으면 표기는 i18n(tr)을 따른다 — label 은 한국어 원문이자 폴백.
const TREE: { key: string; label: string; labelKey?: string; admin?: boolean; scope: SettingsScope; parent?: string }[] = [
  // 시스템 — 서버 운영(시스템 관리자)
  { key: "server", label: "서버 (Server)", admin: true, scope: "system" },
  { key: "overview", label: "운영 현황 (감독)", admin: true, scope: "system" },
  { key: "hospitals", label: "병원 관리", admin: true, scope: "system" },
  { key: "users", label: "사용자 관리", admin: true, scope: "system" },
  { key: "storage", label: "저장·백업 (Storage)", admin: true, scope: "system" },
  { key: "servernet", label: "서버 네트워크", admin: true, scope: "system" },
  // 관리자에게는 사용자 설정 창에서도 노출 — Local Server 공유 루트(디렉토리) 설정 접근성
  { key: "servernet", label: "서버 네트워크 (공유 루트)", admin: true, scope: "viewer" },
  // 병원 — 병원별 배치 구성
  { key: "modality", label: "장비·수신 (Modality)", admin: true, scope: "hospital" },
  { key: "network", label: "네트워크 (DICOM)", scope: "hospital" },
  { key: "pdf", label: "판독서 PDF", admin: true, scope: "hospital" },
  { key: "ai", label: "AI 기능", admin: true, scope: "hospital" },
  // 뷰어 — 사용자/판독 환경
  { key: "env", label: "환경 (Environment)", labelKey: "nav.env", scope: "viewer" },
  { key: "worklist", label: "워크리스트", labelKey: "nav.worklist", scope: "viewer" },
  // 표기·순서 규약: SaintView → I-View → T-View (선택 뷰어·모드 프로파일 콤보와 동일)
  { key: "wlSaint", label: "SaintView", scope: "viewer", parent: "worklist" },
  { key: "wlIn", label: "I-View", scope: "viewer", parent: "worklist" },
  { key: "wlTy", label: "T-View", scope: "viewer", parent: "worklist" },
  { key: "report", label: "리포트", labelKey: "nav.report", scope: "viewer" },
  { key: "reading", label: "판독 (Reading)", labelKey: "nav.reading", scope: "viewer" },
  { key: "collab", label: "협진 (Co-Reading)", labelKey: "nav.collab", scope: "viewer" },
  // 뷰어 설정 3분리 — 공통(선택/모드/OHIF) · TY Viewer 전용 · In Viewer 전용 (키 이름은 기존 유지 — 로밍 호환)
  { key: "viewer", label: "뷰어 공통", labelKey: "nav.viewerCommon", scope: "viewer" },
  { key: "viewerSv", label: "SaintView", scope: "viewer", parent: "viewer" },
  { key: "viewerIn", label: "I-View", scope: "viewer", parent: "viewer" },
  { key: "viewerTy", label: "T-View", scope: "viewer", parent: "viewer" },
  { key: "monitor", label: "모니터 (Display)", labelKey: "nav.monitor", scope: "viewer" },
  { key: "shortcuts", label: "단축키 (Mouse·Key)", labelKey: "nav.shortcuts", scope: "viewer" },
  { key: "policy", label: "정책 (Policy)", labelKey: "nav.policy", scope: "viewer" },
  { key: "hp", label: "행잉 (HP)", labelKey: "nav.hp", scope: "viewer" },
  { key: "speed", label: "속도 측정 (Speed Test)", labelKey: "nav.speed", scope: "viewer" },
  // 정보 — 버전·적용일자·제조사(지속적인 버전 관리). 모든 scope 에서 접근 가능하도록 각 scope 에 배치
  { key: "about", label: "정보 (About)", labelKey: "nav.about", scope: "viewer" },
  { key: "about", label: "정보 (About)", scope: "system" },
  { key: "about", label: "정보 (About)", scope: "hospital" },
];
const SCOPE_TITLE: Record<SettingsScope, string> = {
  system: "시스템 설정", hospital: "병원 설정", viewer: "뷰어 설정",
};

// 사용 패턴 TOP10 표시용 — 툴 id → 표시 이름 (TY=TOOLBAR_DEFS, In=IN_PALETTE)
const TY_TOOL_LABEL: Record<string, string> = Object.fromEntries(
  TOOLBAR_DEFS.flatMap((s) => s.items.map((t) => [t.id, t.label])));
const IN_TOOL_LABEL: Record<string, string> = Object.fromEntries(
  IN_PALETTE.map((t) => [t.id, t.label.split(" — ")[0]]));

/** 자주 쓰는 툴 TOP10 (읽기 전용) + [기록 초기화] — ty_usage/infi_usage 표시 */
function UsageTop({ usage, labelOf, onReset }: {
  usage: Record<string, number>;
  labelOf: (id: string) => string;
  onReset: () => void;
}) {
  const top = Object.entries(usage).sort((a, b) => b[1] - a[1]).slice(0, 10);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text-secondary)" }}>
          {tr("자주 쓰는 툴 TOP10 (사용 횟수순)")}
        </span>
        <button style={{ padding: "1px 8px", fontSize: 11 }} onClick={onReset}>{tr("기록 초기화")}</button>
      </div>
      {top.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          {tr("기록 없음 — 뷰어에서 툴을 사용하면 집계됩니다.")}
        </div>
      ) : (
        <ol style={{ margin: 0, paddingLeft: 22, fontSize: 12,
                     display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 16px" }}>
          {top.map(([id, n]) => (
            <li key={id}>
              {tr(labelOf(id))} <span style={{ color: "var(--text-secondary)" }}>— {n}{tr("회")}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** SCP/SCU 장비 노드 (dicom.nodes — AE Title/IP/Port, 추가·삭제·확장 가능) */
interface DicomNode { name: string; role: "scu" | "scp" | "both"; ae_title: string; ip: string; port: number }

/** 2D 행잉 편집기 — 모달리티별 Series/Image 분할(공통·뷰어별 공용).
 *  ⚠ 모달리티 목록(HANG2D_MODS)·저장본 정리(migrateHang2d)는 규정과 같이 lib/viewerConfig.ts 에 있다.
 *     MG 는 그 목록에 없다 — 맘모는 언제나 '뷰어 공통' 단일 규정(표준 2×2 + 아래 mg_hang 전용 블록). */
function Hanging2dEditor({ map, onChange }: {
  map: Record<string, { s: string; i: string }>;
  onChange: (m: string, next: { s: string; i: string }) => void;
  // disabled 프롭은 '공통 우선' 양자택일 시절의 것 — 캐스케이드 규정(CLAUDE.md)에서 두 표가
  // 모두 읽히므로 '무시되는 표' 가 없다. 호출자 0 이 되어 삭제.
}) {
  const parseG = (s: string) => { const [r, c] = s.split("x").map(Number); return { r: r || 1, c: c || 1 }; };
  const gStr = (g: { r: number; c: number }) => `${g.r}x${g.c}`;
  return (
    <div>
      {HANG2D_MODS.map((m) => {
        const cur = map[m] ?? { s: "1x1", i: "1x1" };
        return (
          <div key={m} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
            <b style={{ width: 64, fontSize: 12 }}
               title={m === "*" ? tr("이 표에 행이 없는 나머지 모달리티에 적용 (같은 표 안에서만)") : undefined}>
              {tr(hang2dModLabel(m))}</b>
            <GridPicker label="Series" max={10} value={parseG(cur.s)} onPick={(g) => onChange(m, { ...cur, s: gStr(g) })} />
            <GridPicker label="Image" max={10} value={parseG(cur.i)} onPick={(g) => onChange(m, { ...cur, i: gStr(g) })} />
          </div>
        );
      })}
    </div>
  );
}

export function SettingsModal({ role, onClose, scope = "viewer" }: {
  role: string; onClose: () => void; scope?: SettingsScope;
}) {
  const isAdmin = role === "admin";
  const uiLang = useLang();   // 언어 변경 시 이 컴포넌트 전체가 다시 그려진다 (tr 반영)
  // 현재 스코프에서 보이는 탭만 (단계별 분리)
  const visibleTabs = TREE.filter((t) => t.scope === scope && (!t.admin || isAdmin));
  const [page, setPage] = useState<string>(visibleTabs[0]?.key ?? "");
  // 설정 창 크기 — 기본(860×580) ↔ 전체 화면 토글, 우하단 드래그로 자유 조절(resize:both)
  const [maxed, setMaxed] = useState(false);
  // 설정 창 드래그 이동(2026-08-10 사용자 확정) — 제목줄을 좌클릭한 채 끌면 이동.
  const [dragOff, setDragOff] = useState({ x: 0, y: 0 });
  const dragMove = (e: React.MouseEvent) => {
    if (maxed) return;                                    // 최대화 상태에선 이동 무의미
    const t = e.target as HTMLElement;
    if (t.closest("button, input, select, a, [data-nodrag]")) return;   // 헤더 안 컨트롤은 드래그 아님
    e.preventDefault();
    const sx = e.clientX - dragOff.x, sy = e.clientY - dragOff.y;
    const clampX = Math.round(window.innerWidth * 0.46), clampY = Math.round(window.innerHeight * 0.46);
    const move = (ev: MouseEvent) => setDragOff({
      x: Math.min(clampX, Math.max(-clampX, ev.clientX - sx)),
      y: Math.min(clampY, Math.max(-clampY, ev.clientY - sy)),
    });
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  const [treeW, setTreeW] = useState(190);   // 좌측 트리 폭 — 스플리터 드래그로 조절
  const [saved, setSaved] = useState("");

  // ── 상태 (페이지별) ──
  // 워크리스트 갱신 정책 — 기본 수동(SEARCH 를 눌러야 갱신). Live 도 동일하게 따른다.
  const [refreshMode, setRefreshMode] = useState<"manual" | "auto">("manual");
  const [refreshSec, setRefreshSec] = useState(10);
  const [defaultStatus, setDefaultStatus] = useState("");
  const [columns, setColumns] = useState<string[]>(DEFAULT_COLUMNS);
  // 뷰어별 워크리스트 컬럼 오버라이드 — null/undefined = 공통(columns) 사용
  const [wlBy, setWlBy] = useState<{ sv?: string[] | null; ty?: string[] | null; infi?: string[] | null }>({});
  // 뷰어별 패널 표시/숨김 오버라이드 (sv·infi) — 없으면 기본 전부 표시. ty 는 공통 wlPanels 사용
  const [wlPanelsBy, setWlPanelsBy] = useState<{ sv?: Record<string, boolean> | null; infi?: Record<string, boolean> | null }>({});
  const [findFields, setFindFields] = useState<string[]>(DEFAULT_FIND_FIELDS);
  // 통합 검색창 설정(2026-08-10) — 방식·범위·다중어 결합 + 의뢰일시 표시 형식
  const [sbMode, setSbMode] = useState<"text" | "ai">(DEFAULT_SEARCH_BOX.mode);
  const [sbFields, setSbFields] = useState<string[]>(DEFAULT_SEARCH_BOX.fields);
  const [sbOp, setSbOp] = useState<"and" | "or">(DEFAULT_SEARCH_BOX.op);
  const [reqDtFmt, setReqDtFmtState] = useState<string>(REQ_DT_FMTS[1]);
  const [dblAction, setDblAction] = useState<"viewer2d" | "ohif">("viewer2d");
  // 선택 뷰어 — Client Viewer 레지스트리(TY Viewer=현행 Viewer2D, Infi Viewer=개발 중)
  const [clientViewer, setClientViewer] = useState(DEFAULT_CLIENT_VIEWER);
  // In Viewer 표시 — 멀티선택 색, 오버레이 글자 크기/표시 (계정 로밍, 뷰어 T+스크롤/T+Del 연동)
  const [infSelColor, setInfSelColor] = useState("#d946ef");
  const [infOvlFont, setInfOvlFont] = useState(9.5);
  const [infOvlVisible, setInfOvlVisible] = useState(true);
  // In Viewer 툴바 사용자화(표시/숨김) + Modality 기본 레이아웃(행잉과 별도)
  const [infTb, setInfTb] = useState<Record<string, boolean>>({});
  // 팔레트 표시: 열 수(1/2/3)·이름 표시·아이콘 크기
  const [infToolCols, setInfToolCols] = useState(2);
  const [infToolLabels, setInfToolLabels] = useState(true);
  const [infToolSize, setInfToolSize] = useState(34);
  const [infCineSec, setInfCineSec] = useState(0.5);   // 시네 기본 간격(초)
  // In Viewer 신규 (viewer.prefs 키 계약) — ★Quick 행·사용 패턴 기록·판독 도크 기본 열림
  const [infQuickRow, setInfQuickRow] = useState(true);
  const [infUsageRec, setInfUsageRec] = useState(true);
  const [infUsage, setInfUsage] = useState<Record<string, number>>({});
  const [infUsageReset, setInfUsageReset] = useState(false);  // 초기화 눌렀을 때만 저장에 포함(뷰어 집계 덮어쓰기 방지)
  const [infRptDock, setInfRptDock] = useState(false);
  const [infScrollBar, setInfScrollBar] = useState(false);  // 페인 우측 이미지 위치 인디케이터(초록 바) — 기본 꺼짐
  // TY Viewer 신규 (viewer.prefs ty_* 키 계약) — 아이콘 크기/라벨/3D·★Quick·사용 패턴·오버레이 글자
  const [tyToolSize, setTyToolSize] = useState(51);   // 기본 3배 확대(구 17)
  const [tyToolCols, setTyToolCols] = useState(2);     // 툴 배열(열 수) — 기본 2X2
  const [tyToolLabels, setTyToolLabels] = useState(true);
  const [tyIcon3d, setTyIcon3d] = useState(true);
  const [tyQuickRow, setTyQuickRow] = useState(true);
  const [tyUsageRec, setTyUsageRec] = useState(true);
  const [tyUsage, setTyUsage] = useState<Record<string, number>>({});
  const [tyUsageReset, setTyUsageReset] = useState(false);
  const [tyOvlFont, setTyOvlFont] = useState(10.5);  // Viewer2D 기본(ov() 10.5px)과 일치 — 키 계약
  // TY 신규 키 계약 — ty_sel_color(멀티선택·활성 페인 테두리 색), ty_cine_sec(페인 시네 기본 간격 초)
  const [tySelColor, setTySelColor] = useState("#d946ef");
  const [tyCineSec, setTyCineSec] = useState(0.15);
  // In 신규 키 계약 — infi_close_mode(닫기 동작: 묻기/현재 저장/전체 저장/저장 안 함)
  const [infCloseMode, setInfCloseMode] = useState<"ask" | "save_current" | "save_all" | "none">("ask");
  const [ohifOn, setOhifOn] = useState(false);         // OHIF 아이콘 표시·동작 (기본 꺼짐)
  const [defLay, setDefLay] = useState<Record<string, { s: string; i: string }>>({});
  // Viewer2D 레이아웃 — Toolbar/Thumbnail 위치 (left/top/right — UBPACS p.14)
  const [paletteSide, setPaletteSide] = useState<"left" | "top" | "right" | "bottom">("left");
  const [thumbSide, setThumbSide] = useState<"left" | "bottom" | "right" | "top">("left");
  const [thumbSize, setThumbSize] = useState(128);
  const [thumbMode, setThumbMode] = useState<"series" | "all">("series");
  // 2D 행잉 — 모달리티별 {Series 분할, Image 분할}. 구 형식(문자열=Series만)은 로드 시 정규화.
  // h2dMap=공통(F-18 자리), h2dByViewer=뷰어별(sv/infi/ty). h2dCommonOn=공통 우선 적용 체크(기본 on).
  const [h2dMap, setH2dMap] = useState<Record<string, { s: string; i: string }>>({});
  const [h2dCommonOn, setH2dCommonOn] = useState(true);
  const [h2dByViewer, setH2dByViewer] = useState<Record<string, Record<string, { s: string; i: string }>>>({});
  // 저장본 정리(migrateHang2d) 결과 — 0보다 크면 **모달 상단 배너**로 띄운다.
  // ⚠ 배너를 '뷰어 공통 > 2D 행잉' 탭 안에 두면 다른 탭에서 OK 를 누른 사용자는 안내를 못 본 채
  //   확정하게 된다 = '조용히 바꾸지 않는다'가 거짓이 된다. 그래서 탭과 무관한 자리로 올렸다.
  const [h2dMigrated, setH2dMigrated] = useState(0);
  // 자동으로 옮기지 않은 값(옮기면 손대지 않은 다른 뷰어까지 바뀐다) — 모달리티·뷰어·값을 그대로 찍는다
  const [h2dPending, setH2dPending] = useState<Hang2dPending[]>([]);
  // 2D 행잉 표에 행이 없어 어떤 뷰어도 읽지 않는 구 infi_default_layout 키
  const [h2dDropped, setH2dDropped] = useState<string[]>([]);
  // 2D-MG — MG 좌우 사이 공기 여백 제거 모드(뷰어 3종 공통). viewer.prefs.mg_hang
  const [mgCfg, setMgCfg] = useState<MgCfg>(DEFAULT_MG_CFG);
  // 오류 기록(정보 탭) — 화면 백지화 원인이 새로고침으로 사라지지 않게 보관한 것
  const [crashes, setCrashes] = useState<CrashEntry[]>([]);
  // 영상 위 4모서리 오버레이 구성 — 모달리티별(viewer.prefs.overlay_by_modality)
  const [ovlCfg, setOvlCfg] = useState<Record<string, CornerMap>>({});
  // Live(원격 PACS 직결) 접속 설정 — 웹 서버 설정과 같은 자리에서 등록한다(워크리스트 팝업에만
  // 있던 것을 옮김). 비밀번호는 서버가 마스킹해 내려주므로 빈 칸이면 기존 값을 유지한다.
  const [lv, setLv] = useState<{ enabled: boolean; base_url: string; user_id: string;
                                 verify_ssl: boolean; has_password?: boolean }>(
    { enabled: false, base_url: "", user_id: "", verify_ssl: true });
  const [lvPw, setLvPw] = useState("");
  const [lvMsg, setLvMsg] = useState("");
  useEffect(() => {
    api.webpacsConfig().then((r) => setLv({
      enabled: !!r.value.enabled, base_url: r.value.base_url || "",
      user_id: r.value.user_id || "", verify_ssl: r.value.verify_ssl !== false,
      has_password: r.value.has_password,
    })).catch(() => {});
  }, []);
  useEffect(() => { setCrashes(readCrashLog()); }, []);
  const [reportDock, setReportDock] = useState(false);  // 판독 도크 기본 숨김
  // 비교(Compare) 설정 — viewer.prefs.compare (뷰어·openV2 가 소비). 편집은 판독(Reading) 탭.
  //  enabled=기능 on/off · multi_monitor=Viewer 모니터 2개+면 비교검사를 다음 모니터에(끝번→첫번 순환) · labels=M/S 녹색 라벨
  //  prior_mode=과거검사(History) 비교 표시 — "layout"(1:2 분할) / "monitor"(인접 모니터: 다음, 끝번이면 이전)
  const [cmpCfg, setCmpCfg] = useState<{ enabled: boolean; multi_monitor: boolean; labels: boolean;
                                         prior_mode: "layout" | "monitor" }>(
    { enabled: true, multi_monitor: true, labels: true, prior_mode: "layout" });
  const [hospital, setHospital] = useState("");
  const [department, setDepartment] = useState("");
  const [footer, setFooter] = useState("");
  const [autoGenerate, setAutoGenerate] = useState(true);
  // AI 판독 초안 마스터 스위치 — RAG Structured Report 개편 전까지 기본 보류(off)
  const [draftEnabled, setDraftEnabled] = useState(false);
  const [vision, setVision] = useState(false);
  // STT 엔진 (음성판독 — 브라우저/Whisper 오픈소스/상용 API)
  const [sttEngine, setSttEngine] = useState("browser");
  const [sttModel, setSttModel] = useState("");
  const [sttStat, setSttStat] = useState<SttStatus | null>(null);   // 서버 STT 설치/키 상태
  useEffect(() => { sttStatus().then(setSttStat).catch(() => {}); }, []);
  // 리포트 구성 (Report Composition)
  const [rptAiPanel, setRptAiPanel] = useState(true);
  const [rptAutoApply, setRptAutoApply] = useState(true);
  // 판독(Reading) 페이지 — 기본/단축키/템플릿 3탭 + 레포트 옵션(report.prefs)
  const [rdTab, setRdTab] = useState<"basic" | "shortcut" | "template">("basic");
  // 저장이 끝났는가 — 하단 버튼 라벨(Cancel ↔ 닫기)이 이 값을 따른다.
  const [dirtySaved, setDirtySaved] = useState(false);
  const [saving, setSaving] = useState(false);      // 저장 중 이중 클릭 방지
  // Compare 기준 — report.prefs.compare. 뷰어 3종이 이 값을 기본값으로 쓴다.
  // (이름이 cmpCfg 가 아닌 이유: 그 이름은 이미 Compare **표시 방식**(다중모니터·라벨) 설정이 쓴다)
  const [cmpBasis, setCmpBasis] = useState<CompareCfg>(DEFAULT_COMPARE);
  const [rdOpts, setRdOpts] = useState<Record<string, unknown>>({
    always_report_window: false, phrase_backup_min: 10,
    open_next_after_save: false, save_alert: false, auto_insert_prior: false,
    cvr_notice: false, sidebar_tab: "history", panel_tab: "shortcut",
    insert_pos: "end", key_save: "Ctrl+S", key_approve: "Ctrl+Shift+A", key_mic: "Ctrl+M",
  });
  // 뷰어 닫기 동작 (닫기 다이얼로그 "기본으로" 체크와 동일 설정)
  const [closeMode, setCloseMode] = useState<"ask" | "save_current" | "save_all" | "discard">("ask");
  // 모니터 설정 — 하드웨어 모니터 감지 후 뷰어 표시 모니터 선택(다중=스팬)
  const [monitors, setMonitors] = useState<{ label: string; w: number; h: number; primary: boolean }[]>([]);
  const [monitorSel, setMonitorSel] = useState<number[]>([]);   // 뷰어 모니터(다중=라운드로빈)
  const [maxOpen, setMaxOpen] = useState(0);                     // 최대 열 영상 수(라운드로빈 슬롯, 0=선택 전부)
  const [closeScope, setCloseScope] = useState<"all" | "current">("all");  // All Close 범위(전체/현재 모니터)
  // All Close 시 판독창(ReportWindow)도 함께 닫을지 — **기본 끔**. 판독 원고는 자동 저장이 없어
  // 임의로 닫으면 작성 중인 글이 날아간다(켜도 미저장 입력이 있으면 닫지 않는다 — lib/viewerClose).
  const [closeReport, setCloseReport] = useState(false);
  // 모니터별 ◀▶ 탐색 목록 = 배정된 워크리스트 탭의 필터 (monitorIndex → tabId, ""=전체)
  const [tabBinding, setTabBinding] = useState<Record<number, string>>({});
  // 워크리스트 탭 → 모니터 배치 예외(라운드로빈 대신 지정 모니터로 오픈). {tab: tabId, monitor}
  // 활성 워크리스트 탭에서 연 검사는 지정 모니터에 열린다(예: WORKLIST 2 → 3번).
  const [tabMonMap, setTabMonMap] = useState<{ tab: string; monitor: number }[]>([]);
  const [availTabs, setAvailTabs] = useState<WorklistTab[]>([]);   // 배정 드롭다운용 워크리스트 탭 목록
  useEffect(() => { loadTabs().then(setAvailTabs).catch(() => {}); }, []);
  const [wlMon, setWlMon] = useState<number | null>(null);      // 워크리스트 창
  const [rptMon, setRptMon] = useState<number | null>(null);    // 판독(Reading) 창
  const [monitorMsg, setMonitorMsg] = useState("");
  // 단축키(마우스·키) — 계정별 저장(viewer.prefs.shortcuts)
  const [scRdrag, setScRdrag] = useState<"wl" | "zoom" | "pan">("wl");
  const [scShiftR, setScShiftR] = useState<"zoomout" | "none">("zoomout");
  const [scKeys, setScKeys] = useState<Record<string, string>>({ ...SC_DEFAULTS });
  const [dropMenu, setDropMenu] = useState(false);  // 시리즈 드롭 동작 메뉴(기본 숨김=바로 Open)
  const [wasmPipe, setWasmPipe] = useState(false);  // WASM 디코딩 파이프라인(베타)
  // ── 영상 취득 모드(설정>환경) — Live(볼 때 받는다) / 다운로드(미리 받아 둔다) ──
  // ⚠ 이름 주의: sv_server_mode(local/web/live)·연동 3가지 모드(미러/Live/표준 DICOM)가 이미
  //   '모드'를 점유하고 있다. 이 항목은 **영상 취득 모드**이고 저장은 viewer.prefs.dl_* 이다.
  const [dl, setDl] = useState<DlPrefs>({ ...DL_DEFAULTS });
  const [dlUse, setDlUse] = useState<DlUsage | null>(null);
  // 실효 상한 — 설정값과 브라우저 할당량의 절반 중 작은 쪽(opfsLimitBytes). 사용량을 '몇 GB' 로만
  // 보여 주면 사용자는 자기가 적은 값(예: 20GB)을 기준으로 읽는데, 실제 축출은 실효 상한에서
  // 일어난다(할당량 4GB 면 실효 2GB). 비율을 함께 보여 줘야 '왜 벌써 지워지나'가 설명된다.
  const [dlLimit, setDlLimit] = useState(0);
  const [dlBusy, setDlBusy] = useState(false);
  const [dlProg, setDlProg] = useState<DlProgress | null>(null);
  const dlWhy = dlSupportReason();
  // 정책 — ◀(왼쪽) 버튼이 시간상 어느 방향으로 갈지 (워크리스트는 최신이 위)
  const [polNavLeft, setPolNavLeft] = useState<"past" | "recent">("past");
  const [quality, setQuality] = useState<AiQuality | null>(null);
  const [orthanc, setOrthanc] = useState<OrthancStatus | null>(null);
  // 05 Mode Profile — 백엔드 mode.profiles JSON (S7 applyMode)
  const [modeProfiles, setModeProfiles] = useState<Record<string, ModeProfile>>({});
  const [modeSel, setModeSel] = useState("");   // 현재 적용된 모드(viewer.prefs.mode_key) — 콤보에 표시
  // 협진(Co-Reading) — viewer.prefs.collab. 여기 값은 **기본값**이고, 세션 중에는
  // 협진 페이지에서 Master 가 사람마다 조정한 것이 최종이다.
  const [colCfg, setColCfg] = useState<{
    default_caps: string[]; auto_grant: boolean; cursor_labels: boolean;
    author_colors: boolean; follow_default: boolean; ice: string;
    close_action: "end" | "hide"; media_exclusive: boolean;   // 협진 창 동작(2026-08-10)
  }>({
    default_caps: ["collab.annotate", "collab.text"], auto_grant: false,
    cursor_labels: true, author_colors: true, follow_default: true, ice: "",
    close_action: "end", media_exclusive: true,
  });
  const [modeJson, setModeJson] = useState("");
  // UBPACS-Z Worklist 구성요소 표시/숨김 (Study List 제외 추가·삭제)
  const [wlPanels, setWlPanels] = useState<Record<string, boolean>>({
    orders: true, prior: true, compare: true, thumb: true, std: true, comment: true, report: true,
  });
  // 행잉 프로토콜(HP) 규칙 + 툴바 구성 + W/L 프리셋 (계정 로밍)
  const [hpRules, setHpRules] = useState<HpRule[]>([]);
  // 사양 2 — 사용자가 추가한 장비명(프리셋 DX/DR/CR/MG/US/CT/MR 외). viewer.hp.modalities 로 로밍.
  const [hpMods, setHpMods] = useState<string[]>([]);
  const [tbConfig, setTbConfig] = useState<Record<string, boolean>>({});
  const [wlPresets, setWlPresets] = useState<WlPreset[]>(DEFAULT_WL_PRESETS);
  // 판독(Reading) — 내 서명 정보(확정 시 리포트에 기록)
  const [profName, setProfName] = useState("");
  const [profLicense, setProfLicense] = useState("");
  const [profMajor, setProfMajor] = useState("");   // 전문의 번호(2026-08-10) — A 자동 채움, 없으면 공란
  const [chipDays, setChipDays] = useState<number>(Number(localStorage.getItem("sv_chip_days") || 30));
  // 기기 프로필(2026-08-10 사용자 확정) — 계정당 3슬롯. 장비 의존 설정(모니터·패널 크기)의 슬롯 목록
  const [devices, setDevices] = useState<{ id: string; slot: number; label: string;
                                           screen?: string; last_seen?: string }[] | null>(null);
  useEffect(() => {
    api.deviceSlots().then((r) => setDevices(r.devices)).catch(() => setDevices([]));
  }, []);
  // DICOM 노드 (SCP/SCU) — 전역/관리자
  const [nodes, setNodes] = useState<DicomNode[]>([]);
  const [nodeMsg, setNodeMsg] = useState("");
  // 서버 네트워크 — 로컬 공유 디렉토리 + 웹서버(IP/Port/Name/AET) + 연결 테스트
  const [snDir, setSnDir] = useState("");
  const [snWeb, setSnWeb] = useState({ ip: "", port: "", dicom_port: "", name: "", ae_title: "" });
  const [snMsg, setSnMsg] = useState("");
  // 공유 디렉토리 존재 여부 뱃지(초록 '존재함'/주황 '경로 없음') + 폴더 찾기 모달
  const [snDirExists, setSnDirExists] = useState<boolean | null>(null);
  const [fsPickerOpen, setFsPickerOpen] = useState(false);
  // 상용구 관리 (DB 테이블)
  const [phrases, setPhrases] = useState<PhraseRow[]>([]);
  const [phraseModal, setPhraseModal] = useState<PhraseRow | "new" | null>(null);
  // UBPACS-Z: 워크리스트 페이지 탭 + 검색 폴더 트리 (워크리스트 화면과 동일 데이터)
  const [wlTabs, setWlTabs] = useState<WorklistTab[]>([]);
  const [wlTree, setWlTree] = useState<TreeNode[]>([]);
  const [selTreeId, setSelTreeId] = useState<string | null>(null);
  const [tabModal, setTabModal] = useState<{ index: number } | "add" | null>(null);

  useEffect(() => {
    api.getSetting("worklist.prefs").then((r) => {
      const bv = (r.value as { by_viewer?: { sv?: string[] | null; ty?: string[] | null; infi?: string[] | null } }).by_viewer;
      if (bv) setWlBy(bv);
      const pbv = (r.value as { panels_by_viewer?: { sv?: Record<string, boolean> | null; infi?: Record<string, boolean> | null } }).panels_by_viewer;
      if (pbv) setWlPanelsBy(pbv);
      const v = r.value as {
        auto_refresh_sec?: number; refresh_mode?: string; default_status?: string; columns?: string[];
        find_fields?: string[]; dbl_action?: "viewer2d" | "ohif";
      };
      // 구 설정 이관 — Worklist.tsx 와 **같은 규칙**이어야 화면과 설정이 어긋나지 않는다:
      //   refresh_mode 없음 + auto_refresh_sec 없음/0 → 수동, >0 → 자동 그 초
      if (v.refresh_mode === "auto" || v.refresh_mode === "manual") {
        setRefreshMode(v.refresh_mode);
        if (v.auto_refresh_sec) setRefreshSec(v.auto_refresh_sec);
      } else if (v.auto_refresh_sec) {
        setRefreshMode("auto");
        setRefreshSec(v.auto_refresh_sec);
      } else {
        setRefreshMode("manual");
      }
      setDefaultStatus(v.default_status ?? "");
      if (v.columns?.length) setColumns(v.columns.filter((c) => COLUMN_DEFS[c]));
      if (v.find_fields?.length) setFindFields(v.find_fields.filter((c) => FIND_FIELDS[c]));
      {  // 검색창 설정 + 의뢰일시 형식
        const sb = (v as { search_box?: { mode?: string; fields?: string[]; op?: string } }).search_box;
        if (sb?.mode === "ai" || sb?.mode === "text") setSbMode(sb.mode);
        if (sb?.fields?.length) setSbFields(sb.fields.filter((f) => SEARCH_SCOPE_FIELDS[f]));
        if (sb?.op === "or" || sb?.op === "and") setSbOp(sb.op);
        const fmt = (v as { req_dt_fmt?: string }).req_dt_fmt;
        if (fmt && (REQ_DT_FMTS as readonly string[]).includes(fmt)) setReqDtFmtState(fmt);
      }
      if (v.dbl_action) setDblAction(v.dbl_action);
      const pn = (v as { panels?: Record<string, boolean> }).panels;
      if (pn) setWlPanels((prev) => ({ ...prev, ...pn }));
      const nl = (v as { nav_left?: "past" | "recent" }).nav_left;
      if (nl) setPolNavLeft(nl);
    }).catch(() => {});
    api.getSetting("viewer.prefs").then((r) => {
      const v = r.value as {
        hanging?: Record<string, string>; hanging2d?: Record<string, string | { s: string; i: string }>;
        paletteSide?: "left" | "top" | "right" | "bottom"; thumbSide?: "left" | "bottom" | "right" | "top";
        thumbSize?: number; thumbMode?: "series" | "all"; reportDock?: boolean;
      };
      const cv = (v as { client_viewer?: string }).client_viewer;
      if (cv && CLIENT_VIEWERS.some((x) => x.id === cv)) setClientViewer(cv);
      const cmp = (v as { compare?: Partial<{ enabled: boolean; multi_monitor: boolean; labels: boolean;
                                              prior_mode: "layout" | "monitor" }> }).compare;
      if (cmp) setCmpCfg((p) => ({ ...p, ...cmp }));
      const mk = (v as { mode_key?: string }).mode_key;
      if (mk) setModeSel(mk);
      const col = (v as { collab?: Partial<typeof colCfg> }).collab;
      if (col) setColCfg((p) => ({ ...p, ...col }));
      const iv = v as { infi_sel_color?: string; infi_overlay_font?: number; infi_overlay_visible?: boolean;
                        infi_toolbar?: Record<string, boolean>;
                        infi_default_layout?: Record<string, { s?: { r: number; c: number } | null;
                                                               i?: { r: number; c: number } | null }> };
      if (iv.infi_sel_color) setInfSelColor(iv.infi_sel_color);
      if (iv.infi_overlay_font) setInfOvlFont(iv.infi_overlay_font);
      if (iv.infi_overlay_visible !== undefined) setInfOvlVisible(iv.infi_overlay_visible);
      if (iv.infi_toolbar) setInfTb(iv.infi_toolbar);
      const tv = v as { infi_tool_cols?: number; infi_tool_labels?: boolean; infi_tool_size?: number;
                        infi_cine_sec?: number };
      if (tv.infi_tool_cols) setInfToolCols(tv.infi_tool_cols);
      if (tv.infi_tool_labels !== undefined) setInfToolLabels(tv.infi_tool_labels);
      if (tv.infi_tool_size) setInfToolSize(tv.infi_tool_size);
      if (tv.infi_cine_sec) setInfCineSec(tv.infi_cine_sec);
      const nf = v as { infi_quick_row?: boolean; infi_usage_rec?: boolean;
                        infi_usage?: Record<string, number>; infi_report_dock?: boolean };
      if (nf.infi_quick_row !== undefined) setInfQuickRow(nf.infi_quick_row);
      if (nf.infi_usage_rec !== undefined) setInfUsageRec(nf.infi_usage_rec);
      if (nf.infi_usage) setInfUsage(nf.infi_usage);
      if (nf.infi_report_dock !== undefined) setInfRptDock(nf.infi_report_dock);
      const sb = (v as { infi_scrollbar?: boolean }).infi_scrollbar;
      if (sb !== undefined) setInfScrollBar(sb);
      const ty = v as { ty_tool_size?: number; ty_tool_labels?: boolean; ty_icon_3d?: boolean;
                        ty_quick_row?: boolean; ty_usage_rec?: boolean;
                        ty_usage?: Record<string, number>; ty_overlay_font?: number };
      if (ty.ty_tool_size && ty.ty_tool_size !== 17) setTyToolSize(ty.ty_tool_size);  // 구 기본 17→새 기본 51 승격
      if (ty.ty_tool_labels !== undefined) setTyToolLabels(ty.ty_tool_labels);
      if (ty.ty_icon_3d !== undefined) setTyIcon3d(ty.ty_icon_3d);
      if (ty.ty_quick_row !== undefined) setTyQuickRow(ty.ty_quick_row);
      if (ty.ty_usage_rec !== undefined) setTyUsageRec(ty.ty_usage_rec);
      if (ty.ty_usage) setTyUsage(ty.ty_usage);
      if (ty.ty_overlay_font) setTyOvlFont(ty.ty_overlay_font);
      // 신규 키 로드 — 뷰어 소비 코드와 동일 범위로 정규화(Viewer2D clamp 0.05~, ViewerInfi 값 검증)
      const ty2 = v as { ty_sel_color?: string; ty_cine_sec?: number };
      if (ty2.ty_sel_color) setTySelColor(ty2.ty_sel_color);
      if (ty2.ty_cine_sec) setTyCineSec(Math.min(5, Math.max(0.05, ty2.ty_cine_sec)));
      const icm = (v as { infi_close_mode?: "ask" | "save_current" | "save_all" | "none" }).infi_close_mode;
      if (icm && ["ask", "save_current", "save_all", "none"].includes(icm)) setInfCloseMode(icm);
      setOhifOn(!!(v as { ohif_enabled?: boolean }).ohif_enabled);
      setWasmPipe(!!(v as { wasm_pipeline?: boolean }).wasm_pipeline);
      setDl(readDlPrefs(v));
      if (v.paletteSide) setPaletteSide(v.paletteSide);
      if (v.thumbSide) setThumbSide(v.thumbSide);
      if (v.thumbSize) setThumbSize(v.thumbSize);
      if (v.thumbMode) setThumbMode(v.thumbMode);
      // 2D 행잉 — 공통/체크/뷰어별 + 구 infi_default_layout 을 한 블록에서 확정한다.
      // 따로 setState 하면 마이그레이션이 체크 상태를 못 보고 굳혀 버린다(순서 의존).
      {
        const norm: Record<string, { s: string; i: string }> = {};
        for (const [m, val] of Object.entries(v.hanging2d ?? {})) {
          if (typeof val === "string") norm[m] = { s: val, i: "1x1" };   // 구 형식(Series만)
          else if (val && typeof val === "object") norm[m] = { s: (val as { s?: string }).s ?? "1x1", i: (val as { i?: string }).i ?? "1x1" };
        }
        const vv = v as { hanging2d_common_on?: boolean; hanging2d_by_viewer?: Record<string, Record<string, { s: string; i: string }>> };
        // 키 없음 = 체크 on. 뷰어(pickHang2d)의 기본값과 반드시 같아야 한다 —
        // 여기서 false 로 읽으면 구 계정 전부가 '체크 off + 뷰어별 비어 있음' = 전 모달리티 자동이 된다.
        const commonOn = vv.hanging2d_common_on ?? true;
        // 구 값은 {r,c} → "RxC". 공백을 넣으면(구 "2 x 2") Viewer2D 의 LAYOUTS 키 조회가 실패한다.
        const gStr = (l?: { r: number; c: number } | null) => (l ? `${l.r}x${l.c}` : "");
        const legacyInfi: Record<string, { s: string; i: string }> = Object.fromEntries(
          Object.entries(iv.infi_default_layout ?? {}).map(([k, cfg]) => [k, { s: gStr(cfg?.s), i: gStr(cfg?.i) }]));
        const mig = migrateHang2d(norm, vv.hanging2d_by_viewer ?? {}, commonOn, legacyInfi);
        setH2dMap(mig.common);
        setH2dCommonOn(commonOn);
        setH2dByViewer(mig.byViewer);
        setH2dMigrated(mig.moved);
        setH2dPending(mig.pending);
        setH2dDropped(mig.dropped);
        // 표로 접힌 모달리티 키는 infi_default_layout 에서 뺀다. HANG2D_MODS 에 DX·'*' 행이 있으므로
        // 구 편집기(CT/MR/CR/DX/US/XA/'*')가 만들 수 있던 키는 전부 접힌다 → 보통 여기 남는 건 없다.
        // 남는 게 있으면 그건 어떤 뷰어도 읽지 않는 값이고, mig.dropped 로 배너에 그대로 찍힌다.
        setDefLay(Object.fromEntries(Object.entries(legacyInfi)
          .filter(([k]) => !HANG2D_MODS.includes(k) && k !== "MG")));
      }
      {
        const cd = (v as { reading_chip_days?: number }).reading_chip_days;
        if (typeof cd === "number" && cd >= 1 && cd <= 30) {
          setChipDays(cd);
          localStorage.setItem("sv_chip_days", String(cd));
        }
      }
      setMgCfg(readMgCfg((v as { mg_hang?: unknown }).mg_hang));
      {
        const raw = (v as { overlay_by_modality?: Record<string, unknown> }).overlay_by_modality;
        if (raw && typeof raw === "object") {
          setOvlCfg(Object.fromEntries(Object.entries(raw).map(([k, val]) => [k, normCorners(val)])));
        }
      }
      if (v.reportDock !== undefined) setReportDock(v.reportDock);
      const tb = (v as { toolbar?: Record<string, boolean> }).toolbar;
      if (tb) setTbConfig(tb);
      const wp = (v as { wl_presets?: WlPreset[] }).wl_presets;
      if (wp?.length) setWlPresets(wp);
      const cm = (v as { close_mode?: "ask" | "save_current" | "save_all" | "discard" }).close_mode;
      if (cm) setCloseMode(cm);
      const mon = (v as { monitor?: { screens?: number[]; worklist?: number | null; report?: number | null; max_open?: number; close_scope?: "all" | "current"; close_report?: boolean; tab_binding?: Record<number, string>; tab_monitor_map?: { tab: string; monitor: number }[] } }).monitor;
      if (mon?.screens) setMonitorSel(mon.screens);
      if (mon?.worklist !== undefined) setWlMon(mon.worklist);
      if (mon?.report !== undefined) setRptMon(mon.report);
      if (mon?.max_open != null) setMaxOpen(Number(mon.max_open) || 0);
      if (mon?.close_scope === "all" || mon?.close_scope === "current") setCloseScope(mon.close_scope);
      setCloseReport(mon?.close_report === true);   // 미저장 = 끔(판독 원고 유실 방지가 기본)
      if (mon?.tab_binding) setTabBinding(mon.tab_binding);
      if (Array.isArray(mon?.tab_monitor_map)) setTabMonMap(mon.tab_monitor_map);
      const tc = v as { ty_tool_cols?: number };
      if (tc.ty_tool_cols) setTyToolCols(tc.ty_tool_cols);
      const sc = (v as { shortcuts?: { rdrag?: "wl" | "zoom" | "pan"; shift_rclick?: "zoomout" | "none" } }).shortcuts;
      if (sc?.rdrag) setScRdrag(sc.rdrag);
      if (sc?.shift_rclick) setScShiftR(sc.shift_rclick);
      const kk = (sc as { keys?: Record<string, string> } | undefined)?.keys;
      if (kk) setScKeys({ ...SC_DEFAULTS, ...kk });
      setDropMenu(!!(v as { drop_menu?: boolean }).drop_menu);
    }).catch(() => {});
    // 구 저장본(displays·s·i 만 있던 규칙)을 새 계약으로 읽어 온다 — readHpDoc 이 유일한 마이그레이션이다.
    // ⚠ 여기서 값이 하나라도 사라지면 설정을 여는 것만으로 사용자의 행잉이 날아간다(tests/hp_rule.test.mjs 가 고정).
    api.getSetting("viewer.hp").then((r) => {
      const doc = readHpDoc(r.value);
      setHpRules(doc.rules);
      setHpMods(doc.modalities);
    }).catch(() => {});
    api.getSetting("report.prefs").then((r) => {
      const v = r.value as { ai_panel?: boolean; auto_apply?: boolean } & Record<string, unknown>;
      if (v.ai_panel !== undefined) setRptAiPanel(v.ai_panel);
      if (v.auto_apply !== undefined) setRptAutoApply(v.auto_apply);
      setCmpBasis(readCompareCfg(v.compare));
      setRdOpts((prev) => ({ ...prev, ...v }));
    }).catch(() => {});
    api.getSetting("mode.profiles").then((r) => {
      const v = r.value as { profiles?: Record<string, ModeProfile> };
      setModeProfiles(v.profiles ?? {});
      setModeJson(JSON.stringify(r.value, null, 2));
    }).catch(() => {});
    loadTabs().then(setWlTabs).catch(() => {});
    loadTree().then(setWlTree).catch(() => {});
    api.profile().then((p) => { setProfName(p.display_name); setProfLicense(p.license_no);
      setProfMajor((p as { major_no?: string }).major_no ?? ""); }).catch(() => {});
    api.phrases().then((r) => setPhrases(r.items)).catch(() => {});
    api.getSetting("dicom.nodes").then((r) => {
      setNodes(((r.value as { items?: DicomNode[] }).items) ?? []);
    }).catch(() => {});
    api.getSetting("server.network").then((r) => {
      const v = r.value as { local_share_dir?: string; web?: { ip?: string; port?: number | string; dicom_port?: number | string; name?: string; ae_title?: string } };
      setSnDir(v.local_share_dir ?? "");
      setSnWeb({
        ip: v.web?.ip ?? "", port: String(v.web?.port ?? ""),
        dicom_port: String(v.web?.dicom_port ?? ""),
        name: v.web?.name ?? "", ae_title: v.web?.ae_title ?? "",
      });
      // 설정을 열 때 '지금 현재 공유된 폴더'가 처음에 보이게 — 값이 비면 /api/share/config 로 보충
      if (!(v.local_share_dir ?? "").trim()) {
        api.shareConfig().then((c) => { if (c.dir) setSnDir(c.dir); }).catch(() => {});
      }
    }).catch(() => {
      api.shareConfig().then((c) => { if (c.dir) setSnDir(c.dir); }).catch(() => {});
    });
    if (isAdmin) {
      api.getSetting("pdf.template").then((r) => {
        const v = r.value as Record<string, string>;
        setHospital(v.hospital ?? ""); setDepartment(v.department ?? ""); setFooter(v.footer ?? "");
      });
      api.getSetting("ai.policy").then((r) => {
        const v = r.value as Record<string, boolean | string>;
        setAutoGenerate((v.auto_generate as boolean) ?? true);
        setDraftEnabled((v.draft_enabled as boolean) ?? false);   // 기본 보류
        setVision((v.vision as boolean) ?? false);
        setSttEngine((v.stt_engine as string) ?? "browser");
        setSttModel((v.stt_model as string) ?? "");
      });
      api.aiQuality().then(setQuality).catch(() => {});
    }
  }, [isAdmin]);

  const testOrthanc = () => {
    setOrthanc(null);
    api.orthancStatus().then(setOrthanc).catch(() => setOrthanc({ alive: false, url: "?" }));
  };
  useEffect(() => { if (page === "network") testOrthanc(); }, [page]);

  // 영상 취득(환경 탭) — 사용량·진행률은 이 창의 스케줄러 상태에서 읽는다(설정 모달은
  // 워크리스트와 같은 창에 있다). 탭을 보고 있을 때만 1초 폴링 — 다른 탭에서는 돌지 않는다.
  useEffect(() => {
    if (page !== "env") return;
    const tick = () => {
      setDlProg(dlProgress());
      void opfsUsage().then(setDlUse).catch(() => {});
      void opfsLimitBytes(dl.limitGb).then(setDlLimit).catch(() => {});
    };
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
    // dl.limitGb — 상한 입력을 바꾸면 실효 상한(할당량 절반과의 min)도 그 자리에서 다시 보여 준다
  }, [page, dl.limitGb]);

  // 공유 디렉토리 존재 여부 뱃지 — 입력 디바운스(400ms) 후 서버측 확인(/api/share/fs, 관리자 전용)
  useEffect(() => {
    if (!isAdmin || page !== "servernet") return;
    const dir = snDir.trim();
    if (!dir) { setSnDirExists(null); return; }
    const t = setTimeout(() => {
      api.shareFs(dir).then((r) => setSnDirExists(r.exists)).catch(() => setSnDirExists(null));
    }, 400);
    return () => clearTimeout(t);
  }, [snDir, isAdmin, page]);

  /* ── 2D 행잉: 체크 상태가 바뀌면 그 자리에서 다시 정리한다 ──────────────────────────────
     캐스케이드 규정(CLAUDE.md) 이후 '공통 우선' 체크박스는 폐지됐다 — h2dRemigrate 도 함께
     삭제(호출자 0). 두 표가 모두 읽히므로 토글로 값이 사라지는 경로 자체가 없다. */
  /** 배너의 [공통 표로 올리기] — 자동 승격을 막은 값을 사용자가 명시적으로 공통에 올린다. */
  const h2dPromote = (p: Hang2dPending) => {
    const val: Hang2dCell = { s: p.cur[0].s, i: p.cur[0].i };
    setH2dMap((prev) => ({ ...prev, [p.m]: val }));
    setH2dPending((prev) => prev.filter((x) => x.m !== p.m));
    setSaved(`${tr(hang2dModLabel(p.m))} ${val.s}/${val.i} ${tr("를 공통 표에 올렸습니다 — OK(저장) 시 세 뷰어에 적용")}`);
  };

  const save = async () => {
    // 2D 행잉 저장 직전 재정리 — 체크박스를 뒤집은 뒤 다른 탭에서 OK 를 눌러도(=h2dRemigrate 를
    // 안 탄 경로여도) 읽히는 쪽 맵이 비어 나가지 않게 하는 마지막 방어선. 멱등이라 두 번 돌아도 무해.
    const h2d = migrateHang2d(h2dMap, h2dByViewer, h2dCommonOn, {});
    setH2dMap(h2d.common); setH2dByViewer(h2d.byViewer);
    if (h2d.moved) setH2dMigrated((n) => n + h2d.moved);
    setH2dPending(h2d.pending);
    // 병합 저장 — 드래그 panel_order 등 다른 키를 덮어쓰지 않도록 현재 서버 값과 합친다
    const cur = (await api.getSetting("worklist.prefs").catch(() => ({ value: {} }))).value;
    await api.putSetting("worklist.prefs",
      { ...cur, refresh_mode: refreshMode, auto_refresh_sec: refreshSec, default_status: defaultStatus, columns,
        by_viewer: wlBy, panels_by_viewer: wlPanelsBy,
        find_fields: findFields, dbl_action: dblAction, panels: wlPanels, nav_left: polNavLeft,
        search_box: { mode: sbMode, fields: sbFields, op: sbOp },
        req_dt_fmt: reqDtFmt }, "user");
    const curV = (await api.getSetting("viewer.prefs").catch(() => ({ value: {} }))).value;
    await api.putSetting("viewer.prefs", {
      ...curV,
      hanging2d: h2d.common,
      hanging2d_common_on: h2dCommonOn,
      hanging2d_by_viewer: h2d.byViewer,
      reading_chip_days: chipDays,   // 칩 집계 기간(배정의) — 로밍
      mg_hang: mgCfg,
      overlay_by_modality: ovlCfg,
      client_viewer: clientViewer,
      compare: cmpCfg,
      collab: colCfg,
      infi_sel_color: infSelColor, infi_overlay_font: infOvlFont, infi_overlay_visible: infOvlVisible,
      infi_toolbar: infTb,
      infi_tool_cols: infToolCols, infi_tool_labels: infToolLabels, infi_tool_size: infToolSize,
      infi_cine_sec: infCineSec,
      infi_quick_row: infQuickRow, infi_usage_rec: infUsageRec, infi_report_dock: infRptDock,
      infi_scrollbar: infScrollBar,
      ty_tool_size: tyToolSize, ty_tool_labels: tyToolLabels, ty_icon_3d: tyIcon3d,
      ty_quick_row: tyQuickRow, ty_usage_rec: tyUsageRec, ty_overlay_font: tyOvlFont,
      ty_tool_cols: tyToolCols,
      ty_sel_color: tySelColor, ty_cine_sec: tyCineSec,
      infi_close_mode: infCloseMode,
      // 사용 기록(ty_usage/infi_usage)은 [기록 초기화]를 누른 경우에만 빈 값으로 저장 —
      // 평소에는 뷰어의 2초 디바운스 집계를 설정 저장이 덮어쓰지 않도록 제외
      ...(tyUsageReset ? { ty_usage: {} } : {}),
      ...(infUsageReset ? { infi_usage: {} } : {}),
      ohif_enabled: ohifOn,
      wasm_pipeline: wasmPipe,
      // 영상 취득 모드 — 뷰어 2종이 소비하므로 viewer.prefs 에 둔다(worklist.prefs 아님)
      dl_mode: dl.mode, dl_limit_gb: dl.limitGb, dl_conc: dl.concurrency,
      dl_scope: dl.scope, dl_recent_n: dl.recentN,
      // 용량 초과 자동 삭제 — 이 4개를 저장 목록에서 빠뜨리면 UI 는 바뀌는데 저장이 안 돼
      // 모달을 다시 열면 기본값으로 돌아온다(= 설정이 없는 것과 같다)
      dl_auto_evict: dl.autoEvict, dl_evict_by: dl.evictBy,
      dl_warn_near: dl.warnNearLimit, dl_warn_pct: dl.warnAtPct,
      // 구 I-View 'Modality 기본 레이아웃' — 편집 UI 는 ee88de4 에서 삭제됐다. 로드 시 모달리티 키는
      // 2D 행잉(뷰어별 infi)으로 접었으므로 여기 남는 건 표에 자리 없는 키('*' 기타 전체)뿐이다.
      infi_default_layout: Object.fromEntries(Object.entries(defLay)
        .map(([k, v]) => {
          const parse = (s: string) => {
            const m = s.match(/(\d+)\s*x\s*(\d+)/);
            return m ? { r: Number(m[1]), c: Number(m[2]) } : null;
          };
          return [k, { s: parse(v.s), i: parse(v.i) }];
        })
        .filter(([, cfg]) => (cfg as { s: unknown; i: unknown }).s || (cfg as { s: unknown; i: unknown }).i)),
      paletteSide, thumbSide, thumbSize, thumbMode, reportDock,
      toolbar: tbConfig, wl_presets: wlPresets, close_mode: closeMode,
      monitor: { screens: monitorSel, worklist: wlMon, report: rptMon, max_open: maxOpen, close_scope: closeScope,
                 close_report: closeReport, tab_binding: tabBinding, tab_monitor_map: tabMonMap },
      shortcuts: { rdrag: scRdrag, shift_rclick: scShiftR, keys: scKeys },
      drop_menu: dropMenu,
    }, "user");
    await api.putSetting("report.prefs",
      { ...rdOpts, ai_panel: rptAiPanel, auto_apply: rptAutoApply, compare: cmpBasis }, "user");
    if (isAdmin) {
      // 서버 네트워크(공유 루트 등)도 OK(저장)로 함께 저장 — '서버 설정 저장' 버튼을 몰라도 반영
      if (snDir.trim() || snWeb.ip || snWeb.port || snWeb.name || snWeb.ae_title) {
        const curN = (await api.getSetting("server.network").catch(() => ({ value: {} }))).value;
        await api.putSetting("server.network", {
          ...curN,
          local_share_dir: snDir,
          web: { ...snWeb, port: Number(snWeb.port) || snWeb.port, dicom_port: Number(snWeb.dicom_port) || undefined },
        }, "global");
      }
      await api.putSetting("pdf.template", { hospital, department, footer }, "global");
      await api.putSetting("ai.policy", {
        draft_enabled: draftEnabled, auto_generate: autoGenerate, vision,
        stt_engine: sttEngine, stt_model: sttModel,
      }, "global");
    }
    // 정리 안내는 '저장하면 확정됩니다'라는 예고다 — 저장에 성공했으면 예고를 내린다.
    // pending/dropped 는 저장 뒤에도 여전히 '적용되지 않는 값'이므로 그대로 둔다.
    setH2dMigrated(0);
    // 열려 있는 Worklist 에 즉시 반영 신호 — 컬럼·패널·크기(뷰어별) 재로드/재해석 (Refresh 없이 반영)
    window.dispatchEvent(new CustomEvent("sv-settings-saved"));
    setSaved(tr("저장됨 — 워크리스트에 즉시 반영되었습니다"));
    setTimeout(() => setSaved(""), 2500);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "grid", placeItems: "center", zIndex: 100 }}>
      {/* ⚠ 이 줄에는 왼쪽 Refresh 버튼과 설정 패널이 **나란히** 있다. 패널만 98vw 로 잡으면
          버튼 폭(+gap)이 더해져 합계가 화면을 넘고, 오른쪽 끝의 OK/닫기 버튼이 잘려 나간다
          (최대화에서 실제로 잘렸다). 줄 자체를 뷰포트에 가두고 패널은 남는 폭을 쓰게 한다. */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8,
                    width: "100vw", maxWidth: "100vw", padding: "0 8px",
                    boxSizing: "border-box", justifyContent: "center" }}>
      {/* 설정 창 왼쪽 Refresh — 저장 후 전체 새로고침으로 적용값을 즉시 확인 */}
      <button title={tr("모든 설정을 저장하고 화면을 새로고침 — 적용된 값을 바로 확인합니다")}
              onClick={async () => { await save(); window.location.reload(); }}
              style={{
                display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                padding: "14px 10px", fontSize: 12, borderRadius: 8, cursor: "pointer",
                background: "var(--accent)", color: "#fff", border: "1px solid var(--accent)",
              }}>
        <span style={{ fontSize: 20, lineHeight: 1 }}>⟳</span>
        <span>Refresh</span>
        <span style={{ fontSize: 10.5, opacity: 0.85 }}>{tr("저장+적용")}</span>
      </button>
      <div style={{
        background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8,
        display: "flex", flexDirection: "column", overflow: "hidden",
        // 드래그 이동 오프셋 — 최대화에서는 원위치(전체 화면이라 이동 무의미)
        transform: maxed || (!dragOff.x && !dragOff.y) ? undefined : `translate(${dragOff.x}px, ${dragOff.y}px)`,
        ...(maxed
          // flex 로 남는 폭을 쓴다 — 형제(Refresh)와 padding 을 자동으로 비켜 간다
          ? { flex: 1, minWidth: 0, height: "95vh" }
          // 행잉(HP) 페이지만 넓게 연다 — 사양 5 '체크박스 5개 가로 1열' 이 성립하는 최소 폭을
          // lib/hangingProtocol.hpSettingsMinWidth() 가 라벨 길이 + 실제 크롬(좌측 트리 폭 포함)으로
          // 계산한다(현재 값 1130px). 860px 로는 편집 영역이 363px 뿐이라 원리적으로 불가능했다.
          // 화면이 좁으면 96vw 에서 멈추고 flexWrap 이 접는다(잘리지 않는다).
          : { width: `min(${page === "hp" ? hpSettingsMinWidth({ tree: treeW }) : 860}px, 96vw)`,
              height: "min(580px, 92vh)",
              // 우하단 핸들 드래그로 좌우·상하 크기 자유 조절(네이티브 resize)
              resize: "both" as const, minWidth: 640, minHeight: 420, maxWidth: "98vw", maxHeight: "95vh" }),
      }}>
        <div onMouseDown={dragMove} title={tr("제목줄을 잡고 드래그하면 창을 이동할 수 있습니다")}
             style={{ padding: "9px 14px", borderBottom: "1px solid var(--border)", display: "flex",
                      alignItems: "center", background: "var(--bg-elevated)", cursor: "move", userSelect: "none" }}>
          <b>{tr(SCOPE_TITLE[scope])}</b>
          <span style={{ marginLeft: 8, fontSize: 11.5, color: "var(--text-secondary)" }}>
            {scope === "system" ? tr("서버 운영") : scope === "hospital" ? tr("병원별 배치 구성") : tr("사용자·판독 환경")}
          </span>
          {/* 버전 표기 — 지속적인 버전 관리용. 클릭 시 [정보] 항목으로 이동(상세: 적용일자·제조사) */}
          <span onClick={() => setPage("about")} title={`${PRODUCT_NAME} — ${tr("클릭하면 정보 보기")}`}
                style={{ marginLeft: "auto", marginRight: 10, fontSize: 11.5, cursor: "pointer",
                         color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
            {VERSION_LABEL}
          </span>
          <button style={{ marginRight: 6 }} title={maxed ? tr("기본 크기로 복원") : tr("전체 화면으로 크게 보기")}
                  onClick={() => setMaxed((m) => !m)}>{maxed ? tr("❐ 복원") : tr("⬜ 최대화")}</button>
          {/* 우측 상단 닫기는 없앴다 — 하단 버튼과 중복이고, 저장 전/후 라벨이 달라야 하는데
              같은 자리에 두 개가 있으면 어느 것을 눌러야 저장이 되는지 알 수 없다. */}
        </div>
        {/* 2D 행잉 저장본 정리 안내 — **탭과 무관하게** 모달 상단에 띄운다.
            '뷰어 공통 > 2D 행잉' 탭 안에만 두면 다른 탭에서 OK 를 누른 사용자는 안내를 못 본 채
            행잉 변경을 확정하게 된다. 저장은 어느 탭에서 눌러도 hanging2d 전체를 쓰기 때문이다. */}
        {(h2dMigrated > 0 || h2dPending.length > 0 || h2dDropped.length > 0) && (
          <div style={{ padding: "7px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0,
                        background: "rgba(251,191,36,0.10)", color: "#fbbf24",
                        fontSize: 11.5, lineHeight: 1.65, maxHeight: 168, overflowY: "auto" }}>
            <b>{tr("2D Layout 저장본 정리")}</b> — {tr("아래 내용은")} <b>{tr("어느 탭에서든 OK(저장)")}</b> {tr("를 누르면 확정됩니다.")}
            {visibleTabs.some((t) => t.key === "viewer") && (
              <> <span onClick={() => setPage("viewer")}
                       style={{ textDecoration: "underline", cursor: "pointer" }}>{tr("표 열기")}</span></>
            )}
            {h2dMigrated > 0 && (
              <div>
                {tr("· 구 버전에서")} <b>{tr("폴백")}</b>{tr("(설정이 없는 쪽을 반대쪽 값으로 대신 적용) 또는 구 I-View")}
                <b> &lsquo;Modality {tr("기본 레이아웃")}&rsquo;</b>{tr("으로 적용되던 칸")} {h2dMigrated}{tr("개를 지금 실제로 읽히는 표")}({h2dCommonOn ? tr("공통") : tr("각 뷰어")}){tr("로 옮겼습니다.")}
              </div>
            )}
            {h2dPending.map((p) => (
              <div key={p.m}>
                · <b>{tr(hang2dModLabel(p.m))}</b> — {p.cur.map((x) => `${hang2dViewerLabel(x.v)} ${x.s}/${x.i}`).join(", ")}
                {p.auto.length
                  ? ` (${p.auto.map(hang2dViewerLabel).join("·")} ${tr("에는 설정이 없었습니다")})`
                  : ` (${tr("뷰어마다 값이 다릅니다")})`} —
                {tr("공통 표로 올리면")} <b>{tr("손대지 않은 다른 뷰어의 화면까지 바뀌므로")}</b> {tr("자동으로 옮기지 않았습니다. 지금은")} <b>{tr("적용되지 않습니다")}</b>{tr("(값은 각 뷰어 표에 그대로 있어 체크를 해제하면 다시 적용).")}
                <button style={{ marginLeft: 6, fontSize: 11 }} onClick={() => h2dPromote(p)}>
                  {tr("공통 표로 올리기")} ({p.cur[0].s}/{p.cur[0].i})
                </button>
              </div>
            ))}
            {h2dDropped.length > 0 && (
              <div>
                {tr("· 구 I-View 설정의")} <b>{h2dDropped.join(", ")}</b> {tr("는 2D Layout 표에 행이 없어")}
                <b> {tr("어떤 뷰어도 읽지 않습니다")}</b> — {tr("필요하면 해당 모달리티를 표에서 다시 지정하세요.")}
              </div>
            )}
          </div>
        )}
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          {/* 좌측 트리 (INFINITT 패턴) */}
          <div style={{ width: treeW, borderRight: "1px solid var(--border)", padding: 8, background: "var(--bg-canvas)", flexShrink: 0, overflowY: "auto" }}>
            {visibleTabs.filter((t) => !(t as { parent?: string }).parent).map((t) => (
              <div key={t.key}>
                <div onClick={() => setPage(t.key)}
                     style={{
                       padding: "6px 10px", borderRadius: 4, cursor: "pointer", fontSize: 12.5, marginBottom: 2,
                       display: "flex", alignItems: "center", gap: 7,
                       background: page === t.key ? "var(--accent-subtle)" : undefined,
                       color: page === t.key ? "var(--text-primary)" : "var(--text-secondary)",
                     }}>
                  <FolderIcon /> {t.labelKey ? tr(t.labelKey) : tr(t.label)}
                </div>
                {/* 하위 항목 — 부모 아래 들여쓰기로 표시(워크리스트·뷰어 공통의 뷰어별 페이지) */}
                {visibleTabs.filter((c) => (c as { parent?: string }).parent === t.key).map((c) => (
                  <div key={c.key} onClick={() => setPage(c.key)}
                       style={{
                         padding: "5px 10px 5px 26px", borderRadius: 4, cursor: "pointer", fontSize: 12,
                         marginBottom: 2, display: "flex", alignItems: "center", gap: 6,
                         background: page === c.key ? "var(--accent-subtle)" : undefined,
                         color: page === c.key ? "var(--text-primary)" : "var(--text-secondary)",
                       }}>
                    <span style={{ opacity: 0.6 }}>└</span> {c.labelKey ? tr(c.labelKey) : tr(c.label)}
                  </div>
                ))}
              </div>
            ))}
          </div>
          {/* 트리 폭 스플리터 — 드래그로 좌우 크기 조절 */}
          <div style={{ width: 5, cursor: "col-resize", flexShrink: 0, background: "transparent" }}
               onPointerDown={(e) => {
                 const sx = e.clientX, sw = treeW;
                 const mv = (ev: PointerEvent) => setTreeW(Math.min(340, Math.max(120, sw + ev.clientX - sx)));
                 const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
                 window.addEventListener("pointermove", mv);
                 window.addEventListener("pointerup", up);
               }} />
          {/* 우측 페이지 */}
          <div style={{ flex: 1, overflow: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
            {visibleTabs.length === 0 && (
              <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                {tr("이 설정에 접근할 권한이 없습니다.")}
              </div>
            )}
            {page === "viewer" && (
              <>
                <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                  {tr("뷰어 선택·모드·OHIF 등")} <b>{tr("공통 설정")}</b>{tr("입니다. 표시·아이콘·사용 패턴은 좌측 [뷰어 — TY Viewer]/[뷰어 — In Viewer] 탭에서 뷰어별로 설정하며, 기능은 두 뷰어 동일합니다.")}
                </div>
                <Group title={tr("영상 파이프라인")}>
                  <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}>
                    <input type="checkbox" checked={wasmPipe} onChange={(e) => setWasmPipe(e.target.checked)} />
                    {tr("WASM 디코딩 파이프라인 (베타) — 원본 픽셀(WADO-RS bulkdata)을 브라우저에서 직접 디코딩")}
                  </label>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    {tr("켜면 2D 뷰어가 서버 렌더링(JPEG) 대신 원본 16bit 프레임을 받아 WASM 코덱으로 디코딩합니다. W/L 조정이 서버 왕복 없이 즉시 반영되고, 병원 설정의 전송구문(JPEG2000/JPEG-LS)으로 수신합니다. 디코딩 전에는 서버 렌더링으로 표시(자동 폴백).")}
                  </div>
                </Group>
                {/* 제품 모드 프로파일 + 선택 뷰어 — 같은 높이 좌/우 배치(좁으면 줄바꿈) */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-start" }}>
                <Group title={tr("제품 모드 프로파일 (05 Mode Profile — 서버 JSON)")} style={{ flex: "1 1 360px", minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
                    <select id="sv-mode" value={modeSel} onChange={(e) => setModeSel(e.target.value)}>
                      <option value="" disabled>{tr("모드 선택…")}</option>
                      {Object.entries(modeProfiles).map(([k, p]) => (
                        <option key={k} value={k}>{p.label ?? k}{k === modeSel ? ` ✓ (${tr("현재 적용")})` : ""}</option>
                      ))}
                    </select>
                    <button onClick={async () => {
                      const m = modeSel;
                      const prof = modeProfiles[m];
                      if (!prof) return;
                      const cur = (await api.getSetting("worklist.prefs")).value;
                      const wl = { ...cur, ...(prof.worklist ?? {}) } as Record<string, unknown>;
                      await api.putSetting("worklist.prefs", wl, "user");
                      const curv = (await api.getSetting("viewer.prefs")).value;
                      // mode_key 영속 — 다음에 설정을 열면 현재 적용 모드가 콤보에 표시된다
                      const vw = { ...curv, ...(prof.viewer ?? {}), mode_key: m } as Record<string, unknown>;
                      await api.putSetting("viewer.prefs", vw, "user");
                      // 설정 창 상태를 프로파일 값으로 즉시 동기화 — 이후 OK(저장)가 옛 값으로 덮어쓰지 않도록
                      const wlc = wl.columns as string[] | undefined;
                      if (wlc?.length) setColumns(wlc.filter((c) => COLUMN_DEFS[c]));
                      const wlf = wl.find_fields as string[] | undefined;
                      if (wlf?.length) setFindFields(wlf.filter((c) => FIND_FIELDS[c]));
                      if (wl.dbl_action) setDblAction(wl.dbl_action as "viewer2d" | "ohif");
                      if (vw.paletteSide) setPaletteSide(vw.paletteSide as "left" | "top" | "right" | "bottom");
                      if (vw.thumbSide) setThumbSide(vw.thumbSide as "left" | "bottom" | "right" | "top");
                      if (vw.thumbSize) setThumbSize(vw.thumbSize as number);
                      if (vw.thumbMode) setThumbMode(vw.thumbMode as "series" | "all");
                      const cvw = vw.client_viewer as string | undefined;
                      if (cvw && CLIENT_VIEWERS.some((x) => x.id === cvw)) setClientViewer(cvw);
                      setSaved(`'${prof.label ?? m}' ${tr("모드 적용 — 왼쪽 ⟳ Refresh로 즉시 확인")}`);
                    }}>{tr("적용")}</button>
                    {isAdmin && (
                      <button title={tr("현재 워크리스트·뷰어 레이아웃(컬럼·검색필드·팔레트/썸네일 배치·선택 뷰어)을 선택한 프로파일에 저장 (전역)")}
                              onClick={async () => {
                        const m = modeSel;
                        const prof = modeProfiles[m];
                        if (!prof) { alert(tr("저장할 프로파일을 먼저 선택하세요")); return; }
                        if (!confirm(`${tr("현재 화면 구성을")} '${prof.label ?? m}' ${tr("프로파일에 저장할까요? (전역 — 모든 사용자에게 적용)")}`)) return;
                        const wl = (await api.getSetting("worklist.prefs")).value as Record<string, unknown>;
                        const vw = (await api.getSetting("viewer.prefs")).value as Record<string, unknown>;
                        const pick = (src: Record<string, unknown>, keys: string[]) =>
                          Object.fromEntries(keys.filter((k) => src[k] !== undefined).map((k) => [k, src[k]]));
                        const next = {
                          ...modeProfiles,
                          [m]: {
                            ...prof,
                            worklist: { ...(prof.worklist ?? {}), ...pick(wl, ["columns", "find_fields", "dbl_action"]) },
                            viewer: { ...(prof.viewer ?? {}), ...pick(vw, ["client_viewer", "paletteSide", "thumbSide", "thumbMode", "thumbSize", "reportDock"]) },
                          },
                        };
                        await api.putSetting("mode.profiles", { profiles: next }, "global");
                        setModeProfiles(next);
                        setModeJson(JSON.stringify({ profiles: next }, null, 2));
                        setSaved(`${tr("현재 화면 구성을")} '${prof.label ?? m}' ${tr("프로파일에 저장했습니다 (전역)")}`);
                      }}>{tr("현재 화면을 프로파일에 저장")}</button>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    {tr("Core 기능은 동일, 화면 구성(컬럼·검색필드·팔레트/썸네일 배치·더블클릭·선택 뷰어)만 제품별 프로파일로 전환 — 타 PACS 사용 경험 그대로 이전. 프로파일 정의는 서버 전역 설정(mode.profiles)에서 로드.")} <b>I-View</b>{tr("=INFINITT 스타일 레이아웃 저장소 ·")} <b>T-View</b>{tr("=자체 뷰어 레이아웃.")}
                  </div>
                  {isAdmin && (
                    <details>
                      <summary style={{ fontSize: 11.5, cursor: "pointer", color: "var(--text-secondary)" }}>
                        {tr("프로파일 JSON 편집 (관리자 — 전역 적용)")}
                      </summary>
                      <textarea value={modeJson} onChange={(e) => setModeJson(e.target.value)}
                                spellCheck={false}
                                style={{
                                  width: "100%", height: 160, marginTop: 6, fontSize: 11,
                                  fontFamily: "Consolas, monospace", background: "var(--bg-canvas)",
                                  color: "var(--text-primary)", border: "1px solid var(--border)", borderRadius: 4,
                                }} />
                      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                        <button onClick={async () => {
                          try {
                            const parsed = JSON.parse(modeJson);
                            if (!parsed.profiles) throw new Error("최상위에 profiles 객체가 필요합니다");
                            await api.putSetting("mode.profiles", parsed, "global");
                            setModeProfiles(parsed.profiles);
                            setSaved(tr("모드 프로파일 JSON 저장됨 (전역)"));
                          } catch (e) {
                            alert(e instanceof Error ? `${tr("JSON 오류")}: ${e.message}` : tr("저장 실패"));
                          }
                        }}>{tr("JSON 저장")}</button>
                      </div>
                    </details>
                  )}
                </Group>
                <Group title={tr("선택 뷰어 (Client Viewer)")} style={{ flex: "1 1 300px", minWidth: 0 }}>
                  <Row label={tr("사용할 뷰어")}>
                    <select value={clientViewer} onChange={(e) => setClientViewer(e.target.value)}>
                      {CLIENT_VIEWERS.map((v) => (
                        <option key={v.id} value={v.id} disabled={!v.available}>
                          {v.label}{v.available ? "" : ` (${tr("개발 중")})`}
                        </option>
                      ))}
                    </select>
                    <span style={{ fontSize: 11.5, color: "var(--text-secondary)", marginLeft: 8 }}>
                      {tr(CLIENT_VIEWERS.find((v) => v.id === clientViewer)?.desc ?? "")}
                    </span>
                  </Row>
                </Group>
                </div>
              </>
            )}
            {page === "env" && (
              <>
                {/* ★ 최상단 고정(사용자 규정) — UI 언어. 즉시 적용 + viewer.prefs.ui_lang 로밍.
                    이관 전 문자열은 한국어로 남는다(lib/i18n.ts 폴백 규칙) — 점진 이관 대상. */}
                <Group title={`${tr("language")} (Language)`}>
                  <Row label={tr("language")}>
                    <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <select value={uiLang}
                              onChange={(e) => {
                                const v = e.target.value as (typeof LANGS)[number]["code"];
                                setLang(v);   // 즉시 적용 (localStorage — 로그인 화면에도 미리 반영)
                                // 계정 로밍 — 다른 PC 에서도 같은 언어. 실패해도 이 PC 적용은 유지된다.
                                api.getSetting("viewer.prefs")
                                  .then((r) => api.putSetting("viewer.prefs", { ...(r.value || {}), ui_lang: v }, "user"))
                                  .catch(() => {});
                              }}>
                        {LANGS.map((l) => <option key={l.code} value={l.code}>{l.native}</option>)}
                      </select>
                      {(() => {   // 번역 커버리지 — "이 언어에서 몇 %가 번역돼 나오나"를 그대로 보여준다
                        const c = coverage(uiLang);
                        const pct = c.total ? Math.round((c.done / c.total) * 100) : 100;
                        return (
                          <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                            {tr("UI 번역")} {c.done}/{c.total} ({pct}%)
                            {pct < 100 && <> — {tr("번역이 없는 문구는 한국어로 표시됩니다.")}</>}
                          </span>
                        );
                      })()}
                    </span>
                  </Row>
                </Group>
                {/* 기기 프로필 — 같은 계정 3시스템 동시 사용, 장비 의존 설정만 기기별 분리 저장 */}
                <Group title={tr("기기 프로필")}>
                  <div style={{ fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.7, marginBottom: 6 }}>
                    {tr("같은 계정을 최대 3개 시스템에서 동시에 사용할 수 있습니다. 모니터 구성·패널 크기 같은 장비 의존 설정은 기기(슬롯)별로 서버에 저장되고, 컬럼 구성 등 나머지 설정은 모든 기기에 공통입니다.")}
                  </div>
                  {[1, 2, 3].map((s) => {
                    const d = (devices ?? []).find((x) => x.slot === s);
                    const mine = !!d && d.id === localStorage.getItem("sv_device_id");
                    return (
                      <Row key={s} label={`${tr("슬롯")} ${s}`}>
                        {d ? (
                          <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <input value={d.label} style={{ width: 200 }}
                                   onChange={(e) => setDevices((p) => (p ?? []).map((x) =>
                                     x.id === d.id ? { ...x, label: e.target.value } : x))}
                                   onBlur={(e) => { api.renameDeviceSlot(d.id, e.target.value).catch(() => {}); }} />
                            {mine && <span style={{ fontSize: 11, fontWeight: 700, color: "var(--ai,#a78bfa)" }}>{tr("현재 기기")}</span>}
                            {d.last_seen && (
                              <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                                {d.last_seen.slice(0, 16).replace("T", " ")}{d.screen ? ` · ${d.screen}` : ""}
                              </span>
                            )}
                            {!mine && (
                              <button style={{ fontSize: 11 }}
                                      onClick={() => api.clearDeviceSlot(d.id).then(setDevices).catch(() => {})}>
                                {tr("슬롯 비우기")}
                              </button>
                            )}
                          </span>
                        ) : (
                          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{tr("빈 슬롯")}</span>
                        )}
                      </Row>
                    );
                  })}
                </Group>
                <Group title={tr("워크리스트 동작")}>
                  <Row label={tr("env.listRefresh")}>
                    <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <input type="radio" name="wlrefresh" checked={refreshMode === "manual"}
                               onChange={() => setRefreshMode("manual")} />
                        {tr("manual")} (SEARCH)
                      </label>
                      <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <input type="radio" name="wlrefresh" checked={refreshMode === "auto"}
                               onChange={() => setRefreshMode("auto")} />
                        {tr("auto")}
                      </label>
                      <input type="number" min={1} max={3600} value={refreshSec}
                             disabled={refreshMode !== "auto"}
                             onChange={(e) => {
                               const n = Number(e.target.value);
                               setRefreshSec(Number.isFinite(n) ? Math.min(3600, Math.max(1, Math.round(n))) : 10);
                             }}
                             style={{ width: 70, opacity: refreshMode === "auto" ? 1 : 0.45 }} />
                      <span style={{ color: "var(--text-secondary)" }}>{tr("env.everySec")}</span>
                    </span>
                  </Row>
                  <Row label="">
                    <span style={{ fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.7 }}>
                      {tr("모든 뷰어(SaintView·T-View·I-View)의 워크리스트와")} <b>{tr("Live 모드에도 함께")}</b> {tr("적용됩니다. 수동일 때 원격에 변경이 생기면 목록을 바꾸지 않고 상단에 알림만 띄웁니다.")}
                      {refreshMode === "auto" && refreshSec < 3 && (
                        <><br /><b style={{ color: "var(--warn, #f59e0b)" }}>
                          {refreshSec}{tr("초는 매우 짧습니다 — Live 모드에서는 원격 PACS 에 그만큼 자주 질의합니다.")}
                        </b></>
                      )}
                    </span>
                  </Row>
                  <Row label={tr("env.statusFilter")}>
                    <select value={defaultStatus} onChange={(e) => setDefaultStatus(e.target.value)}>
                      <option value="">{tr("전체")}</option><option value="unread">{tr("미판독(확정 전)")}</option>
                      <option value="draft_ready">{tr("AI초안")}</option>
                      <option value="reading">{tr("판독중")}</option><option value="received">{tr("도착")}</option>
                    </select>
                  </Row>
                  <Row label={tr("단축키")}>
                    <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                      {tr("워크리스트: Enter=View&Draft · B=일괄검토 · E=Emergency │ 뷰어: ←→ 이미지 · I 반전 · R 회전 · F Fit · L Link · 1/2/4 분할 · Space Cine · Esc 닫기")}
                    </span>
                  </Row>
                  <Row label={tr("더블클릭 동작")}>
                    <select value={dblAction} onChange={(e) => setDblAction(e.target.value as "viewer2d" | "ohif")}>
                      <option value="viewer2d">{tr("자체 뷰어 (View&Draft)")}</option>
                      <option value="ohif">{tr("OHIF 뷰어")}</option>
                    </select>
                  </Row>
                </Group>
                <Group title={tr("영상 취득")}>
                  <Row label={tr("모드")}>
                    <span style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <input type="radio" name="dlmode" checked={dl.mode === "live"}
                               onChange={() => setDl({ ...dl, mode: "live" })} />
                        {tr("Live — 볼 때 받는다 (기본)")}
                      </label>
                      <label style={{ display: "flex", alignItems: "center", gap: 4, opacity: dlWhy ? 0.45 : 1 }}>
                        <input type="radio" name="dlmode" checked={dl.mode === "download"} disabled={!!dlWhy}
                               onChange={() => setDl({ ...dl, mode: "download" })} />
                        {tr("다운로드 — 미리 받아 둔다")}
                      </label>
                    </span>
                  </Row>
                  <Row label="">
                    <span style={{ fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.7 }}>
                      {tr("다운로드 모드는 워크리스트를")} <b>{tr("최근 환자 순")}</b>{tr("으로 훑어 시리즈 썸네일 → 각 시리즈의 이미지 순서로 미리 받아 둡니다. 저장 위치는 브라우저 전용 영역이라")} <b>{tr("탐색기에 보이지 않고 권한 프롬프트도 없습니다")}</b>{tr(". 받아 둔 검사는 서버 왕복 없이 열립니다.")}
                      <br />{tr("⚠ 현재는")} <b>{tr("Live 모드 + 2D 뷰어(SaintView·T-View·I-View)")}</b>{tr("에서만 동작합니다. W/L 을 조정하는 동안에는 서버 렌더로 자동 폴백합니다(저장본은 검사 기본 W/L 로 구운 영상이라 그대로 쓰면 표시 W/L 과 실제 영상이 어긋납니다).")}
                      <br />⚠ <b>{tr("로그아웃·세션 만료 시 받아 둔 영상은 전부 삭제됩니다")}</b>{tr("(공용 판독 PC 안전).")}
                      {dlWhy && (
                        <><br /><b style={{ color: "var(--warn, #f59e0b)" }}>
                          {tr("이 환경에서는 사용할 수 없습니다 —")} {dlWhy}
                        </b></>
                      )}
                    </span>
                  </Row>
                  {dl.mode === "download" && !dlWhy && (
                    <>
                      <Row label={tr("저장 상한")}>
                        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <input type="number" min={1} max={200} value={dl.limitGb} style={{ width: 70 }}
                                 onChange={(e) => setDl({ ...dl,
                                   limitGb: Math.min(200, Math.max(1, Math.round(Number(e.target.value) || 2))) })} />
                          <span style={{ color: "var(--text-secondary)" }}>
                            {tr("GB (브라우저 할당량의 절반을 넘지 않습니다 ·")}{" "}
                            {/* ★ 문구를 하드코딩하지 않는다 — 예전에는 '오래 안 본 검사부터' 라고 박혀
                                있었고 실제 동작도 그랬는데, 사용자가 원한 정책은 '과거 검사부터' 였다.
                                문구가 곧 정책인 상태에서는 되돌림이 조용히 일어난다. */}
                            {dl.autoEvict
                              ? <>{tr("초과 시")} <b>{dl.evictBy === "lru" ? tr("오래 안 본 검사부터") : tr("과거 검사일부터")}</b> {tr("통째로 삭제")}</>
                              : <><b>{tr("자동 삭제 꺼짐")}</b> — {tr("상한에 도달하면 더 받지 않습니다")}</>})
                          </span>
                        </span>
                      </Row>
                      {/* 용량 초과 시 자동 삭제 — 기준/알림. '보고 있는 검사는 삭제하지 않는다'는
                          보호 규칙(dlScheduler.protectedUids)을 여기서 명시한다. */}
                      <Row label={tr("자동 삭제")}>
                        <span style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                          <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <input type="checkbox" checked={dl.autoEvict}
                                   onChange={(e) => setDl({ ...dl, autoEvict: e.target.checked })} />
                            {tr("상한을 넘으면 자동으로 삭제")}
                          </label>
                          <label style={{ display: "flex", alignItems: "center", gap: 4, opacity: dl.autoEvict ? 1 : 0.45 }}>
                            <input type="radio" name="dlevict" disabled={!dl.autoEvict}
                                   checked={dl.evictBy === "date"}
                                   onChange={() => setDl({ ...dl, evictBy: "date" })} />
                            {tr("과거 검사일부터 (기본)")}
                          </label>
                          <label style={{ display: "flex", alignItems: "center", gap: 4, opacity: dl.autoEvict ? 1 : 0.45 }}>
                            <input type="radio" name="dlevict" disabled={!dl.autoEvict}
                                   checked={dl.evictBy === "lru"}
                                   onChange={() => setDl({ ...dl, evictBy: "lru" })} />
                            {tr("오래 안 본 검사부터")}
                          </label>
                        </span>
                      </Row>
                      <Row label="">
                        <span style={{ fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.7 }}>
                          {tr("삭제 단위는")} <b>{tr("검사 하나 통째로")}</b>{tr("입니다(반쪽 검사가 남으면 빠르다는 체감이 깨집니다).")}
                          <b> {tr("지금 보고 있는 검사와 받는 중인 검사는 삭제하지 않습니다.")}</b>
                          {" "}{tr("검사일을 알 수 없는 검사는")} <b>{tr("가장 나중에")}</b> {tr("삭제합니다.")}
                          <br />{tr("⚠ 자동 삭제를 끄면 상한에 도달한 순간부터")} <b>{tr("더 받지 않습니다")}</b>{tr(". 계속 받다가 브라우저 할당량이 차면 브라우저가 받아 둔 영상을")} <b>{tr("통째로 조용히")}</b> {tr("지우기 때문입니다.")}
                          {/* 용량 때문에 지운 검사를 자동으로 다시 받지 않는다는 것은 사용자가 알아야 할
                              동작이다(진행률이 N/N 에 못 미치는 이유이기도 하다). 예전에는 10분 뒤 자동
                              재다운로드가 돌아 같은 검사를 받고 지우기를 세션 내내 반복했다. */}
                          <br />{tr("한 번 삭제한 검사는")} <b>{tr("자동으로 다시 받지 않습니다")}</b> — {tr("그 검사를 워크리스트에서 열면 그때 다시 받습니다(상한·삭제 기준을 바꾸거나 [지금 비우기] 를 눌러도 초기화됩니다).")}
                        </span>
                      </Row>
                      <Row label={tr("상한 근접 알림")}>
                        <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <input type="checkbox" checked={dl.warnNearLimit}
                                   onChange={(e) => setDl({ ...dl, warnNearLimit: e.target.checked })} />
                            {tr("사용량이")}
                          </label>
                          <input type="number" min={50} max={99} value={dl.warnAtPct}
                                 disabled={!dl.warnNearLimit}
                                 style={{ width: 64, opacity: dl.warnNearLimit ? 1 : 0.45 }}
                                 onChange={(e) => setDl({ ...dl,
                                   warnAtPct: Math.min(99, Math.max(50, Math.round(Number(e.target.value) || 90))) })} />
                          {/* ★ 문구가 곧 정책이다 — '넘으면 무조건 알림' 이라고 써 두면 자동 삭제가
                              정상 작동해서 상한에 딱 맞춰진 상태(=착지값이 늘 100%)가 영구 경보가 된다.
                              실제 규칙은 lib/dlQueueRule.shouldWarnNearLimit 이고, 알림의 의미는
                              '곧 중지됩니다' 라는 **예고** 뿐이다. */}
                          <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                            {tr("% 를 넘으면 알립니다 —")} <b>{tr("다운로드가 곧 중지될 때만")}</b> {tr("뜹니다(자동 삭제가 꺼져 있거나, 열려 있는 검사만으로 상한을 넘어 지울 것이 없을 때). 자동 삭제가 정상 작동 중이면 사용량이 상한에 붙어 있는 것이 정상이라 알리지 않습니다. 워크리스트 창에서 1회 — 판독 중인 뷰어 창에는 띄우지 않습니다.")}
                          </span>
                        </span>
                      </Row>
                      <Row label={tr("대상 범위")}>
                        <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <input type="radio" name="dlscope" checked={dl.scope === "list"}
                                   onChange={() => setDl({ ...dl, scope: "list" })} />
                            {tr("현재 목록 전체")}
                          </label>
                          <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <input type="radio" name="dlscope" checked={dl.scope === "recent"}
                                   onChange={() => setDl({ ...dl, scope: "recent" })} />
                            {tr("최근")}
                          </label>
                          <input type="number" min={1} max={500} value={dl.recentN}
                                 disabled={dl.scope !== "recent"}
                                 style={{ width: 70, opacity: dl.scope === "recent" ? 1 : 0.45 }}
                                 onChange={(e) => setDl({ ...dl,
                                   recentN: Math.min(500, Math.max(1, Math.round(Number(e.target.value) || 50))) })} />
                          <span style={{ color: "var(--text-secondary)" }}>{tr("건만")}</span>
                        </span>
                      </Row>
                      <Row label={tr("동시 받기")}>
                        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <input type="number" min={1} max={4} value={dl.concurrency} style={{ width: 60 }}
                                 onChange={(e) => setDl({ ...dl,
                                   concurrency: Math.min(4, Math.max(1, Math.round(Number(e.target.value) || 2))) })} />
                          <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                            {tr("개 — 크게 잡으면")} <b>{tr("내 화면은 빨라지고 남의 화면은 느려집니다")}</b>{tr("(원격 PACS 공용). 서버가 이미 검사마다 8워커로 예열하므로 2 를 권합니다.")}
                          </span>
                        </span>
                      </Row>
                      <Row label={tr("사용량")}>
                        <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 12 }}>
                            {dlUse
                              ? `${(dlUse.bytes / 1073741824).toFixed(2)} GB · ${tr("검사")} ${dlUse.studies}${tr("건")} · ${tr("파일")} ${dlUse.files}${tr("개")}`
                              : tr("확인 전")}
                            {/* 실효 상한 대비 비율 — 축출은 이 값에서 일어난다(설정값이 아니라). */}
                            {dlUse && dlLimit > 0 && (
                              <b style={{ marginLeft: 8,
                                          color: dlUse.bytes / dlLimit >= dl.warnAtPct / 100
                                            ? "var(--warn, #f59e0b)" : "inherit" }}>
                                {tr("실효 상한")} {(dlLimit / 1073741824).toFixed(2)} GB {tr("의")}{" "}
                                {Math.round((dlUse.bytes / dlLimit) * 100)}%
                              </b>
                            )}
                          </span>
                          <button type="button" disabled={dlBusy}
                                  onClick={() => { setDlBusy(true); void opfsUsage().then(setDlUse).finally(() => setDlBusy(false)); }}>
                            {tr("새로고침")}
                          </button>
                          <button type="button" disabled={dlBusy}
                                  onClick={() => {
                                    if (!confirm(tr("받아 둔 영상을 전부 삭제합니다. 계속할까요?"))) return;
                                    setDlBusy(true);
                                    // ★ 파일만 지우면 안 된다 — 설정 모달은 워크리스트와 **같은 창**이라
                                    //   스케줄러 모듈 상태를 그대로 공유한다.
                                    //   · dlForgetDone(): doneUids 를 비워 다시 받게 한다. 안 비우면 loop 의
                                    //     `!doneUids.has(...)` 필터에 전부 걸려 저장소는 0GB 인데 아무것도
                                    //     재다운로드되지 않고 진행 표시만 '검사 N/N' 으로 남는다(모순 화면).
                                    //   · dlInvalidateCache(): 이 창과 **뷰어 창들**의 blob URL 캐시를 버린다.
                                    //     안 버리면 이미 삭제된 파일의 blob URL 이 계속 서빙된다('비웠다'와 어긋남).
                                    void opfsWipe()
                                      .then(() => { dlForgetDone(); dlInvalidateCache(); return opfsUsage(); })
                                      .then(setDlUse).finally(() => setDlBusy(false));
                                  }}>
                            {tr("지금 비우기")}
                          </button>
                        </span>
                      </Row>
                      <Row label={tr("진행")}>
                        <span style={{ fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.7 }}>
                          {dlProg
                            ? (dlProg.running
                                ? `${tr("받는 중 — 검사")} ${dlProg.done}/${dlProg.total} · ${tr("파일")} ${dlProg.files}${tr("개")}` +
                                  (dlProg.current ? ` · ${tr("현재")}: ${dlProg.current}` : "")
                                : tr(dlProg.note || "대기 중 — 저장 후 워크리스트에서 시작됩니다."))
                            : "—"}
                          {/* ★ running=true 라도 사유(note)가 있으면 반드시 보여 준다 — 상한 게이트로
                              멈춘 동안에도 Web Lock 은 이 창이 쥐고 있어 running 은 참이다. 사유를
                              숨기면 '받는 중인데 아무 일도 안 일어난다'는 진단 불가 화면이 된다. */}
                          {dlProg?.running && dlProg.note && (
                            <><br /><b style={{ color: "var(--warn, #f59e0b)" }}>{tr(dlProg.note)}</b></>
                          )}
                          <br />{tr("창을 여러 개 열어도")} <b>{tr("다운로드는 한 창에서만")}</b> {tr("돕니다(같은 영상을 두 번 받지 않도록).")}
                        </span>
                      </Row>
                    </>
                  )}
                </Group>
              </>
            )}

            {page === "server" && isAdmin && <ServerPanel />}
            {page === "overview" && isAdmin && <OverviewPanel />}
            {page === "hospitals" && isAdmin && <HospitalsPanel />}
            {page === "users" && isAdmin && <UsersPanel />}
            {page === "modality" && isAdmin && <ModalityPanel />}
            {page === "storage" && isAdmin && <StoragePanel />}

            {page === "network" && (
              <>
                <Group title={tr("로컬 구성")}>
                  {/* 하드코딩하지 않는다 — 스위트 백엔드는 8010 이고 8000 은 본체 포트다.
                      VITE_API_BASE 가 비면(기본 배치) 같은 출처로 나가므로 그것을 그대로 보여준다. */}
                  <Row label={tr("API 서버")}><code style={{ fontSize: 12 }}>
                    {import.meta.env.VITE_API_BASE || window.location.origin}
                  </code></Row>
                  <Row label={tr("OHIF 뷰어")}><code style={{ fontSize: 12 }}>http://localhost:3000</code></Row>
                </Group>
                <Group title={tr("DICOM 서버 (Orthanc)")} right={<button onClick={testOrthanc}>{tr("연결 테스트")}</button>}>
                  {orthanc === null ? (
                    <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{tr("확인 중…")}</div>
                  ) : orthanc.alive ? (
                    <table className="grid-table">
                      <tbody>
                        <tr><th style={{ width: 110 }}>{tr("상태")}</th><td style={{ color: "var(--stat-final)" }}>{tr("● 연결됨")}</td></tr>
                        <tr><th>AE Title</th><td>{orthanc.aet}</td></tr>
                        <tr><th>{tr("DICOM 포트")}</th><td>{orthanc.dicom_port} {tr("(C-STORE 수신)")}</td></tr>
                        <tr><th>{tr("버전")}</th><td>Orthanc {orthanc.version}</td></tr>
                        <tr><th>{tr("저장 검사")}</th><td>{orthanc.studies_count}{tr("건")}</td></tr>
                      </tbody>
                    </table>
                  ) : (
                    <div style={{ color: "var(--stat-emergency)", fontSize: 12.5 }}>
                      {tr("● 연결 실패 —")} {orthanc.url} {orthanc.error ?? ""}
                    </div>
                  )}
                </Group>
                <Group title={tr("SCP/SCU 장비 노드 (AE Title · IP · Port)")} right={
                  isAdmin && (
                    <span style={{ display: "flex", gap: 4 }}>
                      <button style={{ padding: "1px 8px", fontSize: 11 }}
                              onClick={() => setNodes((p) => [...p, { name: `NODE${p.length + 1}`, role: "scu", ae_title: "", ip: "", port: 104 }])}>
                        {tr("＋ 추가")}
                      </button>
                      <button style={{ padding: "1px 8px", fontSize: 11 }} onClick={async () => {
                        try {
                          await api.putSetting("dicom.nodes", { items: nodes }, "global");
                          setNodeMsg(tr("저장됨"));
                        } catch (e) { setNodeMsg(e instanceof Error ? e.message : tr("저장 실패")); }
                      }}>{tr("저장")}</button>
                      <button style={{ padding: "1px 8px", fontSize: 11 }}
                              title={tr("저장된 노드를 Orthanc DicomModalities로 등록 — C-STORE/C-FIND 대상")}
                              onClick={async () => {
                                try {
                                  const r = await api.applyDicomNodes();
                                  setNodeMsg(`${tr("Orthanc 반영")} ${r.applied}${tr("건")}${r.errors.length ? ` · ${tr("오류")}: ${r.errors.join(", ")}` : ""}`);
                                } catch (e) { setNodeMsg(e instanceof Error ? e.message : tr("반영 실패")); }
                              }}>{tr("Orthanc 반영")}</button>
                    </span>
                  )
                }>
                  <table className="grid-table">
                    <thead><tr><th>{tr("이름")}</th><th style={{ width: 80 }}>{tr("역할")}</th><th>AE Title</th><th>IP</th><th style={{ width: 70 }}>Port</th><th style={{ width: 30 }}></th></tr></thead>
                    <tbody>
                      {nodes.map((n, i) => (
                        <tr key={i}>
                          {isAdmin ? (
                            <>
                              <td><input value={n.name} style={{ width: "95%" }}
                                         onChange={(e) => setNodes((p) => p.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} /></td>
                              <td>
                                <select value={n.role}
                                        onChange={(e) => setNodes((p) => p.map((x, j) => j === i ? { ...x, role: e.target.value as DicomNode["role"] } : x))}>
                                  <option value="scu">SCU</option><option value="scp">SCP</option><option value="both">{tr("양방향")}</option>
                                </select>
                              </td>
                              <td><input value={n.ae_title} style={{ width: "95%" }}
                                         onChange={(e) => setNodes((p) => p.map((x, j) => j === i ? { ...x, ae_title: e.target.value.toUpperCase() } : x))} /></td>
                              <td><input value={n.ip} style={{ width: "95%" }}
                                         onChange={(e) => setNodes((p) => p.map((x, j) => j === i ? { ...x, ip: e.target.value } : x))} /></td>
                              <td><input value={n.port} type="number" style={{ width: 60 }}
                                         onChange={(e) => setNodes((p) => p.map((x, j) => j === i ? { ...x, port: Number(e.target.value) } : x))} /></td>
                              <td><button style={{ padding: "0 6px", fontSize: 11 }}
                                          onClick={() => setNodes((p) => p.filter((_, j) => j !== i))}>✕</button></td>
                            </>
                          ) : (
                            <>
                              <td>{n.name}</td><td>{n.role.toUpperCase()}</td><td>{n.ae_title}</td>
                              <td>{n.ip}</td><td>{n.port}</td><td></td>
                            </>
                          )}
                        </tr>
                      ))}
                      {nodes.length === 0 && (
                        <tr><td colSpan={6} style={{ color: "var(--text-secondary)" }}>
                          {tr("등록된 장비 없음")} {isAdmin && tr("— ＋추가로 등록 후 저장 → Orthanc 반영")}
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)", display: "flex", gap: 8 }}>
                    {tr("SCU=우리가 전송(C-STORE 대상), SCP=수신 노드. MWL 응답은 Orthanc(SAINTVIEW:4242)가 담당.")}
                    {nodeMsg && <b style={{ color: "var(--stat-final)" }}>{nodeMsg}</b>}
                  </div>
                </Group>
              </>
            )}

            {page === "servernet" && (
              <>
                <Group title={tr("로컬 서버 — 폴더 공유")}>
                  <Row label={tr("공유 디렉토리")}>
                    <input value={snDir} onChange={(e) => setSnDir(e.target.value)} disabled={!isAdmin}
                           placeholder="C:\PACS\share" style={{ width: 320 }} />
                    {isAdmin && (
                      <button onClick={() => setFsPickerOpen(true)}
                              title={tr("서버 PC의 폴더를 직접 탐색해 선택합니다 (드라이브→하위 폴더)")}
                              style={{ padding: "2px 10px", fontSize: 12, display: "flex",
                                       alignItems: "center", gap: 5 }}>
                        <FolderIcon size={13} /> {tr("폴더 찾기")}
                      </button>
                    )}
                    {snDirExists !== null && (
                      <span style={{
                        fontSize: 10.5, fontWeight: 700, padding: "1px 8px", borderRadius: 9,
                        color: "#fff", flexShrink: 0,
                        background: snDirExists ? "#16a34a" : "#d97706",
                      }}>
                        {snDirExists ? tr("존재함") : tr("경로 없음")}
                      </span>
                    )}
                  </Row>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    {tr("워크리스트 우측 [Local Server] 버튼에서 이 폴더의 파일 목록·다운로드가 제공됩니다 (서버 PC 기준 경로).")}
                  </div>
                </Group>
                {fsPickerOpen && (
                  <FolderPickerModal
                    initial={snDir.trim()}
                    onPick={(p) => { setSnDir(p); setFsPickerOpen(false); }}
                    onClose={() => setFsPickerOpen(false)} />
                )}
                <Group title={tr("웹 서버")}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <Row label={tr("IP 주소")}>
                      <input value={snWeb.ip} disabled={!isAdmin} placeholder="192.168.0.10"
                             onChange={(e) => setSnWeb((p) => ({ ...p, ip: e.target.value }))} style={{ flex: 1, minWidth: 0 }} />
                    </Row>
                    <Row label="Port (Web)">
                      <input value={snWeb.port} disabled={!isAdmin} placeholder="8000"
                             onChange={(e) => setSnWeb((p) => ({ ...p, port: e.target.value }))} style={{ width: 90 }} />
                    </Row>
                    <Row label="DICOM Port">
                      {/* DIMSE(C-ECHO/C-STORE) 통신 포트 — 웹(HTTP) 포트와 다르다. Echo 테스트는 이 포트로 나간다(미입력 시 Port 폴백) */}
                      <input value={snWeb.dicom_port} disabled={!isAdmin} placeholder="4242"
                             title={tr("DICOM C-ECHO/C-STORE 등 DIMSE 통신 포트 — 웹(HTTP) 포트와 다릅니다 (병원 컨테이너는 4301 등)")}
                             onChange={(e) => setSnWeb((p) => ({ ...p, dicom_port: e.target.value }))} style={{ width: 90 }} />
                    </Row>
                    <Row label="Name">
                      <input value={snWeb.name} disabled={!isAdmin} placeholder="Saintview Main"
                             onChange={(e) => setSnWeb((p) => ({ ...p, name: e.target.value }))} style={{ flex: 1, minWidth: 0 }} />
                    </Row>
                    <Row label="AE Title">
                      <input value={snWeb.ae_title} disabled={!isAdmin} placeholder="SAINTVIEW"
                             onChange={(e) => setSnWeb((p) => ({ ...p, ae_title: e.target.value.toUpperCase() }))} style={{ flex: 1, minWidth: 0 }} />
                    </Row>
                  </div>
                  {isAdmin && (
                    <div>
                      <button className="primary" onClick={async () => {
                        try {
                          await api.putSetting("server.network", {
                            local_share_dir: snDir,
                            web: { ...snWeb, port: Number(snWeb.port) || snWeb.port, dicom_port: Number(snWeb.dicom_port) || undefined },
                          }, "global");
                          setSnMsg(tr("서버 네트워크 설정 저장됨 (전역)"));
                        } catch (e) { setSnMsg(e instanceof Error ? e.message : tr("저장 실패")); }
                      }}>{tr("서버 설정 저장")}</button>
                    </div>
                  )}

                  {/* ── Live (원격 PACS 직결) ─────────────────────────────────
                      '어느 서버의 데이터를 볼 것인가'는 웹 서버 설정과 같은 축이라 여기에 둔다.
                      예전엔 워크리스트의 [WebPACS] 팝업에만 있어서 찾기 어려웠다. */}
                  {/* ⚠ 자체 <form> 으로 격리한다 — form 밖에 type=password 가 있으면 크롬이 문서 전체를
                      '주인 없는(unowned) 합성 로그인 폼'으로 묶어, 같은 문서의 이름 없는 텍스트 필드
                      (워크리스트 SEARCH 등)에 저장된 자격증명을 자동완성으로 채워 넣는다.
                      로그인 폼이 아니므로 autoComplete="off"(+비번은 new-password)로 저장 후보에서도 뺀다.
                      onSubmit 은 반드시 막는다(엔터 = 페이지 리로드 방지). */}
                  <form autoComplete="off" onSubmit={(e) => e.preventDefault()}
                        style={{ marginTop: 14, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 4, color: "#22c55e" }}>
                      {tr("Live — 원격 PACS 직결 (복사 없음)")}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 7, lineHeight: 1.7 }}>
                      {tr("원격 PACS 의 워크리스트·영상·판독을")} <b>{tr("복사 없이 그대로")}</b> {tr("사용합니다. 켜면 워크리스트 우측 서버 버튼에서")} <b style={{ color: "#22c55e" }}>Live</b> {tr("로 전환할 수 있습니다.")}
                    </div>
                    <Row label={tr("사용")}>
                      <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input type="checkbox" checked={lv.enabled} disabled={!isAdmin}
                               onChange={(e) => setLv((p) => ({ ...p, enabled: e.target.checked }))} />
                        {tr("Live 모드 활성화")}
                      </label>
                    </Row>
                    <Row label={tr("원격 주소")}>
                      <input value={lv.base_url} disabled={!isAdmin} placeholder="https://api.example.co.kr"
                             name="live-base-url" autoComplete="off" spellCheck={false}
                             onChange={(e) => setLv((p) => ({ ...p, base_url: e.target.value }))}
                             style={{ width: 320 }} />
                    </Row>
                    <Row label={tr("계정")}>
                      <input value={lv.user_id} disabled={!isAdmin} placeholder={tr("원격 PACS 사용자 ID")}
                             name="live-user-id" autoComplete="off" spellCheck={false}
                             onChange={(e) => setLv((p) => ({ ...p, user_id: e.target.value }))}
                             style={{ width: 200 }} />
                    </Row>
                    <Row label={tr("비밀번호")}>
                      <input type="password" value={lvPw} disabled={!isAdmin}
                             name="live-password" autoComplete="new-password"
                             placeholder={lv.has_password ? tr("(저장됨 — 바꿀 때만 입력)") : tr("비밀번호")}
                             onChange={(e) => setLvPw(e.target.value)} style={{ width: 200 }} />
                    </Row>
                    <Row label={tr("SSL 인증서")}>
                      <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input type="checkbox" checked={lv.verify_ssl} disabled={!isAdmin}
                               onChange={(e) => setLv((p) => ({ ...p, verify_ssl: e.target.checked }))} />
                        {tr("인증서 검증 (자체서명 서버면 해제)")}
                      </label>
                    </Row>
                    {isAdmin && (
                      <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6 }}>
                        {/* form 안의 button 은 기본이 submit — 반드시 type="button" (리로드 방지) */}
                        <button type="button" className="primary" onClick={async () => {
                          try {
                            const r = await api.webpacsSaveConfig({
                              enabled: lv.enabled, base_url: lv.base_url.trim(),
                              user_id: lv.user_id.trim(), verify_ssl: lv.verify_ssl,
                              ...(lvPw ? { password: lvPw } : {}),   // 빈 칸이면 기존 비밀번호 유지
                            });
                            setLv((p) => ({ ...p, has_password: r.value.has_password }));
                            setLvPw("");
                            setLvMsg(tr("Live 설정 저장됨"));
                          } catch (e) { setLvMsg(e instanceof Error ? e.message : tr("저장 실패")); }
                        }}>{tr("Live 설정 저장")}</button>
                        <button type="button" onClick={async () => {
                          setLvMsg(tr("연결 테스트 중…"));
                          try {
                            const r = await api.webpacsTest();
                            setLvMsg(r.ok ? `✅ ${tr("연결됨 — 원격 검사")} ${r.study_count ?? "?"}${tr("건")}`
                                          : `❌ ${r.detail || tr("연결 실패")}`);
                          } catch (e) { setLvMsg(`❌ ${e instanceof Error ? e.message : tr("연결 실패")}`); }
                        }}>{tr("연결 테스트")}</button>
                        {lvMsg && <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>{lvMsg}</span>}
                      </div>
                    )}
                  </form>
                </Group>
                <Group title={tr("연결 테스트 (Ping · DICOM Echo · DB)")}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button onClick={async () => {
                      if (!snWeb.ip) { setSnMsg(tr("IP를 먼저 입력하세요")); return; }
                      setSnMsg(tr("Ping 테스트 중…"));
                      try {
                        const r = await api.netPing(snWeb.ip, Number(snWeb.port) || undefined);
                        setSnMsg(`Ping: ${r.icmp ? `OK (${r.icmp_ms}ms)` : tr("실패")}${r.tcp !== null ? ` · TCP ${snWeb.port}: ${r.tcp ? "OK" : tr("실패")}` : ""}`);
                      } catch (e) { setSnMsg(e instanceof Error ? e.message : tr("Ping 실패")); }
                    }}>{tr("Ping 테스트")}</button>
                    <button onClick={async () => {
                      // Echo 는 DICOM Port 로 — 웹(HTTP) 포트에 시도하면 연관 수립이 항상 실패한다
                      const dport = Number(snWeb.dicom_port) || Number(snWeb.port);
                      if (!snWeb.ip || !dport) { setSnMsg(tr("IP/DICOM Port를 먼저 입력하세요")); return; }
                      setSnMsg(`${tr("DICOM C-ECHO 테스트 중…")} (:${dport})`);
                      try {
                        const r = await api.netEcho(snWeb.ip, dport, snWeb.ae_title);
                        setSnMsg(`DICOM Echo(:${dport}): ${r.ok ? "✅ " : "❌ "}${r.detail}${!r.ok && !snWeb.dicom_port ? ` — ${tr("웹 포트로 시도했다면 DICOM Port 를 입력하세요")}` : ""}`);
                      } catch (e) { setSnMsg(e instanceof Error ? e.message : tr("Echo 실패")); }
                    }}>DICOM Echo Test</button>
                    <button onClick={async () => {
                      setSnMsg(tr("DB 연동 테스트 중…"));
                      try {
                        const r = await api.netDb();
                        setSnMsg(r.ok
                          ? `DB: ✅ ${r.dialect} (${r.latency_ms}ms) — ${r.target}`
                          : `DB: ❌ ${r.detail}`);
                      } catch (e) { setSnMsg(e instanceof Error ? e.message : tr("DB 테스트 실패")); }
                    }}>{tr("DB 연동 Test")}</button>
                  </div>
                  {snMsg && <div style={{ fontSize: 12.5, color: snMsg.includes("❌") || snMsg.includes("실패") ? "var(--stat-emergency)" : "var(--stat-final)" }}>{snMsg}</div>}
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    {tr("테스트는 관리자 권한으로 백엔드 서버에서 수행됩니다 (Echo=AE Title 검증 포함, DB=현재 연결 엔진 SELECT 1).")}
                  </div>
                </Group>
              </>
            )}

            {page === "collab" && (
              <>
                {/* 협진 창 하단과 **같은 컴포넌트**(MediaPermPanel) — 두 곳이 갈리면 안내가 어긋난다 */}
                <Group title={tr("미디어 권한·장치")}>
                  <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginBottom: 6 }}>
                    {tr("협진 통화가 안 될 때 1차 점검 — 협진 창 하단에도 같은 패널이 있습니다.")}
                  </div>
                  <MediaPermPanel />
                </Group>
                {/* 협진 창 동작(2026-08-10 사용자 확정) — ✕/숨기기 구별 · 미디어 배타 */}
                <Group title={tr("협진 창 동작")}>
                  <Row label={tr("✕ 버튼 동작")}>
                    <select value={colCfg.close_action}
                            onChange={(e) => setColCfg((p) => ({ ...p, close_action: e.target.value as "end" | "hide" }))}>
                      <option value="end">{tr("종료 — 통화를 끊고 창을 닫습니다")}</option>
                      <option value="hide">{tr("숨기기 — 통화·대화를 유지한 채 창만 감춥니다")}</option>
                    </select>
                  </Row>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 6 }}>
                    {tr("협진 창의 — 버튼은 언제나 '숨기기'입니다. ✕ 의 동작만 여기서 바꿉니다.")}
                  </div>
                  <Row label={tr("미디어 동시 사용 제한")}>
                    <label style={{ display: "flex", gap: 5, alignItems: "flex-start", fontSize: 12 }}>
                      <input type="checkbox" checked={colCfg.media_exclusive}
                             onChange={(e) => setColCfg((p) => ({ ...p, media_exclusive: e.target.checked }))} />
                      <span>{tr("마이크·화상·화면 공유는 한 대화에서만 — 다른 대화에서는 버튼이 비활성화됩니다. 끄면 다른 대화에서 켤 때 기존 통화를 끊고 가져옵니다.")}</span>
                    </label>
                  </Row>
                </Group>
                <Group title={tr("초대 시 자동으로 줄 기본 권한")}>
                  <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginBottom: 6 }}>
                    {tr("여기서 정한 것은 기본값입니다. 협진 중에는 협진 페이지에서 참가자마다 켜고 끌 수 있습니다.")}
                  </div>
                  {COLLAB_CAP_ROWS.map(([k, label]) => (
                    <label key={k} style={{ display: "flex", gap: 6, alignItems: "flex-start",
                                            fontSize: 12.5, padding: "2px 0" }}>
                      <input type="checkbox" checked={colCfg.default_caps.includes(k)}
                             onChange={(e) => setColCfg((p) => ({
                               ...p,
                               default_caps: e.target.checked
                                 ? [...p.default_caps, k]
                                 : p.default_caps.filter((x) => x !== k),
                             }))} />
                      <span>{tr(label)}</span>
                    </label>
                  ))}
                  <div style={{ fontSize: 11.5, color: "var(--stat-emergency)", marginTop: 8,
                                lineHeight: 1.6 }}>
                    {tr("판독 수정·영상 삭제는 협진으로 절대 위임되지 않습니다 — 목록에 없는 이유입니다.")}
                  </div>
                </Group>

                <Group title={tr("화면 조작 · 발표자")}>
                  <label style={{ display: "flex", gap: 6, alignItems: "flex-start", fontSize: 12.5 }}>
                    <input type="checkbox" checked={colCfg.follow_default}
                           onChange={(e) => setColCfg((p) => ({ ...p, follow_default: e.target.checked }))} />
                    <span>{tr("참가 시 발표자 화면 따라가기 (내가 화면을 만지면 자유 보기로 전환)")}</span>
                  </label>
                  <label style={{ display: "flex", gap: 6, alignItems: "flex-start", fontSize: 12.5,
                                  marginTop: 4 }}>
                    <input type="checkbox" checked={colCfg.auto_grant}
                           onChange={(e) => setColCfg((p) => ({ ...p, auto_grant: e.target.checked }))} />
                    <span>{tr("참가자의 권한 요청을 자동 승인")}</span>
                  </label>
                  <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 6,
                                lineHeight: 1.6 }}>
                    {tr("화면 조작(줌·팬·W/L)은 발표자 1명만 전원에게 송출합니다. 나머지 참가자는 각자 자유롭게 보며, 주석·커서는 항상 전원에게 공유됩니다.")}
                  </div>
                </Group>

                <Group title={tr("참여자 표시")}>
                  <label style={{ display: "flex", gap: 6, alignItems: "flex-start", fontSize: 12.5 }}>
                    <input type="checkbox" checked={colCfg.cursor_labels}
                           onChange={(e) => setColCfg((p) => ({ ...p, cursor_labels: e.target.checked }))} />
                    <span>{tr("마우스 커서 옆에 참여자 아이디 표시")}</span>
                  </label>
                  <label style={{ display: "flex", gap: 6, alignItems: "flex-start", fontSize: 12.5,
                                  marginTop: 4 }}>
                    <input type="checkbox" checked={colCfg.author_colors}
                           onChange={(e) => setColCfg((p) => ({ ...p, author_colors: e.target.checked }))} />
                    <span>{tr("참여자별 색으로 커서·툴·글자 구분")}</span>
                  </label>
                </Group>

                <Group title={tr("화상·음성 네트워크 (STUN/TURN)")}>
                  <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginBottom: 6,
                                lineHeight: 1.6 }}>
                    {tr("병원 내부망은 비워 두면 됩니다. 인터넷을 건너는 협진에만 STUN/TURN 을 넣으세요 (JSON 배열).")}
                  </div>
                  <textarea value={colCfg.ice} rows={3} spellCheck={false}
                            placeholder='[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]'
                            onChange={(e) => setColCfg((p) => ({ ...p, ice: e.target.value }))}
                            style={{ width: "100%", fontSize: 11.5, fontFamily: "monospace" }} />
                </Group>
              </>
            )}

            {page === "reading" && (
              <>
                {/* 서브탭 — 기본 설정 / 단축키 설정 / 템플릿 설정 (레퍼런스 Report 설정) */}
                <div style={{ display: "flex", gap: 2, borderBottom: "1px solid var(--border)" }}>
                  {([["basic", "기본 설정"], ["shortcut", "단축키 설정"], ["template", "템플릿 설정"]] as const).map(([k, label]) => (
                    <div key={k} onClick={() => setRdTab(k)}
                         style={{ padding: "6px 16px", fontSize: 12.5, cursor: "pointer",
                                  fontWeight: rdTab === k ? 700 : 400,
                                  background: rdTab === k ? "var(--bg-elevated)" : undefined,
                                  borderBottom: rdTab === k ? "2px solid var(--accent)" : "2px solid transparent" }}>
                      {tr(label)}
                    </div>
                  ))}
                </div>

                {rdTab === "basic" && (
                  <>
                    <Group title={tr("판독의 등록 — 확정 서명에 기록")}>
                      <Row label={tr("이름(표시명)")}>
                        <input value={profName} onChange={(e) => setProfName(e.target.value)}
                               placeholder={tr("홍길동")} style={{ width: 220 }} />
                      </Row>
                      <Row label={tr("면허번호")}>
                        <input value={profLicense} onChange={(e) => setProfLicense(e.target.value)}
                               placeholder="12345" style={{ width: 220 }} />
                      </Row>
                      <Row label={tr("전문의 번호")}>
                        <input value={profMajor} onChange={(e) => setProfMajor(e.target.value)}
                               placeholder="67890" style={{ width: 220 }} />
                        <span style={{ fontSize: 11, color: "var(--text-secondary)", marginLeft: 8 }}>
                          {tr("원격 PACS 계정으로 로그인하면 면허·전문의 번호가 자동으로 채워집니다(등록이 없으면 공란).")}
                        </span>
                      </Row>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <button className="primary" onClick={async () => {
                          await api.putProfile(profName, profLicense, profMajor);
                          setSaved(tr("판독의 정보 저장됨 — 이후 확정(서명)부터 적용"));
                        }}>{tr("판독의 정보 저장")}</button>
                      </div>
                      {/* 칩 집계 기간(2026-08-10 사용자 확정) — 배정의(A 계정) 로그인 시 상태 칩
                          (전체·미판독·판독중…)을 최근 N일 기준으로 집계. 응급은 **1일 고정**. */}
                      <Row label={tr("칩 집계 기간")}>
                        <select value={String(chipDays)}
                                onChange={(e) => {
                                  const n = Math.min(30, Math.max(1, Number(e.target.value) || 30));
                                  setChipDays(n);
                                  localStorage.setItem("sv_chip_days", String(n));
                                }}>
                          {Array.from({ length: 30 }, (_, i) => i + 1).map((n) => (
                            <option key={n} value={n}>{n}</option>
                          ))}
                        </select>
                        <span style={{ fontSize: 11, color: "var(--text-secondary)", marginLeft: 8 }}>
                          {tr("일 — 배정의(원격 PACS 계정) 로그인 시 워크리스트 상태 칩의 집계 기간입니다. 응급 칩은 항상 1일(당일) 기준입니다.")}
                        </span>
                      </Row>
                    </Group>
                    {/* 판독창 설정(2026-08-10 사용자 확정) — 판독창 상단 'Worklist 뷰어' 체크와
                        같은 키(report.prefs.worklist_viewer)를 읽고 써서 양방향·계정 저장이다. */}
                    <Group title={tr("판독창 설정")}>
                      <Row label={tr("Worklist 뷰어 사용")}>
                        <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12 }}>
                          <input type="checkbox" checked={!!rdOpts.worklist_viewer}
                                 onChange={(e) => setRdOpts((p) => ({ ...p, worklist_viewer: e.target.checked }))} />
                          {tr("판독창 하단에 워크리스트를 표시합니다 (판독창 상단 체크와 연동 · 계정별 저장)")}
                        </label>
                      </Row>
                    </Group>
                    <Group title={tr("Compare — 비교할 과거 검사를 어디서 고를까")}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {(["patient", "reader"] as CompareBasisKind[]).map((k) => (
                          <label key={k} style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                            <input type="radio" name="cmpbasis" checked={cmpBasis.basis === k}
                                   onChange={() => setCmpCfg((c) => ({ ...c, basis: k }))}
                                   style={{ marginTop: 3 }} />
                            <span>
                              <b style={{ fontSize: 12.5 }}>{tr(BASIS_LABEL[k])}</b>
                              <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.6 }}>
                                {k === "patient"
                                  ? tr("같은 환자(차트번호)의 과거 검사에서 고릅니다. 판독 비교의 기본입니다.")
                                  : tr("내가 판독했던 검사 전체에서 고릅니다 — 환자가 달라도 됩니다. 내가 이미 판독하며 본 검사만 모집단이라 새로 열리는 자료는 없습니다.")}
                              </div>
                            </span>
                          </label>
                        ))}
                      </div>

                      <Row label={tr("좁히기")}>
                        <span style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
                          <label style={{ display: "flex", gap: 5, alignItems: "center" }}>
                            <input type="checkbox" checked={cmpBasis.by_modality}
                                   onChange={(e) => setCmpCfg((c) => ({ ...c, by_modality: e.target.checked }))} />
                            Modality
                          </label>
                          <label style={{ display: "flex", gap: 5, alignItems: "center" }}>
                            <input type="checkbox" checked={cmpBasis.by_body_part}
                                   onChange={(e) => setCmpCfg((c) => ({ ...c, by_body_part: e.target.checked }))} />
                            Bodypart
                          </label>
                        </span>
                      </Row>
                      <Row label={tr("기간")}>
                        <select value={cmpBasis.period}
                                onChange={(e) => setCmpCfg((c) => ({ ...c, period: e.target.value as ComparePeriod }))}>
                          {PERIODS.map((p) => <option key={p} value={p}>{tr(PERIOD_LABEL[p])}</option>)}
                        </select>
                      </Row>
                      <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.7 }}>
                        {tr("체크한 축만")} <b>{tr("지금 보는 검사와 같은 것")}</b>{tr("으로 좁힙니다. 아무것도 체크하지 않으면 모집단 전체입니다.")}
                        <br />{tr("예) Chest CT 판독 중 · 판독의사 기준 · 둘 다 체크 → 내가 판독한")} <b>Chest CT</b>{tr("들. Bodypart 만 체크 →")} <b>Chest X-ray · Chest MRI</b> {tr("까지 (환자 무관).")}
                        <br />{tr("기간의 기준점은 오늘이 아니라")} <b>{tr("지금 보는 검사의 검사일")}</b>{tr("입니다 — 예전 검사를 되짚어 판독할 때 '오늘로부터 1년'은 의미가 없기 때문입니다.")}
                        <br />{tr("이 값은")} <b>{tr("뷰어가 시작할 때의 기본값")}</b>{tr("입니다. 뷰어 Compare 창에서 그 자리에서 바꿀 수 있고, 그 변경은 저장되지 않습니다.")}
                      </div>
                    </Group>
                    <Group title={tr("레포트 옵션")}>
                      {([
                        ["always_report_window", "판독 창 항상 별도로 열기 — 워크리스트 옆 웹창(검사 선택 연동)"],
                        ["open_next_after_save", "저장(확정) 후 다음 레포트 열기"],
                        ["save_alert", "레포트 저장 알림 사용"],
                        ["auto_insert_prior", "이전 검사 비교 정보 자동 삽입"],
                        ["cvr_notice", "CVR Notice — critical 소견 경고 기본 표시"],
                      ] as const).map(([k, label]) => (
                        <label key={k} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
                          <input type="checkbox" checked={!!rdOpts[k]}
                                 onChange={(e) => setRdOpts((p) => ({ ...p, [k]: e.target.checked }))} />
                          {tr(label)}
                        </label>
                      ))}
                      <Row label={tr("상용구 백업 주기")}>
                        <input type="number" min={0} max={1440} style={{ width: 70 }}
                               value={Number(rdOpts.phrase_backup_min ?? 10)}
                               onChange={(e) => setRdOpts((p) => ({ ...p, phrase_backup_min: Number(e.target.value) }))} />
                        <span style={{ fontSize: 11.5, color: "var(--text-secondary)", marginLeft: 6 }}>
                          {tr("분 — 판독창의 내 단축키·템플릿(계정 로컬)을 주기적으로 서버에 백업 (0=끄기)")}
                        </span>
                      </Row>
                      <Row label={tr("사이드바 기본 탭")}>
                        <select value={String(rdOpts.sidebar_tab ?? "history")}
                                onChange={(e) => setRdOpts((p) => ({ ...p, sidebar_tab: e.target.value }))}>
                          <option value="history">{tr("판독 이력")}</option>
                          <option value="read">{tr("판독")}</option>
                        </select>
                      </Row>
                      <Row label={tr("단축키 패널 기본 탭")}>
                        <select value={String(rdOpts.panel_tab ?? "shortcut")}
                                onChange={(e) => setRdOpts((p) => ({ ...p, panel_tab: e.target.value }))}>
                          <option value="shortcut">{tr("단축키")}</option>
                          <option value="template">{tr("템플릿")}</option>
                        </select>
                      </Row>
                      <Row label={tr("텍스트 삽입 위치")}>
                        <select value={String(rdOpts.insert_pos ?? "end")}
                                onChange={(e) => setRdOpts((p) => ({ ...p, insert_pos: e.target.value }))}>
                          <option value="end">{tr("맨 끝에 삽입")}</option>
                          <option value="cursor">{tr("커서 위치에 삽입")}</option>
                        </select>
                      </Row>
                    </Group>
                    <Group title={tr("비교 (Compare) — 과거검사 나란히 보기")}>
                      <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
                        <input type="checkbox" checked={cmpCfg.enabled}
                               onChange={(e) => setCmpCfg((p) => ({ ...p, enabled: e.target.checked }))} />
                        {tr("비교 기능 사용 (⇄ Compare)")}
                      </label>
                      <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, opacity: cmpCfg.enabled ? 1 : 0.5 }}>
                        <input type="checkbox" checked={cmpCfg.multi_monitor} disabled={!cmpCfg.enabled}
                               onChange={(e) => setCmpCfg((p) => ({ ...p, multi_monitor: e.target.checked }))} />
                        {tr("다중 모니터 배치 — Viewer 모니터가 2개 이상이면 비교검사를 다음 모니터에 (끝번→첫 모니터 순환)")}
                      </label>
                      <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, opacity: cmpCfg.enabled ? 1 : 0.5 }}>
                        <input type="checkbox" checked={cmpCfg.labels} disabled={!cmpCfg.enabled}
                               onChange={(e) => setCmpCfg((p) => ({ ...p, labels: e.target.checked }))} />
                        {tr("M/S 라벨 표시 — 기준 검사")} <b style={{ color: "var(--stat-final)" }}>Compare M</b>{tr(", 비교 검사")} <b style={{ color: "var(--stat-final)" }}>Compare S1·S2</b> {tr("(녹색·중앙 상단)")}
                      </label>
                      <Row label={tr("과거검사(History) 비교 표시")}>
                        <select value={cmpCfg.prior_mode} disabled={!cmpCfg.enabled}
                                onChange={(e) => setCmpCfg((p) => ({ ...p, prior_mode: e.target.value as "layout" | "monitor" }))}>
                          <option value="layout">{tr("Layout 띄우기 — 한 화면 1:2 분할 (좌=현재, 우=과거)")}</option>
                          <option value="monitor">{tr("Monitor 띄우기 — 인접 모니터 창 (다음, 끝번이면 이전)")}</option>
                        </select>
                      </Row>
                      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                        {tr("판독 도크 History의 과거검사(Prior Studies) 썸네일 클릭 시 적용. Monitor 띄우기 예: 모니터 1·2·3에서 3번 기준→2번, 1번 기준→2번에 표시. 조건 미충족(단일 모니터·감지/팝업 차단) 시 Layout 1:2로 폴백. ⇄ Compare(다중 선택)의 다중 모니터 배치는 위 체크가 담당합니다. 창 관리 권한(HTTPS)·팝업 허용 필요.")}
                      </div>
                    </Group>
                    <Group title={tr("시스템 단축키")} right={
                      <button style={{ padding: "1px 8px", fontSize: 11 }}
                              onClick={() => setRdOpts((p) => ({ ...p, key_save: "Ctrl+S", key_approve: "Ctrl+Shift+A", key_mic: "Ctrl+M" }))}>
                        {tr("기본값으로 초기화")}
                      </button>
                    }>
                      <Row label={tr("리포트 저장")}>
                        <KeyCaptureInput value={String(rdOpts.key_save ?? "Ctrl+S")}
                                         onChange={(v) => setRdOpts((p) => ({ ...p, key_save: v }))} />
                      </Row>
                      <Row label={tr("리포트 승인")}>
                        <KeyCaptureInput value={String(rdOpts.key_approve ?? "Ctrl+Shift+A")}
                                         onChange={(v) => setRdOpts((p) => ({ ...p, key_approve: v }))} />
                      </Row>
                      <Row label={tr("음성 판독 (STT) 토글")}>
                        <KeyCaptureInput value={String(rdOpts.key_mic ?? "Ctrl+M")}
                                         onChange={(v) => setRdOpts((p) => ({ ...p, key_mic: v }))} />
                      </Row>
                      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                        {tr("옵션·단축키는 OK(저장) 시 계정에 저장(로밍) — 뷰어 판독 창에 즉시 적용됩니다.")}
                      </div>
                    </Group>
                  </>
                )}

                {rdTab === "shortcut" && (
                  <ReadingItemEditor kind="phrase" items={phrases}
                                     reload={() => api.phrases().then((r) => setPhrases(r.items))} />
                )}
                {rdTab === "template" && (
                  <ReadingItemEditor kind="template" items={phrases}
                                     reload={() => api.phrases().then((r) => setPhrases(r.items))} />
                )}
              </>
            )}

            {(["wlSaint", "wlTy", "wlIn"] as const).includes(page as never) && (() => {
              const vk: ViewerKey = page === "wlSaint" ? "sv" : page === "wlTy" ? "ty" : "infi";
              const vLabel = page === "wlSaint" ? "SaintView" : page === "wlTy" ? "T-View" : "I-View";
              const ov = wlBy[vk];
              // 오버라이드 시작 시드값 — sv/infi 는 각 스킨 기본 컬럼, ty 는 공통 컬럼
              // 2026-08-10 사용자 확정 — 세 뷰어 모두 원 서버(A) 순서(DEFAULT_COLUMNS)가 초기 기본.
              // 구 SV/INFI 원형은 '뷰어 원형 되돌리기' 참고용으로만 남아 있다(Worklist.tsx 주석).
              const colDefault = vk === "ty" ? columns : DEFAULT_COLUMNS;
              return (
                <>
                  <Group title={vLabel + " " + tr("워크리스트 — 뷰어별 그리드 컬럼 (계정별 저장)")}>
                    <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, marginBottom: 8 }}>
                      <input type="checkbox" checked={!ov}
                             onChange={(e) => setWlBy((p) => ({ ...p, [vk]: e.target.checked ? null : [...colDefault] }))} />
                      {tr("공통 워크리스트 설정 사용 (기본) — 해제하면 이 뷰어 전용 컬럼 구성을 편집합니다")}
                    </label>
                    {ov && (
                      <FilterSettingList
                        all={Object.keys(COLUMN_DEFS)}
                        selected={ov}
                        labelOf={(k) => tr(COLUMN_DEFS[k].label)}
                        onChange={(cols) => setWlBy((p) => ({ ...p, [vk]: cols }))}
                      />
                    )}
                    <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                      {vLabel} {tr("모드로 워크리스트를 열면 이 구성이 공통 설정 대신 적용됩니다. OK(저장) 시 반영.")}
                    </div>
                  </Group>
                  <Group title={vLabel + " " + tr("워크리스트 — 구성요소 표시/숨김 (화면 드래그·✕ 와 동기)")}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
                      {vk === "ty"
                        ? ([
                            ["orders", "오더/예약 (Order)"], ["prior", "과거검사 (Related-1)"],
                            ["compare", "비교세트 (Related-2)"], ["thumb", "썸네일 (Thumbnail)"],
                            ["std", "상용구 (Reference)"], ["comment", "Comment / MEMO"],
                            ["report", "리포트 (Report)"],
                          ] as const).map(([pk, label]) => (
                            <label key={pk} style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12.5 }}>
                              <input type="checkbox" checked={!!wlPanels[pk]}
                                     onChange={(e) => setWlPanels((p) => ({ ...p, [pk]: e.target.checked }))} />
                              {tr(label)}
                            </label>
                          ))
                        : SVINFI_PANELS.map((pk) => {
                            const cur = wlPanelsBy[vk as "sv" | "infi"] ?? {};
                            return (
                              <label key={pk} style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12.5 }}>
                                <input type="checkbox" checked={cur[pk] !== false}
                                       onChange={(e) => setWlPanelsBy((p) => ({
                                         ...p, [vk]: { ...(p[vk as "sv" | "infi"] ?? {}), [pk]: e.target.checked },
                                       }))} />
                                {tr(SVINFI_PANEL_LABEL[pk])}
                              </label>
                            );
                          })}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                      {tr("해제 = 워크리스트에서 숨김. 화면에서 스플리터를 최소까지 드래그하거나 ✕(패널 그립)로 숨긴 상태가 여기와 양방향으로 동기됩니다.")}
                    </div>
                  </Group>
                </>
              );
            })()}
            {page === "worklist" && (
              <>
                {(() => {
                  // 통합 편집기(2026-08-10 사용자 확정) — 그리드 컬럼과 검색 필드는 겹치는
                  // 개념이라 한 표(표시·검색·순서)로 합쳤다. 목록은 **선택 뷰어의 실제 표시
                  // 순서**(그리드 헤더 드래그와 같은 by_viewer 저장)를 그대로 보여 준다.
                  const cvk: ViewerKey = clientViewer === "sv" ? "sv" : clientViewer === "infi" ? "infi" : "ty";
                  const eff = ((wlBy[cvk]?.length ? wlBy[cvk]! : (cvk === "ty" && columns.length ? columns : DEFAULT_COLUMNS)))
                    .filter((c) => COLUMN_DEFS[c]);
                  return (
                <Group title={tr("워크리스트 항목 구성 — 표시·검색·순서 (그리드와 같은 계정별 저장)")}>
                  <FilterSettingList
                    all={Object.keys(COLUMN_DEFS)}
                    selected={eff}
                    labelOf={(k) => tr(COLUMN_DEFS[k].label)}
                    onChange={(next) => { setColumns(next); setWlBy((p) => ({ ...p, [cvk]: next })); }}
                    searchable={COL_FIND_MAP}
                    searchSel={findFields}
                    onSearchChange={setFindFields}
                    searchOnly={FIND_ONLY_FIELDS}
                    searchOnlyLabelOf={(k) => tr(FIND_FIELDS[k])}
                  />
                  <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.7 }}>
                    {tr("표시 = 그리드 컬럼 · 검색 = 검색 필터 바 노출 · 행 드래그/▲▼ = 순서. 그리드 헤더를 드래그해 바꾼 순서와 같은 저장(계정별·뷰어별)이라 서로 그대로 반영됩니다.")}
                  </div>
                </Group>
                  );
                })()}
                <Group title={tr("검색창 설정 — 통합 검색(SEARCH/AI)의 방식·범위")}>
                  <Row label={tr("기본 방식")}>
                    <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      <input type="radio" name="sbmode" checked={sbMode === "text"} onChange={() => setSbMode("text")} />
                      {tr("SEARCH — 아래 범위에서 문법 검색")}
                    </label>
                    <label style={{ display: "flex", gap: 4, alignItems: "center", marginLeft: 12 }}>
                      <input type="radio" name="sbmode" checked={sbMode === "ai"} onChange={() => setSbMode("ai")} />
                      {tr("AI — 자연어를 검색 조건으로 변환")}
                    </label>
                  </Row>
                  <Row label={tr("검색 범위")}>
                    <span style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                      {Object.entries(SEARCH_SCOPE_FIELDS).map(([k, label]) => (
                        <label key={k} style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12 }}>
                          <input type="checkbox" checked={sbFields.includes(k)}
                                 onChange={(e) => setSbFields((p) => e.target.checked ? [...p, k] : p.filter((x) => x !== k))} />
                          {tr(label)}
                        </label>
                      ))}
                    </span>
                  </Row>
                  <Row label={tr("다중어 결합")}>
                    <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      <input type="radio" name="sbop" checked={sbOp === "and"} onChange={() => setSbOp("and")} />
                      {tr("AND — 모든 단어 일치(공백 구분)")}
                    </label>
                    <label style={{ display: "flex", gap: 4, alignItems: "center", marginLeft: 12 }}>
                      <input type="radio" name="sbop" checked={sbOp === "or"} onChange={() => setSbOp("or")} />
                      {tr("OR — 한 단어라도 일치")}
                    </label>
                  </Row>
                  <Row label={tr("의뢰일시 표시")}>
                    <select value={reqDtFmt} onChange={(e) => setReqDtFmtState(e.target.value)}>
                      {REQ_DT_FMTS.map((f) => <option key={f} value={f}>{f}</option>)}
                    </select>
                    <span style={{ fontSize: 11, color: "var(--text-secondary)", marginLeft: 8 }}>
                      {tr("워크리스트 '의뢰 일시' 컬럼의 표시 형식입니다.")}
                    </span>
                  </Row>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.7 }}>
                    {tr("문법: =단어(정확) · 단어%(접두) · !단어(제외) · 공백=다중어. 범위·방식·형식 모두 계정별 저장(로밍)입니다.")}<br />
                    {tr("⚠ Live(원격 직결)는 원격 PACS 파라미터 한계로 환자 ID/이름에만 통합 검색이 적용됩니다.")}
                  </div>
                </Group>
                <Group title={tr("상용구 관리 (DB — Modality×부위 분류 + Alt+단축키)")} right={
                  <button style={{ padding: "1px 8px", fontSize: 11 }} onClick={() => setPhraseModal("new")}>{tr("＋ 추가")}</button>
                }>
                  <table className="grid-table">
                    <thead><tr><th style={{ width: 90 }}>{tr("분류")}</th><th>NAME</th><th style={{ width: 56 }}>{tr("단축키")}</th><th style={{ width: 76 }}></th></tr></thead>
                    <tbody>
                      {phrases.map((p) => (
                        <tr key={p.id}>
                          <td>{p.category}</td>
                          <td title={p.text}>{p.name}</td>
                          <td style={{ color: "var(--accent)" }}>{p.shortcut && `Alt+${p.shortcut}`}</td>
                          <td style={{ whiteSpace: "nowrap" }}>
                            <button style={{ padding: "0 6px", fontSize: 11 }} onClick={() => setPhraseModal(p)}>✏</button>
                            <button style={{ padding: "0 6px", fontSize: 11 }} onClick={async () => {
                              if (!window.confirm(`${tr("상용구")} '${p.name}'${tr("을 삭제할까요?")}`)) return;
                              await api.deletePhrase(p.id);
                              api.phrases().then((r) => setPhrases(r.items));
                            }}>✕</button>
                          </td>
                        </tr>
                      ))}
                      {phrases.length === 0 && (
                        <tr><td colSpan={4} style={{ color: "var(--text-secondary)" }}>{tr("등록된 상용구 없음 — ＋추가")}</td></tr>
                      )}
                    </tbody>
                  </table>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    {tr("워크리스트 상용구(Std) 패널과 동일 DB — 리포트에서 Alt+단축키로 즉시 삽입.")}
                  </div>
                </Group>
                {phraseModal !== null && (
                  <PhraseEditModal
                    init={phraseModal === "new" ? null : phraseModal}
                    onSave={async (body) => {
                      if (phraseModal === "new") await api.createPhrase(body);
                      else await api.updatePhrase(phraseModal.id, body);
                      api.phrases().then((r) => setPhrases(r.items));
                    }}
                    onClose={() => setPhraseModal(null)}
                  />
                )}
                <Group title={tr("워크리스트 구성요소 (UBPACS-Z p.8 — Study List 제외 추가/삭제)")}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
                    {([
                      ["orders", "오더/예약 (Order)"],
                      ["prior", "과거검사 (Related Study List-1)"],
                      ["compare", "비교세트 (Related Study List-2)"],
                      ["thumb", "썸네일 (Thumbnail Window)"],
                      ["std", "상용구 (Reference Window)"],
                      ["comment", "Comment / MEMO"],
                      ["report", "리포트 (Report Window)"],
                    ] as const).map(([k, label]) => (
                      <label key={k} style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12.5 }}>
                        <input type="checkbox" checked={!!wlPanels[k]}
                               onChange={(e) => setWlPanels((p) => ({ ...p, [k]: e.target.checked }))} />
                        {tr(label)}
                      </label>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    {tr("체크 해제 시 워크리스트에서 해당 창이 숨겨집니다. 배치 순서는 워크리스트에서 그립(⋮) 드래그로 변경.")}
                  </div>
                </Group>
                <Group title={tr("워크리스트 페이지 탭 (UBPACS-Z — 최대 10)")}>
                  <table className="grid-table">
                    <thead><tr><th style={{ width: 130 }}>{tr("이름")}</th><th>{tr("검색 조건")}</th><th style={{ width: 118 }}></th></tr></thead>
                    <tbody>
                      {wlTabs.map((t, i) => (
                        <tr key={t.id}>
                          <td>{t.label}</td>
                          <td style={{ color: "var(--text-secondary)" }}>{folderSummary(t.filter)}</td>
                          <td style={{ whiteSpace: "nowrap" }}>
                            <button style={{ padding: "0 6px", fontSize: 11 }} title={tr("이름·검색 조건 수정")}
                                    onClick={() => setTabModal({ index: i })}>{tr("수정")}</button>
                            <button style={{ padding: "0 6px", fontSize: 11 }} disabled={i === 0} title={tr("위로")}
                                    onClick={() => {
                                      const next = [...wlTabs];
                                      [next[i - 1], next[i]] = [next[i], next[i - 1]];
                                      setWlTabs(next);
                                      saveTabs(next).then(() => setSaved(tr("페이지 탭 저장됨"))).catch(() => {});
                                    }}>▲</button>
                            <button style={{ padding: "0 6px", fontSize: 11 }} disabled={i === wlTabs.length - 1} title={tr("아래로")}
                                    onClick={() => {
                                      const next = [...wlTabs];
                                      [next[i], next[i + 1]] = [next[i + 1], next[i]];
                                      setWlTabs(next);
                                      saveTabs(next).then(() => setSaved(tr("페이지 탭 저장됨"))).catch(() => {});
                                    }}>▼</button>
                            <button style={{ padding: "0 6px", fontSize: 11 }} disabled={t.id === "default"} title={tr("삭제")}
                                    onClick={() => {
                                      if (!window.confirm(`'${t.label}' ${tr("페이지를 삭제할까요?")}`)) return;
                                      const next = wlTabs.filter((x) => x.id !== t.id);
                                      setWlTabs(next);
                                      saveTabs(next).then(() => setSaved(tr("페이지 탭 저장됨"))).catch(() => {});
                                    }}>✕</button>
                          </td>
                        </tr>
                      ))}
                      {wlTabs.length === 0 && (
                        <tr><td colSpan={3} style={{ color: "var(--text-secondary)" }}>{tr("페이지 없음")}</td></tr>
                      )}
                    </tbody>
                  </table>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <button onClick={() => setTabModal("add")} disabled={wlTabs.length >= 10}>{tr("＋ 페이지 추가")}</button>
                    <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                      {tr("워크리스트 상단 탭과 동일 데이터 — 탭 ＋ 버튼은 현재 검색조건을 스냅샷으로 등록.")}
                    </span>
                  </div>
                </Group>
                <Group title={tr("검색 폴더 트리 (탐색기형 — 예: 응급실 › DR › Chest)")}>
                  <div style={{
                    height: 190, display: "flex", flexDirection: "column", padding: 4,
                    border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-canvas)",
                  }}>
                    <FolderTreeEditor nodes={wlTree} selectedId={selTreeId}
                                      onSelect={(n) => setSelTreeId(n.id)}
                                      onChange={(next) => {
                                        setWlTree(next);
                                        saveTree(next).then(() => setSaved(tr("검색 폴더 저장됨"))).catch(() => {});
                                      }} />
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    {tr("각 폴더는 자기 조건만 가지며, 워크리스트에서 폴더 클릭 시")} <b>{tr("상위 경로 조건이 누적 병합")}</b>{tr("되어 검색됩니다. 변경은 즉시 서버 저장(로밍).")}
                  </div>
                </Group>
                {tabModal !== null && (
                  <FolderEditModal
                    title={tabModal === "add" ? tr("새 워크리스트 페이지")
                         : `${tr("페이지 수정 —")} ${wlTabs[tabModal.index]?.label ?? ""}`}
                    init={tabModal === "add" ? undefined
                        : { label: wlTabs[tabModal.index].label, filter: wlTabs[tabModal.index].filter }}
                    onSave={(label, filter) => {
                      let next: WorklistTab[];
                      if (tabModal === "add") {
                        if (wlTabs.length >= 10) { alert(tr("워크리스트 페이지는 최대 10개입니다")); return; }
                        next = [...wlTabs, { id: newId(), label, filter }];
                      } else {
                        next = wlTabs.map((t, i) => (i === tabModal.index ? { ...t, label, filter } : t));
                      }
                      setWlTabs(next);
                      saveTabs(next).then(() => setSaved(tr("페이지 탭 저장됨"))).catch(() => {});
                      setTabModal(null);
                    }}
                    onClose={() => setTabModal(null)}
                  />
                )}
              </>
            )}

            {page === "report" && (
              <>
                <Group title={tr("상용구 (Predefined Readings)")}>
                  <div style={{ fontSize: 12.5 }}>
                    {tr("등록된 상용구:")} <b>{phrases.length}{tr("건")}</b> {tr("(DB 테이블)")}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                    {tr("등록·수정·삭제는")} <b>{tr("워크리스트 탭의 상용구 관리")}</b> {tr("또는 워크리스트 하단 상용구(Std) 패널에서. 더블클릭 또는 Alt+단축키로 Conclusion에 삽입됩니다.")}
                  </div>
                </Group>
                <Group title={tr("리포트 구성 (Report Composition — UBPACS p.22)")}>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
                    <input type="checkbox" checked={rptAiPanel} onChange={(e) => setRptAiPanel(e.target.checked)} />
                    {tr("AI Structured Report 패널 표시 (해제 시 Report 단독 — AI는 ↗ 별도 창으로만)")}
                  </label>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
                    <input type="checkbox" checked={rptAutoApply} onChange={(e) => setRptAutoApply(e.target.checked)} />
                    {tr("AI 초안을 Report에 자동 적용 (해제 시 빈 양식에서 시작 — [적용 ▶]로만 가져옴)")}
                  </label>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    {tr("리포트 패널: ◀▶ 이전/다음 환자 이동 · 이력 콤보(과거 버전 보기) · ↗ AI 별도 창(모니터) — 계정 로밍.")}
                  </div>
                </Group>
                <Group title={tr("출력 형식")}>
                  <div style={{ fontSize: 12.5 }}>{tr("PDF · DICOM SR(확정 후 전송) · FHIR DiagnosticReport")}</div>
                </Group>
              </>
            )}

            {page === "viewer" && (
              <Group title={tr("OHIF (고급 웹뷰어)")}>
                <Row label={tr("OHIF 사용")}>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
                    <input type="checkbox" checked={ohifOn}
                           onChange={(e) => setOhifOn(e.target.checked)} />
                    {tr("OHIF 아이콘 표시·동작 허용 (기본 꺼짐)")}
                  </label>
                </Row>
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  {tr("끄면 워크리스트(⌂ Adv·🌐·우클릭 메뉴)와 뷰어의 OHIF 버튼이 숨겨지고 동작하지 않습니다. 더블클릭 동작이 OHIF 로 설정돼 있어도 자체 뷰어로 열립니다.")}
                </div>
              </Group>
            )}
            {page === "viewer" && (
              <Group title={tr("Tools 아이콘 크기 (TY · In 뷰어)")}>
                <Row label="TY Viewer">
                  <input type="range" min={13} max={64} step={1} value={tyToolSize}
                         onChange={(e) => setTyToolSize(Number(e.target.value))} />
                  <input type="number" min={13} max={64} value={tyToolSize} style={{ width: 52, marginLeft: 6 }}
                         onChange={(e) => setTyToolSize(Math.min(64, Math.max(13, Number(e.target.value) || 51)))} />
                  <span style={{ fontSize: 12, marginLeft: 4 }}>px</span>
                </Row>
                <Row label="In Viewer">
                  <input type="range" min={13} max={64} step={1} value={infToolSize}
                         onChange={(e) => setInfToolSize(Number(e.target.value))} />
                  <input type="number" min={13} max={64} value={infToolSize} style={{ width: 52, marginLeft: 6 }}
                         onChange={(e) => setInfToolSize(Math.min(64, Math.max(13, Number(e.target.value) || 34)))} />
                  <span style={{ fontSize: 12, marginLeft: 4 }}>px</span>
                </Row>
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  {tr("두 뷰어의 도구 팔레트 아이콘 크기를 한 곳에서 조정합니다 (각 뷰어 전용 탭에서도 동일하게 조정 가능).")}
                  <b> {tr("OK(저장)")}</b> {tr("후 열려 있는 뷰어를 새로고침하면 반영됩니다.")}
                </div>
              </Group>
            )}
            {page === "viewerIn" && (
              <>
              <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                <b>{tr("In Viewer 전용")}</b> — {tr("표시·아이콘·사용 패턴 설정은 뷰어별로 적용되고, 판독·측정 등 기능은 두 뷰어 동일합니다.")}
              </div>
              <Group title={"2D-InViewer Layout " + tr("(이 뷰어 전용 — 모달리티 → Series / Image)")}>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 5 }}>
                  {tr("이 뷰어 전용 2D Layout. 맘모(MG)는 뷰어 공통 규정이라 여기 없습니다.")}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 5 }}>
                  {tr("적용 순서(고정): Common 표에 그 모달리티 행이 있으면 Common 이 우선하고, 없을 때 이 표가 적용됩니다.")}
                </div>
                <Hanging2dEditor map={h2dByViewer.infi ?? {}} onChange={(m, next) =>
                  setH2dByViewer((p) => ({ ...p, infi: { ...(p.infi ?? {}), [m]: next } }))} />
              </Group>
              <Group title={tr("In Viewer 표시 (계정별 저장)")}>
                <Row label={tr("툴 배열 (열)")}>
                  <select value={infToolCols} onChange={(e) => setInfToolCols(Number(e.target.value))}>
                    <option value={1}>{tr("1X1 (한 줄 1개)")}</option>
                    <option value={2}>{tr("2X2 (기본)")}</option>
                    <option value={3}>3X3</option>
                    <option value={4}>4X4</option>
                  </select>
                </Row>
                <Row label={tr("멀티선택 색")}>
                  <input type="color" value={infSelColor}
                         onChange={(e) => setInfSelColor(e.target.value)}
                         title={tr("Crosslink 멀티 선택 페인 테두리 색")} />
                  <span style={{ fontSize: 11.5, color: "var(--text-secondary)", marginLeft: 8 }}>
                    {tr("Shift/Ctrl/A 로 선택된 페인 테두리 (기본 자주색)")}
                  </span>
                </Row>
                <Row label={tr("오버레이 글자")}>
                  <input type="range" min={6} max={24} step={0.5} value={infOvlFont}
                         onChange={(e) => setInfOvlFont(Number(e.target.value))} /> {infOvlFont}px
                  <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12, marginLeft: 12 }}>
                    <input type="checkbox" checked={infOvlVisible}
                           onChange={(e) => setInfOvlVisible(e.target.checked)} />
                    {tr("표시")}
                  </label>
                </Row>
                <Row label={tr("판독 도크")}>
                  <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12 }}>
                    <input type="checkbox" checked={infRptDock}
                           onChange={(e) => setInfRptDock(e.target.checked)} />
                    {tr("뷰어를 열 때 판독(Report) 도크를 기본으로 열기 — 도크 열림 상태를 계정에 기억")}
                  </label>
                </Row>
                <Row label={tr("위치 인디케이터")}>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
                    <input type="checkbox" checked={infScrollBar}
                           onChange={(e) => setInfScrollBar(e.target.checked)} />
                    {tr("페인 우측 이미지 위치 인디케이터(초록 바) 표시 — Scout line 과 무관한 현재 이미지 위치 표시(기본 꺼짐)")}
                  </label>
                </Row>
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  {tr("단축키(뷰어):")} <b>{tr("T + 마우스 스크롤")}</b> {tr("= 글자 크기 조절 ·")} <b>T + Del</b> {tr("= 숨김/표시 토글 — 변경 즉시 계정에 저장됩니다.")}
                </div>
              </Group>
              </>
            )}
            {page === "viewerIn" && (
              <Group title={tr("툴 팔레트 표시 (In Viewer)")}>
                <Row label={tr("열 수")}>
                  <select value={infToolCols} onChange={(e) => setInfToolCols(Number(e.target.value))}>
                    <option value={1}>{tr("1열")}</option><option value={2}>{tr("2열")}</option><option value={3}>{tr("3열")}</option>
                  </select>
                  <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12, marginLeft: 14 }}>
                    <input type="checkbox" checked={infToolLabels}
                           onChange={(e) => setInfToolLabels(e.target.checked)} />
                    {tr("아이콘 아래 이름 표시")}
                  </label>
                </Row>
                <Row label={tr("아이콘 크기")}>
                  <input type="range" min={13} max={64} step={1} value={infToolSize}
                         onChange={(e) => setInfToolSize(Number(e.target.value))} />
                  <input type="number" min={13} max={64} value={infToolSize} style={{ width: 52, marginLeft: 6 }}
                         onChange={(e) => setInfToolSize(Math.min(64, Math.max(13, Number(e.target.value) || 34)))} />
                  <span style={{ fontSize: 12, marginLeft: 4 }}>px</span>
                </Row>
                <Row label={tr("시네 기본 간격")}>
                  <input type="number" min={0.1} max={10} step={0.1} value={infCineSec}
                         onChange={(e) => setInfCineSec(Math.min(10, Math.max(0.1, Number(e.target.value) || 0.5)))}
                         style={{ width: 70 }} />
                  <span style={{ fontSize: 11.5, color: "var(--text-secondary)", marginLeft: 6 }}>
                    {tr("초 — Play(▶) 자동 넘김의 초기 간격. 뷰어에서 페인별로 개별 조정 가능")}
                  </span>
                </Row>
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  {tr("팔레트는 기능별 구획(영상 조정 · 측정 · 주석 · 셔터 · 선택·연동 · 기타)으로 표시됩니다.")}
                </div>
              </Group>
            )}
            {page === "viewerIn" && (
              <>
              <Group title={tr("툴바 사용자화 (In Viewer — 표시할 툴 선택)")}>
                <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--border)",
                              borderRadius: 4, padding: 6 }}>
                  {IN_PALETTE.map((t) => (
                    <label key={t.id}
                           style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12,
                                    padding: "2px 4px", opacity: t.impl ? 1 : 0.55 }}>
                      <input type="checkbox" checked={infTb[t.id] !== false}
                             onChange={(e) => setInfTb((p) => ({ ...p, [t.id]: e.target.checked }))} />
                      <span style={{ width: 22, textAlign: "center", flexShrink: 0 }}>{t.icon}</span>
                      <span style={{ color: "var(--text-secondary)" }}>{tr(t.label)}</span>
                    </label>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  {tr("체크 해제한 툴은 뷰어 팔레트에서 숨겨집니다. 흐린 항목은 개발 예정 툴입니다.")}
                </div>
              </Group>
              <Group title={tr("사용 패턴 · ★Quick 행 (In Viewer)")}>
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
                  <input type="checkbox" checked={infQuickRow}
                         onChange={(e) => setInfQuickRow(e.target.checked)} />
                  {tr("★ Quick 행 표시 — 사용 상위 6개 툴을 팔레트 최상단에 (3회 미만 사용 시 비표시)")}
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
                  <input type="checkbox" checked={infUsageRec}
                         onChange={(e) => setInfUsageRec(e.target.checked)} />
                  {tr("사용 패턴 기록 — 툴 활성화 횟수 집계 (상위 50개, 계정 로밍)")}
                </label>
                <UsageTop usage={infUsage} labelOf={(id) => IN_TOOL_LABEL[id] ?? id}
                          onReset={() => {
                            setInfUsage({}); setInfUsageReset(true);
                            setSaved(tr("In Viewer 사용 기록을 비웠습니다 — OK(저장) 시 반영"));
                          }} />
              </Group>
              </>
            )}
            {/* 뷰어 닫기 설정(2026-08-10 사용자 확정 — 위치는 **뷰어 공통**) — 닫기 다이얼로그의
                "기본으로" 체크가 여기 저장되고, 체크를 해제하면 다시 다이얼로그가 나타난다(계정 로밍).
                SaintView·T-View 는 close_mode 를 공유하고 I-View 는 infi_close_mode —
                뷰어 닫기 규정의 설정 UI 는 이 그룹 **한 곳**뿐이다(하위 페이지에 복제 금지). */}
            {page === "viewer" && (
              <Group title={tr("뷰어 닫기 설정")}>
                <Row label="SaintView · T-View">
                  <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <label style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12 }}>
                      <input type="checkbox" checked={closeMode !== "ask"}
                             onChange={(e) => setCloseMode(e.target.checked ? "save_current" : "ask")} />
                      {tr("묻지 않고 기본 동작으로 닫기")}
                    </label>
                    <select value={closeMode === "ask" ? "save_current" : closeMode}
                            disabled={closeMode === "ask"}
                            onChange={(e) => setCloseMode(e.target.value as typeof closeMode)}>
                      <option value="save_current">{tr("현재 화면 저장하고 닫기")}</option>
                      <option value="save_all">{tr("전체 변경사항 저장하고 닫기 (주석+GSPS)")}</option>
                      <option value="discard">{tr("저장하지 않고 닫기")}</option>
                    </select>
                  </span>
                </Row>
                <Row label="I-View">
                  <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <label style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12 }}>
                      <input type="checkbox" checked={infCloseMode !== "ask"}
                             onChange={(e) => setInfCloseMode(e.target.checked ? "save_current" : "ask")} />
                      {tr("묻지 않고 기본 동작으로 닫기")}
                    </label>
                    <select value={infCloseMode === "ask" ? "save_current" : infCloseMode}
                            disabled={infCloseMode === "ask"}
                            onChange={(e) => setInfCloseMode(e.target.value as typeof infCloseMode)}>
                      <option value="save_current">{tr("현재 저장하고 닫기 (주석)")}</option>
                      <option value="save_all">{tr("전체 저장하고 닫기 (주석+GSPS)")}</option>
                      <option value="none">{tr("저장하지 않고 닫기")}</option>
                    </select>
                  </span>
                </Row>
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  {closeMode === "ask" && infCloseMode === "ask"
                    ? tr('지금은 닫을 때마다 다이얼로그로 묻습니다. 다이얼로그에서 "기본으로"를 체크하면 그 동작이 여기에 저장됩니다.')
                    : tr("닫기 다이얼로그 없이 위 동작으로 바로 닫습니다. 체크를 해제하면 다시 다이얼로그가 나타납니다.")}
                  {" "}{tr("Exam 탭은 ✕/전체닫기 전까지 유지.")}
                </div>
              </Group>
            )}
            {page === "viewer" && (
              <Group title={"2D-Common Layout " + tr("(모달리티 → Series / Image 분할)")}>
                {/* 불변 규정(CLAUDE.md · 2026-08-04): 네 기능은 각기 독립, 표 순서는 Common → 뷰어별.
                    구 '공통 우선 적용' 체크박스(양자택일)는 폐지 — false 로 저장된 계정에서
                    Common 표가 통째로 무시되던 것이 "CT 를 열면 설정이 풀려" 증상이었다. */}
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 5, lineHeight: 1.7 }}>
                  <b>{tr("적용 순서(고정)")}</b>{tr(": ① 행잉(HP — 선택 시만) → ② Mammo(2D-MG — 선택 시만) → ③ 이 Common 표 → ④ 각 뷰어별 표 → ⑤ 자동 규칙(1×1 등).")}<br />
                  {tr("이 표에 해당 모달리티 행이 있으면 세 뷰어(SaintView/I-View/T-View) 모두 이 값을 씁니다. 행이 없으면 그 뷰어의 개별 표를 봅니다.")}<br />
                  {tr("맘모(")}<b>MG</b>{tr(")는 아래")} <b>&lsquo;{tr("MG — 유방 사이 여백 제거")}&rsquo;</b> {tr("규정이 켜져 있을 때만 그 규정을 따릅니다(이 표에 MG 행이 없는 이유).")}<br />
                  <b>{tr("기타(전체)")}</b> {tr("행은 그 표에 행이 없는 나머지 모달리티에 적용됩니다 —")} <b>{tr("같은 표 안에서만")}</b>.<br />
                  {tr("검사를 열 때 모달리티별 기본 분할 —")} <b>Series</b>{tr("(뷰포트 개수)")} + <b>Image</b>{tr("(페인 내 이미지 타일). 그리드에서 선택.")}
                </div>
                <Hanging2dEditor map={h2dMap} onChange={(m, next) => setH2dMap((p) => ({ ...p, [m]: next }))} />

                {/* MG(유방촬영) 전용 — 좌우 사이 공기 여백 제거(2D-MG). 뷰어 3종 공통 설정 */}
                <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 4 }}>
                    {tr("MG — 유방 사이 여백 제거 (2D-MG)")}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 7, lineHeight: 1.7 }}>
                    {tr("MG 검사를 열면 뷰어 우측 상단에")} <b style={{ color: "#f0abfc" }}>2D-MG</b> {tr("체크박스가 나타납니다. 체크하면 좌·우 유방 사이의 빈 공간(공기)을 잘라내고")} <b>{tr("흉벽을 바깥쪽 가장자리에 붙여")}</b> {tr("두 영상이 가운데에서 맞닿게 배치합니다. 해제하면 원본 그대로 표시합니다. (SaintView·I-View·T-View 공통 적용)")}
                  </div>
                  <Row label={tr("기본 사용")}>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input type="checkbox" checked={mgCfg.on}
                             onChange={(e) => setMgCfg({ ...mgCfg, on: e.target.checked })} />
                      {tr("MG 검사를 열 때 2D-MG 를 켠 상태로 시작")}
                    </label>
                  </Row>
                  <Row label="Image layout">
                    <select value={mgCfg.layout}
                            onChange={(e) => setMgCfg({ ...mgCfg, layout: e.target.value })}>
                      {MG_LAYOUTS.map((l) => (
                        <option key={l} value={l}>
                          {l.replace("x", " : ")}
                          {l === "1x2" ? "  " + tr("(좌우 2뷰)") : l === "2x2" ? "  " + tr("(CC/MLO 4뷰)") : "  " + tr("(6뷰)")}
                        </option>
                      ))}
                    </select>
                    <span style={{ fontSize: 11, color: "var(--text-secondary)", marginLeft: 8 }}>
                      {tr("4뷰가 한 시리즈에 들어 있는 검사에 이 분할로 겁니다(행:열).")}
                    </span>
                  </Row>
                  <Row label={tr("분할 방식")}>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                      <input type="checkbox" checked={mgCfg.series_layout}
                             onChange={(e) => setMgCfg({ ...mgCfg, series_layout: e.target.checked })} />
                      {tr("위 값을")} <b>Series Layout</b> {tr("으로 적용 (해제 시")} <b>Image Layout</b>)
                    </label>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 4, lineHeight: 1.5 }}>
                      {tr("기본은 해제 — 페인 하나 안에 4뷰를")} <b>{tr("타일(Image Layout)")}</b>{tr("로 겁니다.")}
                      <br />
                      {tr("⚠ T-View·SaintView 는 타일로 나뉜 페인에")} <b>{tr("계측·주석·오버레이를 표시하지 않습니다")}</b>{tr(". MG 에서 계측을 쓰신다면 이 체크를 켜서 Series Layout 으로 두세요(뷰 하나당 페인 하나 — W/L·확대·계측이 뷰마다 따로 동작합니다). I-View 는 타일에도 계측이 나오므로 영향이 없습니다.")}
                    </div>
                  </Row>
                  <Row label={tr("좌우 비율 무시")}>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input type="checkbox" checked={mgCfg.center_cut}
                             onChange={(e) => setMgCfg({ ...mgCfg, center_cut: e.target.checked })} />
                      {tr("조직 탐지와 무관하게 항상 같은 고정 비율로 가운데 여백 제거 (기본 켬)")}
                    </label>
                    <span style={{ fontSize: 11, color: "var(--text-secondary)", marginLeft: 8 }}>
                      {tr("자동 탐지가 영상마다 실패·지연하면 배치가 들쭉날쭉해집니다 — 켜 두면 항상 같은 모양으로 나옵니다. 해제하면 아래 흉벽 판정(자동 탐지) 규칙을 씁니다.")}
                    </span>
                  </Row>
                  {!mgCfg.center_cut && (
                  <Row label={tr("흉벽 판정")}>
                    <select value={mgCfg.detect}
                            onChange={(e) => setMgCfg({ ...mgCfg, detect: e.target.value === "ratio" ? "ratio" : "auto" })}>
                      <option value="auto">{tr("자동 — 영상에서 조직 경계를 찾아 잘라냄 (권장)")}</option>
                      <option value="ratio">{tr("고정 비율 — 안쪽에서 정해진 비율만큼 잘라냄")}</option>
                    </select>
                  </Row>
                  )}
                  {!mgCfg.center_cut && mgCfg.detect === "auto" && (
                    <Row label={tr("배경 임계값")}>
                      <input type="number" min={1} max={80} step={1} value={mgCfg.thr}
                             onChange={(e) => setMgCfg({ ...mgCfg, thr: Number(e.target.value) || 12 })}
                             style={{ width: 70 }} /> (0~255)
                      <span style={{ fontSize: 11, color: "var(--text-secondary)", marginLeft: 8 }}>
                        {tr("프레임 네 모서리에서 잰")} <b>{tr("배경 밝기와의 차이")}</b>{tr("가 이 값을 넘으면 조직으로 봅니다. 조직이 잘리면 낮추고, 여백이 남으면 높입니다.")}
                      </span>
                    </Row>
                  )}
                  {!mgCfg.center_cut && (
                  <Row label={tr("탐지 불가 시")}>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input type="checkbox" checked={mgCfg.blind_ratio}
                             onChange={(e) => setMgCfg({ ...mgCfg, blind_ratio: e.target.checked })} />
                      {tr("픽셀을 읽을 수 없을 때 아래 고정 비율로 잘라내기")}
                    </label>
                    <span style={{ fontSize: 11, color: "var(--text-secondary)", marginLeft: 8 }}>
                      {tr("꺼 두면(권장) 근거가 없을 때")} <b>{tr("원본을 그대로")}</b> {tr("표시합니다 — 추정 크롭은 조직을 가릴 수 있습니다.")}
                    </span>
                  </Row>
                  )}
                  <Row label={tr("고정 비율")}>
                    <input type="number" min={0} max={60} step={1} value={mgCfg.ratio}
                           onChange={(e) => setMgCfg({ ...mgCfg, ratio: Number(e.target.value) || 0 })}
                           style={{ width: 70 }} /> %
                    <span style={{ fontSize: 11, color: "var(--text-secondary)", marginLeft: 8 }}>
                      {tr("자동 판정이 불가능할 때(외부 서버 영상 등) 안쪽에서 잘라낼 폭.")}
                    </span>
                  </Row>
                  <Row label={tr("여백")}>
                    <input type="number" min={0} max={10} step={1} value={mgCfg.margin}
                           onChange={(e) => setMgCfg({ ...mgCfg, margin: Number(e.target.value) || 0 })}
                           style={{ width: 70 }} /> %
                    <span style={{ fontSize: 11, color: "var(--text-secondary)", marginLeft: 8 }}>
                      {tr("조직이 가장자리에 딱 붙지 않도록 남기는 여백.")}
                    </span>
                  </Row>
                </div>
              </Group>
            )}
            {page === "viewer" && (
              <Group title={tr("영상 정보 표시 (모서리 오버레이) — 모달리티별")}>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 7, lineHeight: 1.7 }}>
                  {tr("DICOM 헤더의 환자·검사·시리즈·영상 정보를 영상 상자의")} <b>{tr("네 귀퉁이 중 어디에")}</b> {tr("보일지 정합니다.")} <b>{tr("모달리티마다 다르게")}</b> {tr("지정할 수 있습니다(CT 는 슬라이스 두께, MG 는 좌우·자세 등). Image 분할에서는")} <b>{tr("칸마다")}</b> {tr("그 칸의 영상 기준으로 표시됩니다. SaintView·I-View·T-View 공통으로 적용됩니다.")}
                </div>
                <OverlayLayoutEditor cfg={ovlCfg} onChange={setOvlCfg} />
              </Group>
            )}
            {(page === "viewerTy" || page === "viewerSv") && (
              <>
                {page === "viewerSv" && (
                  <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                    <b>SaintView</b> — {tr("상단 가로 메뉴(Image Tool·Measurement·Reading Support·Additional) 스킨. 엔진은 T-View 공유 — 아래 설정(아이콘·오버레이·시네·썸네일·판독창 등)이 동일하게 적용됩니다.")}
                  </div>
                )}
                <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                  <b>{tr("T-View 전용")}</b> — {tr("표시·아이콘·사용 패턴 설정은 뷰어별로 적용되고, 판독·측정 등 기능은 세 뷰어 동일합니다.")}
                </div>
                {(() => {
                  const vk = page === "viewerSv" ? "sv" : "ty";
                  const vmap = h2dByViewer[vk] ?? {};
                  return (
                    <Group title={`${page === "viewerSv" ? "2D-SaintViewer" : "2D-TViewer"} Layout ${tr("(이 뷰어 전용 — 모달리티 → Series / Image)")}`}>
                      <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 5 }}>
                        {tr("이 뷰어 전용 2D Layout. 맘모(MG)는 뷰어 공통 규정이라 여기 없습니다.")}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 5 }}>
                        {tr("적용 순서(고정): Common 표에 그 모달리티 행이 있으면 Common 이 우선하고, 없을 때 이 표가 적용됩니다.")}
                      </div>
                      <Hanging2dEditor map={vmap} onChange={(m, next) =>
                        setH2dByViewer((p) => ({ ...p, [vk]: { ...(p[vk] ?? {}), [m]: next } }))} />
                    </Group>
                  );
                })()}
                <Group title={tr("툴 아이콘·팔레트 (TY Viewer)")}>
                  <Row label={tr("툴 배열 (열)")}>
                    <select value={tyToolCols} onChange={(e) => setTyToolCols(Number(e.target.value))}>
                      <option value={1}>{tr("1X1 (한 줄 1개)")}</option>
                      <option value={2}>{tr("2X2 (기본)")}</option>
                      <option value={3}>3X3</option>
                      <option value={4}>4X4</option>
                    </select>
                  </Row>
                  <Row label={tr("아이콘 크기")}>
                    <input type="range" min={13} max={64} step={1} value={tyToolSize}
                           onChange={(e) => setTyToolSize(Number(e.target.value))} />
                    <input type="number" min={13} max={64} value={tyToolSize}
                           style={{ width: 56, marginLeft: 6 }}
                           onChange={(e) => setTyToolSize(Math.min(64, Math.max(13, Number(e.target.value) || 51)))} />
                    <span style={{ fontSize: 12, marginLeft: 4 }}>px</span>
                  </Row>
                  <Row label={tr("라벨 표시")}>
                    <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12 }}>
                      <input type="checkbox" checked={tyToolLabels}
                             onChange={(e) => setTyToolLabels(e.target.checked)} />
                      {tr("아이콘 아래 이름 표시")}
                    </label>
                  </Row>
                  <Row label={tr("3D 아이콘 효과")}>
                    <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12 }}>
                      <input type="checkbox" checked={tyIcon3d}
                             onChange={(e) => setTyIcon3d(e.target.checked)} />
                      {tr("입체(3D) 렌더 — 해제 시 플랫(평면) 아이콘")}
                    </label>
                  </Row>
                  <Row label={tr("오버레이 글자")}>
                    <input type="range" min={6} max={24} step={0.5} value={tyOvlFont}
                           onChange={(e) => setTyOvlFont(Number(e.target.value))} /> {tyOvlFont}px
                  </Row>
                  <Row label={tr("멀티선택 색")}>
                    <input type="color" value={tySelColor}
                           onChange={(e) => setTySelColor(e.target.value)}
                           title={tr("멀티 선택·활성 페인 테두리 색 (viewer.prefs.ty_sel_color)")} />
                    <span style={{ fontSize: 11.5, color: "var(--text-secondary)", marginLeft: 8 }}>
                      {tr("Shift/Ctrl 로 선택된 페인 테두리 2px · 활성 페인 1px (기본 자주색 #d946ef)")}
                    </span>
                  </Row>
                  <Row label={tr("시네 기본 간격")}>
                    <input type="number" min={0.05} max={5} step={0.05} value={tyCineSec}
                           onChange={(e) => setTyCineSec(Math.min(5, Math.max(0.05, Number(e.target.value) || 0.15)))}
                           style={{ width: 70 }} />
                    <span style={{ fontSize: 11.5, color: "var(--text-secondary)", marginLeft: 6 }}>
                      {tr("초 — 시네(▶)·페인별 시네(▶p) 자동 넘김의 초기 간격. 뷰어에서 페인별로 개별 조정 가능")}
                    </span>
                  </Row>
                </Group>
                <Group title={tr("사용 패턴 · ★Quick 행 (TY Viewer)")}>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
                    <input type="checkbox" checked={tyQuickRow}
                           onChange={(e) => setTyQuickRow(e.target.checked)} />
                    {tr("★ Quick 행 표시 — 사용 상위 6개 툴을 팔레트 최상단에 (3회 미만 사용 시 비표시)")}
                  </label>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
                    <input type="checkbox" checked={tyUsageRec}
                           onChange={(e) => setTyUsageRec(e.target.checked)} />
                    {tr("사용 패턴 기록 — 툴 활성화 횟수 집계 (상위 50개, 계정 로밍)")}
                  </label>
                  <UsageTop usage={tyUsage} labelOf={(id) => TY_TOOL_LABEL[id] ?? id}
                            onReset={() => {
                              setTyUsage({}); setTyUsageReset(true);
                              setSaved(tr("TY Viewer 사용 기록을 비웠습니다 — OK(저장) 시 반영"));
                            }} />
                </Group>
                <Group title={tr("자체 2D 뷰어 레이아웃 (요청: 방향·크기 전환)")}>
                  <Row label={tr("툴 팔레트 위치")}>
                    <select value={paletteSide} onChange={(e) => setPaletteSide(e.target.value as "left" | "top" | "right")}>
                      <option value="left">{tr("세로 (좌측)")}</option><option value="top">{tr("가로 (상단)")}</option>
                      <option value="right">{tr("세로 (우측)")}</option><option value="bottom">{tr("가로 (하단)")}</option>
                    </select>
                  </Row>
                  <Row label={tr("썸네일 위치")}>
                    <select value={thumbSide} onChange={(e) => setThumbSide(e.target.value as "left" | "bottom" | "right")}>
                      <option value="left">{tr("세로 (좌측)")}</option><option value="bottom">{tr("가로 (하단)")}</option>
                      <option value="right">{tr("세로 (우측)")}</option><option value="top">{tr("가로 (상단)")}</option>
                    </select>
                  </Row>
                  <Row label={tr("썸네일 크기")}>
                    <input type="range" min={56} max={260} step={4} value={thumbSize}
                           onChange={(e) => setThumbSize(Number(e.target.value))} /> {thumbSize}px
                  </Row>
                  <Row label={tr("썸네일 모드")}>
                    <select value={thumbMode} onChange={(e) => setThumbMode(e.target.value as "series" | "all")}>
                      <option value="series">{tr("시리즈 (선택 시 개별 전개)")}</option>
                      <option value="all">{tr("전체 이미지 나열")}</option>
                    </select>
                  </Row>
                  <Row label={tr("판독창 도크")}>
                    <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12 }}>
                      <input type="checkbox" checked={reportDock} onChange={(e) => setReportDock(e.target.checked)} />
                      {tr("뷰어 우측에 리포트·과거검사 표시")}
                    </label>
                  </Row>
                </Group>
                <Group title={tr("Tools bar 구성 (UBPACS p.18~21 — 계정 로밍)")}>
                  {TOOLBAR_DEFS.map((sec) => (
                    <div key={sec.section}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-secondary)", marginBottom: 3 }}>
                        {sec.section}
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 3 }}>
                        {sec.items.map((t) => (
                          <label key={t.id} title={tr(t.desc)}
                                 style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12 }}>
                            <input type="checkbox" checked={tbConfig[t.id] !== false}
                                   onChange={(e) => setTbConfig((p) => ({ ...p, [t.id]: e.target.checked }))} />
                            {["cobb", "leg", "pelvis", "spineCurve"].includes(t.id)
                              ? <AnatomyIcon id={t.id} size={14} />
                              : <ToolIconTy id={t.id === "3d" ? "mpr" : t.id} size={14} />}
                            {t.label} <span style={{ color: "var(--text-secondary)", fontSize: 10.5 }}>{tr(t.desc.split(" — ")[0].split(" (")[0])}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    {tr("체크 해제 시 뷰어 툴바에서 해당 버튼이 숨겨집니다 — 로그인 계정별 저장(로밍).")}
                  </div>
                </Group>
                <Group title={tr("W/L 프리셋 (Presetting — 2D 섹션 버튼)")} right={
                  <button style={{ padding: "1px 8px", fontSize: 11 }}
                          onClick={() => setWlPresets((p) => [...p, { key: `p${Date.now() % 1e5}`, label: "새 프리셋", q: "40,400" }])}>
                    {tr("＋ 추가")}
                  </button>
                }>
                  <table className="grid-table">
                    <thead><tr><th>{tr("이름")}</th><th style={{ width: 90 }}>Center</th><th style={{ width: 90 }}>Width</th><th style={{ width: 32 }}></th></tr></thead>
                    <tbody>
                      {wlPresets.map((p, i) => {
                        const [c, w] = p.q ? p.q.split(",") : ["", ""];
                        const setQ = (nc: string, nw: string) =>
                          setWlPresets((arr) => arr.map((x, j) => j === i ? { ...x, q: nc === "" && nw === "" ? "" : `${nc},${nw}` } : x));
                        return (
                          <tr key={p.key}>
                            <td><input value={p.label} style={{ width: "95%" }}
                                       onChange={(e) => setWlPresets((arr) => arr.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} /></td>
                            <td><input value={c} placeholder={tr("(기본)")} style={{ width: 70 }}
                                       onChange={(e) => setQ(e.target.value, w)} /></td>
                            <td><input value={w} style={{ width: 70 }}
                                       onChange={(e) => setQ(c, e.target.value)} /></td>
                            <td><button style={{ padding: "0 6px", fontSize: 11 }}
                                        onClick={() => setWlPresets((arr) => arr.filter((_, j) => j !== i))}>✕</button></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    {tr("뷰어 2D 섹션에 프리셋 버튼으로 표시 — All 토글 시 전체 페인 적용. OK(저장) 시 반영.")}
                  </div>
                </Group>
              </>
            )}

            {page === "shortcuts" && (
              <Group title={tr("단축키 (Mouse·Key) — 계정별 저장")}>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  {tr("뷰어 마우스/키 동작을 계정별로 설정합니다(모든 뷰어 공통). 하단 OK(저장) 시 내 계정에만 적용.")}
                </div>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}>
                  <span style={{ width: 170, color: "var(--text-secondary)" }}>{tr("우클릭 드래그 도구")}</span>
                  <select value={scRdrag} onChange={(e) => setScRdrag(e.target.value as "wl" | "zoom" | "pan")}>
                    <option value="wl">{tr("W/L 조정 (기본)")}</option>
                    <option value="zoom">Zoom</option>
                    <option value="pan">Pan</option>
                  </select>
                </label>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}>
                  <span style={{ width: 170, color: "var(--text-secondary)" }}>{tr("시리즈 드롭 동작 메뉴")}</span>
                  <input type="checkbox" checked={dropMenu} onChange={(e) => setDropMenu(e.target.checked)} />
                  <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                    {tr("체크 시 드롭할 때 Open/Combine/Combine all 메뉴 표시 — 해제(기본)는 바로 Open(교체)")}
                  </span>
                </label>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}>
                  <span style={{ width: 170, color: "var(--text-secondary)" }}>{tr("Shift + 우클릭")}</span>
                  <select value={scShiftR} onChange={(e) => setScShiftR(e.target.value as "zoomout" | "none")}>
                    <option value="zoomout">{tr("Zoom Out 한 단계 (기본)")}</option>
                    <option value="none">{tr("동작 없음")}</option>
                  </select>
                </label>
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  {tr("· 우클릭(클릭만)=컨텍스트 메뉴 · 중클릭 드래그=Pan 고정 · 고정 키: Esc(계층 취소) · 1~9(시리즈 선택) · T 홀드(오버레이) · Backspace(주석 삭제 보조)")}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                  <b style={{ fontSize: 12.5 }}>{tr("키 바인딩 (전체 기능)")}</b>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{tr("칸 클릭 후 키 입력 — Backspace=해제. 중복 키는 빨간 표시.")}</span>
                  <button style={{ marginLeft: "auto", fontSize: 11, padding: "1px 10px" }}
                          onClick={() => setScKeys({ ...SC_DEFAULTS })}>{tr("↺ 전체 기본값")}</button>
                </div>
                {(() => {
                  const dup = new Set(Object.values(scKeys).filter((v, _, arr) => v && arr.filter((x) => x === v).length > 1));
                  const groups = [...new Set(SC_ACTIONS.map((x) => x.group))];
                  return groups.map((g) => (
                    <div key={g} style={{ marginTop: 4 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-secondary)", padding: "2px 0" }}>{tr(g)}</div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: 4 }}>
                        {SC_ACTIONS.filter((x) => x.group === g).map((x) => (
                          <label key={x.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                            <span style={{ flex: 1, color: "var(--text-primary)" }}>{tr(x.label)}</span>
                            <input readOnly value={displayKey(scKeys[x.id] ?? x.def)} placeholder={tr("키 입력")}
                                   title={`${tr("기본값:")} ${displayKey(x.def)} — ${tr("클릭 후 원하는 키 입력 (Backspace=해제)")}`}
                                   onKeyDown={(e) => {
                                     e.preventDefault();
                                     if (e.key === "Escape") return;
                                     const nk = e.key === "Backspace" ? ""
                                       : e.key.length === 1 ? e.key.toLowerCase() : e.key;
                                     setScKeys((prev) => ({ ...prev, [x.id]: nk }));
                                   }}
                                   style={{ width: 92, textAlign: "center", cursor: "pointer",
                                            border: scKeys[x.id] && dup.has(scKeys[x.id])
                                              ? "1px solid var(--stat-emergency,#f87171)" : undefined }} />
                          </label>
                        ))}
                      </div>
                    </div>
                  ));
                })()}
              </Group>
            )}
            {page === "monitor" && (
              <>
                <Group title={tr("모니터 감지 · 뷰어 배치")} right={
                  <span style={{ display: "flex", gap: 4 }}>
                  <button style={{ padding: "1px 10px", fontSize: 11.5 }}
                          title={tr("각 모니터 중앙에 번호(1,2,3…)를 3초간 표시 — 어떤 모니터가 어떤 모델인지 확인")}
                          onClick={async () => {
                            const w = window as unknown as {
                              getScreenDetails?: () => Promise<{
                                screens: { label?: string; availLeft: number; availTop: number; availWidth: number; availHeight: number }[];
                              }>;
                            };
                            const issue0 = screenApiIssue();
                            if (issue0) { setMonitorMsg(tr(issue0)); return; }
                            try {
                              const det = await w.getScreenDetails!();
                              const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                              let blocked = 0;
                              det.screens.forEach((s, i) => {
                                const W = 320, H = 230;
                                const left = Math.round(s.availLeft + (s.availWidth - W) / 2);
                                const top = Math.round(s.availTop + (s.availHeight - H) / 2);
                                const pop = window.open("", `sv_ident_${i}`,
                                  `left=${left},top=${top},width=${W},height=${H},popup=1`);
                                if (!pop) { blocked++; return; }
                                pop.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${tr("모니터")} ${i + 1}</title>
<style>body{margin:0;background:#1769e0;color:#fff;font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;overflow:hidden}
.n{font-size:120px;font-weight:800;line-height:1}.l{font-size:13px;opacity:.9;text-align:center;padding:0 12px;margin-top:6px}</style></head>
<body><div style="text-align:center"><div class="n">${i + 1}</div>
<div class="l">${esc(s.label || `${tr("모니터")} ${i + 1}`)}<br>${s.availWidth}×${s.availHeight}</div></div></body></html>`);
                                pop.document.close();
                                setTimeout(() => { try { pop.close(); } catch { /* 무시 */ } }, 3000);
                              });
                              setMonitorMsg(blocked
                                ? `${tr("일부 창이 팝업 차단됨")}(${blocked}) — ${tr("주소창에서 팝업 허용 후 다시 시도")}`
                                : tr("각 모니터 중앙에 번호를 3초간 표시했습니다 — 목록의 번호와 대조하세요"));
                            } catch { setMonitorMsg(tr("모니터 권한이 거부되었습니다")); }
                          }}>
                    {tr("🔢 모니터 확인")}
                  </button>
                  <button className="primary" style={{ padding: "1px 10px", fontSize: 11.5 }} onClick={async () => {
                    const w = window as unknown as {
                      getScreenDetails?: () => Promise<{
                        screens: { label?: string; availWidth: number; availHeight: number; isPrimary?: boolean }[];
                      }>;
                    };
                    const issue = screenApiIssue();
                    if (issue) { setMonitorMsg(tr(issue)); return; }
                    try {
                      const det = await w.getScreenDetails!();
                      setMonitors(det.screens.map((s, i) => ({
                        label: s.label || `${tr("모니터")} ${i + 1}`, w: s.availWidth, h: s.availHeight,
                        primary: !!s.isPrimary,
                      })));
                      setMonitorMsg(`${det.screens.length}${tr("대 감지됨 — 🔢 모니터 확인으로 번호를 대조하고 창별로 지정하세요")}`);
                    } catch { setMonitorMsg(tr("모니터 권한이 거부되었습니다 — 주소창 권한 아이콘에서 허용 후 다시 시도")); }
                  }}>{tr("① 모니터 감지")}</button>
                  </span>
                }>
                  {monitorMsg && <div style={{ fontSize: 12, color: "var(--stat-final)" }}>{monitorMsg}</div>}
                  {screenApiIssue() && (
                    <div style={{
                      fontSize: 12, color: "var(--warning)", lineHeight: 1.5,
                      border: "1px solid var(--warning)", borderRadius: 6, padding: "6px 9px",
                      background: "color-mix(in srgb, var(--warning) 10%, transparent)",
                    }}>
                      ⚠ {tr(screenApiIssue() || "")}
                    </div>
                  )}
                  {monitors.length === 0 ? (
                    <div style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
                      {tr("아직 감지된 모니터가 없습니다 — 우측 상단")} <b>{tr("① 모니터 감지")}</b>{tr("를 누르세요 (최초 1회 브라우저 권한 허용 필요).")}
                      {(monitorSel.length > 0 || wlMon != null || rptMon != null) && (
                        <div style={{ marginTop: 4 }}>
                          {tr("현재 저장된 배치 —")}{" "}
                          {tr("뷰어:")} <b style={{ color: "var(--text-primary)" }}>{monitorSel.length ? monitorSel.map((i) => i + 1).join(", ") : tr("기본")}</b> ·
                          {" "}{tr("워크리스트:")} <b style={{ color: "var(--text-primary)" }}>{wlMon != null ? wlMon + 1 : tr("기본")}</b> ·
                          {" "}{tr("판독:")} <b style={{ color: "var(--text-primary)" }}>{rptMon != null ? rptMon + 1 : tr("기본")}</b>
                        </div>
                      )}
                    </div>
                  ) : (
                    <table className="grid-table">
                      <thead>
                        <tr>
                          <th>{tr("② 모니터")}</th>
                          <th style={{ width: 96 }} title={tr("다중 선택=스팬")}>{tr("뷰어 ☑")}</th>
                          <th style={{ width: 96 }} title={tr("다시 클릭=해제")}>{tr("워크리스트 ◉")}</th>
                          <th style={{ width: 96 }} title={tr("다시 클릭=해제")}>{tr("판독 ◉")}</th>
                          <th style={{ width: 150 }} title={tr("이 모니터의 뷰어에서 ◀▶(다음/이전 환자)가 훑는 워크리스트 탭(필터)")}>{tr("◀▶ 탐색 탭")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {monitors.map((m, i) => (
                          <tr key={i}>
                            <td>
                              <b style={{ color: "var(--accent)", marginRight: 4 }}>{i + 1}</b>
                              🖵 {m.label} ({m.w}×{m.h}){m.primary && " · " + tr("주 모니터")}
                            </td>
                            <td style={{ textAlign: "center" }}>
                              <input type="checkbox" checked={monitorSel.includes(i)}
                                     onChange={(e) => setMonitorSel((p) =>
                                       e.target.checked ? [...p, i].sort((a, b) => a - b) : p.filter((x) => x !== i))} />
                            </td>
                            <td style={{ textAlign: "center" }}>
                              <input type="radio" name="wlmon" checked={wlMon === i}
                                     onClick={() => setWlMon((p) => (p === i ? null : i))}
                                     onChange={() => {}} />
                            </td>
                            <td style={{ textAlign: "center" }}>
                              <input type="radio" name="rptmon" checked={rptMon === i}
                                     onClick={() => setRptMon((p) => (p === i ? null : i))}
                                     onChange={() => {}} />
                            </td>
                            <td style={{ textAlign: "center" }}>
                              <select value={tabBinding[i] ?? ""} style={{ maxWidth: 142 }}
                                      onChange={(e) => setTabBinding((p) => ({ ...p, [i]: e.target.value }))}>
                                <option value="">{tr("전체 (필터 없음)")}</option>
                                {availTabs.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12.5 }}>{tr("최대 열 영상 수 (라운드로빈 슬롯)")}</span>
                    <input type="number" min={0} max={monitorSel.length || 8} value={maxOpen}
                           title={tr("검사를 열 때 순환할 모니터(영상) 개수 — 0=선택한 뷰어 모니터 전부. 예: 3이면 1·2·3 모니터를 1,2,3,1,2,3… 순환")}
                           onChange={(e) => setMaxOpen(Math.max(0, Number(e.target.value) || 0))}
                           style={{ width: 64 }} />
                    <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                      {tr("0 = 선택한 뷰어 모니터 전부")} ({monitorSel.length || 0}{tr("대")})
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12.5 }}>{tr("All Close(전체 닫기) 범위")}</span>
                    <select value={closeScope} onChange={(e) => setCloseScope(e.target.value as "all" | "current")}
                            title={tr("뷰어의 All Close 버튼을 눌렀을 때 닫을 범위")}>
                      <option value="all">{tr("전체 모니터 뷰어 닫기")}</option>
                      <option value="current">{tr("현재 모니터 뷰어만 닫기")}</option>
                    </select>
                    <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                      {tr("뷰어의")} <b>All Close ✕</b>·<b>WORKLIST</b>·<b>Esc</b>·{tr("마지막 Exam 탭")} <b>✕</b> {tr("등 창이 닫히는 모든 경우")}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
                      <input type="checkbox" checked={closeReport}
                             onChange={(e) => setCloseReport(e.target.checked)} />
                      {tr("All Close 시")} <b>{tr("판독창")}</b>{tr("도 함께 닫기")}
                    </label>
                    <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                      {tr("기본")} <b>{tr("끔")}</b> — {tr("판독 원고는 자동 저장이 없습니다. 켜더라도")} <b>{tr("저장하지 않은 입력이 있으면 닫지 않습니다")}</b>.
                    </span>
                  </div>
                  {(() => {
                    // 상호 배타: 모니터별 '◀▶ 탐색 탭'(tab_binding)이 하나라도 설정되면 이 기능은 비활성.
                    // 탐색 탭을 모두 '전체(필터 없음)'로 두어야 워크리스트 탭→모니터 배치를 설정할 수 있다.
                    const navTabOn = Object.values(tabBinding).some((v) => !!v);
                    return (
                  <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8, opacity: navTabOn ? 0.5 : 1 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>
                      {tr("워크리스트 탭 → 모니터 배치 (라운드로빈 대신 지정 모니터로 오픈)")}
                    </div>
                    {navTabOn ? (
                      <div style={{ fontSize: 11.5, color: "var(--stat-emergency,#f87171)", marginBottom: 6 }}>
                        {tr("⚠ 위 표의")} <b>{tr("◀▶ 탐색 탭")}</b>{tr("이 설정되어 있어 이 기능은 비활성화됩니다. 탐색 탭을 모두")} <b>'{tr("전체 (필터 없음)")}'</b>{tr("로 두면 설정할 수 있습니다.")}
                      </div>
                    ) : (
                      <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 6 }}>
                        {tr("기본은 번호순 순환(1,2,3…)이지만, 여기에 지정한")} <b>{tr("워크리스트 탭")}</b>{tr("에서 연 검사는 항상 지정 모니터에 열립니다 (예: WORKLIST 2 → 3번).")}
                      </div>
                    )}
                    {tabMonMap.map((rule, ri) => (
                      <div key={ri} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                        <select value={rule.tab} disabled={navTabOn}
                                onChange={(e) => setTabMonMap((p) => p.map((r, k) => k === ri ? { ...r, tab: e.target.value } : r))}
                                style={{ maxWidth: 160 }}>
                          <option value="">{tr("— 탭 선택 —")}</option>
                          {availTabs.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                        </select>
                        <span>{tr("→ 모니터")}</span>
                        <input type="number" min={1} max={monitors.length || 8} value={rule.monitor + 1} disabled={navTabOn}
                               onChange={(e) => setTabMonMap((p) => p.map((r, k) => k === ri ? { ...r, monitor: Math.max(0, (Number(e.target.value) || 1) - 1) } : r))}
                               style={{ width: 56 }} />
                        <button disabled={navTabOn} onClick={() => setTabMonMap((p) => p.filter((_, k) => k !== ri))}
                                style={{ fontSize: 11 }}>{tr("삭제")}</button>
                      </div>
                    ))}
                    <button disabled={navTabOn} onClick={() => setTabMonMap((p) => [...p, { tab: "", monitor: 0 }])}
                            style={{ fontSize: 11.5 }}>{tr("+ 예외 추가")}</button>
                  </div>
                    );
                  })()}
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <button disabled={wlMon == null}
                            title={tr("워크리스트를 선택한 모니터의 새 창으로 열기 (기존 탭은 닫아도 됨)")}
                            onClick={async () => {
                              const { screenFeatures } = await import("../lib/screens");
                              const features = await screenFeatures(wlMon != null ? [wlMon] : null);
                              window.open(`${window.location.origin}${window.location.pathname}`, "sv_worklist", features)?.focus();
                            }}>
                      {tr("워크리스트를 해당 모니터로 열기")}
                    </button>
                    <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                      {tr("(브라우저 보안상 현재 창은 이동 불가 — 새 창으로 엽니다)")}
                    </span>
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--text-secondary)", borderTop: "1px solid var(--border)", paddingTop: 6 }}>
                    <b>{tr("사용 방법:")}</b> {tr("① 모니터 감지 → 🔢 모니터 확인(각 화면에 번호 표시·목록 번호와 대조) → ② 창별 모니터 지정 → ③ 하단")} <b>{tr("OK(저장)")}</b> {tr("→ ④ 다음 오픈부터 적용.")}<br />
                    · <b>{tr("뷰어 ☑")}</b>{tr(": 1대=해당 모니터 / 2대 이상=아래 규칙 / 0대=기본 크기")}<br />
                    &nbsp;&nbsp;&nbsp;① <b>{tr("첫 영상(뷰어 창이 하나도 없을 때)은 선택한 모든 모니터에 같은 검사")}</b>{tr("로 뜹니다.")}<br />
                    &nbsp;&nbsp;&nbsp;② <b>{tr("두 번째 영상부터는 모니터 번호순으로 한 대씩")}</b> {tr("바뀝니다(2,3,…,1,2,3…).")}<br />
                    &nbsp;&nbsp;&nbsp;{tr("검사가 열리는 그 모니터만 새로 로드되고, 나머지 모니터 뷰어는")} <b>{tr("깜빡임 없이 Exam 탭만 추가")}</b>{tr("됩니다.")}<br />
                    &nbsp;&nbsp;&nbsp;{tr("순환할 모니터 수는 위")} <b>{tr("최대 열 영상 수")}</b>{tr("로 조절(0=선택 전부). 이 값은")} <b>{tr("순환 범위에만")}</b> {tr("적용됩니다 — Compare·과거검사 '모니터 띄우기'는 선택한 모니터 전부를 쓰되")} <b>{tr("지금 검사가 떠 있는 모니터는 뒤로 미뤄")}</b> {tr("비어 있는 모니터부터 사용합니다. 순서는 워크리스트를 새로고침해도")} <b>{tr("살아 있는 뷰어 창")}</b>{tr("을 기준으로 이어집니다. 최초 오픈은 창을 여러 개 동시에 열므로 팝업이 차단되면 주소창 팝업 아이콘에서 이 사이트")} <b>{tr("항상 허용")}</b>{tr("으로 설정하세요.")}<br />
                    · <b>{tr("워크리스트 ◉")}</b>{tr(": 위 버튼으로 해당 모니터에 새 창 오픈 (라디오 재클릭=해제)")}<br />
                    · <b>{tr("판독 ◉")}</b>{tr(": 뷰어의 [Reading] 버튼이 해당 모니터에 판독 창을 띄움")}
                  </div>
                </Group>
                <Group title={tr("뷰어 창 정보 (별도 포트)")}>
                  <div style={{ fontSize: 12.5 }}>
                    {tr("현재 뷰어 창 출처:")} <code>{VIEWER_BASE || tr("워크리스트와 동일 (같은 포트)")}</code>
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                    {tr("뷰어를 별도 포트로 분리하려면")} <code>frontend/.env</code>{tr("에")}
                    <code> VITE_VIEWER_BASE=https://localhost:5176</code> {tr("추가 후")}
                    <code> npm run dev:viewer</code>{tr("를 함께 실행하세요 (재기동 필요).")}
                  </div>
                </Group>
              </>
            )}

            {page === "policy" && (
              <Group title={tr("탐색 방향 정책 — ◀▶ 환자 이동 (뷰어·판독 창·워크리스트 공통)")}>
                <Row label={tr("◀ (왼쪽) 버튼")}>
                  <select value={polNavLeft} onChange={(e) => setPolNavLeft(e.target.value as "past" | "recent")}>
                    <option value="past">{tr("시간상 과거로 (워크리스트 아래 행 방향)")}</option>
                    <option value="recent">{tr("시간상 최신으로 (워크리스트 위 행 방향)")}</option>
                  </select>
                </Row>
                <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.7 }}>
                  {tr("워크리스트는 최신 검사가 위에 정렬됩니다. ◀▶는 열려 있는 환자(현재 보고 있는 검사)를 기준으로")} <b>{tr("시간대별 한 단계씩")}</b> {tr("이동하며, ▶(오른쪽)는 항상 ◀의 반대 방향입니다.")}<br />
                  · <b>{tr("과거로(기본)")}</b>{tr(": ◀=한 단계 과거(아래 행) / ▶=한 단계 최신(위 행)")}<br />
                  · <b>{tr("최신으로")}</b>{tr(": ◀=한 단계 최신(위 행) / ▶=한 단계 과거(아래 행)")}<br />
                  {tr("이동 대상 환자가 이미 Exam 탭으로 열려 있으면 그 탭으로 전환되고, 아니면 열면서 이동합니다. Worklist·Image Viewer·Reading Viewer는 열린 환자를 서로 따라갑니다(연동). OK(저장) 시 적용.")}
                </div>
              </Group>
            )}

            {page === "hp" && (
              <HpProtocolEditor
                rules={hpRules}
                modalities={hpMods}
                monitors={monitors}
                monitorSel={monitorSel}
                // ⚠ mods 를 인자로 받는다 — setHpMods 직후의 hpMods 는 아직 옛 값이라(리렌더 전)
                //   그대로 저장하면 방금 추가한 장비가 유실된다(사양 2 '사용자 추가 장비'가 사라짐).
                onChange={async (next, mods) => {
                  const m = mods ?? hpMods;
                  setHpRules(next);
                  if (mods) setHpMods(mods);
                  // writeHpDoc: 새 screens → 구 s/i/displays 되채우기(구 빌드·구 호출부 보호) +
                  //             규칙이 쓰는 비프리셋 장비를 modalities 에 남긴다(사양 2 — 사용자 추가 장비)
                  await api.putSetting("viewer.hp", writeHpDoc({ rules: next, modalities: m }), "user");
                  setSaved(tr("행잉 프로토콜 저장됨 — 왼쪽 ⟳ Refresh 후 뷰어 재오픈 시 적용"));
                }}
              />
            )}

            {page === "speed" && (
              <Group title={tr("영상 열기 속도 측정")}>
                <SpeedTestPanel />
              </Group>
            )}

            {page === "about" && (
              <Group title={tr("정보 (About)")}>
                <Row label={tr("제품")}>{PRODUCT_NAME}</Row>
                <Row label={tr("현재 Version")}>
                  <b style={{ fontSize: 14, letterSpacing: 0.3 }}>{VERSION_LABEL}</b>
                </Row>
                <Row label={tr("버전 적용일자")}>{BUILD_DATE || "—"}</Row>
                <Row label={tr("제조사")}>{VENDOR}</Row>
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)",
                              fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.7 }}>
                  {tr("버전은 배포본 빌드 시점에 자동 기록됩니다(적용일자 = 빌드 일자).")}<br />
                  {tr("기술 지원·문의:")} {VENDOR}
                </div>

                {/* 오류 기록 — 화면이 죽었다가 새로고침으로 복구되면 콘솔이 함께 날아간다.
                    그래서 예외를 localStorage 에 남겨 두고 여기서 꺼내 볼 수 있게 한다. */}
                <div style={{ marginTop: 14, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 4 }}>
                    {tr("오류 기록")} {crashes.length > 0 && (
                      <span style={{ color: "#f87171" }}>({crashes.length}{tr("건")})</span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 7, lineHeight: 1.7 }}>
                    {tr("화면이 비거나 오류가 났을 때 자동으로 남는 기록입니다.")} <b>{tr("새로고침해도 지워지지 않습니다.")}</b>
                    {tr("화면이 죽는 증상이 있으면 [복사]해서 전달해 주세요 — 어디서 무엇이 터졌는지 그대로 들어 있습니다.")}
                  </div>
                  {crashes.length === 0 ? (
                    <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{tr("기록된 오류가 없습니다.")}</div>
                  ) : (
                    <>
                      <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 11,
                                    background: "var(--bg-canvas)", border: "1px solid var(--border)",
                                    borderRadius: 6, padding: 8, maxHeight: 220, overflow: "auto" }}>
                        {crashes.map((c) => [
                          `[${c.at}] ${c.where}`, c.message, c.url,
                          ...c.stack.split(String.fromCharCode(10)).slice(0, 4),
                        ].join(String.fromCharCode(10)))
                          .join(String.fromCharCode(10, 10) + "──────────" + String.fromCharCode(10, 10))}
                      </pre>
                      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                        <button onClick={() => void navigator.clipboard?.writeText(JSON.stringify(crashes, null, 2))}>
                          {tr("전체 복사 (JSON)")}
                        </button>
                        <button onClick={() => { clearCrashLog(); setCrashes([]); }}>{tr("기록 비우기")}</button>
                      </div>
                    </>
                  )}
                </div>
              </Group>
            )}

            {page === "pdf" && isAdmin && (
              <Group title={tr("판독서 템플릿 (기관)")}>
                <Row label={tr("병원명")}><input value={hospital} onChange={(e) => setHospital(e.target.value)} style={{ width: 280 }} /></Row>
                <Row label={tr("부서")}><input value={department} onChange={(e) => setDepartment(e.target.value)} style={{ width: 280 }} /></Row>
                <Row label={tr("푸터")}><input value={footer} onChange={(e) => setFooter(e.target.value)} style={{ width: 280 }} /></Row>
              </Group>
            )}

            {page === "ai" && isAdmin && (
              <>
                <Group title={tr("AI 정책")}>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, fontWeight: 700 }}>
                    <input type="checkbox" checked={draftEnabled} onChange={(e) => setDraftEnabled(e.target.checked)} />
                    {tr("AI 판독 초안 생성 (Structured Report) — 마스터 스위치")}
                  </label>
                  <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginLeft: 22 }}>
                    {draftEnabled
                      ? tr("활성 — 자동/수동 초안 생성이 동작합니다.")
                      : tr("보류 중 — RAG 기반 Structured Report 개편 전까지 자동·수동 초안 생성이 전면 차단됩니다(기존 초안 열람은 가능).")}
                  </div>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5,
                                  opacity: draftEnabled ? 1 : 0.5 }}>
                    <input type="checkbox" checked={autoGenerate} disabled={!draftEnabled}
                           onChange={(e) => setAutoGenerate(e.target.checked)} />
                    {tr("검사 도착 시 초안 자동 생성")}
                  </label>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
                    <input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} />
                    {tr("키이미지 vision 분석 (F-11) —")} <span style={{ color: "var(--ai)" }}>{tr("[영상 참고 관찰]로만 표기")}</span>
                  </label>
                </Group>
                <Group title={tr("음성 판독 STT 엔진 (Whisper 오픈소스 / 상용 API)")}>
                  <Row label={tr("엔진")}>
                    <select value={sttEngine} onChange={(e) => setSttEngine(e.target.value)}>
                      <option value="browser">{tr("브라우저 내장 (Web Speech — 기본)")}</option>
                      <option value="whisper_local">{tr("Whisper 로컬 (오픈소스 — 온프레미스, PHI 안전)")}</option>
                      <option value="openai_api">{tr("OpenAI API (상용 — whisper-1)")}</option>
                    </select>
                  </Row>
                  <Row label={tr("모델")}>
                    <input value={sttModel} onChange={(e) => setSttModel(e.target.value)}
                           placeholder={sttEngine === "openai_api" ? "whisper-1" : "base / small / medium…"}
                           style={{ width: 220 }} />
                  </Row>
                  {sttStat && (
                    <div style={{ fontSize: 11.5, display: "flex", flexDirection: "column", gap: 3,
                                  background: "var(--bg-canvas)", border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>
                      <div style={{ fontWeight: 700, color: sttStat.ready ? "var(--stat-final)" : "var(--stat-emergency)" }}>
                        {sttStat.ready ? tr("● 현재 엔진 구동 가능") : tr("○ 현재 엔진 구동 불가 — 설치/키 확인 필요")}
                      </div>
                      <div style={{ color: "var(--text-secondary)" }}>
                        {tr("서버 설치 상태 —")} faster-whisper: <b>{sttStat.available.faster_whisper ? tr("설치됨") : tr("미설치")}</b> ·
                        openai-whisper: <b>{sttStat.available.openai_whisper ? tr("설치됨") : tr("미설치")}</b> ·
                        OPENAI_API_KEY: <b>{sttStat.available.openai_api_key ? tr("설정됨") : tr("없음")}</b>
                      </div>
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    {tr("Whisper 로컬:")} <code>pip install faster-whisper</code> {tr("필요(미설치 시 안내 응답).")}
                    <b style={{ color: "var(--stat-emergency)" }}> {tr("OpenAI API는 음성이 외부로 전송됩니다")}</b> —
                    {tr("API 키는 서버 환경변수")} <code>OPENAI_API_KEY</code>{tr("로만 설정(코드/설정 저장 금지). 이 설정은")} <b>{tr("전역(모든 병원·Client 공통)")}</b>{tr("으로 적용됩니다.")}
                  </div>
                </Group>
                {quality && quality.with_ai_draft > 0 && (
                  <Group title={tr("AI 품질 지표 (F-20)")}>
                    <table className="grid-table">
                      <tbody>
                        <tr><th style={{ width: 140 }}>{tr("AI 초안 기반 확정")}</th><td>{quality.with_ai_draft} / {quality.finalized_total}{tr("건")}</td></tr>
                        <tr><th>{tr("무수정 수용률")}</th><td>{((quality.acceptance_rate ?? 0) * 100).toFixed(1)}%</td></tr>
                        <tr><th>{tr("평균 수정률")}</th><td>{((quality.avg_modified_ratio ?? 0) * 100).toFixed(1)}%</td></tr>
                        <tr><th>{tr("critical 변경")}</th>
                          <td style={{ color: (quality.critical_dropped || quality.critical_added) ? "var(--stat-emergency)" : undefined }}>
                            {tr("탈락")} {quality.critical_dropped ?? 0} / {tr("추가")} {quality.critical_added ?? 0}
                          </td></tr>
                      </tbody>
                    </table>
                  </Group>
                )}
              </>
            )}
          </div>
        </div>
        <div style={{ padding: "9px 14px", borderTop: "1px solid var(--border)", display: "flex", gap: 8, alignItems: "center", background: "var(--bg-elevated)" }}>
          {saved && <span style={{ color: "var(--stat-final)", fontSize: 12 }}>{saved}</span>}
          <div style={{ flex: 1 }} />
          <button className="primary" disabled={saving}
                  onClick={() => {
                    setDirtySaved(false); setSaving(true);
                    // 성공했을 때만 라벨을 '닫기' 로 바꾼다 — 실패하면 Cancel 로 남아
                    // "아직 저장 안 됐다" 가 버튼만 봐도 보인다.
                    save()
                      .then(() => setDirtySaved(true))
                      .catch((e) => setSaved(`⚠ ${tr("저장 실패")} — ${e instanceof Error ? e.message : String(e)}`))
                      .finally(() => setSaving(false));
                  }}>
            {saving ? tr("저장 중…") : tr("okSave")}
          </button>
          {/* 저장 전에는 Cancel(=버리고 나감), 저장이 **끝난 뒤에만** 닫기.
              라벨이 곧 상태 표시다 — 아직 Cancel 이면 저장이 안 끝난 것이다. */}
          <button onClick={onClose}>{dirtySaved ? tr("close") : tr("cancel")}</button>
        </div>
      </div>
      </div>
    </div>
  );
}

/* ── 키 캡처 입력 (시스템 단축키 — [입력] 후 키 조합을 누르면 기록) ── */
function KeyCaptureInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [cap, setCap] = useState(false);
  const ref = useRef<HTMLInputElement | null>(null);
  return (
    <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
      <input ref={ref} value={value} readOnly placeholder={tr("키를 입력하세요")}
             style={{ width: 140, background: cap ? "var(--accent-subtle)" : undefined }}
             onKeyDown={(e) => {
               if (!cap) return;
               e.preventDefault();
               if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
               const combo = [e.ctrlKey && "Ctrl", e.shiftKey && "Shift", e.altKey && "Alt",
                              e.key.length === 1 ? e.key.toUpperCase() : e.key].filter(Boolean).join("+");
               onChange(combo);
               setCap(false);
             }} />
      <button className={cap ? "primary" : ""} style={{ padding: "1px 9px", fontSize: 11 }}
              onClick={() => { setCap((c) => !c); ref.current?.focus(); }}>
        {cap ? tr("입력 중…") : tr("입력")}
      </button>
      <button style={{ padding: "1px 9px", fontSize: 11 }} onClick={() => onChange("")}>{tr("지우기")}</button>
    </span>
  );
}

/* ── 판독 단축키/템플릿 편집기 (레퍼런스: 목록 | 추가 폼 — 모달리티·코드·이름·판독·결론) ── */
function ReadingItemEditor({ kind, items, reload }: {
  kind: "phrase" | "template";
  items: PhraseRow[];
  reload: () => void;
}) {
  const list = items.filter((p) => p.kind === kind);
  const label = kind === "phrase" ? "단축키" : "템플릿";
  const [sel, setSel] = useState<PhraseRow | null>(null);
  const empty = { name: "", modality: "", shortcut: "", reading_text: "", text: "" };
  const [f, setF] = useState(empty);
  const [cap, setCap] = useState(false);
  useEffect(() => {
    setF(sel ? { name: sel.name, modality: sel.modality, shortcut: sel.shortcut,
                 reading_text: sel.reading_text, text: sel.text } : empty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  const save = async () => {
    try {
      const body = { ...f, kind, body_part: sel?.body_part ?? "" };
      if (sel) await api.updatePhrase(sel.id, body);
      else await api.createPhrase(body);
      setSel(null);
      setF(empty);
      reload();
    } catch (e) { alert(e instanceof Error ? e.message : tr("저장 실패")); }
  };

  return (
    <div style={{ display: "flex", gap: 14, minHeight: 320 }}>
      {/* 좌: 목록 */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <b style={{ fontSize: 12.5 }}>{tr(label)} {tr("목록")}</b>
          <button className="primary" style={{ padding: "2px 10px", fontSize: 11.5 }}
                  onClick={() => { setSel(null); setF(empty); }}>＋ {tr(label)} {tr("추가")}</button>
        </div>
        <div style={{ flex: 1, overflow: "auto", border: "1px solid var(--border)", borderRadius: 4 }}>
          {list.map((p) => (
            <div key={p.id} onClick={() => setSel(p)}
                 style={{ padding: "6px 10px", fontSize: 12, cursor: "pointer", borderBottom: "1px solid #24282d",
                          display: "flex", gap: 6, alignItems: "center",
                          background: sel?.id === p.id ? "var(--accent-subtle)" : undefined }}>
              <span style={{ color: "var(--text-secondary)" }}>[{p.modality || tr("공통")}]</span>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
              {p.shortcut && <span style={{ color: "var(--accent)" }}>Alt+{p.shortcut}</span>}
              <button style={{ padding: "0 6px", fontSize: 11 }} onClick={async (e) => {
                e.stopPropagation();
                if (!window.confirm(`'${p.name}'${tr("을 삭제할까요?")}`)) return;
                await api.deletePhrase(p.id);
                if (sel?.id === p.id) setSel(null);
                reload();
              }}>✕</button>
            </div>
          ))}
          {list.length === 0 && (
            <div style={{ padding: 16, fontSize: 12, color: "var(--text-secondary)", textAlign: "center" }}>
              {tr("등록된")} {tr(label)}{tr("가 없습니다.")}
            </div>
          )}
        </div>
      </div>
      {/* 우: 추가/수정 폼 (레퍼런스 폼 구성) */}
      <div style={{ flex: 1.1, minWidth: 0, display: "flex", flexDirection: "column", gap: 7 }}>
        <b style={{ fontSize: 12.5 }}>{sel ? `${tr(label)} ${tr("수정 —")} ${sel.name}` : `${tr("새")} ${tr(label)} ${tr("추가")}`}</b>
        <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>{tr("모달리티")}</div>
        <select value={f.modality} onChange={(e) => setF((p) => ({ ...p, modality: e.target.value }))}>
          <option value="">{tr("공통 (모든 장비)")}</option>
          {["CR", "DX", "CT", "MR", "US", "MG", "XA", "NM"].map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        {kind === "phrase" && (
          <>
            <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>{tr("단축키 코드 (Alt+키)")}</div>
            <div style={{ display: "flex", gap: 4 }}>
              <input value={f.shortcut} readOnly placeholder={tr("단축키를 입력하세요")}
                     style={{ flex: 1, background: cap ? "var(--accent-subtle)" : undefined }}
                     onKeyDown={(e) => {
                       if (!cap) return;
                       e.preventDefault();
                       if (/^[a-zA-Z0-9]$/.test(e.key)) { setF((p) => ({ ...p, shortcut: e.key.toUpperCase() })); setCap(false); }
                     }} />
              <button className={cap ? "primary" : ""} style={{ padding: "2px 10px", fontSize: 11.5 }}
                      onClick={(e) => { setCap((c) => !c); (e.currentTarget.previousElementSibling as HTMLInputElement)?.focus(); }}>
                {tr("입력")}
              </button>
            </div>
          </>
        )}
        <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>{tr(label)} {tr("이름")}</div>
        <input value={f.name} onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))} />
        <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>{tr("판독 (Reading)")}</div>
        <textarea value={f.reading_text} rows={5}
                  onChange={(e) => setF((p) => ({ ...p, reading_text: e.target.value }))}
                  style={{ background: "var(--bg-canvas)", color: "var(--text-primary)", border: "1px solid var(--border)",
                           borderRadius: 3, padding: 6, fontFamily: "inherit", fontSize: 12, resize: "vertical" }} />
        <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>{tr("결론 (Conclusion)")}</div>
        <textarea value={f.text} rows={4}
                  onChange={(e) => setF((p) => ({ ...p, text: e.target.value }))}
                  style={{ background: "var(--bg-canvas)", color: "var(--text-primary)", border: "1px solid var(--border)",
                           borderRadius: 3, padding: 6, fontFamily: "inherit", fontSize: 12, resize: "vertical" }} />
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button className="primary" style={{ padding: "4px 18px" }}
                  disabled={!f.name.trim() || !(f.text.trim() || f.reading_text.trim())}
                  onClick={() => void save()}>{tr("저장")}</button>
        </div>
      </div>
    </div>
  );
}

/* ── 행잉 프로토콜 편집기 (설정>행잉) — 좌측 프로토콜 카드 목록 + 우측 기본정보·옵션·모니터 배치 ──
 *  사양 1 프로토콜명 · 2 장비(사용자 추가 가능) · 3 부위 + 출처 DICOM 필드(복수)
 *       · 4 모니터 배치(Series/Image 레이아웃 + 칸별 시간대 슬롯) · 5 체크박스 5개(가로 1열)
 *       · 6 '가장 우선 적용'(기본 언체크)
 *  규칙·판정은 전부 lib/hangingProtocol.ts 의 순수 함수다 — 여기는 화면만 그린다. */
/* 사양 5 의 5개 항목·라벨은 lib/hangingProtocol.HP_OPTION_FIELDS 에 있다.
   ⚠ 여기 다시 적지 않는 이유: 사양이 '가로 1열' 을 요구하므로 **라벨 길이가 설정 창의 최소 폭을
     정한다**(hpSettingsMinWidth). 라벨이 이 파일에만 있으면 라벨을 늘려도 창 폭이 안 따라와
     조용히 2~3줄로 접힌다 — 실제로 그 상태였다. */
const HP_OPTIONS = HP_OPTION_FIELDS;

function HpProtocolEditor({ rules, modalities, monitors, monitorSel, onChange }: {
  rules: HpRule[];
  modalities: string[];                                   // 사양 2 — 사용자가 추가한 장비명
  monitors: { label: string; w: number; h: number; primary: boolean }[];  // 설정>모니터에서 감지된 것
  monitorSel: number[];                                   // 설정>모니터에서 뷰어로 고른 화면(0-base)
  onChange: (next: HpRule[], mods?: string[]) => void | Promise<void>;
}) {
  const [selId, setSelId] = useState<string | null>(null);
  const [draft, setDraft] = useState<HpRule | null>(null);
  const [dirty, setDirty] = useState(false);
  const [newMod, setNewMod] = useState("");               // 사양 2 — 장비 직접 추가 입력창
  // 최초/외부 rules 도착 시 첫 프로토콜 선택
  useEffect(() => {
    if (selId === null && rules.length) { setSelId(rules[0].id); setDraft(rules[0]); }
  }, [rules, selId]);

  const select = (id: string | null) => {
    setSelId(id);
    setDraft(id ? (rules.find((r) => r.id === id) ?? null) : null);
    setDirty(false);
  };
  const upd = (patch: Partial<HpRule>) => { setDraft((d) => (d ? { ...d, ...patch } : d)); setDirty(true); };
  // 기본값은 lib/hangingProtocol.newHpRule 한 곳에만 — 뷰어 '직접설정' 저장도 같은 것을 쓴다.
  const newRule = (): HpRule => newHpRule();
  const addNew = () => { const r = newRule(); void onChange([...rules, r]); setSelId(r.id); setDraft(r); setDirty(false); };
  const dup = (r: HpRule) => {
    const c: HpRule = { ...JSON.parse(JSON.stringify(r)), id: `hp${Date.now().toString(36)}`, name: `${r.name} (복사)` };
    void onChange([...rules, c]); setSelId(c.id); setDraft(c); setDirty(false);
  };
  const del = (id: string) => {
    if (!window.confirm(tr("이 행잉 프로토콜을 삭제할까요?"))) return;
    const next = rules.filter((r) => r.id !== id);
    void onChange(next);
    if (selId === id) { const n = next[0] ?? null; setSelId(n?.id ?? null); setDraft(n); setDirty(false); }
  };
  const save = () => {
    if (!draft) return;
    if (!draft.name.trim()) { window.alert(tr("프로토콜명을 입력하세요")); return; }
    // ⚠ 장비 필수 검사를 뺐다 — 데이터 계약에서 modality 빈값 = **모든 장비**다(hpRuleMatches).
    //   필수로 막으면 '장비 무관' 규칙을 아예 만들 수 없다(콤보에 그 뜻의 항목이 있다).
    // ⚠ 구 필드(s·i·displays) 되채우기는 여기서 하지 않는다 — writeHpDoc→syncHpLegacy 가
    //   저장 직전에 screens(정본)에서 한 번에 만든다. 두 곳에서 만들면 값이 갈라진다.
    const clean: HpRule = { ...draft, name: draft.name.trim() };
    void onChange(rules.map((r) => (r.id === clean.id ? clean : r)));
    setDraft(clean); setDirty(false);
  };
  // 프리셋 7종 + 사용자 추가분 + 규칙이 실제로 쓰는 값(옵션에서 사라지면 편집 순간 값이 날아간다)
  const modOpts = hpModalityOptions(modalities, rules);
  // 적용 순서 — matchHpRule 과 같은 순서(priority 먼저). '왜 저 규칙이 걸렸나'를 목록에서 보여 준다.
  const order = hpRuleOrder(rules);
  const orderOf = (id: string) => order.findIndex((r) => r.id === id) + 1;
  /** 사양 2 — 목록에 없는 장비를 사용자가 추가한다(고정 목록 금지). 규칙과 함께 즉시 저장된다. */
  const addModality = () => {
    const m = newMod.trim().toUpperCase();
    if (!m) return;
    setNewMod("");
    upd({ modality: m });
    // 프리셋/기존 목록에 없을 때만 modalities 에 남긴다 — 남기지 않으면 다음에 편집기를 열었을 때
    // 그 장비가 콤보에서 사라지고(규칙이 하나도 안 쓰면) 사용자가 다시 입력해야 한다.
    if (!modOpts.includes(m)) void onChange(rules, [...modalities, m]);
  };

  const tag = (text: string, color: string) => (
    <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 3, background: `${color}22`, color, border: `1px solid ${color}55` }}>{text}</span>
  );
  const secHead = (title: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0 10px" }}>
      <span style={{ width: 4, height: 15, background: "var(--accent)", borderRadius: 2 }} />
      <b style={{ fontSize: 14 }}>{title}</b>
    </div>
  );

  return (
    <div style={{ display: "flex", gap: 14, alignItems: "stretch", minHeight: 480 }}>
      {/* 좌측 — 프로토콜 카드 목록 */}
      <div style={{ width: 250, flexShrink: 0, display: "flex", flexDirection: "column", gap: 8,
                    border: "1px solid var(--border)", borderRadius: 8, padding: 10, background: "var(--bg-canvas)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <b style={{ fontSize: 14 }}>{tr("행잉 프로토콜")}</b>
          <button className="primary" title={tr("새 프로토콜 추가")} onClick={addNew}
                  style={{ width: 30, height: 30, fontSize: 17, padding: 0, borderRadius: 6 }}>＋</button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, overflow: "auto" }}>
          {rules.map((r) => (
            <div key={r.id} onClick={() => select(r.id)}
                 style={{ padding: "10px 12px", borderRadius: 8, cursor: "pointer",
                          background: r.id === selId ? "var(--bg-elevated)" : "var(--bg-panel)",
                          border: `1px solid ${r.id === selId ? "var(--accent)" : "var(--border)"}` }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                <b style={{ fontSize: 13.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {/* 적용 순서(=matchHpRule 이 보는 순서). 여러 규칙이 걸릴 때 앞 번호가 이긴다. */}
                  <span title={tr("적용(감지) 순서 — 여러 규칙이 걸리면 번호가 작은 쪽이 적용됩니다")}
                        style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text-secondary)", marginRight: 5 }}>
                    {orderOf(r.id)}
                  </span>
                  {r.id === selId && dirty ? `${draft?.name || r.name} *` : r.name}
                </b>
                <span style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                  <button title={tr("복제")} onClick={(e) => { e.stopPropagation(); dup(r); }}
                          style={{ padding: "2px 6px", fontSize: 12 }}>⧉</button>
                  <button title={tr("삭제")} onClick={(e) => { e.stopPropagation(); del(r.id); }}
                          style={{ padding: "2px 6px", fontSize: 12 }}>🗑</button>
                </span>
              </div>
              <div style={{ display: "flex", gap: 5, marginTop: 6, flexWrap: "wrap" }}>
                {tag(r.modality || tr("모든 장비"), "#60a5fa")}
                {r.body_part ? tag(r.body_part, "#f59e0b") : null}
                {r.priority ? tag(tr("우선"), "#ef4444") : null}
                {r.source === "viewer" ? tag(tr("뷰어에서 저장"), "#22c55e") : null}
              </div>
            </div>
          ))}
          {rules.length === 0 && (
            <div style={{ color: "var(--text-secondary)", fontSize: 12, padding: "12px 4px", textAlign: "center" }}>
              {tr("프로토콜이 없습니다.")}<br />{tr("＋ 로 추가하세요.")}
            </div>
          )}
        </div>
      </div>

      {/* 우측 — 기본 정보 + 옵션 + 디스플레이 레이아웃 */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {!draft ? (
          <div style={{ display: "grid", placeItems: "center", flex: 1, color: "var(--text-secondary)" }}>
            {tr("좌측에서 프로토콜을 선택하거나 ＋ 로 추가하세요.")}
          </div>
        ) : (
          <>
            <div style={{ flex: 1, overflow: "auto", paddingRight: 4 }}>
              {secHead(tr("기본 정보"))}
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <label style={{ fontSize: 12.5 }}>
                  <div style={{ color: "var(--text-secondary)", marginBottom: 4 }}>{tr("프로토콜명")} <span style={{ color: "var(--stat-emergency)" }}>*</span></div>
                  <input value={draft.name} onChange={(e) => upd({ name: e.target.value })}
                         placeholder={tr("프로토콜 이름을 입력하세요")} style={{ width: "100%" }} />
                </label>
                {/* 사양 2 — 장비. 프리셋 7종 + 사용자가 추가한 것(고정 목록 금지). */}
                <div style={{ fontSize: 12.5 }}>
                  <div style={{ color: "var(--text-secondary)", marginBottom: 4 }}>{tr("장비")}</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    <select value={draft.modality} onChange={(e) => upd({ modality: e.target.value })}
                            style={{ flex: "1 1 160px", minWidth: 0 }}>
                      <option value="">{tr("모든 장비 (빈값 = 장비 무관)")}</option>
                      {modOpts.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                    <input value={newMod} onChange={(e) => setNewMod(e.target.value.toUpperCase())}
                           onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addModality(); } }}
                           placeholder={tr("장비 직접 추가 (예: XA)")} style={{ flex: "0 1 150px", minWidth: 0 }} />
                    <button onClick={addModality} disabled={!newMod.trim()}>{tr("＋ 추가")}</button>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 3 }}>
                    {tr("검사의 Modality 와")} <b>{tr("대문자 완전일치")}</b>{tr("일 때만 걸립니다 — 'CT' 규칙은 'CTA' 검사에 걸리지 않습니다.")}
                  </div>
                </div>
                {/* 사양 3 — 부위 값(자유 입력) + 그 값을 어느 DICOM 필드에서 찾을지(복수 선택) */}
                <div style={{ fontSize: 12.5 }}>
                  <div style={{ color: "var(--text-secondary)", marginBottom: 4 }}>{tr("Body Part (부위)")}</div>
                  <input value={draft.body_part} onChange={(e) => upd({ body_part: e.target.value.toUpperCase() })}
                         placeholder={tr("부위를 입력하세요 (예: CHEST, SKULL | BRAIN — 쉼표·| 로 여러 값, 빈칸=무관)")}
                         style={{ width: "100%" }} />
                  <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 3 }}>
                    {tr("쉼표·")}<code>|</code> {tr("로 나눈 값 중")} <b>{tr("하나라도")}</b> {tr("포함되면 걸립니다. 공백은 구분자가 아닙니다(")}<code>L SPINE</code> {tr("은 한 값).")}
                  </div>
                  <HpPartFieldPicker value={draft.body_part_fields}
                                     onChange={(f) => upd({ body_part_fields: f })} />
                </div>
                <label style={{ fontSize: 12.5 }}>
                  <div style={{ color: "var(--text-secondary)", marginBottom: 4 }}>{tr("설명")}</div>
                  <textarea value={draft.description ?? ""} onChange={(e) => upd({ description: e.target.value })}
                            placeholder={tr("설명을 입력하세요")} rows={3} style={{ width: "100%", resize: "vertical" }} />
                </label>
              </div>

              {/* 사양 5 — 체크박스 5개를 **가로 1열**로.
                  ⚠ 여기 style 상수(폰트 12 · 좌우 padding 8 · 체크박스 14 · 라벨 gap 6 · 항목 gap 5)는
                    lib/hangingProtocol.HP_OPTION_ROW 와 **같은 값이어야 한다** — 그 값으로 계산한
                    hpSettingsMinWidth() 로 이 페이지의 창 폭을 잡는다(아래 모달 width). 예전엔
                    기본 폭 860px 에서 편집 영역이 약 363px 밖에 안 남아 다섯 라벨(≈416px)이 애초에
                    한 줄에 들어갈 수 없었다 — flexWrap 이 잘림은 막았지만 사양대로 1열이 아니었다.
                  ⚠ flexWrap 은 그대로 둔다: 창을 좁히거나 96vw 제한에 걸리면 접혀야 하고, nowrap 로
                    박으면 오른쪽 항목이 잘려 나간다(예전에 고친 문제). */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: HP_OPTION_ROW.itemGap, margin: "16px 0 8px" }}>
                {HP_OPTIONS.map((o) => {
                  const on = !!draft[o.key];
                  return (
                    <label key={String(o.key)} title={tr(o.desc)}
                           style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 8px",
                                    flex: "1 1 auto", whiteSpace: "nowrap",
                                    border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
                                    borderRadius: 8, cursor: "pointer", background: "var(--bg-canvas)" }}>
                      <input type="checkbox" checked={on}
                             onChange={(e) => upd({ [o.key]: e.target.checked } as Partial<HpRule>)}
                             style={{ width: 14, height: 14, flexShrink: 0 }} />
                      <span style={{ fontSize: HP_OPTION_ROW.fontPx, fontWeight: 600 }}>{tr(o.label)}</span>
                    </label>
                  );
                })}
              </div>

              {/* 사양 6 — '가장 우선 적용'. ⚠ 기본은 언체크. 위 5개와 뜻이 달라(적용 순서) 줄을 나눈다. */}
              <label style={{ display: "flex", alignItems: "flex-start", gap: 9, padding: "9px 11px",
                              border: `1px solid ${draft.priority ? "#ef4444" : "var(--border)"}`,
                              borderRadius: 8, cursor: "pointer", background: "var(--bg-canvas)", marginBottom: 14 }}>
                <input type="checkbox" checked={!!draft.priority}
                       onChange={(e) => upd({ priority: e.target.checked })}
                       style={{ width: 16, height: 16, marginTop: 2, flexShrink: 0 }} />
                <span style={{ fontSize: 12.5 }}>
                  <b>{tr("가장 우선 적용")}</b>
                  <div style={{ color: "var(--text-secondary)", fontSize: 11.5, marginTop: 2, lineHeight: 1.5 }}>
                    {tr("이 규칙을")} <b>{tr("다른 규칙보다 먼저")}</b> {tr("검사해, 조건이 맞으면 그것을 적용합니다(기본 해제). 켠 규칙이 여러 개면")} <b>{tr("왼쪽 목록의 번호가 작은 쪽")}</b>{tr("이 이깁니다.")}
                  </div>
                </span>
              </label>

              {/* 사양 4 — 모니터 배치 */}
              {secHead(tr("모니터 배치 (Series · Image 레이아웃 · 칸별 영상)"))}
              <HpScreenEditor screens={draft.screens ?? hpScreensFromMonitors(monitorSel, draft.s, draft.i)}
                              monitors={monitors} monitorSel={monitorSel}
                              onChange={(sc) => upd({ screens: sc })} />
            </div>

            {/* 하단 — 취소/저장 */}
            <div style={{ display: "flex", gap: 8, justifyContent: "center", padding: "12px 0 2px",
                          borderTop: "1px solid var(--border)", marginTop: 8 }}>
              <button onClick={() => select(selId)} disabled={!dirty} style={{ minWidth: 84 }}>{tr("취소")}</button>
              <button className="primary" onClick={save} style={{ minWidth: 84 }}>{tr("저장")}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── 사양 3 — 부위를 '어느 DICOM 필드에서 찾을지' 고르는 UI(복수) ──
 *  ⚠ 여기 뜨는 4개가 **우리 데이터에 실제로 값이 있는 전부**다(HP_PART_FIELDS).
 *    사양이 예로 든 Protocol Code / Procedure Code / Procedure Step Description 은 백엔드가
 *    그 태그를 읽지도·저장하지도·내려주지도 않는다 — 올려 두면 '골라도 절대 안 걸리는' 항목이 된다.
 *  ⚠ 로컬/Live 배지와 경고가 반드시 필요하다: body_part 하나만 고른 규칙은 로컬(Orthanc) 검사에서
 *    값이 항상 "" 이라 **절대 걸리지 않는다**. 구 저장본이 정확히 이 상태로 읽힌다(마이그레이션이
 *    일부러 넓히지 않는다 — 넓히면 어제와 다른 규칙이 걸린다). 화면이 말해 주지 않으면 원인을 알 수 없다. */
function HpPartFieldPicker({ value, onChange }: {
  value?: HpPartField[];
  onChange: (f: HpPartField[]) => void;
}) {
  // 빈값 = 구 저장본. lib 과 같은 규칙으로 body_part 만 켠 것처럼 보여 준다(hpPartFieldGaps 도 같다).
  const cur: HpPartField[] = value && value.length ? value : ["body_part"];
  const toggle = (k: HpPartField) => {
    const next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
    onChange(next.length ? next : [k]);   // 전부 끄면 무엇으로 찾을지가 없어진다 — 마지막 하나는 남긴다
  };
  const gaps = hpPartFieldGaps(cur);
  const badge = (t: string, ok: boolean) => (
    <span style={{ fontSize: 9.5, fontWeight: 700, padding: "0 4px", borderRadius: 3,
                   border: `1px solid ${ok ? "#22c55e" : "var(--border)"}`,
                   color: ok ? "#22c55e" : "var(--text-secondary)",
                   background: ok ? "rgba(34,197,94,0.12)" : "transparent" }}>{t}</span>
  );
  return (
    <div style={{ marginTop: 8, border: "1px solid var(--border)", borderRadius: 8, padding: 9,
                  background: "var(--bg-canvas)" }}>
      <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginBottom: 6 }}>
        {tr("위 부위 값을")} <b>{tr("어느 DICOM 필드에서 찾을지")}</b> {tr("(여러 개 선택 가능 — 고른 곳들에서 모두 찾습니다)")}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {HP_PART_FIELDS.map((f) => {
          const on = cur.includes(f.key);
          return (
            <label key={f.key} title={tr(f.note)}
                   style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 8px",
                            border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`, borderRadius: 6,
                            cursor: "pointer", background: on ? "var(--accent-subtle)" : "var(--bg-panel)" }}>
              <input type="checkbox" checked={on} onChange={() => toggle(f.key)}
                     style={{ width: 15, height: 15, marginTop: 2, flexShrink: 0 }} />
              <span style={{ minWidth: 0, fontSize: 12 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                  <b>{tr(f.label)}</b>
                  <code style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>{f.tag}</code>
                  {badge(tr("로컬"), f.local)}{badge("Live", f.live)}
                </span>
                <span style={{ display: "block", fontSize: 11, color: "var(--text-secondary)", marginTop: 1 }}>
                  {tr(f.note)}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {(gaps.local || gaps.live) && (
        <div style={{ marginTop: 7, fontSize: 11.5, lineHeight: 1.55, borderRadius: 6, padding: "6px 9px",
                      color: "#fbbf24", border: "1px solid rgba(251,191,36,0.5)", background: "rgba(251,191,36,0.10)" }}>
          {tr("⚠ 지금 고른 출처는")} <b>{gaps.local ? tr("로컬(Orthanc) 검사") : tr("Live(A) 검사")}</b>{tr("에서 값이 비어 있어, 그쪽 검사에는")} <b>{tr("이 규칙이 절대 걸리지 않습니다")}</b>.
          {" "}<b>Study Description</b> {tr("을 함께 켜면 로컬·Live 양쪽에서 찾습니다.")}
        </div>
      )}
      {/* 사양이 이름을 댔지만 목록에 없는 출처가 **있을 때만** 안내한다.
          지금은 전부 올라가 문구가 비어 있다 — 빈 문구로 빈 줄을 그리면 안 된다. */}
      {HP_PART_FIELDS_UNAVAILABLE && (
        <div style={{ marginTop: 7, fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          · <b>{HP_PART_FIELDS_UNAVAILABLE}</b> {tr("는 서버가 그 DICOM 태그를 저장하지 않아 목록에 없습니다 (올려 두면 고를 수는 있는데")} <b>{tr("어떤 검사에도 걸리지 않는")}</b> {tr("항목이 됩니다).")}
        </div>
      )}
      {!value?.length && (
        <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          {tr("이 규칙은 예전 버전에서 저장된 것이라 출처가")} <b>{tr("Body Part Examined 하나")}</b>{tr("로 읽혔습니다 (지금까지와 동작을 같게 두려고 자동으로 넓히지 않습니다). 저장하면 위 선택이 그대로 굳습니다.")}
        </div>
      )}
    </div>
  );
}

/* ── 사양 4 — 모니터 배치 편집기 ──
 *  설정>모니터에서 고른 화면을 **크게** 보여 주고, 화면마다 4-1 Series/Image 레이아웃을,
 *  칸마다 4-2 '무엇을 띄울지'(시간대 슬롯·3D)와 시리즈 순번을 고른다.
 *  ⚠ 가로 스크롤이 아니라 **줄바꿈(wrap)** 이다 — 설정 창을 좁혔을 때 오른쪽 화면이 잘려 보이지 않게 한다. */
function HpScreenEditor({ screens, monitors, monitorSel, onChange }: {
  screens: HpScreen[];
  monitors: { label: string; w: number; h: number; primary: boolean }[];
  monitorSel: number[];
  onChange: (s: HpScreen[]) => void;
}) {
  const patch = (id: string, p: Partial<HpScreen>) =>
    onChange(screens.map((s) => (s.id === id ? { ...s, ...p } : s)));
  // 그리드를 바꾸면 칸 배열 길이를 맞춘다 — fitHpCells(lib) 가 늘림/줄임과 기본 슬롯을 책임진다.
  const setS = (sc: HpScreen, g: { r: number; c: number }) =>
    patch(sc.id, { s: g, cells: fitHpCells(sc.cells, g) });
  const setCell = (sc: HpScreen, k: number, c: HpCell) =>
    patch(sc.id, { cells: sc.cells.map((x, i) => (i === k ? c : x)) });
  const cycleSeries = (sc: HpScreen, k: number) => {
    const n = Math.max(1, sc.s.r * sc.s.c);
    const cur = sc.cells[k]?.series ?? null;
    const next = cur == null ? 1 : cur >= n ? null : cur + 1;   // 자동 → 1 → … → n → 자동
    setCell(sc, k, { series: next, slot: readHpSlot(sc.cells[k]?.slot) });
  };
  const add = () => onChange([...screens, {
    id: `sc${Date.now().toString(36)}`, role: "viewer", label: String(screens.length + 1),
    monitor: null, resolution: "", s: { r: 1, c: 1 }, i: { r: 1, c: 1 },
    cells: fitHpCells(undefined, { r: 1, c: 1 }),
  }]);

  // 3D 칸이 하나라도 있으면 아래 경고를 띄운다(뷰어가 복원하지 못한다 — hpPlanCells 의 skip:"3d")
  const has3d = screens.some((sc) => (sc.cells ?? []).some((c) => readHpSlot(c?.slot).kind === "3d"));
  // 모니터 콤보 — 감지된 목록이 있으면 그것을, 없으면 설정>모니터에서 뷰어로 고른 번호만이라도 보여 준다
  const monOpts = monitors.length
    ? monitors.map((m, i) => ({
        i, label: `${i + 1}. ${m.label} (${m.w}×${m.h})${m.primary ? ` · ${tr("주")}` : ""}${monitorSel.includes(i) ? ` · ${tr("뷰어")}` : ""}`,
      }))
    : monitorSel.map((i) => ({ i, label: `${i + 1}${tr("번 모니터 (뷰어)")}` }));

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, background: "var(--bg-canvas)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <button onClick={() => onChange(hpScreensFromMonitors(monitorSel, screens[0]?.s, screens[0]?.i))}
                title={tr("설정 > 모니터에서 '뷰어 ☑' 로 고른 화면들로 배치를 다시 만듭니다 (칸 설정은 초기화)")}>
          {tr("⟳ 설정>모니터에서 가져오기")}
        </button>
        <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
          {monOpts.length
            ? `${tr("설정 > 모니터:")} ${monOpts.length}${tr("대 — 화면마다 어느 모니터인지 지정하세요")}`
            : tr("설정 > 모니터에서 ① 모니터 감지 → 뷰어 ☑ 를 먼저 지정하면 여기에 실제 모니터가 뜹니다")}
        </span>
      </div>

      {/* 화면 카드 — 넓으면 나란히, 좁으면 아래로 접힌다(잘리지 않는다) */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {screens.map((sc) => {
          const viewer = sc.role === "viewer";
          return (
            <div key={sc.id} style={{ flex: "1 1 340px", minWidth: 280, maxWidth: "100%",
                                      border: `2px solid ${viewer ? "#8b5cf6" : "#22c55e"}`,
                                      borderRadius: 6, overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6,
                            padding: "6px 10px", background: viewer ? "#8b5cf6" : "#22c55e",
                            color: "#fff", fontSize: 12, fontWeight: 700 }}>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {viewer ? "viewer" : "workList + report"} · {sc.monitor == null ? tr("모니터 미지정") : `${tr("모니터")} ${sc.monitor + 1}`}
                </span>
                <span style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                  <button title={tr("역할 전환 (viewer ↔ workList+report)")}
                          onClick={() => patch(sc.id, { role: viewer ? "worklist_report" : "viewer" })}
                          style={{ padding: "0 6px", fontSize: 11, color: "#fff", background: "rgba(0,0,0,0.25)", border: "none", borderRadius: 3 }}>⇄</button>
                  {screens.length > 1 && (
                    <button title={tr("이 화면 제거")} onClick={() => onChange(screens.filter((x) => x.id !== sc.id))}
                            style={{ padding: "0 6px", fontSize: 11, color: "#fff", background: "rgba(0,0,0,0.25)", border: "none", borderRadius: 3 }}>✕</button>
                  )}
                </span>
              </div>
              <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8, background: "var(--bg-panel)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)", flexShrink: 0 }}>{tr("모니터")}</span>
                  <select value={sc.monitor ?? ""} style={{ flex: "1 1 140px", minWidth: 0, fontSize: 11 }}
                          onChange={(e) => patch(sc.id, { monitor: e.target.value === "" ? null : Number(e.target.value) })}>
                    <option value="">{tr("미지정 (연 순서대로)")}</option>
                    {monOpts.map((o) => <option key={o.i} value={o.i}>{o.label}</option>)}
                    {/* 저장된 값이 지금 감지 목록에 없을 수도 있다(모니터를 안 뽑았을 때) — 값이 사라지지 않게 남긴다 */}
                    {sc.monitor != null && !monOpts.some((o) => o.i === sc.monitor) && (
                      <option value={sc.monitor}>{sc.monitor + 1}{tr("번 모니터 (지금 감지 안 됨)")}</option>
                    )}
                  </select>
                </div>
                {viewer ? (
                  <>
                    {/* 4-1 Series Layout · Image Layout */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <GridPicker label="Series" max={10} value={sc.s} onPick={(g) => setS(sc, g)} />
                      <GridPicker label="Image" max={10} value={sc.i} onPick={(g) => patch(sc.id, { i: g })} />
                      <span style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>{tr("칸 = Series 분할")}</span>
                    </div>
                    {/* 4-2 칸마다 '무엇을 띄울지' */}
                    <div style={{ display: "grid", gridTemplateColumns: `repeat(${sc.s.c}, minmax(0, 1fr))`, gap: 5,
                                  background: "var(--bg-elevated)", padding: 6, borderRadius: 4 }}>
                      {sc.cells.map((c, k) => {
                        const slot = readHpSlot(c?.slot);
                        return (
                          <div key={k} style={{ border: "1px solid var(--border)", borderRadius: 4, padding: 5,
                                                background: "var(--bg-canvas)", display: "flex",
                                                flexDirection: "column", gap: 4, minWidth: 0 }}>
                            <button onClick={() => cycleSeries(sc, k)} title={tr("클릭 = 시리즈 순번 지정 ↔ 자동")}
                                    style={{ fontSize: 11, padding: "2px 4px", width: "100%" }}>
                              {c?.series == null ? `${tr("자동")} ${k + 1}` : `${tr("시리즈")} ${c.series}`}
                            </button>
                            <select value={slot.kind} style={{ fontSize: 11, width: "100%", minWidth: 0 }}
                                    title={tr("이 칸에 띄울 영상")}
                                    onChange={(e) => setCell(sc, k, {
                                      series: c?.series ?? null,
                                      slot: readHpSlot(e.target.value === "custom"
                                        ? { kind: "custom", n: slot.n ?? 1, unit: slot.unit ?? "m" }
                                        : { kind: e.target.value }),
                                    })}>
                              {HP_SLOTS.map((k2) => <option key={k2} value={k2}>{tr(HP_SLOT_LABEL[k2])}</option>)}
                            </select>
                            {slot.kind === "custom" && (
                              <div style={{ display: "flex", gap: 4 }}>
                                <input type="number" min={1} value={slot.n ?? 1} style={{ width: 52, fontSize: 11 }}
                                       onChange={(e) => setCell(sc, k, {
                                         series: c?.series ?? null,
                                         slot: readHpSlot({ kind: "custom", n: Number(e.target.value), unit: slot.unit ?? "m" }),
                                       })} />
                                <select value={slot.unit ?? "m"} style={{ flex: 1, minWidth: 0, fontSize: 11 }}
                                        onChange={(e) => setCell(sc, k, {
                                          series: c?.series ?? null,
                                          slot: readHpSlot({ kind: "custom", n: slot.n ?? 1, unit: e.target.value as HpSlotUnit }),
                                        })}>
                                  {(["d", "w", "m", "y"] as HpSlotUnit[]).map((u) =>
                                    <option key={u} value={u}>{tr(HP_SLOT_UNIT_LABEL[u])} {tr("내")}</option>)}
                                </select>
                              </div>
                            )}
                            <span style={{ fontSize: 10, color: "var(--text-secondary)", textAlign: "center" }}>
                              {tr(hpSlotLabel(slot))}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </>
                ) : (
                  <div style={{ height: 90, display: "grid", placeItems: "center", color: "var(--text-secondary)",
                                background: "var(--bg-elevated)", borderRadius: 4, fontSize: 12 }}>
                    {tr("뷰어 사용 안함 (워크리스트 + 판독)")}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", justifyContent: "center", marginTop: 10 }}>
        <button onClick={add} style={{ fontSize: 11.5 }}>{tr("＋ 화면 추가")}</button>
      </div>
      {/* 3D 칸은 저장은 되지만 뷰어가 복원하지 못한다 — **저장 전에** 알린다.
          (예전에는 고르고 저장한 뒤 뷰어를 열어야 '빈 칸'이라는 것을 알 수 있었다) */}
      {has3d && (
        <div style={{ marginTop: 8, fontSize: 11, lineHeight: 1.55, borderRadius: 6, padding: "6px 9px",
                      color: "#fbbf24", border: "1px solid rgba(251,191,36,0.5)", background: "rgba(251,191,36,0.10)" }}>
          ⚠ <b>{tr("3D 영상")}</b>{tr("을 고른 칸이 있습니다 — 뷰어는 그 칸을")} <b>{tr("빈 칸으로 두고")}</b> {tr("상태줄에 알립니다. 뷰어의 3D 는 페인이 아니라 뷰포트 전체를 바꾸는 모드라 칸 하나에 대응시킬 수 없습니다.")}
        </div>
      )}
      <div style={{ fontSize: 10.5, color: "var(--text-secondary)", marginTop: 8, lineHeight: 1.6 }}>
        · {tr("기간은")} <b>{tr("오늘이 아니라 지금 보는 검사의 검사일")}</b>{tr("을 기준으로 거슬러 올라갑니다(같은 날 포함). 1주=7일 · 1개월=30일 · 1년=365일(달력 월/년이 아닙니다 — 백엔드 비교 기준과 같습니다).")}<br />
        · {tr("같은 시간대를 고른 칸이 여러 개면")} <b>{tr("최신 순으로 한 건씩")}</b> {tr("나뉘어 들어갑니다.")}<br />
        {/* ⚠ 이 문단은 예전에 '두 번째 모니터·칸별 시간대·3D 는 아직 반영되지 않습니다' 라고
            적혀 있었는데, 그 뒤 뷰어가 pickHpScreen(모니터별 화면) + hpPlanCells(칸별 시간대)를
            실제로 적용하게 되면서 **거짓말이 됐다**. 안내가 '아직 안 된다'고 하면 사용자는 그 기능을
            안 쓴다 — 동작이 바뀌면 이 문단도 같이 바꾼다(짝이 되는 규정은 lib/hpCapture.ts). */}
        · <b>{tr("칸별 시간대와 모니터별 화면은 뷰어가 그대로 적용합니다.")}</b> {tr("이 창의 모니터에 맞는 화면이 없으면")} <b>{tr("모니터 미지정 화면 → 첫 viewer 화면")}</b> {tr("순으로 폴백합니다. 조건에 맞는 과거검사가 없는 칸은 비워 두고 상태줄에 알립니다.")}<br />
        · <b>{tr("3D 영상 칸만")}</b> {tr("뷰어가 복원하지 않습니다(3D 는 페인이 아니라 뷰포트 전체를 바꾸므로 칸에 대응시킬 수 없습니다).")}
      </div>
    </div>
  );
}

/* ── Filter Setting 리스트 (UBPACS형 — ITEM | USE/NO USE 토글 + ▲▼ 순서) ── */
export function FilterSettingList({ all, selected, labelOf, onChange, searchable, searchSel, onSearchChange, searchOnly, searchOnlyLabelOf }: {
  all: string[];
  selected: string[];
  labelOf: (k: string) => string;
  onChange: (next: string[]) => void;
  /** 통합 편집기(2026-08-10 사용자 확정) — 그리드 컬럼 구성과 검색 필드 구성이 기능적으로
   *  겹쳐 한 표로 합쳤다. searchable[컬럼키]=검색 필드 키 · searchSel=켜진 검색 필드 ·
   *  searchOnly=대응 컬럼이 없는 검색 전용 항목(소견 검색·Key Image 등). */
  searchable?: Record<string, string>;
  searchSel?: string[];
  onSearchChange?: (next: string[]) => void;
  searchOnly?: string[];
  searchOnlyLabelOf?: (k: string) => string;
}) {
  useLang();   // tr 반영 — 언어 변경 시 다시 그린다
  const rows = [...selected, ...all.filter((k) => !selected.includes(k))];
  const unified = !!searchable && !!searchSel && !!onSearchChange;
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const move = (k: string, dir: -1 | 1) => {
    const i = selected.indexOf(k);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= selected.length) return;
    const next = [...selected];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  // 행 드래그 = 순서 이동(그리드 헤더 드래그와 같은 조작) — 켜진(USE) 항목 사이에서만
  const dropOn = (k: string) => {
    if (!dragKey || dragKey === k || !selected.includes(dragKey)) { setDragKey(null); setOverKey(null); return; }
    const next = selected.filter((x) => x !== dragKey);
    const at = next.indexOf(k);
    next.splice(at < 0 ? next.length : at, 0, dragKey);
    onChange(next);
    setDragKey(null); setOverKey(null);
  };
  const toggleSearch = (fk: string) => {
    if (!searchSel || !onSearchChange) return;
    onSearchChange(searchSel.includes(fk) ? searchSel.filter((x) => x !== fk) : [...searchSel, fk]);
  };
  const searchCell = (fk?: string) => {
    if (!unified) return null;
    if (!fk) return <td style={{ color: "var(--text-secondary)" }}>—</td>;
    const on = searchSel!.includes(fk);
    return (
      <td>
        <span onClick={() => toggleSearch(fk)} title={tr("클릭=토글")}
              style={{ cursor: "pointer", fontWeight: 700, fontSize: 10.5, padding: "1px 7px",
                       border: "1px solid var(--border)", borderRadius: 3,
                       color: on ? "var(--accent)" : "var(--text-secondary)",
                       background: on ? "rgba(80,140,220,0.14)" : undefined }}>
          {on ? "USE" : "NO USE"}
        </span>
      </td>
    );
  };
  return (
    <div style={{ maxHeight: 280, overflow: "auto", border: "1px solid var(--border)", borderRadius: 4 }}>
      <table className="grid-table">
        <thead><tr>
          <th>ITEM</th>
          <th style={{ width: 78 }}>{unified ? tr("표시") : tr("사용")}</th>
          {unified && <th style={{ width: 78 }}>{tr("검색")}</th>}
          <th style={{ width: 64 }}>{tr("순서")}</th>
        </tr></thead>
        <tbody>
          {rows.map((k) => {
            const used = selected.includes(k);
            const i = selected.indexOf(k);
            return (
              <tr key={k}
                  draggable={used}
                  onDragStart={(e) => { setDragKey(k); e.dataTransfer.effectAllowed = "move"; }}
                  onDragOver={(e) => { if (dragKey) { e.preventDefault(); setOverKey(k); } }}
                  onDrop={(e) => { e.preventDefault(); dropOn(k); }}
                  onDragEnd={() => { setDragKey(null); setOverKey(null); }}
                  style={{ cursor: used ? "grab" : undefined,
                           opacity: dragKey === k ? 0.4 : undefined,
                           boxShadow: overKey === k && dragKey && dragKey !== k
                             ? "inset 0 3px 0 var(--accent)" : undefined }}
                  title={used ? tr("행 드래그 = 순서 이동") : undefined}>
                <td style={{ color: used ? "var(--text-primary)" : "var(--text-secondary)" }}>{labelOf(k)}</td>
                <td>
                  <span onClick={() => onChange(used ? selected.filter((x) => x !== k) : [...selected, k])}
                        title={tr("클릭=토글")}
                        style={{
                          cursor: "pointer", fontWeight: 700, fontSize: 10.5, padding: "1px 7px",
                          border: "1px solid var(--border)", borderRadius: 3,
                          color: used ? "var(--stat-final)" : "var(--text-secondary)",
                          background: used ? "rgba(80,200,120,0.12)" : undefined,
                        }}>
                    {used ? "USE" : "NO USE"}
                  </span>
                </td>
                {searchCell(searchable?.[k])}
                <td style={{ whiteSpace: "nowrap" }}>
                  {used && (
                    <>
                      <button style={{ padding: "0 5px", fontSize: 10.5 }} disabled={i === 0}
                              onClick={() => move(k, -1)}>▲</button>
                      <button style={{ padding: "0 5px", fontSize: 10.5 }} disabled={i === selected.length - 1}
                              onClick={() => move(k, 1)}>▼</button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
          {/* 검색 전용 항목(대응 컬럼 없음 — 소견 검색·Key Image 등)은 표 끝에 */}
          {unified && (searchOnly ?? []).map((fk) => (
            <tr key={"find:" + fk}>
              <td style={{ color: "var(--text-secondary)" }}>
                {(searchOnlyLabelOf ?? ((x: string) => x))(fk)}
                <span style={{ fontSize: 10, marginLeft: 6, opacity: 0.7 }}>{tr("(검색 전용)")}</span>
              </td>
              <td style={{ color: "var(--text-secondary)" }}>—</td>
              {searchCell(fk)}
              <td />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── 듀얼 리스트 (화면분석 §5.10 패턴: Available ↔ Selected + Up/Down) ── */
export function DualList({ all, selected, labelOf, onChange }: {
  all: string[];
  selected: string[];
  labelOf: (k: string) => string;
  onChange: (next: string[]) => void;
}) {
  useLang();   // tr 반영 — 언어 변경 시 다시 그린다
  const [pickAvail, setPickAvail] = useState<string | null>(null);
  const [pickSel, setPickSel] = useState<string | null>(null);
  const available = all.filter((k) => !selected.includes(k));

  const move = (dir: 1 | -1) => {
    if (!pickSel) return;
    const i = selected.indexOf(pickSel);
    const j = i + dir;
    if (j < 0 || j >= selected.length) return;
    const next = [...selected];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  const ListBox = ({ title, items, pick, setPick }: {
    title: string; items: string[]; pick: string | null; setPick: (k: string) => void;
  }) => (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 3 }}>{title}</div>
      <div style={{ height: 200, overflow: "auto", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-canvas)" }}>
        {items.map((k) => (
          <div key={k} onClick={() => setPick(k)}
               style={{
                 padding: "4px 10px", fontSize: 12.5, cursor: "pointer",
                 background: pick === k ? "var(--accent-subtle)" : undefined,
               }}>
            {labelOf(k)}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
      <ListBox title="Available Columns" items={available} pick={pickAvail} setPick={setPickAvail} />
      <div style={{ display: "flex", flexDirection: "column", gap: 5, justifyContent: "center" }}>
        <button disabled={!pickAvail}
                onClick={() => { if (pickAvail) { onChange([...selected, pickAvail]); setPickAvail(null); } }}>→</button>
        <button disabled={!pickSel}
                onClick={() => { if (pickSel) { onChange(selected.filter((k) => k !== pickSel)); setPickSel(null); } }}>←</button>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <ListBox title={"Selected Columns " + tr("(순서 = 표시 순서)")} items={selected} pick={pickSel} setPick={setPickSel} />
        <div style={{ display: "flex", gap: 5, marginTop: 5, justifyContent: "flex-end" }}>
          <button disabled={!pickSel} onClick={() => move(-1)}>Up</button>
          <button disabled={!pickSel} onClick={() => move(1)}>Down</button>
        </div>
      </div>
    </div>
  );
}

export function Group({ title, right, children, style }: { title: string; right?: React.ReactNode; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <fieldset style={{ border: "1px solid var(--border)", borderRadius: 5, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8, margin: 0, ...style }}>
      <legend style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text-secondary)", padding: "0 6px", display: "flex", gap: 8 }}>
        {title}{right}
      </legend>
      {children}
    </fieldset>
  );
}
export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}>
      <span style={{ width: 110, color: "var(--text-secondary)" }}>{label}</span>
      {children}
    </label>
  );
}

/** 폴더 선택 모달 — 서버 PC 폴더 탐색(/api/share/fs, 관리자 전용).
 *  폴더 클릭=진입, ⬆=상위(드라이브 루트면 드라이브 목록), [이 폴더 선택]=입력에 반영(저장은 기존 OK/Refresh). */
function FolderPickerModal({ initial, onPick, onClose }: {
  initial: string; onPick: (path: string) => void; onClose: () => void;
}) {
  const [path, setPath] = useState("");                 // 현재 경로("" = 드라이브 목록)
  const [parent, setParent] = useState<string | null>(null);
  const [dirs, setDirs] = useState<{ name: string; path: string }[]>([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const nav = (p: string) => {
    setLoading(true); setErr("");
    api.shareFs(p).then((r) => {
      // 주의: nav("")가 동기적으로 setErr("")를 실행하므로, 에러 메시지는 nav("") 이후에 설정해야 남는다
      if (p && !r.exists) { nav(""); setErr(`${tr("경로 없음")}: ${p} — ${tr("드라이브 목록을 표시합니다")}`); return; }
      setPath(r.path); setParent(r.parent); setDirs(r.dirs); setLoading(false);
    }).catch((e) => { setErr(e instanceof Error ? e.message : tr("폴더 탐색 실패")); setLoading(false); });
  };
  useEffect(() => {
    // 초기 경로: 현재 입력값 → 없으면 현재 설정된 공유 디렉토리 → 없으면 드라이브 목록
    if (initial) { nav(initial); return; }
    api.shareConfig().then((c) => nav(c.exists ? c.dir : "")).catch(() => nav(""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
                  display: "grid", placeItems: "center", zIndex: 400 }}>
      <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8,
                    width: "min(480px, 92vw)", height: "min(440px, 80vh)", display: "flex",
                    flexDirection: "column", padding: 12, gap: 8 }}>
        <b style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
          <FolderIcon size={15} /> {tr("서버 폴더 선택")}
        </b>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button onClick={() => nav(parent ?? "")} disabled={!path}
                  title={parent ? tr("상위 폴더로") : tr("드라이브 목록으로")}
                  style={{ padding: "2px 8px", fontSize: 12 }}>{tr("⬆ 상위")}</button>
          <code title={path}
                style={{ flex: 1, fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis",
                         whiteSpace: "nowrap" }}>
            {path || tr("(드라이브를 선택하세요)")}
          </code>
        </div>
        {err && <div style={{ fontSize: 11.5, color: "var(--stat-emergency)" }}>{err}</div>}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto",
                      border: "1px solid var(--border)", borderRadius: 4 }}>
          {loading ? (
            <div style={{ padding: 10, fontSize: 12, color: "var(--text-secondary)" }}>{tr("불러오는 중…")}</div>
          ) : dirs.length === 0 ? (
            <div style={{ padding: 10, fontSize: 12, color: "var(--text-secondary)" }}>{tr("하위 폴더 없음")}</div>
          ) : dirs.map((d) => (
            <div key={d.path} onClick={() => nav(d.path)} className="sv-fav-row"
                 title={d.path}
                 style={{ padding: "4px 10px", fontSize: 12.5, cursor: "pointer",
                          display: "flex", alignItems: "center", gap: 6 }}>
              <FolderIcon size={14} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {d.name}
              </span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", alignItems: "center" }}>
          <span style={{ marginRight: "auto", fontSize: 10.5, color: "var(--text-secondary)" }}>
            {tr("선택 후 저장(OK/Refresh)해야 반영됩니다")}
          </span>
          <button onClick={onClose} style={{ fontSize: 12 }}>{tr("취소")}</button>
          <button className="primary" disabled={!path} onClick={() => onPick(path)}
                  title={tr("현재 표시된 경로를 공유 디렉토리 입력에 반영")} style={{ fontSize: 12 }}>
            {tr("이 폴더 선택")}
          </button>
        </div>
      </div>
    </div>
  );
}
