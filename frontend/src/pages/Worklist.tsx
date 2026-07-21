// 워크리스트 워크스페이스 — 디자인 명세 §3 5구역 레이아웃 충실 구현
// [A]툴바 [B]필터 [C-좌]날짜트리|[C]메인그리드 [D]과거검사|비교세트 [E]상용구|리포트|오더 + 컨텍스트메뉴
import {
  Fragment,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  PERM_DENIED_TIP,
  VIEWER_BASE,
  api,
  downloadReportPdf,
  hasPerm,
  loadPermMe,
  openViewer,
  openViewerCompare,
  sttTranscribe,
  type BatchCandidate,
  type InstanceThumb,
  type KeyImage,
  type LocalStudyRow,
  type NlQueryResult,
  type OrderRow,
  type PermMe,
  type PhraseRow,
  type Report,
  type SeriesNode,
  type ServerNetwork,
  type SrJson,
  type StudyDetail,
  type StudyRow,
} from "../api";

import {
  DEFAULT_TAB,
  FolderTreeEditor,
  folderSummary,
  folderToFilters,
  loadTabs,
  loadTree,
  mergedFilter,
  newId,
  saveTabs,
  saveTree,
  type TreeNode,
  type WorklistTab,
} from "./WorklistTree";

import { OrderEntryRis } from "../components/OrderEntryRis";
import { MergeIcon, ReadStateIcon } from "../components/readState";
import { GridPicker } from "../lib/GridPicker";
import { IN_EXAM_STATUSES, IN_STATUS_MAP } from "../lib/infiConfig";
import { screenFeatures, screenFeaturesList } from "../lib/screens";
import { showToast } from "../lib/toast";
import { onStudySync, postStudySync, postViewerAddTab } from "../lib/sync";
import { Splitter, clampSz } from "../lib/Splitter";

const Viewer3D = lazy(() => import("./Viewer3D").then((m) => ({ default: m.Viewer3D })));
const ImportDialog = lazy(() => import("./ImportDialog").then((m) => ({ default: m.ImportDialog })));
const LocalViewer = lazy(() => import("./LocalViewer").then((m) => ({ default: m.LocalViewer })));
// EXAM CONTROL (레인 F) — 관리자 전용 검사 QC 화면 (워크리스트 탭 바에서 전환)
const ExamControl = lazy(() => import("./admin/ExamControl").then((m) => ({ default: m.ExamControl })));

/* ── Local Server 모드 (레인 F) — 로컬 검사(local.db)를 그리드 공용 StudyRow 로 매핑 ── */
function localToRow(r: LocalStudyRow): StudyRow {
  return {
    id: r.id, study_uid: "", patient_key: r.patient_key, patient_name: r.patient_name,
    sex: r.sex, birth_date: "", accession_no: "", study_date: r.study_date, study_time: "",
    modality: r.modality, body_part: "", study_desc: r.study_desc, status: "LOCAL",
    emergency: false, critical: false, series_count: 0, instance_count: r.images,
    report_status: null, impression_preview: "", institution: "", referring_physician: "",
    memo: "", finalized_at: "", department: "", source_aet: "", bookmark: false, order_name: "",
    // 로컬 병합 표시 — 로컬 행 응답에 merged 가 있으면 그대로 전달(없으면 undefined → 아이콘 미표시).
    // read_state 등은 전달하지 않음(undefined → ReadStateIcon 이 unread 회색으로 표시)
    merged: (r as LocalStudyRow & { merged?: boolean }).merged,
  };
}
/** LOCAL 모드에서 허용되는 툴바 액션 — 그 외 서버 액션은 비활성+툴팁 */
const LOCAL_OK_ACTIONS = new Set(["import", "csv", "print", "refresh", "logout"]);
const LOCAL_DENIED_TIP = "LOCAL 모드 — 서버 기능 비활성 (Import/새로고침/로컬 뷰어만 사용 가능)";

/* ── F-18 행잉 매핑 + 모니터 배치(viewer.prefs.monitor) ─────────────────── */
let hangingMap: Record<string, string> = {};
let monitorScreens: number[] = [];  // 뷰어를 띄울 모니터 인덱스(다중=스팬)
export function loadHangingPrefs() {
  api.getSetting("viewer.prefs").then((r) => {
    hangingMap = ((r.value as { hanging?: Record<string, string> }).hanging) ?? {};
    monitorScreens = ((r.value as { monitor?: { screens?: number[] } }).monitor?.screens) ?? [];
  }).catch(() => {});
}

/** 뷰어 모니터 배치 계획 — 선택 모니터별 슬롯(번호 오름차순, max_open 캡) + 모달리티→모니터 예외 +
 *  모니터별 ◀▶ 탐색 탭(tab_binding). Window Management API(Chrome) 가용 시. 매 호출 최신 설정 재조회. */
async function viewerMonitorPlan(): Promise<{
  slots: { index: number; features: string }[];
  modalityMap: { modality: string; monitor: number }[];
  tabBinding: Record<number, string>;
}> {
  let maxOpen = 0;
  let modalityMap: { modality: string; monitor: number }[] = [];
  let tabBinding: Record<number, string> = {};
  try {
    const r = await api.getSetting("viewer.prefs");
    const mon = (r.value as { monitor?: {
      screens?: number[]; max_open?: number;
      modality_map?: { modality: string; monitor: number }[]; tab_binding?: Record<number, string>;
    } }).monitor;
    monitorScreens = mon?.screens ?? monitorScreens;
    maxOpen = Number(mon?.max_open) || 0;   // 0/미설정 = 선택 모니터 전부
    if (Array.isArray(mon?.modality_map)) modalityMap = mon!.modality_map!;
    if (mon?.tab_binding) tabBinding = mon.tab_binding;
  } catch { /* 캐시 유지 */ }
  let slots = await screenFeaturesList(monitorScreens);
  if (maxOpen > 0 && slots[0]?.index >= 0 && slots.length > maxOpen) slots = slots.slice(0, maxOpen);
  return { slots, modalityMap, tabBinding };
}
// 다중 모니터 라운드로빈 카운터(모듈 레벨 — Worklist 세션 동안 유지). 검사를 열 때마다 다음 슬롯.
let viewerRoundRobin = 0;
// 마지막 openV2 로 연 뷰어 창들(이름→핸들). 라운드로빈 대상 판정·고아 창 정리·닫힘 감지에 사용.
// 최저번호 모니터(슬롯 0)는 표준 이름 "sv_viewer"(ReportWindow ◀▶·관련검사 오픈이 참조), 나머지는
// "sv_viewer_slot{index}".
const openedViewerWindows = new Map<string, Window>();

/** 재사용 창(window.open 의 위치 옵션이 무시됨)도 지정 모니터로 이동/리사이즈 */
function applyWindowBounds(w: Window | null, features: string) {
  if (!w) return;
  const m: Record<string, number> = {};
  for (const kv of features.split(",")) {
    const [k, v] = kv.split("=");
    m[k] = Number(v);
  }
  if ([m.left, m.top, m.width, m.height].some((n) => n === undefined || Number.isNaN(n))) return;
  try { w.moveTo(m.left, m.top); w.resizeTo(m.width, m.height); } catch { /* 권한/브라우저 제약 */ }
}
function hpFor(modality: string): string | undefined {
  return hangingMap[modality] ?? hangingMap.default;
}

const STATUS_LABEL: Record<string, string> = {
  received: "도착", draft_ready: "AI초안", reading: "판독중", finalized: "확정",
  suspended: "보류", draft: "초안", in_review: "검토중",
};
function StatusBadge({ status }: { status: string }) {
  // INFINITT User Guide p.5 Exam Status 매핑 — 색 점 + 툴팁으로 등가 상태 표기
  const inSt = IN_EXAM_STATUSES.find((s) => s.key === IN_STATUS_MAP[status]);
  return (
    <span className={`badge ${status}`}
          title={inSt ? `${inSt.label} — ${inSt.desc}` : undefined}>
      {inSt && <span style={{
        display: "inline-block", width: 7, height: 7, borderRadius: 4,
        background: inSt.color, marginRight: 4, verticalAlign: "middle",
      }} />}
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

/* ── 컬럼 정의 (F-8: 설정에서 구성 가능) ──────────── */
export const COLUMN_DEFS: Record<string, { label: string; render: (r: StudyRow) => React.ReactNode; width?: number }> = {
  // 판독 상태 아이콘 (fixed/read/reading/open/unread + 보조 인디케이터) — 서버 계산 read_state 소비
  read_state: { label: "판독", render: (r) => <ReadStateIcon row={r} /> },
  status: { label: "상태", render: (r) => <StatusBadge status={r.status} /> },
  ai: {
    label: "AI",
    render: (r) =>
      r.critical ? <span className="badge critical">CRITICAL</span>
        : r.report_status === "draft" ? <span className="badge ai">초안</span> : null,
  },
  patient_key: { label: "ID", render: (r) => r.patient_key },
  patient_name: {
    label: "이름",
    // 병합(Merge)된 환자는 이름 앞에 병합 아이콘 표시 (Exam Control 에서 Unmerge 가능)
    render: (r) => <>{r.merged && <MergeIcon />}{r.has_key && <span title="키이미지 등록 검사">🔑 </span>}{r.patient_name}</>,
  },
  sex: { label: "성별", render: (r) => r.sex },
  birth_date: { label: "생년월일", render: (r) => r.birth_date },
  study_date: { label: "검사일", render: (r) => r.study_date },
  modality: { label: "MOD", render: (r) => r.modality },
  body_part: { label: "부위", render: (r) => r.body_part },
  study_desc: { label: "검사명", render: (r) => <span title={r.study_desc}>{r.study_desc}</span> },
  accession_no: { label: "Accession", render: (r) => r.accession_no },
  impression: {
    label: "임프레션 (AI 미리보기)",
    render: (r) => (
      <span style={{ color: "var(--ai)" }} title={r.impression_preview}>{r.impression_preview}</span>
    ),
  },
  series_count: { label: "Srs", render: (r) => r.series_count },
  instance_count: { label: "Img", render: (r) => r.instance_count },
  priority: {
    label: "우선순위",
    render: (r) => (r.emergency ? <span style={{ color: "var(--stat-emergency)" }}>Emergency</span> : "Normal"),
  },
  // DICOM 헤더 기반 확장 컬럼 (UBPACS-Z Filter Setting — Setting>워크리스트에서 USE/NO USE)
  study_time: {
    label: "검사시각",
    render: (r) => (r.study_time ? `${r.study_time.slice(0, 2)}:${r.study_time.slice(2, 4)}` : ""),
  },
  institution: { label: "기관 (Institution)", render: (r) => r.institution },
  referring_physician: { label: "의뢰의 (Ref.Phys)", render: (r) => r.referring_physician },
  finalized_at: {
    label: "판독일시",
    render: (r) => (r.finalized_at ? r.finalized_at.slice(0, 16).replace("T", " ") : ""),
  },
  memo: {
    label: "메모 (MEMO)",
    render: (r) => <span title={r.memo}>{r.memo ? `📝 ${r.memo.slice(0, 24)}` : ""}</span>,
  },
  department: { label: "부서 (DEPT)", render: (r) => r.department },
  source_aet: { label: "AE TITLE", render: (r) => r.source_aet },
  bookmark: {
    label: "★",
    render: (r) => (r.bookmark ? <span style={{ color: "#f6c244" }}>★</span> : ""),
  },
  order_name: { label: "오더명 (ORDER NAME)", render: (r) => r.order_name },
};
export const DEFAULT_COLUMNS = [
  "read_state", "status", "ai", "patient_key", "patient_name", "sex", "study_date",
  "modality", "body_part", "study_desc", "impression", "series_count", "instance_count", "priority",
];
// Infi(INFINITT) 컬럼 순서 — 원본 Exam List: Status | ID | Name | Sex | Study Date | MOD | Srs | Img | Body | Desc | AETitle
export const INFI_COLUMNS = [
  "read_state", "status", "patient_key", "patient_name", "sex", "study_date",
  "modality", "series_count", "instance_count", "body_part", "study_desc", "source_aet",
];
// 컬럼별 폭(px) — Infi 그리드 비율 (없으면 auto)
const INFI_COL_WIDTH: Record<string, number> = {
  read_state: 52, status: 74, patient_key: 96, patient_name: 130, sex: 40, study_date: 92,
  modality: 46, series_count: 42, instance_count: 46, body_part: 84, source_aet: 90,
};
// SAINT VIEW 컬럼 순서 (그림1 Exam List: 검사상태 | 검사일 | 센터명 | 환자명 | 환자ID | 장비 | 시각 | 배정의사 | 부위 | 병원명)
export const SV_COLUMNS = [
  "read_state", "status", "study_date", "institution", "patient_name", "patient_key",
  "modality", "study_time", "referring_physician", "body_part", "source_aet",
];

/* ── 유효 권한 게이트 (레인 W) — 액션별 필요 권한 키 (병원 매트릭스 perm/me) ──
 * 서버가 이미 403 을 강제하므로 이 UI 게이트는 UX(사전 비활성+안내) 목적이다.
 * 매핑이 없는 액션 = 조회성(검색·조회·뷰어 열기) → 항상 허용.
 * staff(Medician)는 worklist.view/report.read 만 보유 → 아래 액션 전부 비활성. */
const ACTION_PERM: Record<string, string> = {
  pdf: "report.print",          // 판독 출력(PDF)
  print: "image.print",         // 영상 출력(화면 인쇄)
  import: "study.import",       // 영상 추가(Import DICOM)
  batch: "report.write",        // AI 초안 일괄 확정(판독 변경)
  regen: "report.write",        // AI 초안 재생성
  copyreport: "report.write",   // 과거 판독 복사(초안 수정)
  emergency: "report.write",    // 응급 우선순위(판독 워크플로 변경)
  adm_match: "study.match",     // 오더 매칭
  adm_unmatch: "study.unmatch", // 언매칭
  adm_move: "study.move",       // 검사 이동(재귀속)
  adm_copy: "study.copy",       // 검사 복제
  adm_delete: "study.delete",   // 검사 삭제
};

/** perm/me 훅 — loadPermMe 캐시로 창당 1회만 조회. null=폴백(전 기능 허용) */
function usePermMe(): PermMe | null {
  const [me, setMe] = useState<PermMe | null>(null);
  useEffect(() => { loadPermMe().then(setMe).catch(() => {}); }, []);
  return me;
}

/* ── [A] 액션 툴바 ─────────────────────────────── */
function ActionToolbar({
  selected, onAction, searchText, setSearchText, onSearch, onNlSearch,
  withOpen, setWithOpen, withOpenMode, setWithOpenMode, ohifOn = false, allowed,
}: {
  selected: StudyDetail | null;
  onAction: (a: string) => void;
  searchText: string;
  setSearchText: (s: string) => void;
  onSearch: () => void;
  onNlSearch: (text: string) => void;
  withOpen: boolean;
  setWithOpen: (b: boolean) => void;
  withOpenMode: "add" | "stack";
  setWithOpenMode: (m: "add" | "stack") => void;
  ohifOn?: boolean;   // OHIF 아이콘 표시 여부 (설정>뷰어 — 기본 숨김)
  allowed?: (a: string) => boolean;   // 유효 권한 게이트(레인 W) — 서버 403 이 최종 방어선
}) {
  const need = !selected;
  const [nlText, setNlText] = useState("");
  const Btn = ({ a, label, primary, title }: { a: string; label: string; primary?: boolean; title?: string }) => {
    const ok = allowed ? allowed(a) : true;   // 권한 없음 → 비활성 + 안내 툴팁 (UX 목적)
    return (
      <button className={primary ? "primary" : ""}
              disabled={(need && a !== "batch" && a !== "refresh") || !ok}
              title={ok ? title : PERM_DENIED_TIP} onClick={() => onAction(a)}>
        {label}
      </button>
    );
  };
  return (
    <div style={{
      display: "flex", gap: 5, padding: "6px 8px", alignItems: "center",
      background: "var(--bg-panel)", borderBottom: "1px solid var(--border)",
    }}>
      <Btn a="viewdraft" label="View&Draft" primary title="뷰어 + 초안 패널 동시 오픈 (더블클릭과 동일)" />
      <Btn a="3d" label="3D" title="내장 Cornerstone3D MPR/MIP" />
      <span style={{ width: 1, alignSelf: "stretch", background: "var(--border)", margin: "0 3px" }} />
      {/* UBPACS-Z Study Open 5종 */}
      <Btn a="ub_view" label="🖵 View" title="① View — 기존 영상을 닫고 선택 검사를 그 자리에 표시 (UBPACS-Z)" />
      <Btn a="ub_add" label="🖵+ Add" title="② Add View — 기존 영상은 닫지 않고 선택 검사를 분할 추가" />
      <Btn a="ub_stack" label="⧉ Stack" title="③ Stack View — 기존 영상 유지 + 선택 검사를 같은 페인에 중첩" />
      {ohifOn && <Btn a="ub_adv" label="⌂ Adv" title="④ Advance View — 고급 뷰어(OHIF)로 열기" />}
      <Btn a="ub_key" label="🔑 Key" title="⑤ Key Image View — 선택 검사의 키 이미지만 표시 (F-16)" />
      <Btn a="compareOpen" label="⇄ Compare" title="Compare — 뷰어에서 같은 환자의 과거검사를 골라 나란히 비교(모달, In Viewer 동일)" />
      {/* Study With Open (p.13): 더블클릭 시 Related Study를 함께 오픈 */}
      <label title="Study With Open — 더블클릭으로 열 때 Related Study List의 검사를 한번에 같이 오픈"
             style={{ display: "flex", gap: 3, alignItems: "center", fontSize: 11.5, marginLeft: 3 }}>
        <input type="checkbox" checked={withOpen} onChange={(e) => setWithOpen(e.target.checked)} />
        With Open
      </label>
      <select value={withOpenMode} disabled={!withOpen} title="함께 오픈 모드"
              onChange={(e) => setWithOpenMode(e.target.value as "add" | "stack")}
              style={{ fontSize: 10.5 }}>
        <option value="add">ADD VIEW</option>
        <option value="stack">STACK VIEW</option>
      </select>
      {/* Reading/Import/Export/Print/PDF/Emergency/AI/일괄검토/새로고침은 상단 탭 바(Local Server 왼쪽)로 이동(요청) */}
      <div style={{ flex: 1 }} />
      {/* 07 A.2 SearchShortcut: 검색 바로가기 저장/적용 */}
      <select title="검색 바로가기" defaultValue="" onChange={(e) => {
        const sc = JSON.parse(localStorage.getItem("sv_shortcuts") ?? "[]")
          .find((s: { label: string }) => s.label === e.target.value);
        if (sc) window.dispatchEvent(new CustomEvent("sv-apply-shortcut", { detail: sc }));
        e.target.value = "";
      }}>
        <option value="">바로가기…</option>
        {JSON.parse(localStorage.getItem("sv_shortcuts") ?? "[]").map((s: { label: string }) => (
          <option key={s.label} value={s.label}>{s.label}</option>
        ))}
      </select>
      <button title="현재 검색조건을 바로가기로 저장" onClick={() => {
        window.dispatchEvent(new CustomEvent("sv-save-shortcut"));
      }}>★저장</button>
      {/* S1 자연어 검색 (nl_to_query) — AI 기능이므로 보라 포인트 */}
      <input
        placeholder="AI 검색 — 예: 지난주 흉부 CT 미판독" value={nlText}
        onChange={(e) => setNlText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && nlText.trim()) { onNlSearch(nlText); } }}
        title="자연어로 검색 조건을 입력하면 AI가 필터로 변환합니다 (적용 전 미리보기)"
        style={{ width: 200, background: "var(--bg-canvas)", borderColor: "var(--ai)" }}
      />
      <input
        placeholder="SEARCH — 환자 ID/이름 (=정확 / 접두% / !제외)" value={searchText}
        onChange={(e) => setSearchText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onSearch()}
        style={{ width: 280, background: "var(--bg-canvas)" }}
      />
      <button className="primary" onClick={onSearch}>SEARCH</button>
    </div>
  );
}

/* ── [B] 필드별 검색 필터 바 (Zetta: ID/NAME/SEX/MODALITY/DATE/DESC 개별 콤보) ── */
export const FIND_FIELDS: Record<string, string> = {
  pid: "환자 ID", pname: "환자 이름", sex: "성별", modality: "Modality",
  date: "검사일", desc: "검사명(Description)", body_part: "부위",
  status: "상태", finding: "소견 검색(F-2)", emergency: "Emergency", key: "Key Image",
};
export const DEFAULT_FIND_FIELDS = ["pid", "pname", "sex", "modality", "date", "desc", "status", "finding", "emergency", "key"];

