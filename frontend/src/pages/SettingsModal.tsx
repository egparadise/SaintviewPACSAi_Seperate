// 설정 — INFINITT Setting options 패턴(좌측 트리 + 우측 페이지, 화면분석 §5)
import { useEffect, useRef, useState } from "react";
import { VIEWER_BASE, api, sttStatus, type AiQuality, type OrthancStatus, type PhraseRow, type SttStatus } from "../api";
import { COLUMN_DEFS, DEFAULT_COLUMNS, DEFAULT_FIND_FIELDS, FIND_FIELDS, PhraseEditModal } from "./Worklist";
import { GridPicker } from "../lib/GridPicker";
import { CLIENT_VIEWERS, DEFAULT_CLIENT_VIEWER, DEFAULT_HP_DISPLAYS, DEFAULT_WL_PRESETS, TOOLBAR_DEFS, type HpDisplay, type HpRule, type WlPreset } from "../lib/viewerConfig";
import { IN_LAYOUTS, IN_PALETTE } from "../lib/infiConfig";
import { screenApiIssue } from "../lib/screens";
import { SC_ACTIONS, SC_DEFAULTS, displayKey } from "../lib/shortcutDefs";
import { ToolIconTy } from "../components/ToolIconTy";
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

const TREE: { key: string; label: string; admin?: boolean; scope: SettingsScope; parent?: string }[] = [
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
  { key: "env", label: "환경 (Environment)", scope: "viewer" },
  { key: "worklist", label: "워크리스트", scope: "viewer" },
  // 표기·순서 규약: SaintView → I-View → T-View (선택 뷰어·모드 프로파일 콤보와 동일)
  { key: "wlSaint", label: "SaintView", scope: "viewer", parent: "worklist" },
  { key: "wlIn", label: "I-View", scope: "viewer", parent: "worklist" },
  { key: "wlTy", label: "T-View", scope: "viewer", parent: "worklist" },
  { key: "report", label: "리포트", scope: "viewer" },
  { key: "reading", label: "판독 (Reading)", scope: "viewer" },
  // 뷰어 설정 3분리 — 공통(선택/모드/OHIF) · TY Viewer 전용 · In Viewer 전용 (키 이름은 기존 유지 — 로밍 호환)
  { key: "viewer", label: "뷰어 공통", scope: "viewer" },
  { key: "viewerSv", label: "SaintView", scope: "viewer", parent: "viewer" },
  { key: "viewerIn", label: "I-View", scope: "viewer", parent: "viewer" },
  { key: "viewerTy", label: "T-View", scope: "viewer", parent: "viewer" },
  { key: "monitor", label: "모니터 (Display)", scope: "viewer" },
  { key: "shortcuts", label: "단축키 (Mouse·Key)", scope: "viewer" },
  { key: "policy", label: "정책 (Policy)", scope: "viewer" },
  { key: "hp", label: "행잉 (HP)", scope: "viewer" },
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
          자주 쓰는 툴 TOP10 (사용 횟수순)
        </span>
        <button style={{ padding: "1px 8px", fontSize: 11 }} onClick={onReset}>기록 초기화</button>
      </div>
      {top.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          기록 없음 — 뷰어에서 툴을 사용하면 집계됩니다.
        </div>
      ) : (
        <ol style={{ margin: 0, paddingLeft: 22, fontSize: 12,
                     display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 16px" }}>
          {top.map(([id, n]) => (
            <li key={id}>
              {labelOf(id)} <span style={{ color: "var(--text-secondary)" }}>— {n}회</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** SCP/SCU 장비 노드 (dicom.nodes — AE Title/IP/Port, 추가·삭제·확장 가능) */
interface DicomNode { name: string; role: "scu" | "scp" | "both"; ae_title: string; ip: string; port: number }

export function SettingsModal({ role, onClose, scope = "viewer" }: {
  role: string; onClose: () => void; scope?: SettingsScope;
}) {
  const isAdmin = role === "admin";
  // 현재 스코프에서 보이는 탭만 (단계별 분리)
  const visibleTabs = TREE.filter((t) => t.scope === scope && (!t.admin || isAdmin));
  const [page, setPage] = useState<string>(visibleTabs[0]?.key ?? "");
  // 설정 창 크기 — 기본(860×580) ↔ 전체 화면 토글, 우하단 드래그로 자유 조절(resize:both)
  const [maxed, setMaxed] = useState(false);
  const [treeW, setTreeW] = useState(190);   // 좌측 트리 폭 — 스플리터 드래그로 조절
  const [saved, setSaved] = useState("");

  // ── 상태 (페이지별) ──
  const [refreshSec, setRefreshSec] = useState(10);
  const [defaultStatus, setDefaultStatus] = useState("");
  const [columns, setColumns] = useState<string[]>(DEFAULT_COLUMNS);
  // 뷰어별 워크리스트 컬럼 오버라이드 — null/undefined = 공통(columns) 사용
  const [wlBy, setWlBy] = useState<{ sv?: string[] | null; ty?: string[] | null; infi?: string[] | null }>({});
  const [findFields, setFindFields] = useState<string[]>(DEFAULT_FIND_FIELDS);
  const [dblAction, setDblAction] = useState<"viewer2d" | "ohif">("viewer2d");
  const [hangingCT, setHangingCT] = useState("default");
  const [hangingMR, setHangingMR] = useState("default");
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
  const [h2dCT, setH2dCT] = useState("1x1");
  const [h2dMR, setH2dMR] = useState("1x2");
  const [reportDock, setReportDock] = useState(true);
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
  // 모니터별 ◀▶ 탐색 목록 = 배정된 워크리스트 탭의 필터 (monitorIndex → tabId, ""=전체)
  const [tabBinding, setTabBinding] = useState<Record<number, string>>({});
  // 모달리티 → 모니터 배치 예외(라운드로빈 대신 지정 모니터로 오픈). {modality, monitor}
  const [modalityMap, setModalityMap] = useState<{ modality: string; monitor: number }[]>([]);
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
  // 정책 — ◀(왼쪽) 버튼이 시간상 어느 방향으로 갈지 (워크리스트는 최신이 위)
  const [polNavLeft, setPolNavLeft] = useState<"past" | "recent">("past");
  const [quality, setQuality] = useState<AiQuality | null>(null);
  const [orthanc, setOrthanc] = useState<OrthancStatus | null>(null);
  // 05 Mode Profile — 백엔드 mode.profiles JSON (S7 applyMode)
  const [modeProfiles, setModeProfiles] = useState<Record<string, ModeProfile>>({});
  const [modeSel, setModeSel] = useState("");   // 현재 적용된 모드(viewer.prefs.mode_key) — 콤보에 표시
  const [modeJson, setModeJson] = useState("");
  // UBPACS-Z Worklist 구성요소 표시/숨김 (Study List 제외 추가·삭제)
  const [wlPanels, setWlPanels] = useState<Record<string, boolean>>({
    orders: true, prior: true, compare: true, thumb: true, std: true, comment: true, report: true,
  });
  // 행잉 프로토콜(HP) 규칙 + 툴바 구성 + W/L 프리셋 (계정 로밍)
  const [hpRules, setHpRules] = useState<HpRule[]>([]);
  const [tbConfig, setTbConfig] = useState<Record<string, boolean>>({});
  const [wlPresets, setWlPresets] = useState<WlPreset[]>(DEFAULT_WL_PRESETS);
  // 판독(Reading) — 내 서명 정보(확정 시 리포트에 기록)
  const [profName, setProfName] = useState("");
  const [profLicense, setProfLicense] = useState("");
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
      const v = r.value as {
        auto_refresh_sec?: number; default_status?: string; columns?: string[];
        find_fields?: string[]; dbl_action?: "viewer2d" | "ohif";
      };
      if (v.auto_refresh_sec !== undefined) setRefreshSec(v.auto_refresh_sec);
      setDefaultStatus(v.default_status ?? "");
      if (v.columns?.length) setColumns(v.columns.filter((c) => COLUMN_DEFS[c]));
      if (v.find_fields?.length) setFindFields(v.find_fields.filter((c) => FIND_FIELDS[c]));
      if (v.dbl_action) setDblAction(v.dbl_action);
      const pn = (v as { panels?: Record<string, boolean> }).panels;
      if (pn) setWlPanels((prev) => ({ ...prev, ...pn }));
      const nl = (v as { nav_left?: "past" | "recent" }).nav_left;
      if (nl) setPolNavLeft(nl);
    }).catch(() => {});
    api.getSetting("viewer.prefs").then((r) => {
      const v = r.value as {
        hanging?: Record<string, string>; hanging2d?: Record<string, string>;
        paletteSide?: "left" | "top" | "right" | "bottom"; thumbSide?: "left" | "bottom" | "right" | "top";
        thumbSize?: number; thumbMode?: "series" | "all"; reportDock?: boolean;
      };
      const h = v.hanging ?? {};
      setHangingCT(h.CT ?? "default");
      setHangingMR(h.MR ?? "default");
      const cv = (v as { client_viewer?: string }).client_viewer;
      if (cv && CLIENT_VIEWERS.some((x) => x.id === cv)) setClientViewer(cv);
      const mk = (v as { mode_key?: string }).mode_key;
      if (mk) setModeSel(mk);
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
      if (iv.infi_default_layout) {
        const toStr = (l?: { r: number; c: number } | null) => (l ? `${l.r} x ${l.c}` : "");
        setDefLay(Object.fromEntries(Object.entries(iv.infi_default_layout)
          .map(([k, cfg]) => [k, { s: toStr(cfg.s), i: toStr(cfg.i) }])));
      }
      if (v.paletteSide) setPaletteSide(v.paletteSide);
      if (v.thumbSide) setThumbSide(v.thumbSide);
      if (v.thumbSize) setThumbSize(v.thumbSize);
      if (v.thumbMode) setThumbMode(v.thumbMode);
      if (v.hanging2d?.CT) setH2dCT(v.hanging2d.CT);
      if (v.hanging2d?.MR) setH2dMR(v.hanging2d.MR);
      if (v.reportDock !== undefined) setReportDock(v.reportDock);
      const tb = (v as { toolbar?: Record<string, boolean> }).toolbar;
      if (tb) setTbConfig(tb);
      const wp = (v as { wl_presets?: WlPreset[] }).wl_presets;
      if (wp?.length) setWlPresets(wp);
      const cm = (v as { close_mode?: "ask" | "save_current" | "save_all" | "discard" }).close_mode;
      if (cm) setCloseMode(cm);
      const mon = (v as { monitor?: { screens?: number[]; worklist?: number | null; report?: number | null; max_open?: number; close_scope?: "all" | "current"; tab_binding?: Record<number, string>; modality_map?: { modality: string; monitor: number }[] } }).monitor;
      if (mon?.screens) setMonitorSel(mon.screens);
      if (mon?.worklist !== undefined) setWlMon(mon.worklist);
      if (mon?.report !== undefined) setRptMon(mon.report);
      if (mon?.max_open != null) setMaxOpen(Number(mon.max_open) || 0);
      if (mon?.close_scope === "all" || mon?.close_scope === "current") setCloseScope(mon.close_scope);
      if (mon?.tab_binding) setTabBinding(mon.tab_binding);
      if (Array.isArray(mon?.modality_map)) setModalityMap(mon.modality_map);
      const tc = v as { ty_tool_cols?: number };
      if (tc.ty_tool_cols) setTyToolCols(tc.ty_tool_cols);
      const sc = (v as { shortcuts?: { rdrag?: "wl" | "zoom" | "pan"; shift_rclick?: "zoomout" | "none" } }).shortcuts;
      if (sc?.rdrag) setScRdrag(sc.rdrag);
      if (sc?.shift_rclick) setScShiftR(sc.shift_rclick);
      const kk = (sc as { keys?: Record<string, string> } | undefined)?.keys;
      if (kk) setScKeys({ ...SC_DEFAULTS, ...kk });
      setDropMenu(!!(v as { drop_menu?: boolean }).drop_menu);
    }).catch(() => {});
    api.getSetting("viewer.hp").then((r) => {
      setHpRules(((r.value as { rules?: HpRule[] }).rules) ?? []);
    }).catch(() => {});
    api.getSetting("report.prefs").then((r) => {
      const v = r.value as { ai_panel?: boolean; auto_apply?: boolean } & Record<string, unknown>;
      if (v.ai_panel !== undefined) setRptAiPanel(v.ai_panel);
      if (v.auto_apply !== undefined) setRptAutoApply(v.auto_apply);
      setRdOpts((prev) => ({ ...prev, ...v }));
    }).catch(() => {});
    api.getSetting("mode.profiles").then((r) => {
      const v = r.value as { profiles?: Record<string, ModeProfile> };
      setModeProfiles(v.profiles ?? {});
      setModeJson(JSON.stringify(r.value, null, 2));
    }).catch(() => {});
    loadTabs().then(setWlTabs).catch(() => {});
    loadTree().then(setWlTree).catch(() => {});
    api.profile().then((p) => { setProfName(p.display_name); setProfLicense(p.license_no); }).catch(() => {});
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

  const save = async () => {
    // 병합 저장 — 드래그 panel_order 등 다른 키를 덮어쓰지 않도록 현재 서버 값과 합친다
    const cur = (await api.getSetting("worklist.prefs").catch(() => ({ value: {} }))).value;
    await api.putSetting("worklist.prefs",
      { ...cur, auto_refresh_sec: refreshSec, default_status: defaultStatus, columns,
        by_viewer: wlBy,
        find_fields: findFields, dbl_action: dblAction, panels: wlPanels, nav_left: polNavLeft }, "user");
    const curV = (await api.getSetting("viewer.prefs").catch(() => ({ value: {} }))).value;
    await api.putSetting("viewer.prefs", {
      ...curV,
      hanging: { CT: hangingCT, MR: hangingMR },
      hanging2d: { CT: h2dCT, MR: h2dMR },
      client_viewer: clientViewer,
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
                 tab_binding: tabBinding, modality_map: modalityMap },
      shortcuts: { rdrag: scRdrag, shift_rclick: scShiftR, keys: scKeys },
      drop_menu: dropMenu,
    }, "user");
    await api.putSetting("report.prefs",
      { ...rdOpts, ai_panel: rptAiPanel, auto_apply: rptAutoApply }, "user");
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
    setSaved("저장됨 — 왼쪽 ⟳ Refresh를 누르면 즉시 적용·확인됩니다");
    setTimeout(() => setSaved(""), 2500);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "grid", placeItems: "center", zIndex: 100 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
      {/* 설정 창 왼쪽 Refresh — 저장 후 전체 새로고침으로 적용값을 즉시 확인 */}
      <button title="모든 설정을 저장하고 화면을 새로고침 — 적용된 값을 바로 확인합니다"
              onClick={async () => { await save(); window.location.reload(); }}
              style={{
                display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                padding: "14px 10px", fontSize: 12, borderRadius: 8, cursor: "pointer",
                background: "var(--accent)", color: "#fff", border: "1px solid var(--accent)",
              }}>
        <span style={{ fontSize: 20, lineHeight: 1 }}>⟳</span>
        <span>Refresh</span>
        <span style={{ fontSize: 10.5, opacity: 0.85 }}>저장+적용</span>
      </button>
      <div style={{
        background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8,
        display: "flex", flexDirection: "column", overflow: "hidden",
        ...(maxed
          ? { width: "98vw", height: "95vh" }
          : { width: "min(860px, 96vw)", height: "min(580px, 92vh)",
              // 우하단 핸들 드래그로 좌우·상하 크기 자유 조절(네이티브 resize)
              resize: "both" as const, minWidth: 640, minHeight: 420, maxWidth: "98vw", maxHeight: "95vh" }),
      }}>
        <div style={{ padding: "9px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", background: "var(--bg-elevated)" }}>
          <b>{SCOPE_TITLE[scope]}</b>
          <span style={{ marginLeft: 8, fontSize: 11.5, color: "var(--text-secondary)" }}>
            {scope === "system" ? "서버 운영" : scope === "hospital" ? "병원별 배치 구성" : "사용자·판독 환경"}
          </span>
          <button style={{ marginLeft: "auto", marginRight: 6 }} title={maxed ? "기본 크기로 복원" : "전체 화면으로 크게 보기"}
                  onClick={() => setMaxed((m) => !m)}>{maxed ? "❐ 복원" : "⬜ 최대화"}</button>
          <button onClick={onClose}>닫기</button>
        </div>
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
                  <FolderIcon /> {t.label}
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
                    <span style={{ opacity: 0.6 }}>└</span> {c.label}
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
                이 설정에 접근할 권한이 없습니다.
              </div>
            )}
            {page === "viewer" && (
              <>
                <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                  뷰어 선택·모드·OHIF 등 <b>공통 설정</b>입니다. 표시·아이콘·사용 패턴은 좌측
                  [뷰어 — TY Viewer]/[뷰어 — In Viewer] 탭에서 뷰어별로 설정하며, 기능은 두 뷰어 동일합니다.
                </div>
                <Group title="영상 파이프라인">
                  <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}>
                    <input type="checkbox" checked={wasmPipe} onChange={(e) => setWasmPipe(e.target.checked)} />
                    WASM 디코딩 파이프라인 (베타) — 원본 픽셀(WADO-RS bulkdata)을 브라우저에서 직접 디코딩
                  </label>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    켜면 2D 뷰어가 서버 렌더링(JPEG) 대신 원본 16bit 프레임을 받아 WASM 코덱으로 디코딩합니다.
                    W/L 조정이 서버 왕복 없이 즉시 반영되고, 병원 설정의 전송구문(JPEG2000/JPEG-LS)으로 수신합니다.
                    디코딩 전에는 서버 렌더링으로 표시(자동 폴백).
                  </div>
                </Group>
                {/* 제품 모드 프로파일 + 선택 뷰어 — 같은 높이 좌/우 배치(좁으면 줄바꿈) */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-start" }}>
                <Group title="제품 모드 프로파일 (05 Mode Profile — 서버 JSON)" style={{ flex: "1 1 360px", minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
                    <select id="sv-mode" value={modeSel} onChange={(e) => setModeSel(e.target.value)}>
                      <option value="" disabled>모드 선택…</option>
                      {Object.entries(modeProfiles).map(([k, p]) => (
                        <option key={k} value={k}>{p.label ?? k}{k === modeSel ? " ✓ (현재 적용)" : ""}</option>
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
                      setSaved(`'${prof.label ?? m}' 모드 적용 — 왼쪽 ⟳ Refresh로 즉시 확인`);
                    }}>적용</button>
                    {isAdmin && (
                      <button title="현재 워크리스트·뷰어 레이아웃(컬럼·검색필드·팔레트/썸네일 배치·선택 뷰어)을 선택한 프로파일에 저장 (전역)"
                              onClick={async () => {
                        const m = modeSel;
                        const prof = modeProfiles[m];
                        if (!prof) { alert("저장할 프로파일을 먼저 선택하세요"); return; }
                        if (!confirm(`현재 화면 구성을 '${prof.label ?? m}' 프로파일에 저장할까요? (전역 — 모든 사용자에게 적용)`)) return;
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
                        setSaved(`현재 화면 구성을 '${prof.label ?? m}' 프로파일에 저장했습니다 (전역)`);
                      }}>현재 화면을 프로파일에 저장</button>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    Core 기능은 동일, 화면 구성(컬럼·검색필드·팔레트/썸네일 배치·더블클릭·선택 뷰어)만 제품별 프로파일로 전환 — 타 PACS 사용 경험 그대로 이전.
                    프로파일 정의는 서버 전역 설정(mode.profiles)에서 로드. <b>I-View</b>=INFINITT 스타일 레이아웃 저장소 · <b>T-View</b>=자체 뷰어 레이아웃.
                  </div>
                  {isAdmin && (
                    <details>
                      <summary style={{ fontSize: 11.5, cursor: "pointer", color: "var(--text-secondary)" }}>
                        프로파일 JSON 편집 (관리자 — 전역 적용)
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
                            setSaved("모드 프로파일 JSON 저장됨 (전역)");
                          } catch (e) {
                            alert(e instanceof Error ? `JSON 오류: ${e.message}` : "저장 실패");
                          }
                        }}>JSON 저장</button>
                      </div>
                    </details>
                  )}
                </Group>
                <Group title="선택 뷰어 (Client Viewer)" style={{ flex: "1 1 300px", minWidth: 0 }}>
                  <Row label="사용할 뷰어">
                    <select value={clientViewer} onChange={(e) => setClientViewer(e.target.value)}>
                      {CLIENT_VIEWERS.map((v) => (
                        <option key={v.id} value={v.id} disabled={!v.available}>
                          {v.label}{v.available ? "" : " (개발 중)"}
                        </option>
                      ))}
                    </select>
                    <span style={{ fontSize: 11.5, color: "var(--text-secondary)", marginLeft: 8 }}>
                      {CLIENT_VIEWERS.find((v) => v.id === clientViewer)?.desc}
                    </span>
                  </Row>
                </Group>
                </div>
              </>
            )}
            {page === "env" && (
              <>
                <Group title="워크리스트 동작">
                  <Row label="자동 갱신">
                    <select value={refreshSec} onChange={(e) => setRefreshSec(Number(e.target.value))}>
                      <option value={0}>끔</option><option value={5}>5초</option>
                      <option value={10}>10초</option><option value={30}>30초</option>
                    </select>
                  </Row>
                  <Row label="기본 상태 필터">
                    <select value={defaultStatus} onChange={(e) => setDefaultStatus(e.target.value)}>
                      <option value="">전체</option><option value="unread">미판독(확정 전)</option>
                      <option value="draft_ready">AI초안</option>
                      <option value="reading">판독중</option><option value="received">도착</option>
                    </select>
                  </Row>
                  <Row label="단축키">
                    <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                      워크리스트: Enter=View&Draft · B=일괄검토 · E=Emergency │
                      뷰어: ←→ 이미지 · I 반전 · R 회전 · F Fit · L Link · 1/2/4 분할 · Space Cine · Esc 닫기
                    </span>
                  </Row>
                  <Row label="더블클릭 동작">
                    <select value={dblAction} onChange={(e) => setDblAction(e.target.value as "viewer2d" | "ohif")}>
                      <option value="viewer2d">자체 뷰어 (View&Draft)</option>
                      <option value="ohif">OHIF 뷰어</option>
                    </select>
                  </Row>
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
                <Group title="로컬 구성">
                  <Row label="API 서버"><code style={{ fontSize: 12 }}>http://localhost:8000</code></Row>
                  <Row label="OHIF 뷰어"><code style={{ fontSize: 12 }}>http://localhost:3000</code></Row>
                </Group>
                <Group title="DICOM 서버 (Orthanc)" right={<button onClick={testOrthanc}>연결 테스트</button>}>
                  {orthanc === null ? (
                    <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>확인 중…</div>
                  ) : orthanc.alive ? (
                    <table className="grid-table">
                      <tbody>
                        <tr><th style={{ width: 110 }}>상태</th><td style={{ color: "var(--stat-final)" }}>● 연결됨</td></tr>
                        <tr><th>AE Title</th><td>{orthanc.aet}</td></tr>
                        <tr><th>DICOM 포트</th><td>{orthanc.dicom_port} (C-STORE 수신)</td></tr>
                        <tr><th>버전</th><td>Orthanc {orthanc.version}</td></tr>
                        <tr><th>저장 검사</th><td>{orthanc.studies_count}건</td></tr>
                      </tbody>
                    </table>
                  ) : (
                    <div style={{ color: "var(--stat-emergency)", fontSize: 12.5 }}>
                      ● 연결 실패 — {orthanc.url} {orthanc.error ?? ""}
                    </div>
                  )}
                </Group>
                <Group title="SCP/SCU 장비 노드 (AE Title · IP · Port)" right={
                  isAdmin && (
                    <span style={{ display: "flex", gap: 4 }}>
                      <button style={{ padding: "1px 8px", fontSize: 11 }}
                              onClick={() => setNodes((p) => [...p, { name: `NODE${p.length + 1}`, role: "scu", ae_title: "", ip: "", port: 104 }])}>
                        ＋ 추가
                      </button>
                      <button style={{ padding: "1px 8px", fontSize: 11 }} onClick={async () => {
                        try {
                          await api.putSetting("dicom.nodes", { items: nodes }, "global");
                          setNodeMsg("저장됨");
                        } catch (e) { setNodeMsg(e instanceof Error ? e.message : "저장 실패"); }
                      }}>저장</button>
                      <button style={{ padding: "1px 8px", fontSize: 11 }}
                              title="저장된 노드를 Orthanc DicomModalities로 등록 — C-STORE/C-FIND 대상"
                              onClick={async () => {
                                try {
                                  const r = await api.applyDicomNodes();
                                  setNodeMsg(`Orthanc 반영 ${r.applied}건${r.errors.length ? ` · 오류: ${r.errors.join(", ")}` : ""}`);
                                } catch (e) { setNodeMsg(e instanceof Error ? e.message : "반영 실패"); }
                              }}>Orthanc 반영</button>
                    </span>
                  )
                }>
                  <table className="grid-table">
                    <thead><tr><th>이름</th><th style={{ width: 80 }}>역할</th><th>AE Title</th><th>IP</th><th style={{ width: 70 }}>Port</th><th style={{ width: 30 }}></th></tr></thead>
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
                                  <option value="scu">SCU</option><option value="scp">SCP</option><option value="both">양방향</option>
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
                          등록된 장비 없음 {isAdmin && "— ＋추가로 등록 후 저장 → Orthanc 반영"}
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)", display: "flex", gap: 8 }}>
                    SCU=우리가 전송(C-STORE 대상), SCP=수신 노드. MWL 응답은 Orthanc(SAINTVIEW:4242)가 담당.
                    {nodeMsg && <b style={{ color: "var(--stat-final)" }}>{nodeMsg}</b>}
                  </div>
                </Group>
              </>
            )}

            {page === "servernet" && (
              <>
                <Group title="로컬 서버 — 폴더 공유">
                  <Row label="공유 디렉토리">
                    <input value={snDir} onChange={(e) => setSnDir(e.target.value)} disabled={!isAdmin}
                           placeholder="C:\PACS\share" style={{ width: 320 }} />
                    {isAdmin && (
                      <button onClick={() => setFsPickerOpen(true)}
                              title="서버 PC의 폴더를 직접 탐색해 선택합니다 (드라이브→하위 폴더)"
                              style={{ padding: "2px 10px", fontSize: 12, display: "flex",
                                       alignItems: "center", gap: 5 }}>
                        <FolderIcon size={13} /> 폴더 찾기
                      </button>
                    )}
                    {snDirExists !== null && (
                      <span style={{
                        fontSize: 10.5, fontWeight: 700, padding: "1px 8px", borderRadius: 9,
                        color: "#fff", flexShrink: 0,
                        background: snDirExists ? "#16a34a" : "#d97706",
                      }}>
                        {snDirExists ? "존재함" : "경로 없음"}
                      </span>
                    )}
                  </Row>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    워크리스트 우측 [Local Server] 버튼에서 이 폴더의 파일 목록·다운로드가 제공됩니다 (서버 PC 기준 경로).
                  </div>
                </Group>
                {fsPickerOpen && (
                  <FolderPickerModal
                    initial={snDir.trim()}
                    onPick={(p) => { setSnDir(p); setFsPickerOpen(false); }}
                    onClose={() => setFsPickerOpen(false)} />
                )}
                <Group title="웹 서버">
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <Row label="IP 주소">
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
                             title="DICOM C-ECHO/C-STORE 등 DIMSE 통신 포트 — 웹(HTTP) 포트와 다릅니다 (병원 컨테이너는 4301 등)"
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
                          setSnMsg("서버 네트워크 설정 저장됨 (전역)");
                        } catch (e) { setSnMsg(e instanceof Error ? e.message : "저장 실패"); }
                      }}>서버 설정 저장</button>
                    </div>
                  )}
                </Group>
                <Group title="연결 테스트 (Ping · DICOM Echo · DB)">
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button onClick={async () => {
                      if (!snWeb.ip) { setSnMsg("IP를 먼저 입력하세요"); return; }
                      setSnMsg("Ping 테스트 중…");
                      try {
                        const r = await api.netPing(snWeb.ip, Number(snWeb.port) || undefined);
                        setSnMsg(`Ping: ${r.icmp ? `OK (${r.icmp_ms}ms)` : "실패"}${r.tcp !== null ? ` · TCP ${snWeb.port}: ${r.tcp ? "OK" : "실패"}` : ""}`);
                      } catch (e) { setSnMsg(e instanceof Error ? e.message : "Ping 실패"); }
                    }}>Ping 테스트</button>
                    <button onClick={async () => {
                      // Echo 는 DICOM Port 로 — 웹(HTTP) 포트에 시도하면 연관 수립이 항상 실패한다
                      const dport = Number(snWeb.dicom_port) || Number(snWeb.port);
                      if (!snWeb.ip || !dport) { setSnMsg("IP/DICOM Port를 먼저 입력하세요"); return; }
                      setSnMsg(`DICOM C-ECHO 테스트 중… (:${dport})`);
                      try {
                        const r = await api.netEcho(snWeb.ip, dport, snWeb.ae_title);
                        setSnMsg(`DICOM Echo(:${dport}): ${r.ok ? "✅ " : "❌ "}${r.detail}${!r.ok && !snWeb.dicom_port ? " — 웹 포트로 시도했다면 DICOM Port 를 입력하세요" : ""}`);
                      } catch (e) { setSnMsg(e instanceof Error ? e.message : "Echo 실패"); }
                    }}>DICOM Echo Test</button>
                    <button onClick={async () => {
                      setSnMsg("DB 연동 테스트 중…");
                      try {
                        const r = await api.netDb();
                        setSnMsg(r.ok
                          ? `DB: ✅ ${r.dialect} (${r.latency_ms}ms) — ${r.target}`
                          : `DB: ❌ ${r.detail}`);
                      } catch (e) { setSnMsg(e instanceof Error ? e.message : "DB 테스트 실패"); }
                    }}>DB 연동 Test</button>
                  </div>
                  {snMsg && <div style={{ fontSize: 12.5, color: snMsg.includes("❌") || snMsg.includes("실패") ? "var(--stat-emergency)" : "var(--stat-final)" }}>{snMsg}</div>}
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    테스트는 관리자 권한으로 백엔드 서버에서 수행됩니다 (Echo=AE Title 검증 포함, DB=현재 연결 엔진 SELECT 1).
                  </div>
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
                      {label}
                    </div>
                  ))}
                </div>

                {rdTab === "basic" && (
                  <>
                    <Group title="판독의 등록 — 확정 서명에 기록">
                      <Row label="이름(표시명)">
                        <input value={profName} onChange={(e) => setProfName(e.target.value)}
                               placeholder="홍길동" style={{ width: 220 }} />
                      </Row>
                      <Row label="면허번호">
                        <input value={profLicense} onChange={(e) => setProfLicense(e.target.value)}
                               placeholder="12345" style={{ width: 220 }} />
                      </Row>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <button className="primary" onClick={async () => {
                          await api.putProfile(profName, profLicense);
                          setSaved("판독의 정보 저장됨 — 이후 확정(서명)부터 적용");
                        }}>판독의 정보 저장</button>
                      </div>
                    </Group>
                    <Group title="레포트 옵션">
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
                          {label}
                        </label>
                      ))}
                      <Row label="상용구 백업 주기">
                        <input type="number" min={0} max={1440} style={{ width: 70 }}
                               value={Number(rdOpts.phrase_backup_min ?? 10)}
                               onChange={(e) => setRdOpts((p) => ({ ...p, phrase_backup_min: Number(e.target.value) }))} />
                        <span style={{ fontSize: 11.5, color: "var(--text-secondary)", marginLeft: 6 }}>
                          분 — 판독창의 내 단축키·템플릿(계정 로컬)을 주기적으로 서버에 백업 (0=끄기)
                        </span>
                      </Row>
                      <Row label="사이드바 기본 탭">
                        <select value={String(rdOpts.sidebar_tab ?? "history")}
                                onChange={(e) => setRdOpts((p) => ({ ...p, sidebar_tab: e.target.value }))}>
                          <option value="history">판독 이력</option>
                          <option value="read">판독</option>
                        </select>
                      </Row>
                      <Row label="단축키 패널 기본 탭">
                        <select value={String(rdOpts.panel_tab ?? "shortcut")}
                                onChange={(e) => setRdOpts((p) => ({ ...p, panel_tab: e.target.value }))}>
                          <option value="shortcut">단축키</option>
                          <option value="template">템플릿</option>
                        </select>
                      </Row>
                      <Row label="텍스트 삽입 위치">
                        <select value={String(rdOpts.insert_pos ?? "end")}
                                onChange={(e) => setRdOpts((p) => ({ ...p, insert_pos: e.target.value }))}>
                          <option value="end">맨 끝에 삽입</option>
                          <option value="cursor">커서 위치에 삽입</option>
                        </select>
                      </Row>
                    </Group>
                    <Group title="시스템 단축키" right={
                      <button style={{ padding: "1px 8px", fontSize: 11 }}
                              onClick={() => setRdOpts((p) => ({ ...p, key_save: "Ctrl+S", key_approve: "Ctrl+Shift+A", key_mic: "Ctrl+M" }))}>
                        기본값으로 초기화
                      </button>
                    }>
                      <Row label="리포트 저장">
                        <KeyCaptureInput value={String(rdOpts.key_save ?? "Ctrl+S")}
                                         onChange={(v) => setRdOpts((p) => ({ ...p, key_save: v }))} />
                      </Row>
                      <Row label="리포트 승인">
                        <KeyCaptureInput value={String(rdOpts.key_approve ?? "Ctrl+Shift+A")}
                                         onChange={(v) => setRdOpts((p) => ({ ...p, key_approve: v }))} />
                      </Row>
                      <Row label="음성 판독 (STT) 토글">
                        <KeyCaptureInput value={String(rdOpts.key_mic ?? "Ctrl+M")}
                                         onChange={(v) => setRdOpts((p) => ({ ...p, key_mic: v }))} />
                      </Row>
                      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                        옵션·단축키는 OK(저장) 시 계정에 저장(로밍) — 뷰어 판독 창에 즉시 적용됩니다.
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
              const vk = page === "wlSaint" ? "sv" : page === "wlTy" ? "ty" : "infi";
              const vLabel = page === "wlSaint" ? "SaintView" : page === "wlTy" ? "T-View" : "I-View";
              const ov = wlBy[vk as "sv" | "ty" | "infi"];
              return (
                <Group title={vLabel + " 워크리스트 — 뷰어별 그리드 컬럼 (계정별 저장)"}>
                  <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, marginBottom: 8 }}>
                    <input type="checkbox" checked={!ov}
                           onChange={(e) => setWlBy((p) => ({ ...p, [vk]: e.target.checked ? null : [...columns] }))} />
                    공통 워크리스트 설정 사용 (기본) — 해제하면 이 뷰어 전용 컬럼 구성을 편집합니다
                  </label>
                  {ov && (
                    <FilterSettingList
                      all={Object.keys(COLUMN_DEFS)}
                      selected={ov}
                      labelOf={(k) => COLUMN_DEFS[k].label}
                      onChange={(cols) => setWlBy((p) => ({ ...p, [vk]: cols }))}
                    />
                  )}
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    {vLabel} 모드로 워크리스트를 열면 이 구성이 공통 설정 대신 적용됩니다. OK(저장) 시 반영.
                  </div>
                </Group>
              );
            })()}
            {page === "worklist" && (
              <>
                <Group title="그리드 컬럼 구성 — Filter Setting (USE/NO USE, UBPACS형)">
                  <FilterSettingList
                    all={Object.keys(COLUMN_DEFS)}
                    selected={columns}
                    labelOf={(k) => COLUMN_DEFS[k].label}
                    onChange={setColumns}
                  />
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    USE/NO USE 클릭으로 토글, ▲▼로 표시 순서 변경 — OK(저장) 시 적용.
                  </div>
                </Group>
                <Group title="검색 필드 구성 (Find criteria)">
                  <DualList
                    all={Object.keys(FIND_FIELDS)}
                    selected={findFields}
                    labelOf={(k) => FIND_FIELDS[k]}
                    onChange={setFindFields}
                  />
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    컬럼·검색필드 구성은 서버 저장(로밍) — 어느 PC에서 로그인해도 동일 적용.
                  </div>
                </Group>
                <Group title="상용구 관리 (DB — Modality×부위 분류 + Alt+단축키)" right={
                  <button style={{ padding: "1px 8px", fontSize: 11 }} onClick={() => setPhraseModal("new")}>＋ 추가</button>
                }>
                  <table className="grid-table">
                    <thead><tr><th style={{ width: 90 }}>분류</th><th>NAME</th><th style={{ width: 56 }}>단축키</th><th style={{ width: 76 }}></th></tr></thead>
                    <tbody>
                      {phrases.map((p) => (
                        <tr key={p.id}>
                          <td>{p.category}</td>
                          <td title={p.text}>{p.name}</td>
                          <td style={{ color: "var(--accent)" }}>{p.shortcut && `Alt+${p.shortcut}`}</td>
                          <td style={{ whiteSpace: "nowrap" }}>
                            <button style={{ padding: "0 6px", fontSize: 11 }} onClick={() => setPhraseModal(p)}>✏</button>
                            <button style={{ padding: "0 6px", fontSize: 11 }} onClick={async () => {
                              if (!window.confirm(`상용구 '${p.name}'을 삭제할까요?`)) return;
                              await api.deletePhrase(p.id);
                              api.phrases().then((r) => setPhrases(r.items));
                            }}>✕</button>
                          </td>
                        </tr>
                      ))}
                      {phrases.length === 0 && (
                        <tr><td colSpan={4} style={{ color: "var(--text-secondary)" }}>등록된 상용구 없음 — ＋추가</td></tr>
                      )}
                    </tbody>
                  </table>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    워크리스트 상용구(Std) 패널과 동일 DB — 리포트에서 Alt+단축키로 즉시 삽입.
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
                <Group title="워크리스트 구성요소 (UBPACS-Z p.8 — Study List 제외 추가/삭제)">
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
                        {label}
                      </label>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    체크 해제 시 워크리스트에서 해당 창이 숨겨집니다. 배치 순서는 워크리스트에서 그립(⋮) 드래그로 변경.
                  </div>
                </Group>
                <Group title="워크리스트 페이지 탭 (UBPACS-Z — 최대 10)">
                  <table className="grid-table">
                    <thead><tr><th style={{ width: 130 }}>이름</th><th>검색 조건</th><th style={{ width: 118 }}></th></tr></thead>
                    <tbody>
                      {wlTabs.map((t, i) => (
                        <tr key={t.id}>
                          <td>{t.label}</td>
                          <td style={{ color: "var(--text-secondary)" }}>{folderSummary(t.filter)}</td>
                          <td style={{ whiteSpace: "nowrap" }}>
                            <button style={{ padding: "0 6px", fontSize: 11 }} title="이름·검색 조건 수정"
                                    onClick={() => setTabModal({ index: i })}>수정</button>
                            <button style={{ padding: "0 6px", fontSize: 11 }} disabled={i === 0} title="위로"
                                    onClick={() => {
                                      const next = [...wlTabs];
                                      [next[i - 1], next[i]] = [next[i], next[i - 1]];
                                      setWlTabs(next);
                                      saveTabs(next).then(() => setSaved("페이지 탭 저장됨")).catch(() => {});
                                    }}>▲</button>
                            <button style={{ padding: "0 6px", fontSize: 11 }} disabled={i === wlTabs.length - 1} title="아래로"
                                    onClick={() => {
                                      const next = [...wlTabs];
                                      [next[i], next[i + 1]] = [next[i + 1], next[i]];
                                      setWlTabs(next);
                                      saveTabs(next).then(() => setSaved("페이지 탭 저장됨")).catch(() => {});
                                    }}>▼</button>
                            <button style={{ padding: "0 6px", fontSize: 11 }} disabled={t.id === "default"} title="삭제"
                                    onClick={() => {
                                      if (!window.confirm(`'${t.label}' 페이지를 삭제할까요?`)) return;
                                      const next = wlTabs.filter((x) => x.id !== t.id);
                                      setWlTabs(next);
                                      saveTabs(next).then(() => setSaved("페이지 탭 저장됨")).catch(() => {});
                                    }}>✕</button>
                          </td>
                        </tr>
                      ))}
                      {wlTabs.length === 0 && (
                        <tr><td colSpan={3} style={{ color: "var(--text-secondary)" }}>페이지 없음</td></tr>
                      )}
                    </tbody>
                  </table>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <button onClick={() => setTabModal("add")} disabled={wlTabs.length >= 10}>＋ 페이지 추가</button>
                    <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                      워크리스트 상단 탭과 동일 데이터 — 탭 ＋ 버튼은 현재 검색조건을 스냅샷으로 등록.
                    </span>
                  </div>
                </Group>
                <Group title="검색 폴더 트리 (탐색기형 — 예: 응급실 › DR › Chest)">
                  <div style={{
                    height: 190, display: "flex", flexDirection: "column", padding: 4,
                    border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-canvas)",
                  }}>
                    <FolderTreeEditor nodes={wlTree} selectedId={selTreeId}
                                      onSelect={(n) => setSelTreeId(n.id)}
                                      onChange={(next) => {
                                        setWlTree(next);
                                        saveTree(next).then(() => setSaved("검색 폴더 저장됨")).catch(() => {});
                                      }} />
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    각 폴더는 자기 조건만 가지며, 워크리스트에서 폴더 클릭 시 <b>상위 경로 조건이 누적 병합</b>되어 검색됩니다.
                    변경은 즉시 서버 저장(로밍).
                  </div>
                </Group>
                {tabModal !== null && (
                  <FolderEditModal
                    title={tabModal === "add" ? "새 워크리스트 페이지"
                         : `페이지 수정 — ${wlTabs[tabModal.index]?.label ?? ""}`}
                    init={tabModal === "add" ? undefined
                        : { label: wlTabs[tabModal.index].label, filter: wlTabs[tabModal.index].filter }}
                    onSave={(label, filter) => {
                      let next: WorklistTab[];
                      if (tabModal === "add") {
                        if (wlTabs.length >= 10) { alert("워크리스트 페이지는 최대 10개입니다"); return; }
                        next = [...wlTabs, { id: newId(), label, filter }];
                      } else {
                        next = wlTabs.map((t, i) => (i === tabModal.index ? { ...t, label, filter } : t));
                      }
                      setWlTabs(next);
                      saveTabs(next).then(() => setSaved("페이지 탭 저장됨")).catch(() => {});
                      setTabModal(null);
                    }}
                    onClose={() => setTabModal(null)}
                  />
                )}
              </>
            )}

            {page === "report" && (
              <>
                <Group title="상용구 (Predefined Readings)">
                  <div style={{ fontSize: 12.5 }}>
                    등록된 상용구: <b>{phrases.length}건</b> (DB 테이블)
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                    등록·수정·삭제는 <b>워크리스트 탭의 상용구 관리</b> 또는 워크리스트 하단 상용구(Std) 패널에서.
                    더블클릭 또는 Alt+단축키로 Conclusion에 삽입됩니다.
                  </div>
                </Group>
                <Group title="리포트 구성 (Report Composition — UBPACS p.22)">
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
                    <input type="checkbox" checked={rptAiPanel} onChange={(e) => setRptAiPanel(e.target.checked)} />
                    AI Structured Report 패널 표시 (해제 시 Report 단독 — AI는 ↗ 별도 창으로만)
                  </label>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
                    <input type="checkbox" checked={rptAutoApply} onChange={(e) => setRptAutoApply(e.target.checked)} />
                    AI 초안을 Report에 자동 적용 (해제 시 빈 양식에서 시작 — [적용 ▶]로만 가져옴)
                  </label>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    리포트 패널: ◀▶ 이전/다음 환자 이동 · 이력 콤보(과거 버전 보기) · ↗ AI 별도 창(모니터) — 계정 로밍.
                  </div>
                </Group>
                <Group title="출력 형식">
                  <div style={{ fontSize: 12.5 }}>PDF · DICOM SR(확정 후 전송) · FHIR DiagnosticReport</div>
                </Group>
              </>
            )}

            {page === "viewer" && (
              <Group title="OHIF (고급 웹뷰어)">
                <Row label="OHIF 사용">
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
                    <input type="checkbox" checked={ohifOn}
                           onChange={(e) => setOhifOn(e.target.checked)} />
                    OHIF 아이콘 표시·동작 허용 (기본 꺼짐)
                  </label>
                </Row>
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  끄면 워크리스트(⌂ Adv·🌐·우클릭 메뉴)와 뷰어의 OHIF 버튼이 숨겨지고 동작하지 않습니다.
                  더블클릭 동작이 OHIF 로 설정돼 있어도 자체 뷰어로 열립니다.
                </div>
              </Group>
            )}
            {page === "viewer" && (
              <Group title="Tools 아이콘 크기 (TY · In 뷰어)">
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
                  두 뷰어의 도구 팔레트 아이콘 크기를 한 곳에서 조정합니다 (각 뷰어 전용 탭에서도 동일하게 조정 가능).
                  <b> OK(저장)</b> 후 열려 있는 뷰어를 새로고침하면 반영됩니다.
                </div>
              </Group>
            )}
            {page === "viewerIn" && (
              <>
              <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                <b>In Viewer 전용</b> — 표시·아이콘·사용 패턴 설정은 뷰어별로 적용되고, 판독·측정 등 기능은 두 뷰어 동일합니다.
              </div>
              <Group title="In Viewer 표시 (계정별 저장)">
                <Row label="툴 배열 (열)">
                  <select value={infToolCols} onChange={(e) => setInfToolCols(Number(e.target.value))}>
                    <option value={1}>1X1 (한 줄 1개)</option>
                    <option value={2}>2X2 (기본)</option>
                    <option value={3}>3X3</option>
                    <option value={4}>4X4</option>
                  </select>
                </Row>
                <Row label="멀티선택 색">
                  <input type="color" value={infSelColor}
                         onChange={(e) => setInfSelColor(e.target.value)}
                         title="Crosslink 멀티 선택 페인 테두리 색" />
                  <span style={{ fontSize: 11.5, color: "var(--text-secondary)", marginLeft: 8 }}>
                    Shift/Ctrl/A 로 선택된 페인 테두리 (기본 자주색)
                  </span>
                </Row>
                <Row label="오버레이 글자">
                  <input type="range" min={6} max={24} step={0.5} value={infOvlFont}
                         onChange={(e) => setInfOvlFont(Number(e.target.value))} /> {infOvlFont}px
                  <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12, marginLeft: 12 }}>
                    <input type="checkbox" checked={infOvlVisible}
                           onChange={(e) => setInfOvlVisible(e.target.checked)} />
                    표시
                  </label>
                </Row>
                <Row label="판독 도크">
                  <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12 }}>
                    <input type="checkbox" checked={infRptDock}
                           onChange={(e) => setInfRptDock(e.target.checked)} />
                    뷰어를 열 때 판독(Report) 도크를 기본으로 열기 — 도크 열림 상태를 계정에 기억
                  </label>
                </Row>
                <Row label="위치 인디케이터">
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
                    <input type="checkbox" checked={infScrollBar}
                           onChange={(e) => setInfScrollBar(e.target.checked)} />
                    페인 우측 이미지 위치 인디케이터(초록 바) 표시 — Scout line 과 무관한 현재 이미지 위치 표시(기본 꺼짐)
                  </label>
                </Row>
                <Row label="닫기 동작">
                  <select value={infCloseMode}
                          onChange={(e) => setInfCloseMode(e.target.value as typeof infCloseMode)}>
                    <option value="ask">항상 묻기 (닫기 다이얼로그)</option>
                    <option value="save_current">현재 저장하고 닫기 (주석)</option>
                    <option value="save_all">전체 저장하고 닫기 (주석+GSPS)</option>
                    <option value="none">저장하지 않고 닫기</option>
                  </select>
                  <span style={{ fontSize: 11.5, color: "var(--text-secondary)", marginLeft: 8 }}>
                    닫기 다이얼로그의 "기본으로" 체크 시 이 설정이 자동 변경됩니다 (viewer.prefs.infi_close_mode)
                  </span>
                </Row>
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  단축키(뷰어): <b>T + 마우스 스크롤</b> = 글자 크기 조절 · <b>T + Del</b> = 숨김/표시 토글 — 변경 즉시 계정에 저장됩니다.
                </div>
              </Group>
              </>
            )}
            {page === "viewerIn" && (
              <Group title="Modality 기본 레이아웃 (In Viewer — 행잉과 별도)">
                {["CT", "MR", "CR", "DX", "US", "XA", "*"].map((m) => (
                  <Row key={m} label={m === "*" ? "기타(전체)" : m}>
                    <span style={{ fontSize: 12 }}>Series</span>
                    <select value={defLay[m]?.s ?? ""} style={{ fontSize: 12 }}
                            onChange={(e) => setDefLay((p) => ({ ...p, [m]: { s: e.target.value, i: p[m]?.i ?? "" } }))}>
                      <option value="">자동</option>
                      {IN_LAYOUTS.map((l) => <option key={`${l.r}x${l.c}`}>{`${l.r} x ${l.c}`}</option>)}
                    </select>
                    <span style={{ fontSize: 12, marginLeft: 8 }}>Image</span>
                    <select value={defLay[m]?.i ?? ""} style={{ fontSize: 12 }}
                            onChange={(e) => setDefLay((p) => ({ ...p, [m]: { s: p[m]?.s ?? "", i: e.target.value } }))}>
                      <option value="">자동</option>
                      {IN_LAYOUTS.map((l) => <option key={`${l.r}x${l.c}`}>{`${l.r} x ${l.c}`}</option>)}
                    </select>
                  </Row>
                ))}
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  검사를 열 때 해당 Modality 의 Series(페인)/Image(타일) 분할이 자동 적용됩니다.
                  '자동' = 기존 규칙(CT/MR 다층 3x3). 행잉 프로토콜(F-18)과는 별개 설정입니다.
                </div>
              </Group>
            )}
            {page === "viewerIn" && (
              <Group title="툴 팔레트 표시 (In Viewer)">
                <Row label="열 수">
                  <select value={infToolCols} onChange={(e) => setInfToolCols(Number(e.target.value))}>
                    <option value={1}>1열</option><option value={2}>2열</option><option value={3}>3열</option>
                  </select>
                  <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12, marginLeft: 14 }}>
                    <input type="checkbox" checked={infToolLabels}
                           onChange={(e) => setInfToolLabels(e.target.checked)} />
                    아이콘 아래 이름 표시
                  </label>
                </Row>
                <Row label="아이콘 크기">
                  <input type="range" min={13} max={64} step={1} value={infToolSize}
                         onChange={(e) => setInfToolSize(Number(e.target.value))} />
                  <input type="number" min={13} max={64} value={infToolSize} style={{ width: 52, marginLeft: 6 }}
                         onChange={(e) => setInfToolSize(Math.min(64, Math.max(13, Number(e.target.value) || 34)))} />
                  <span style={{ fontSize: 12, marginLeft: 4 }}>px</span>
                </Row>
                <Row label="시네 기본 간격">
                  <input type="number" min={0.1} max={10} step={0.1} value={infCineSec}
                         onChange={(e) => setInfCineSec(Math.min(10, Math.max(0.1, Number(e.target.value) || 0.5)))}
                         style={{ width: 70 }} />
                  <span style={{ fontSize: 11.5, color: "var(--text-secondary)", marginLeft: 6 }}>
                    초 — Play(▶) 자동 넘김의 초기 간격. 뷰어에서 페인별로 개별 조정 가능
                  </span>
                </Row>
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  팔레트는 기능별 구획(영상 조정 · 측정 · 주석 · 셔터 · 선택·연동 · 기타)으로 표시됩니다.
                </div>
              </Group>
            )}
            {page === "viewerIn" && (
              <>
              <Group title="툴바 사용자화 (In Viewer — 표시할 툴 선택)">
                <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--border)",
                              borderRadius: 4, padding: 6 }}>
                  {IN_PALETTE.map((t) => (
                    <label key={t.id}
                           style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12,
                                    padding: "2px 4px", opacity: t.impl ? 1 : 0.55 }}>
                      <input type="checkbox" checked={infTb[t.id] !== false}
                             onChange={(e) => setInfTb((p) => ({ ...p, [t.id]: e.target.checked }))} />
                      <span style={{ width: 22, textAlign: "center", flexShrink: 0 }}>{t.icon}</span>
                      <span style={{ color: "var(--text-secondary)" }}>{t.label}</span>
                    </label>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  체크 해제한 툴은 뷰어 팔레트에서 숨겨집니다. 흐린 항목은 개발 예정 툴입니다.
                </div>
              </Group>
              <Group title="사용 패턴 · ★Quick 행 (In Viewer)">
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
                  <input type="checkbox" checked={infQuickRow}
                         onChange={(e) => setInfQuickRow(e.target.checked)} />
                  ★ Quick 행 표시 — 사용 상위 6개 툴을 팔레트 최상단에 (3회 미만 사용 시 비표시)
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
                  <input type="checkbox" checked={infUsageRec}
                         onChange={(e) => setInfUsageRec(e.target.checked)} />
                  사용 패턴 기록 — 툴 활성화 횟수 집계 (상위 50개, 계정 로밍)
                </label>
                <UsageTop usage={infUsage} labelOf={(id) => IN_TOOL_LABEL[id] ?? id}
                          onReset={() => {
                            setInfUsage({}); setInfUsageReset(true);
                            setSaved("In Viewer 사용 기록을 비웠습니다 — OK(저장) 시 반영");
                          }} />
              </Group>
              </>
            )}
            {page === "viewer" && (
              <Group title="행잉 프로토콜 (F-18)">
                {([["CT", hangingCT, setHangingCT], ["MR", hangingMR, setHangingMR]] as const).map(([m, v, set]) => (
                  <Row key={m} label={`${m} 기본 행잉`}>
                    <select value={v} onChange={(e) => set(e.target.value)}>
                      <option value="default">기본 (스택)</option>
                      <option value="mpr">MPR</option>
                    </select>
                  </Row>
                ))}
              </Group>
            )}
            {(page === "viewerTy" || page === "viewerSv") && (
              <>
                {page === "viewerSv" && (
                  <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                    <b>SaintView</b> — 상단 가로 메뉴(Image Tool·Measurement·Reading Support·Additional) 스킨.
                    엔진은 T-View 공유 — 아래 설정(아이콘·오버레이·시네·썸네일·판독창 등)이 동일하게 적용됩니다.
                  </div>
                )}
                <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                  <b>T-View 전용</b> — 표시·아이콘·사용 패턴 설정은 뷰어별로 적용되고, 판독·측정 등 기능은 세 뷰어 동일합니다.
                </div>
                <Group title="툴 아이콘·팔레트 (TY Viewer)">
                  <Row label="툴 배열 (열)">
                    <select value={tyToolCols} onChange={(e) => setTyToolCols(Number(e.target.value))}>
                      <option value={1}>1X1 (한 줄 1개)</option>
                      <option value={2}>2X2 (기본)</option>
                      <option value={3}>3X3</option>
                      <option value={4}>4X4</option>
                    </select>
                  </Row>
                  <Row label="아이콘 크기">
                    <input type="range" min={13} max={64} step={1} value={tyToolSize}
                           onChange={(e) => setTyToolSize(Number(e.target.value))} />
                    <input type="number" min={13} max={64} value={tyToolSize}
                           style={{ width: 56, marginLeft: 6 }}
                           onChange={(e) => setTyToolSize(Math.min(64, Math.max(13, Number(e.target.value) || 51)))} />
                    <span style={{ fontSize: 12, marginLeft: 4 }}>px</span>
                  </Row>
                  <Row label="라벨 표시">
                    <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12 }}>
                      <input type="checkbox" checked={tyToolLabels}
                             onChange={(e) => setTyToolLabels(e.target.checked)} />
                      아이콘 아래 이름 표시
                    </label>
                  </Row>
                  <Row label="3D 아이콘 효과">
                    <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12 }}>
                      <input type="checkbox" checked={tyIcon3d}
                             onChange={(e) => setTyIcon3d(e.target.checked)} />
                      입체(3D) 렌더 — 해제 시 플랫(평면) 아이콘
                    </label>
                  </Row>
                  <Row label="오버레이 글자">
                    <input type="range" min={6} max={24} step={0.5} value={tyOvlFont}
                           onChange={(e) => setTyOvlFont(Number(e.target.value))} /> {tyOvlFont}px
                  </Row>
                  <Row label="멀티선택 색">
                    <input type="color" value={tySelColor}
                           onChange={(e) => setTySelColor(e.target.value)}
                           title="멀티 선택·활성 페인 테두리 색 (viewer.prefs.ty_sel_color)" />
                    <span style={{ fontSize: 11.5, color: "var(--text-secondary)", marginLeft: 8 }}>
                      Shift/Ctrl 로 선택된 페인 테두리 2px · 활성 페인 1px (기본 자주색 #d946ef)
                    </span>
                  </Row>
                  <Row label="시네 기본 간격">
                    <input type="number" min={0.05} max={5} step={0.05} value={tyCineSec}
                           onChange={(e) => setTyCineSec(Math.min(5, Math.max(0.05, Number(e.target.value) || 0.15)))}
                           style={{ width: 70 }} />
                    <span style={{ fontSize: 11.5, color: "var(--text-secondary)", marginLeft: 6 }}>
                      초 — 시네(▶)·페인별 시네(▶p) 자동 넘김의 초기 간격. 뷰어에서 페인별로 개별 조정 가능
                    </span>
                  </Row>
                </Group>
                <Group title="사용 패턴 · ★Quick 행 (TY Viewer)">
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
                    <input type="checkbox" checked={tyQuickRow}
                           onChange={(e) => setTyQuickRow(e.target.checked)} />
                    ★ Quick 행 표시 — 사용 상위 6개 툴을 팔레트 최상단에 (3회 미만 사용 시 비표시)
                  </label>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
                    <input type="checkbox" checked={tyUsageRec}
                           onChange={(e) => setTyUsageRec(e.target.checked)} />
                    사용 패턴 기록 — 툴 활성화 횟수 집계 (상위 50개, 계정 로밍)
                  </label>
                  <UsageTop usage={tyUsage} labelOf={(id) => TY_TOOL_LABEL[id] ?? id}
                            onReset={() => {
                              setTyUsage({}); setTyUsageReset(true);
                              setSaved("TY Viewer 사용 기록을 비웠습니다 — OK(저장) 시 반영");
                            }} />
                </Group>
                <Group title="자체 2D 뷰어 레이아웃 (요청: 방향·크기 전환)">
                  <Row label="툴 팔레트 위치">
                    <select value={paletteSide} onChange={(e) => setPaletteSide(e.target.value as "left" | "top" | "right")}>
                      <option value="left">세로 (좌측)</option><option value="top">가로 (상단)</option>
                      <option value="right">세로 (우측)</option><option value="bottom">가로 (하단)</option>
                    </select>
                  </Row>
                  <Row label="썸네일 위치">
                    <select value={thumbSide} onChange={(e) => setThumbSide(e.target.value as "left" | "bottom" | "right")}>
                      <option value="left">세로 (좌측)</option><option value="bottom">가로 (하단)</option>
                      <option value="right">세로 (우측)</option><option value="top">가로 (상단)</option>
                    </select>
                  </Row>
                  <Row label="썸네일 크기">
                    <input type="range" min={56} max={260} step={4} value={thumbSize}
                           onChange={(e) => setThumbSize(Number(e.target.value))} /> {thumbSize}px
                  </Row>
                  <Row label="썸네일 모드">
                    <select value={thumbMode} onChange={(e) => setThumbMode(e.target.value as "series" | "all")}>
                      <option value="series">시리즈 (선택 시 개별 전개)</option>
                      <option value="all">전체 이미지 나열</option>
                    </select>
                  </Row>
                  <Row label="판독창 도크">
                    <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12 }}>
                      <input type="checkbox" checked={reportDock} onChange={(e) => setReportDock(e.target.checked)} />
                      뷰어 우측에 리포트·과거검사 표시
                    </label>
                  </Row>
                  <Row label="닫기 동작">
                    <select value={closeMode}
                            onChange={(e) => setCloseMode(e.target.value as typeof closeMode)}>
                      <option value="ask">항상 묻기 (닫기 다이얼로그)</option>
                      <option value="save_current">현재 화면 저장하고 닫기</option>
                      <option value="save_all">전체 변경사항 저장하고 닫기 (주석+GSPS)</option>
                      <option value="discard">저장하지 않고 닫기</option>
                    </select>
                  </Row>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    닫기 다이얼로그에서 "기본으로" 체크 시 이 설정이 자동 변경됩니다. Exam 탭은 ✕/전체닫기 전까지 유지.
                  </div>
                </Group>
                <Group title="2D 행잉 (모달리티 → 분할)">
                  {([["CT", h2dCT, setH2dCT], ["MR", h2dMR, setH2dMR]] as const).map(([m, v, set]) => (
                    <Row key={m} label={m}>
                      <select value={v} onChange={(e) => set(e.target.value)}>
                        <option value="1x1">1 X 1</option><option value="1x2">1 X 2</option><option value="2x2">2 X 2</option>
                      </select>
                    </Row>
                  ))}
                </Group>
                <Group title="Tools bar 구성 (UBPACS p.18~21 — 계정 로밍)">
                  {TOOLBAR_DEFS.map((sec) => (
                    <div key={sec.section}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-secondary)", marginBottom: 3 }}>
                        {sec.section}
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 3 }}>
                        {sec.items.map((t) => (
                          <label key={t.id} title={t.desc}
                                 style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12 }}>
                            <input type="checkbox" checked={tbConfig[t.id] !== false}
                                   onChange={(e) => setTbConfig((p) => ({ ...p, [t.id]: e.target.checked }))} />
                            {["cobb", "leg", "pelvis", "spineCurve"].includes(t.id)
                              ? <AnatomyIcon id={t.id} size={14} />
                              : <ToolIconTy id={t.id === "3d" ? "mpr" : t.id} size={14} />}
                            {t.label} <span style={{ color: "var(--text-secondary)", fontSize: 10.5 }}>{t.desc.split(" — ")[0].split(" (")[0]}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    체크 해제 시 뷰어 툴바에서 해당 버튼이 숨겨집니다 — 로그인 계정별 저장(로밍).
                  </div>
                </Group>
                <Group title="W/L 프리셋 (Presetting — 2D 섹션 버튼)" right={
                  <button style={{ padding: "1px 8px", fontSize: 11 }}
                          onClick={() => setWlPresets((p) => [...p, { key: `p${Date.now() % 1e5}`, label: "새 프리셋", q: "40,400" }])}>
                    ＋ 추가
                  </button>
                }>
                  <table className="grid-table">
                    <thead><tr><th>이름</th><th style={{ width: 90 }}>Center</th><th style={{ width: 90 }}>Width</th><th style={{ width: 32 }}></th></tr></thead>
                    <tbody>
                      {wlPresets.map((p, i) => {
                        const [c, w] = p.q ? p.q.split(",") : ["", ""];
                        const setQ = (nc: string, nw: string) =>
                          setWlPresets((arr) => arr.map((x, j) => j === i ? { ...x, q: nc === "" && nw === "" ? "" : `${nc},${nw}` } : x));
                        return (
                          <tr key={p.key}>
                            <td><input value={p.label} style={{ width: "95%" }}
                                       onChange={(e) => setWlPresets((arr) => arr.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} /></td>
                            <td><input value={c} placeholder="(기본)" style={{ width: 70 }}
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
                    뷰어 2D 섹션에 프리셋 버튼으로 표시 — All 토글 시 전체 페인 적용. OK(저장) 시 반영.
                  </div>
                </Group>
              </>
            )}

            {page === "shortcuts" && (
              <Group title="단축키 (Mouse·Key) — 계정별 저장">
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  뷰어 마우스/키 동작을 계정별로 설정합니다(모든 뷰어 공통). 하단 OK(저장) 시 내 계정에만 적용.
                </div>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}>
                  <span style={{ width: 170, color: "var(--text-secondary)" }}>우클릭 드래그 도구</span>
                  <select value={scRdrag} onChange={(e) => setScRdrag(e.target.value as "wl" | "zoom" | "pan")}>
                    <option value="wl">W/L 조정 (기본)</option>
                    <option value="zoom">Zoom</option>
                    <option value="pan">Pan</option>
                  </select>
                </label>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}>
                  <span style={{ width: 170, color: "var(--text-secondary)" }}>시리즈 드롭 동작 메뉴</span>
                  <input type="checkbox" checked={dropMenu} onChange={(e) => setDropMenu(e.target.checked)} />
                  <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                    체크 시 드롭할 때 Open/Combine/Combine all 메뉴 표시 — 해제(기본)는 바로 Open(교체)
                  </span>
                </label>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}>
                  <span style={{ width: 170, color: "var(--text-secondary)" }}>Shift + 우클릭</span>
                  <select value={scShiftR} onChange={(e) => setScShiftR(e.target.value as "zoomout" | "none")}>
                    <option value="zoomout">Zoom Out 한 단계 (기본)</option>
                    <option value="none">동작 없음</option>
                  </select>
                </label>
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  · 우클릭(클릭만)=컨텍스트 메뉴 · 중클릭 드래그=Pan 고정 · 고정 키: Esc(계층 취소) · 1~9(시리즈 선택) · T 홀드(오버레이) · Backspace(주석 삭제 보조)
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                  <b style={{ fontSize: 12.5 }}>키 바인딩 (전체 기능)</b>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>칸 클릭 후 키 입력 — Backspace=해제. 중복 키는 빨간 표시.</span>
                  <button style={{ marginLeft: "auto", fontSize: 11, padding: "1px 10px" }}
                          onClick={() => setScKeys({ ...SC_DEFAULTS })}>↺ 전체 기본값</button>
                </div>
                {(() => {
                  const dup = new Set(Object.values(scKeys).filter((v, _, arr) => v && arr.filter((x) => x === v).length > 1));
                  const groups = [...new Set(SC_ACTIONS.map((x) => x.group))];
                  return groups.map((g) => (
                    <div key={g} style={{ marginTop: 4 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-secondary)", padding: "2px 0" }}>{g}</div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: 4 }}>
                        {SC_ACTIONS.filter((x) => x.group === g).map((x) => (
                          <label key={x.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                            <span style={{ flex: 1, color: "var(--text-primary)" }}>{x.label}</span>
                            <input readOnly value={displayKey(scKeys[x.id] ?? x.def)} placeholder="키 입력"
                                   title={`기본값: ${displayKey(x.def)} — 클릭 후 원하는 키 입력 (Backspace=해제)`}
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
                <Group title="모니터 감지 · 뷰어 배치" right={
                  <span style={{ display: "flex", gap: 4 }}>
                  <button style={{ padding: "1px 10px", fontSize: 11.5 }}
                          title="각 모니터 중앙에 번호(1,2,3…)를 3초간 표시 — 어떤 모니터가 어떤 모델인지 확인"
                          onClick={async () => {
                            const w = window as unknown as {
                              getScreenDetails?: () => Promise<{
                                screens: { label?: string; availLeft: number; availTop: number; availWidth: number; availHeight: number }[];
                              }>;
                            };
                            const issue0 = screenApiIssue();
                            if (issue0) { setMonitorMsg(issue0); return; }
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
                                pop.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>모니터 ${i + 1}</title>
<style>body{margin:0;background:#1769e0;color:#fff;font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;overflow:hidden}
.n{font-size:120px;font-weight:800;line-height:1}.l{font-size:13px;opacity:.9;text-align:center;padding:0 12px;margin-top:6px}</style></head>
<body><div style="text-align:center"><div class="n">${i + 1}</div>
<div class="l">${esc(s.label || `모니터 ${i + 1}`)}<br>${s.availWidth}×${s.availHeight}</div></div></body></html>`);
                                pop.document.close();
                                setTimeout(() => { try { pop.close(); } catch { /* 무시 */ } }, 3000);
                              });
                              setMonitorMsg(blocked
                                ? `일부 창이 팝업 차단됨(${blocked}) — 주소창에서 팝업 허용 후 다시 시도`
                                : "각 모니터 중앙에 번호를 3초간 표시했습니다 — 목록의 번호와 대조하세요");
                            } catch { setMonitorMsg("모니터 권한이 거부되었습니다"); }
                          }}>
                    🔢 모니터 확인
                  </button>
                  <button className="primary" style={{ padding: "1px 10px", fontSize: 11.5 }} onClick={async () => {
                    const w = window as unknown as {
                      getScreenDetails?: () => Promise<{
                        screens: { label?: string; availWidth: number; availHeight: number; isPrimary?: boolean }[];
                      }>;
                    };
                    const issue = screenApiIssue();
                    if (issue) { setMonitorMsg(issue); return; }
                    try {
                      const det = await w.getScreenDetails!();
                      setMonitors(det.screens.map((s, i) => ({
                        label: s.label || `모니터 ${i + 1}`, w: s.availWidth, h: s.availHeight,
                        primary: !!s.isPrimary,
                      })));
                      setMonitorMsg(`${det.screens.length}대 감지됨 — 🔢 모니터 확인으로 번호를 대조하고 창별로 지정하세요`);
                    } catch { setMonitorMsg("모니터 권한이 거부되었습니다 — 주소창 권한 아이콘에서 허용 후 다시 시도"); }
                  }}>① 모니터 감지</button>
                  </span>
                }>
                  {monitorMsg && <div style={{ fontSize: 12, color: "var(--stat-final)" }}>{monitorMsg}</div>}
                  {screenApiIssue() && (
                    <div style={{
                      fontSize: 12, color: "var(--warning)", lineHeight: 1.5,
                      border: "1px solid var(--warning)", borderRadius: 6, padding: "6px 9px",
                      background: "color-mix(in srgb, var(--warning) 10%, transparent)",
                    }}>
                      ⚠ {screenApiIssue()}
                    </div>
                  )}
                  {monitors.length === 0 ? (
                    <div style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
                      아직 감지된 모니터가 없습니다 — 우측 상단 <b>① 모니터 감지</b>를 누르세요
                      (최초 1회 브라우저 권한 허용 필요).
                      {(monitorSel.length > 0 || wlMon != null || rptMon != null) && (
                        <div style={{ marginTop: 4 }}>
                          현재 저장된 배치 —
                          뷰어: <b style={{ color: "var(--text-primary)" }}>{monitorSel.length ? monitorSel.map((i) => i + 1).join(", ") : "기본"}</b> ·
                          워크리스트: <b style={{ color: "var(--text-primary)" }}>{wlMon != null ? wlMon + 1 : "기본"}</b> ·
                          판독: <b style={{ color: "var(--text-primary)" }}>{rptMon != null ? rptMon + 1 : "기본"}</b>
                        </div>
                      )}
                    </div>
                  ) : (
                    <table className="grid-table">
                      <thead>
                        <tr>
                          <th>② 모니터</th>
                          <th style={{ width: 96 }} title="다중 선택=스팬">뷰어 ☑</th>
                          <th style={{ width: 96 }} title="다시 클릭=해제">워크리스트 ◉</th>
                          <th style={{ width: 96 }} title="다시 클릭=해제">판독 ◉</th>
                          <th style={{ width: 150 }} title="이 모니터의 뷰어에서 ◀▶(다음/이전 환자)가 훑는 워크리스트 탭(필터)">◀▶ 탐색 탭</th>
                        </tr>
                      </thead>
                      <tbody>
                        {monitors.map((m, i) => (
                          <tr key={i}>
                            <td>
                              <b style={{ color: "var(--accent)", marginRight: 4 }}>{i + 1}</b>
                              🖵 {m.label} ({m.w}×{m.h}){m.primary && " · 주 모니터"}
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
                                <option value="">전체 (필터 없음)</option>
                                {availTabs.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12.5 }}>최대 열 영상 수 (라운드로빈 슬롯)</span>
                    <input type="number" min={0} max={monitorSel.length || 8} value={maxOpen}
                           title="검사를 열 때 순환할 모니터(영상) 개수 — 0=선택한 뷰어 모니터 전부. 예: 3이면 1·2·3 모니터를 1,2,3,1,2,3… 순환"
                           onChange={(e) => setMaxOpen(Math.max(0, Number(e.target.value) || 0))}
                           style={{ width: 64 }} />
                    <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                      0 = 선택한 뷰어 모니터 전부 ({monitorSel.length || 0}대)
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12.5 }}>All Close(전체 닫기) 범위</span>
                    <select value={closeScope} onChange={(e) => setCloseScope(e.target.value as "all" | "current")}
                            title="뷰어의 All Close 버튼을 눌렀을 때 닫을 범위">
                      <option value="all">전체 모니터 뷰어 닫기</option>
                      <option value="current">현재 모니터 뷰어만 닫기</option>
                    </select>
                    <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                      뷰어의 <b>All Close ✕</b> 클릭 시
                    </span>
                  </div>
                  <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>
                      모달리티 → 모니터 배치 예외 (라운드로빈 대신 지정 모니터로 오픈)
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 6 }}>
                      기본은 번호순 순환(1,2,3…)이지만, 여기에 지정한 모달리티 검사는 항상 지정 모니터에 열립니다 (예: CR → 3번).
                    </div>
                    {modalityMap.map((rule, ri) => (
                      <div key={ri} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                        <input value={rule.modality} placeholder="모달리티 (예: CR)"
                               onChange={(e) => setModalityMap((p) => p.map((r, k) => k === ri ? { ...r, modality: e.target.value.toUpperCase() } : r))}
                               style={{ width: 120 }} />
                        <span>→ 모니터</span>
                        <input type="number" min={1} max={monitors.length || 8} value={rule.monitor + 1}
                               onChange={(e) => setModalityMap((p) => p.map((r, k) => k === ri ? { ...r, monitor: Math.max(0, (Number(e.target.value) || 1) - 1) } : r))}
                               style={{ width: 56 }} />
                        <button onClick={() => setModalityMap((p) => p.filter((_, k) => k !== ri))}
                                style={{ fontSize: 11 }}>삭제</button>
                      </div>
                    ))}
                    <button onClick={() => setModalityMap((p) => [...p, { modality: "", monitor: 0 }])}
                            style={{ fontSize: 11.5 }}>+ 예외 추가</button>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <button disabled={wlMon == null}
                            title="워크리스트를 선택한 모니터의 새 창으로 열기 (기존 탭은 닫아도 됨)"
                            onClick={async () => {
                              const { screenFeatures } = await import("../lib/screens");
                              const features = await screenFeatures(wlMon != null ? [wlMon] : null);
                              window.open(`${window.location.origin}${window.location.pathname}`, "sv_worklist", features)?.focus();
                            }}>
                      워크리스트를 해당 모니터로 열기
                    </button>
                    <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                      (브라우저 보안상 현재 창은 이동 불가 — 새 창으로 엽니다)
                    </span>
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--text-secondary)", borderTop: "1px solid var(--border)", paddingTop: 6 }}>
                    <b>사용 방법:</b> ① 모니터 감지 → 🔢 모니터 확인(각 화면에 번호 표시·목록 번호와 대조)
                    → ② 창별 모니터 지정 → ③ 하단 <b>OK(저장)</b> → ④ 다음 오픈부터 적용.<br />
                    · <b>뷰어 ☑</b>: 1대=해당 모니터 / <b>2대 이상=검사를 열 때마다 모니터 번호순으로 순환 배치</b>(1,2,3,1,2,3…) / 0대=기본 크기<br />
                    &nbsp;&nbsp;&nbsp;검사가 열리는 그 모니터만 새로 로드되고, 나머지 모니터 뷰어는 <b>깜빡임 없이 Exam 탭만 추가</b>됩니다.<br />
                    &nbsp;&nbsp;&nbsp;순환할 모니터 수는 위 <b>최대 열 영상 수</b>로 조절(0=선택 전부).
                    최초 오픈 시 팝업이 차단되면 주소창 팝업 아이콘에서 이 사이트 <b>항상 허용</b>으로 설정하세요.<br />
                    · <b>워크리스트 ◉</b>: 위 버튼으로 해당 모니터에 새 창 오픈 (라디오 재클릭=해제)<br />
                    · <b>판독 ◉</b>: 뷰어의 [Reading] 버튼이 해당 모니터에 판독 창을 띄움
                  </div>
                </Group>
                <Group title="뷰어 창 정보 (별도 포트)">
                  <div style={{ fontSize: 12.5 }}>
                    현재 뷰어 창 출처: <code>{VIEWER_BASE || "워크리스트와 동일 (같은 포트)"}</code>
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                    뷰어를 별도 포트로 분리하려면 <code>frontend/.env</code>에
                    <code> VITE_VIEWER_BASE=https://localhost:5176</code> 추가 후
                    <code> npm run dev:viewer</code>를 함께 실행하세요 (재기동 필요).
                  </div>
                </Group>
              </>
            )}

            {page === "policy" && (
              <Group title="탐색 방향 정책 — ◀▶ 환자 이동 (뷰어·판독 창·워크리스트 공통)">
                <Row label="◀ (왼쪽) 버튼">
                  <select value={polNavLeft} onChange={(e) => setPolNavLeft(e.target.value as "past" | "recent")}>
                    <option value="past">시간상 과거로 (워크리스트 아래 행 방향)</option>
                    <option value="recent">시간상 최신으로 (워크리스트 위 행 방향)</option>
                  </select>
                </Row>
                <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.7 }}>
                  워크리스트는 최신 검사가 위에 정렬됩니다. ◀▶는 열려 있는 환자(현재 보고 있는 검사)를
                  기준으로 <b>시간대별 한 단계씩</b> 이동하며, ▶(오른쪽)는 항상 ◀의 반대 방향입니다.<br />
                  · <b>과거로(기본)</b>: ◀=한 단계 과거(아래 행) / ▶=한 단계 최신(위 행)<br />
                  · <b>최신으로</b>: ◀=한 단계 최신(위 행) / ▶=한 단계 과거(아래 행)<br />
                  이동 대상 환자가 이미 Exam 탭으로 열려 있으면 그 탭으로 전환되고, 아니면 열면서 이동합니다.
                  Worklist·Image Viewer·Reading Viewer는 열린 환자를 서로 따라갑니다(연동). OK(저장) 시 적용.
                </div>
              </Group>
            )}

            {page === "hp" && (
              <HpProtocolEditor
                rules={hpRules}
                onChange={async (next) => {
                  setHpRules(next);
                  await api.putSetting("viewer.hp", { rules: next }, "user");
                  setSaved("행잉 프로토콜 저장됨 — 왼쪽 ⟳ Refresh 후 뷰어 재오픈 시 적용");
                }}
              />
            )}

            {page === "pdf" && isAdmin && (
              <Group title="판독서 템플릿 (기관)">
                <Row label="병원명"><input value={hospital} onChange={(e) => setHospital(e.target.value)} style={{ width: 280 }} /></Row>
                <Row label="부서"><input value={department} onChange={(e) => setDepartment(e.target.value)} style={{ width: 280 }} /></Row>
                <Row label="푸터"><input value={footer} onChange={(e) => setFooter(e.target.value)} style={{ width: 280 }} /></Row>
              </Group>
            )}

            {page === "ai" && isAdmin && (
              <>
                <Group title="AI 정책">
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, fontWeight: 700 }}>
                    <input type="checkbox" checked={draftEnabled} onChange={(e) => setDraftEnabled(e.target.checked)} />
                    AI 판독 초안 생성 (Structured Report) — 마스터 스위치
                  </label>
                  <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginLeft: 22 }}>
                    {draftEnabled
                      ? "활성 — 자동/수동 초안 생성이 동작합니다."
                      : "보류 중 — RAG 기반 Structured Report 개편 전까지 자동·수동 초안 생성이 전면 차단됩니다(기존 초안 열람은 가능)."}
                  </div>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5,
                                  opacity: draftEnabled ? 1 : 0.5 }}>
                    <input type="checkbox" checked={autoGenerate} disabled={!draftEnabled}
                           onChange={(e) => setAutoGenerate(e.target.checked)} />
                    검사 도착 시 초안 자동 생성
                  </label>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
                    <input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} />
                    키이미지 vision 분석 (F-11) — <span style={{ color: "var(--ai)" }}>[영상 참고 관찰]로만 표기</span>
                  </label>
                </Group>
                <Group title="음성 판독 STT 엔진 (Whisper 오픈소스 / 상용 API)">
                  <Row label="엔진">
                    <select value={sttEngine} onChange={(e) => setSttEngine(e.target.value)}>
                      <option value="browser">브라우저 내장 (Web Speech — 기본)</option>
                      <option value="whisper_local">Whisper 로컬 (오픈소스 — 온프레미스, PHI 안전)</option>
                      <option value="openai_api">OpenAI API (상용 — whisper-1)</option>
                    </select>
                  </Row>
                  <Row label="모델">
                    <input value={sttModel} onChange={(e) => setSttModel(e.target.value)}
                           placeholder={sttEngine === "openai_api" ? "whisper-1" : "base / small / medium…"}
                           style={{ width: 220 }} />
                  </Row>
                  {sttStat && (
                    <div style={{ fontSize: 11.5, display: "flex", flexDirection: "column", gap: 3,
                                  background: "var(--bg-canvas)", border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>
                      <div style={{ fontWeight: 700, color: sttStat.ready ? "var(--stat-final)" : "var(--stat-emergency)" }}>
                        {sttStat.ready ? "● 현재 엔진 구동 가능" : "○ 현재 엔진 구동 불가 — 설치/키 확인 필요"}
                      </div>
                      <div style={{ color: "var(--text-secondary)" }}>
                        서버 설치 상태 — faster-whisper: <b>{sttStat.available.faster_whisper ? "설치됨" : "미설치"}</b> ·
                        openai-whisper: <b>{sttStat.available.openai_whisper ? "설치됨" : "미설치"}</b> ·
                        OPENAI_API_KEY: <b>{sttStat.available.openai_api_key ? "설정됨" : "없음"}</b>
                      </div>
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    Whisper 로컬: <code>pip install faster-whisper</code> 필요(미설치 시 안내 응답).
                    <b style={{ color: "var(--stat-emergency)" }}> OpenAI API는 음성이 외부로 전송됩니다</b> —
                    API 키는 서버 환경변수 <code>OPENAI_API_KEY</code>로만 설정(코드/설정 저장 금지).
                    이 설정은 <b>전역(모든 병원·Client 공통)</b>으로 적용됩니다.
                  </div>
                </Group>
                {quality && quality.with_ai_draft > 0 && (
                  <Group title="AI 품질 지표 (F-20)">
                    <table className="grid-table">
                      <tbody>
                        <tr><th style={{ width: 140 }}>AI 초안 기반 확정</th><td>{quality.with_ai_draft} / {quality.finalized_total}건</td></tr>
                        <tr><th>무수정 수용률</th><td>{((quality.acceptance_rate ?? 0) * 100).toFixed(1)}%</td></tr>
                        <tr><th>평균 수정률</th><td>{((quality.avg_modified_ratio ?? 0) * 100).toFixed(1)}%</td></tr>
                        <tr><th>critical 변경</th>
                          <td style={{ color: (quality.critical_dropped || quality.critical_added) ? "var(--stat-emergency)" : undefined }}>
                            탈락 {quality.critical_dropped ?? 0} / 추가 {quality.critical_added ?? 0}
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
          <button className="primary" onClick={save}>OK (저장)</button>
          <button onClick={onClose}>Cancel</button>
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
      <input ref={ref} value={value} readOnly placeholder="키를 입력하세요"
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
        {cap ? "입력 중…" : "입력"}
      </button>
      <button style={{ padding: "1px 9px", fontSize: 11 }} onClick={() => onChange("")}>지우기</button>
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
    } catch (e) { alert(e instanceof Error ? e.message : "저장 실패"); }
  };

  return (
    <div style={{ display: "flex", gap: 14, minHeight: 320 }}>
      {/* 좌: 목록 */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <b style={{ fontSize: 12.5 }}>{label} 목록</b>
          <button className="primary" style={{ padding: "2px 10px", fontSize: 11.5 }}
                  onClick={() => { setSel(null); setF(empty); }}>＋ {label} 추가</button>
        </div>
        <div style={{ flex: 1, overflow: "auto", border: "1px solid var(--border)", borderRadius: 4 }}>
          {list.map((p) => (
            <div key={p.id} onClick={() => setSel(p)}
                 style={{ padding: "6px 10px", fontSize: 12, cursor: "pointer", borderBottom: "1px solid #24282d",
                          display: "flex", gap: 6, alignItems: "center",
                          background: sel?.id === p.id ? "var(--accent-subtle)" : undefined }}>
              <span style={{ color: "var(--text-secondary)" }}>[{p.modality || "공통"}]</span>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
              {p.shortcut && <span style={{ color: "var(--accent)" }}>Alt+{p.shortcut}</span>}
              <button style={{ padding: "0 6px", fontSize: 11 }} onClick={async (e) => {
                e.stopPropagation();
                if (!window.confirm(`'${p.name}'을 삭제할까요?`)) return;
                await api.deletePhrase(p.id);
                if (sel?.id === p.id) setSel(null);
                reload();
              }}>✕</button>
            </div>
          ))}
          {list.length === 0 && (
            <div style={{ padding: 16, fontSize: 12, color: "var(--text-secondary)", textAlign: "center" }}>
              등록된 {label}가 없습니다.
            </div>
          )}
        </div>
      </div>
      {/* 우: 추가/수정 폼 (레퍼런스 폼 구성) */}
      <div style={{ flex: 1.1, minWidth: 0, display: "flex", flexDirection: "column", gap: 7 }}>
        <b style={{ fontSize: 12.5 }}>{sel ? `${label} 수정 — ${sel.name}` : `새 ${label} 추가`}</b>
        <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>모달리티</div>
        <select value={f.modality} onChange={(e) => setF((p) => ({ ...p, modality: e.target.value }))}>
          <option value="">공통 (모든 장비)</option>
          {["CR", "DX", "CT", "MR", "US", "MG", "XA", "NM"].map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        {kind === "phrase" && (
          <>
            <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>단축키 코드 (Alt+키)</div>
            <div style={{ display: "flex", gap: 4 }}>
              <input value={f.shortcut} readOnly placeholder="단축키를 입력하세요"
                     style={{ flex: 1, background: cap ? "var(--accent-subtle)" : undefined }}
                     onKeyDown={(e) => {
                       if (!cap) return;
                       e.preventDefault();
                       if (/^[a-zA-Z0-9]$/.test(e.key)) { setF((p) => ({ ...p, shortcut: e.key.toUpperCase() })); setCap(false); }
                     }} />
              <button className={cap ? "primary" : ""} style={{ padding: "2px 10px", fontSize: 11.5 }}
                      onClick={(e) => { setCap((c) => !c); (e.currentTarget.previousElementSibling as HTMLInputElement)?.focus(); }}>
                입력
              </button>
            </div>
          </>
        )}
        <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>{label} 이름</div>
        <input value={f.name} onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))} />
        <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>판독 (Reading)</div>
        <textarea value={f.reading_text} rows={5}
                  onChange={(e) => setF((p) => ({ ...p, reading_text: e.target.value }))}
                  style={{ background: "var(--bg-canvas)", color: "var(--text-primary)", border: "1px solid var(--border)",
                           borderRadius: 3, padding: 6, fontFamily: "inherit", fontSize: 12, resize: "vertical" }} />
        <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>결론 (Conclusion)</div>
        <textarea value={f.text} rows={4}
                  onChange={(e) => setF((p) => ({ ...p, text: e.target.value }))}
                  style={{ background: "var(--bg-canvas)", color: "var(--text-primary)", border: "1px solid var(--border)",
                           borderRadius: 3, padding: 6, fontFamily: "inherit", fontSize: 12, resize: "vertical" }} />
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button className="primary" style={{ padding: "4px 18px" }}
                  disabled={!f.name.trim() || !(f.text.trim() || f.reading_text.trim())}
                  onClick={() => void save()}>저장</button>
        </div>
      </div>
    </div>
  );
}

/* ── 행잉 프로토콜 편집기 (설정>행잉) — 좌측 프로토콜 카드 목록 + 우측 기본정보·옵션·디스플레이 레이아웃 ── */
const HP_MODALITIES = ["CT", "MR", "CR", "DX", "US", "MG", "XA", "NM", "PT", "RF", "OT"];
const HP_OPTIONS: { key: keyof HpRule; label: string; desc: string }[] = [
  { key: "use_on_exam_open", label: "Exam 열 때 HP 사용", desc: "검사 열 때 이 프로토콜을 자동 적용" },
  { key: "full_link", label: "전체 링크", desc: "모든 페인을 함께 조작(동기)" },
  { key: "full_scroll_sync", label: "전체 스크롤 동기화", desc: "페인 스크롤을 함께 이동" },
  { key: "cross_link", label: "Cross Link 사용", desc: "교차 해부학 위치 동기(다른 시리즈)" },
  { key: "scout_image", label: "Scout 이미지 사용", desc: "교차선(Scout) 표시" },
];

function HpProtocolEditor({ rules, onChange }: {
  rules: HpRule[];
  onChange: (next: HpRule[]) => void | Promise<void>;
}) {
  const [selId, setSelId] = useState<string | null>(null);
  const [draft, setDraft] = useState<HpRule | null>(null);
  const [dirty, setDirty] = useState(false);
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
  const newRule = (): HpRule => ({
    id: `hp${Date.now().toString(36)}`, name: "새 프로토콜", modality: "", body_part: "", projection: "",
    description: "", s: { r: 1, c: 1 }, i: { r: 1, c: 1 }, wl: "",
    use_on_exam_open: true, full_link: false, full_scroll_sync: false, cross_link: false, scout_image: false,
    displays: DEFAULT_HP_DISPLAYS(),
  });
  const addNew = () => { const r = newRule(); void onChange([...rules, r]); setSelId(r.id); setDraft(r); setDirty(false); };
  const dup = (r: HpRule) => {
    const c: HpRule = { ...JSON.parse(JSON.stringify(r)), id: `hp${Date.now().toString(36)}`, name: `${r.name} (복사)` };
    void onChange([...rules, c]); setSelId(c.id); setDraft(c); setDirty(false);
  };
  const del = (id: string) => {
    if (!window.confirm("이 행잉 프로토콜을 삭제할까요?")) return;
    const next = rules.filter((r) => r.id !== id);
    void onChange(next);
    if (selId === id) { const n = next[0] ?? null; setSelId(n?.id ?? null); setDraft(n); setDirty(false); }
  };
  const save = () => {
    if (!draft) return;
    if (!draft.name.trim()) { window.alert("프로토콜명을 입력하세요"); return; }
    if (!draft.modality) { window.alert("장비를 선택하세요"); return; }
    // viewer 디스플레이 그리드를 하위호환 s(Series 분할)로 반영 → 기존 applyHp 적용
    const vd = (draft.displays ?? []).find((d) => d.role === "viewer");
    const clean: HpRule = { ...draft, name: draft.name.trim(), s: vd ? { ...vd.grid } : draft.s };
    void onChange(rules.map((r) => (r.id === clean.id ? clean : r)));
    setDraft(clean); setDirty(false);
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
          <b style={{ fontSize: 14 }}>행잉 프로토콜</b>
          <button className="primary" title="새 프로토콜 추가" onClick={addNew}
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
                  {r.id === selId && dirty ? `${draft?.name || r.name} *` : r.name}
                </b>
                <span style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                  <button title="복제" onClick={(e) => { e.stopPropagation(); dup(r); }}
                          style={{ padding: "2px 6px", fontSize: 12 }}>⧉</button>
                  <button title="삭제" onClick={(e) => { e.stopPropagation(); del(r.id); }}
                          style={{ padding: "2px 6px", fontSize: 12 }}>🗑</button>
                </span>
              </div>
              <div style={{ display: "flex", gap: 5, marginTop: 6 }}>
                {tag(r.modality || "*", "#60a5fa")}
                {r.body_part ? tag(r.body_part, "#f59e0b") : null}
              </div>
            </div>
          ))}
          {rules.length === 0 && (
            <div style={{ color: "var(--text-secondary)", fontSize: 12, padding: "12px 4px", textAlign: "center" }}>
              프로토콜이 없습니다.<br />＋ 로 추가하세요.
            </div>
          )}
        </div>
      </div>

      {/* 우측 — 기본 정보 + 옵션 + 디스플레이 레이아웃 */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {!draft ? (
          <div style={{ display: "grid", placeItems: "center", flex: 1, color: "var(--text-secondary)" }}>
            좌측에서 프로토콜을 선택하거나 ＋ 로 추가하세요.
          </div>
        ) : (
          <>
            <div style={{ flex: 1, overflow: "auto", paddingRight: 4 }}>
              {secHead("기본 정보")}
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <label style={{ fontSize: 12.5 }}>
                  <div style={{ color: "var(--text-secondary)", marginBottom: 4 }}>프로토콜명 <span style={{ color: "var(--stat-emergency)" }}>*</span></div>
                  <input value={draft.name} onChange={(e) => upd({ name: e.target.value })}
                         placeholder="프로토콜 이름을 입력하세요" style={{ width: "100%" }} />
                </label>
                <label style={{ fontSize: 12.5 }}>
                  <div style={{ color: "var(--text-secondary)", marginBottom: 4 }}>장비 <span style={{ color: "var(--stat-emergency)" }}>*</span></div>
                  <select value={draft.modality} onChange={(e) => upd({ modality: e.target.value })} style={{ width: "100%" }}>
                    <option value="">장비를 선택하세요</option>
                    {HP_MODALITIES.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </label>
                <label style={{ fontSize: 12.5 }}>
                  <div style={{ color: "var(--text-secondary)", marginBottom: 4 }}>부위</div>
                  <input value={draft.body_part} onChange={(e) => upd({ body_part: e.target.value.toUpperCase() })}
                         placeholder="부위를 입력하세요 (예: CHEST, 빈칸=무관)" style={{ width: "100%" }} />
                </label>
                <label style={{ fontSize: 12.5 }}>
                  <div style={{ color: "var(--text-secondary)", marginBottom: 4 }}>설명</div>
                  <textarea value={draft.description ?? ""} onChange={(e) => upd({ description: e.target.value })}
                            placeholder="설명을 입력하세요" rows={3} style={{ width: "100%", resize: "vertical" }} />
                </label>
              </div>

              {/* 옵션 체크박스 */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "16px 0" }}>
                {HP_OPTIONS.map((o) => {
                  const on = !!draft[o.key];
                  return (
                    <label key={String(o.key)} title={o.desc}
                           style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px",
                                    border: "1px solid var(--border)", borderRadius: 8, cursor: "pointer",
                                    background: "var(--bg-canvas)" }}>
                      <input type="checkbox" checked={on}
                             onChange={(e) => upd({ [o.key]: e.target.checked } as Partial<HpRule>)}
                             style={{ width: 18, height: 18 }} />
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{o.label}</span>
                    </label>
                  );
                })}
              </div>

              {/* 디스플레이 레이아웃 */}
              {secHead("디스플레이 레이아웃")}
              <HpDisplayEditor displays={draft.displays ?? DEFAULT_HP_DISPLAYS()}
                               onChange={(ds) => upd({ displays: ds })} />
            </div>

            {/* 하단 — 취소/저장 */}
            <div style={{ display: "flex", gap: 8, justifyContent: "center", padding: "12px 0 2px",
                          borderTop: "1px solid var(--border)", marginTop: 8 }}>
              <button onClick={() => select(selId)} disabled={!dirty} style={{ minWidth: 84 }}>취소</button>
              <button className="primary" onClick={save} style={{ minWidth: 84 }}>저장</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── HP 디스플레이(모니터) 레이아웃 편집기 — 모니터별 역할·해상도·viewer 그리드(셀별 시리즈) ── */
function HpDisplayEditor({ displays, onChange }: {
  displays: HpDisplay[];
  onChange: (ds: HpDisplay[]) => void;
}) {
  const patch = (id: string, p: Partial<HpDisplay>) => onChange(displays.map((d) => (d.id === id ? { ...d, ...p } : d)));
  const setGrid = (d: HpDisplay, grid: { r: number; c: number }) => {
    const n = grid.r * grid.c;
    const cells = Array.from({ length: n }, (_, i) => d.cells[i] ?? null);
    patch(d.id, { grid, cells });
  };
  const cycleCell = (d: HpDisplay, i: number) => {
    const n = d.grid.r * d.grid.c;
    const cur = d.cells[i];
    const nextV = cur == null ? 1 : cur >= n ? null : cur + 1;   // null→1→…→n→null(자동)
    patch(d.id, { cells: d.cells.map((c, k) => (k === i ? nextV : c)) });
  };
  const addDisplay = () => onChange([...displays, {
    id: `d${Date.now().toString(36)}`, role: "viewer", label: `${displays.length + 1}`,
    resolution: "1920 * 1080 (100%)", grid: { r: 1, c: 1 }, cells: [null],
  }]);

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, background: "var(--bg-canvas)" }}>
      <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 4 }}>
        {displays.map((d) => {
          const viewer = d.role === "viewer";
          return (
            <div key={d.id} style={{ minWidth: 300, flex: "0 0 300px",   // 축소 금지 — 좌우 스크롤로 우측 디스플레이 접근
                                     border: `2px solid ${viewer ? "#8b5cf6" : "#22c55e"}`, borderRadius: 6, overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                            padding: "6px 10px", background: viewer ? "#8b5cf6" : "#22c55e", color: "#fff", fontSize: 12, fontWeight: 700 }}>
                <span>{viewer ? "viewer" : "workList + report"} Display:{d.label}</span>
                <span style={{ display: "flex", gap: 4 }}>
                  <button title="역할 전환 (viewer ↔ workList+report)"
                          onClick={() => patch(d.id, { role: viewer ? "worklist_report" : "viewer" })}
                          style={{ padding: "0 6px", fontSize: 11, color: "#fff", background: "rgba(0,0,0,0.25)", border: "none", borderRadius: 3 }}>⇄</button>
                  {displays.length > 1 && (
                    <button title="이 디스플레이 제거" onClick={() => onChange(displays.filter((x) => x.id !== d.id))}
                            style={{ padding: "0 6px", fontSize: 11, color: "#fff", background: "rgba(0,0,0,0.25)", border: "none", borderRadius: 3 }}>✕</button>
                  )}
                </span>
              </div>
              <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8, background: "var(--bg-panel)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)", flexShrink: 0 }}>해상도</span>
                  <input value={d.resolution} onChange={(e) => patch(d.id, { resolution: e.target.value })}
                         style={{ flex: 1, minWidth: 0, fontSize: 11 }} />
                </div>
                {viewer ? (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>분할</span>
                      <GridPicker label="Series" max={10} value={d.grid} onPick={(g) => setGrid(d, g)} />
                      <span style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>셀 클릭=시리즈 지정(순번↔자동)</span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: `repeat(${d.grid.c}, 1fr)`, gap: 4,
                                  background: "var(--bg-elevated)", padding: 6, borderRadius: 4 }}>
                      {d.cells.map((c, i) => (
                        <div key={i} onClick={() => cycleCell(d, i)} title="클릭=시리즈 순번 지정 / 자동"
                             style={{ height: 44, display: "grid", placeItems: "center", cursor: "pointer",
                                      borderRadius: 3, border: "1px solid var(--border)",
                                      background: c == null ? "var(--bg-canvas)" : "rgba(139,92,246,0.18)",
                                      color: c == null ? "var(--text-secondary)" : "var(--text-primary)",
                                      fontSize: 15, fontWeight: 700 }}>
                          {c == null ? <span style={{ fontSize: 11, opacity: 0.6 }}>자동 {i + 1}</span> : c}
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div style={{ height: 90, display: "grid", placeItems: "center", color: "var(--text-secondary)",
                                background: "var(--bg-elevated)", borderRadius: 4, fontSize: 12 }}>
                    뷰어 사용 안함 (워크리스트 + 판독)
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "center", marginTop: 8 }}>
        <button onClick={addDisplay} style={{ fontSize: 11.5 }}>＋ 디스플레이 추가</button>
      </div>
      <div style={{ fontSize: 10.5, color: "var(--text-secondary)", textAlign: "center", marginTop: 6 }}>
        viewer 디스플레이 분할이 뷰어의 Series 레이아웃으로 적용됩니다. 물리적 모니터 배치는 설정만 저장됩니다(추후 지원).
      </div>
    </div>
  );
}

/* ── Filter Setting 리스트 (UBPACS형 — ITEM | USE/NO USE 토글 + ▲▼ 순서) ── */
export function FilterSettingList({ all, selected, labelOf, onChange }: {
  all: string[];
  selected: string[];
  labelOf: (k: string) => string;
  onChange: (next: string[]) => void;
}) {
  const rows = [...selected, ...all.filter((k) => !selected.includes(k))];
  const move = (k: string, dir: -1 | 1) => {
    const i = selected.indexOf(k);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= selected.length) return;
    const next = [...selected];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div style={{ maxHeight: 250, overflow: "auto", border: "1px solid var(--border)", borderRadius: 4 }}>
      <table className="grid-table">
        <thead><tr><th>ITEM</th><th style={{ width: 78 }}>사용</th><th style={{ width: 64 }}>순서</th></tr></thead>
        <tbody>
          {rows.map((k) => {
            const used = selected.includes(k);
            const i = selected.indexOf(k);
            return (
              <tr key={k}>
                <td style={{ color: used ? "var(--text-primary)" : "var(--text-secondary)" }}>{labelOf(k)}</td>
                <td>
                  <span onClick={() => onChange(used ? selected.filter((x) => x !== k) : [...selected, k])}
                        title="클릭=토글"
                        style={{
                          cursor: "pointer", fontWeight: 700, fontSize: 10.5, padding: "1px 7px",
                          border: "1px solid var(--border)", borderRadius: 3,
                          color: used ? "var(--stat-final)" : "var(--text-secondary)",
                          background: used ? "rgba(80,200,120,0.12)" : undefined,
                        }}>
                    {used ? "USE" : "NO USE"}
                  </span>
                </td>
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
        <ListBox title="Selected Columns (순서 = 표시 순서)" items={selected} pick={pickSel} setPick={setPickSel} />
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
      if (p && !r.exists) { nav(""); setErr(`경로 없음: ${p} — 드라이브 목록을 표시합니다`); return; }
      setPath(r.path); setParent(r.parent); setDirs(r.dirs); setLoading(false);
    }).catch((e) => { setErr(e instanceof Error ? e.message : "폴더 탐색 실패"); setLoading(false); });
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
          <FolderIcon size={15} /> 서버 폴더 선택
        </b>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button onClick={() => nav(parent ?? "")} disabled={!path}
                  title={parent ? "상위 폴더로" : "드라이브 목록으로"}
                  style={{ padding: "2px 8px", fontSize: 12 }}>⬆ 상위</button>
          <code title={path}
                style={{ flex: 1, fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis",
                         whiteSpace: "nowrap" }}>
            {path || "(드라이브를 선택하세요)"}
          </code>
        </div>
        {err && <div style={{ fontSize: 11.5, color: "var(--stat-emergency)" }}>{err}</div>}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto",
                      border: "1px solid var(--border)", borderRadius: 4 }}>
          {loading ? (
            <div style={{ padding: 10, fontSize: 12, color: "var(--text-secondary)" }}>불러오는 중…</div>
          ) : dirs.length === 0 ? (
            <div style={{ padding: 10, fontSize: 12, color: "var(--text-secondary)" }}>하위 폴더 없음</div>
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
            선택 후 저장(OK/Refresh)해야 반영됩니다
          </span>
          <button onClick={onClose} style={{ fontSize: 12 }}>취소</button>
          <button className="primary" disabled={!path} onClick={() => onPick(path)}
                  title="현재 표시된 경로를 공유 디렉토리 입력에 반영" style={{ fontSize: 12 }}>
            이 폴더 선택
          </button>
        </div>
      </div>
    </div>
  );
}