function FilterBar({ filters, setFilters, fields, onSearch }: {
  filters: Record<string, string>;
  setFilters: (f: Record<string, string>) => void;
  fields: string[];
  onSearch: () => void;
}) {
  const set = (k: string, v: string) => setFilters({ ...filters, [k]: v });
  const enter = (e: React.KeyboardEvent) => e.key === "Enter" && onSearch();
  const F = (key: string) => {
    switch (key) {
      case "pid":
        return <input key={key} placeholder="*Any 환자 ID" value={filters.pid ?? ""} style={{ width: 110 }}
                      onChange={(e) => set("pid", e.target.value)} onKeyDown={enter} />;
      case "pname":
        return <input key={key} placeholder="*Any 이름" value={filters.pname ?? ""} style={{ width: 110 }}
                      onChange={(e) => set("pname", e.target.value)} onKeyDown={enter} />;
      case "sex":
        return (
          <select key={key} value={filters.sex ?? ""} onChange={(e) => set("sex", e.target.value)}>
            <option value="">*Any 성별</option><option value="M">M</option>
            <option value="F">F</option><option value="O">O</option>
          </select>
        );
      case "modality":
        return (
          <select key={key} value={filters.modality ?? ""} onChange={(e) => set("modality", e.target.value)}>
            <option value="">*Any Modality</option>
            {["CR", "CT", "MR", "US", "MG", "XA", "NM", "DX", "ES", "RF", "OT"].map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        );
      case "date":
        return (
          <span key={key} style={{ display: "flex", gap: 3, alignItems: "center" }}>
            <input type="date" value={filters.date_from_iso ?? ""} title="검사일 From"
                   onChange={(e) => set("date_from_iso", e.target.value)} />
            <span style={{ color: "var(--text-secondary)" }}>~</span>
            <input type="date" value={filters.date_to_iso ?? ""} title="검사일 To"
                   onChange={(e) => set("date_to_iso", e.target.value)} />
          </span>
        );
      case "desc":
        return <input key={key} placeholder="*Any 검사명" value={filters.desc ?? ""} style={{ width: 140 }}
                      onChange={(e) => set("desc", e.target.value)} onKeyDown={enter} />;
      case "body_part":
        return <input key={key} placeholder="*Any 부위" value={filters.body_part ?? ""} style={{ width: 90 }}
                      onChange={(e) => set("body_part", e.target.value)} onKeyDown={enter} />;
      case "status":
        return (
          <select key={key} value={filters.status ?? ""} onChange={(e) => set("status", e.target.value)}>
            <option value="">*Any 상태</option><option value="unread">미판독(확정 전)</option>
            <option value="received">도착</option>
            <option value="draft_ready">AI초안</option><option value="reading">판독중</option>
            <option value="finalized">확정</option>
          </select>
        );
      case "finding":
        return <input key={key} placeholder="소견/임프레션 검색 (F-2)" value={filters.finding ?? ""}
                      style={{ width: 180 }} onChange={(e) => set("finding", e.target.value)} onKeyDown={enter} />;
      case "emergency":
        return (
          <label key={key} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
            <input type="checkbox" checked={filters.emergency === "true"}
                   onChange={(e) => set("emergency", e.target.checked ? "true" : "")} />
            ⚠ Emergency
          </label>
        );
      case "key":
        return (
          <label key={key} title="키이미지가 등록된 검사만 조회 (F-16)"
                 style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
            <input type="checkbox" checked={filters.key === "true"}
                   onChange={(e) => set("key", e.target.checked ? "true" : "")} />
            🔑 Key
          </label>
        );
      default: return null;
    }
  };
  return (
    <div style={{
      display: "flex", gap: 6, padding: "5px 8px", background: "var(--bg-panel)",
      borderBottom: "1px solid var(--border)", alignItems: "center", flexWrap: "wrap",
    }}>
      {fields.map(F)}
    </div>
  );
}

/* ── [C-좌] 검색 레일: 기간 프리셋 + 검색 폴더 트리 (UBPACS-Z Search Filter) ── */
const DATE_PRESETS = [
  { key: "today", label: "Today", days: 0 },
  { key: "3d", label: "최근 3일", days: 3 },
  { key: "1w", label: "최근 1주", days: 7 },
  { key: "1m", label: "최근 1개월", days: 30 },
  { key: "all", label: "전체", days: -1 },
];
function SearchRail({ active, onPick, tree, width, mods, activeMod, onMod, unifiedScroll }: {
  active: string; onPick: (key: string, from: string) => void; tree: React.ReactNode; width: number;
  mods: Record<string, number>; activeMod: string; onMod: (m: string) => void;
  // true 면 섹션별 개별 스크롤(30vh/22vh) 대신 레일 전체가 한 번에 스크롤(In/SAINT VIEW 좌열).
  unifiedScroll?: boolean;
}) {
  const total = Object.values(mods).reduce((a, b) => a + b, 0);
  const [favTick, setFavTick] = useState(0);   // Favorites 편집(이름변경/삭제) 후 재렌더
  const favs = (JSON.parse(localStorage.getItem("sv_shortcuts") ?? "[]") as
    { label: string; filters?: Record<string, string>; searchText?: string }[]);
  const saveFavs = (list: typeof favs) => {
    localStorage.setItem("sv_shortcuts", JSON.stringify(list));
    setFavTick(favTick + 1);
  };

  // ── 기간·Search Filter 사용자 편집 (계정 저장: worklist.prefs) ──
  const [dpCustom, setDpCustom] = useState<{ key: string; label: string; days: number }[] | null>(null);
  const [modList, setModList] = useState<string[] | null>(null);   // null = 자동(데이터 집계)
  useEffect(() => {
    api.getSetting("worklist.prefs").then((r) => {
      const v = r.value as { date_presets?: { key: string; label: string; days: number }[]; mod_filters?: string[] };
      if (v.date_presets?.length) setDpCustom(v.date_presets);
      if (v.mod_filters) setModList(v.mod_filters);
    }).catch(() => {});
  }, []);
  const persistRail = (patch: Record<string, unknown>) => {
    api.getSetting("worklist.prefs").then((r) =>
      api.putSetting("worklist.prefs", { ...r.value, ...patch }, "user")).catch(() => {});
  };
  const presets = dpCustom ?? DATE_PRESETS;
  const askPreset = (init?: { label: string; days: number }) => {
    const label = prompt("기간 이름", init?.label ?? "");
    if (!label) return null;
    const ds = prompt("일수 (0=오늘, 숫자=최근 N일, -1=전체)", String(init?.days ?? 7));
    if (ds === null) return null;
    const days = Number(ds);
    if (Number.isNaN(days)) { alert("숫자를 입력하세요"); return null; }
    return { label, days };
  };
  const saveDp = (next: { key: string; label: string; days: number }[]) => {
    setDpCustom(next);
    persistRail({ date_presets: next });
  };
  const shownMods = modList ?? Object.keys(mods).sort((a, b) => a.localeCompare(b));
  const saveMods = (next: string[]) => {
    setModList(next);
    persistRail({ mod_filters: next });
  };
  // 섹션별 편집 모드 — 헤더의 ✏️ 아이콘을 눌렀을 때만 행에 연필/휴지통 표시
  const [editSec, setEditSec] = useState<{ dp?: boolean; mods?: boolean; favs?: boolean }>({});
  const EditToggle = ({ k }: { k: "dp" | "mods" | "favs" }) => (
    <button title={editSec[k] ? "편집 모드 끄기" : "편집 모드 — 행별 수정(연필)/삭제(휴지통) 표시"}
            style={{ padding: "0 6px", fontSize: 10.5,
                     background: editSec[k] ? "var(--accent)" : undefined,
                     color: editSec[k] ? "#fff" : undefined }}
            onClick={() => setEditSec((p) => ({ ...p, [k]: !p[k] }))}>✏️</button>
  );

  const pick = (p: { key: string; days: number }) => {
    if (p.days < 0) return onPick(p.key, "");
    const d = new Date();
    d.setDate(d.getDate() - p.days);
    onPick(p.key, d.toISOString().slice(0, 10).replaceAll("-", ""));
  };
  return (
    <div style={{
      width, background: "var(--bg-panel)", borderRight: "1px solid var(--border)",
      padding: 6, display: "flex", flexDirection: "column", gap: 2, flexShrink: 0, minHeight: 0,
      // 레일 전체 스크롤 — 섹션(기간·Search Filter·Favorites·검색 폴더)이 늘어나도 끝까지 보이게.
      // unifiedScroll(In/SV 좌열)은 바깥 래퍼가 스크롤하므로 중복 방지.
      ...(unifiedScroll ? {} : { overflowY: "auto" as const, maxHeight: "100%" }),
    }}>
      <div style={{ fontSize: 10.5, color: "var(--text-secondary)", fontWeight: 700, padding: "2px 4px",
                    display: "flex", alignItems: "center" }}>
        기간
        <span style={{ marginLeft: "auto", display: "flex", gap: 2 }}>
          <EditToggle k="dp" />
          <button title="기간 프리셋 추가" style={{ padding: "0 6px", fontSize: 10.5 }}
                  onClick={() => {
                    const r = askPreset();
                    if (r) saveDp([...presets, { key: `c${Math.random().toString(36).slice(2, 8)}`, ...r }]);
                  }}>＋</button>
        </span>
      </div>
      {presets.map((p, i) => (
        <div key={p.key} onClick={() => pick(p)}
             style={{
               padding: "3px 8px", borderRadius: 3, cursor: "pointer", fontSize: 12.5,
               display: "flex", alignItems: "center", gap: 4,
               background: active === p.key ? "var(--accent-subtle)" : undefined,
               color: active === p.key ? "var(--text-primary)" : "var(--text-secondary)",
             }}>
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {p.label}
          </span>
          {editSec.dp && (
            <>
              <span title="수정" style={{ flexShrink: 0 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      const r = askPreset(p);
                      if (r) saveDp(presets.map((x, k) => (k === i ? { ...x, ...r } : x)));
                    }}>✏️</span>
              <span title="삭제" style={{ flexShrink: 0 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm(`'${p.label}' 기간을 삭제할까요?`)) {
                        saveDp(presets.filter((_, k) => k !== i));
                      }
                    }}>🗑️</span>
            </>
          )}
        </div>
      ))}
      {/* INFINITT User Guide p.5 ⑦ Search Filter — 모달리티 트리 */}
      <div style={{
        fontSize: 10.5, color: "var(--text-secondary)", fontWeight: 700,
        padding: "6px 4px 2px", borderTop: "1px solid var(--border)", marginTop: 4,
        display: "flex", alignItems: "center",
      }}>
        Search Filter
        <span style={{ marginLeft: "auto", display: "flex", gap: 2 }}>
          <EditToggle k="mods" />
          <button title="모달리티 필터 추가 (예: US, MG)" style={{ padding: "0 6px", fontSize: 10.5 }}
                  onClick={() => {
                    const code = prompt("추가할 Modality 코드 (예: US, MG, XA)");
                    if (!code) return;
                    const c = code.trim().toUpperCase();
                    if (shownMods.includes(c)) { alert("이미 목록에 있습니다"); return; }
                    saveMods([...shownMods, c]);
                  }}>＋</button>
          {modList && (
            <button title="자동 목록으로 되돌리기 (데이터 집계)" style={{ padding: "0 6px", fontSize: 10.5 }}
                    onClick={() => { setModList(null); persistRail({ mod_filters: null }); }}>↺</button>
          )}
        </span>
      </div>
      {/* 항목이 늘어나도 섹션 안에서 스크롤 (unifiedScroll 이면 레일 전체 스크롤에 맡김) */}
      <div style={unifiedScroll ? { flexShrink: 0 } : { maxHeight: "30vh", overflowY: "auto", flexShrink: 0 }}>
        <div onClick={() => onMod("")}
             style={{
               padding: "3px 8px", borderRadius: 3, cursor: "pointer", fontSize: 12.5,
               display: "flex", justifyContent: "space-between",
               background: activeMod === "" ? "var(--accent-subtle)" : undefined,
               color: activeMod === "" ? "var(--text-primary)" : "var(--text-secondary)",
             }}>
          <span>📁 전체</span><span style={{ fontSize: 11 }}>{total}</span>
        </div>
        {shownMods.map((m, i) => (
          <div key={m} onClick={() => onMod(activeMod === m ? "" : m)}
               style={{
                 padding: "3px 8px 3px 18px", borderRadius: 3, cursor: "pointer", fontSize: 12.5,
                 display: "flex", alignItems: "center", gap: 4,
                 background: activeMod === m ? "var(--accent-subtle)" : undefined,
                 color: activeMod === m ? "var(--text-primary)" : "var(--text-secondary)",
               }}>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {m || "(없음)"}
            </span>
            <span style={{ fontSize: 11, flexShrink: 0 }}>{mods[m] ?? 0}</span>
            {editSec.mods && (
              <>
                <span title="코드 수정" style={{ flexShrink: 0 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        const code = prompt("Modality 코드 수정", m);
                        if (!code || code.trim().toUpperCase() === m) return;
                        saveMods(shownMods.map((x, k) => (k === i ? code.trim().toUpperCase() : x)));
                      }}>✏️</span>
                <span title="목록에서 제거" style={{ flexShrink: 0 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`'${m || "(없음)"}' 필터를 목록에서 제거할까요?`)) {
                          saveMods(shownMods.filter((_, k) => k !== i));
                        }
                      }}>🗑️</span>
              </>
            )}
          </div>
        ))}
      </div>
      {/* INFINITT Guide ⑦ Favorites — 저장된 검색 바로가기(★저장) 원클릭 적용 */}
      <div style={{
        fontSize: 10.5, color: "var(--text-secondary)", fontWeight: 700,
        padding: "6px 4px 2px", borderTop: "1px solid var(--border)", marginTop: 4,
        display: "flex", alignItems: "center",
      }}>
        Favorites
        <span style={{ marginLeft: "auto", display: "flex", gap: 2 }}>
          <EditToggle k="favs" />
          <button title="현재 검색조건을 바로가기로 추가 (툴바 ★저장과 동일)"
                  style={{ padding: "0 6px", fontSize: 10.5 }}
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent("sv-save-shortcut"));
                    setTimeout(() => setFavTick((t) => t + 1), 300);   // 저장 후 목록 갱신
                  }}>＋</button>
        </span>
      </div>
      <div style={unifiedScroll ? { flexShrink: 0 } : { maxHeight: "22vh", overflowY: "auto", flexShrink: 0 }}>
        {favs.length === 0 && (
          <div style={{ padding: "2px 8px", fontSize: 11, color: "var(--text-secondary)" }}>
            툴바 ★저장으로 현재 검색조건 등록
          </div>
        )}
        {favs.map((s, i) => (
          <div key={`${s.label}-${favTick}`}
               onClick={() => window.dispatchEvent(new CustomEvent("sv-apply-shortcut", { detail: s }))}
               title={`클릭=적용 (헤더 ✏️=편집 모드 — 이름 변경/삭제)\n같은 이름으로 ★저장하면 조건이 덮어써집니다`}
               className="sv-fav-row"
               style={{ padding: "3px 8px", borderRadius: 3, cursor: "pointer", fontSize: 12.5,
                        color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              ⭐ {s.label}
            </span>
            {editSec.favs && (
              <>
                <span title="이름 변경" style={{ flexShrink: 0 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        const nn = prompt("바로가기 이름 변경", s.label);
                        if (!nn || nn === s.label) return;
                        saveFavs(favs.map((f, k) => (k === i ? { ...f, label: nn } : f)));
                      }}>✏️</span>
                <span title="삭제" style={{ flexShrink: 0 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`'${s.label}' 바로가기를 삭제할까요?`)) {
                          saveFavs(favs.filter((_, k) => k !== i));
                        }
                      }}>🗑️</span>
              </>
            )}
          </div>
        ))}
      </div>
      <div style={{
        fontSize: 10.5, color: "var(--text-secondary)", fontWeight: 700,
        padding: "6px 4px 2px", borderTop: "1px solid var(--border)", marginTop: 4,
      }}>
        검색 폴더
      </div>
      <div style={unifiedScroll
        ? { flexShrink: 0, display: "flex", flexDirection: "column" }
        : { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>{tree}</div>
    </div>
  );
}

/* ── 서버 선택 버튼 (탭 바 우측) — Local Server: 로컬 PACS 모드 전환+폴더 보기 / Web Server: 주소·포트 ──
 * mode 는 워크리스트 데이터 소스 전환(레인 F)을 위해 부모(Worklist)가 소유한다. */
function ServerButtons({ mode, onMode }: {
  mode: "local" | "web" | null;
  onMode: (m: "local" | "web") => void;
}) {
  const [open, setOpen] = useState<null | "local" | "web">(null);
  const [net, setNet] = useState<ServerNetwork>({});
  const [files, setFiles] = useState<{ name: string; is_dir: boolean; size: number; mtime: number }[]>([]);
  const [shareDir, setShareDir] = useState("");
  const [sub, setSub] = useState("");   // 공유 루트 기준 현재 상대경로("" = 루트) — 하위 폴더 탐색
  const [err, setErr] = useState("");

  // 공유 폴더 목록 조회 — s=상대 하위경로(빈값=루트). 이미지 데이터 폴더 구조 탐색 지원
  const openLocal = (s: string) => {
    api.shareList(s || undefined)
      .then((r) => { setFiles(r.items); setShareDir(r.dir); setSub(r.sub); setErr(""); })
      .catch((e) => { setFiles([]); setErr(e instanceof Error ? e.message : "조회 실패"); });
  };

  useEffect(() => {
    // 팝업을 열 때마다 최신 설정을 다시 읽는다 — 설정>서버 네트워크 저장 직후에도 반영
    api.getSetting("server.network").then((r) => setNet(r.value as ServerNetwork)).catch(() => {});
  }, [open]);

  const pick = (m: "local" | "web") => {
    onMode(m);
    setErr("");
    if (open === m) { setOpen(null); return; }
    setOpen(m);
    if (m === "local") { setShareDir(""); setSub(""); openLocal(""); }
  };
  const fmtSize = (n: number) => n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : n > 1024 ? `${(n / 1024).toFixed(0)}KB` : `${n}B`;

  return (
    <span style={{ position: "relative", display: "flex", gap: 3, alignSelf: "center" }}>
      <button onClick={() => pick("local")}
              title="Local Server — 로컬 PACS 모드로 전환(서버 데이터 숨김) + 공유 폴더 보기 (설정>서버 네트워크에서 디렉토리 지정)"
              style={{ padding: "2px 10px", fontSize: 11, fontWeight: 700,
                       background: mode === "local" ? "var(--accent)" : undefined,
                       color: mode === "local" ? "#fff" : undefined }}>
        Local Server
      </button>
      <button onClick={() => pick("web")}
              title="Web Server — 서버 주소·포트 확인 (설정>서버 네트워크)"
              style={{ padding: "2px 10px", fontSize: 11, fontWeight: 700,
                       background: mode === "web" ? "var(--accent)" : undefined,
                       color: mode === "web" ? "#fff" : undefined }}>
        Web Server
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "100%", right: 0, zIndex: 360, minWidth: 320, maxHeight: 320,
          overflow: "auto", background: "var(--bg-elevated)", border: "1px solid var(--border)",
          borderRadius: 6, boxShadow: "0 6px 20px rgba(0,0,0,0.5)", padding: 10, fontSize: 12,
        }} onMouseLeave={() => setOpen(null)}>
          {open === "local" ? (
            <>
              <b>Local Server — 폴더 공유</b>
              {err ? (
                <div style={{ color: "var(--stat-emergency)", marginTop: 6 }}>{err}</div>
              ) : (
                <>
                  <div style={{ display: "flex", gap: 5, alignItems: "center", margin: "5px 0", color: "var(--text-secondary)" }}>
                    <code style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}
                          title={sub ? `${shareDir}\\${sub.replace(/\//g, "\\")}` : shareDir}>
                      {shareDir}
                    </code>
                    <MiniBtn onClick={() => navigator.clipboard?.writeText(sub ? `${shareDir}\\${sub.replace(/\//g, "\\")}` : shareDir)}>경로 복사</MiniBtn>
                  </div>
                  {/* 브레드크럼 — 루트/하위 폴더 경로 표시, 각 조각 클릭=해당 폴더로 이동, ⬆=상위 */}
                  <div style={{ display: "flex", gap: 3, alignItems: "center", flexWrap: "wrap",
                                margin: "0 0 5px", fontSize: 11 }}>
                    <MiniBtn onClick={() => openLocal(sub.split("/").slice(0, -1).join("/"))}
                             disabled={!sub} title="상위 폴더로">⬆ 상위</MiniBtn>
                    <span style={{ cursor: sub ? "pointer" : undefined, fontWeight: sub ? 400 : 700 }}
                          onClick={() => sub && openLocal("")}>루트</span>
                    {sub && sub.split("/").map((seg, i, arr) => (
                      <span key={i} style={{ display: "flex", gap: 3, alignItems: "center" }}>
                        <span style={{ color: "var(--text-secondary)" }}>›</span>
                        <span style={{ cursor: i < arr.length - 1 ? "pointer" : undefined,
                                       fontWeight: i === arr.length - 1 ? 700 : 400 }}
                              onClick={() => i < arr.length - 1 && openLocal(arr.slice(0, i + 1).join("/"))}>
                          {seg}
                        </span>
                      </span>
                    ))}
                  </div>
                  <table className="grid-table">
                    <thead><tr><th>이름</th><th style={{ width: 64 }}>크기</th></tr></thead>
                    <tbody>
                      {files.slice(0, 20).map((f) => {
                        const rel = sub ? `${sub}/${f.name}` : f.name;   // 루트 기준 상대경로
                        const isImg = /\.(jpe?g|png|bmp|gif)$/i.test(f.name);   // 이미지 미리보기 아이콘
                        return (
                          <tr key={f.name} style={{ cursor: "pointer" }}
                              title={f.is_dir ? "클릭 = 폴더 진입" : "클릭 = 다운로드"}
                              onClick={() => {
                                if (f.is_dir) { openLocal(rel); return; }
                                window.open(`${(import.meta.env.VITE_API_BASE ?? "http://localhost:8000")}/api/share/file?name=${encodeURIComponent(rel)}`, "_blank");
                              }}>
                            <td>{f.is_dir ? "📁" : isImg ? "🖼" : "📄"} {f.name}</td>
                            <td>{f.is_dir ? "-" : fmtSize(f.size)}</td>
                          </tr>
                        );
                      })}
                      {files.length === 0 && <tr><td colSpan={2} style={{ color: "var(--text-secondary)" }}>비어 있음</td></tr>}
                    </tbody>
                  </table>
                </>
              )}
            </>
          ) : (
            <>
              <b>Web Server</b>
              <table className="grid-table" style={{ marginTop: 6 }}>
                <tbody>
                  <tr><th style={{ width: 80 }}>주소(IP)</th><td>{net.web?.ip || "(미설정)"}</td></tr>
                  <tr><th>Port</th><td>{net.web?.port || "(미설정)"}</td></tr>
                  <tr><th>Name</th><td>{net.web?.name || "-"}</td></tr>
                  <tr><th>AE Title</th><td>{net.web?.ae_title || "-"}</td></tr>
                </tbody>
              </table>
              <div style={{ marginTop: 5, color: "var(--text-secondary)", fontSize: 11 }}>
                설정 변경·Ping/Echo/DB 테스트는 설정 &gt; 서버 네트워크에서.
              </div>
            </>
          )}
        </div>
      )}
    </span>
  );
}

/* ── 워크리스트 페이지 탭 바 (UBPACS-Z — 저장된 검색 정의를 페이지로, 최대 10) ── */
function WorklistTabsBar({ tabs, activeId, onPick, onAdd, onRemove, actions, serverMode, onServerMode, extraTab }: {
  tabs: WorklistTab[]; activeId: string;
  onPick: (t: WorklistTab) => void; onAdd: () => void; onRemove: (id: string) => void;
  actions?: React.ReactNode;  // Local Server 왼쪽에 노출할 액션 버튼 그룹
  serverMode: "local" | "web" | null;              // 데이터 소스 모드 (레인 F — Worklist 소유)
  onServerMode: (m: "local" | "web") => void;
  extraTab?: React.ReactNode; // WORKLIST 탭들 옆 추가 탭 (관리자 EXAM CONTROL — 레인 F)
}) {
  return (
    <div style={{
      display: "flex", gap: 2, padding: "4px 8px 0", alignItems: "flex-end",
      background: "var(--bg-canvas)", borderBottom: "1px solid var(--border)",
    }}>
      {tabs.map((t) => (
        <div key={t.id} onClick={() => onPick(t)} title={folderSummary(t.filter)}
             style={{
               display: "flex", alignItems: "center", gap: 6, padding: "4px 11px",
               borderRadius: "4px 4px 0 0", cursor: "pointer", fontSize: 11.5, fontWeight: 700,
               background: t.id === activeId ? "var(--accent)" : "var(--bg-elevated)",
               color: t.id === activeId ? "#fff" : "var(--text-secondary)",
               border: "1px solid var(--border)", borderBottom: "none", whiteSpace: "nowrap",
             }}>
          {t.label.toUpperCase()}
          {t.id !== "default" && (
            <span title="페이지 삭제" onClick={(e) => { e.stopPropagation(); onRemove(t.id); }}
                  style={{ fontSize: 10, opacity: 0.75 }}>✕</span>
          )}
        </div>
      ))}
      {extraTab}
      <button onClick={onAdd} title="현재 검색조건을 새 페이지로 등록 (최대 10 — UBPACS-Z)"
              style={{ padding: "1px 9px", fontSize: 13, marginLeft: 4, marginBottom: 3 }}>＋</button>
      {/* 우측 그룹: 액션 버튼(요청 — Local Server 왼쪽) + 서버 버튼 */}
      <span style={{ marginLeft: "auto", display: "flex", gap: 3, alignItems: "center", alignSelf: "center" }}>
        {actions}
        <ServerButtons mode={serverMode} onMode={onServerMode} />
      </span>
    </div>
  );
}

/* ── [C] 메인 검사 그리드 (컬럼 구성형) ───────────── */
function StudyGrid({
  items, columns, selectedId, selectedIds, onSelect, onOpen, onContext, variant, treeDisabled,
}: {
  items: StudyRow[];
  columns: string[];
  selectedId: number | null;
  selectedIds?: Set<number>;   // 다중선택 집합(Shift 범위/Ctrl 토글). 없으면 단일(selectedId)만.
  onSelect: (row: StudyRow, e?: React.MouseEvent) => void;
  onOpen: (row: StudyRow) => void;
  onContext: (e: React.MouseEvent, row: StudyRow) => void;
  variant?: "infi";
  /** LOCAL 모드 — Series 펼침(＋)은 서버 seriesTree 라 숨김(로컬 id 오호출 방지) */
  treeDisabled?: boolean;
}) {
  const infi = variant === "infi";
  // Exam → Series → Image 계층 확장: '＋' 클릭=아래로 전개('−'로 전환), 다시 클릭=접기
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [expSeries, setExpSeries] = useState<Set<string>>(new Set());
  const [trees, setTrees] = useState<Record<number, SeriesNode[] | null>>({});   // null=로딩 중
  const toggleExam = (id: number) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) { n.delete(id); return n; }
      n.add(id);
      if (trees[id] === undefined) {
        setTrees((t) => ({ ...t, [id]: null }));
        api.seriesTree(id)
          .then((r) => setTrees((t) => ({ ...t, [id]: r.series })))
          .catch(() => setTrees((t) => ({ ...t, [id]: [] })));
      }
      return n;
    });
  };
  const toggleSeries = (uid: string) => setExpSeries((prev) => {
    const n = new Set(prev);
    if (n.has(uid)) n.delete(uid); else n.add(uid);
    return n;
  });
  const span = columns.length + 2;   // 토글 + # + 컬럼들
  const markStyle: React.CSSProperties = {
    cursor: "pointer", color: "var(--accent)", fontWeight: 700, userSelect: "none",
  };
  return (
    <div style={{ overflow: "auto", flex: 1, minWidth: 0 }}>
      <table className={infi ? "grid-table grid-infi" : "grid-table"}>
        <thead>
          <tr>
            <th style={{ width: 22 }} />
            <th style={{ width: 30 }}>#</th>
            {columns.map((c) => (
              <th key={c} style={infi && INFI_COL_WIDTH[c] ? { width: INFI_COL_WIDTH[c] } : undefined}>
                {COLUMN_DEFS[c]?.label ?? c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((row, i) => (
            <Fragment key={row.id}>
              <tr className={[(row.id === selectedId || selectedIds?.has(row.id)) ? "selected" : "", row.emergency ? "emergency" : ""].join(" ")}
                  onClick={(e) => onSelect(row, e)}
                  onDoubleClick={() => onOpen(row)}
                  onContextMenu={(e) => { e.preventDefault(); onSelect(row, e); onContext(e, row); }}
                  style={{ userSelect: "none" }}>
                {treeDisabled ? (
                  <td onDoubleClick={(e) => e.stopPropagation()} />
                ) : (
                  <td style={{ ...markStyle, textAlign: "center" }}
                      title={expanded.has(row.id) ? "접기" : "Series/Image 펼치기"}
                      onClick={(e) => { e.stopPropagation(); toggleExam(row.id); }}
                      onDoubleClick={(e) => e.stopPropagation()}>
                    {expanded.has(row.id) ? "−" : "＋"}
                  </td>
                )}
                <td style={{ color: "var(--text-secondary)" }}>{i + 1}</td>
                {columns.map((c) => <td key={c}>{COLUMN_DEFS[c]?.render(row)}</td>)}
              </tr>
              {/* 1단계: Series 행들 */}
              {!treeDisabled && expanded.has(row.id) && (
                trees[row.id] === null ? (
                  <tr><td /><td colSpan={span - 1}
                          style={{ paddingLeft: 30, fontSize: 11.5, color: "var(--text-secondary)" }}>
                    시리즈 로딩…
                  </td></tr>
                ) : (trees[row.id] ?? []).length === 0 ? (
                  <tr><td /><td colSpan={span - 1}
                          style={{ paddingLeft: 30, fontSize: 11.5, color: "var(--text-secondary)" }}>
                    시리즈 없음
                  </td></tr>
                ) : (trees[row.id] ?? []).map((s, si) => (
                  <Fragment key={s.series_uid}>
                    <tr style={{ background: "rgba(56,108,173,0.10)" }}
                        onDoubleClick={() => onOpen(row)}>
                      <td />
                      <td colSpan={span - 1} style={{ paddingLeft: 26, fontSize: 12 }}>
                        <span style={{ ...markStyle, marginRight: 7 }}
                              title={expSeries.has(s.series_uid) ? "Image 접기" : "Image 펼치기"}
                              onClick={(e) => { e.stopPropagation(); toggleSeries(s.series_uid); }}
                              onDoubleClick={(e) => e.stopPropagation()}>
                          {expSeries.has(s.series_uid) ? "−" : "＋"}
                        </span>
                        📚 Series {s.series_number || si + 1} · {s.modality} · {s.instances.length}장
                        <span style={{ color: "var(--text-secondary)" }}> {s.series_desc}</span>
                      </td>
                    </tr>
                    {/* 2단계: Image(인스턴스) 행들 */}
                    {expSeries.has(s.series_uid) && s.instances.map((inst, ii) => (
                      <tr key={inst.sop_uid} onDoubleClick={() => onOpen(row)}>
                        <td />
                        <td colSpan={span - 1}
                            style={{ paddingLeft: 58, fontSize: 11.5, color: "var(--text-secondary)" }}>
                          🖼 Image {inst.instance_number || ii + 1}
                          {inst.rows ? ` · ${inst.rows}×${inst.cols}px` : ""}
                          <span style={{ opacity: 0.6 }}> · …{inst.sop_uid.slice(-12)}</span>
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))
              )}
            </Fragment>
          ))}
          {items.length === 0 && (
            <tr><td colSpan={span}
                    style={{ color: "var(--text-secondary)", textAlign: "center", padding: 24 }}>
              검사가 없습니다
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ── [D-좌] 과거검사 (선택 환자, F-14) ────────────── */
function PriorStudiesGrid({ detail, onAddCompare }: {
  detail: StudyDetail | null;
  onAddCompare: (e: { id: number; study_uid: string; study_date: string; modality: string; study_desc: string }) => void;
}) {
  return (
    <PanelBox title={`과거검사 ${detail ? `— ${detail.patient_name}` : ""} (더블클릭=비교세트 추가)`}>
      <table className="grid-table">
        <thead><tr><th>검사일</th><th>MOD</th><th>검사명</th><th>상태</th></tr></thead>
        <tbody>
          {(detail?.related_exams ?? []).map((e) => (
            <tr key={e.id} onDoubleClick={() => onAddCompare(e)}>
              <td>{e.study_date}</td><td>{e.modality}</td>
              <td title={e.study_desc}>{e.study_desc}</td>
              <td><StatusBadge status={e.status} /></td>
            </tr>
          ))}
          {(!detail || detail.related_exams.length === 0) && (
            <tr><td colSpan={4} style={{ color: "var(--text-secondary)" }}>
              {detail ? "과거 검사 없음" : "검사를 선택하세요"}
            </td></tr>
          )}
        </tbody>
      </table>
    </PanelBox>
  );
}

/* ── [D-우] 비교세트 (Complementary set) ─────────── */
interface CompareItem { id: number; study_uid: string; study_date: string; modality: string; study_desc: string }
function ComparisonSetGrid({ items, current, onRemove, onOpenCompare, onMerge }: {
  items: CompareItem[];
  current: StudyDetail | null;
  onRemove: (uid: string) => void;
  onOpenCompare: () => void;
  onMerge: () => void;
}) {
  return (
    <PanelBox title="비교세트 (Complementary set)" right={
      <span style={{ display: "flex", gap: 4 }}>
        <button disabled={!current || items.length === 0} onClick={onMerge}
                title="묶음판독(report_merge) — 비교세트 검사들을 현재 검사 판독 하나로 병합"
                style={{ padding: "2px 10px", fontSize: 11.5 }}>
          묶음판독
        </button>
        <button className="primary" disabled={!current || items.length === 0} onClick={onOpenCompare}
                style={{ padding: "2px 10px", fontSize: 11.5 }}>
          비교 열기 ({items.length + (current ? 1 : 0)})
        </button>
      </span>
    }>
      <table className="grid-table">
        <thead><tr><th>검사일</th><th>MOD</th><th>검사명</th><th></th></tr></thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.study_uid}>
              <td>{e.study_date}</td><td>{e.modality}</td>
              <td title={e.study_desc}>{e.study_desc}</td>
              <td><button style={{ padding: "0 7px", fontSize: 11 }} onClick={() => onRemove(e.study_uid)}>✕</button></td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr><td colSpan={4} style={{ color: "var(--text-secondary)" }}>
              과거검사를 더블클릭해 추가 → 현재 검사와 함께 뷰어에서 비교
            </td></tr>
          )}
        </tbody>
      </table>
    </PanelBox>
  );
}

/* ── 상용구 편집 모달 (화면분석 §5.6 — Worklist·Settings 공용) ─────── */
export function PhraseEditModal({ init, defaults, onSave, onClose }: {
  init?: PhraseRow | null;
  defaults?: { modality?: string; body_part?: string };
  onSave: (body: Partial<PhraseRow>) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(init?.name ?? "");
  const [text, setText] = useState(init?.text ?? "");
  const [modality, setModality] = useState(init?.modality ?? defaults?.modality ?? "");
  const [bodyPart, setBodyPart] = useState(init?.body_part ?? defaults?.body_part ?? "");
  const [shortcut, setShortcut] = useState(init?.shortcut ?? "");
  const [err, setErr] = useState("");
  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
      <span style={{ width: 84, color: "var(--text-secondary)", flexShrink: 0 }}>{label}</span>
      {children}
    </label>
  );
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "grid", placeItems: "center", zIndex: 400 }}
         onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8,
                    width: 460, padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
        <b style={{ fontSize: 13 }}>{init ? `상용구 수정 — ${init.name}` : "새 상용구 등록"}</b>
        <Row label="이름 *"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} /></Row>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Row label="장비(MOD)">
            <select value={modality} onChange={(e) => setModality(e.target.value)} style={{ flex: 1 }}>
              <option value="">공통</option>
              {["CR", "DX", "CT", "MR", "US", "MG", "XA", "NM", "ES", "RF"].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </Row>
          <Row label="부위">
            <input value={bodyPart} onChange={(e) => setBodyPart(e.target.value)} placeholder="CHEST… (빈칸=공통)"
                   style={{ flex: 1, minWidth: 0 }} />
          </Row>
        </div>
        <Row label="단축키">
          <input value={shortcut} maxLength={1} onChange={(e) => setShortcut(e.target.value.toUpperCase())}
                 placeholder="영문/숫자 1글자" style={{ width: 90 }} />
          <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>리포트에서 Alt+키로 즉시 삽입</span>
        </Row>
        <Row label="본문 *">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5}
                    style={{ flex: 1, background: "var(--bg-canvas)", color: "var(--text-primary)",
                             border: "1px solid var(--border)", borderRadius: 3, padding: 5,
                             fontFamily: "inherit", fontSize: 12.5, resize: "vertical" }} />
        </Row>
        {err && <div style={{ color: "var(--stat-emergency)", fontSize: 12 }}>{err}</div>}
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <button className="primary" disabled={!name.trim() || !text.trim()}
                  onClick={async () => {
                    try {
                      await onSave({ name, text, modality, body_part: bodyPart, shortcut });
                      onClose();
                    } catch (e) { setErr(e instanceof Error ? e.message : "저장 실패"); }
                  }}>저장</button>
          <button onClick={onClose}>취소</button>
        </div>
      </div>
    </div>
  );
}

/* ── [E] 상용구 패널 (DB 테이블 + Alt+단축키, 화면분석 §5.6) ─────── */
function PhrasePanel({ onInsert, current, shortcutRef }: {
  onInsert: (text: string) => void;
  current: StudyDetail | null;
  shortcutRef: React.MutableRefObject<Record<string, string>>;
}) {
  const [items, setItems] = useState<PhraseRow[]>([]);
  const [sel, setSel] = useState<PhraseRow | null>(null);
  const [fitOnly, setFitOnly] = useState(true); // 현재 검사 맞춤(모달리티 일치 or 공통)
  const [modal, setModal] = useState<"new" | "edit" | null>(null);
  const visible = items.filter((p) =>
    !fitOnly || !current || !p.modality || p.modality === current.modality);

  const load = useCallback(() => {
    api.phrases().then((r) => {
      setItems(r.items);
      // Alt+단축키 매핑을 루트 키보드 핸들러에 공급
      shortcutRef.current = Object.fromEntries(
        r.items.filter((p) => p.shortcut).map((p) => [p.shortcut, p.text]));
    }).catch(() => {});
  }, [shortcutRef]);
  useEffect(load, [load]);

  const del = async () => {
    if (!sel || !window.confirm(`상용구 '${sel.name}'을 삭제할까요?`)) return;
    await api.deletePhrase(sel.id);
    setSel(null);
    load();
  };

  return (
    <PanelBox title="상용구 (Std)" right={
      <span style={{ display: "flex", gap: 3, alignItems: "center" }}>
        <label style={{ fontSize: 10, display: "flex", gap: 2, alignItems: "center", textTransform: "none" }}>
          <input type="checkbox" checked={fitOnly} onChange={(e) => setFitOnly(e.target.checked)} />맞춤
        </label>
        <MiniBtn onClick={() => sel && onInsert(sel.text)} disabled={!sel}>삽입</MiniBtn>
        <MiniBtn onClick={() => setModal("new")}>New</MiniBtn>
        <MiniBtn onClick={() => setModal("edit")} disabled={!sel}>Edit</MiniBtn>
        <MiniBtn onClick={del} disabled={!sel}>Del</MiniBtn>
      </span>
    }>
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
          <table className="grid-table">
            <thead><tr><th>분류</th><th>NAME</th><th style={{ width: 34 }}>키</th></tr></thead>
            <tbody>
              {visible.map((p) => (
                <tr key={p.id} className={sel?.id === p.id ? "selected" : ""}
                    onClick={() => setSel(p)} onDoubleClick={() => onInsert(p.text)}>
                  <td>{p.category}</td><td title={p.text}>{p.name}</td>
                  <td style={{ color: "var(--accent)" }}>{p.shortcut && `Alt+${p.shortcut}`}</td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr><td colSpan={3} style={{ color: "var(--text-secondary)" }}>
                  {items.length ? "맞춤 해제 시 전체 표시" : "New로 상용구 등록"}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        {sel && (
          <div style={{
            borderTop: "1px solid var(--border)", padding: 6, fontSize: 11.5,
            color: "var(--text-secondary)", maxHeight: 70, overflow: "auto",
          }}>
            {sel.text}
          </div>
        )}
      </div>
      {modal && (
        <PhraseEditModal
          init={modal === "edit" ? sel : null}
          defaults={{ modality: current?.modality, body_part: current?.body_part }}
          onSave={async (body) => {
            if (modal === "edit" && sel) await api.updatePhrase(sel.id, body);
            else await api.createPhrase(body);
            load();
          }}
          onClose={() => setModal(null)}
        />
      )}
    </PanelBox>
  );
}

/* ── 키이미지 스트립 (F-16) ───────────────────── */
function KeyImageStrip({ studyId }: { studyId: number }) {
  const [items, setItems] = useState<InstanceThumb[]>([]);
  const [selected, setSelected] = useState<Map<string, KeyImage>>(new Map());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  // 키이미지 등록은 image.register 게이트 (조회·표시는 자유) — 서버 403 이 최종 방어선
  const canRegister = hasPerm(usePermMe(), "image.register");

  useEffect(() => {
    api.instances(studyId).then((r) => {
      setItems(r.items);
      setSelected(new Map(r.key_images.map((k) => [k.sop_uid, k])));
    }).catch(() => setItems([]));
  }, [studyId]);

  if (items.length === 0) return null;
  const toggle = (it: InstanceThumb) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(it.sop_uid)) next.delete(it.sop_uid);
      else next.set(it.sop_uid, { sop_uid: it.sop_uid, orthanc_id: it.orthanc_id, instance_number: it.instance_number });
      return next;
    });
  };
  const save = async (kos: boolean) => {
    setBusy(true);
    try {
      await api.setKeyImages(studyId, [...selected.values()]);
      if (kos && selected.size > 0) { await api.sendKos(studyId); setMsg("KOS 전송됨"); }
      else setMsg("저장됨");
    } catch (e) { setMsg(e instanceof Error ? e.message : "실패"); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center", padding: "3px 0" }}>
      <span style={{ fontSize: 10.5, color: "var(--text-secondary)", width: 56, flexShrink: 0 }}>
        KEY IMG<br />({selected.size}장)
      </span>
      <div style={{ display: "flex", gap: 3, overflowX: "auto" }}>
        {items.slice(0, 16).map((it) => (
          <img key={it.sop_uid} src={it.preview_url} alt="" onClick={() => toggle(it)}
               style={{
                 width: 40, height: 40, objectFit: "cover", borderRadius: 2, cursor: "pointer", flexShrink: 0,
                 border: selected.has(it.sop_uid) ? "2px solid var(--anno-keyimage)" : "1px solid var(--border)",
               }} />
        ))}
      </div>
      <MiniBtn onClick={() => save(false)} disabled={busy || !canRegister}
               title={canRegister ? undefined : PERM_DENIED_TIP}>저장</MiniBtn>
      <MiniBtn onClick={() => save(true)} disabled={busy || selected.size === 0 || !canRegister}
               title={canRegister ? undefined : PERM_DENIED_TIP}>KOS</MiniBtn>
      {msg && <span style={{ fontSize: 10.5, color: "var(--stat-final)" }}>{msg}</span>}
    </div>
  );
}

/* ── [E-중] 리포트 패널 (레퍼런스 메타테이블 + 3단) ── */
/** auto_apply=false일 때 Report 편집 영역 초기 템플릿 (AI 내용은 [적용▶]로만) */
function emptySr(base: SrJson): SrJson {
  return {
    exam: base.exam,
    comparison: { prior_study_refs: [], summary: "" },
    findings: [],
    impression: [{ rank: 1, statement: "", confidence: "low", codes: [] }],
    recommendations: [],
    ai_meta: { caveats: [] },
  };
}
const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function ReportPanel({ detail, onChanged, insertRef, onNav }: {
  detail: StudyDetail | null;
  onChanged: () => void;
  insertRef: React.MutableRefObject<((t: string) => void) | null>;
  onNav?: (dir: 1 | -1) => void;
}) {
  const [reports, setReports] = useState<Report[]>([]);
  const [draft, setDraft] = useState<SrJson | null>(null);
  const [busy, setBusy] = useState(false);
  const [histId, setHistId] = useState<number | null>(null);  // 판독 이력 보기(버전)
  const current = reports[0] ?? null;
  // 유효 권한(레인 W) — report.write 없으면 편집·저장·확정 비활성(조회는 가능),
  // report.print 없으면 PDF 비활성. 서버 403 이 최종 방어선(UI 는 사전 안내)
  const permMe = usePermMe();
  const canWrite = hasPerm(permMe, "report.write");
  const canPrint = hasPerm(permMe, "report.print");

  // 리포트 구성(Setting>리포트 — Report Composition) + STT 엔진(Setting>AI 정책)
  const [aiPanelOn, setAiPanelOn] = useState(true);
  const [autoApply, setAutoApply] = useState(true);
  const [openNext, setOpenNext] = useState(false);  // 저장(확정) 후 다음 레포트 열기
  const [sttEngine, setSttEngine] = useState("browser");
  useEffect(() => {
    api.getSetting("report.prefs").then((r) => {
      const v = r.value as { ai_panel?: boolean; auto_apply?: boolean; open_next_after_save?: boolean };
      if (v.ai_panel !== undefined) setAiPanelOn(v.ai_panel);
      if (v.auto_apply !== undefined) setAutoApply(v.auto_apply);
      if (v.open_next_after_save !== undefined) setOpenNext(v.open_next_after_save);
    }).catch(() => {});
    api.getSetting("ai.policy").then((r) => {
      setSttEngine(((r.value as { stt_engine?: string }).stt_engine) ?? "browser");
    }).catch(() => {});
  }, []);

  const insertText = (text: string) => setDraft((d) => {
    if (!d) return d;
    const n = structuredClone(d);
    if (n.impression[0]) n.impression[0].statement += (n.impression[0].statement ? " " : "") + text;
    return n;
  });

  // 음성 판독(STT) — browser: Web Speech / whisper_local·openai_api: 서버 전사(MediaRecorder)
  const [stt, setStt] = useState(false);
  const recRef = useRef<{ stop: () => void } | null>(null);
  const toggleStt = () => {
    if (stt) { recRef.current?.stop(); setStt(false); return; }
    if (sttEngine !== "browser") {
      navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        const rec = new MediaRecorder(stream);
        const chunks: Blob[] = [];
        rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        rec.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          try {
            const r = await sttTranscribe(new Blob(chunks, { type: "audio/webm" }));
            if (r.text) insertText(r.text);
          } catch (e) { alert(e instanceof Error ? e.message : "STT 실패"); }
        };
        recRef.current = rec;
        rec.start();
        setStt(true);
      }).catch(() => alert("마이크 권한이 필요합니다"));
      return;
    }
    const w = window as unknown as Record<string, unknown>;
    const SR = (w.webkitSpeechRecognition ?? w.SpeechRecognition) as
      (new () => {
        lang: string; continuous: boolean; interimResults: boolean;
        onresult: (ev: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
        onend: () => void; onerror: () => void; start: () => void; stop: () => void;
      }) | undefined;
    if (!SR) { alert("이 브라우저는 음성 인식을 지원하지 않습니다 (Chrome 권장 — 또는 설정>AI 정책에서 Whisper 선택)"); return; }
    const rec = new SR();
    rec.lang = "ko-KR";
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (ev) => {
      const texts: string[] = [];
      for (let i = ev.resultIndex; i < ev.results.length; i++) texts.push(ev.results[i][0].transcript);
      const text = texts.join(" ").trim();
      if (text) insertText(text);
    };
    rec.onend = () => setStt(false);
    rec.onerror = () => setStt(false);
    recRef.current = rec;
    rec.start();
    setStt(true);
  };
  useEffect(() => () => recRef.current?.stop(), []);

  useEffect(() => {
    setHistId(null);
    if (!detail) { setReports([]); setDraft(null); return; }
    api.reports(detail.id).then((r) => {
      setReports(r.items);
      const latest = r.items[0];
      if (!latest) { setDraft(null); return; }
      // AI 적용 선택(Setting>리포트): 자동 적용 꺼짐이면 빈 템플릿으로 시작 — [적용 ▶]로만 가져옴
      if (!autoApply && latest.created_by === "ai" && latest.status === "draft") {
        setDraft(emptySr(latest.sr_json));
      } else {
        setDraft(structuredClone(latest.sr_json));
      }
    });
  }, [detail, autoApply]);

  // 상용구 삽입 훅 (E-좌 → E-중)
  useEffect(() => {
    insertRef.current = (text: string) => {
      setDraft((d) => {
        if (!d) return d;
        const next = structuredClone(d);
        if (next.impression[0]) next.impression[0].statement += (next.impression[0].statement ? "\n" : "") + text;
        return next;
      });
    };
  }, [insertRef]);

  if (!detail) {
    return <PanelBox title="REPORT"><Empty>검사를 선택하세요</Empty></PanelBox>;
  }

  const finalized = current?.status === "finalized";
  // 16차: AI Structured Report(최신 AI 버전)와 의료인 Report 분리 + 전자서명
  const aiDraft = reports.find((r) => r.created_by === "ai") ?? null;
  const signature = (current?.diff_metrics as {
    signature?: { name: string; license_no: string; signed_at: string };
  })?.signature;
  const age = detail.birth_date ? `${new Date().getFullYear() - parseInt(detail.birth_date.slice(0, 4), 10)}세` : "-";

  const save = async () => {
    if (!current || !draft) return;
    setBusy(true);
    try { await api.updateReport(current.id, draft); onChanged(); } finally { setBusy(false); }
  };
  const finalize = async () => {
    if (!current || !draft) return;
    setBusy(true);
    try {
      if (!finalized) await api.updateReport(current.id, draft);
      await api.finalizeReport(current.id);
      onChanged();
      if (openNext && onNav) onNav(1);  // 옵션: 저장(확정) 후 다음 레포트 열기
    } finally { setBusy(false); }
  };

  // AI Structured Report를 별도 웹페이지(모니터)로 — UBPACS Report Composition
  const openAiPopup = () => {
    if (!aiDraft) return;
    const w = window.open("", "sv_ai_report", "width=620,height=780");
    if (!w) { alert("팝업이 차단되었습니다"); return; }
    const sr = aiDraft.sr_json;
    const rows = [
      ...(sr.comparison.summary ? [`<div class="sec">COMPARISON</div><div>${escHtml(sr.comparison.summary)}</div>`] : []),
      `<div class="sec">FINDINGS</div>`,
      ...sr.findings.map((f) =>
        `<div><b>${escHtml(f.organ)}</b>: ${escHtml(f.observation)} ${f.severity === "critical" ? '<span class="crit">[CRITICAL]</span>' : ""}</div>`),
      `<div class="sec">IMPRESSION</div>`,
      ...sr.impression.map((i) => `<div>${i.rank}. ${escHtml(i.statement)} <i>(${i.confidence})</i></div>`),
      ...(sr.recommendations.length ? [`<div class="sec">RECOMMEND</div>`,
        ...sr.recommendations.map((r) => `<div>- ${escHtml(r.action)} (${escHtml(r.timeframe)})</div>`)] : []),
    ].join("");
    w.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>AI Report — ${escHtml(detail.patient_key)}</title>
<style>body{background:#15181c;color:#e6e9ed;font-family:system-ui,sans-serif;padding:20px;font-size:14px;line-height:1.6}
h2{color:#a78bfa;font-size:16px;margin:0 0 4px}.meta{color:#9aa3ad;font-size:12px;border-bottom:1px solid #333;padding-bottom:8px}
.sec{color:#9aa3ad;font-weight:700;margin-top:14px;border-bottom:1px solid #333;font-size:11px}
.crit{color:#ff5b5b;font-weight:700}.foot{margin-top:18px;color:#a78bfa;font-size:11px}</style></head><body>
<h2>AI STRUCTURED REPORT</h2>
<div class="meta">${escHtml(detail.patient_name)} (${escHtml(detail.patient_key)}) · ${detail.modality} · ${detail.study_date} · ${escHtml(detail.study_desc)} · v${aiDraft.version} ${escHtml(aiDraft.ai_model)}</div>
${rows}
<div class="foot">⚠ AI 생성 초안 — 확정 아님. 최종 판독은 의료인이 합니다.</div>
</body></html>`);
    w.document.close();
  };

  const histReport = histId !== null ? reports.find((r) => r.id === histId) ?? null : null;

  return (
    <PanelBox title="REPORT" right={
      <span style={{ display: "flex", gap: 3, alignItems: "center" }}>
        {onNav && (<>
          <MiniBtn title="이전 환자(검사)로 이동" onClick={() => onNav(-1)}>◀</MiniBtn>
          <MiniBtn title="다음 환자(검사)로 이동" onClick={() => onNav(1)}>▶</MiniBtn>
        </>)}
        {current && (<>
          {current.created_by === "ai" && <span className="badge ai">AI 초안 — 검토 필수</span>}
          <StatusBadge status={current.status === "draft" ? "draft_ready" : current.status} />
        </>)}
      </span>
    }>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, overflow: "auto", height: "100%", padding: "0 2px" }}>
        {/* 메타 테이블 — 레퍼런스 [E-중] 형식 */}
        <table className="grid-table" style={{ fontSize: 11.5 }}>
          <tbody>
            <tr>
              <th style={{ width: 64 }}>ID</th><td>{detail.patient_key}</td>
              <th style={{ width: 50 }}>NAME</th><td>{detail.patient_name}</td>
              <th style={{ width: 42 }}>AGE</th><td>{age}</td>
              <th style={{ width: 40 }}>SEX</th><td>{detail.sex}</td>
            </tr>
            <tr>
              <th>Acc No</th><td>{detail.accession_no}</td>
              <th>검사명</th><td colSpan={3} title={detail.study_desc}>{detail.study_desc}</td>
              <th>검사일</th><td>{detail.study_date}</td>
            </tr>
            <tr>
              <th>Reporter</th>
              <td colSpan={5}>
                Dictator: {current?.created_by === "ai" ? `AI(${current.ai_model})` : current?.created_by ?? "-"} ·
                Reader: {current?.reviewed_by || "-"} · Conf1: {finalized ? current?.reviewed_by : "-"} ·
                Conf2: {(current?.diff_metrics as { confirm2?: { by: string } })?.confirm2?.by ?? "-"}
              </td>
              <th>확정일</th>
              <td>{current?.finalized_at ? current.finalized_at.slice(0, 10) : "-"}</td>
            </tr>
          </tbody>
        </table>

        <KeyImageStrip studyId={detail.id} />

        {!current || !draft ? (
          <Empty>
            리포트 없음
            <div style={{ marginTop: 6 }}>
              <MiniBtn disabled={!canWrite} title={canWrite ? undefined : PERM_DENIED_TIP}
                       onClick={async () => {
                         try { await api.analyze(detail.id); onChanged(); }
                         catch (e) { alert((e as Error).message); }   // AI 판독 보류(409) 등 안내
                       }}>AI 초안 생성</MiniBtn>
            </div>
          </Empty>
        ) : (
          <>
            {/* 2열 분리: AI Structured Report(읽기) → [적용 ▶] → Report(의료인 작성·서명) */}
            <div style={{ display: "flex", gap: 6, flex: 1, minHeight: 120 }}>
              {/* 좌: AI Structured Report — 보라(AI 생성물 전용 색). Setting>리포트에서 표시 선택 */}
              {aiPanelOn && (
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4,
                            border: "1px solid var(--ai)", borderRadius: 4, padding: 6, overflow: "auto" }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--ai)", display: "flex", gap: 6, alignItems: "center" }}>
                  AI STRUCTURED REPORT {aiDraft && `(v${aiDraft.version} · ${aiDraft.ai_model})`}
                  <span style={{ flex: 1 }} />
                  <button title="별도 창(모니터)으로 AI 리포트 보기" disabled={!aiDraft} onClick={openAiPopup}
                          style={{ padding: "1px 7px", fontSize: 11 }}>↗</button>
                  <button className="primary" disabled={!aiDraft || finalized || !canWrite}
                          title={canWrite ? "AI 초안을 우측 Report로 복사 — 검토 후 의료인이 확정(서명)" : PERM_DENIED_TIP}
                          onClick={() => aiDraft && setDraft(structuredClone(aiDraft.sr_json))}
                          style={{ padding: "1px 10px", fontSize: 11 }}>적용 ▶</button>
                </div>
                {!aiDraft ? (
                  <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>AI 초안 없음 — 초안 재생성으로 생성</div>
                ) : (
                  <div style={{ fontSize: 11.5 }}>
                    {aiDraft.sr_json.comparison.summary && (
                      <div style={{ color: "var(--text-secondary)", marginBottom: 3 }}>[비교] {aiDraft.sr_json.comparison.summary}</div>
                    )}
                    {aiDraft.sr_json.findings.map((f, i) => (
                      <div key={i}>
                        <b>{f.organ}</b>: {f.observation}{" "}
                        {f.severity === "critical" && <span className="badge critical">CRITICAL</span>}
                      </div>
                    ))}
                    <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0", paddingTop: 3 }}>
                      {aiDraft.sr_json.impression.map((imp, i) => (
                        <div key={i}>{imp.rank}. {imp.statement} <i style={{ color: "var(--text-secondary)" }}>({imp.confidence})</i></div>
                      ))}
                    </div>
                    {aiDraft.sr_json.recommendations.map((r, i) => (
                      <div key={i} style={{ color: "var(--text-secondary)" }}>- {r.action} ({r.timeframe})</div>
                    ))}
                  </div>
                )}
              </div>
              )}
              {/* 우: Report — 의료인 작성·확정(서명) + 판독 이력 */}
              <div style={{ flex: 1.2, minWidth: 0, display: "flex", flexDirection: "column", gap: 4,
                            border: "1px solid var(--border)", borderRadius: 4, padding: 6, overflow: "auto" }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text-secondary)",
                              display: "flex", gap: 6, alignItems: "center" }}>
                  REPORT (판독)
                  <span style={{ flex: 1 }} />
                  <select title="판독 이력 — 과거 버전 보기" value={histId ?? "cur"}
                          style={{ fontSize: 10.5 }}
                          onChange={(e) => setHistId(e.target.value === "cur" ? null : Number(e.target.value))}>
                    <option value="cur">현재 (v{current.version})</option>
                    {reports.slice(1).map((r) => (
                      <option key={r.id} value={r.id}>
                        v{r.version} · {STATUS_LABEL[r.status] ?? r.status} · {r.created_by === "ai" ? "AI" : r.created_by}
                      </option>
                    ))}
                  </select>
                </div>
                {histReport ? (
                  <div style={{ fontSize: 12, whiteSpace: "pre-wrap", color: "var(--text-secondary)", overflow: "auto" }}>
                    <div style={{ color: "var(--accent)", fontSize: 10.5, marginBottom: 4 }}>
                      [이력 보기 — v{histReport.version} · {histReport.created_by === "ai" ? `AI(${histReport.ai_model})` : histReport.created_by}
                      {histReport.finalized_at && ` · 확정 ${histReport.finalized_at.slice(0, 10)}`}] 읽기 전용
                    </div>
                    {histReport.narrative_text || "(내용 없음)"}
                  </div>
                ) : (<>
                <SectionTitle>READING</SectionTitle>
                <div style={{ fontSize: 12 }}>
                  {draft.comparison.summary && (
                    <div style={{ color: "var(--text-secondary)", marginBottom: 3 }}>[비교] {draft.comparison.summary}</div>
                  )}
                  {draft.findings.map((f, i) => (
                    <div key={i}>
                      <b>{f.organ}</b>: {f.observation}{" "}
                      {f.severity === "critical" && <span className="badge critical">CRITICAL</span>}
                    </div>
                  ))}
                </div>
                <SectionTitle>CONCLUSION</SectionTitle>
                {draft.impression.map((imp, i) => (
                  <textarea key={i} value={imp.statement} disabled={finalized} readOnly={!canWrite}
                            title={canWrite ? undefined : PERM_DENIED_TIP}
                            onChange={(e) => setDraft((d) => {
                              const n = structuredClone(d!); n.impression[i].statement = e.target.value; return n;
                            })}
                            style={{
                              width: "100%", background: "var(--bg-canvas)", color: "var(--text-primary)",
                              border: "1px solid var(--border)", borderRadius: 3, padding: 5,
                              fontFamily: "inherit", fontSize: 12.5, resize: "vertical", minHeight: 44,
                            }} />
                ))}
                {draft.recommendations.length > 0 && (
                  <>
                    <SectionTitle>RECOMMEND</SectionTitle>
                    {draft.recommendations.map((r, i) => (
                      <div key={i} style={{ fontSize: 12 }}>- {r.action} ({r.timeframe})</div>
                    ))}
                  </>
                )}
                {signature && (
                  <div style={{
                    marginTop: "auto", borderTop: "1px solid var(--border)", paddingTop: 4,
                    fontSize: 11.5, color: "var(--stat-final)",
                  }}>
                    ✍ 서명: {signature.name}{signature.license_no && ` (면허 제${signature.license_no}호)`} ·
                    {" "}{signature.signed_at?.slice(0, 16).replace("T", " ")}
                  </div>
                )}
                </>)}
              </div>
            </div>
            <div style={{ display: "flex", gap: 5, marginTop: "auto", paddingTop: 4 }}>
              {/* 판독 작성·변경(report.write)/판독 출력(report.print) 게이트 — 서버 403 이 최종 방어선 */}
              <MiniBtn disabled={!canWrite} title={canWrite ? undefined : PERM_DENIED_TIP}
                       onClick={async () => {
                         try { await api.analyze(detail.id); onChanged(); }
                         catch (e) { alert((e as Error).message); }   // AI 판독 보류(409) 등 안내
                       }}>초안 재생성</MiniBtn>
              <MiniBtn disabled={!canPrint} title={canPrint ? undefined : PERM_DENIED_TIP}
                       onClick={() => downloadReportPdf(current.id)}>PDF</MiniBtn>
              {!finalized && (
                <MiniBtn onClick={toggleStt} disabled={!canWrite}
                         title={!canWrite ? PERM_DENIED_TIP
                              : `음성 판독(STT) — 엔진: ${sttEngine === "whisper_local" ? "Whisper 로컬(오픈소스)"
                              : sttEngine === "openai_api" ? "OpenAI API" : "브라우저 내장"} (설정>AI 정책)`}
                         style={stt ? { background: "var(--stat-emergency)", color: "#fff" } : undefined}>
                  {stt ? "🎤 녹음중" : `🎤 음성${sttEngine !== "browser" ? "·W" : ""}`}
                </MiniBtn>
              )}
              {!finalized && (
                <MiniBtn disabled={!canWrite} title={canWrite ? "판독 보류(Suspend) — 토글" : PERM_DENIED_TIP}
                         onClick={async () => {
                  await api.suspendReport(current.id); onChanged();
                }}>{current.status === "suspended" ? "보류 해제" : "보류"}</MiniBtn>
              )}
              {finalized && !(current.diff_metrics as { confirm2?: unknown })?.confirm2 && (
                <MiniBtn disabled={!canWrite} title={canWrite ? "2차 승인(Conf2) — 1차와 다른 판독의 권장" : PERM_DENIED_TIP}
                         onClick={async () => {
                  await api.confirm2Report(current.id); onChanged();
                }}>2nd Approve</MiniBtn>
              )}
              {finalized && (
                <MiniBtn onClick={async () => { setBusy(true); try { await api.sendSr(current.id); alert("DICOM SR 전송 완료"); } finally { setBusy(false); } }}>
                  SR 전송
                </MiniBtn>
              )}
              <div style={{ flex: 1 }} />
              <MiniBtn onClick={save} disabled={busy || finalized || !canWrite}
                       title={canWrite ? undefined : PERM_DENIED_TIP}>Save</MiniBtn>
              <button className="primary" style={{ padding: "2px 12px", fontSize: 12 }}
                      onClick={finalize} disabled={busy || finalized || !canWrite}
                      title={canWrite ? undefined : PERM_DENIED_TIP}>
                {finalized ? "확정됨" : "확정 (서명)"}
              </button>
            </div>
          </>
        )}
      </div>
    </PanelBox>
  );
}

/* ── 오더 등록 모달 — RIS 오더 입력형(OrderEntryRis 공용 컴포넌트)으로 통일 (레인 F-B) ──
   내용물은 OrderEntryRis 가 전담하고, 이 함수는 모달 셸(오버레이·패널·닫기)만 유지한다.
   저장 = 검사 항목(exams)마다 api.createOrder 순차 호출, 성공 메시지는 컴포넌트가 표시. */
function OrderEditModal({ onSaved, onClose }: {
  onSaved: () => void;   // 저장 성공 직후 호출 — 오더 목록 새로고침용
  onClose: () => void;
}) {
  // 기존 gen 로직 재사용 — epoch 하위 8자리 시퀀스 기반 자동 채번 (SV 프리픽스)
  const genSeq = () => Date.now().toString().slice(-8);
  const genPid = () => `SV${genSeq()}`;
  const genAcc = () => `SV${genSeq()}`;
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "grid", placeItems: "center", zIndex: 400 }}
         onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8,
                    width: 1050, maxWidth: "95vw", maxHeight: "92vh", overflow: "auto",
                    padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <b style={{ fontSize: 13 }}>새 오더 등록 — MWL로 장비에 전달됩니다</b>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} title="닫기" style={{ padding: "1px 8px" }}>✕</button>
        </div>
        <OrderEntryRis
          genPid={genPid}
          genAcc={genAcc}
          onSave={async (p, exams) => {
            // 검사 항목 1건 = 오더 1건. Patient ID 빈값이면 400 → 자동 채번으로 방어.
            const pid = p.patient_id.trim() || genPid();
            const patient_name = [p.last_name.trim().toUpperCase(), p.first_name.trim().toUpperCase()]
              .filter(Boolean).join("^");  // DICOM PN: LAST^FIRST
            const acc = p.accession.trim();  // 빈값 = 서버 자동 채번(SV{id:08d}) 위임 — 접미 미적용
            for (let i = 0; i < exams.length; i++) {
              const ex = exams[i];
              await api.createOrder({
                patient_key: pid, patient_name, birth_date: p.birth_date, sex: p.sex,
                // 다건이면 -1/-2 접미로 Accession 중복 방지 (SPEC 매핑)
                accession_no: acc ? (exams.length > 1 ? `${acc}-${i + 1}` : acc) : "",
                modality: p.modality,
                scheduled_date: p.scheduled_date, scheduled_time: p.scheduled_time,
                procedure_desc: `${ex.body_part} ${ex.projection}`.trim(),
                station_aet: p.station_aet,
                body_part: ex.body_part, projection: ex.projection,
                dicom_study_id: p.dicom_study_id,
              });
            }
            onSaved();  // 목록 즉시 갱신 (모달은 열어둠 — 연속 등록 가능)
            return `오더 ${exams.length}건 등록`;
          }} />
      </div>
    </div>
  );
}

/* ── [E-우] 오더/예약 (RIS — P2): MWL 내보내기 + MPPS 상태 매핑 ─────── */
const ORDER_STATUS: Record<string, string> = {
  scheduled: "예약", in_progress: "진행중", completed: "완료", cancelled: "취소",
};
function OrdersPanel({ refreshKey }: { refreshKey: number }) {
  const [items, setItems] = useState<OrderRow[]>([]);
  const [msg, setMsg] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const load = useCallback(() => {
    api.orders().then((r) => setItems(r.items)).catch(() => {});
  }, []);
  useEffect(load, [load, refreshKey]);

  const setSt = async (id: number, status: string) => {
    try { await api.setOrderStatus(id, status); load(); }
    catch (e) { alert(e instanceof Error ? e.message : "상태 변경 실패"); }
  };
  const exportMwl = async () => {
    try {
      const r = await api.exportMwl();
      setMsg(`MWL ${r.count}건 내보냄 → 장비 C-FIND 응답`);
    } catch (e) { setMsg(e instanceof Error ? e.message : "MWL 실패"); }
  };
  // 오더 삭제 — confirm 후 DELETE, 실패 사유는 사용자에게 그대로 노출 (삼킴 금지)
  const del = async (o: OrderRow) => {
    if (!confirm(`오더 삭제 — ${o.patient_name || o.patient_key} / ${o.accession_no || "(Accession 없음)"}\n삭제하면 되돌릴 수 없습니다.`)) return;
    try { await api.deleteOrder(o.id); load(); }
    catch (e) { alert(e instanceof Error ? e.message : "오더 삭제 실패"); }
  };

  return (
    <PanelBox title="오더/예약 (RIS·MWL)" right={
      <span style={{ display: "flex", gap: 3 }}>
        <MiniBtn onClick={() => setModalOpen(true)}>New</MiniBtn>
        <MiniBtn onClick={exportMwl} title="scheduled 오더를 MWL(.wl)로 내보내기 — Orthanc worklists">MWL</MiniBtn>
      </span>
    }>
      <table className="grid-table">
        <thead><tr><th>환자</th><th>오더명</th><th>MOD</th><th>예약일</th><th>상태</th><th>가져감</th><th></th></tr></thead>
        <tbody>
          {items.map((o) => (
            <tr key={o.id}>
              <td title={o.accession_no}>{o.patient_name || o.patient_key}</td>
              <td title={o.procedure_desc}>{o.procedure_desc}</td>
              <td>{o.modality}</td>
              <td>{o.scheduled_date}</td>
              <td>{ORDER_STATUS[o.status] ?? o.status}</td>
              {/* 장비가 MWL C-FIND 로 가져간 관찰 기록 — AET 표시, 시각은 title 툴팁 */}
              <td>{o.taken_aet
                ? <span title={o.taken_at ? `가져간 시각: ${o.taken_at.slice(0, 19).replace("T", " ")}` : undefined}>🏷 {o.taken_aet}</span>
                : "—"}</td>
              <td style={{ whiteSpace: "nowrap" }}>
                {o.status === "scheduled" && (
                  <MiniBtn title="검사 시작 (MPPS IN PROGRESS)" onClick={() => setSt(o.id, "in_progress")}>시작</MiniBtn>
                )}
                {o.status === "in_progress" && (
                  <MiniBtn title="검사 완료 (MPPS COMPLETED)" onClick={() => setSt(o.id, "completed")}>완료</MiniBtn>
                )}
                {(o.status === "scheduled" || o.status === "in_progress") && (
                  <MiniBtn title="취소 (MPPS DISCONTINUED)" onClick={() => setSt(o.id, "cancelled")}>✕</MiniBtn>
                )}
                <MiniBtn title="오더 삭제 (DB에서 제거 — 되돌릴 수 없음)" onClick={() => del(o)}
                         style={{ color: "var(--stat-emergency)" }}>✕</MiniBtn>
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr><td colSpan={7} style={{ color: "var(--text-secondary)" }}>오더 없음 — New로 등록, MWL로 장비 전달</td></tr>
          )}
        </tbody>
      </table>
      {msg && <div style={{ padding: "3px 8px", fontSize: 10.5, color: "var(--stat-final)" }}>{msg}</div>}
      {modalOpen && (
        <OrderEditModal onClose={() => setModalOpen(false)} onSaved={load} />
      )}
    </PanelBox>
  );
}

/* ── Infi 판독 정보 뷰 (INFINITT 원본 하단 Report 블록 재현) ──
   Accession/환자/검사일·상태/코멘트/성별·나이 + Creator·Dictator·Transcriber·Approver·Approver2 + 판독문 */
function InfiReport({ detail }: { detail: StudyDetail | null }) {
  const [rep, setRep] = useState<Report | null>(null);
  useEffect(() => {
    if (!detail) { setRep(null); return; }
    api.reports(detail.id).then((r) => setRep(r.items[0] ?? null)).catch(() => setRep(null));
  }, [detail]);
  if (!detail) {
    return <PanelBox title="Report"><div style={{ padding: 10, fontSize: 12, color: "var(--text-secondary)" }}>
      Select a study.</div></PanelBox>;
  }
  const age = (() => {
    const b = detail.birth_date?.replaceAll("-", "");
    const s = detail.study_date?.replaceAll("-", "");
    if (b?.length === 8 && s?.length === 8) {
      let a = +s.slice(0, 4) - +b.slice(0, 4);
      if (s.slice(4) < b.slice(4)) a--;
      return `${a}Y`;
    }
    return "";
  })();
  const sig = (rep?.diff_metrics as { signature?: { name?: string }; confirm2?: { by?: string } } | undefined);
  const L = ({ k, v }: { k: string; v: React.ReactNode }) => (
    <div style={{ display: "flex", gap: 6 }}>
      <span style={{ width: 118, color: "#7dd3fc", flexShrink: 0 }}>{k}</span>
      <span style={{ color: "var(--text-primary)" }}>{v || "-"}</span>
    </div>
  );
  return (
    <PanelBox title="Report">
      <div style={{ padding: "8px 12px", fontSize: 12, lineHeight: 1.7, overflow: "auto", fontFamily: "monospace" }}>
        <L k="Accession No" v={detail.accession_no} />
        <L k="Patient Name / ID" v={`${detail.patient_name} / ${detail.patient_key}`} />
        <L k="Exam Date" v={`${detail.study_date} ${detail.study_time ?? ""} [ ${STATUS_LABEL[detail.status] ?? detail.status} ]`} />
        <L k="Study Comment" v={detail.clinical_info} />
        <L k="Sex / Age" v={`${detail.sex} / ${age}`} />
        <div style={{ height: 8 }} />
        <L k="Creator" v={rep?.created_by === "ai" ? "AI (초안)" : rep?.created_by} />
        <L k="Dictator" v={rep?.created_by === "ai" ? "AI(claude-opus-4-8)" : rep?.created_by} />
        <L k="Transcriber" v={rep?.reviewed_by} />
        <L k="Approver" v={sig?.signature?.name} />
        <L k="Approver2" v={sig?.confirm2?.by} />
        <div style={{ height: 8 }} />
        <L k="Report Date" v={rep?.finalized_at ? rep.finalized_at.slice(0, 10) : ""} />
        <div style={{ borderTop: "1px solid var(--border)", margin: "8px 0", paddingTop: 8,
                      whiteSpace: "pre-wrap", fontFamily: "inherit", color: "var(--text-secondary)" }}>
          {rep?.narrative_text || "No report"}
        </div>
      </div>
    </PanelBox>
  );
}

/* ── Thumbnail Window — Series Layout / Image Layout 분할 선택 (UBPACS) ── */
function ThumbnailPanel({ detail, onOpen }: { detail: StudyDetail | null; onOpen: () => void }) {
  const [tree, setTree] = useState<SeriesNode[]>([]);
  const [selSeries, setSelSeries] = useState<string | null>(null);
  const [sLay, setSLay] = useState({ r: 1, c: 2 });   // Series layout
  const [iLay, setILay] = useState({ r: 2, c: 2 });   // Image layout

  useEffect(() => {
    api.getSetting("worklist.prefs").then((r) => {
      const t = (r.value as { thumb_layout?: { s?: { r: number; c: number }; i?: { r: number; c: number } } }).thumb_layout;
      if (t?.s) setSLay(t.s);
      if (t?.i) setILay(t.i);
    }).catch(() => {});
  }, []);
  const persist = (s: { r: number; c: number }, i: { r: number; c: number }) => {
    api.getSetting("worklist.prefs").then((r) =>
      api.putSetting("worklist.prefs", { ...r.value, thumb_layout: { s, i } }, "user")).catch(() => {});
  };

  useEffect(() => {
    if (!detail) { setTree([]); setSelSeries(null); return; }
    api.seriesTree(detail.id).then((r) => {
      const img = r.series.filter((s) => !["SR", "KO", "PR", "SEG"].includes(s.modality));
      setTree(img);
      setSelSeries(img[0]?.series_uid ?? null);
    }).catch(() => setTree([]));
  }, [detail]);

  const sel = tree.find((s) => s.series_uid === selSeries) ?? null;

  return (
    <PanelBox title="Thumbnail (더블클릭=뷰어)" right={
      <span style={{ display: "flex", gap: 3 }}>
        <GridPicker label="Srs" value={sLay} onPick={(v) => { setSLay(v); persist(v, iLay); }} />
        <GridPicker label="Img" value={iLay} onPick={(v) => { setILay(v); persist(sLay, v); }} />
      </span>
    }>
      {!detail ? <Empty>검사를 선택하세요</Empty> : tree.length === 0 ? (
        <Empty>영상 없음 (Orthanc 미연결?)</Empty>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: 5, height: "100%", minHeight: 0 }}
             onDoubleClick={onOpen}>
          {/* Series Layout — N×M 그리드로 시리즈 카드 배열 */}
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${sLay.c}, 1fr)`, gap: 3, flexShrink: 0 }}>
            {tree.slice(0, sLay.r * sLay.c).map((s) => (
              <div key={s.series_uid} onClick={() => setSelSeries(s.series_uid)}
                   title={s.series_desc || s.modality}
                   style={{
                     position: "relative", borderRadius: 3, overflow: "hidden", cursor: "pointer",
                     border: selSeries === s.series_uid ? "2px solid var(--accent)" : "1px solid var(--border)",
                   }}>
                {s.instances[Math.floor(s.instances.length / 2)] && (
                  <img src={s.instances[Math.floor(s.instances.length / 2)].preview_url} alt=""
                       style={{ width: "100%", height: 46, objectFit: "cover", display: "block", background: "#000" }} />
                )}
                <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, fontSize: 9,
                              background: "rgba(0,0,0,0.65)", padding: "0 3px" }}>
                  S{s.series_number}·{s.instances.length}
                </div>
              </div>
            ))}
          </div>
          {tree.length > sLay.r * sLay.c && (
            <div style={{ fontSize: 10, color: "var(--text-secondary)" }}>
              +{tree.length - sLay.r * sLay.c} 시리즈 — Srs 레이아웃 확장
            </div>
          )}
          {/* Image Layout — 선택 시리즈의 이미지 N×M 그리드 */}
          <div style={{
            flex: 1, minHeight: 0, overflow: "auto",
            display: "grid", gridTemplateColumns: `repeat(${iLay.c}, 1fr)`, gap: 3, alignContent: "flex-start",
          }}>
            {(sel?.instances ?? []).slice(0, Math.max(iLay.r * iLay.c, 4) * 4).map((it) => (
              <img key={it.sop_uid} src={it.preview_url} alt="" title={`Img ${it.instance_number}`}
                   style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 2,
                            border: "1px solid var(--border)", background: "#000", cursor: "pointer" }} />
            ))}
          </div>
        </div>
      )}
    </PanelBox>
  );
}

/* ── Comment + MEMO Window (UBPACS-Z) — 임상정보 표시 + 검사 메모 편집 ── */
function CommentMemoPanel({ detail, onChanged }: { detail: StudyDetail | null; onChanged: () => void }) {
  const [memo, setMemo] = useState("");
  const [saved, setSaved] = useState("");
  useEffect(() => { setMemo(detail?.memo ?? ""); setSaved(""); }, [detail]);
  return (
    <PanelBox title="Comment / MEMO" right={
      detail && (
        <MiniBtn onClick={async () => {
          await api.setMemo(detail.id, memo);
          setSaved("저장됨");
          onChanged();
          setTimeout(() => setSaved(""), 2000);
        }}>저장</MiniBtn>
      )
    }>
      {!detail ? <Empty>검사를 선택하세요</Empty> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: 6, height: "100%" }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text-secondary)" }}>COMMENT (임상정보)</div>
          <div style={{ fontSize: 12, color: "var(--text-primary)", maxHeight: 56, overflow: "auto" }}>
            {detail.clinical_info || <span style={{ color: "var(--text-secondary)" }}>(없음)</span>}
          </div>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text-secondary)", display: "flex", gap: 6 }}>
            MEMO {saved && <span style={{ color: "var(--stat-final)" }}>{saved}</span>}
          </div>
          <textarea value={memo} onChange={(e) => setMemo(e.target.value)}
                    placeholder="검사 메모 — 워크리스트 메모 컬럼에 표시됩니다"
                    style={{ flex: 1, minHeight: 40, background: "var(--bg-canvas)", color: "var(--text-primary)",
                             border: "1px solid var(--border)", borderRadius: 3, padding: 5,
                             fontFamily: "inherit", fontSize: 12, resize: "none" }} />
        </div>
      )}
    </PanelBox>
  );
}

/* ── 컨텍스트 메뉴 (디자인 §3.3) ─────────────────── */
function ContextMenu({ x, y, row, onAction, onClose, ohifOn = false, allowed }: {
  x: number; y: number; row: StudyRow;
  onAction: (a: string) => void; onClose: () => void;
  ohifOn?: boolean;
  allowed?: (a: string) => boolean;   // 유효 권한 게이트(레인 W) — 서버 403 이 최종 방어선
}) {
  useEffect(() => {
    const h = () => onClose();
    window.addEventListener("click", h);
    return () => window.removeEventListener("click", h);
  }, [onClose]);
  const Item = ({ a, label, danger }: { a: string; label: string; danger?: boolean }) => {
    const ok = allowed ? allowed(a) : true;   // 권한 없음 → 회색 비활성 + 안내 툴팁 (UX 목적)
    return (
      <div onClick={ok ? () => { onAction(a); onClose(); } : (e) => e.stopPropagation()}
           title={ok ? undefined : PERM_DENIED_TIP}
           style={{ padding: "5px 14px", cursor: ok ? "pointer" : "not-allowed", fontSize: 12.5,
                    opacity: ok ? 1 : 0.45,
                    color: !ok ? "var(--text-secondary)" : danger ? "var(--stat-emergency)" : undefined }}
           onMouseEnter={ok ? (e) => (e.currentTarget.style.background = "var(--bg-hover)") : undefined}
           onMouseLeave={ok ? (e) => (e.currentTarget.style.background = "") : undefined}>
        {label}
      </div>
    );
  };
  const Sep = () => <div style={{ height: 1, background: "var(--border)", margin: "3px 0" }} />;
  return (
    <div style={{
      position: "fixed", left: x, top: y, zIndex: 300, minWidth: 180,
      background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 5,
      boxShadow: "0 6px 20px rgba(0,0,0,0.5)", padding: "4px 0",
    }}>
      <Item a="viewdraft" label="View&Draft (자체 뷰어)" />
      <Item a="ub_add" label="Add View — 기존 유지+추가" />
      <Item a="ub_stack" label="Stack View — 기존 유지+중첩" />
      {ohifOn && <Item a="ub_adv" label="Advance View (OHIF)" />}
      <Item a="ub_key" label="Key Image View — 키 이미지만" />
      <Item a="3d" label="3D 뷰어 (MPR/MIP)" />
      <Item a="compare" label="비교세트에 추가" />
      <Sep />
      <Item a="pdf" label="PDF 내보내기" />
      <Item a="copyreport" label="과거 판독 복사 (Copy Report)" />
      <Item a="regen" label="AI 초안 재생성" />
      <Sep />
      <Item a="bookmark" label={row.bookmark ? "★ 북마크 해제" : "☆ 북마크"} />
      <Item a="emergency" label={row.emergency ? "Emergency 해제" : "⚠ Emergency 지정"} danger={!row.emergency} />
      <Sep />
      {/* 검사 관리(admin-action) — 등급별 유효 권한으로 게이트, 서버도 403 강제 */}
      <Item a="adm_match" label="오더 매칭 (Match)" />
      <Item a="adm_unmatch" label="오더 언매칭 (Unmatch)" />
      <Item a="adm_move" label="검사 이동 — 병원 재귀속" />
      <Item a="adm_copy" label="검사 복제 (Copy)" />
      <Item a="adm_delete" label="검사 삭제" danger />
    </div>
  );
}

interface LayoutSizes { railW: number; dH: number; eH: number; thumbW: number; stdW: number; commentW: number }
const DEFAULT_SIZES: LayoutSizes = { railW: 152, dH: 140, eH: 300, thumbW: 230, stdW: 210, commentW: 250 };

/* ── 패널 드래그 래퍼 — 좌측 그립을 끌어 같은 행 안에서 자리 교환 ── */
function DraggablePanel({ zone, k, onDrop, style, children }: {
  zone: "d" | "e"; k: string;
  onDrop: (zone: "d" | "e", src: string, dst: string) => void;
  style?: React.CSSProperties; children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", minWidth: 0, minHeight: 0, ...style }}
         onDragOver={(e) => e.preventDefault()}
         onDrop={(e) => {
           const src = e.dataTransfer.getData(`text/sv-panel-${zone}`);
           if (src) onDrop(zone, src, k);
         }}>
      <div draggable title="패널 이동 — 드래그해서 자리 교환"
           onDragStart={(e) => e.dataTransfer.setData(`text/sv-panel-${zone}`, k)}
           style={{ width: 10, flexShrink: 0, cursor: "grab", display: "flex", alignItems: "center",
                    justifyContent: "center", color: "var(--text-secondary)", fontSize: 9,
                    background: "var(--bg-elevated)", borderRadius: "4px 0 0 4px",
                    border: "1px solid var(--border)", borderRight: "none" }}>
        ⋮
      </div>
      <div style={{ display: "flex", flex: 1, minWidth: 0, minHeight: 0 }}>{children}</div>
    </div>
  );
}

/* ── 공통 소품 ─────────────────────────────────── */
function PanelBox({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, flex: 1,
      background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden",
    }}>
      <div style={{
        display: "flex", alignItems: "center", padding: "3px 8px", flexShrink: 0,
        background: "var(--bg-elevated)", borderBottom: "1px solid var(--border)",
        fontSize: 10.5, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase",
      }}>
        {title}<div style={{ flex: 1 }} />{right}
      </div>
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>{children}</div>
    </div>
  );
}
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10.5, fontWeight: 700, color: "var(--text-secondary)", letterSpacing: 0.5,
      borderBottom: "1px solid var(--border)", paddingBottom: 2, marginTop: 2,
    }}>{children}</div>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 14, color: "var(--text-secondary)", fontSize: 12.5 }}>{children}</div>;
}
function MiniBtn(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} style={{ padding: "2px 9px", fontSize: 11.5, ...props.style }} />;
}

/* ── F-22 일괄 검토 모달 ─────────────────────────── */
function BatchReviewModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [items, setItems] = useState<BatchCandidate[]>([]);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  useEffect(() => {
    api.batchReview().then((r) => {
      setItems(r.items);
      setChecked(new Set(r.items.map((i) => i.report_id)));
    });
  }, []);
  const toggle = (id: number) => setChecked((p) => {
    const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n;
  });
  const confirm = async () => {
    // 03b 가드레일: 대량 확정 = 파괴적 액션 — 대상·건수 명시 후 사용자 확인 강제
    if (!window.confirm(`AI 초안 ${checked.size}건을 일괄 확정(서명)합니다.\n확정 후에는 수정할 수 없습니다. 진행할까요?`)) return;
    setBusy(true);
    try { const r = await api.batchFinalize([...checked]); setResult(`${r.finalized}/${r.total}건 확정`); onDone(); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "grid", placeItems: "center", zIndex: 100 }}>
      <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8, width: 760, maxHeight: "80vh", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center" }}>
          <b>AI 초안 일괄 검토 (F-22)</b>
          <span style={{ color: "var(--text-secondary)", fontSize: 12, marginLeft: 8 }}>critical 초안은 자동 제외 — 개별 검토 필요</span>
          <button style={{ marginLeft: "auto" }} onClick={onClose}>닫기</button>
        </div>
        <div style={{ overflow: "auto", flex: 1 }}>
          <table className="grid-table">
            <thead><tr><th></th><th>환자</th><th>검사일</th><th>MOD</th><th>검사명</th><th>AI 임프레션</th><th>신뢰도</th></tr></thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.report_id} onClick={() => toggle(c.report_id)}>
                  <td><input type="checkbox" checked={checked.has(c.report_id)} readOnly /></td>
                  <td>{c.patient_name} ({c.patient_key})</td>
                  <td>{c.study_date}</td><td>{c.modality}</td>
                  <td title={c.study_desc}>{c.study_desc}</td>
                  <td style={{ color: "var(--ai)", maxWidth: 240 }} title={c.impression}>{c.impression}</td>
                  <td>{c.confidence}</td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: "center", color: "var(--text-secondary)", padding: 20 }}>대상 초안 없음</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)", display: "flex", gap: 8, alignItems: "center" }}>
          {result && <span style={{ color: "var(--stat-final)" }}>{result}</span>}
          <div style={{ flex: 1 }} />
          <button className="primary" disabled={busy || checked.size === 0} onClick={confirm}>
            선택 {checked.size}건 일괄 확정
          </button>
        </div>
      </div>
    </div>
  );
}

/* ════ 워크리스트 워크스페이스 루트 ════ */
/* SAINT VIEW 워크리스트 상단 상태 카운트 바 (그림1) — 서버 counts 엔드포인트로 전 검사 정확 집계.
   서버 응답 전/실패 시 현재 페이지 집계로 폴백. 칩 클릭 시 상태 필터. */
function SvStatusBar({ queryParams, refreshKey, items, onStatus, onRefresh }: {
  queryParams: Record<string, string>;
  refreshKey: number;
  items: StudyRow[];
  onStatus: (patch: { status?: string; emergency?: string }) => void;
  onRefresh: () => void;
}) {
  const [c, setC] = useState<{ total: number; emergency: number; unread: number; reading: number; draft_ready: number; finalized: number } | null>(null);
  useEffect(() => {
    let alive = true;
    api.worklistCounts(queryParams).then((r) => { if (alive) setC(r); }).catch(() => { if (alive) setC(null); });
    return () => { alive = false; };
  }, [queryParams, refreshKey]);
  const pageN = (pred: (r: StudyRow) => boolean) => items.filter(pred).length;
  const chips: { label: string; n: number | undefined; fb: number; color: string; onClick: () => void }[] = [
    { label: "전체", n: c?.total, fb: items.length, color: "var(--accent)", onClick: () => onStatus({ status: "", emergency: "" }) },
    { label: "응급", n: c?.emergency, fb: pageN((r) => r.emergency), color: "var(--stat-emergency)", onClick: () => onStatus({ emergency: "true" }) },
    { label: "미판독", n: c?.unread, fb: pageN((r) => r.read_state === "unread"), color: "#f59e0b", onClick: () => onStatus({ status: "unread" }) },
    { label: "판독중", n: c?.reading, fb: pageN((r) => r.read_state === "reading" || r.status === "reading"), color: "#60a5fa", onClick: () => onStatus({ status: "reading" }) },
    { label: "판독저장", n: c?.draft_ready, fb: pageN((r) => r.status === "draft_ready"), color: "#a78bfa", onClick: () => onStatus({ status: "draft_ready" }) },
    { label: "승인", n: c?.finalized, fb: pageN((r) => r.status === "finalized"), color: "var(--stat-final)", onClick: () => onStatus({ status: "finalized" }) },
  ];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px",
                  background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
      <b style={{ fontSize: 14, marginRight: 6 }}>워크리스트</b>
      {chips.map((ch) => (
        <button key={ch.label} onClick={ch.onClick} title={`${ch.label} 상태로 필터`}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 12px", borderRadius: 16,
                         background: "var(--bg-elevated)", border: "1px solid var(--border)", cursor: "pointer", fontSize: 12 }}>
          <span style={{ color: ch.color, fontWeight: 700 }}>{ch.label}</span>
          <span style={{ fontWeight: 700 }}>{(ch.n ?? ch.fb).toLocaleString()}</span>
        </button>
      ))}
      {!c && (
        <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--text-secondary)" }}>현재 페이지 집계 (서버 집계 대기…)</span>
      )}
      <button title="새로고침" onClick={onRefresh} style={{ padding: "3px 10px", marginLeft: c ? "auto" : 8 }}>⟳</button>
    </div>
  );
}

/* SAINT VIEW 상단 탭 스트립 (그림1) — 로고 + General/Performance/Update upload */
function SvTabStrip({ perf, onGeneral, onPerf, onUpload }: {
  perf: boolean;
  onGeneral: () => void;
  onPerf: () => void;
  onUpload: () => void;
}) {
  const tab = (label: string, active: boolean, onClick: () => void) => (
    <button onClick={onClick}
            style={{ padding: "9px 16px", fontSize: 13, fontWeight: 600, border: "none", background: "transparent",
                     color: active ? "var(--text-primary)" : "var(--text-secondary)",
                     borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent", cursor: "pointer" }}>
      {label}
    </button>
  );
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2, padding: "0 12px",
                  background: "var(--bg-canvas)", borderBottom: "1px solid var(--border)" }}>
      <b style={{ fontSize: 15, letterSpacing: 1.5, color: "var(--accent)", marginRight: 16 }}>SAINT VIEW</b>
      {tab("General", !perf, onGeneral)}
      {tab("Performance", perf, onPerf)}
      {tab("Update upload", false, onUpload)}
    </div>
  );
}

/* SAINT VIEW Performance 패널 — 현재 검색 결과의 모달리티 분포(막대) */
function SvPerfCard({ mods }: { mods: Record<string, number> }) {
  const entries = Object.entries(mods).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, n]) => n));
  return (
    <div style={{ padding: "10px 14px", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)" }}>
      <b style={{ fontSize: 13 }}>Performance — 모달리티 분포 (현재 검색 범위)</b>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 8, maxWidth: 560 }}>
        {entries.length === 0 && <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>데이터 없음</span>}
        {entries.map(([m, nn]) => (
          <div key={m} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            <span style={{ width: 44, color: "var(--text-secondary)" }}>{m || "-"}</span>
            <div style={{ flex: 1, background: "var(--bg-elevated)", borderRadius: 3, height: 14, overflow: "hidden" }}>
              <div style={{ width: `${(nn / max) * 100}%`, height: "100%", background: "var(--accent)" }} />
            </div>
            <span style={{ width: 64, textAlign: "right", fontWeight: 700 }}>{nn.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Worklist() {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [searchText, setSearchText] = useState("");
  const [datePreset, setDatePreset] = useState("all");
  const [items, setItems] = useState<StudyRow[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<StudyDetail | null>(null);
  // 다중선택 — Shift=범위, Ctrl/Cmd=개별 토글, 일반=단일. selected(포커스)와 별개의 선택 집합.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const selAnchorRef = useRef<number | null>(null);   // Shift 범위 기준점(마지막 단일/토글 클릭)
  const [compareSet, setCompareSet] = useState<CompareItem[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshSec, setRefreshSec] = useState(10);
  // SEARCH 실행 시각 피드백 — 재조회 시작 시 그리드 깜빡임 (동일 keyframes 2개를 번갈아 써서 연속 클릭에도 재시작)
  const [searchFlash, setSearchFlash] = useState(0);
  const flashMountRef = useRef(false);
  const [columns, setColumns] = useState<string[]>(DEFAULT_COLUMNS);
  // 뷰어별 워크리스트 컬럼 오버라이드(settings>워크리스트>뷰어별) — 모드 전환 시 적용
  const wlColsBaseRef = useRef<string[]>(DEFAULT_COLUMNS);
  const wlByViewerRef = useRef<{ sv?: string[] | null; ty?: string[] | null; infi?: string[] | null }>({});
  const [wlBvTick, setWlBvTick] = useState(0);
  const [findFields, setFindFields] = useState<string[]>(DEFAULT_FIND_FIELDS);
  const [dblAction, setDblAction] = useState<"viewer2d" | "ohif">("viewer2d");
  const [batchOpen, setBatchOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [viewer3dUid, setViewer3dUid] = useState<string | null>(null);
  // Local Server 모드 (레인 F) — ServerButtons 의 sv_server_mode 를 데이터 소스 전환으로 승격.
  // local 이면 서버 worklist 를 호출하지 않고(서버 검사·환자 완전 숨김) local.db 목록만 표시
  const [serverMode, setServerMode] = useState<"local" | "web" | null>(
    () => (localStorage.getItem("sv_server_mode") as "local" | "web") || null);
  const localMode = serverMode === "local";
  // EXAM CONTROL (레인 F) — 관리자 역할일 때만 탭 노출, 선택 시 본문을 검사 QC 화면으로 전환.
  // 탭 바는 TY·In 양 모드 공유이므로 두 모드 모두 자동 지원. 워크리스트 탭 클릭 시 원복.
  const isAdminRole = (localStorage.getItem("sv_role") ?? sessionStorage.getItem("sv_role") ?? "") === "admin";
  const [examCtl, setExamCtl] = useState(false);
  const [localRoot, setLocalRoot] = useState("");           // localInit 결과 루트(배지·Import 안내)
  const [localErr, setLocalErr] = useState("");             // 백엔드 미구현/미설정 → '⚠ 준비 중' 우아 처리
  const [localViewerRow, setLocalViewerRow] = useState<StudyRow | null>(null);   // 로컬 뷰어 모달 대상
  const pickServerMode = useCallback((m: "local" | "web") => {
    setServerMode(m);
    localStorage.setItem("sv_server_mode", m);              // 새로고침에도 유지(기존 키)
    setRefreshKey((k) => k + 1);
  }, []);
  // LOCAL 진입: 폴더 구조 보장(init — 멱등) + 루트 표시, 서버 선택 상태 해제
  useEffect(() => {
    if (!localMode) return;
    setSelected(null);
    api.localInit()
      .then((r) => { setLocalRoot(r.root); setLocalErr(""); })
      .catch((e) => { setLocalRoot(""); setLocalErr(e instanceof Error ? e.message : "준비 중"); });
  }, [localMode]);
  // UBPACS-Z Study Open 5종 + Study With Open — 뷰어는 새 창(별도 웹페이지)으로 연다
  const lastViewerRef = useRef<StudyDetail | null>(null);  // "기존 영상" = 마지막으로 연 검사
  const [ctx, setCtx] = useState<{ x: number; y: number; row: StudyRow } | null>(null);
  // INFINITT Guide ⑦ Search Filter — 모달리티 카운트(모달리티 필터 미적용 시점의 분포 유지)
  const [modCounts, setModCounts] = useState<Record<string, number>>({});
  const [nlPreview, setNlPreview] = useState<NlQueryResult | null>(null);
  const [nlBusy, setNlBusy] = useState(false);
  // 패널 배치 사용자화(드래그) — UBPACS-Z Worklist 구성(p.8):
  // D행 = Order | Related-1(과거검사) | Related-2(비교세트)
  // E행 = Thumbnail | Reference(상용구) | Comment+MEMO | Report
  const [panelOrder, setPanelOrder] = useState<{ d: string[]; e: string[] }>({
    d: ["orders", "prior", "compare"], e: ["thumb", "std", "comment", "report"],
  });
  // 구성요소 표시/숨김 (Study List 제외 추가·삭제 가능 — UBPACS 최대 10 구성)
  const [panelsOn, setPanelsOn] = useState<Record<string, boolean>>({
    orders: true, prior: true, compare: true, thumb: true, std: true, comment: true, report: true,
  });
  // Study With Open (p.13): 더블클릭 시 Related Study를 함께 오픈 (ADD/STACK 모드)
  const [withOpen, setWithOpen] = useState(false);
  const [withOpenMode, setWithOpenMode] = useState<"add" | "stack">("add");
  // UBPACS-Z: 워크리스트 페이지 탭(최대 10) + 검색 폴더 트리 (서버 로밍)
  const [tabs, setTabs] = useState<WorklistTab[]>([DEFAULT_TAB]);
  const [activeTabId, setActiveTabId] = useState(DEFAULT_TAB.id);
  const [treeNodes, setTreeNodes] = useState<TreeNode[]>([]);
  const [selNodeId, setSelNodeId] = useState<string | null>(null);
  const insertRef = useRef<((t: string) => void) | null>(null);
  const phraseShortcutRef = useRef<Record<string, string>>({});  // Alt+키 → 상용구 본문
  // 레이아웃 크기 — 스플리터 드래그로 조절, 로그인 계정에 저장(로밍)
  const [sizes, setSizes] = useState<LayoutSizes>(DEFAULT_SIZES);
  const sizesRef = useRef(sizes);
  useEffect(() => { sizesRef.current = sizes; }, [sizes]);
  const persistSizes = useCallback(() => {
    api.getSetting("worklist.prefs").then((r) =>
      api.putSetting("worklist.prefs", { ...r.value, layout_sizes: sizesRef.current }, "user")).catch(() => {});
  }, []);
  // E행 패널 사이 스플리터: 좌측 패널 폭 조절(좌측이 가변 report면 우측을 역방향 조절)
  const resizeE = useCallback((left: string, right: string, dx: number) => {
    const keyOf = (k: string): keyof LayoutSizes | null =>
      k === "thumb" ? "thumbW" : k === "std" ? "stdW" : k === "comment" ? "commentW" : null;
    const lk = keyOf(left), rk = keyOf(right);
    setSizes((s) => {
      if (lk) return { ...s, [lk]: clampSz(s[lk] + dx, 120, 600) };
      if (rk) return { ...s, [rk]: clampSz(s[rk] - dx, 120, 600) };
      return s;
    });
  }, []);

  // 유효 권한(perm/me) — 로그인 후 1회 로드(캐시). 실패 시 null=전 기능 허용 폴백.
  // 서버가 403 을 강제하므로 이 게이트는 UX(사전 비활성+안내) 목적이다 (레인 W)
  const permMe = usePermMe();
  const allowedAction = useCallback((a: string) => {
    const perm = ACTION_PERM[a];
    return !perm || hasPerm(permMe, perm);
  }, [permMe]);

  // 워크리스트 창에 이름 부여 — 뷰어의 🗂 버튼이 window.open("", "sv_worklist") 로
  // 이 창을 전면으로 올릴 수 있게 한다 (opener.focus() 는 브라우저가 무시하는 경우가 많음)
  useEffect(() => {
    if (!window.name || window.name === "sv_worklist") window.name = "sv_worklist";
  }, []);

  // 사용자 환경설정 로드 (화면분석 §5.4/§5.5)
  useEffect(() => {
    loadHangingPrefs();
    api.getSetting("worklist.prefs").then((r) => {
      const v = r.value as {
        auto_refresh_sec?: number; default_status?: string; columns?: string[];
        find_fields?: string[]; dbl_action?: "viewer2d" | "ohif";
      };
      if (v.auto_refresh_sec !== undefined) setRefreshSec(v.auto_refresh_sec);
      if (v.default_status) setFilters((f) => ({ ...f, status: v.default_status! }));
      if (v.columns?.length) {
        // 저장된 사용자 컬럼 설정(read_state 도입 전 저장분)에 신규 판독 컬럼이 없으면
        // 맨 앞에 가산 보정한다 — 사용자 설정 무시가 아니라 추가만
        const cols = v.columns.filter((c) => COLUMN_DEFS[c]);
        if (!cols.includes("read_state")) cols.unshift("read_state");
        wlColsBaseRef.current = cols;
        wlByViewerRef.current = (v as { by_viewer?: { sv?: string[] | null; ty?: string[] | null; infi?: string[] | null } }).by_viewer ?? {};
        setWlBvTick((t) => t + 1);
        setColumns(cols);
      }
      if (v.find_fields?.length) setFindFields(v.find_fields.filter((c) => FIND_FIELDS[c]));
      if (v.dbl_action) setDblAction(v.dbl_action);
      const po = (v as { panel_order?: { d?: string[]; e?: string[] } }).panel_order;
      if (po?.d?.length === 3 && po?.e?.length === 4) setPanelOrder({ d: po.d, e: po.e });
      const pn = (v as { panels?: Record<string, boolean> }).panels;
      if (pn) setPanelsOn((prev) => ({ ...prev, ...pn }));
      const ls = (v as { layout_sizes?: Partial<LayoutSizes> }).layout_sizes;
      if (ls) setSizes((prev) => ({ ...prev, ...ls }));
    }).catch(() => {});
    loadTabs().then(setTabs).catch(() => {});
    loadTree().then(setTreeNodes).catch(() => {});
    // ETC 섹션의 3D 버튼(Viewer2D 내부) → 3D 뷰어 전환
    const h = (e: Event) => setViewer3dUid((e as CustomEvent).detail as string);
    window.addEventListener("sv-open-3d", h);
    // 07 A.2 SearchShortcut 저장/적용
    const onSave = () => {
      const label = prompt("바로가기 이름 (예: 오늘 CT 미판독)");
      if (!label) return;
      const list = JSON.parse(localStorage.getItem("sv_shortcuts") ?? "[]")
        .filter((s: { label: string }) => s.label !== label);
      list.push({ label, filters: filtersRef.current, searchText: searchRef.current });
      localStorage.setItem("sv_shortcuts", JSON.stringify(list));
      alert(`'${label}' 저장됨`);
    };
    const onApply = (e: Event) => {
      const sc = (e as CustomEvent).detail as { filters: Record<string, string>; searchText: string };
      setFilters(sc.filters ?? {});
      setSearchText(sc.searchText ?? "");
      setRefreshKey((k) => k + 1);
    };
    window.addEventListener("sv-save-shortcut", onSave);
    window.addEventListener("sv-apply-shortcut", onApply);
    return () => {
      window.removeEventListener("sv-open-3d", h);
      window.removeEventListener("sv-save-shortcut", onSave);
      window.removeEventListener("sv-apply-shortcut", onApply);
    };
  }, []);
  const filtersRef = useRef(filters);
  const searchRef = useRef(searchText);
  useEffect(() => { filtersRef.current = filters; searchRef.current = searchText; }, [filters, searchText]);

  // 판독 단축키(UBPACS-Z §5): Enter=View&Draft, B=일괄검토, E=Emergency, F5=새로고침
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 상용구 단축키(Alt+키) — 입력 필드 포커스 중에도 동작 (Conclusion에 삽입)
      if (e.altKey && !e.ctrlKey && !e.metaKey && selected) {
        const text = phraseShortcutRef.current[e.key.toUpperCase()];
        if (text) { e.preventDefault(); insertRef.current?.(text); return; }
      }
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (viewer3dUid || batchOpen) return; // 모달/뷰어 우선
      if (e.key === "Enter" && selected) { e.preventDefault(); void doAction("viewdraft"); }
      // 단축키도 유효 권한 게이트 — 버튼 비활성과 동일 기준 (서버 403 이 최종 방어선)
      else if (e.key.toLowerCase() === "b") { if (!localMode && allowedAction("batch")) setBatchOpen(true); }
      else if (e.key.toLowerCase() === "e" && selected) { if (allowedAction("emergency")) void doAction("emergency"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, viewer3dUid, batchOpen, allowedAction, localMode]);

  const queryParams = useMemo(() => {
    const p: Record<string, string> = { q: searchText };
    for (const k of ["pid", "pname", "sex", "desc", "modality", "status", "body_part", "finding", "emergency", "key"]) {
      if (filters[k]) p[k] = filters[k];
    }
    if (filters.date_from_iso) p.date_from = filters.date_from_iso.replaceAll("-", "");
    if (filters.date_to_iso) p.date_to = filters.date_to_iso.replaceAll("-", "");
    if (filters.tree_from) p.date_from = filters.tree_from;
    return p;
  }, [filters, searchText]);

  useEffect(() => {
    // SEARCH/필터/새로고침으로 재조회가 시작되면 그리드를 짧게 깜빡여 '검색이 동작했음'을 보여준다(최초 로드는 제외)
    if (flashMountRef.current) setSearchFlash((t) => t + 1);
    else flashMountRef.current = true;
    if (localMode) {
      // LOCAL 모드 — 서버 worklist 호출 안 함. local.db 목록(q=검색어)만 표시 (미구현 서버=빈 목록)
      api.localStudies(searchText.trim() || undefined)
        .then((r) => { setItems(r.items.map(localToRow)); setTotal(r.items.length); })
        .catch(() => { setItems([]); setTotal(0); });
      return;
    }
    api.worklist(queryParams).then((r) => {
      setItems(r.items);
      setTotal(r.total);
      // 다중선택은 현재 목록에 남아있는 항목만 유지(검색/새로고침 후 stale id 제거)
      setSelectedIds((prev) => {
        if (!prev.size) return prev;
        const present = new Set(r.items.map((it) => it.id));
        const next = new Set([...prev].filter((id) => present.has(id)));
        return next.size === prev.size ? prev : next;
      });
      // Shift 기준점도 목록에서 사라졌으면 초기화 — 다음 클릭이 새 기준점을 잡도록(stale 범위 방지)
      if (selAnchorRef.current != null && !r.items.some((it) => it.id === selAnchorRef.current)) {
        selAnchorRef.current = null;
      }
    }).catch(() => {});
  }, [queryParams, refreshKey, localMode, searchText]);

  // Search Filter 모달리티 분포 — 모달리티 필터가 꺼진 결과에서만 갱신(필터 중 카운트 유지)
  useEffect(() => {
    if (filters.modality) return;
    const c: Record<string, number> = {};
    items.forEach((r) => { c[r.modality || ""] = (c[r.modality || ""] ?? 0) + 1; });
    setModCounts(c);
  }, [items, filters.modality]);

  useEffect(() => {
    if (!refreshSec) return;
    const t = setInterval(() => setRefreshKey((k) => k + 1), refreshSec * 1000);
    return () => clearInterval(t);
  }, [refreshSec]);

  // 판독 창 항상 열기(설정>판독) — 워크리스트 옆 별도 웹창(?report=1), 선택 동기(sync) 연동
  const readingWinRef = useRef<Window | null>(null);
  const alwaysReadingRef = useRef(false);
  useEffect(() => {
    api.getSetting("report.prefs").then((r) => {
      alwaysReadingRef.current = !!(r.value as { always_report_window?: boolean }).always_report_window;
    }).catch(() => {});
  }, [refreshKey]);
  const ensureReadingWindow = useCallback((id: number) => {
    if (!alwaysReadingRef.current) return;
    if (readingWinRef.current && !readingWinRef.current.closed) return;   // 이미 옆에 떠 있음
    void (async () => {
      const r = await api.getSetting("viewer.prefs").catch(() => ({ value: {} }));
      const mon = (r.value as { monitor?: { report?: number | null } }).monitor?.report;
      // 자동 오픈 게이트 — 설정>모니터에서 '판독' 모니터를 지정한 경우에만 더블클릭 자동 오픈.
      // 미지정이면 자동으로 띄우지 않음(뷰어/워크리스트의 [Reading] 버튼으로만 수동 오픈).
      if (mon == null || mon < 0) return;
      const beside = `left=${window.screenX + Math.max(360, window.outerWidth - 620)},` +
        `top=${window.screenY},width=980,height=${Math.max(600, window.outerHeight - 40)}`;
      const features = await screenFeatures([mon], beside);
      readingWinRef.current = window.open(
        `${window.location.origin}${window.location.pathname}?report=1&study=${id}`, "sv_report", features);
    })();
  }, []);

  const onSelect = useCallback((row: StudyRow, e?: React.MouseEvent) => {
    if (localMode) return;              // LOCAL 모드 — 서버 상세/동기 호출 없음(더블클릭=로컬 뷰어)
    const isCtrl = !!(e && (e.ctrlKey || e.metaKey));
    const isShift = !!(e && e.shiftKey);
    const isCtx = !!(e && (e.type === "contextmenu" || e.button === 2));
    // 다중선택 집합 갱신 — Shift=기준점~현재 범위, Ctrl/Cmd=개별 토글, 우클릭=기존 다중선택 유지, 그 외 단일
    setSelectedIds((prev) => {
      if (isShift && selAnchorRef.current != null) {
        const ids = items.map((r) => r.id);
        const a = ids.indexOf(selAnchorRef.current), b = ids.indexOf(row.id);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          return new Set(ids.slice(lo, hi + 1));
        }
        return new Set([row.id]);
      }
      if (isCtrl) {
        const n = new Set(prev);
        if (n.has(row.id)) n.delete(row.id); else n.add(row.id);
        return n;
      }
      if (isCtx && prev.has(row.id) && prev.size > 1) return prev;   // 우클릭: 선택 유지(배치 컨텍스트)
      return new Set([row.id]);
    });
    // 범위가 실제로 형성될 때만 기준점 유지 — 그 외(단일/Ctrl/기준점 없음·필터아웃)는 클릭 행을 새 기준점으로(범위 기능 사망 방지)
    const rangeFormed = isShift && selAnchorRef.current != null && items.some((r) => r.id === selAnchorRef.current);
    if (!rangeFormed) selAnchorRef.current = row.id;
    // 포커스(상세/연동)는 항상 클릭한 행
    api.study(row.id).then(setSelected);
    postStudySync(row.id, "worklist");  // Viewer·Reading 연동
    ensureReadingWindow(row.id);        // 설정 시 판독 창 자동 오픈(옆 창)
  }, [items, ensureReadingWindow, localMode]);

  // 다른 창(Viewer/Reading)에서 환자가 바뀌면 워크리스트 선택도 따라간다
  useEffect(() => {
    const off = onStudySync("worklist", (id) => {
      api.study(id).then(setSelected).catch(() => {});
      setSelectedIds(new Set([id]));   // 외부 창 포커스 변경 → 다중선택 축소(stale 하이라이트 방지)
      selAnchorRef.current = id;
    });
    return off;
  }, []);
  const onChanged = useCallback(() => {
    setRefreshKey((k) => k + 1);
    if (selected) api.study(selected.id).then(setSelected);
  }, [selected]);

  const openStudy = useCallback((row: StudyRow | StudyDetail) => {
    openViewer(row.study_uid, hpFor(row.modality));
  }, []);

  // 자체 뷰어 오픈 — 새 창(별도 웹페이지, ?viewer=2d)으로 연다. lastViewerRef = UBPACS "기존 영상"
  const openV2 = useCallback((cfg: {
    detail: StudyDetail; addDetail?: StudyDetail; stackDetail?: StudyDetail; keySops?: string[];
    withOpen?: { mode: "add" | "stack"; ids: number[] };
    cmp?: boolean;  // ⇄ Compare 진입 — 뷰어 로드 후 Compare 모달 자동 오픈
  }) => {
    lastViewerRef.current = cfg.addDetail ?? cfg.stackDetail ?? cfg.detail;
    const p = new URLSearchParams({ viewer: "2d", study: String(cfg.detail.id) });
    if (cfg.cmp) p.set("cmp", "1");
    if (cfg.addDetail) p.set("add", String(cfg.addDetail.id));
    if (cfg.stackDetail) p.set("stack", String(cfg.stackDetail.id));
    if (cfg.keySops?.length) p.set("keysops", cfg.keySops.join(","));
    if (cfg.withOpen) {
      p.set("wo_mode", cfg.withOpen.mode);
      p.set("wo_ids", cfg.withOpen.ids.join(","));
    }
    // 같은 이름 창 재사용 — 뷰어 창 1개에 검사가 탭으로 누적.
    // VIEWER_BASE 설정 시 별도 포트(출처)로, 모니터 설정 시 해당 모니터(들)에 배치.
    const base = VIEWER_BASE
      ? `${VIEWER_BASE.replace(/\/$/, "")}/`
      : `${window.location.origin}${window.location.pathname}`;
    // Exam 탭 라벨(Viewer2D 형식과 동일 — 다른 모니터 창의 탭 표시에 사용)
    const d0 = cfg.detail;
    const tabLabel = `${d0.modality} ${d0.body_part || d0.patient_name} ${d0.study_date} #${d0.id}`;
    return viewerMonitorPlan().then(({ slots, modalityMap, tabBinding }) => {
      // 닫힌 창은 추적 맵에서 정리. 살아있는 창이 하나도 없으면 라운드로빈을 1번 모니터부터 재시작.
      for (const [nm, w] of [...openedViewerWindows]) {
        if (w.closed) openedViewerWindows.delete(nm);
      }
      // 모니터별 ◀▶ 탐색 탭(navtab)을 URL 에 실어 뷰어가 그 탭 필터 목록으로 이동하게 한다.
      const urlFor = (monitorIndex: number) => {
        const tab = tabBinding[monitorIndex];
        return tab ? `${base}?${p}&navtab=${encodeURIComponent(tab)}` : `${base}?${p}`;
      };
      // 최저번호 모니터=표준 "sv_viewer"(판독창 참조·재사용), 나머지=sv_viewer_slot{index} (모니터 정체성 기준 고정)
      const nameFor = (monitorIndex: number) =>
        monitorIndex === slots[0]?.index ? "sv_viewer" : `sv_viewer_slot${monitorIndex}`;
      const multi = slots.length > 1 && slots[0].index >= 0;
      if (!multi) {
        // 단일/미감지: 재사용 창 "sv_viewer" 1개. 다중→단일 전환 시 이전 보조 창은 고아이므로 닫는다.
        for (const [nm, ow] of [...openedViewerWindows]) {
          if (nm !== "sv_viewer") { try { ow.close(); } catch { /* 이미 닫힘 */ } openedViewerWindows.delete(nm); }
        }
        const feat = slots[0]?.features ?? "width=1500,height=920";
        const w = window.open(urlFor(slots[0]?.index ?? -1), "sv_viewer", feat);
        applyWindowBounds(w, feat);
        if (w) openedViewerWindows.set("sv_viewer", w);
        w?.focus();
        return;
      }
      // 대상 모니터 결정 — 기본은 번호순 라운드로빈. 예외: 모달리티→모니터 매핑이 있고 그 모니터가
      // 선택 슬롯이면 거기로 오픈(라운드로빈 카운터는 소모하지 않아 일반 검사의 1,2,3 순서 보존).
      if (openedViewerWindows.size === 0) viewerRoundRobin = 0;   // 전부 닫힘 → 1번부터
      const overrideMon = modalityMap.find((r) => r.modality && r.modality === (d0.modality || "").toUpperCase())?.monitor;
      let target = overrideMon != null ? slots.find((s) => s.index === overrideMon) : undefined;
      if (!target) {
        target = slots[viewerRoundRobin % slots.length];
        viewerRoundRobin += 1;
      }
      const targetName = nameFor(target.index);
      // (1) 이미 열린 다른 뷰어 창들 → 탭만 추가(리로드 없음). 대상 창은 아래 URL 로 직접 로드됨.
      postViewerAddTab(d0.id, d0.study_uid, tabLabel);
      // (2) 대상 모니터 창만 열기/네비게이트(=그 뷰어만 전체 리프레시) + 해당 모니터에 배치.
      const w = window.open(urlFor(target.index), targetName, target.features);
      applyWindowBounds(w, target.features);
      if (w) { openedViewerWindows.set(targetName, w); w.focus(); }
      else {
        showToast(
          "팝업이 차단되어 뷰어 창을 열지 못했습니다 — 주소창의 팝업 아이콘에서 이 사이트를 '항상 허용'으로 설정하세요",
          "error",
        );
      }
      // 현재 선택 슬롯 집합에 없는 이전 보조 창(모니터 설정 축소 등)은 닫아 고아 방지
      const validNames = new Set(slots.map((s) => nameFor(s.index)));
      for (const [nm, ow] of [...openedViewerWindows]) {
        if (!validNames.has(nm)) { try { ow.close(); } catch { /* 이미 닫힘 */ } openedViewerWindows.delete(nm); }
      }
    });
  }, []);

  // 선택 + 3창 동기(Viewer·Reading이 같은 환자를 따라감). 포커스만 바뀌는 경로 → 다중선택은 그 행으로 축소(stale 하이라이트/카운트 방지)
  const selectAndSync = useCallback((d: StudyDetail) => {
    setSelected(d);
    setSelectedIds(new Set([d.id]));
    selAnchorRef.current = d.id;
    postStudySync(d.id, "worklist");
    ensureReadingWindow(d.id);
  }, [ensureReadingWindow]);

  const doAction = useCallback(async (a: string, row?: StudyRow) => {
    // LOCAL 모드 — 서버 검사 대상 액션 전면 차단(로컬 id 로 서버 API 오호출 방지). refresh 만 통과
    if (localMode && a !== "refresh") { alert(LOCAL_DENIED_TIP); return; }
    const target = row ?? selected;
    switch (a) {
      case "refresh": setRefreshKey((k) => k + 1); break;
      case "batch": setBatchOpen(true); break;
      case "viewdraft":
        // 다중 선택(Shift/Ctrl) + View 버튼 → 선택 검사를 워크리스트 순서대로 한꺼번에 오픈.
        // 각 openV2 는 라운드로빈으로 다음 모니터에 분산(await 로 순차 → 1,2,3 순서 보장).
        // row(더블클릭)로 온 경우는 단일 오픈(아래) — 다중 오픈은 View 버튼/Enter(row 없음)에서만.
        if (!row && selectedIds.size > 1) {
          const chosen = items.filter((it) => selectedIds.has(it.id));
          let first = true;
          for (const it of chosen) {
            try {
              const d = await api.study(it.id);
              if (first) { selectAndSync(d); first = false; }
              await openV2({ detail: d });
            } catch { /* 개별 실패는 건너뛰고 나머지 오픈 */ }
          }
          break;
        }
        // View&Draft = 자체 뷰어(기본) — 더블클릭 동작은 환경설정에서 변경 가능
        // Study With Open(p.13): 체크 시 Related Study List 검사를 ADD/STACK 모드로 함께 오픈
        if (target) {
          const d = await api.study(target.id);
          selectAndSync(d);
          if (dblAction === "ohif" && ohifOnRef.current) openStudy(d);
          else if (withOpen) {
            // With Open 체크 = 명시적 다중 오픈 — 다른 환자라도 기존 검사에 ADD/STACK 으로 누적.
            // 과거검사(최대 3건)도 함께. related 가 없어도 withOpen 신호를 보내 누적 유지
            openV2({ detail: d, withOpen: { mode: withOpenMode, ids: d.related_exams.slice(0, 3).map((e) => e.id) } });
          } else openV2({ detail: d });
        }
        break;
      case "viewer2d": case "ub_view":
        // 다중 선택(Shift/Ctrl) + View → 선택 검사를 워크리스트 순서대로 한꺼번에(라운드로빈 분산)
        if (!row && selectedIds.size > 1) {
          localStorage.setItem("sv_infi_exams", "[]");
          const chosen = items.filter((it) => selectedIds.has(it.id));
          let first = true;
          for (const it of chosen) {
            try {
              const d = await api.study(it.id);
              if (first) { selectAndSync(d); first = false; }
              await openV2({ detail: d });
            } catch { /* 개별 실패는 건너뛰고 나머지 오픈 */ }
          }
          break;
        }
        // ① View: 기존 영상을 닫고 선택 검사를 그 자리에 표시 — In Viewer 누적 목록 초기화(교체 시맨틱)
        if (target) {
          const d = await api.study(target.id);
          selectAndSync(d);
          localStorage.setItem("sv_infi_exams", "[]");
          openV2({ detail: d });
        }
        break;
      case "ub_add": {
        // ② Add View: 기존 영상(마지막 오픈)은 닫지 않고 선택 검사를 분할 추가
        if (!target) break;
        const d = await api.study(target.id);
        selectAndSync(d);
        const prev = lastViewerRef.current;
        if (prev && prev.id !== d.id) openV2({ detail: prev, addDetail: d });
        else openV2({ detail: d });
        break;
      }
      case "ub_stack": {
        // ③ Stack View: 기존 영상 유지 + 선택 검사를 같은 페인에 중첩
        if (!target) break;
        const d = await api.study(target.id);
        selectAndSync(d);
        const prev = lastViewerRef.current;
        if (prev && prev.id !== d.id) openV2({ detail: prev, stackDetail: d });
        else openV2({ detail: d });
        break;
      }
      case "ub_adv":
        // ④ Advance View: 고급 뷰어(OHIF)로 교체 오픈 — 설정에서 허용 시에만
        if (!ohifOnRef.current) { alert("OHIF는 설정 > 뷰어 > OHIF에서 활성화할 수 있습니다"); break; }
        if (target) openStudy(target);
        break;
      case "ub_key": {
        // ⑤ Key Image View: 키 이미지만 표시 (F-16)
        if (!target) break;
        const d = await api.study(target.id);
        selectAndSync(d);
        const inst = await api.instances(target.id);
        if (!inst.key_images.length) {
          alert("이 검사에 선택된 키 이미지가 없습니다.\nREPORT 패널의 KEY IMG에서 먼저 선택·저장하세요.");
          break;
        }
        openV2({ detail: d, keySops: inst.key_images.map((k) => k.sop_uid) });
        break;
      }
      case "viewer": if (target) openStudy(target); break;
      case "3d": if (target) setViewer3dUid(target.study_uid); break;
      case "compare":
        if (target) setCompareSet((prev) =>
          prev.some((c) => c.study_uid === target.study_uid) ? prev
            : [...prev, { id: target.id, study_uid: target.study_uid, study_date: target.study_date, modality: target.modality, study_desc: target.study_desc }]);
        break;
      case "compareOpen":
        // ⇄ Compare — In Viewer 와 동일: 선택 검사를 뷰어로 열고 과거검사 선택 Compare 모달 자동 오픈
        if (target) {
          const d = await api.study(target.id);
          selectAndSync(d);
          openV2({ detail: d, cmp: true });
        }
        break;
      case "pdf": {
        if (!target) break;
        const reps = await api.reports(target.id);
        if (reps.items[0]) downloadReportPdf(reps.items[0].id);
        break;
      }
      case "regen":
        if (target) {
          try { await api.analyze(target.id); onChanged(); }
          catch (e) { alert((e as Error).message); }   // AI 판독 보류(409) 등 안내
        }
        break;
      case "copyreport": {
        // ③ report_copy(UBPACS-Z): 동일 환자 최근 확정 판독을 현재 초안 Conclusion에 복사
        if (!target) break;
        const d = await api.study(target.id);
        for (const rel of d.related_exams) {
          if (rel.status !== "finalized") continue;
          const prior = (await api.reports(rel.id)).items.find((r) => r.status === "finalized");
          const cur = (await api.reports(target.id)).items[0];
          if (prior && cur && cur.status !== "finalized") {
            const sr = structuredClone(cur.sr_json);
            const copied = prior.sr_json.impression.map((i) => i.statement).join("\n");
            sr.impression[0].statement =
              (sr.impression[0].statement ? sr.impression[0].statement + "\n" : "") +
              `[과거판독 복사 ${rel.study_date}]\n${copied}`;
            await api.updateReport(cur.id, sr);
            onChanged();
            alert(`과거 확정 판독(${rel.study_date})을 Conclusion에 복사했습니다.`);
          }
          break;
        }
        break;
      }
      case "emergency":
        if (target) { await api.setPriority(target.id, !target.emergency); onChanged(); }
        break;
      case "bookmark":
        if (target) { await api.setBookmark(target.id, !target.bookmark); onChanged(); }
        break;
      /* ── 검사 관리(admin-action): 삭제/이동/매칭/언매칭/복제 ──
       * 유효 권한은 서버가 403 으로 강제 — UI 게이트(allowedAction)는 사전 안내(UX)용 */
      case "adm_delete":
        if (!target) break;
        // 파괴 작업 2단계 확인(병원별 관리 탭과 동일 기준)
        if (!window.confirm(
          `[1/2] 검사 삭제 — ${target.patient_name} · ${target.modality} · ${target.study_date}\n` +
          `영상·판독이 함께 삭제되며 되돌릴 수 없습니다. 진행할까요?`)) break;
        if (!window.confirm("[2/2] 최종 확인 — 영구 삭제됩니다. 정말 삭제할까요?")) break;
        try {
          await api.studyAdminAction(target.id, { action: "delete" });
          if (selected?.id === target.id) setSelected(null);
          setRefreshKey((k) => k + 1);
        } catch (e) { alert(e instanceof Error ? e.message : "삭제 실패"); }
        break;
      case "adm_move": case "adm_copy": {
        if (!target) break;
        const isMove = a === "adm_move";
        const verb = isMove ? "이동(재귀속)" : "복제";
        const raw = prompt(isMove
          ? "검사를 이동(재귀속)할 대상 병원 ID(숫자)를 입력하세요"
          : "복제 대상 병원 ID(숫자) — 비우면 같은 병원에 사본을 만듭니다");
        if (raw === null) break;              // 취소
        const hid = raw.trim();
        if (isMove && !hid) break;            // 이동은 대상 필수
        if (hid && !/^\d+$/.test(hid)) { alert("병원 ID는 숫자여야 합니다"); break; }
        try {
          await api.studyAdminAction(target.id, {
            action: isMove ? "move" : "copy",
            ...(hid ? { target_hid: Number(hid) } : {}),
          });
          // 이동 시 검사가 현재 병원 스코프에서 빠질 수 있어 선택 해제 후 목록 갱신
          if (a === "adm_move" && selected?.id === target.id) setSelected(null);
          setRefreshKey((k) => k + 1);
          alert(`검사 ${verb} 완료`);
        } catch (e) { alert(e instanceof Error ? e.message : `${verb} 실패`); }
        break;
      }
      case "adm_match": {
        if (!target) break;
        const oid = prompt("매칭할 오더 ID를 입력하세요 (오더/예약 패널의 오더)")?.trim();
        if (!oid) break;
        try {
          await api.studyAdminAction(target.id, { action: "match", order_id: oid });
          onChanged();
          alert("오더 매칭 완료");
        } catch (e) { alert(e instanceof Error ? e.message : "매칭 실패"); }
        break;
      }
      case "adm_unmatch":
        if (!target) break;
        if (!window.confirm("이 검사의 오더 매칭을 해제(언매칭)할까요?")) break;
        try {
          await api.studyAdminAction(target.id, { action: "unmatch" });
          onChanged();
        } catch (e) { alert(e instanceof Error ? e.message : "언매칭 실패"); }
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, onSelect, openStudy, onChanged, dblAction, withOpen, withOpenMode, openV2, localMode, items, selectedIds]);

  const openCompare = useCallback(() => {
    if (!selected) return;
    openViewerCompare([selected.study_uid, ...compareSet.map((c) => c.study_uid)], hpFor(selected.modality));
  }, [selected, compareSet]);

  // 리포트에서 이전/다음 환자(검사)로 이동 — UBPACS Report Composition
  const navPatient = useCallback(async (dir: 1 | -1) => {
    if (!selected) return;
    const idx = items.findIndex((i) => i.id === selected.id);
    const next = items[idx + dir];
    if (!next) return;
    selectAndSync(await api.study(next.id));
  }, [items, selected, selectAndSync]);

  // 묶음판독(report_merge): 현재 검사 + 비교세트 → 판독 1건 병합 (03b: 건수 명시 confirm)
  const doMerge = useCallback(async () => {
    if (!selected || compareSet.length === 0) return;
    if (!window.confirm(
      `현재 검사 + 비교세트 ${compareSet.length}건을 하나의 판독으로 병합(묶음판독)합니다.\n` +
      `부속 검사 소견은 [MOD 검사일] 태그로 합쳐집니다. 진행할까요?`)) return;
    try {
      await api.mergeReports([selected.id, ...compareSet.map((c) => c.id)]);
      setCompareSet([]);
      onChanged();
      alert("묶음판독 초안이 생성되었습니다 — REPORT 패널에서 검토하세요.");
    } catch (e) {
      alert(e instanceof Error ? e.message : "묶음판독 실패");
    }
  }, [selected, compareSet, onChanged]);

  // S1 자연어 검색: 변환 → 미리보기 배너 → 사용자 적용
  const onNlSearch = useCallback(async (text: string) => {
    setNlBusy(true);
    try { setNlPreview(await api.nlQuery(text)); }
    catch (e) { alert(e instanceof Error ? e.message : "자연어 검색 실패"); }
    finally { setNlBusy(false); }
  }, []);

  /* ── UBPACS-Z 페이지 탭 + 검색 폴더 ── */
  // 탭별 라이브 상태 — 탭을 오가도 각 탭의 검색조건·설정이 독립 보존된다
  const tabLive = useRef<Record<string, {
    filters: Record<string, string>; searchText: string; datePreset: string; selNodeId: string | null;
  }>>({});
  // 탭 전환: 현재 탭 상태를 스냅샷하고, 대상 탭의 라이브 상태(있으면) 또는 저장된 정의를 적용
  const pickTab = (tab: WorklistTab) => {
    tabLive.current[activeTabId] = {
      filters: filtersRef.current, searchText: searchRef.current, datePreset, selNodeId,
    };
    setActiveTabId(tab.id);
    const live = tabLive.current[tab.id];
    if (live) {
      setFilters(live.filters);
      setSearchText(live.searchText);
      setDatePreset(live.datePreset);
      setSelNodeId(live.selNodeId);
    } else {
      setSelNodeId(null);
      setSearchText("");
      setDatePreset(tab.filter.date ?? "all");
      setFilters(folderToFilters(tab.filter));
    }
    setRefreshKey((k) => k + 1);
  };

  // 새 페이지 등록 (최대 10) — 새 탭은 빈 검색으로 시작해 독립적으로 조건을 설정한다.
  // (검색 폴더에서 만들면 그 폴더 조건으로 시작)
  const addTab = useCallback(async (treeFilter?: { label: string; filter: WorklistTab["filter"] }) => {
    if (tabs.length >= 10) { alert("워크리스트 페이지는 최대 10개입니다 (UBPACS-Z 규격)"); return; }
    const label = prompt("새 페이지 이름 — 새 검색으로 시작합니다 (예: CR, 응급실)",
                         treeFilter?.label ?? `WORKLIST ${tabs.length + 1}`);
    if (!label) return;
    // 현재 탭 상태 보존 후 새 탭으로
    tabLive.current[activeTabId] = {
      filters: filtersRef.current, searchText: searchRef.current, datePreset, selNodeId,
    };
    const tab: WorklistTab = { id: newId(), label, filter: treeFilter?.filter ?? {} };
    const next = [...tabs, tab];
    setTabs(next);
    setActiveTabId(tab.id);
    setSelNodeId(null);
    setSearchText("");
    setDatePreset(tab.filter.date ?? "all");
    setFilters(folderToFilters(tab.filter));
    setRefreshKey((k) => k + 1);
    try { await saveTabs(next); } catch (e) { alert(e instanceof Error ? e.message : "페이지 저장 실패"); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, datePreset, activeTabId, selNodeId]);

  const removeTab = useCallback(async (id: string) => {
    const t = tabs.find((x) => x.id === id);
    if (!t || !window.confirm(`'${t.label}' 페이지를 삭제할까요?`)) return;
    const next = tabs.filter((x) => x.id !== id);
    const fixed = next.length ? next : [DEFAULT_TAB];
    setTabs(fixed);
    if (activeTabId === id) pickTab(fixed[0]);
    try { await saveTabs(fixed); } catch {}
  }, [tabs, activeTabId, pickTab]);

  // 폴더 클릭: 루트→폴더 경로 조건 누적 병합 적용 (예: 응급실›DR›Chest)
  const applyFolder = useCallback((node: TreeNode) => {
    setSelNodeId(node.id);
    const merged = mergedFilter(treeNodes, node.id) ?? node.filter;
    setDatePreset(merged.date ?? "");
    setFilters(folderToFilters(merged));
    setRefreshKey((k) => k + 1);
  }, [treeNodes]);

  const onTreeChange = useCallback((next: TreeNode[]) => {
    setTreeNodes(next);
    saveTree(next).catch((e) => alert(e instanceof Error ? e.message : "검색 폴더 저장 실패"));
  }, []);

  // 패널 자리 교환 + 서버 저장(로밍)
  const onPanelDrop = useCallback((zone: "d" | "e", src: string, dst: string) => {
    if (src === dst) return;
    setPanelOrder((prev) => {
      const arr = [...prev[zone]];
      const i = arr.indexOf(src), j = arr.indexOf(dst);
      if (i < 0 || j < 0) return prev;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      const next = { ...prev, [zone]: arr };
      api.getSetting("worklist.prefs").then((r) =>
        api.putSetting("worklist.prefs", { ...r.value, panel_order: next }, "user")).catch(() => {});
      return next;
    });
  }, []);

  const applyNlPreview = useCallback(() => {
    if (!nlPreview) return;
    const f = nlPreview.filter;
    const next: Record<string, string> = {};
    if (f.patient_id) next.pid = f.patient_id;
    if (f.patient_name) next.pname = f.patient_name;
    if (f.sex) next.sex = f.sex;
    if (f.modality) next.modality = f.modality;
    if (f.body_part) next.body_part = f.body_part;
    if (f.study_desc) next.desc = f.study_desc;
    if (f.status) next.status = f.status;
    if (f.finding) next.finding = f.finding;
    if (f.emergency) next.emergency = "true";
    const iso = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    if (f.date_from) next.date_from_iso = iso(f.date_from);
    if (f.date_to) next.date_to_iso = iso(f.date_to);
    setDatePreset("all");
    setFilters(next);
    setNlPreview(null);
    setRefreshKey((k) => k + 1);
  }, [nlPreview]);

  const emergencyCount = useMemo(() => items.filter((i) => i.emergency).length, [items]);

  // In 모드 워크리스트 배치 — 선택 뷰어(viewer.prefs.client_viewer)=infi 면 INFINITT 원본 7구역 배치,
  // ty 면 현행(TY) 배치 유지. 설정 저장/⟳Refresh 시 refreshKey 로 즉시 재적용.
  const [infiMode, setInfiMode] = useState(false);
  // SAINT VIEW 모드 — client_viewer=sv 면 SAINT VIEW 워크리스트 스킨(상태 카운트 바 + SV 컬럼, infi 7구역 레이아웃 재사용)
  const [svMode, setSvMode] = useState(false);
  // 뷰어별 컬럼 적용 — 현재 모드(sv/infi/ty)의 오버라이드가 있으면 공통 대신 사용
  useEffect(() => {
    const key = svMode ? "sv" : infiMode ? "infi" : "ty";
    const ov = wlByViewerRef.current[key as "sv" | "ty" | "infi"];
    const next = (ov?.length ? ov.filter((c) => COLUMN_DEFS[c]) : wlColsBaseRef.current);
    if (next?.length) setColumns(next.includes("read_state") ? next : ["read_state", ...next]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svMode, infiMode, wlBvTick]);
  const [svPerf, setSvPerf] = useState(false);   // SAINT VIEW 상단 탭 — General/Performance 전환
  // OHIF 표시/동작 — 기본 숨김, 설정>뷰어>OHIF 에서 허용 (viewer.prefs.ohif_enabled)
  const [ohifOn, setOhifOn] = useState(false);
  const ohifOnRef = useRef(false);
  useEffect(() => {
    api.getSetting("viewer.prefs").then((r) => {
      const cv = (r.value as { client_viewer?: string }).client_viewer;
      setInfiMode(cv === "infi");
      setSvMode(cv === "sv");
      const on = !!(r.value as { ohif_enabled?: boolean }).ohif_enabled;
      setOhifOn(on);
      ohifOnRef.current = on;
    }).catch(() => {});
  }, [refreshKey]);
  // Infi 레이아웃 패널 크기(px) — 각 경계 스플리터로 드래그 조절 후 계정 저장
  const [infiSz, setInfiSz] = useState({ prevH: 220, priorH: 96, repH: 260 });
  useEffect(() => {
    api.getSetting("worklist.prefs").then((r) => {
      const s = (r.value as { infi_sizes?: typeof infiSz }).infi_sizes;
      if (s) setInfiSz((p) => ({ ...p, ...s }));
    }).catch(() => {});
  }, []);
  const persistInfiSz = useCallback(() => {
    api.getSetting("worklist.prefs").then((r) =>
      api.putSetting("worklist.prefs", { ...r.value, infi_sizes: infiSzRef.current }, "user")).catch(() => {});
  }, []);
  const infiSzRef = useRef(infiSz);

  // In/SAINT VIEW 좌측 검색레일 스크롤 보장 — flex 체인 대신 실제 top 을 측정해 뷰포트 기준 maxHeight 를
  // 직접 지정한다(상단 바 구성이 바뀌어도 정확, 브라우저 환경차 무관). 렌더/리사이즈마다 재측정.
  const railScrollRef = useRef<HTMLDivElement | null>(null);
  const fitRail = useCallback(() => {
    const el = railScrollRef.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    // 아래 여백 = Preview(prevH) + h-스플리터(6) + 소폭 마진. 최소 80px 보장.
    const h = Math.max(80, Math.round(window.innerHeight - top - infiSzRef.current.prevH - 14));
    el.style.maxHeight = `${h}px`;
  }, []);
  useLayoutEffect(fitRail);   // 매 렌더 후 재측정(조건부 상단 바 출현/사라짐까지 반영)
  useEffect(() => {
    window.addEventListener("resize", fitRail);
    return () => window.removeEventListener("resize", fitRail);
  }, [fitRail]);
  useEffect(() => { infiSzRef.current = infiSz; }, [infiSz]);

  // In 모드 ① 상단 아이콘 툴바 (INFINITT 원본 13종) — 기존 doAction + 특수 동작 매핑
  const infiTool = (act: string) => {
    // LOCAL 모드 — Import/Export/Print/Refresh/Logout 만 허용, 나머지 서버 액션 차단
    if (localMode && !LOCAL_OK_ACTIONS.has(act) && act !== "refresh") { alert(LOCAL_DENIED_TIP); return; }
    switch (act) {
      case "import": setImportOpen(true); break;  // Import DICOM — USB/CD .dcm 등록
      case "reading": {   // Report 창 — 판독 작성 (모니터 설정 반영, 선택 연동은 sync)
        if (!selected) { alert("검사를 먼저 선택하세요"); break; }
        void (async () => {
          const r = await api.getSetting("viewer.prefs").catch(() => ({ value: {} }));
          const mon = (r.value as { monitor?: { report?: number | null } }).monitor?.report;
          const features = await screenFeatures(mon != null && mon >= 0 ? [mon] : null,
            "width=1280,height=860");
          const w = window.open(
            `${window.location.origin}${window.location.pathname}?report=1&study=${selected.id}`,
            "sv_report", features);
          w?.focus();
        })();
        break;
      }
      case "csv": {   // Export — 현재 워크리스트를 CSV 로 (원본 Export result to file)
        const rows = [
          ["PatientID", "Name", "Sex", "Modality", "StudyDate", "Description", "Status"].join(","),
          ...items.map((r) => [r.patient_key, r.patient_name, r.sex, r.modality, r.study_date,
                               (r.study_desc ?? "").replaceAll(",", " "), r.status].join(",")),
        ].join("\n");
        const url = URL.createObjectURL(new Blob(["﻿" + rows], { type: "text/csv;charset=utf-8" }));
        const a = document.createElement("a");
        a.href = url; a.download = `worklist_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
        URL.revokeObjectURL(url);
        break;
      }
      case "print": window.print(); break;
      case "logout":
        localStorage.setItem("sv_logout", String(Date.now()));   // 뷰어 창도 닫기
        localStorage.removeItem("sv_token"); sessionStorage.removeItem("sv_token");
        location.href = "/"; break;
      default: void doAction(act);
    }
  };
  // 열린 문 로그아웃 아이콘 — 3D 스타일(그라데이션 문틀/나무 문짝/하이라이트), 이웃 이모지(22px)와 크기 정렬
  const openDoorIcon = (
    <svg width="20" height="20" viewBox="0 0 24 24"
         style={{ display: "block", filter: "drop-shadow(0 1.2px 1.2px rgba(0,0,0,0.6))" }}>
      <defs>
        <linearGradient id="svDoorFrame" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7c8aa0" /><stop offset="1" stopColor="#3b4859" />
        </linearGradient>
        <linearGradient id="svDoorWood" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#d99a4e" /><stop offset="0.5" stopColor="#b06f2c" />
          <stop offset="1" stopColor="#7a4718" />
        </linearGradient>
        <linearGradient id="svDoorIn" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0f172a" /><stop offset="1" stopColor="#020617" />
        </linearGradient>
      </defs>
      <rect x="2.6" y="2" width="11.4" height="20" rx="1.2" fill="url(#svDoorFrame)" />   {/* 문틀 */}
      <rect x="4.1" y="3.6" width="8.4" height="16.8" fill="url(#svDoorIn)" />            {/* 열린 안쪽 */}
      <path d="M12.5 3 L21 0.8 V21.2 L12.5 23.4 Z" fill="url(#svDoorWood)" stroke="#5b3617" strokeWidth="0.6" />  {/* 열린 문짝 */}
      <path d="M12.5 3 L21 0.8 L21 2.6 L12.5 4.8 Z" fill="#f0c078" opacity="0.85" />       {/* 윗면 하이라이트 */}
      <path d="M12.5 21.4 L21 19.2 L21 21.2 L12.5 23.4 Z" fill="#4a2c10" opacity="0.9" />  {/* 아랫면 음영 */}
      <circle cx="14.6" cy="12.6" r="1" fill="#f8e3b0" stroke="#8a5a20" strokeWidth="0.4" /> {/* 손잡이 */}
      <path d="M5.4 12 H10 M8.2 9.7 L10.6 12 L8.2 14.3" stroke="#38bdf8" strokeWidth="1.7"
            fill="none" strokeLinecap="round" strokeLinejoin="round" />                     {/* 나가는 화살표 */}
    </svg>
  );
  const INFI_ICONS: { i: React.ReactNode; l: string; a: string }[] = [
    { i: "🖥", l: "View — 선택 검사를 In Viewer 로 열기", a: "viewer2d" },
    { i: "🌐", l: "Advanced View — OHIF 웹뷰어", a: "ub_adv" },
    { i: "🧊", l: "3D — MPR/MIP 뷰어", a: "3d" },
    { i: "⇄", l: "Compare — 뷰어에서 과거검사 선택 비교(모달) 열기", a: "compareOpen" },
    { i: "📥", l: "Import — DICOM 파일 업로드(Orthanc)", a: "import" },
    { i: "📤", l: "Export — 워크리스트 CSV 내보내기", a: "csv" },
    { i: "🖨", l: "Print — 화면 인쇄", a: "print" },
    { i: "📄", l: "Report — 판독서 PDF 내려받기", a: "pdf" },
    { i: "📝", l: "Report 창 — 판독 작성 창 열기(선택 검사)", a: "reading" },
    { i: "🤖", l: "AI — 초안 재생성", a: "regen" },
    { i: "📋", l: "Batch — AI 일괄 검토 (B)", a: "batch" },
    { i: "🚨", l: "Emergency 토글 (E)", a: "emergency" },
    { i: "🔄", l: "Refresh — 목록 새로고침", a: "refresh" },
    { i: openDoorIcon, l: "Logout — 로그아웃", a: "logout" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 0 }}>
      {/* UBPACS-Z: 워크리스트 페이지 탭 — 저장된 검색 정의 전환.
          우측(Local Server 왼쪽)에 액션 버튼 그룹 노출(요청) — Infi 모드는 아래 아이콘 툴바가 동일 기능이라 생략 */}
      <WorklistTabsBar tabs={tabs} activeId={examCtl ? "" : activeTabId}
                       onPick={(t) => { setExamCtl(false); pickTab(t); }}
                       onAdd={() => { setExamCtl(false); void addTab(); }}
                       onRemove={(id) => void removeTab(id)}
                       serverMode={serverMode} onServerMode={pickServerMode}
                       extraTab={isAdminRole && (
                         /* 관리자 전용 EXAM CONTROL 탭 — 기존 탭과 동일 스타일 + 보라 포인트 */
                         <div onClick={() => setExamCtl(true)}
                              title="Exam Control — 관리자 검사 QC (삭제·복구·Unassign·Assign)"
                              style={{
                                display: "flex", alignItems: "center", gap: 6, padding: "4px 11px",
                                borderRadius: "4px 4px 0 0", cursor: "pointer", fontSize: 11.5, fontWeight: 700,
                                background: examCtl ? "var(--ai,#a78bfa)" : "var(--bg-elevated)",
                                color: examCtl ? "#fff" : "var(--ai,#a78bfa)",
                                border: "1px solid var(--ai,#a78bfa)", borderBottom: "none", whiteSpace: "nowrap",
                              }}>
                           EXAM CONTROL
                         </div>
                       )}
                       actions={!infiMode && !svMode && !examCtl && (
                         <>
                           {([
                             ["reading", "📝 Reading", "Report 창 — 판독 작성 창 열기(선택 검사)"],
                             ["import", "📥 Import", "Import — DICOM 파일/폴더 업로드(Orthanc)"],
                             ["csv", "📤 Export", "Export — 워크리스트 CSV 내보내기"],
                             ["print", "🖨 Print", "Print — 화면 인쇄"],
                             ["pdf", "📄 PDF", "판독서 PDF"],
                             ["emergency", "⚠ Emergency", "응급 우선순위 토글 (F-15)"],
                             ["regen", "🤖 AI", "AI — 초안 재생성"],
                             ["batch", "📋 일괄 검토", "AI 초안 일괄 검토 (F-22)"],
                             ["refresh", "🔄 새로고침", "목록 새로고침"],
                           ] as const).map(([a, label, title]) => {
                             // LOCAL 모드: 서버 전용 액션은 비활성+안내 툴팁 (Import/Export/Print/새로고침만 활성)
                             const localBlocked = localMode && !LOCAL_OK_ACTIONS.has(a);
                             const ok = allowedAction(a) && !localBlocked;
                             return (
                               <button key={a} disabled={!ok}
                                       title={ok ? title : localBlocked ? LOCAL_DENIED_TIP : PERM_DENIED_TIP}
                                       onClick={() => infiTool(a)}
                                       style={{ padding: "2px 8px", fontSize: 11, whiteSpace: "nowrap" }}>
                                 {label}
                               </button>
                             );
                           })}
                         </>
                       )} />
      {/* EXAM CONTROL 본문 (레인 F) — 관리자 검사 QC. 선택 시 워크리스트 본문 전체를 대체.
          source: Local Server 모드(sv_server_mode=local)면 로컬 PACS(/api/local/examctl), 아니면 서버(/api/examctl) */}
      {examCtl ? (
        <Suspense fallback={<div style={{ padding: 20, color: "var(--text-secondary)" }}>Exam Control 로딩…</div>}>
          <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 8, display: "flex", flexDirection: "column" }}>
            <ExamControl source={serverMode === "local" ? "local" : "server"} />
          </div>
        </Suspense>
      ) : (
      <>
      {/* LOCAL 모드 배지 — 데이터 소스·루트 표시 + 서버 데이터 숨김 안내 (레인 F) */}
      {localMode && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 10px",
                      background: "rgba(245,158,11,0.12)", borderBottom: "1px solid #f59e0b", fontSize: 12 }}>
          <b style={{ color: "#f59e0b" }}>LOCAL 모드</b>
          <span>서버 데이터 숨김 · 데이터: <code style={{ fontSize: 11 }}>
            {localRoot || (localErr ? `⚠ 준비 중 (${localErr})` : "확인 중…")}</code></span>
          <span style={{ marginLeft: "auto", color: "var(--text-secondary)", fontSize: 11 }}>
            Import·새로고침·로컬 뷰어(더블클릭)만 사용 가능 — 해제: Web Server
          </span>
        </div>
      )}
      {/* ── In 모드 ① 아이콘 툴바 (원본 우측 상단 13종) ── */}
      {infiMode && (
        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8,
                      padding: "3px 10px", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", gap: 4, padding: "3px 6px", border: "1px solid var(--border)",
                        borderRadius: 6, background: "var(--bg-elevated)" }}>
            {INFI_ICONS.filter((t) => t.a !== "ub_adv" || ohifOn).map((t) => {
              // 유효 권한 게이트 + LOCAL 모드 게이트 — 비활성+안내 툴팁 (UX 목적)
              const localBlocked = localMode && !LOCAL_OK_ACTIONS.has(t.a);
              const ok = allowedAction(t.a) && !localBlocked;
              return (
                <button key={t.a} disabled={!ok}
                        title={ok ? t.l : `${t.l} — ${localBlocked ? LOCAL_DENIED_TIP : PERM_DENIED_TIP}`}
                        onClick={() => infiTool(t.a)}
                        style={{ width: 46, height: 40, fontSize: 22, padding: 0, border: "none",
                                 display: "flex", alignItems: "center", justifyContent: "center",
                                 background: "transparent", cursor: ok ? "pointer" : "not-allowed",
                                 opacity: ok ? 1 : 0.35, borderRadius: 5 }}
                        onMouseEnter={ok ? (e) => (e.currentTarget.style.background = "var(--accent-subtle)") : undefined}
                        onMouseLeave={ok ? (e) => (e.currentTarget.style.background = "transparent") : undefined}>
                  {t.i}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {/* SAINT VIEW 상단 탭(General/Performance/Update upload) + 상태 카운트 바 (그림1) */}
      {svMode && (
        <>
          <SvTabStrip perf={svPerf} onGeneral={() => setSvPerf(false)} onPerf={() => setSvPerf(true)}
                      onUpload={() => setImportOpen(true)} />
          {svPerf
            ? <SvPerfCard mods={modCounts} />
            : <SvStatusBar queryParams={queryParams} refreshKey={refreshKey} items={items}
                           onStatus={(p) => { setFilters((f) => ({ ...f, ...p })); setRefreshKey((k) => k + 1); }}
                           onRefresh={() => setRefreshKey((k) => k + 1)} />}
        </>
      )}
      <ActionToolbar selected={selected} onAction={(a) => doAction(a)}
                     searchText={searchText} setSearchText={setSearchText}
                     onSearch={() => setRefreshKey((k) => k + 1)}
                     onNlSearch={onNlSearch}
                     withOpen={withOpen} setWithOpen={setWithOpen}
                     withOpenMode={withOpenMode} setWithOpenMode={setWithOpenMode}
                     ohifOn={ohifOn} allowed={allowedAction} />
      <FilterBar filters={filters} setFilters={setFilters} fields={findFields}
                 onSearch={() => setRefreshKey((k) => k + 1)} />

      {/* 다중선택 상태 바 — Shift(범위)/Ctrl·Cmd(개별) 로 여러 Exam 선택 시 표시 */}
      {selectedIds.size > 1 && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 12px",
                      background: "var(--accent-subtle, rgba(96,165,250,0.12))", borderBottom: "1px solid var(--border)", fontSize: 12 }}>
          <b>{selectedIds.size}개 Exam 선택됨</b>
          <button style={{ padding: "2px 10px" }} onClick={() => { setSelectedIds(new Set(items.map((r) => r.id))); selAnchorRef.current = items[0]?.id ?? null; }}>모두 선택</button>
          <button style={{ padding: "2px 10px" }} onClick={() => { setSelectedIds(new Set(selected ? [selected.id] : [])); selAnchorRef.current = selected?.id ?? null; }}>선택 해제</button>
          <span style={{ marginLeft: "auto", color: "var(--text-secondary)", fontSize: 11 }}>
            Shift+클릭 = 범위 · Ctrl/Cmd+클릭 = 개별 토글
          </span>
        </div>
      )}

      {/* S1 자연어 검색 미리보기 — 적용 전 사용자 확인(03b: AI 결과는 항상 라벨링) */}
      {(nlBusy || nlPreview) && (
        <div style={{
          display: "flex", gap: 8, alignItems: "center", padding: "5px 10px",
          background: "var(--bg-panel)", borderBottom: "1px solid var(--ai)", fontSize: 12.5,
        }}>
          <span className="badge ai">AI 검색</span>
          {nlBusy ? (
            <span style={{ color: "var(--text-secondary)" }}>변환 중…</span>
          ) : nlPreview && (
            <>
              <span>해석: <b>{nlPreview.explanation}</b></span>
              {nlPreview.source !== "live" && (
                <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>
                  ({nlPreview.source === "mock" ? "규칙 기반" : "AI 실패 — 규칙 기반 폴백"})
                </span>
              )}
              <button className="primary" style={{ padding: "1px 12px", fontSize: 12 }} onClick={applyNlPreview}>적용</button>
              <button style={{ padding: "1px 10px", fontSize: 12 }} onClick={() => setNlPreview(null)}>취소</button>
            </>
          )}
        </div>
      )}

      {/* ── In / SAINT VIEW 모드 배치 (7구역): 좌열=⑦Search Filter+⑤Preview,
             우열=③Study Grid→④Related Exam→⑥Report. SAINT VIEW 는 SV 컬럼 + 상단 상태바 사용 ── */}
      {(infiMode || svMode) && (
        <div style={{ display: "flex", flex: 1, minHeight: 0, gap: 0, padding: 3 }}>
          {/* 좌열: Search Filter(위) ─h스플리터─ Preview(아래, prevH) */}
          <div style={{ width: sizes.railW, display: "flex", flexDirection: "column", flexShrink: 0, minHeight: 0 }}>
            <div ref={railScrollRef}
                 style={{ flex: 1, minHeight: 0, overflow: "auto", display: "block", background: "var(--bg-panel)" }}>
              <SearchRail width={sizes.railW} active={datePreset} unifiedScroll
                          mods={modCounts} activeMod={filters.modality ?? ""}
                          onMod={(m) => setFilters((f) => ({ ...f, modality: m }))}
                          onPick={(key, from) => {
                            setDatePreset(key);
                            setFilters((f) => ({ ...f, tree_from: from, date_from_iso: "", date_to_iso: "" }));
                          }} tree={
                <FolderTreeEditor nodes={treeNodes} onChange={onTreeChange}
                                  selectedId={selNodeId} onSelect={applyFolder} applyHint />
              } />
            </div>
            <Splitter dir="h" onEnd={persistInfiSz}
                      onDrag={(dy) => setInfiSz((s) => ({ ...s, prevH: clampSz(s.prevH - dy, 80, 600) }))} />
            {/* ⑤ Preview — 선택 검사 미리보기 (원본 좌하단 흑배경) */}
            <div style={{ height: infiSz.prevH, flexShrink: 0, background: "#000", border: "1px solid var(--border)",
                          borderRadius: 4, overflow: "hidden", display: "flex" }}>
              <ThumbnailPanel detail={selected} onOpen={() => void doAction("viewdraft")} />
            </div>
          </div>
          {/* 좌|우 세로 스플리터 (railW) */}
          <Splitter dir="v" onEnd={persistSizes}
                    onDrag={(dx) => setSizes((s) => ({ ...s, railW: clampSz(s.railW + dx, 100, 460) }))} />
          {/* 우열: Grid(위) ─h─ Related(priorH) ─h─ Report(repH) */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
            <div style={{ flex: 1, minHeight: 60, display: "flex",
                          ...(searchFlash ? { animation: `${searchFlash % 2 ? "wlSearchFlashA" : "wlSearchFlashB"} 0.5s ease` } : {}) }}>
              <StudyGrid items={items} columns={svMode ? SV_COLUMNS : INFI_COLUMNS} variant="infi" selectedId={selected?.id ?? null} selectedIds={selectedIds}
                         treeDisabled={localMode}
                         onSelect={onSelect}
                         onOpen={(r) => { if (localMode) setLocalViewerRow(r); else void doAction("viewdraft", r); }}
                         onContext={(e, r) => setCtx({ x: e.clientX, y: e.clientY, row: r })} />
            </div>
            <Splitter dir="h" onEnd={persistInfiSz}
                      onDrag={(dy) => setInfiSz((s) => ({ ...s, priorH: clampSz(s.priorH - dy, 48, 320) }))} />
            <div style={{ height: infiSz.priorH, flexShrink: 0, display: "flex" }}>
              <PriorStudiesGrid detail={selected}
                                onAddCompare={(e) => setCompareSet((prev) =>
                                  prev.some((c) => c.study_uid === e.study_uid) ? prev : [...prev, e])} />
            </div>
            <Splitter dir="h" onEnd={persistInfiSz}
                      onDrag={(dy) => setInfiSz((s) => ({ ...s, repH: clampSz(s.repH - dy, 80, 640) }))} />
            <div style={{ height: infiSz.repH, flexShrink: 0, display: "flex" }}>
              <InfiReport detail={selected} />
            </div>
          </div>
        </div>
      )}

      {/* 중단: 검색 레일(기간+폴더 트리) + 메인 그리드 — 좌우 스플리터 (TY 배치) */}
      {!infiMode && !svMode && (
      <div style={{ display: "flex", flex: 2.2, minHeight: 0 }}>
        <SearchRail width={sizes.railW} active={datePreset}
                    mods={modCounts} activeMod={filters.modality ?? ""}
                    onMod={(m) => setFilters((f) => ({ ...f, modality: m }))}
                    onPick={(key, from) => {
          setDatePreset(key);
          setFilters((f) => ({ ...f, tree_from: from, date_from_iso: "", date_to_iso: "" }));
        }} tree={
          <FolderTreeEditor nodes={treeNodes} onChange={onTreeChange}
                            selectedId={selNodeId} onSelect={applyFolder} applyHint />
        } />
        <Splitter dir="v" onEnd={persistSizes}
                  onDrag={(dx) => setSizes((s) => ({ ...s, railW: clampSz(s.railW + dx, 100, 420) }))} />
        <div style={{ flex: 1, minWidth: 0, display: "flex",
                      ...(searchFlash ? { animation: `${searchFlash % 2 ? "wlSearchFlashA" : "wlSearchFlashB"} 0.5s ease` } : {}) }}>
          <StudyGrid items={items} columns={columns} selectedId={selected?.id ?? null} selectedIds={selectedIds}
                     treeDisabled={localMode}
                     onSelect={onSelect}
                     onOpen={(r) => { if (localMode) setLocalViewerRow(r); else void doAction("viewdraft", r); }}
                     onContext={(e, r) => setCtx({ x: e.clientX, y: e.clientY, row: r })} />
        </div>
      </div>
      )}

      {/* 하단1 (UBPACS p.8): Order | Related Study List-1 | Related Study List-2 — 드래그 재배치 + 상하 스플리터 */}
      {!infiMode && !svMode && panelOrder.d.some((k) => panelsOn[k]) && (
        <Splitter dir="h" onEnd={persistSizes}
                  onDrag={(dy) => setSizes((s) => ({ ...s, dH: clampSz(s.dH - dy, 80, 420) }))} />
      )}
      {!infiMode && !svMode && panelOrder.d.some((k) => panelsOn[k]) && (
        <div style={{ display: "flex", gap: 3, height: sizes.dH, padding: "3px 3px 0", flexShrink: 0 }}>
          {panelOrder.d.filter((k) => panelsOn[k]).map((k) => (
            <DraggablePanel key={k} zone="d" k={k} onDrop={onPanelDrop} style={{ flex: 1 }}>
              {k === "orders" ? <OrdersPanel refreshKey={refreshKey} />
                : k === "prior" ? (
                  <PriorStudiesGrid detail={selected}
                                    onAddCompare={(e) => setCompareSet((prev) =>
                                      prev.some((c) => c.study_uid === e.study_uid) ? prev : [...prev, e])} />
                ) : (
                  <ComparisonSetGrid items={compareSet} current={selected}
                                     onRemove={(uid) => setCompareSet((p) => p.filter((c) => c.study_uid !== uid))}
                                     onOpenCompare={openCompare} onMerge={doMerge} />
                )}
            </DraggablePanel>
          ))}
        </div>
      )}

      {/* 하단2 (UBPACS p.8): Thumbnail | Reference(상용구) | Comment+MEMO | Report — 드래그 재배치 + 스플리터 */}
      {!infiMode && !svMode && panelOrder.e.some((k) => panelsOn[k]) && (
        <Splitter dir="h" onEnd={persistSizes}
                  onDrag={(dy) => setSizes((s) => ({ ...s, eH: clampSz(s.eH - dy, 140, 640) }))} />
      )}
      {!infiMode && !svMode && panelOrder.e.some((k) => panelsOn[k]) && (
        <div style={{ display: "flex", gap: 3, height: sizes.eH, flexShrink: 0, padding: 3 }}>
          {(() => {
            const arr = panelOrder.e.filter((k) => panelsOn[k]);
            return arr.flatMap((k, i) => {
              const out = [(
                <DraggablePanel key={k} zone="e" k={k} onDrop={onPanelDrop}
                                style={k === "thumb" ? { width: sizes.thumbW, flexShrink: 0 }
                                     : k === "std" ? { width: sizes.stdW, flexShrink: 0 }
                                     : k === "comment" ? { width: sizes.commentW, flexShrink: 0 }
                                     : { flex: 1.6 }}>
                  {k === "thumb" ? <ThumbnailPanel detail={selected} onOpen={() => void doAction("viewdraft")} />
                    : k === "std" ? <PhrasePanel onInsert={(t) => insertRef.current?.(t)} current={selected}
                                                 shortcutRef={phraseShortcutRef} />
                    : k === "comment" ? <CommentMemoPanel detail={selected} onChanged={onChanged} />
                    : <ReportPanel detail={selected} onChanged={onChanged} insertRef={insertRef} onNav={navPatient} />}
                </DraggablePanel>
              )];
              if (i < arr.length - 1) {
                out.push(<Splitter key={`sp-${k}`} dir="v" onEnd={persistSizes}
                                   onDrag={(dx) => resizeE(k, arr[i + 1], dx)} />);
              }
              return out;
            });
          })()}
        </div>
      )}

      {/* 상태바 (§2) */}
      <footer style={{
        display: "flex", gap: 16, padding: "3px 12px", background: "var(--bg-panel)",
        borderTop: "1px solid var(--border)", fontSize: 11.5, color: "var(--text-secondary)", flexShrink: 0,
      }}>
        <span>[Q][H] Server: http://localhost:8000</span>
        <span>{total} results {selected ? "1 selected" : "0 selected"}</span>
        {emergencyCount > 0 && <span style={{ color: "var(--stat-emergency)" }}>⚠ Emergency {emergencyCount}건</span>}
        <span style={{ marginLeft: "auto" }}>{new Date().toLocaleString("ko-KR")}</span>
      </footer>

      {batchOpen && <BatchReviewModal onClose={() => setBatchOpen(false)} onDone={() => setRefreshKey((k) => k + 1)} />}
      {importOpen && (
        <Suspense fallback={null}>
          <ImportDialog onClose={() => setImportOpen(false)}
                        localMode={localMode} localRoot={localRoot}
                        onDone={() => {
                          // CD 영상은 검사일이 과거인 경우가 많아 기간 필터를 '전체'로 풀어 바로 보이게 한다
                          setDatePreset("all");
                          setFilters((f) => ({ ...f, tree_from: "", date_from_iso: "", date_to_iso: "" }));
                          setRefreshKey((k) => k + 1);
                        }} />
        </Suspense>
      )}
      {/* 로컬 뷰어 — LOCAL 모드 검사 더블클릭(경량 뷰어 모달, 레인 F) */}
      {localViewerRow && (
        <Suspense fallback={null}>
          <LocalViewer studyId={localViewerRow.id}
                       title={`${localViewerRow.patient_name || localViewerRow.patient_key} · ` +
                              `${localViewerRow.modality} ${localViewerRow.study_date}` +
                              (localViewerRow.study_desc ? ` · ${localViewerRow.study_desc}` : "")}
                       onClose={() => setLocalViewerRow(null)} />
        </Suspense>
      )}
      {/* 자체 뷰어(Viewer2D)는 새 창(?viewer=2d)으로 열린다 — openV2 참조 */}
      {viewer3dUid && (
        <Suspense fallback={
          <div style={{ position: "fixed", inset: 0, background: "var(--bg-canvas)", zIndex: 200, display: "grid", placeItems: "center", color: "var(--text-secondary)" }}>
            3D 뷰어 로딩…
          </div>
        }>
          <Viewer3D studyUid={viewer3dUid} onClose={() => setViewer3dUid(null)} />
        </Suspense>
      )}
      {ctx && localMode ? (
        /* LOCAL 모드 우클릭 — 서버 컨텍스트 메뉴 대신 로컬 전용(뷰어/삭제)만 (로컬 id 서버 오호출 방지) */
        <div style={{ position: "fixed", left: ctx.x, top: ctx.y, zIndex: 500, minWidth: 168,
                      background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 6,
                      boxShadow: "0 6px 20px rgba(0,0,0,0.5)", fontSize: 12.5, padding: 4 }}
             onMouseLeave={() => setCtx(null)}>
          <div className="sv-fav-row" style={{ padding: "5px 10px", borderRadius: 4, cursor: "pointer" }}
               onClick={() => { setLocalViewerRow(ctx.row); setCtx(null); }}>
            🗔 로컬 뷰어 열기
          </div>
          <div className="sv-fav-row" style={{ padding: "5px 10px", borderRadius: 4, cursor: "pointer",
                                               color: "var(--stat-emergency)" }}
               onClick={() => {
                 const r = ctx.row;
                 setCtx(null);
                 if (!window.confirm(
                   `로컬 검사 삭제 — ${r.patient_name || r.patient_key} · ${r.modality} · ${r.study_date}\n` +
                   `로컬 Image 파일과 local.db 등록이 함께 삭제됩니다. 진행할까요?`)) return;
                 api.localDelete(r.id)
                   .then(() => setRefreshKey((k) => k + 1))
                   .catch((e) => alert(e instanceof Error ? e.message : "삭제 실패 — ⚠ 준비 중"));
               }}>
            🗑 검사 삭제 (로컬)
          </div>
        </div>
      ) : ctx && (
        <ContextMenu x={ctx.x} y={ctx.y} row={ctx.row} ohifOn={ohifOn} allowed={allowedAction}
                     onAction={(a) => doAction(a, ctx.row)} onClose={() => setCtx(null)} />
      )}
      </>
      )}
    </div>
  );
}
