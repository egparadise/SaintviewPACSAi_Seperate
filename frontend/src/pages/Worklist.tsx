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
import { ExportDialog } from "./ExportDialog";
import { readDlPrefs } from "../lib/dlPrefs";
import { dlConfigure, dlInvalidate, dlPromote, dlReset, dlResume, dlSetQueue, dlStop } from "../lib/dlScheduler";
import { dlSupportReason, opfsWipe } from "../lib/opfsStore";
import { setImageFormat } from "../lib/imageFormat";
import { registerLiveStudyVid } from "../lib/liveUids";
// 조회 질의는 '확정된 조건(committed)'에서만 만든다 — 규칙과 근거는 lib/worklistQuery.ts 참조
import {
  buildWorklistQuery,
  decideDlScope,
  defaultStatusInjection,
  freshChangedVids,
  isQueryDirty,
  toLiveParams,
  type CommittedQuery,
} from "../lib/worklistQuery";
import {
  PERM_DENIED_TIP,
  VID_BASE,
  VIEWER_BASE,
  api,
  isLiveId,
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
import { onStudySync, onViewerCloseAll, onViewerOpened, postStudySync, postViewerAddTab } from "../lib/sync";
import {
  decideBaselineArm, decideBaselineRelease, forgetViewerSlot, liveViewerSlots, noteViewerSlot,
  openByPlan, planViewerOpen, readViewerRoundRobin, viewerSlotName, writeViewerRoundRobin,
} from "../lib/viewerSlots";
import { Splitter, clampSz } from "../lib/Splitter";
import { t as tr, useLang } from "../lib/i18n";

const Viewer3D = lazy(() => import("./Viewer3D").then((m) => ({ default: m.Viewer3D })));
const ImportDialog = lazy(() => import("./ImportDialog").then((m) => ({ default: m.ImportDialog })));
const WebPacsBrowser = lazy(() => import("./WebPacsBrowser").then((m) => ({ default: m.WebPacsBrowser })));
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
/** LIVE(WebPACS 직결) 모드 허용 액션 — 열람·판독·응급·PDF·북마크는 A 왕복으로 동작.
 *  A 미대응(KOS/SR/GSPS/키이미지·자사 AI·파괴적 QC)만 차단 */
const LIVE_OK_ACTIONS = new Set([
  "viewdraft", "viewer2d", "ub_view", "ub_add", "ub_stack", "ub_key",
  "compare", "compareOpen", "reading", "refresh", "csv", "print", "logout", "import",
  "emergency", "pdf", "copyreport", "3d",   // A 대응 구현(요구5)
]);
const LIVE_DENIED_TIP = "LIVE 모드(원격 PACS 직결) — 이 기능은 원격 검사에서 지원되지 않습니다";

/* ── F-18 행잉 매핑 + 모니터 배치(viewer.prefs.monitor) ─────────────────── */
let hangingMap: Record<string, string> = {};
let monitorScreens: number[] = [];  // 뷰어를 띄울 모니터 인덱스(다중=스팬)
export function loadHangingPrefs() {
  api.getSetting("viewer.prefs").then((r) => {
    hangingMap = ((r.value as { hanging?: Record<string, string> }).hanging) ?? {};
    monitorScreens = ((r.value as { monitor?: { screens?: number[] } }).monitor?.screens) ?? [];
  }).catch(() => {});
}

/** 뷰어 모니터 배치 계획 — 선택 모니터별 슬롯(번호 오름차순, max_open 캡) + 워크리스트 탭→모니터 배치 예외 +
 *  모니터별 ◀▶ 탐색 탭(tab_binding). Window Management API(Chrome) 가용 시. 매 호출 최신 설정 재조회. */
async function viewerMonitorPlan(): Promise<{
  slots: { index: number; features: string }[];
  tabMonMap: { tab: string; monitor: number }[];
  tabBinding: Record<number, string>;
}> {
  let maxOpen = 0;
  let tabMonMap: { tab: string; monitor: number }[] = [];
  let tabBinding: Record<number, string> = {};
  try {
    const r = await api.getSetting("viewer.prefs");
    const mon = (r.value as { monitor?: {
      screens?: number[]; max_open?: number;
      tab_monitor_map?: { tab: string; monitor: number }[]; tab_binding?: Record<number, string>;
    } }).monitor;
    monitorScreens = mon?.screens ?? monitorScreens;
    maxOpen = Number(mon?.max_open) || 0;   // 0/미설정 = 선택 모니터 전부
    if (Array.isArray(mon?.tab_monitor_map)) tabMonMap = mon!.tab_monitor_map!;
    if (mon?.tab_binding) tabBinding = mon.tab_binding;
  } catch { /* 캐시 유지 */ }
  // max_open 캡('검사를 열 때 순환할 모니터 개수')은 **라운드로빈 슬롯 수**다 — 적용 지점은 여기,
  // 워크리스트 오픈 경로뿐이다. 뷰어측 Compare·과거검사 '인접 모니터'까지 이 캡을 적용했더니
  // 라운드로빈이 쓰지도 않는 여분 모니터를 못 쓰게 만들어(3모니터·max_open=2 → Compare 2건이 배치
  // 포기, max_open=1 → prior_mode="monitor" 가 항상 Layout 폴백) 기능만 깎였다.
  // '라운드로빈이 쓰는 모니터를 Compare 가 덮는 것'은 screens.ts 가 살아 있는 슬롯을 피해 배치한다.
  const slots = await screenFeaturesList(monitorScreens, undefined, maxOpen);
  return { slots, tabMonMap, tabBinding };
}
// 다중 선택 일괄 오픈 시작 시 호출 — 선택 목록의 위(첫)부터 모니터 1,2,3 순서로 배치되도록 리셋.
// ⚠ 카운터는 모듈 변수가 아니라 창 간 공유 상태(lib/viewerSlots)에 있다 — 워크리스트를 F5 해도
//   살아 있는 뷰어 창의 배치 순서가 이어져야 하기 때문(모듈 변수는 F5 로 0 이 되어 1번 모니터를 덮어썼다).
function resetViewerRoundRobin() { writeViewerRoundRobin(0); }
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
  received: "요청", draft_ready: "AI초안", reading: "판독중", finalized: "확정",   // 2026-08-10 표시 변경
  suspended: "보류", draft: "초안", in_review: "검토중",
};
function StatusBadge({ status }: { status: string }) {
  // INFINITT User Guide p.5 Exam Status 매핑 — 색 점 + 툴팁으로 등가 상태 표기
  const inSt = IN_EXAM_STATUSES.find((s) => s.key === IN_STATUS_MAP[status]);
  return (
    <span className={`badge ${status}`}
          title={inSt ? `${inSt.label} — ${tr(inSt.desc)}` : undefined}>
      {inSt && <span style={{
        display: "inline-block", width: 7, height: 7, borderRadius: 4,
        background: inSt.color, marginRight: 4, verticalAlign: "middle",
      }} />}
      {tr(STATUS_LABEL[status] ?? status)}
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
        : r.report_status === "draft" ? <span className="badge ai">{tr("초안")}</span> : null,
  },
  patient_key: { label: "ID", render: (r) => r.patient_key },
  patient_name: {
    label: "이름",
    // 병합(Merge)된 환자는 이름 앞에 병합 아이콘 표시 (Exam Control 에서 Unmerge 가능)
    render: (r) => <>{r.merged && <MergeIcon />}{r.has_key && <span title={tr("키이미지 등록 검사")}>🔑 </span>}{r.patient_name}</>,
  },
  sex: { label: "성별", render: (r) => r.sex },
  birth_date: { label: "생년월일", render: (r) => r.birth_date },
  // 환자 나이 — 검사일 기준 만 나이(판독창 배너와 같은 계산 규칙). 생년월일·검사일이
  // 8자리로 안 잡히면 빈칸(추정 표기 금지 — 의료 화면에서 틀린 나이가 빈칸보다 해롭다).
  age: {
    label: "나이",
    render: (r) => {
      const b = (r.birth_date || "").replace(/\D/g, "");
      const s = (r.study_date || "").replace(/\D/g, "");
      if (b.length < 8 || s.length < 8) return "";
      let a = Number(s.slice(0, 4)) - Number(b.slice(0, 4));
      if (s.slice(4, 8) < b.slice(4, 8)) a -= 1;
      return a >= 0 && a < 200 ? String(a) : "";
    },
  },
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
  // 원격판독 운영 4항목(2026-08-10) — Live 는 A 원천(study_insert_datetime·hospital/center·배정의)
  request_datetime: { label: "의뢰 일시", render: (r) => fmtReqDt(r.request_datetime) },
  hospital_name: { label: "병원명 (의뢰병원)", render: (r) => r.hospital_name ?? r.institution },
  center_name: { label: "센터명 (판독센터)", render: (r) => r.center_name ?? "" },
  assigned_doctor: { label: "배정의사", render: (r) => r.assigned_doctor ?? "" },
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
/* 초기(기본) 컬럼 — 2026-08-10 사용자 확정: 원 서버(A) 워크리스트의 항목 순서를 따른다.
 *   검사상태 → (의뢰일시×) → 센터명 → 환자명 → 환자ID → 장비 → 검사일시 → 배정의사 → 부위
 *   → (병원명=기관과 중복×) → (재판독사유×) → 이미지수 → 검사내용 → 응급여부 → 검사코멘트
 *   → (병원코멘트×) → Accession → 나이 → (판독의사×) → 성별 → 생년월일 → 판독일시
 *   → (판독시간×) → 판독문(임프레션 미리보기로 근사) → (병원결과문×)
 * ×표는 우리 데이터(StudyRow)에 원천이 없어 제외 — 억지로 빈 컬럼을 만들지 않는다.
 * 세 뷰어(Saint/I/T) 공통 기본이며, 계정이 저장한 순서(by_viewer)가 있으면 그것이 우선.
 * 넘치는 폭은 그리드 가로 스크롤이 받는다(3166356). */
export const DEFAULT_COLUMNS = [
  "read_state", "status", "request_datetime", "center_name", "patient_name", "patient_key",
  "modality", "study_date", "study_time", "assigned_doctor", "body_part", "hospital_name",
  "instance_count", "study_desc", "priority", "memo", "accession_no", "age", "sex",
  "birth_date", "finalized_at", "impression",
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

// 뷰어 스킨 키 — client_viewer 값과 1:1 (sv=SaintView / infi=I-View / ty=T-View)
export type ViewerKey = "sv" | "infi" | "ty";
// 뷰어별 컬럼 기본값(오버라이드 없을 때) — 2026-08-10 사용자 확정: 세 뷰어 모두
// 원 서버(A) 순서(DEFAULT_COLUMNS)로 시작한다. 구 SV_COLUMNS/INFI_COLUMNS 는 설정
// 화면의 '뷰어 원형' 참고용으로만 남는다.
export const VIEWER_COL_DEFAULT: Record<ViewerKey, string[]> = {
  sv: DEFAULT_COLUMNS, infi: DEFAULT_COLUMNS, ty: DEFAULT_COLUMNS,
};
// SaintView/I-View 고정 배치의 숨김 가능한 구역(검색레일·검사그리드는 항상 표시).
//  preview=좌하단 미리보기 · related=과거검사 · report=리포트
export const SVINFI_PANELS = ["preview", "related", "report"] as const;
export const SVINFI_PANEL_LABEL: Record<string, string> = {
  preview: "미리보기 (Preview)", related: "과거검사 (Related)", report: "리포트 (Report)",
};
const DEFAULT_SVINFI_PANELS: Record<string, boolean> = { preview: true, related: true, report: true };
// T-View(현행) 하단 패널 기본 표시 상태 (UBPACS p.8 7구성)
const DEFAULT_TY_PANELS: Record<string, boolean> = {
  orders: true, prior: true, compare: true, thumb: true, std: true, comment: true, report: true,
};

// 숨긴 구역 자리의 얇은 재열기 바 — 클릭하면 마지막 크기로 다시 표시(화면에서 복구, Setting 체크박스와 동기)
function ReopenBar({ label, onExpand }: { label: string; onExpand: () => void }) {
  return (
    <div onClick={onExpand} title={`${label} ${tr("다시 표시")}`}
         style={{ height: 18, flexShrink: 0, cursor: "pointer", display: "flex", alignItems: "center",
                  gap: 6, padding: "0 8px", margin: "2px 0", fontSize: 11, color: "var(--text-secondary)",
                  background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 4,
                  userSelect: "none" }}>
      <span style={{ fontWeight: 700 }}>▸</span>{label}
      <span style={{ marginLeft: "auto", opacity: 0.7 }}>{tr("펼치기")}</span>
    </div>
  );
}

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
  selected, onAction, searchText, setSearchText, onSearch, onNlSearch, dirty, searchMode, setSearchMode,
  withOpen, setWithOpen, withOpenMode, setWithOpenMode, ohifOn = false, allowed,
}: {
  selected: StudyDetail | null;
  onAction: (a: string) => void;
  searchText: string;
  setSearchText: (s: string) => void;
  onSearch: () => void;
  onNlSearch: (text: string) => void;
  searchMode: "text" | "ai";                    // 통합 검색창 방식(설정>워크리스트>검색창 설정이 기본값)
  setSearchMode: (m: "text" | "ai") => void;
  // 입력한 검색조건이 아직 조회에 반영되지 않았음(=커밋 전). SEARCH 를 눌러야 목록이 바뀐다는
  // 계약을 지키되, 사용자가 '왜 안 바뀌지?' 로 헤매지 않도록 버튼에 표시만 해 준다.
  dirty?: boolean;
  withOpen: boolean;
  setWithOpen: (b: boolean) => void;
  withOpenMode: "add" | "stack";
  setWithOpenMode: (m: "add" | "stack") => void;
  ohifOn?: boolean;   // OHIF 아이콘 표시 여부 (설정>뷰어 — 기본 숨김)
  allowed?: (a: string) => boolean;   // 유효 권한 게이트(레인 W) — 서버 403 이 최종 방어선
}) {
  const need = !selected;
  const Btn = ({ a, label, primary, title }: { a: string; label: string; primary?: boolean; title?: string }) => {
    const ok = allowed ? allowed(a) : true;   // 권한 없음 → 비활성 + 안내 툴팁 (UX 목적)
    return (
      <button className={primary ? "primary" : ""}
              disabled={(need && a !== "batch" && a !== "refresh") || !ok}
              title={ok ? title : tr(PERM_DENIED_TIP)} onClick={() => onAction(a)}>
        {label}
      </button>
    );
  };
  return (
    <div style={{
      display: "flex", gap: 5, padding: "6px 8px", alignItems: "center",
      background: "var(--bg-panel)", borderBottom: "1px solid var(--border)",
    }}>
      <Btn a="viewdraft" label="View&Draft" primary title={tr("뷰어 + 초안 패널 동시 오픈 (더블클릭과 동일)")} />
      <Btn a="3d" label="3D" title={tr("내장 Cornerstone3D MPR/MIP")} />
      <span style={{ width: 1, alignSelf: "stretch", background: "var(--border)", margin: "0 3px" }} />
      {/* UBPACS-Z Study Open 5종 */}
      <Btn a="ub_view" label="🖵 View" title={tr("① View — 기존 영상을 닫고 선택 검사를 그 자리에 표시 (UBPACS-Z)")} />
      <Btn a="ub_add" label="🖵+ Add" title={tr("② Add View — 기존 영상은 닫지 않고 선택 검사를 분할 추가")} />
      <Btn a="ub_stack" label="⧉ Stack" title={tr("③ Stack View — 기존 영상 유지 + 선택 검사를 같은 페인에 중첩")} />
      {ohifOn && <Btn a="ub_adv" label="⌂ Adv" title={tr("④ Advance View — 고급 뷰어(OHIF)로 열기")} />}
      <Btn a="ub_key" label="🔑 Key" title={tr("⑤ Key Image View — 선택 검사의 키 이미지만 표시 (F-16)")} />
      <Btn a="compareOpen" label="⇄ Compare" title={tr("Compare — 뷰어에서 같은 환자의 과거검사를 골라 나란히 비교(모달, In Viewer 동일)")} />
      {/* Study With Open (p.13): 더블클릭 시 Related Study를 함께 오픈 */}
      <label title={tr("Study With Open — 더블클릭으로 열 때 Related Study List의 검사를 한번에 같이 오픈")}
             style={{ display: "flex", gap: 3, alignItems: "center", fontSize: 11.5, marginLeft: 3 }}>
        <input type="checkbox" checked={withOpen} onChange={(e) => setWithOpen(e.target.checked)} />
        With Open
      </label>
      <select value={withOpenMode} disabled={!withOpen} title={tr("함께 오픈 모드")}
              onChange={(e) => setWithOpenMode(e.target.value as "add" | "stack")}
              style={{ fontSize: 10.5 }}>
        <option value="add">ADD VIEW</option>
        <option value="stack">STACK VIEW</option>
      </select>
      {/* Reading/Import/Export/Print/PDF/Emergency/AI/일괄검토/새로고침은 상단 탭 바(Local Server 왼쪽)로 이동(요청) */}
      <div style={{ flex: 1 }} />
      {/* 07 A.2 SearchShortcut: 검색 바로가기 저장/적용 */}
      <select title={tr("검색 바로가기")} defaultValue="" onChange={(e) => {
        const sc = JSON.parse(localStorage.getItem("sv_shortcuts") ?? "[]")
          .find((s: { label: string }) => s.label === e.target.value);
        if (sc) window.dispatchEvent(new CustomEvent("sv-apply-shortcut", { detail: sc }));
        e.target.value = "";
      }}>
        <option value="">{tr("바로가기…")}</option>
        {JSON.parse(localStorage.getItem("sv_shortcuts") ?? "[]").map((s: { label: string }) => (
          <option key={s.label} value={s.label}>{s.label}</option>
        ))}
      </select>
      <button title={tr("현재 검색조건을 바로가기로 저장")} onClick={() => {
        window.dispatchEvent(new CustomEvent("sv-save-shortcut"));
      }}>{tr("★저장")}</button>
      {/* S1 자연어 검색 (nl_to_query) — AI 기능이므로 보라 포인트 */}
      {/* ⚠ name/autoComplete 를 반드시 준다 — 이름 없는 텍스트 필드는 크롬이 문서 전체를
          'unowned 합성 로그인 폼' 으로 묶을 때 username 후보로 잡아 저장된 자격증명(예: 병원ID)을
          여기에 채워 넣는다. 실제로 SEARCH 칸에 로그인 병원ID 가 자동입력돼 목록이 비는 사고가 있었다. */}
      {/* ★ 통합 검색창(2026-08-10 사용자 확정) — AI 검색과 SEARCH 를 한 입력으로 합쳤다.
          방식(SEARCH/AI)은 셀렉트로 전환, 기본값·검색 범위·다중어 결합은
          설정>워크리스트>검색창 설정(계정별 저장)이 정한다. */}
      <select value={searchMode} onChange={(e) => setSearchMode(e.target.value === "ai" ? "ai" : "text")}
              title={tr("검색 방식 — SEARCH: 선택한 범위에서 문법 검색(=정확/접두%/!제외/공백=다중어) · AI: 자연어를 필터로 변환")}
              style={searchMode === "ai" ? { borderColor: "var(--ai)", color: "var(--ai)", fontWeight: 700 } : { fontWeight: 700 }}>
        <option value="text">SEARCH</option>
        <option value="ai">AI</option>
      </select>
      <input
        placeholder={searchMode === "ai"
          ? tr("AI 검색 — 예: 지난주 흉부 CT 미판독")
          : tr("SEARCH — 선택한 범위에서 검색 (=정확 / 접두% / !제외 · 공백=다중어)")}
        value={searchText}
        name="wl-q" autoComplete="off" autoCorrect="off" spellCheck={false}
        onChange={(e) => setSearchText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          if (searchMode === "ai") { if (searchText.trim()) onNlSearch(searchText); }
          else onSearch();
        }}
        style={{ width: 420, background: "var(--bg-canvas)",
                 ...(searchMode === "ai" ? { borderColor: "var(--ai)" } : {}) }}
      />
      <button className="primary"
              onClick={() => { if (searchMode === "ai") { if (searchText.trim()) onNlSearch(searchText); } else onSearch(); }}
              title={searchMode === "ai"
                ? tr("자연어로 검색 조건을 입력하면 AI가 필터로 변환합니다 (적용 전 미리보기)")
                : dirty ? tr("입력한 검색조건이 아직 적용되지 않았습니다 — 누르면 조회합니다")
                        : tr("현재 조건으로 다시 조회")}
              style={dirty && searchMode !== "ai" ? { boxShadow: "0 0 0 2px var(--stat-emergency,#f87171)" } : undefined}>
        {searchMode === "ai" ? "AI" : "SEARCH"}{dirty && searchMode !== "ai" ? " •" : ""}
      </button>
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

/* ── 통합 편집기·통합 검색창 (2026-08-10 사용자 확정) ─────────────────────────
 * COL_FIND_MAP: 그리드 컬럼 ↔ 검색 필드 대응(설정의 두 표를 한 표로 합치는 접착제).
 * SEARCH_SCOPE_FIELDS: 통합 검색(q)이 훑을 수 있는 범위 — 백엔드 _QUERY_FIELD_COLS 와 1:1.
 * ⚠ Live 는 A 파라미터 한계로 환자 ID/이름만 통합 검색이 적용된다(설정 도움말에 명시). */
/* 통합 검색 범위/결합 — 컴포넌트 밖 조회 함수가 쓸 모듈 미러(리렌더 무관).
   Worklist 가 prefs 로드/설정 변경 시 setSbConfig 로 갱신한다. */
let SB_FIELDS: string[] = ["pid", "pname"];
let SB_OP: "and" | "or" = "and";
export function setSbConfig(fields: string[], op: "and" | "or"): void {
  SB_FIELDS = fields.length ? fields : ["pid", "pname"];
  SB_OP = op;
}
export function sbScopeParam(): string { return SB_FIELDS.join(","); }
export function sbOpParam(): string { return SB_OP; }

/** 의뢰일시 표시 형식(설정>워크리스트 공통 — 계정 저장 worklist.prefs.req_dt_fmt).
 *  COLUMN_DEFS.render 는 정적이라 모듈 상태로 든다(imageFormat 의 IMG_FMT 패턴). */
export const REQ_DT_FMTS = [
  "yyyy-mm-dd hh:mm:ss", "yyyy-mm-dd hh:mm", "yyyy-mm-dd", "mm-dd hh:mm", "hh:mm:ss",
] as const;
let REQ_DT_FMT: string = REQ_DT_FMTS[1];
export function setReqDtFmt(f: string): void { if ((REQ_DT_FMTS as readonly string[]).includes(f)) REQ_DT_FMT = f; }
export function fmtReqDt(raw: string | undefined | null, fmt = REQ_DT_FMT): string {
  const d = String(raw ?? "").replace(/\D/g, "");   // "2026-08-10 12:17:00" → 14자리
  if (d.length < 8) return "";
  const [Y, M, D, h, m, sec] = [d.slice(0, 4), d.slice(4, 6), d.slice(6, 8),
                                d.slice(8, 10) || "00", d.slice(10, 12) || "00", d.slice(12, 14) || "00"];
  switch (fmt) {
    case "yyyy-mm-dd hh:mm:ss": return `${Y}-${M}-${D} ${h}:${m}:${sec}`;
    case "yyyy-mm-dd": return `${Y}-${M}-${D}`;
    case "mm-dd hh:mm": return `${M}-${D} ${h}:${m}`;
    case "hh:mm:ss": return `${h}:${m}:${sec}`;
    default: return `${Y}-${M}-${D} ${h}:${m}`;
  }
}

export const COL_FIND_MAP: Record<string, string> = {
  patient_key: "pid", patient_name: "pname", sex: "sex", modality: "modality",
  study_date: "date", study_desc: "desc", status: "status", body_part: "body_part",
  impression: "finding", priority: "emergency",
};
export const FIND_ONLY_FIELDS = Object.keys(FIND_FIELDS)
  .filter((k) => !Object.values(COL_FIND_MAP).includes(k));
export const SEARCH_SCOPE_FIELDS: Record<string, string> = {
  pid: "환자 ID", pname: "환자 이름", accession: "Accession 번호", desc: "검사명",
  institution: "기관(센터명)", body_part: "부위", ref_phys: "의뢰의", memo: "메모",
};
export const DEFAULT_SEARCH_BOX = { mode: "text" as "text" | "ai", fields: ["pid", "pname"], op: "and" as "and" | "or" };

function FilterBar({ filters, setFilters, fields, onSearch, dirty }: {
  filters: Record<string, string>;
  setFilters: (f: Record<string, string>) => void;
  fields: string[];
  onSearch: () => void;
  dirty?: boolean;   // 입력했지만 아직 SEARCH 로 커밋되지 않음 (조회에 반영 전)
}) {
  // ⚠ setFilters 는 **입력 상태만** 바꾼다. 조회는 SEARCH/Enter(onSearch)로만 일어난다
  //    — 기획: '수동 = 내가 SEARCH 를 누를 때만 목록이 바뀐다'(커밋 7c5d360).
  const set = (k: string, v: string) => setFilters({ ...filters, [k]: v });
  const enter = (e: React.KeyboardEvent) => e.key === "Enter" && onSearch();
  // 이름 없는 텍스트 필드는 크롬 자동완성이 로그인 username 칸으로 오인한다 → name + autoComplete 필수
  const ac = (k: string) => ({ name: `wl-f-${k}`, autoComplete: "off" as const, spellCheck: false });
  const F = (key: string) => {
    switch (key) {
      case "pid":
        return <input key={key} placeholder={tr("*Any 환자 ID")} value={filters.pid ?? ""} style={{ width: 110 }} {...ac("pid")}
                      onChange={(e) => set("pid", e.target.value)} onKeyDown={enter} />;
      case "pname":
        return <input key={key} placeholder={tr("*Any 이름")} value={filters.pname ?? ""} style={{ width: 110 }} {...ac("pname")}
                      onChange={(e) => set("pname", e.target.value)} onKeyDown={enter} />;
      case "sex":
        return (
          <select key={key} value={filters.sex ?? ""} {...ac("sex")} onChange={(e) => set("sex", e.target.value)}>
            <option value="">{tr("*Any 성별")}</option><option value="M">M</option>
            <option value="F">F</option><option value="O">O</option>
          </select>
        );
      case "modality":
        return (
          <select key={key} value={filters.modality ?? ""} {...ac("modality")} onChange={(e) => set("modality", e.target.value)}>
            <option value="">*Any Modality</option>
            {["CR", "CT", "MR", "US", "MG", "XA", "NM", "DX", "ES", "RF", "OT"].map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        );
      case "date":
        return (
          <span key={key} style={{ display: "flex", gap: 3, alignItems: "center" }}>
            <input type="date" value={filters.date_from_iso ?? ""} title={tr("검사일 From")} {...ac("date-from")}
                   onChange={(e) => set("date_from_iso", e.target.value)} />
            <span style={{ color: "var(--text-secondary)" }}>~</span>
            <input type="date" value={filters.date_to_iso ?? ""} title={tr("검사일 To")} {...ac("date-to")}
                   onChange={(e) => set("date_to_iso", e.target.value)} />
          </span>
        );
      case "desc":
        return <input key={key} placeholder={tr("*Any 검사명")} value={filters.desc ?? ""} style={{ width: 140 }} {...ac("desc")}
                      onChange={(e) => set("desc", e.target.value)} onKeyDown={enter} />;
      case "body_part":
        return <input key={key} placeholder={tr("*Any 부위")} value={filters.body_part ?? ""} style={{ width: 90 }} {...ac("body_part")}
                      onChange={(e) => set("body_part", e.target.value)} onKeyDown={enter} />;
      case "status":
        return (
          <select key={key} value={filters.status ?? ""} {...ac("status")} onChange={(e) => set("status", e.target.value)}>
            <option value="">{tr("*Any 상태")}</option><option value="unread">{tr("미판독(확정 전)")}</option>
            <option value="received">{tr("요청")}</option>
            <option value="draft_ready">{tr("AI초안")}</option><option value="reading">{tr("판독중")}</option>
            <option value="finalized">{tr("확정")}</option>
          </select>
        );
      case "finding":
        return <input key={key} placeholder={tr("소견/임프레션 검색 (F-2)")} value={filters.finding ?? ""} {...ac("finding")}
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
          <label key={key} title={tr("키이미지가 등록된 검사만 조회 (F-16)")}
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
      {dirty && (
        <button onClick={onSearch} title={tr("입력한 조건으로 조회합니다 (Enter 와 동일)")}
                style={{ marginLeft: "auto", fontSize: 11.5, padding: "2px 10px",
                         color: "var(--stat-emergency,#f87171)", fontWeight: 700 }}>
          {tr("● 조건 변경됨 — SEARCH 로 적용")}
        </button>
      )}
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
    const label = prompt(tr("기간 이름"), init?.label ?? "");
    if (!label) return null;
    const ds = prompt(tr("일수 (0=오늘, 숫자=최근 N일, -1=전체)"), String(init?.days ?? 7));
    if (ds === null) return null;
    const days = Number(ds);
    if (Number.isNaN(days)) { alert(tr("숫자를 입력하세요")); return null; }
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
    <button title={editSec[k] ? tr("편집 모드 끄기") : tr("편집 모드 — 행별 수정(연필)/삭제(휴지통) 표시")}
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
        {tr("기간")}
        <span style={{ marginLeft: "auto", display: "flex", gap: 2 }}>
          <EditToggle k="dp" />
          <button title={tr("기간 프리셋 추가")} style={{ padding: "0 6px", fontSize: 10.5 }}
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
            {tr(p.label)}
          </span>
          {editSec.dp && (
            <>
              <span title={tr("수정")} style={{ flexShrink: 0 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      const r = askPreset(p);
                      if (r) saveDp(presets.map((x, k) => (k === i ? { ...x, ...r } : x)));
                    }}>✏️</span>
              <span title={tr("삭제")} style={{ flexShrink: 0 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm(`'${p.label}' ${tr("기간을 삭제할까요?")}`)) {
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
          <button title={tr("모달리티 필터 추가 (예: US, MG)")} style={{ padding: "0 6px", fontSize: 10.5 }}
                  onClick={() => {
                    const code = prompt(tr("추가할 Modality 코드 (예: US, MG, XA)"));
                    if (!code) return;
                    const c = code.trim().toUpperCase();
                    if (shownMods.includes(c)) { alert(tr("이미 목록에 있습니다")); return; }
                    saveMods([...shownMods, c]);
                  }}>＋</button>
          {modList && (
            <button title={tr("자동 목록으로 되돌리기 (데이터 집계)")} style={{ padding: "0 6px", fontSize: 10.5 }}
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
          <span>📁 {tr("전체")}</span><span style={{ fontSize: 11 }}>{total}</span>
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
              {m || tr("(없음)")}
            </span>
            <span style={{ fontSize: 11, flexShrink: 0 }}>{mods[m] ?? 0}</span>
            {editSec.mods && (
              <>
                <span title={tr("코드 수정")} style={{ flexShrink: 0 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        const code = prompt(tr("Modality 코드 수정"), m);
                        if (!code || code.trim().toUpperCase() === m) return;
                        saveMods(shownMods.map((x, k) => (k === i ? code.trim().toUpperCase() : x)));
                      }}>✏️</span>
                <span title={tr("목록에서 제거")} style={{ flexShrink: 0 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`'${m || tr("(없음)")}' ${tr("필터를 목록에서 제거할까요?")}`)) {
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
          <button title={tr("현재 검색조건을 바로가기로 추가 (툴바 ★저장과 동일)")}
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
            {tr("툴바 ★저장으로 현재 검색조건 등록")}
          </div>
        )}
        {favs.map((s, i) => (
          <div key={`${s.label}-${favTick}`}
               onClick={() => window.dispatchEvent(new CustomEvent("sv-apply-shortcut", { detail: s }))}
               title={tr("클릭=적용 (헤더 ✏️=편집 모드 — 이름 변경/삭제)\n같은 이름으로 ★저장하면 조건이 덮어써집니다")}
               className="sv-fav-row"
               style={{ padding: "3px 8px", borderRadius: 3, cursor: "pointer", fontSize: 12.5,
                        color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              ⭐ {s.label}
            </span>
            {editSec.favs && (
              <>
                <span title={tr("이름 변경")} style={{ flexShrink: 0 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        const nn = prompt(tr("바로가기 이름 변경"), s.label);
                        if (!nn || nn === s.label) return;
                        saveFavs(favs.map((f, k) => (k === i ? { ...f, label: nn } : f)));
                      }}>✏️</span>
                <span title={tr("삭제")} style={{ flexShrink: 0 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`'${s.label}' ${tr("바로가기를 삭제할까요?")}`)) {
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
        {tr("검색 폴더")}
      </div>
      <div style={unifiedScroll
        ? { flexShrink: 0, display: "flex", flexDirection: "column" }
        : { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>{tree}</div>
    </div>
  );
}

/* ── 서버 선택 버튼 (탭 바 우측) — Local Server: 로컬 PACS 모드 전환+폴더 보기 / Web Server: 주소·포트 ──
 * mode 는 워크리스트 데이터 소스 전환(레인 F)을 위해 부모(Worklist)가 소유한다. */
function ServerButtons({ mode, onMode, onWebPacs }: {
  mode: "local" | "web" | "live" | null;
  onMode: (m: "local" | "web" | "live") => void;
  onWebPacs?: () => void;   // WebPACS 브리지 모달 열기 (인계 PACS 검사 가져오기)
}) {
  const [open, setOpen] = useState<null | "local" | "web">(null);
  const [live, setLive] = useState<{ enabled?: boolean; base_url?: string; user_id?: string }>({});
  const [net, setNet] = useState<ServerNetwork>({});
  const [files, setFiles] = useState<{ name: string; is_dir: boolean; size: number; mtime: number }[]>([]);
  const [shareDir, setShareDir] = useState("");
  const [sub, setSub] = useState("");   // 공유 루트 기준 현재 상대경로("" = 루트) — 하위 폴더 탐색
  const [err, setErr] = useState("");

  // 공유 폴더 목록 조회 — s=상대 하위경로(빈값=루트). 이미지 데이터 폴더 구조 탐색 지원
  const openLocal = (s: string) => {
    api.shareList(s || undefined)
      .then((r) => { setFiles(r.items); setShareDir(r.dir); setSub(r.sub); setErr(""); })
      .catch((e) => { setFiles([]); setErr(e instanceof Error ? e.message : tr("조회 실패")); });
  };

  useEffect(() => {
    // 팝업을 열 때마다 최신 설정을 다시 읽는다 — 설정>서버 네트워크 저장 직후에도 반영
    api.getSetting("server.network").then((r) => setNet(r.value as ServerNetwork)).catch(() => {});
    api.webpacsConfig().then((r) => setLive(r.value)).catch(() => {});   // Live(원격 직결) 접속 설정
  }, [open]);

  const pick = (m: "local" | "web" | "live") => {
    onMode(m);
    setErr("");
    if (m === "live") { setOpen("web"); return; }   // 통합 버튼 — 팝오버는 그대로 두고 모드만 전환
    if (open === m) { setOpen(null); return; }
    setOpen(m as "local" | "web");
    if (m === "local") { setShareDir(""); setSub(""); openLocal(""); }
  };
  const fmtSize = (n: number) => n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : n > 1024 ? `${(n / 1024).toFixed(0)}KB` : `${n}B`;

  return (
    <span style={{ position: "relative", display: "flex", gap: 3, alignSelf: "center" }}>
      <button onClick={() => pick("local")}
              title={tr("Local Server — 로컬 PACS 모드로 전환(서버 데이터 숨김) + 공유 폴더 보기 (설정>서버 네트워크에서 디렉토리 지정)")}
              style={{ padding: "2px 10px", fontSize: 11, fontWeight: 700,
                       background: mode === "local" ? "var(--accent)" : undefined,
                       color: mode === "local" ? "#fff" : undefined }}>
        Local Server
      </button>
      {/* Web Server 와 Live 는 '어느 서버의 데이터를 볼 것인가'라는 같은 축이라 하나로 합쳤다.
          버튼이 현재 모드를 그대로 보여 주고(Live 는 녹색), 클릭하면 팝오버에서 전환한다. */}
      <button onClick={() => setOpen((o) => (o === "web" ? null : "web"))}
              title={tr("서버 — Web Server(이 서버) / Live(원격 PACS 직결) 전환·설정 확인")}
              style={{ padding: "2px 10px", fontSize: 11, fontWeight: 700,
                       background: mode === "live" ? "#22c55e" : mode === "web" ? "var(--accent)" : undefined,
                       color: mode === "live" || mode === "web" ? "#fff" : undefined,
                       borderColor: mode === "live" ? "#22c55e" : undefined }}>
        {mode === "live" ? "Live" : "Web Server"} ▾
      </button>
      {onWebPacs && (
        <button onClick={onWebPacs}
                title={tr("WebPACS — 인계 PACS(webpacs_api)의 검사를 검색해 우리 뷰어로 가져오기(복사) + 접속 설정")}
                style={{ padding: "2px 10px", fontSize: 11, fontWeight: 700 }}>
          WebPACS
        </button>
      )}
      {open && (
        <div style={{
          position: "absolute", top: "100%", right: 0, zIndex: 360, minWidth: 320, maxHeight: 320,
          overflow: "auto", background: "var(--bg-elevated)", border: "1px solid var(--border)",
          borderRadius: 6, boxShadow: "0 6px 20px rgba(0,0,0,0.5)", padding: 10, fontSize: 12,
        }} onMouseLeave={() => setOpen(null)}>
          {open === "local" ? (
            <>
              <b>{tr("Local Server — 폴더 공유")}</b>
              {err ? (
                <div style={{ color: "var(--stat-emergency)", marginTop: 6 }}>{err}</div>
              ) : (
                <>
                  <div style={{ display: "flex", gap: 5, alignItems: "center", margin: "5px 0", color: "var(--text-secondary)" }}>
                    <code style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}
                          title={sub ? `${shareDir}\\${sub.replace(/\//g, "\\")}` : shareDir}>
                      {shareDir}
                    </code>
                    <MiniBtn onClick={() => navigator.clipboard?.writeText(sub ? `${shareDir}\\${sub.replace(/\//g, "\\")}` : shareDir)}>{tr("경로 복사")}</MiniBtn>
                  </div>
                  {/* 브레드크럼 — 루트/하위 폴더 경로 표시, 각 조각 클릭=해당 폴더로 이동, ⬆=상위 */}
                  <div style={{ display: "flex", gap: 3, alignItems: "center", flexWrap: "wrap",
                                margin: "0 0 5px", fontSize: 11 }}>
                    <MiniBtn onClick={() => openLocal(sub.split("/").slice(0, -1).join("/"))}
                             disabled={!sub} title={tr("상위 폴더로")}>{tr("⬆ 상위")}</MiniBtn>
                    <span style={{ cursor: sub ? "pointer" : undefined, fontWeight: sub ? 400 : 700 }}
                          onClick={() => sub && openLocal("")}>{tr("루트")}</span>
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
                    <thead><tr><th>{tr("이름")}</th><th style={{ width: 64 }}>{tr("크기")}</th></tr></thead>
                    <tbody>
                      {files.slice(0, 20).map((f) => {
                        const rel = sub ? `${sub}/${f.name}` : f.name;   // 루트 기준 상대경로
                        const isImg = /\.(jpe?g|png|bmp|gif)$/i.test(f.name);   // 이미지 미리보기 아이콘
                        return (
                          <tr key={f.name} style={{ cursor: "pointer" }}
                              title={f.is_dir ? tr("클릭 = 폴더 진입") : tr("클릭 = 다운로드")}
                              onClick={() => {
                                if (f.is_dir) { openLocal(rel); return; }
                                window.open(`${(import.meta.env.VITE_API_BASE ?? "http://localhost:8000")}/api/share/file?name=${encodeURIComponent(rel)}`, "_blank");
                              }}>
                            <td>{f.is_dir ? "📁" : isImg ? "🖼" : "📄"} {f.name}</td>
                            <td>{f.is_dir ? "-" : fmtSize(f.size)}</td>
                          </tr>
                        );
                      })}
                      {files.length === 0 && <tr><td colSpan={2} style={{ color: "var(--text-secondary)" }}>{tr("비어 있음")}</td></tr>}
                    </tbody>
                  </table>
                </>
              )}
            </>
          ) : (
            <>
              <b>{tr("서버 선택")}</b>
              <div style={{ display: "flex", gap: 6, margin: "7px 0 9px" }}>
                <button onClick={() => onMode("web")} style={{ flex: 1, fontSize: 11.5, fontWeight: 700,
                        background: mode === "web" ? "var(--accent)" : undefined,
                        color: mode === "web" ? "#fff" : undefined }}>
                  Web Server<br /><span style={{ fontSize: 10, fontWeight: 400 }}>{tr("이 서버의 검사")}</span>
                </button>
                <button onClick={() => onMode("live")} disabled={!live.enabled}
                        title={live.enabled ? tr("원격 PACS 직결(복사 없음)") : tr("설정 > 서버 네트워크 > 웹 서버에서 Live 를 먼저 활성화하세요")}
                        style={{ flex: 1, fontSize: 11.5, fontWeight: 700,
                        background: mode === "live" ? "#22c55e" : undefined,
                        color: mode === "live" ? "#fff" : live.enabled ? "#22c55e" : undefined,
                        borderColor: "#22c55e" }}>
                  Live<br /><span style={{ fontSize: 10, fontWeight: 400 }}>{tr("원격 PACS 직결")}</span>
                </button>
              </div>
              <table className="grid-table">
                <tbody>
                  <tr><th style={{ width: 84 }}>{tr("주소(IP)")}</th><td>{net.web?.ip || tr("(미설정)")}</td></tr>
                  <tr><th>Port</th><td>{net.web?.port || tr("(미설정)")}</td></tr>
                  <tr><th>Name</th><td>{net.web?.name || "-"}</td></tr>
                  <tr><th>AE Title</th><td>{net.web?.ae_title || "-"}</td></tr>
                  <tr><th style={{ color: "#22c55e" }}>{tr("Live 원격")}</th>
                      <td>{live.enabled ? (live.base_url || tr("(주소 미설정)")) : tr("사용 안 함")}</td></tr>
                  <tr><th style={{ color: "#22c55e" }}>{tr("Live 계정")}</th><td>{live.user_id || "-"}</td></tr>
                </tbody>
              </table>
              <div style={{ marginTop: 5, color: "var(--text-secondary)", fontSize: 11 }}>
                {tr("설정 변경·Live 접속·Ping/Echo/DB 테스트는 설정 > 서버 네트워크 > 웹 서버에서.")}
              </div>
            </>
          )}
        </div>
      )}
    </span>
  );
}

/* ── 워크리스트 페이지 탭 바 (UBPACS-Z — 저장된 검색 정의를 페이지로, 최대 10) ── */
function WorklistTabsBar({ tabs, activeId, onPick, onAdd, onRemove, actions, serverMode, onServerMode, extraTab, viewerName, onWebPacs }: {
  tabs: WorklistTab[]; activeId: string;
  onPick: (t: WorklistTab) => void; onAdd: () => void; onRemove: (id: string) => void;
  actions?: React.ReactNode;  // Local Server 왼쪽에 노출할 액션 버튼 그룹
  serverMode: "local" | "web" | "live" | null;     // 데이터 소스 모드 (레인 F — Worklist 소유)
  onServerMode: (m: "local" | "web" | "live") => void;
  extraTab?: React.ReactNode; // WORKLIST 탭들 옆 추가 탭 (관리자 EXAM CONTROL — 레인 F)
  viewerName?: string;        // 선택 뷰어 이름(SaintView/I-View/T-View) — 탭 스트립 좌측에 표기
  onWebPacs?: () => void;     // WebPACS 브리지 모달 (인계 PACS 검사 가져오기)
}) {
  return (
    <div style={{
      display: "flex", gap: 2, padding: "4px 8px 0", alignItems: "flex-end",
      background: "var(--bg-canvas)", borderBottom: "1px solid var(--border)",
    }}>
      {viewerName && (
        <b title={tr("선택된 뷰어(설정>환경) — 워크리스트·뷰어 스킨")} style={{
          fontSize: 13, letterSpacing: 0.6, color: "var(--accent)", padding: "4px 12px 6px 2px",
          whiteSpace: "nowrap", alignSelf: "center",
        }}>{viewerName}</b>
      )}
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
            <span title={tr("페이지 삭제")} onClick={(e) => { e.stopPropagation(); onRemove(t.id); }}
                  style={{ fontSize: 10, opacity: 0.75 }}>✕</span>
          )}
        </div>
      ))}
      {extraTab}
      <button onClick={onAdd} title={tr("현재 검색조건을 새 페이지로 등록 (최대 10 — UBPACS-Z)")}
              style={{ padding: "1px 9px", fontSize: 13, marginLeft: 4, marginBottom: 3 }}>＋</button>
      {/* 우측 그룹: 액션 버튼(요청 — Local Server 왼쪽) + 서버 버튼 */}
      <span style={{ marginLeft: "auto", display: "flex", gap: 3, alignItems: "center", alignSelf: "center" }}>
        {actions}
        <ServerButtons mode={serverMode} onMode={onServerMode} onWebPacs={onWebPacs} />
      </span>
    </div>
  );
}

/* ── Exam → Series → Image 확장 트리 (메인 그리드·과거검사 공용) ─────────────
   두 곳이 같은 계층을 보여 준다. 같은 코드를 두 번 쓰면 한쪽만 고쳐지는 사고가 나므로
   상태(useSeriesTree)와 행 렌더(SeriesTreeRows)를 한 벌만 둔다. */
function useSeriesTree() {
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
  // 시리즈 키는 검사 id 를 접두로 붙인다 — 다른 검사가 같은 series_uid 를 갖는 경우
  // (같은 검사가 목록과 과거검사에 동시에 뜨는 상황 포함) 펼침이 서로 얽히지 않게.
  const toggleSeries = (key: string) => setExpSeries((prev) => {
    const n = new Set(prev);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });
  return { expanded, expSeries, trees, toggleExam, toggleSeries };
}

const TREE_MARK: React.CSSProperties = {
  cursor: "pointer", color: "var(--accent)", fontWeight: 700, userSelect: "none",
};

/** 펼쳐진 검사의 Series/Image 행들. 앞의 빈 칸(토글 열) 수는 lead 로 맞춘다. */
function SeriesTreeRows({ studyId, tree, expSeries, toggleSeries, colSpan, lead, onOpen }: {
  studyId: number;
  tree: SeriesNode[] | null | undefined;
  expSeries: Set<string>;
  toggleSeries: (key: string) => void;
  colSpan: number;             // Series/Image 행이 차지할 열 수(토글 열 제외)
  lead: number;                // 앞에 비워 둘 열 수(토글 열)
  onOpen: () => void;          // 더블클릭 — 영상 열기
}) {
  const pad = Array.from({ length: lead }, (_, i) => <td key={`p${i}`} />);
  if (tree === null) {
    return <tr>{pad}<td colSpan={colSpan}
      style={{ paddingLeft: 30, fontSize: 11.5, color: "var(--text-secondary)" }}>{tr("시리즈 로딩…")}</td></tr>;
  }
  if (!tree || tree.length === 0) {
    return <tr>{pad}<td colSpan={colSpan}
      style={{ paddingLeft: 30, fontSize: 11.5, color: "var(--text-secondary)" }}>{tr("시리즈 없음")}</td></tr>;
  }
  return (
    <>
      {tree.map((s, si) => {
        const key = `${studyId}|${s.series_uid}`;
        return (
          <Fragment key={key}>
            <tr style={{ background: "rgba(56,108,173,0.10)" }} onDoubleClick={onOpen}>
              {pad}
              <td colSpan={colSpan} style={{ paddingLeft: 26, fontSize: 12 }}>
                <span style={{ ...TREE_MARK, marginRight: 7 }}
                      title={expSeries.has(key) ? tr("Image 접기") : tr("Image 펼치기")}
                      onClick={(e) => { e.stopPropagation(); toggleSeries(key); }}
                      onDoubleClick={(e) => e.stopPropagation()}>
                  {expSeries.has(key) ? "−" : "＋"}
                </span>
                📚 Series {s.series_number || si + 1} · {s.modality} · {s.instances.length}{tr("장")}
                <span style={{ color: "var(--text-secondary)" }}> {s.series_desc}</span>
              </td>
            </tr>
            {expSeries.has(key) && s.instances.map((inst, ii) => (
              <tr key={inst.sop_uid} onDoubleClick={onOpen}>
                {pad}
                <td colSpan={colSpan}
                    style={{ paddingLeft: 58, fontSize: 11.5, color: "var(--text-secondary)" }}>
                  🖼 Image {inst.instance_number || ii + 1}
                  {inst.rows ? ` · ${inst.rows}×${inst.cols}px` : ""}
                  <span style={{ opacity: 0.6 }}> · …{inst.sop_uid.slice(-12)}</span>
                </td>
              </tr>
            ))}
          </Fragment>
        );
      })}
    </>
  );
}

/* ── [C] 메인 검사 그리드 (컬럼 구성형) ───────────── */
/** 컬럼 기본 폭 — 설정 폭(colWidths)이 없을 때. 넓은 텍스트 컬럼만 예외, 나머지 110px. */
const GRID_COL_DEF_W: Record<string, number> = {
  patient_name: 130, study_desc: 180, institution: 170, referring_physician: 120, memo: 180,
  impression: 220, order_name: 170, source_aet: 120, body_part: 110,
  age: 56, sex: 48, study_time: 76, accession_no: 140, finalized_at: 130,
  request_datetime: 150, hospital_name: 170, center_name: 130, assigned_doctor: 100,
  priority: 80, instance_count: 56, series_count: 50, modality: 56, read_state: 52, status: 76,
};
function StudyGrid({
  items, columns, selectedId, selectedIds, onSelect, onOpen, onContext, variant, treeDisabled,
  colWidths, onReorder, onResize,
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
  /** 2026-08-10 사용자 확정 — 헤더 드래그로 위치 이동·우측 가장자리로 폭 조절·넘치면 가로
   *  스크롤. 조정값은 계정별 저장(worklist.prefs — 부모가 소유). 셋 다 선택적: 안 넘기면 구 동작. */
  colWidths?: Record<string, number>;
  onReorder?: (next: string[]) => void;
  onResize?: (col: string, px: number) => void;
}) {
  const infi = variant === "infi";
  // Exam → Series → Image 계층 확장: '＋' 클릭=아래로 전개('−'로 전환), 다시 클릭=접기
  const { expanded, expSeries, trees, toggleExam, toggleSeries } = useSeriesTree();
  const span = columns.length + 2;   // 토글 + # + 컬럼들
  const markStyle = TREE_MARK;
  // ── 컬럼 폭·순서 직접 조작 ──────────────────────────────────────────────
  const [dragCol, setDragCol] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const resizingRef = useRef(false);   // 폭 조절 중 th 드래그(이동) 시작 금지
  const colWOf = (c: string) =>
    colWidths?.[c] ?? (infi ? INFI_COL_WIDTH[c] : undefined) ?? GRID_COL_DEF_W[c] ?? 110;
  // 전체 폭 = 고정 2열 + 컬럼 합 — 컨테이너보다 크면 바깥 div(overflow:auto)가 가로 스크롤을 낸다.
  // ⚠ tableLayout:fixed + colgroup 이라야 폭 지정이 결정적이다(auto 레이아웃은 내용이 폭을 이긴다).
  const totalW = 22 + 30 + columns.reduce((a, c) => a + colWOf(c), 0);
  const startResize = (c: string) => (e: React.PointerEvent) => {
    if (!onResize) return;
    e.preventDefault(); e.stopPropagation();
    resizingRef.current = true;
    const x0 = e.clientX;
    const w0 = colWOf(c);
    const move = (ev: PointerEvent) =>
      onResize(c, Math.max(40, Math.min(600, w0 + ev.clientX - x0)));
    const up = () => {
      resizingRef.current = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const dropOn = (c: string) => {
    if (!onReorder || !dragCol || dragCol === c) { setDragCol(null); setOverCol(null); return; }
    const next = columns.filter((x) => x !== dragCol);
    next.splice(next.indexOf(c) < 0 ? next.length : next.indexOf(c), 0, dragCol);
    onReorder(next);
    setDragCol(null); setOverCol(null);
  };
  return (
    <div style={{ overflow: "auto", flex: 1, minWidth: 0 }}>
      <table className={infi ? "grid-table grid-infi" : "grid-table"}
             style={{ tableLayout: "fixed", width: totalW, minWidth: "100%" }}>
        <colgroup>
          <col style={{ width: 22 }} />
          <col style={{ width: 30 }} />
          {columns.map((c) => <col key={c} style={{ width: colWOf(c) }} />)}
        </colgroup>
        <thead>
          <tr>
            <th />
            <th>#</th>
            {columns.map((c) => (
              <th key={c}
                  draggable={!!onReorder}
                  title={onReorder ? tr("드래그 = 컬럼 위치 이동 · 오른쪽 가장자리 드래그 = 폭 조절") : undefined}
                  onDragStart={(e) => {
                    if (resizingRef.current) { e.preventDefault(); return; }
                    setDragCol(c); e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => { if (dragCol) { e.preventDefault(); setOverCol(c); } }}
                  onDrop={(e) => { e.preventDefault(); dropOn(c); }}
                  onDragEnd={() => { setDragCol(null); setOverCol(null); }}
                  style={{ position: "relative", overflow: "hidden", textOverflow: "ellipsis",
                           whiteSpace: "nowrap",
                           cursor: onReorder ? "grab" : undefined,
                           opacity: dragCol === c ? 0.4 : undefined,
                           boxShadow: overCol === c && dragCol && dragCol !== c
                             ? "inset 3px 0 0 var(--accent)" : undefined }}>
                {tr(COLUMN_DEFS[c]?.label ?? c)}
                {onResize && (
                  <span onPointerDown={startResize(c)} draggable={false}
                        onClick={(e) => e.stopPropagation()}
                        onDragStart={(e) => e.preventDefault()}
                        style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 7,
                                 cursor: "col-resize" }} />
                )}
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
                      title={expanded.has(row.id) ? tr("접기") : tr("Series/Image 펼치기")}
                      onClick={(e) => { e.stopPropagation(); toggleExam(row.id); }}
                      onDoubleClick={(e) => e.stopPropagation()}>
                    {expanded.has(row.id) ? "−" : "＋"}
                  </td>
                )}
                <td style={{ color: "var(--text-secondary)" }}>{i + 1}</td>
                {/* tableLayout:fixed 에선 넘치는 내용이 이웃 칸을 밀지 못한다 — 말줄임으로 자른다 */}
                {columns.map((c) => (
                  <td key={c} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {COLUMN_DEFS[c]?.render(row)}
                  </td>
                ))}
              </tr>
              {/* Series → Image 행들 (과거검사 패널과 같은 렌더) */}
              {!treeDisabled && expanded.has(row.id) && (
                <SeriesTreeRows studyId={row.id} tree={trees[row.id]}
                                expSeries={expSeries} toggleSeries={toggleSeries}
                                colSpan={span - 1} lead={1} onOpen={() => onOpen(row)} />
              )}
            </Fragment>
          ))}
          {items.length === 0 && (
            <tr><td colSpan={span}
                    style={{ color: "var(--text-secondary)", textAlign: "center", padding: 24 }}>
              {tr("검사가 없습니다")}
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ── [D-좌] 과거검사 (선택 환자, F-14) ──────────────
   메인 그리드와 같은 '＋' 계층(Series → Image)을 쓰고, **더블클릭은 영상 열기**다.
   비교세트 추가는 예전에 더블클릭이 맡았지만 열기와 겹칠 수 없어 행 끝의 ⇄ 버튼으로 옮겼다
   (과거영상은 '열어 본다'가 '비교세트에 담는다'보다 훨씬 잦은 동작이다). */
function PriorStudiesGrid({ detail, onAddCompare, onOpen }: {
  detail: StudyDetail | null;
  onAddCompare: (e: { id: number; study_uid: string; study_date: string; modality: string; study_desc: string }) => void;
  onOpen: (id: number) => void;
}) {
  const { expanded, expSeries, trees, toggleExam, toggleSeries } = useSeriesTree();
  const span = 5;   // 토글 + 검사일 + MOD + 검사명 + 상태 (⇄ 는 상태 칸 안)
  return (
    <PanelBox title={`${tr("과거검사")} ${detail ? `— ${detail.patient_name}` : ""} ${tr("(＋ 펼치기 · 더블클릭=열기 · ⇄ 비교세트)")}`}>
      <table className="grid-table">
        <thead>
          <tr>
            <th style={{ width: 22 }} />
            <th>{tr("검사일")}</th><th>MOD</th><th>{tr("검사명")}</th><th>{tr("상태")}</th>
          </tr>
        </thead>
        <tbody>
          {(detail?.related_exams ?? []).map((e) => (
            <Fragment key={e.id}>
              <tr onDoubleClick={() => onOpen(e.id)} style={{ userSelect: "none" }}>
                <td style={{ ...TREE_MARK, textAlign: "center" }}
                    title={expanded.has(e.id) ? tr("접기") : tr("Series/Image 펼치기")}
                    onClick={(ev) => { ev.stopPropagation(); toggleExam(e.id); }}
                    onDoubleClick={(ev) => ev.stopPropagation()}>
                  {expanded.has(e.id) ? "−" : "＋"}
                </td>
                <td>{e.study_date}</td><td>{e.modality}</td>
                <td title={e.study_desc}>{e.study_desc}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <StatusBadge status={e.status} />
                  <button title={tr("비교세트에 추가")} style={{ padding: "0 6px", fontSize: 11, marginLeft: 6 }}
                          onClick={(ev) => { ev.stopPropagation(); onAddCompare(e); }}
                          onDoubleClick={(ev) => ev.stopPropagation()}>⇄</button>
                </td>
              </tr>
              {expanded.has(e.id) && (
                <SeriesTreeRows studyId={e.id} tree={trees[e.id]}
                                expSeries={expSeries} toggleSeries={toggleSeries}
                                colSpan={span - 1} lead={1} onOpen={() => onOpen(e.id)} />
              )}
            </Fragment>
          ))}
          {(!detail || detail.related_exams.length === 0) && (
            <tr><td colSpan={span} style={{ color: "var(--text-secondary)" }}>
              {detail ? tr("과거 검사 없음") : tr("검사를 선택하세요")}
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
    <PanelBox title={tr("비교세트 (Complementary set)")} right={
      <span style={{ display: "flex", gap: 4 }}>
        <button disabled={!current || items.length === 0} onClick={onMerge}
                title={tr("묶음판독(report_merge) — 비교세트 검사들을 현재 검사 판독 하나로 병합")}
                style={{ padding: "2px 10px", fontSize: 11.5 }}>
          {tr("묶음판독")}
        </button>
        <button className="primary" disabled={!current || items.length === 0} onClick={onOpenCompare}
                style={{ padding: "2px 10px", fontSize: 11.5 }}>
          {tr("비교 열기")} ({items.length + (current ? 1 : 0)})
        </button>
      </span>
    }>
      <table className="grid-table">
        <thead><tr><th>{tr("검사일")}</th><th>MOD</th><th>{tr("검사명")}</th><th></th></tr></thead>
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
              {tr("과거검사를 더블클릭해 추가 → 현재 검사와 함께 뷰어에서 비교")}
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
  useLang();   // 언어 변경 시 재렌더 (tr 사용 — export 컴포넌트)
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
        <b style={{ fontSize: 13 }}>{init ? `${tr("상용구 수정")} — ${init.name}` : tr("새 상용구 등록")}</b>
        <Row label={tr("이름 *")}><input autoFocus value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} /></Row>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Row label={tr("장비(MOD)")}>
            <select value={modality} onChange={(e) => setModality(e.target.value)} style={{ flex: 1 }}>
              <option value="">{tr("공통")}</option>
              {["CR", "DX", "CT", "MR", "US", "MG", "XA", "NM", "ES", "RF"].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </Row>
          <Row label={tr("부위")}>
            <input value={bodyPart} onChange={(e) => setBodyPart(e.target.value)} placeholder={tr("CHEST… (빈칸=공통)")}
                   style={{ flex: 1, minWidth: 0 }} />
          </Row>
        </div>
        <Row label={tr("단축키")}>
          <input value={shortcut} maxLength={1} onChange={(e) => setShortcut(e.target.value.toUpperCase())}
                 placeholder={tr("영문/숫자 1글자")} style={{ width: 90 }} />
          <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{tr("리포트에서 Alt+키로 즉시 삽입")}</span>
        </Row>
        <Row label={tr("본문 *")}>
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
                    } catch (e) { setErr(e instanceof Error ? e.message : tr("저장 실패")); }
                  }}>{tr("저장")}</button>
          <button onClick={onClose}>{tr("취소")}</button>
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
    if (!sel || !window.confirm(`${tr("상용구")} '${sel.name}'${tr("을 삭제할까요?")}`)) return;
    await api.deletePhrase(sel.id);
    setSel(null);
    load();
  };

  return (
    <PanelBox title={tr("상용구 (Std)")} right={
      <span style={{ display: "flex", gap: 3, alignItems: "center" }}>
        <label style={{ fontSize: 10, display: "flex", gap: 2, alignItems: "center", textTransform: "none" }}>
          <input type="checkbox" checked={fitOnly} onChange={(e) => setFitOnly(e.target.checked)} />{tr("맞춤")}
        </label>
        <MiniBtn onClick={() => sel && onInsert(sel.text)} disabled={!sel}>{tr("삽입")}</MiniBtn>
        <MiniBtn onClick={() => setModal("new")}>New</MiniBtn>
        <MiniBtn onClick={() => setModal("edit")} disabled={!sel}>Edit</MiniBtn>
        <MiniBtn onClick={del} disabled={!sel}>Del</MiniBtn>
      </span>
    }>
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
          <table className="grid-table">
            <thead><tr><th>{tr("분류")}</th><th>NAME</th><th style={{ width: 34 }}>{tr("키")}</th></tr></thead>
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
                  {items.length ? tr("맞춤 해제 시 전체 표시") : tr("New로 상용구 등록")}
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
      if (kos && selected.size > 0) { await api.sendKos(studyId); setMsg(tr("KOS 전송됨")); }
      else setMsg(tr("저장됨"));
    } catch (e) { setMsg(e instanceof Error ? e.message : tr("실패")); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center", padding: "3px 0" }}>
      <span style={{ fontSize: 10.5, color: "var(--text-secondary)", width: 56, flexShrink: 0 }}>
        KEY IMG<br />({selected.size}{tr("장")})
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
               title={canRegister ? undefined : tr(PERM_DENIED_TIP)}>{tr("저장")}</MiniBtn>
      <MiniBtn onClick={() => save(true)} disabled={busy || selected.size === 0 || !canRegister}
               title={canRegister ? undefined : tr(PERM_DENIED_TIP)}>KOS</MiniBtn>
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
          } catch (e) { alert(e instanceof Error ? e.message : tr("STT 실패")); }
        };
        recRef.current = rec;
        rec.start();
        setStt(true);
      }).catch(() => alert(tr("마이크 권한이 필요합니다")));
      return;
    }
    const w = window as unknown as Record<string, unknown>;
    const SR = (w.webkitSpeechRecognition ?? w.SpeechRecognition) as
      (new () => {
        lang: string; continuous: boolean; interimResults: boolean;
        onresult: (ev: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
        onend: () => void; onerror: () => void; start: () => void; stop: () => void;
      }) | undefined;
    if (!SR) { alert(tr("이 브라우저는 음성 인식을 지원하지 않습니다 (Chrome 권장 — 또는 설정>AI 정책에서 Whisper 선택)")); return; }
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
    return <PanelBox title="REPORT"><Empty>{tr("검사를 선택하세요")}</Empty></PanelBox>;
  }

  const finalized = current?.status === "finalized";
  // 16차: AI Structured Report(최신 AI 버전)와 의료인 Report 분리 + 전자서명
  const aiDraft = reports.find((r) => r.created_by === "ai") ?? null;
  const signature = (current?.diff_metrics as {
    signature?: { name: string; license_no: string; signed_at: string };
  })?.signature;
  const age = detail.birth_date ? `${new Date().getFullYear() - parseInt(detail.birth_date.slice(0, 4), 10)}${tr("세")}` : "-";

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
    if (!w) { alert(tr("팝업이 차단되었습니다")); return; }
    const sr = aiDraft.sr_json;
    const rows = [
      ...(sr.comparison.summary ? [`<div class="sec">COMPARISON</div><div>${escHtml(sr.comparison.summary)}</div>`] : []),
      `<div class="sec">FINDINGS</div>`,
      ...sr.findings.map((f) =>
        `<div><b>${escHtml(f.organ)}</b>: ${escHtml(f.observation)} ${f.severity === "critical" ? '<span class="crit">[CRITICAL]</span>' : ""}</div>`),
      `<div class="sec">IMPRESSION</div>`,
      ...sr.impression.map((i) => `<div>${i.rank}. ${escHtml(i.statement)} <i>(${i.confidence})</i></div>`),
      ...((sr.recommendations ?? []).length ? [`<div class="sec">RECOMMEND</div>`,
        ...(sr.recommendations ?? []).map((r) => `<div>- ${escHtml(r.action)} (${escHtml(r.timeframe)})</div>`)] : []),
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
<div class="foot">${tr("⚠ AI 생성 초안 — 확정 아님. 최종 판독은 의료인이 합니다.")}</div>
</body></html>`);
    w.document.close();
  };

  const histReport = histId !== null ? reports.find((r) => r.id === histId) ?? null : null;

  return (
    <PanelBox title="REPORT" right={
      <span style={{ display: "flex", gap: 3, alignItems: "center" }}>
        {onNav && (<>
          <MiniBtn title={tr("이전 환자(검사)로 이동")} onClick={() => onNav(-1)}>◀</MiniBtn>
          <MiniBtn title={tr("다음 환자(검사)로 이동")} onClick={() => onNav(1)}>▶</MiniBtn>
        </>)}
        {current && (<>
          {current.created_by === "ai" && <span className="badge ai">{tr("AI 초안 — 검토 필수")}</span>}
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
              <th>{tr("검사명")}</th><td colSpan={3} title={detail.study_desc}>{detail.study_desc}</td>
              <th>{tr("검사일")}</th><td>{detail.study_date}</td>
            </tr>
            <tr>
              <th>Reporter</th>
              <td colSpan={5}>
                Dictator: {current?.created_by === "ai" ? `AI(${current.ai_model})` : current?.created_by ?? "-"} ·
                Reader: {current?.reviewed_by || "-"} · Conf1: {finalized ? current?.reviewed_by : "-"} ·
                Conf2: {(current?.diff_metrics as { confirm2?: { by: string } })?.confirm2?.by ?? "-"}
              </td>
              <th>{tr("확정일")}</th>
              <td>{current?.finalized_at ? current.finalized_at.slice(0, 10) : "-"}</td>
            </tr>
          </tbody>
        </table>

        <KeyImageStrip studyId={detail.id} />

        {!current || !draft ? (
          <Empty>
            {tr("리포트 없음")}
            <div style={{ marginTop: 6 }}>
              <MiniBtn disabled={!canWrite} title={canWrite ? undefined : tr(PERM_DENIED_TIP)}
                       onClick={async () => {
                         try { await api.analyze(detail.id); onChanged(); }
                         catch (e) { alert((e as Error).message); }   // AI 판독 보류(409) 등 안내
                       }}>{tr("AI 초안 생성")}</MiniBtn>
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
                  <button title={tr("별도 창(모니터)으로 AI 리포트 보기")} disabled={!aiDraft} onClick={openAiPopup}
                          style={{ padding: "1px 7px", fontSize: 11 }}>↗</button>
                  <button className="primary" disabled={!aiDraft || finalized || !canWrite}
                          title={canWrite ? tr("AI 초안을 우측 Report로 복사 — 검토 후 의료인이 확정(서명)") : tr(PERM_DENIED_TIP)}
                          onClick={() => aiDraft && setDraft(structuredClone(aiDraft.sr_json))}
                          style={{ padding: "1px 10px", fontSize: 11 }}>{tr("적용 ▶")}</button>
                </div>
                {!aiDraft ? (
                  <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>{tr("AI 초안 없음 — 초안 재생성으로 생성")}</div>
                ) : (
                  <div style={{ fontSize: 11.5 }}>
                    {aiDraft.sr_json.comparison.summary && (
                      <div style={{ color: "var(--text-secondary)", marginBottom: 3 }}>{tr("[비교]")} {aiDraft.sr_json.comparison.summary}</div>
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
                    {(aiDraft.sr_json.recommendations ?? []).map((r, i) => (
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
                  {tr("REPORT (판독)")}
                  <span style={{ flex: 1 }} />
                  <select title={tr("판독 이력 — 과거 버전 보기")} value={histId ?? "cur"}
                          style={{ fontSize: 10.5 }}
                          onChange={(e) => setHistId(e.target.value === "cur" ? null : Number(e.target.value))}>
                    <option value="cur">{tr("현재")} (v{current.version})</option>
                    {reports.slice(1).map((r) => (
                      <option key={r.id} value={r.id}>
                        v{r.version} · {tr(STATUS_LABEL[r.status] ?? r.status)} · {r.created_by === "ai" ? "AI" : r.created_by}
                      </option>
                    ))}
                  </select>
                </div>
                {histReport ? (
                  <div style={{ fontSize: 12, whiteSpace: "pre-wrap", color: "var(--text-secondary)", overflow: "auto" }}>
                    <div style={{ color: "var(--accent)", fontSize: 10.5, marginBottom: 4 }}>
                      [{tr("이력 보기")} — v{histReport.version} · {histReport.created_by === "ai" ? `AI(${histReport.ai_model})` : histReport.created_by}
                      {histReport.finalized_at && ` · ${tr("확정")} ${histReport.finalized_at.slice(0, 10)}`}] {tr("읽기 전용")}
                    </div>
                    {histReport.narrative_text || tr("(내용 없음)")}
                  </div>
                ) : (<>
                <SectionTitle>READING</SectionTitle>
                <div style={{ fontSize: 12 }}>
                  {draft.comparison?.summary && (
                    <div style={{ color: "var(--text-secondary)", marginBottom: 3 }}>{tr("[비교]")} {draft.comparison?.summary}</div>
                  )}
                  {(draft.findings ?? []).map((f, i) => (
                    <div key={i}>
                      <b>{f.organ}</b>: {f.observation}{" "}
                      {f.severity === "critical" && <span className="badge critical">CRITICAL</span>}
                    </div>
                  ))}
                </div>
                <SectionTitle>CONCLUSION</SectionTitle>
                {(draft.impression ?? []).map((imp, i) => (
                  <textarea key={i} value={imp.statement} disabled={finalized} readOnly={!canWrite}
                            title={canWrite ? undefined : tr(PERM_DENIED_TIP)}
                            onChange={(e) => setDraft((d) => {
                              const n = structuredClone(d!); n.impression[i].statement = e.target.value; return n;
                            })}
                            style={{
                              width: "100%", background: "var(--bg-canvas)", color: "var(--text-primary)",
                              border: "1px solid var(--border)", borderRadius: 3, padding: 5,
                              fontFamily: "inherit", fontSize: 12.5, resize: "vertical", minHeight: 44,
                            }} />
                ))}
                {(draft.recommendations ?? []).length > 0 && (
                  <>
                    <SectionTitle>RECOMMEND</SectionTitle>
                    {(draft.recommendations ?? []).map((r, i) => (
                      <div key={i} style={{ fontSize: 12 }}>- {r.action} ({r.timeframe})</div>
                    ))}
                  </>
                )}
                {signature && (
                  <div style={{
                    marginTop: "auto", borderTop: "1px solid var(--border)", paddingTop: 4,
                    fontSize: 11.5, color: "var(--stat-final)",
                  }}>
                    {tr("✍ 서명:")} {signature.name}{signature.license_no && ` (${tr("면허 제")}${signature.license_no}${tr("호")})`} ·
                    {" "}{signature.signed_at?.slice(0, 16).replace("T", " ")}
                  </div>
                )}
                </>)}
              </div>
            </div>
            <div style={{ display: "flex", gap: 5, marginTop: "auto", paddingTop: 4 }}>
              {/* 판독 작성·변경(report.write)/판독 출력(report.print) 게이트 — 서버 403 이 최종 방어선 */}
              <MiniBtn disabled={!canWrite} title={canWrite ? undefined : tr(PERM_DENIED_TIP)}
                       onClick={async () => {
                         try { await api.analyze(detail.id); onChanged(); }
                         catch (e) { alert((e as Error).message); }   // AI 판독 보류(409) 등 안내
                       }}>{tr("초안 재생성")}</MiniBtn>
              <MiniBtn disabled={!canPrint} title={canPrint ? undefined : tr(PERM_DENIED_TIP)}
                       onClick={() => downloadReportPdf(current.id)}>PDF</MiniBtn>
              {!finalized && (
                <MiniBtn onClick={toggleStt} disabled={!canWrite}
                         title={!canWrite ? tr(PERM_DENIED_TIP)
                              : `${tr("음성 판독(STT) — 엔진:")} ${sttEngine === "whisper_local" ? tr("Whisper 로컬(오픈소스)")
                              : sttEngine === "openai_api" ? "OpenAI API" : tr("브라우저 내장")} ${tr("(설정>AI 정책)")}`}
                         style={stt ? { background: "var(--stat-emergency)", color: "#fff" } : undefined}>
                  {stt ? tr("🎤 녹음중") : `${tr("🎤 음성")}${sttEngine !== "browser" ? "·W" : ""}`}
                </MiniBtn>
              )}
              {!finalized && (
                <MiniBtn disabled={!canWrite} title={canWrite ? tr("판독 보류(Suspend) — 토글") : tr(PERM_DENIED_TIP)}
                         onClick={async () => {
                  await api.suspendReport(current.id); onChanged();
                }}>{current.status === "suspended" ? tr("보류 해제") : tr("보류")}</MiniBtn>
              )}
              {finalized && !(current.diff_metrics as { confirm2?: unknown })?.confirm2 && (
                <MiniBtn disabled={!canWrite} title={canWrite ? tr("2차 승인(Conf2) — 1차와 다른 판독의 권장") : tr(PERM_DENIED_TIP)}
                         onClick={async () => {
                  await api.confirm2Report(current.id); onChanged();
                }}>2nd Approve</MiniBtn>
              )}
              {finalized && (
                <MiniBtn onClick={async () => { setBusy(true); try { await api.sendSr(current.id); alert(tr("DICOM SR 전송 완료")); } finally { setBusy(false); } }}>
                  {tr("SR 전송")}
                </MiniBtn>
              )}
              <div style={{ flex: 1 }} />
              <MiniBtn onClick={save} disabled={busy || finalized || !canWrite}
                       title={canWrite ? undefined : tr(PERM_DENIED_TIP)}>Save</MiniBtn>
              <button className="primary" style={{ padding: "2px 12px", fontSize: 12 }}
                      onClick={finalize} disabled={busy || finalized || !canWrite}
                      title={canWrite ? undefined : tr(PERM_DENIED_TIP)}>
                {finalized ? tr("확정됨") : tr("확정 (서명)")}
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
          <b style={{ fontSize: 13 }}>{tr("새 오더 등록 — MWL로 장비에 전달됩니다")}</b>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} title={tr("닫기")} style={{ padding: "1px 8px" }}>✕</button>
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
            return `${tr("오더")} ${exams.length}${tr("건 등록")}`;
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
    catch (e) { alert(e instanceof Error ? e.message : tr("상태 변경 실패")); }
  };
  const exportMwl = async () => {
    try {
      const r = await api.exportMwl();
      setMsg(`MWL ${r.count}${tr("건 내보냄 → 장비 C-FIND 응답")}`);
    } catch (e) { setMsg(e instanceof Error ? e.message : tr("MWL 실패")); }
  };
  // 오더 삭제 — confirm 후 DELETE, 실패 사유는 사용자에게 그대로 노출 (삼킴 금지)
  const del = async (o: OrderRow) => {
    if (!confirm(`${tr("오더 삭제 —")} ${o.patient_name || o.patient_key} / ${o.accession_no || tr("(Accession 없음)")}\n${tr("삭제하면 되돌릴 수 없습니다.")}`)) return;
    try { await api.deleteOrder(o.id); load(); }
    catch (e) { alert(e instanceof Error ? e.message : tr("오더 삭제 실패")); }
  };

  return (
    <PanelBox title={tr("오더/예약 (RIS·MWL)")} right={
      <span style={{ display: "flex", gap: 3 }}>
        <MiniBtn onClick={() => setModalOpen(true)}>New</MiniBtn>
        <MiniBtn onClick={exportMwl} title={tr("scheduled 오더를 MWL(.wl)로 내보내기 — Orthanc worklists")}>MWL</MiniBtn>
      </span>
    }>
      <table className="grid-table">
        <thead><tr><th>{tr("환자")}</th><th>{tr("오더명")}</th><th>MOD</th><th>{tr("예약일")}</th><th>{tr("상태")}</th><th>{tr("가져감")}</th><th></th></tr></thead>
        <tbody>
          {items.map((o) => (
            <tr key={o.id}>
              <td title={o.accession_no}>{o.patient_name || o.patient_key}</td>
              <td title={o.procedure_desc}>{o.procedure_desc}</td>
              <td>{o.modality}</td>
              <td>{o.scheduled_date}</td>
              <td>{tr(ORDER_STATUS[o.status] ?? o.status)}</td>
              {/* 장비가 MWL C-FIND 로 가져간 관찰 기록 — AET 표시, 시각은 title 툴팁 */}
              <td>{o.taken_aet
                ? <span title={o.taken_at ? `${tr("가져간 시각:")} ${o.taken_at.slice(0, 19).replace("T", " ")}` : undefined}>🏷 {o.taken_aet}</span>
                : "—"}</td>
              <td style={{ whiteSpace: "nowrap" }}>
                {o.status === "scheduled" && (
                  <MiniBtn title={tr("검사 시작 (MPPS IN PROGRESS)")} onClick={() => setSt(o.id, "in_progress")}>{tr("시작")}</MiniBtn>
                )}
                {o.status === "in_progress" && (
                  <MiniBtn title={tr("검사 완료 (MPPS COMPLETED)")} onClick={() => setSt(o.id, "completed")}>{tr("완료")}</MiniBtn>
                )}
                {(o.status === "scheduled" || o.status === "in_progress") && (
                  <MiniBtn title={tr("취소 (MPPS DISCONTINUED)")} onClick={() => setSt(o.id, "cancelled")}>✕</MiniBtn>
                )}
                <MiniBtn title={tr("오더 삭제 (DB에서 제거 — 되돌릴 수 없음)")} onClick={() => del(o)}
                         style={{ color: "var(--stat-emergency)" }}>✕</MiniBtn>
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr><td colSpan={7} style={{ color: "var(--text-secondary)" }}>{tr("오더 없음 — New로 등록, MWL로 장비 전달")}</td></tr>
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
        <L k="Exam Date" v={`${detail.study_date} ${detail.study_time ?? ""} [ ${tr(STATUS_LABEL[detail.status] ?? detail.status)} ]`} />
        <L k="Study Comment" v={detail.clinical_info} />
        <L k="Sex / Age" v={`${detail.sex} / ${age}`} />
        <div style={{ height: 8 }} />
        <L k="Creator" v={rep?.created_by === "ai" ? tr("AI (초안)") : rep?.created_by} />
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
    <PanelBox title={tr("Thumbnail (더블클릭=뷰어)")} right={
      <span style={{ display: "flex", gap: 3 }}>
        <GridPicker label="Srs" value={sLay} onPick={(v) => { setSLay(v); persist(v, iLay); }} />
        <GridPicker label="Img" value={iLay} onPick={(v) => { setILay(v); persist(sLay, v); }} />
      </span>
    }>
      {!detail ? <Empty>{tr("검사를 선택하세요")}</Empty> : tree.length === 0 ? (
        <Empty>{tr("영상 없음 (Orthanc 미연결?)")}</Empty>
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
              +{tree.length - sLay.r * sLay.c} {tr("시리즈 — Srs 레이아웃 확장")}
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
          setSaved(tr("저장됨"));
          onChanged();
          setTimeout(() => setSaved(""), 2000);
        }}>{tr("저장")}</MiniBtn>
      )
    }>
      {!detail ? <Empty>{tr("검사를 선택하세요")}</Empty> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: 6, height: "100%" }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text-secondary)" }}>{tr("COMMENT (임상정보)")}</div>
          <div style={{ fontSize: 12, color: "var(--text-primary)", maxHeight: 56, overflow: "auto" }}>
            {detail.clinical_info || <span style={{ color: "var(--text-secondary)" }}>{tr("(없음)")}</span>}
          </div>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text-secondary)", display: "flex", gap: 6 }}>
            MEMO {saved && <span style={{ color: "var(--stat-final)" }}>{saved}</span>}
          </div>
          <textarea value={memo} onChange={(e) => setMemo(e.target.value)}
                    placeholder={tr("검사 메모 — 워크리스트 메모 컬럼에 표시됩니다")}
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
           title={ok ? undefined : tr(PERM_DENIED_TIP)}
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
      <Item a="viewdraft" label={tr("View&Draft (자체 뷰어)")} />
      <Item a="ub_add" label={tr("Add View — 기존 유지+추가")} />
      <Item a="ub_stack" label={tr("Stack View — 기존 유지+중첩")} />
      {ohifOn && <Item a="ub_adv" label="Advance View (OHIF)" />}
      <Item a="ub_key" label={tr("Key Image View — 키 이미지만")} />
      <Item a="3d" label={tr("3D 뷰어 (MPR/MIP)")} />
      <Item a="compare" label={tr("비교세트에 추가")} />
      <Sep />
      <Item a="pdf" label={tr("PDF 내보내기")} />
      <Item a="copyreport" label={tr("과거 판독 복사 (Copy Report)")} />
      <Item a="regen" label={tr("AI 초안 재생성")} />
      <Sep />
      <Item a="bookmark" label={row.bookmark ? tr("★ 북마크 해제") : tr("☆ 북마크")} />
      <Item a="emergency" label={row.emergency ? tr("Emergency 해제") : tr("⚠ Emergency 지정")} danger={!row.emergency} />
      <Sep />
      {/* 검사 관리(admin-action) — 등급별 유효 권한으로 게이트, 서버도 403 강제 */}
      <Item a="adm_match" label={tr("오더 매칭 (Match)")} />
      <Item a="adm_unmatch" label={tr("오더 언매칭 (Unmatch)")} />
      <Item a="adm_move" label={tr("검사 이동 — 병원 재귀속")} />
      <Item a="adm_copy" label={tr("검사 복제 (Copy)")} />
      <Item a="adm_delete" label={tr("검사 삭제")} danger />
    </div>
  );
}

interface LayoutSizes { railW: number; dH: number; eH: number; thumbW: number; stdW: number; commentW: number }
const DEFAULT_SIZES: LayoutSizes = { railW: 152, dH: 140, eH: 300, thumbW: 230, stdW: 210, commentW: 250 };
// SaintView/I-View 고정 배치 구역 높이(px) — 좌하단 Preview·과거검사·리포트
interface InfiSizes { prevH: number; priorH: number; repH: number }
const DEFAULT_INFI_SIZES: InfiSizes = { prevH: 220, priorH: 96, repH: 260 };

/* ── 패널 드래그 래퍼 — 좌측 그립을 끌어 같은 행 안에서 자리 교환 ── */
function DraggablePanel({ zone, k, onDrop, onHide, style, children }: {
  zone: "d" | "e"; k: string;
  onDrop: (zone: "d" | "e", src: string, dst: string) => void;
  onHide?: () => void;   // 있으면 그립 하단에 ✕(숨기기) 버튼 — 화면에서 숨김(Setting 체크박스와 동기)
  style?: React.CSSProperties; children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", minWidth: 0, minHeight: 0, ...style }}
         onDragOver={(e) => e.preventDefault()}
         onDrop={(e) => {
           const src = e.dataTransfer.getData(`text/sv-panel-${zone}`);
           if (src) onDrop(zone, src, k);
         }}>
      <div style={{ width: 12, flexShrink: 0, display: "flex", flexDirection: "column",
                    background: "var(--bg-elevated)", borderRadius: "4px 0 0 4px",
                    border: "1px solid var(--border)", borderRight: "none" }}>
        <div draggable title={tr("패널 이동 — 드래그해서 자리 교환")}
             onDragStart={(e) => e.dataTransfer.setData(`text/sv-panel-${zone}`, k)}
             style={{ flex: 1, cursor: "grab", display: "flex", alignItems: "center",
                      justifyContent: "center", color: "var(--text-secondary)", fontSize: 9 }}>
          ⋮
        </div>
        {onHide && (
          <div title={tr("이 패널 숨기기 (Setting>워크리스트에서 다시 표시)")} onClick={onHide}
               style={{ flexShrink: 0, cursor: "pointer", textAlign: "center", fontSize: 9, lineHeight: "14px",
                        color: "var(--text-secondary)", borderTop: "1px solid var(--border)" }}>
            ✕
          </div>
        )}
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
    if (!window.confirm(`${tr("AI 초안")} ${checked.size}${tr("건을 일괄 확정(서명)합니다.")}\n${tr("확정 후에는 수정할 수 없습니다. 진행할까요?")}`)) return;
    setBusy(true);
    try { const r = await api.batchFinalize([...checked]); setResult(`${r.finalized}/${r.total}${tr("건 확정")}`); onDone(); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "grid", placeItems: "center", zIndex: 100 }}>
      <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8, width: 760, maxHeight: "80vh", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center" }}>
          <b>{tr("AI 초안 일괄 검토 (F-22)")}</b>
          <span style={{ color: "var(--text-secondary)", fontSize: 12, marginLeft: 8 }}>{tr("critical 초안은 자동 제외 — 개별 검토 필요")}</span>
          <button style={{ marginLeft: "auto" }} onClick={onClose}>{tr("닫기")}</button>
        </div>
        <div style={{ overflow: "auto", flex: 1 }}>
          <table className="grid-table">
            <thead><tr><th></th><th>{tr("환자")}</th><th>{tr("검사일")}</th><th>MOD</th><th>{tr("검사명")}</th><th>{tr("AI 임프레션")}</th><th>{tr("신뢰도")}</th></tr></thead>
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
                <tr><td colSpan={7} style={{ textAlign: "center", color: "var(--text-secondary)", padding: 20 }}>{tr("대상 초안 없음")}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)", display: "flex", gap: 8, alignItems: "center" }}>
          {result && <span style={{ color: "var(--stat-final)" }}>{result}</span>}
          <div style={{ flex: 1 }} />
          <button className="primary" disabled={busy || checked.size === 0} onClick={confirm}>
            {tr("선택")} {checked.size}{tr("건 일괄 확정")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ════ 워크리스트 워크스페이스 루트 ════ */
/* SAINT VIEW 워크리스트 상단 상태 카운트 바 (그림1) — 서버 counts 엔드포인트로 전 검사 정확 집계.
   서버 응답 전/실패 시 현재 페이지 집계로 폴백. 칩 클릭 시 상태 필터. */
function SvStatusBar({ queryParams, refreshKey, items, onStatus, onRefresh, pageOnly }: {
  queryParams: Record<string, string>;
  refreshKey: number;
  items: StudyRow[];
  onStatus: (patch: { status?: string; emergency?: string }) => void;
  onRefresh: () => void;
  pageOnly?: boolean;   // LIVE 모드 — 서버(로컬 DB) 집계는 무의미, 현재 페이지 집계만
}) {
  const [c, setC] = useState<{ total: number; emergency: number; unread: number; reading: number; draft_ready: number; finalized: number } | null>(null);
  useEffect(() => {
    if (pageOnly) { setC(null); return; }
    let alive = true;
    api.worklistCounts({ ...queryParams, qf: sbScopeParam(), qop: sbOpParam() })
      .then((r) => { if (alive) setC(r); }).catch(() => { if (alive) setC(null); });
    return () => { alive = false; };
  }, [queryParams, refreshKey, pageOnly]);
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
      <b style={{ fontSize: 14, marginRight: 6 }}>{tr("워크리스트")}</b>
      {chips.map((ch) => (
        <button key={ch.label} onClick={ch.onClick} title={`${tr(ch.label)} ${tr("상태로 필터")}`}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 12px", borderRadius: 16,
                         background: "var(--bg-elevated)", border: "1px solid var(--border)", cursor: "pointer", fontSize: 12 }}>
          <span style={{ color: ch.color, fontWeight: 700 }}>{tr(ch.label)}</span>
          <span style={{ fontWeight: 700 }}>{(ch.n ?? ch.fb).toLocaleString()}</span>
        </button>
      ))}
      {!c && (
        <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--text-secondary)" }}>{tr("현재 페이지 집계 (서버 집계 대기…)")}</span>
      )}
      <button title={tr("새로고침")} onClick={onRefresh} style={{ padding: "3px 10px", marginLeft: c ? "auto" : 8 }}>⟳</button>
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
      <b style={{ fontSize: 13 }}>{tr("Performance — 모달리티 분포 (현재 검색 범위)")}</b>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 8, maxWidth: 560 }}>
        {entries.length === 0 && <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>{tr("데이터 없음")}</span>}
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
  useLang();   // 언어 변경 시 재렌더 (tr 사용 — export 컴포넌트)
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [searchText, setSearchText] = useState("");
  // ── 확정된 질의(committed query) ────────────────────────────────────────────────
  // filters/searchText 는 **입력 상태**일 뿐이다. 서버 조회는 오직 여기 커밋된 스냅샷으로만 한다.
  // 예전에는 조회 effect 가 filters/searchText 를 직접 의존해서, 수동 갱신 모드인데도 SEARCH 칸에
  // 한 글자 칠 때마다 /api/worklist 가 나가고 그리드가 바뀌었다 — 기획(커밋 7c5d360)의
  // '수동 = 내가 SEARCH 를 누를 때만 목록이 바뀐다' 계약을 조회 경로에서만 안 지킨 상태였다.
  // 커밋은 applyAndSearch() 한 곳에서만 일어난다(입력 상태와 커밋 값이 두 개의 진실이 되지 않도록).
  const [committed, setCommitted] = useState<CommittedQuery>(() => ({ filters: {}, searchText: "" }));
  // worklist.prefs(default_status) 도착 전에 조회하면 '빈 조건으로 1회 → prefs 반영해 1회' 로
  // 로드 직후 목록이 두 번 바뀐다. prefs 가 확정된 뒤에 첫 조회를 하도록 게이트한다.
  const [prefsReady, setPrefsReady] = useState(false);
  // 설정 저장 신호 카운터 — 목록 재조회(refreshKey)와 **분리**한다.
  // 설정 저장은 컬럼·패널·레이아웃만 다시 해석해야 하고, 행 구성(목록)을 갈아엎으면 안 된다.
  const [settingsTick, setSettingsTick] = useState(0);
  const [datePreset, setDatePreset] = useState("all");
  const [items, setItems] = useState<StudyRow[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<StudyDetail | null>(null);
  // 다중선택 — Shift=범위, Ctrl/Cmd=개별 토글, 일반=단일. selected(포커스)와 별개의 선택 집합.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [exportRows, setExportRows] = useState<StudyRow[] | null>(null);   // DICOM 반출 대상
  // 다운로드 모드 기준선 — **첫 이미지를 연 시각**. 조건 없는 워크리스트는 곧 전체 아카이브라
  // 통째로 받으면 안 되고, 판독을 시작한 시점부터가 '이 세션에서 볼 것' 이다(lib/worklistQuery 참조).
  // sessionStorage 인 이유: 새로고침으로 기준선이 리셋되면 이미 받은 범위를 다시 계산하게 된다.
  const [dlOpenedAt, setDlOpenedAt] = useState<number>(() => {
    const v = Number(sessionStorage.getItem("sv_dl_opened_at") ?? 0);
    return Number.isFinite(v) ? v : 0;
  });
  // 다운로드 모드가 실제로 켜져 있는가(= dlConfigure 에 넘긴 enabled 와 같은 값).
  // 아래 뷰어 생존 폴링 훅의 게이트다 — 기준선이 **없을 때도** 돌아야 하기 때문에(상승 에지 관측)
  // '기준선이 있는가' 를 게이트로 쓸 수 없다. 다운로드 모드가 꺼져 있으면 관측할 이유가 없으므로
  // 평상시 비용은 그대로 0 이다.
  const [dlEnabled, setDlEnabled] = useState(false);
  // 기준선은 **판독 세션 단위**다: 뷰어가 열려 있는 동안은 처음 연 시각을 유지하고,
  // 뷰어를 닫으면 풀린다(clearDlOpened). 그래서 다시 열면 **그때 연 영상이 새 기준**이 된다.
  // 매 오픈마다 밀면 이미 받던 범위가 계속 잘려 '받다 말다' 를 반복한다.
  //  · 호출자는 둘이다: openV2(이 창에서 여는 경로) + 아래 뷰어 생존 폴링 훅의 **상승 에지**
  //    (판독창 ◀▶·Compare·다른 워크리스트 탭에서 연 경우 — 그 창들은 이 함수를 부를 수 없다).
  const markDlOpened = useCallback(() => {
    // ★ 재개는 기준선 유무와 **무관하게 매번** 부른다. 뷰어를 닫으면 clearDlOpened 가 dlStop 을
    //   부르는데, 그 뒤 다시 열었을 때 되살릴 곳이 여기밖에 없다(dlStart 는 dlConfigure 안에서만
    //   불린다 — 설정 저장이나 서버모드 전환을 해야만 살아나는 상태였다).
    //   dlResume 은 다운로드 모드가 꺼져 있으면 no-op 이고 dlStart 자체가 멱등이라 매번 불러도 무해.
    dlResume();
    setDlOpenedAt((prev) => {
      if (prev) return prev;                       // 세션 안에서는 첫 번째만
      const now = Date.now();
      try { sessionStorage.setItem("sv_dl_opened_at", String(now)); } catch { /* 무시 */ }
      return now;
    });
  }, []);
  /** 뷰어가 **모두** 닫혔다 — 기준선을 풀고 백그라운드 다운로드도 멈춘다.
   *  · 정지는 조건부가 아니라 **항상**이다(사용자 문장: "일단 멈추고"). 검색 조건을 걸어 둔
   *    ①'filtered' 범위도 함께 멈춘다 — 그 대신 markDlOpened 의 dlResume 이 **항상** 되살린다.
   *    둘은 한 쌍이다: 재개 없이 이 정지만 배선하면 '한 번 뷰어를 닫으면 그 세션 내내 다운로드가
   *    죽는' 상태가 된다(지금보다 나쁘다).
   *  · 호출자는 아래 폴링 훅 하나다(하강 에지에서만). */
  const clearDlOpened = useCallback(() => {
    try { sessionStorage.removeItem("sv_dl_opened_at"); } catch { /* 무시 */ }
    setDlOpenedAt(0);
    dlStop();
  }, []);
  const selAnchorRef = useRef<number | null>(null);   // Shift 범위 기준점(마지막 단일/토글 클릭)
  // 하이라이트 전용 **동기** 포커스 id.
  // ⚠ 예전에는 그리드가 selected?.id(= api.study 응답으로 채워지는 상세)를 봤다. 그런데 클릭 즉시
  //   바뀌는 것은 selectedIds 뿐이라, 상세 왕복이 끝나기 전까지 **옛 행과 새 행이 동시에 강조**됐다
  //   ("클릭 한 번인데 두 개가 선택된 것처럼 보인다"). 원격 A 가 느리면 그 시간이 그대로 늘어난다.
  //   하이라이트는 네트워크를 기다릴 이유가 없다 — 화면 상태는 화면 상태로만 정한다.
  const [focusId, setFocusId] = useState<number | null>(null);
  const [compareSet, setCompareSet] = useState<CompareItem[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  // 목록 갱신 정책 — 기본은 **수동**(SEARCH 를 눌러야 갱신). 설정 > 환경에서 자동/초 지정.
  // 예전에는 값이 없으면 10초 자동이었고, Live 는 사용자 설정과 무관하게 5초로 강제됐다.
  // 판독 중에 목록이 저 혼자 움직이는 것이 방해가 된다는 지적이 있어 기본을 뒤집었다.
  const [refreshMode, setRefreshMode] = useState<"manual" | "auto">("manual");
  const [refreshSec, setRefreshSec] = useState(10);
  // 수동 모드에서 원격(A)에 변경이 감지되면 목록을 바꾸지 않고 **알리기만** 한다.
  const [pendingChange, setPendingChange] = useState(false);
  // SEARCH 실행 시각 피드백 — 재조회 시작 시 그리드 깜빡임 (동일 keyframes 2개를 번갈아 써서 연속 클릭에도 재시작)
  const [searchFlash, setSearchFlash] = useState(0);
  const flashMountRef = useRef(false);
  const [columns, setColumns] = useState<string[]>(DEFAULT_COLUMNS);
  // ── 그리드 컬럼 폭·순서 직접 조작(2026-08-10 사용자 확정) — 계정별 저장 ──
  // 폭: worklist.prefs.col_widths_by_viewer[vk] · 순서: by_viewer[vk](설정 ▲▼ 와 같은 키 —
  // 두 UI 가 다른 키에 쓰면 반드시 갈린다). 저장은 병합형(read-modify-write)으로 다른 키 보존.
  const [colW, setColW] = useState<Record<string, number>>({});
  // ── 통합 검색창(2026-08-10) — 방식·범위·결합은 설정>워크리스트>검색창 설정(계정 저장) ──
  const [searchMode, setSearchModeState] = useState<"text" | "ai">(DEFAULT_SEARCH_BOX.mode);
  const sbRef = useRef<{ fields: string[]; op: "and" | "or" }>({ fields: DEFAULT_SEARCH_BOX.fields, op: DEFAULT_SEARCH_BOX.op });
  const setSearchMode = useCallback((m: "text" | "ai") => {
    setSearchModeState(m);
    // 모드 전환은 계정에 기억(다음 접속 기본값) — 병합 저장으로 다른 키 보존
    api.getSetting("worklist.prefs").then((r) => {
      const sb = ((r.value as { search_box?: object }).search_box ?? {}) as Record<string, unknown>;
      return api.putSetting("worklist.prefs", { ...r.value, search_box: { ...sb, mode: m } }, "user");
    }).catch(() => {});
  }, []);
  const colWSaveT = useRef<number | null>(null);
  // 뷰어별 워크리스트 컬럼 오버라이드(settings>워크리스트>뷰어별) — 모드 전환 시 적용
  const wlColsBaseRef = useRef<string[]>(DEFAULT_COLUMNS);
  const wlByViewerRef = useRef<{ sv?: string[] | null; ty?: string[] | null; infi?: string[] | null }>({});
  const [wlBvTick, setWlBvTick] = useState(0);
  const [findFields, setFindFields] = useState<string[]>(DEFAULT_FIND_FIELDS);
  const [dblAction, setDblAction] = useState<"viewer2d" | "ohif">("viewer2d");
  const [batchOpen, setBatchOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [webPacsOpen, setWebPacsOpen] = useState(false);   // WebPACS 브리지(인계 PACS 가져오기)
  const [viewer3dUid, setViewer3dUid] = useState<string | null>(null);
  // Local Server 모드 (레인 F) — ServerButtons 의 sv_server_mode 를 데이터 소스 전환으로 승격.
  // local 이면 서버 worklist 를 호출하지 않고(서버 검사·환자 완전 숨김) local.db 목록만 표시
  const [serverMode, setServerMode] = useState<"local" | "web" | "live" | null>(
    () => (localStorage.getItem("sv_server_mode") as "local" | "web" | "live") || null);
  const localMode = serverMode === "local";
  // WebPACS Live(A 직결) — 워크리스트 데이터 소스를 원격 PACS 실시간 조회로 전환(복사 없음).
  // 검사 id 는 vid(≥90M) — api.* 가 자동으로 /api/webpacs/live 로 라우팅해 뷰어·판독이 그대로 동작
  const liveMode = serverMode === "live";
  // EXAM CONTROL (레인 F) — 관리자 역할일 때만 탭 노출, 선택 시 본문을 검사 QC 화면으로 전환.
  // 탭 바는 TY·In 양 모드 공유이므로 두 모드 모두 자동 지원. 워크리스트 탭 클릭 시 원복.
  const isAdminRole = (localStorage.getItem("sv_role") ?? sessionStorage.getItem("sv_role") ?? "") === "admin";
  const [examCtl, setExamCtl] = useState(false);
  const [localRoot, setLocalRoot] = useState("");           // localInit 결과 루트(배지·Import 안내)
  const [localErr, setLocalErr] = useState("");             // 백엔드 미구현/미설정 → '⚠ 준비 중' 우아 처리
  const [localViewerRow, setLocalViewerRow] = useState<StudyRow | null>(null);   // 로컬 뷰어 모달 대상
  const pickServerMode = useCallback((m: "local" | "web" | "live") => {
    setServerMode(m);
    localStorage.setItem("sv_server_mode", m);              // 새로고침에도 유지(기존 키)
    setRefreshKey((k) => k + 1);
  }, []);
  // LIVE 진입: 선택 해제(연결 상태는 목록 조회가 판정 — 실패 시 liveErr 배지)
  const [liveErr, setLiveErr] = useState("");
  useEffect(() => {
    if (!liveMode) return;
    setSelected(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveMode]);
  // LOCAL 진입: 폴더 구조 보장(init — 멱등) + 루트 표시, 서버 선택 상태 해제
  useEffect(() => {
    if (!localMode) return;
    setSelected(null);
    api.localInit()
      .then((r) => { setLocalRoot(r.root); setLocalErr(""); })
      .catch((e) => { setLocalRoot(""); setLocalErr(e instanceof Error ? e.message : tr("준비 중")); });
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
  const panelsOnRef = useRef(panelsOn);   // 핸들러에서 최신 패널 상태 읽기(setState 업데이터 밖에서 저장)
  useEffect(() => { panelsOnRef.current = panelsOn; }, [panelsOn]);
  // Study With Open (p.13): 더블클릭 시 Related Study를 함께 오픈 (ADD/STACK 모드)
  const [withOpen, setWithOpen] = useState(false);
  const [withOpenMode, setWithOpenMode] = useState<"add" | "stack">("add");
  // UBPACS-Z: 워크리스트 페이지 탭(최대 10) + 검색 폴더 트리 (서버 로밍)
  const [tabs, setTabs] = useState<WorklistTab[]>([DEFAULT_TAB]);
  const [activeTabId, setActiveTabId] = useState(DEFAULT_TAB.id);
  const activeTabIdRef = useRef(activeTabId);   // openV2(라운드로빈 예외)에서 최신 활성 탭 참조
  activeTabIdRef.current = activeTabId;
  const [treeNodes, setTreeNodes] = useState<TreeNode[]>([]);
  const [selNodeId, setSelNodeId] = useState<string | null>(null);
  const insertRef = useRef<((t: string) => void) | null>(null);
  const phraseShortcutRef = useRef<Record<string, string>>({});  // Alt+키 → 상용구 본문
  // 레이아웃 크기 — 스플리터 드래그로 조절, 로그인 계정에 뷰어별 저장(로밍)
  const [sizes, setSizes] = useState<LayoutSizes>(DEFAULT_SIZES);
  const sizesRef = useRef(sizes);
  useEffect(() => { sizesRef.current = sizes; }, [sizes]);
  // SaintView/I-View 고정 배치 구역 높이 — 여기서 선언(뷰어별 persist 에서 sizes 와 함께 저장)
  const [infiSz, setInfiSz] = useState<InfiSizes>(DEFAULT_INFI_SIZES);
  const infiSzRef = useRef(infiSz);
  useEffect(() => { infiSzRef.current = infiSz; }, [infiSz]);
  // 원본 worklist.prefs + 현재 활성 뷰어 스킨 키 — 뷰어별 해석·병합 저장 라우팅
  const wlPrefsRef = useRef<Record<string, unknown>>({});
  const vkRef = useRef<ViewerKey>("ty");
  // ── 그리드 컬럼 순서(헤더 드래그)·폭(가장자리 드래그) 저장 — 계정별(worklist.prefs) ──
  const reorderColumns = useCallback((next: string[]) => {
    setColumns(next);
    const vk = vkRef.current;
    // 설정 ▲▼ 와 같은 키(by_viewer[vk])에 쓴다 — 다음 접속·설정 화면 모두 이 순서를 본다
    wlByViewerRef.current = { ...wlByViewerRef.current, [vk]: next };
    api.getSetting("worklist.prefs").then((r) =>
      api.putSetting("worklist.prefs",
        { ...r.value, by_viewer: { ...((r.value as { by_viewer?: object }).by_viewer ?? {}), [vk]: next } },
        "user")).catch(() => {});
  }, []);
  const resizeColumn = useCallback((c: string, px: number) => {
    setColW((prev) => {
      const next = { ...prev, [c]: Math.round(px) };
      // 드래그 중 매 픽셀 저장하지 않는다 — 600ms 디바운스로 마지막 값만 병합 저장
      if (colWSaveT.current) window.clearTimeout(colWSaveT.current);
      colWSaveT.current = window.setTimeout(() => {
        const vk = vkRef.current;
        api.getSetting("worklist.prefs").then((r) => {
          const cur = (r.value as { col_widths_by_viewer?: Record<string, Record<string, number>> })
            .col_widths_by_viewer ?? {};
          return api.putSetting("worklist.prefs",
            { ...r.value, col_widths_by_viewer: { ...cur, [vk]: next } }, "user");
        }).catch(() => {});
      }, 600);
      return next;
    });
  }, []);
  // 뷰어별 크기 저장 — ty=legacy layout_sizes / sv·infi=sizes_by_viewer[vk]{railW,prevH,priorH,repH}
  const persistViewerSizes = useCallback(() => {
    const vk = vkRef.current;
    api.getSetting("worklist.prefs").then((r) => {
      const v = { ...(r.value as Record<string, unknown>) };
      if (vk === "ty") {
        v.layout_sizes = sizesRef.current;
      } else {
        const prev = (v.sizes_by_viewer as Record<string, unknown>) ?? {};
        v.sizes_by_viewer = { ...prev, [vk]: { railW: sizesRef.current.railW, ...infiSzRef.current } };
      }
      wlPrefsRef.current = v;
      return api.putSetting("worklist.prefs", v, "user");
    }).catch(() => {});
  }, []);
  // 뷰어별 패널 표시/숨김 저장 — ty=legacy panels / sv·infi=panels_by_viewer[vk]
  const persistViewerPanels = useCallback((next: Record<string, boolean>) => {
    const vk = vkRef.current;
    api.getSetting("worklist.prefs").then((r) => {
      const v = { ...(r.value as Record<string, unknown>) };
      if (vk === "ty") {
        v.panels = next;
      } else {
        const prev = (v.panels_by_viewer as Record<string, unknown>) ?? {};
        v.panels_by_viewer = { ...prev, [vk]: next };
      }
      wlPrefsRef.current = v;
      return api.putSetting("worklist.prefs", v, "user");
    }).catch(() => {});
  }, []);
  // 하위호환 별칭 — 기존 railW·dH·eH 스플리터 호출부 유지(모두 뷰어별 저장으로 라우팅)
  const persistSizes = persistViewerSizes;
  // 뷰어별 패널+크기 동시 저장 — 접힘(숨김+크기 복원)처럼 두 키를 한 번의 read-modify-write 로 써 경합 방지
  const persistViewerLayout = useCallback((nextPanels: Record<string, boolean>) => {
    const vk = vkRef.current;
    api.getSetting("worklist.prefs").then((r) => {
      const v = { ...(r.value as Record<string, unknown>) };
      if (vk === "ty") {
        v.panels = nextPanels; v.layout_sizes = sizesRef.current;
      } else {
        v.panels_by_viewer = { ...((v.panels_by_viewer as Record<string, unknown>) ?? {}), [vk]: nextPanels };
        v.sizes_by_viewer = { ...((v.sizes_by_viewer as Record<string, unknown>) ?? {}),
                              [vk]: { railW: sizesRef.current.railW, ...infiSzRef.current } };
      }
      wlPrefsRef.current = v;
      return api.putSetting("worklist.prefs", v, "user");
    }).catch(() => {});
  }, []);
  // 패널 표시/숨김 토글 + 즉시 뷰어별 저장 (화면↔Setting 양방향 동기). 부수효과는 updater 밖에서 실행.
  const setPanelShown = useCallback((k: string, on: boolean) => {
    const next = { ...panelsOnRef.current, [k]: on };
    setPanelsOn(next);
    persistViewerPanels(next);
  }, [persistViewerPanels]);
  // SaintView/I-View 구역 높이 라이브 드래그 — ref 를 즉시 갱신해 후속 판정이 최신값을 보게 한다
  const setInfiLive = useCallback((patch: Partial<InfiSizes>) => {
    infiSzRef.current = { ...infiSzRef.current, ...patch };
    setInfiSz(infiSzRef.current);
  }, []);
  // 마지막으로 저장된 정상 높이 — 접힘 시 여기로 복원(오염된 min 값이 후속 저장에 새지 않게)
  const lastGoodInfi = useCallback((vk: "sv" | "infi", sizeKey: keyof InfiSizes): number => {
    const p = wlPrefsRef.current as { sizes_by_viewer?: Record<string, Partial<InfiSizes>>; infi_sizes?: Partial<InfiSizes> };
    return p.sizes_by_viewer?.[vk]?.[sizeKey] ?? p.infi_sizes?.[sizeKey] ?? DEFAULT_INFI_SIZES[sizeKey];
  }, []);
  const collapseAccumRef = useRef<Record<string, number>>({});   // min 을 지나 더 끌어당긴 누적량
  const gestureCollapsedRef = useRef(false);                      // 이 드래그에서 접혔는지(onEnd 중복 저장 방지)
  // 구역 접기 — 높이는 마지막 정상값으로 되돌린 뒤 숨김, 패널+크기를 한 번에 저장(재열기 시 정상 크기 복원)
  const hideInfiRegion = useCallback((region: string, sizeKey: keyof InfiSizes) => {
    const vk = vkRef.current === "sv" ? "sv" : "infi";
    setInfiLive({ [sizeKey]: lastGoodInfi(vk, sizeKey) } as Partial<InfiSizes>);
    const next = { ...panelsOnRef.current, [region]: false };
    setPanelsOn(next);
    persistViewerLayout(next);
  }, [setInfiLive, lastGoodInfi, persistViewerLayout]);
  // 스플리터 드래그: min 아래로 계속(누적 44px) 끌면 접힘, 아니면 min 에서 멈춤(=min 이 정상 크기로 도달 가능)
  const dragInfiRegion = useCallback((region: string, sizeKey: keyof InfiSizes, min: number, max: number, dy: number) => {
    const raw = infiSzRef.current[sizeKey] - dy;
    if (raw < min) {
      collapseAccumRef.current[region] = (collapseAccumRef.current[region] ?? 0) + (min - raw);
      if (collapseAccumRef.current[region] > 44) {
        collapseAccumRef.current[region] = 0;
        gestureCollapsedRef.current = true;
        hideInfiRegion(region, sizeKey);
        return;
      }
      setInfiLive({ [sizeKey]: min } as Partial<InfiSizes>);
    } else {
      collapseAccumRef.current[region] = 0;
      setInfiLive({ [sizeKey]: clampSz(raw, min, max) } as Partial<InfiSizes>);
    }
  }, [setInfiLive, hideInfiRegion]);
  // 스플리터 놓을 때: 접힘 제스처면 이미 저장됨(스킵), 아니면 크기 저장
  const endInfiRegion = useCallback((region: string) => {
    collapseAccumRef.current[region] = 0;
    if (gestureCollapsedRef.current) { gestureCollapsedRef.current = false; return; }
    persistViewerSizes();
  }, [persistViewerSizes]);
  // 스플리터 더블클릭 — 해당 영역 높이를 기본값으로 복원(계정 저장)
  const resetInfiRegion = useCallback((sizeKey: keyof InfiSizes) => {
    setInfiLive({ [sizeKey]: DEFAULT_INFI_SIZES[sizeKey] } as Partial<InfiSizes>);
    persistViewerSizes();
  }, [setInfiLive, persistViewerSizes]);
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
  // worklist.prefs 로드 → 원본 보관 + 컬럼/패널/크기 해석 트리거. 마운트 + 설정 저장 신호에서 재사용.
  const loadWlPrefs = useCallback(() => {
    api.getSetting("worklist.prefs").then((r) => {
      const v = r.value as {
        auto_refresh_sec?: number; refresh_mode?: string; default_status?: string; columns?: string[];
        find_fields?: string[]; dbl_action?: "viewer2d" | "ohif";
        by_viewer?: { sv?: string[] | null; ty?: string[] | null; infi?: string[] | null };
        panel_order?: { d?: string[]; e?: string[] };
      };
      // 원본 prefs 보관 — 뷰어별 해석/병합 저장의 기준값(panels_by_viewer/sizes_by_viewer 포함)
      wlPrefsRef.current = (r.value ?? {}) as Record<string, unknown>;
      // 구 설정 이관: refresh_mode 가 없으면 auto_refresh_sec 으로 유추한다.
      //   없음 → 수동(새 기본)  ·  0 → 수동('끔'이었던 것)  ·  >0 → 자동 그 초
      if (v.refresh_mode === "auto" || v.refresh_mode === "manual") {
        setRefreshMode(v.refresh_mode);
        if (v.auto_refresh_sec) setRefreshSec(v.auto_refresh_sec);
      } else if (v.auto_refresh_sec) {
        setRefreshMode("auto");
        setRefreshSec(v.auto_refresh_sec);
      } else {
        setRefreshMode("manual");
      }
      // default_status 는 **값이 달라졌을 때만** 주입한다(마지막으로 본 값과 비교).
      //   · 매번 주입: 사용자가 카운트칩('미판독' 등)으로 바꿔 둔 상태필터가, 아무것도 안 바꾼
      //     [저장] 한 번에 병원 기본값으로 되돌아갔다.
      //   · 최초 1회만: 반대로 설정에서 기본 상태 필터를 **실제로 고쳐** 저장해도 그 세션에서는
      //     필터바도 목록도 그대로여서, 새로고침해야 반영됐다(설정이 조용히 안 먹는 상태).
      // 그래서 래치를 '한 번이라도 읽었는가' 가 아니라 '마지막으로 본 값과 달라졌는가' 로 잡는다.
      // 주입은 커밋(setCommitted)까지 함께 해야 필터바 표시와 실제 목록이 어긋나지 않는다.
      // 최초 로드 시점은 prefsReady 게이트 전이라 이 커밋이 여분의 조회를 만들지 않는다.
      const ds = defaultStatusInjection(lastDefaultStatusRef.current, v.default_status);
      if (ds.inject) {
        lastDefaultStatusRef.current = ds.next;
        const nf = { ...filtersRef.current, status: ds.next };
        filtersRef.current = nf;
        setFilters(nf);
        setCommitted({ filters: nf, searchText: searchRef.current });
      }
      // 공통 컬럼(read_state 도입 전 저장분엔 판독 컬럼을 맨 앞에 가산 보정) + 뷰어별 오버라이드
      if (v.columns?.length) {
        const cols = v.columns.filter((c) => COLUMN_DEFS[c]);
        if (!cols.includes("read_state")) cols.unshift("read_state");
        wlColsBaseRef.current = cols;
      }
      wlByViewerRef.current = v.by_viewer ?? {};
      if (v.find_fields?.length) setFindFields(v.find_fields.filter((c) => FIND_FIELDS[c]));
      {  // 통합 검색창 설정 + 의뢰일시 표시 형식(계정 저장)
        const sb = (v as { search_box?: { mode?: string; fields?: string[]; op?: string } }).search_box;
        if (sb?.mode === "ai" || sb?.mode === "text") setSearchModeState(sb.mode);
        sbRef.current = {
          fields: (sb?.fields ?? DEFAULT_SEARCH_BOX.fields).filter((f) => SEARCH_SCOPE_FIELDS[f]),
          op: sb?.op === "or" ? "or" : "and",
        };
        setSbConfig(sbRef.current.fields, sbRef.current.op);
        const fmt = (v as { req_dt_fmt?: string }).req_dt_fmt;
        if (fmt) setReqDtFmt(fmt);
      }
      if (v.dbl_action) setDblAction(v.dbl_action);
      const po = v.panel_order;
      if (po?.d?.length === 3 && po?.e?.length === 4) setPanelOrder({ d: po.d, e: po.e });
      // 패널/크기는 뷰어별 해석 효과가 vk 확정 후 적용 — 여기서 tick 만 올려 트리거
      setWlBvTick((t) => t + 1);
    }).catch(() => {
      // prefs 를 못 읽어도 목록은 떠야 한다 — 기본값(=주입 없음)으로 진행하고 게이트만 finally 에서 푼다.
      // 래치는 건드리지 않는다: 다음 번 로드가 성공하면 그때 정상적으로 주입돼야 한다.
    }).finally(() => setPrefsReady(true));
  }, []);
  // 마지막으로 반영한 default_status. null = 아직 한 번도 못 읽음.
  // '한 번 주입했으니 끝' 이 아니라 '값이 바뀌면 다시 주입' 이어야 두 요구가 동시에 성립한다
  // (같은 값 저장 = 사용자 필터 보존 / 다른 값 저장 = 그 자리에서 반영).
  const lastDefaultStatusRef = useRef<string | null>(null);

  const filtersRef = useRef(filters);
  const searchRef = useRef(searchText);
  useEffect(() => { filtersRef.current = filters; searchRef.current = searchText; }, [filters, searchText]);

  /* ── 검색 커밋 — 목록이 바뀌는 **유일한** 경로 ─────────────────────────────────
     '상태 변경 + 커밋 + 재조회' 를 한 함수로 묶는다. 명시적 사용자 액션(SEARCH·카운트칩·폴더·
     기간 프리셋·탭 전환·바로가기·AI 적용·Import 완료·모달리티 칩)만 이걸 부른다. 단순 타이핑/
     셀렉트 변경은 입력 상태(setFilters/setSearchText)만 바꾸고 여기 오지 않는다.
     ⚠ setState 직후의 filtersRef 는 아직 옛 값이므로(반영은 다음 렌더), 넘겨받은 next 값을
       ref 에 **동기로** 먼저 써 넣는다 — 탭 전환처럼 setState 와 커밋이 같은 틱에 일어나는
       경로에서 옛 조건으로 조회되는 스냅샷 타이밍 버그를 막기 위해서다. */
  const applyAndSearch = useCallback((patch?: {
    filters?: Record<string, string> | ((f: Record<string, string>) => Record<string, string>);
    searchText?: string;
  }) => {
    const pf = patch?.filters;
    const nextF = typeof pf === "function" ? pf(filtersRef.current) : (pf ?? filtersRef.current);
    const nextQ = patch?.searchText ?? searchRef.current;
    filtersRef.current = nextF;
    searchRef.current = nextQ;
    setFilters(nextF);
    setSearchText(nextQ);
    setCommitted({ filters: nextF, searchText: nextQ });
    setPendingChange(false);        // 수동 모드 '변경 있음' 알림 띠는 커밋과 함께 내린다
    setRefreshKey((k) => k + 1);
  }, []);

  useEffect(() => {
    loadHangingPrefs();
    loadWlPrefs();
    loadTabs().then(setTabs).catch(() => {});
    loadTree().then(setTreeNodes).catch(() => {});
    // ETC 섹션의 3D 버튼(Viewer2D 내부) → 3D 뷰어 전환
    const h = (e: Event) => setViewer3dUid((e as CustomEvent).detail as string);
    window.addEventListener("sv-open-3d", h);
    // 설정 저장 시 화면 즉시 반영 — Settings 모달은 Worklist 위 오버레이라 언마운트되지 않으므로
    // 저장 신호를 받아 worklist.prefs 재로드(컬럼·패널·크기 재해석) + 뷰어 스킨 재해석.
    // ⚠ 여기서 refreshKey 는 올리지 않는다 — 설정 저장은 '보여주는 방식'만 바꾸는 행위지
    //   '어떤 행을 보여줄지'를 바꾸는 행위가 아니다. 예전에는 아무것도 안 바꾸고 [저장]만 눌러도
    //   목록이 통째로 재조회되며 사용자가 골라 둔 상태필터까지 되돌아갔다.
    //   컬럼/패널은 wlBvTick, 뷰어 스킨·report.prefs 는 settingsTick 경로로 반영된다.
    const onSettingsSaved = () => { loadWlPrefs(); setSettingsTick((t) => t + 1); };
    window.addEventListener("sv-settings-saved", onSettingsSaved);
    // 07 A.2 SearchShortcut 저장/적용
    const onSave = () => {
      const label = prompt(tr("바로가기 이름 (예: 오늘 CT 미판독)"));
      if (!label) return;
      const list = JSON.parse(localStorage.getItem("sv_shortcuts") ?? "[]")
        .filter((s: { label: string }) => s.label !== label);
      list.push({ label, filters: filtersRef.current, searchText: searchRef.current });
      localStorage.setItem("sv_shortcuts", JSON.stringify(list));
      alert(`'${label}' ${tr("저장됨")}`);
    };
    // 바로가기 적용은 '사용자가 이 조건으로 보겠다'는 명시적 액션 → 입력 상태 + 커밋을 함께
    const onApply = (e: Event) => {
      const sc = (e as CustomEvent).detail as { filters: Record<string, string>; searchText: string };
      applyAndSearch({ filters: sc.filters ?? {}, searchText: sc.searchText ?? "" });
    };
    window.addEventListener("sv-save-shortcut", onSave);
    window.addEventListener("sv-apply-shortcut", onApply);
    return () => {
      window.removeEventListener("sv-open-3d", h);
      window.removeEventListener("sv-settings-saved", onSettingsSaved);
      window.removeEventListener("sv-save-shortcut", onSave);
      window.removeEventListener("sv-apply-shortcut", onApply);
    };
  }, [loadWlPrefs, applyAndSearch]);
  // 입력했지만 아직 커밋되지 않은 조건이 있는가 — SEARCH 버튼/필터바에 표시만 한다(UX 안내).
  const queryDirty = useMemo(
    () => isQueryDirty(committed, filters, searchText), [committed, filters, searchText]);

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

  // ⚠ **커밋된** 질의로만 만든다. filters/searchText(입력 상태)를 여기에 물리면 타건마다
  //   목록·카운트 조회가 나가 '수동 갱신인데 목록이 저 혼자 변한다'로 되돌아간다.
  const queryParams = useMemo(() => buildWorklistQuery(committed), [committed]);

  useEffect(() => {
    // prefs(default_status) 확정 전에는 조회하지 않는다 — 로드 직후 목록이 두 번 바뀌는 것 방지
    if (!prefsReady) return;
    // SEARCH/새로고침으로 재조회가 시작되면 그리드를 짧게 깜빡여 '검색이 동작했음'을 보여준다(최초 로드는 제외).
    // 이 effect 자체가 이제 '커밋됐을 때만' 도는 자리이므로, 깜빡임도 자동으로 커밋 시점에만 난다.
    if (flashMountRef.current) setSearchFlash((t) => t + 1);
    else flashMountRef.current = true;
    if (localMode) {
      // LOCAL 모드 — 서버 worklist 호출 안 함. local.db 목록(q=검색어)만 표시 (미구현 서버=빈 목록)
      api.localStudies(committed.searchText.trim() || undefined)
        .then((r) => { setItems(r.items.map(localToRow)); setTotal(r.items.length); })
        .catch(() => { setItems([]); setTotal(0); });
      return;
    }
    if (liveMode) {
      // LIVE 모드 — 원격 A(webpacs_api) 워크리스트 실시간 조회(vid, 복사 없음).
      // 지원 필터만 매핑(q/pid/pname/modality/기간) — 나머지 필터는 라이브에선 무시.
      // 기획: "Live 도 같은 규칙을 따른다" → 여기도 committed 로만 조회한다.
      api.liveWorklist(toLiveParams(queryParams))
        .then((r) => {
          setItems(r.items);
          setTotal(r.total);
          setLiveErr("");
          // 사라진 행 id 정리 — 다중선택·anchor stale 방지(일반 경로와 동일)
          setSelectedIds((prev) => {
            if (!prev.size) return prev;
            const present = new Set(r.items.map((it) => it.id));
            const next = new Set([...prev].filter((id) => present.has(id)));
            return next.size === prev.size ? prev : next;
          });
          if (selAnchorRef.current != null && !r.items.some((it) => it.id === selAnchorRef.current)) {
            selAnchorRef.current = null;
          }
        })
        .catch((e) => {
          // 폴링 1회 실패는 목록을 비우지 않는다(직전 목록 유지 + 배지만) — 깜빡임 방지
          setLiveErr(e instanceof Error ? e.message : tr("원격 조회 실패"));
        });
      return;
    }
    api.worklist({ ...queryParams, qf: sbScopeParam(), qop: sbOpParam() }).then((r) => {
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
    // ⚠ 의존성에 filters/searchText(입력 상태)를 넣지 마라 — 넣는 순간 '타이핑 한 글자 = 재조회' 가
    //   되살아나 수동 갱신 계약이 깨진다. 조회는 committed(=SEARCH 로 확정된 조건) + refreshKey 로만.
  }, [queryParams, committed, refreshKey, localMode, liveMode, prefsReady]);

  // Search Filter 모달리티 분포 — 모달리티 필터가 꺼진 결과에서만 갱신(필터 중 카운트 유지).
  // 판정은 items 를 만들어 낸 **커밋된** 조건으로 한다(입력 상태로 보면 items 와 어긋난다).
  useEffect(() => {
    if (committed.filters.modality) return;
    const c: Record<string, number> = {};
    items.forEach((r) => { c[r.modality || ""] = (c[r.modality || ""] ?? 0) + 1; });
    setModCounts(c);
  }, [items, committed.filters.modality]);

  useEffect(() => {
    // 자동일 때만 주기 갱신. 수동이면 타이머를 아예 만들지 않는다.
    // ⚠ 예전에는 Live 를 min(sec||5, 5) 로 **강제**해 '끔' 으로 둬도 5초마다 목록이 바뀌었다.
    //   Live 야말로 판독 중 목록이 흔들리면 곤란한 모드라 강제를 없앴다.
    // 자동의 뜻은 '주기적으로 **같은 조건**을 다시 본다' 이지 '입력 중에 흔들린다' 가 아니다 —
    // 그래서 여기서도 refreshKey 만 올리고, 조회는 committed(확정된 조건)로 나간다.
    if (refreshMode !== "auto") return;
    const sec = Math.max(1, refreshSec || 10);
    const t = setInterval(() => setRefreshKey((k) => k + 1), sec * 1000);
    return () => clearInterval(t);
  }, [refreshMode, refreshSec]);

  // ⚡ LIVE — A SSE(`/see/stream`) 변경 감지. A 서버에 이미 있는 SSE 를 백엔드가 구독하고,
  // 여기서는 그 리비전(rev)만 가볍게 확인해 **바뀌었을 때만** 목록을 재조회한다.
  // (위 5초 폴링은 SSE 미연결·구버전 A 를 위한 폴백으로 그대로 둔다 — 이중 안전)
  const sseRevRef = useRef<number | null>(null);
  // 이미 무효화에 반영한 changed_studies 스냅샷(값 → 등장 횟수).
  // ⚠ 백엔드의 changed_studies 는 `(기존 + 신규)[-200:]` 로 **누적**되며 소비 후 비워지지 않는다.
  //   틱마다 통째로 넘기면 SSE rev 가 오를 때마다 누적 200건을 다시 폐기해 '지우고 다시 받기'
  //   폭주가 된다. 그래서 **새로 늘어난 것만** 넘긴다.
  //   같은 검사가 두 번 바뀌면 목록에 두 번 들어오므로 '봤는가'(Set)가 아니라 **횟수**로 비교한다
  //   — Set 으로 하면 두 번째 변경을 통째로 놓친다.
  const sseChangedRef = useRef<Map<number, number>>(new Map());
  // 모드를 effect 의존성에 넣으면 설정을 바꿀 때마다 SSE 구독이 끊겼다 붙는다 → ref 로 읽는다
  const refreshModeRef = useRef(refreshMode);
  useEffect(() => { refreshModeRef.current = refreshMode; }, [refreshMode]);
  useEffect(() => {
    if (!liveMode) { sseRevRef.current = null; return; }
    let stop = false;
    // 누적 목록에서 **이번에 새로 늘어난 것**만 골라 vid 로 올린다(규칙·근거는 worklistQuery 참조).
    const freshVids = (list: number[] | undefined): number[] => {
      const r = freshChangedVids(sseChangedRef.current, list, VID_BASE);
      sseChangedRef.current = r.next;
      return r.vids;
    };
    const tick = () => api.liveSseStatus().then((s) => {
      if (stop || !s.connected) return;                  // 미연결 → 폴링 폴백에 맡김
      // 첫 틱은 기준선만 잡는다 — 목록도 누적본이므로 여기서 스냅샷을 함께 떠 둬야
      // 다음 변경 때 '이미 있던 200건'이 통째로 새것으로 보이지 않는다.
      if (sseRevRef.current === null) { sseRevRef.current = s.rev; freshVids(s.changed_studies); return; }
      if (s.rev !== sseRevRef.current) {                  // 원격 변경 발생
        sseRevRef.current = s.rev;
        // ⚡ 다운로드 모드 무효화 — A 에서 픽셀이 교체된 검사의 로컬 저장본을 폐기한다.
        //   안 하면 캐시 히트가 **낡은 영상**을 계속 준다(백엔드 ETag 1시간과 같은 구멍을
        //   시간 제한 없이 늘리는 셈 — webpacs_live.py:607 주석). 무효화 함수의 프로덕션
        //   호출자는 여기 하나다(호출자 0 이었던 invalidate_tree 전례를 반복하지 않는다).
        // ★ ID 공간을 맞춰서 넘긴다: changed_studies 는 **A 원본 study_idx**(작은 정수)이고
        //   스케줄러 큐의 studyId 는 워크리스트 행 id = vid = VID_BASE + study_idx 다.
        //   그대로 넘기면 `ids.has(q.studyId)` 가 구조적으로 절대 참이 될 수 없어 무효화가
        //   영구 무동작이 된다(호출자는 있는데 조건이 안 맞는 형태로 invalidate_tree 전례 재현).
        const fresh = freshVids(s.changed_studies);
        if (fresh.length) void dlInvalidate(fresh);
        // 자동이면 즉시 반영, 수동이면 목록을 건드리지 않고 **알리기만** 한다
        // (수동의 뜻은 '내가 SEARCH 를 누를 때만 바뀐다' 이므로 여기서 바꾸면 약속을 깬다).
        if (refreshModeRef.current === "auto") setRefreshKey((k) => k + 1);
        else setPendingChange(true);
      }
    }).catch(() => { /* 상태 조회 실패는 무시 — 폴링이 커버 */ });
    tick();
    const t = window.setInterval(tick, 1200);
    return () => { stop = true; window.clearInterval(t); };
  }, [liveMode]);

  /* ── 다운로드 모드(설정>환경 '영상 취득') — 백그라운드 선다운로드 ──
   * 이번 회차 범위는 **Live 모드 + 2D 뷰어 2종**이다. 로컬 Orthanc 모드는 /dicom-web 이
   * 무인증이라 미결 보안과제(#30)와 얽히고, 3D 는 rendered <img> 경로를 쓰지 않아 접합점이
   * 다르다 — 둘 다 2회차로 미룬다. 그래서 여기서 liveMode 를 게이트로 건다. */
  useEffect(() => {
    let dead = false;
    // ★ 병원별 영상 전송 형식을 **먼저** 채운다(뷰어 2종이 하는 것과 같은 호출).
    //   스케줄러의 저장 URL·캐시 키가 이 값에서 나오므로, 안 채우고 시작하면 관리자가 무손실
    //   PNG 로 설정한 병원에서도 기본값(JPEG q90)으로 받아 버린다 — 관리자 정책이 조용히 무시된다.
    //   실패해도 다운로드는 진행한다(기본값 = 서버 기본과 같은 JPEG q90).
    const hid = Number(localStorage.getItem("sv_active_hospital") || 0);
    const fmtReady = hid
      ? api.hospImageFormat(hid).then(setImageFormat).catch(() => {})
      : Promise.resolve();
    void fmtReady.then(() => api.getSetting("viewer.prefs")).then((r) => {
      if (dead || !r) { if (!dead) setDlEnabled(false); return; }
      const p = readDlPrefs(r.value);
      const on = liveMode && p.mode === "download" && !dlSupportReason();
      setDlEnabled(on);   // 뷰어 생존 폴링 훅의 게이트 — 기준선이 없을 때도 돌아야 한다
      dlConfigure({
        enabled: on,
        limitGb: p.limitGb, concurrency: p.concurrency, scope: p.scope, recentN: p.recentN,
        // 용량 초과 정책 — **여기서 안 넘기면 스케줄러는 영영 기본값으로 돈다**(설정 UI 가
        // 있어도 아무 효과가 없다. 이 저장소가 두 번 겪은 '함수는 있는데 호출자가 없다' 형태).
        autoEvict: p.autoEvict, evictBy: p.evictBy,
        warnNearLimit: p.warnNearLimit, warnAtPct: p.warnAtPct,
      });
    }).catch(() => { if (!dead) setDlEnabled(false); });
    return () => { dead = true; };
    // settingsTick — 설정 저장('sv-settings-saved')의 기존 반영 경로. 이걸 안 걸면 모드를 바꿔도
    // 다음 SEARCH 전까지 아무 일도 일어나지 않아 '켰는데 안 받는다'로 보인다.
  }, [liveMode, settingsTick]);
  // 목록이 갱신될 때마다 큐 교체 — **정렬은 서버가 준 그대로** 쓴다(최신순 보장:
  // study_service.py:227 / webpacs_live.py:285). 프론트가 재정렬하면 두 곳이 순서를 정하게 된다.
  useEffect(() => {
    // **무조건 받지 않는다.** 조건이 있으면 그 결과가 대상이고(①), 없으면 첫 이미지를 연
    // 시각 이후만 받는다(②). 아직 아무것도 안 열었으면 큐가 비어 다운로더가 놀고 있는다.
    const d = decideDlScope({
      committed,
      autoStatus: lastDefaultStatusRef.current ?? "",
      openedAt: dlOpenedAt,
      rows: items.map((r) => ({ studyDate: r.study_date, studyTime: r.study_time })),
    });
    dlSetQueue(d.take.map((n) => items[n]).filter(Boolean).map((r) => ({
      studyId: r.id, studyUid: r.study_uid, patientKey: r.patient_key,
      studyDate: r.study_date, modality: r.modality,
      label: `${r.patient_name} · ${r.modality} · ${r.study_date}`,
    })));
  }, [items, committed, dlOpenedAt]);
  // 창을 닫거나 워크리스트를 떠나면 다운로더도 멈춘다(Web Lock 을 붙잡은 채 남지 않게)
  useEffect(() => () => dlStop(), []);
  // 뷰어 창이 **전부** 닫히면 판독 세션이 끝난 것 — 기준선을 풀고 백그라운드 다운로드도 멈춘다.
  // 그래야 다음에 여는 영상이 새 기준이 된다(요구: "새로운 영상을 열면 그 영상을 기준으로").
  // ⚠ 마지막 창이 닫혔을 때만 — 한 창만 닫아도 풀리면 판독 중에 기준선이 사라진다.
  // window.closed 폴링인 이유: 다른 창의 unload 를 신뢰성 있게 받을 방법이 없다(창이 죽으면
  // 이벤트도 같이 죽는다). openV2 안의 w.closed 정리는 **다음 검사를 열기 전까지** 돌지 않고,
  // postViewerCloseAll 은 'All Close 버튼 + close_scope≠current' 에서만 나가 브라우저 X·Ctrl+W·
  // 마지막 Exam 탭 닫기를 못 잡는다(대용 불가). 2초는 사용자가 체감하지 못하면서 A 를 때리지도
  // 않는 간격이다.
  // ⚠ 판정은 **에지 트리거**여야 한다(래치 seenLive). 레벨 트리거(alive===0 이면 해제)로 짜면
  //   (a) 아무것도 안 연 상태 (b) 워크리스트 F5 직후(창 핸들이 사라지고 교차 출처면 장부도 안 보인다)
  //   (c) 방금 해제한 직후 의 0 에서 매 폴마다 clearDlOpened→dlStop 이 불리고, 재개 훅(dlResume)과
  //   맞물려 stop/start 가 진동한다. 진리표는 lib/viewerSlots.decideBaselineRelease + 그 테스트 참조.
  //
  // ★ 이 훅은 **양쪽 에지**를 본다(하강=해제, 상승=재개). 한때 게이트가 `if (!dlOpenedAt) return`
  //   이라 기준선이 있을 때만 돌았고, 그래서 재개 경로가 openV2 **하나뿐**이었다. 그런데 sv_viewer
  //   창을 여는 곳은 openV2 만이 아니다 — 판독창(ReportWindow)의 ◀▶ 넘기기(:351)와 과거검사
  //   Compare(:114)는 다른 창의 다른 문서라 markDlOpened 를 부를 수 없다. 결과:
  //     뷰어 ✕(→dlStop) → 판독창 ◀▶ 로 다음 검사 오픈 → 뷰어는 멀쩡히 떠 있는데 다운로드는
  //     그 세션 내내 죽은 채(워크리스트에서 다시 더블클릭하기 전까지 복구 불가).
  //   오픈 '경로'를 하나씩 배선하는 대신 '뷰어가 살아 있는가' 라는 **상태**로 판정한다
  //   (lib/viewerSlots.decideBaselineArm). 그래서 게이트는 dlEnabled 다.
  // ★ 이 상태 판정은 워크리스트 탭이 2개인 배치도 함께 닫는다. 기준선(sv_dl_opened_at)은
  //   sessionStorage=탭별이고 dlStop 은 모듈 변수=문서별인데, 슬롯 장부(liveViewerSlots)는
  //   **localStorage=오리진 공유**다. 그래서 탭 B 에서 연 뷰어를 탭 A 도 관측해 같이 세우고
  //   같이 재개한다(예전에는 탭 A 가 게이트에 걸려 아무 신호도 못 받고 계속 받았다).
  //   ⚠ 교차 출처(VITE_VIEWER_BASE) 배치에서는 장부가 안 보이지만, 그 배치는 dlSupportReason()
  //     이 다운로드 기능 자체를 끄므로(opfsStore.ts) dlEnabled=false 라 이 훅이 아예 안 돈다.
  const dlSeenLiveRef = useRef(false);
  useEffect(() => {
    if (!dlOpenedAt && !dlEnabled) return;     // 기준선도 없고 다운로드 모드도 꺼짐 = 관측할 것 없음
    const scan = () => {
      for (const [nm, w] of [...openedViewerWindows]) {
        if (w.closed) { openedViewerWindows.delete(nm); forgetViewerSlot(nm); }
      }
      // ⚠ 이 Map 의 크기만으로 '전부 닫혔다'를 판정하면 안 된다 — 창이 살아 있어도 0 일 수 있다
      //   (교차 출처 배치·다른 경로로 열린 창). 라운드로빈이 이미 그 함정에 빠졌던 자리라
      //   같은 판정을 쓴다: 하트비트 장부(liveViewerSlots) + 이 Map 의 !closed 를 합친다.
      //   반대 방향도 있다 — Chrome 이 완전히 가려진 창을 동결하면 장부가 만료돼 '전부 닫힘'으로
      //   오판한다. 창 핸들의 !closed 는 스로틀·동결과 무관하므로 반드시 합집합에 넣는다.
      const alive = new Set<string>(liveViewerSlots().keys());
      for (const [nm, ow] of openedViewerWindows) { if (!ow.closed) alive.add(nm); }
      const d = decideBaselineRelease(dlSeenLiveRef.current, alive);
      dlSeenLiveRef.current = d.seenLive;
      if (d.release) { clearDlOpened(); return; }
      // 상승 에지 — 뷰어가 살아 있는데 기준선이 없다(판독창 ◀▶·Compare·다른 탭에서 연 경우).
      // markDlOpened 는 '세션 첫 1회만 기록' + dlResume 멱등이라 중복 호출이 무해하다.
      if (dlEnabled && decideBaselineArm(!!dlOpenedAt, alive).arm) markDlOpened();
    };
    scan();
    // 기준선이 있을 때(=판독 중)는 닫힘 반응성이 중요하므로 2초, 없을 때는 재개만 기다리는
    // 상태라 5초로 낮춘다. 어차피 아래 두 방송이 폴을 앞당긴다.
    const t = window.setInterval(scan, dlOpenedAt ? 2000 : 5000);
    window.addEventListener("focus", scan);    // 워크리스트로 돌아온 순간 = 뷰어를 닫았을 확률이 높다
    // 두 방송은 **저지연 트리거**로만 쓴다 — 판정은 위 scan 이 장부를 다시 읽어 한다.
    //  · CloseAll: 발신 창이 아직 닫히기 전에 뿌리므로 곧바로 해제하면 살아 있는 창이 남은 순간에
    //    기준선이 풀린다. 폴 한 번을 앞당길 뿐이다.
    //  · ViewerOpened: 뷰어 문서가 뜰 때마다 나간다(판독창 ◀▶ 포함) — 재개를 5초 기다리지 않는다.
    let fast = 0;
    const soon = (ms: number) => { window.clearTimeout(fast); fast = window.setTimeout(scan, ms); };
    const offClose = onViewerCloseAll(() => soon(500));
    const offOpen = onViewerOpened(() => soon(200));
    return () => {
      window.clearInterval(t); window.clearTimeout(fast);
      window.removeEventListener("focus", scan); offClose(); offOpen();
    };
  }, [dlOpenedAt, dlEnabled, clearDlOpened, markDlOpened]);

  // 판독 창 항상 열기(설정>판독) — 워크리스트 옆 별도 웹창(?report=1), 선택 동기(sync) 연동
  const readingWinRef = useRef<Window | null>(null);
  const alwaysReadingRef = useRef(false);
  useEffect(() => {
    api.getSetting("report.prefs").then((r) => {
      alwaysReadingRef.current = !!(r.value as { always_report_window?: boolean }).always_report_window;
    }).catch(() => {});
    // 설정에서 바뀌는 값이므로 마운트 + 설정 저장(settingsTick)에서만 다시 읽는다.
    // 예전엔 refreshKey 였는데, 그건 '목록 재조회' 신호라 검색할 때마다 불필요하게 재조회됐다.
  }, [settingsTick]);
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
    setFocusId(row.id);                 // 하이라이트는 즉시 — 상세(api.study)를 기다리지 않는다
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
      setFocusId(id);
      selAnchorRef.current = id;
    });
    return off;
  }, []);
  const onChanged = useCallback(() => {
    setRefreshKey((k) => k + 1);
    if (selected) api.study(selected.id).then(setSelected);
  }, [selected]);

  // SEARCH — 수동 모드에서 **조회 조건이 바뀌는** 유일한 경로. 대기 중 알림도 여기서 내린다.
  // 지금 입력돼 있는 filters/searchText 를 그대로 커밋해 조회한다(= 눌러야 적용).
  const runSearch = useCallback(() => { applyAndSearch(); }, [applyAndSearch]);

  /* ── 새로고침 — '같은 조건을 다시 본다'. SEARCH 와 뜻이 다르다 ────────────────────
     ⚠ 세 스킨(SaintView ⟳ · Live 수동모드 배너 [지금 갱신] · I-View/T-View 🔄)이 모두 이걸 쓴다.
       한때 SaintView ⟳ 와 [지금 갱신] 만 applyAndSearch(=커밋) 로 바뀌어 있어서, 같은 '새로고침'
       이름의 버튼이 스킨마다 다르게 동작했다 — ⟳ 를 눌렀는데 아직 SEARCH 하지 않은 필터바 입력까지
       함께 적용돼 결과 집합이 바뀌었다(= '내가 SEARCH 를 누를 때만 목록이 바뀐다' 계약 위반).
       새로고침은 **커밋된 조건 그대로** 재조회하고, 미커밋 입력은 dirty 표시로 남겨 둔다.
       pendingChange(원격 변경 알림)는 어느 경로로 갱신하든 내려야 하므로 여기 포함한다. */
  const reloadList = useCallback(() => {
    setPendingChange(false);
    setRefreshKey((k) => k + 1);
  }, []);

  const openStudy = useCallback((row: StudyRow | StudyDetail) => {
    dlPromote(row.study_uid);   // 여는 검사를 선다운로드 큐 맨 앞으로 + 잠시 감속(A 부하 양보)
    // ⚠ 여기서는 markDlOpened() 를 **일부러 부르지 않는다**(확정). 이 경로는 OHIF(외부 뷰어)를
    //   window.open(..., "_blank") 로 여는 것이라 뷰어 슬롯 이름을 갖지 않는다 → 아래 폴링 훅이
    //   '살아 있는 창'으로 셀 수 없다. 기준선만 찍히고 영영 안 풀리는 상태가 된다.
    //   다운로드 모드 범위는 이번 회차 확정대로 **Live + 2D 뷰어 2종(openV2)** 뿐이다.
    openViewer(row.study_uid, hpFor(row.modality));
  }, []);



  // 자체 뷰어 오픈 — 새 창(별도 웹페이지, ?viewer=2d)으로 연다. lastViewerRef = UBPACS "기존 영상"
  // ⚠ 기준선은 **영상을 실제로 여는 곳**에서 찍어야 한다. 행 선택·상세 조회로 찍으면
  //   목록을 훑기만 해도 기준선이 생겨 '첫 이미지를 연 이후' 라는 규칙이 무너진다.
  const openV2 = useCallback((cfg: {
    detail: StudyDetail; addDetail?: StudyDetail; stackDetail?: StudyDetail; keySops?: string[];
    withOpen?: { mode: "add" | "stack"; ids: number[] };
    cmp?: boolean;  // ⇄ Compare 진입 — 뷰어 로드 후 Compare 모달 자동 오픈
    forceRoundRobin?: boolean;  // 다중선택 일괄 오픈 — 탭→모니터 예외 무시, 순수 1,2,3 순환
  }) => {
    markDlOpened();                    // 다운로드 모드 기준선(첫 1회만 기록)
    lastViewerRef.current = cfg.addDetail ?? cfg.stackDetail ?? cfg.detail;
    // 여는 검사를 선다운로드 큐 맨 앞으로 승격 + 잠시 감속 — '지금 보는 검사'가 최우선이고,
    // 동시에 A 를 때리는 총량을 줄인다(백엔드가 이미 오픈마다 8워커 프리페치를 돌린다).
    dlPromote(cfg.detail.study_uid);
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
    return viewerMonitorPlan().then(async ({ slots, tabMonMap, tabBinding }) => {
      // 닫힌 창은 추적 맵에서 정리 + **슬롯 장부에서도 즉시 지운다**. 브라우저 X·Ctrl+W·크래시로
      // 닫히면 releaseViewerSlot() 이 못 돌 수 있는데, 우리가 든 핸들의 w.closed 는 그 사실을 바로
      // 알려 준다(TTL 만료를 기다릴 필요 없다). 장부에 남겨 두면 "그 모니터에 창이 살아 있다"로
      // 오판해 ①부트스트랩(전 모니터 오픈)을 건너뛰고 라운드로빈이 빈 모니터를 향한다.
      for (const [nm, w] of [...openedViewerWindows]) {
        if (w.closed) { openedViewerWindows.delete(nm); forgetViewerSlot(nm); }
      }
      // 탭→모니터 배치 예외 대상 선계산 — mm 판정(창 다수 가능성)에 포함시키기 위해 urlFor 보다 먼저.
      const activeTab = activeTabIdRef.current;
      const navTabOn = Object.values(tabBinding).some((v) => !!v);
      const ovMon = (cfg.forceRoundRobin || navTabOn) ? undefined
        : tabMonMap.find((r) => r.tab && r.tab === activeTab)?.monitor;
      // 다중 모니터 관리 배치(mm=1) — 라운드로빈/탭배치로 창이 여럿일 수 있을 때, 새로 열린 창도 공유
      // Exam 레지스트리 전체를 탭으로 복원하게 한다(In-View 는 환자 혼합 방지 필터를 건너뜀 — 모든 모니터
      // 동일 탭 목록, 각 창의 활성 검사만 다름). 탭배치 예외(ovMon)는 단일 감지여도 별도 창을 만들므로 포함.
      // 단일 모니터(mm=0 명시)는 기존 규칙 유지 — 재사용 창을 mm 에서 강등(sessionStorage 해제).
      const mmFlag = (slots.length > 1 && slots[0].index >= 0) || ovMon != null;
      // 모니터별 ◀▶ 탐색 탭(navtab)을 URL 에 실어 뷰어가 그 탭 필터 목록으로 이동하게 한다.
      const urlFor = (monitorIndex: number) => {
        const tab = tabBinding[monitorIndex];
        const mm = mmFlag ? "&mm=1" : "&mm=0";
        return tab ? `${base}?${p}${mm}&navtab=${encodeURIComponent(tab)}` : `${base}?${p}${mm}`;
      };
      // mm 배치 — 공유 Exam 레지스트리에 이 검사를 '창을 열기 전에' 워크리스트가 직접 선등록한다.
      // 다중선택 일괄 오픈처럼 여러 창이 동시에 마운트되며 각자 read-modify-write 하면 항목이 유실되는
      // 경합을 워크리스트(단일 기록자)의 순차 기록으로 제거. 뷰어 init 의 push 는 멱등이라 무해.
      // (VIEWER_BASE 로 뷰어가 타 출처면 이 기록은 뷰어에 안 보이지만 무해 — 뷰어 자체 push 로 동작)
      if (mmFlag) {
        try {
          const ids: number[] = JSON.parse(localStorage.getItem("sv_infi_exams") ?? "[]");
          if (!ids.includes(d0.id)) localStorage.setItem("sv_infi_exams", JSON.stringify([...ids, d0.id]));
        } catch { /* 무시 */ }
        try {
          const tabs: { id: number; uid: string; label: string }[] = JSON.parse(localStorage.getItem("sv_viewer_tabs") ?? "[]");
          if (!tabs.some((t) => t.id === d0.id)) {
            localStorage.setItem("sv_viewer_tabs", JSON.stringify([...tabs, { id: d0.id, uid: d0.study_uid, label: tabLabel }]));
          }
        } catch { /* 무시 */ }
      }
      // 최저번호 모니터=표준 "sv_viewer"(판독창 참조·재사용), 나머지=sv_viewer_slot{index} (모니터 정체성 기준 고정)
      // ⚠ 규약 본체는 lib/viewerSlots.ts 한 곳 — screens.ts 의 openSlaveWindow 도 같은 함수를 쓴다.
      //   예전엔 두 곳에 따로 하드코딩돼 있어 한쪽만 바꾸면 같은 모니터에 창이 두 개 생겼다.
      const nameFor = (monitorIndex: number) => viewerSlotName(monitorIndex, slots[0]?.index);

      // ── 워크리스트 탭 → 모니터 배치 예외 (최우선) ──
      // 검사를 연 순간의 활성 워크리스트 탭에 지정 모니터가 있으면, 뷰어 모니터 선택·멀티 여부와
      // 무관하게 그 모니터에 직접 연다. (다중선택 일괄 오픈은 forceRoundRobin 으로 제외 — ovMon 은 위에서 선계산)
      // 상호 배타: 모니터별 ◀▶ 탐색 탭(tab_binding)이 하나라도 설정돼 있으면 이 배치 예외는 무시(설정 UI도 비활성).
      if (ovMon != null) {
        const feat = await screenFeatures([ovMon], "width=1500,height=920");   // 지정 모니터 실좌표(감지 가능 시)
        const name = nameFor(ovMon);
        // 다른 열린 뷰어 창은 탭만 추가(리로드 없음). 대상 창(name)은 아래에서 URL 로 통째로 로드되므로 제외.
        postViewerAddTab(d0.id, d0.study_uid, tabLabel, name);
        const w = window.open(urlFor(ovMon), name, feat);
        applyWindowBounds(w, feat);
        if (w) { openedViewerWindows.set(name, w); noteViewerSlot(name, d0.id); w.focus(); }
        else showToast(tr("팝업이 차단되어 뷰어 창을 열지 못했습니다 — 주소창 팝업 아이콘에서 이 사이트를 '항상 허용'으로 설정하세요"), "error");
        return;
      }

      // 진짜 다중 모니터(감지 슬롯 2개+). ovMon 케이스는 위에서 return — 여기선 mmFlag=슬롯 판정과 동일.
      const multi = mmFlag;
      if (!multi) {
        // 단일/미감지: 재사용 창 "sv_viewer" 1개. 다중→단일 전환 시 이전 보조 창은 고아이므로 닫는다.
        for (const [nm, ow] of [...openedViewerWindows]) {
          if (nm !== "sv_viewer") {
            try { ow.close(); } catch { /* 이미 닫힘 */ }
            openedViewerWindows.delete(nm);
            forgetViewerSlot(nm);
          }
        }
        const feat = slots[0]?.features ?? "width=1500,height=920";
        const w = window.open(urlFor(slots[0]?.index ?? -1), "sv_viewer", feat);
        applyWindowBounds(w, feat);
        if (w) { openedViewerWindows.set("sv_viewer", w); noteViewerSlot("sv_viewer", d0.id); }
        w?.focus();
        return;
      }
      // ── 다중 모니터 오픈 규칙 (사용자 확정 규칙 — 되돌리면 회귀다) ───────────────────────────
      //  ① 사이클 시작(살아 있는 뷰어 창 0개)인 **첫 오픈** = 선택된 전 모니터에 창을 열고 모두 같은 검사.
      //     → 판독을 시작하는 순간 2·3번 모니터가 빈 화면으로 남지 않는다. (커밋 109c2cb 의 forEach 동작)
      //  ② 두 번째 오픈부터 = 모니터 번호순으로 **대상 창 하나만** 리로드, 나머지는 Exam 탭만 추가.
      //     (커밋 6da23e0 의 라운드로빈. 이 커밋이 ①의 부트스트랩을 지우면서 회귀가 났다.)
      //  부트스트랩 직후 순번을 slots[1] 로 두는 것이 규칙의 핵심 — 0 으로 두면 두 번째 검사가 1번
      //  모니터를 덮어써 "첫 영상이 사라진다".
      //
      //  규칙 본체는 lib/viewerSlots 의 planViewerOpen/openByPlan **한 곳**에 있다 — 여기(openV2)에
      //  인라인으로 두었을 때는 회귀 테스트가 그 결정부의 사본을 검증해서, 분기를 죽여도 전부 초록이었다.
      //  여기서는 '살아 있는 창 목록'만 만들어 넘기고, 결과대로 window.open 만 한다.
      const validNames = new Set(slots.map((s) => nameFor(s.index)));
      // 현재 선택 슬롯 집합에 없는 이전 보조 창(모니터 설정 축소 등)은 **사이클 시작 판정 전에** 닫는다.
      // 장부에도 남겨 두면 "창이 살아 있다"로 잘못 세어 첫 오픈 부트스트랩이 건너뛰어진다.
      // (이미 닫힌 창은 이 콜백 첫머리에서 맵·장부 양쪽에서 정리됐다.)
      for (const [nm, ow] of [...openedViewerWindows]) {
        if (!validNames.has(nm)) {
          try { ow.close(); } catch { /* 이미 닫힘 */ }
          openedViewerWindows.delete(nm);
          forgetViewerSlot(nm);
        }
      }
      // 생존 판정 = 슬롯 장부 ∪ 살아 있는 창 핸들. 핸들을 합치는 이유 둘:
      //  · VIEWER_BASE(뷰어를 다른 오리진으로) 배치에서는 뷰어의 하트비트가 **이 오리진 장부에 안 보인다**.
      //    핸들의 !w.closed 는 교차 출처에서도 읽히므로 그 배치에서 순번이 도는 유일한 근거다.
      //  · 같은 오리진이어도 뷰어 창이 오래 가려져 있으면(Chrome intensive throttling) 하트비트가
      //    늦어질 수 있다. 워크리스트가 이미 들고 있는 직접 신호를 안 쓸 이유가 없다.
      const liveHere = new Set<string>(liveViewerSlots().keys());
      for (const [nm, ow] of openedViewerWindows) { if (!ow.closed) liveHere.add(nm); }
      const plan = planViewerOpen(slots, liveHere, readViewerRoundRobin());
      // ② 라운드로빈이면 — 이미 열린 **다른** 뷰어 창들에 탭만 추가(리로드 없음). 대상 창은 곧 URL 로
      //    통째로 로드되므로 수신자에서 제외한다(안 그러면 곧 버려질 문서가 study+seriesTree 를 왕복하고
      //    sv_infi_exams 를 다시 써서 위 '단일 기록자' 선등록이 무의미해진다).
      //    ① 부트스트랩이면 다른 뷰어 창이 없으므로 브로드캐스트 자체가 불필요하다.
      if (plan.mode === "roundrobin") postViewerAddTab(d0.id, d0.study_uid, tabLabel, plan.targets[0].name);
      // window.open 은 사용자 클릭 활성화 안에서 **동기**로 호출돼야 한다(모니터 감지 await 은 이미 끝났다).
      let firstW: Window | null = null;
      const opened = openByPlan(plan, d0.id, (t) => {
        const w0 = window.open(urlFor(t.index), t.name, t.features);
        applyWindowBounds(w0, t.features);
        if (!w0) return false;
        openedViewerWindows.set(t.name, w0);
        if (!firstW) firstW = w0;
        return true;
      });
      (firstW as Window | null)?.focus();
      if (opened < plan.targets.length) {
        // 109c2cb 에 있다가 6da23e0 에서 사라진 안내 — 부트스트랩은 창을 여러 개 여는 유일한 지점이라
        // Chrome 팝업 차단이 첫 창 외 전부를 막는다. 안내가 없으면 "2·3번이 안 뜬다"는 민원이 된다.
        showToast(
          plan.mode === "bootstrap"
            ? `${tr("팝업 차단으로")} ${opened}/${plan.targets.length} ${tr("모니터에만 열렸습니다 — 주소창의 팝업 아이콘에서 이 사이트를 '항상 허용'으로 설정한 뒤 다시 여세요")}`
            : tr("팝업이 차단되어 뷰어 창을 열지 못했습니다 — 주소창의 팝업 아이콘에서 이 사이트를 '항상 허용'으로 설정하세요"),
          "error",
        );
      }
    });
  }, []);

  // 과거검사 열기 — related_exams 는 요약(id/uid/일자/모달리티/검사명)만 담고 있어 상세를 한 번 받는다.
  // 그래야 워크리스트에서 여는 것과 **완전히 같은 경로**(openV2)를 타서 탭 누적·모니터 배치가 일치한다.
  // LOCAL 모드는 서버 상세가 없으므로 막는다(로컬 id 로 서버를 부르면 엉뚱한 검사가 열린다).
  const openPrior = useCallback((id: number) => {
    if (localMode) { alert(tr("LOCAL 모드에서는 과거검사를 열 수 없습니다")); return; }
    void api.study(id)
      .then((d) => openV2({ detail: d }))
      .catch((e) => alert(`${tr("검사를 열 수 없습니다:")} ${e instanceof Error ? e.message : String(e)}`));
  }, [openV2, localMode]);

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
    if (localMode && a !== "refresh") { alert(tr(LOCAL_DENIED_TIP)); return; }
    // LIVE 모드 — 원격 미지원 기능만 차단(열람·판독·비교는 원격 왕복으로 정상 동작)
    if (liveMode && !LIVE_OK_ACTIONS.has(a)) { alert(tr(LIVE_DENIED_TIP)); return; }
    const target = row ?? selected;
    switch (a) {
      // I-View/T-View 의 🔄 새로고침 — SaintView ⟳ / Live 배너와 같은 reloadList 를 쓴다(스킨별 의미 통일)
      case "refresh": reloadList(); break;
      case "batch": setBatchOpen(true); break;
      case "viewdraft":
        // 다중 선택(Shift/Ctrl) + View 버튼 → 선택 검사를 워크리스트 순서대로 한꺼번에 오픈.
        // 각 openV2 는 라운드로빈으로 다음 모니터에 분산(await 로 순차 → 1,2,3 순서 보장).
        // row(더블클릭)로 온 경우는 단일 오픈(아래) — 다중 오픈은 View 버튼/Enter(row 없음)에서만.
        if (!row && selectedIds.size > 1) {
          resetViewerRoundRobin();   // 선택 목록 위→아래 순서대로 모니터 1,2,3 부터 열리게
          const chosen = items.filter((it) => selectedIds.has(it.id));
          let first = true;
          for (const it of chosen) {
            try {
              const d = await api.study(it.id);
              if (first) { selectAndSync(d); first = false; }
              await openV2({ detail: d, forceRoundRobin: true });
            } catch { /* 개별 실패는 건너뛰고 나머지 오픈 */ }
          }
          break;
        }
        // View&Draft = 자체 뷰어(기본) — 더블클릭 동작은 환경설정에서 변경 가능
        // Study With Open(p.13): 체크 시 Related Study List 검사를 ADD/STACK 모드로 함께 오픈
        if (target) {
          // ★ 창은 **클릭 제스처 안에서 즉시** 연다 — 실제 사고(sv70/Live): api.study 가 A 왕복으로
          //   수 초 걸리는 동안 아무 일도 없다가 "몇 초 뒤 갑자기 열리는" 증상 + 제스처 밖
          //   window.open 이라 팝업 차단까지 걸렸다. 워크리스트 행(StudyRow)에는 openV2 가 쓰는
          //   필드(id·study_uid·modality·환자·검사명)가 전부 있다 — 상세는 뷰어 창이 스스로 받는다.
          //   With Open 만 related_exams 가 필요해 상세를 먼저 받는다(명시적 다중 오픈 — 지연 수용).
          if (dblAction === "ohif" && ohifOnRef.current) {
            openStudy(target);
            void api.study(target.id).then(selectAndSync).catch(() => {});
          } else if (withOpen) {
            const d = await api.study(target.id);
            selectAndSync(d);
            // With Open 체크 = 명시적 다중 오픈 — 다른 환자라도 기존 검사에 ADD/STACK 으로 누적.
            // 과거검사(최대 3건)도 함께. related 가 없어도 withOpen 신호를 보내 누적 유지
            openV2({ detail: d, withOpen: { mode: withOpenMode, ids: d.related_exams.slice(0, 3).map((e) => e.id) } });
          } else {
            openV2({ detail: target as StudyDetail });
            void api.study(target.id).then(selectAndSync).catch(() => {});
          }
        }
        break;
      case "viewer2d": case "ub_view":
        // 다중 선택(Shift/Ctrl) + View → 선택 검사를 워크리스트 순서대로 한꺼번에(라운드로빈 분산)
        if (!row && selectedIds.size > 1) {
          resetViewerRoundRobin();   // 선택 목록 위→아래 순서대로 모니터 1,2,3 부터 열리게
          localStorage.setItem("sv_infi_exams", "[]");
          const chosen = items.filter((it) => selectedIds.has(it.id));
          let first = true;
          for (const it of chosen) {
            try {
              const d = await api.study(it.id);
              if (first) { selectAndSync(d); first = false; }
              await openV2({ detail: d, forceRoundRobin: true });
            } catch { /* 개별 실패는 건너뛰고 나머지 오픈 */ }
          }
          break;
        }
        // ① View: 기존 영상을 닫고 선택 검사를 그 자리에 표시 — In Viewer 누적 목록 초기화(교체 시맨틱)
        if (target) {
          // ★ 창은 클릭 제스처 안에서 즉시(viewdraft 와 동일 — Live A 왕복 지연·팝업 차단 방지)
          localStorage.setItem("sv_infi_exams", "[]");
          openV2({ detail: target as StudyDetail });
          void api.study(target.id).then(selectAndSync).catch(() => {});
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
        if (!ohifOnRef.current) { alert(tr("OHIF는 설정 > 뷰어 > OHIF에서 활성화할 수 있습니다")); break; }
        if (target) openStudy(target);
        break;
      case "ub_key": {
        // ⑤ Key Image View: 키 이미지만 표시 (F-16)
        if (!target) break;
        const d = await api.study(target.id);
        selectAndSync(d);
        const inst = await api.instances(target.id);
        if (!inst.key_images.length) {
          alert(tr("이 검사에 선택된 키 이미지가 없습니다.\nREPORT 패널의 KEY IMG에서 먼저 선택·저장하세요."));
          break;
        }
        openV2({ detail: d, keySops: inst.key_images.map((k) => k.sop_uid) });
        break;
      }
      case "viewer": if (target) openStudy(target); break;
      case "3d":
        if (target) {
          // Live 검사 — 3D 가 UID→vid 역참조로 시리즈 트리를 찾도록 등록(뷰어를 안 거친 직행 경로)
          if (isLiveId(target.id)) registerLiveStudyVid(target.study_uid, target.id);
          setViewer3dUid(target.study_uid);
        }
        break;
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
            alert(`${tr("과거 확정 판독")}(${rel.study_date})${tr("을 Conclusion에 복사했습니다.")}`);
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
          `${tr("[1/2] 검사 삭제 —")} ${target.patient_name} · ${target.modality} · ${target.study_date}\n` +
          tr("영상·판독이 함께 삭제되며 되돌릴 수 없습니다. 진행할까요?"))) break;
        if (!window.confirm(tr("[2/2] 최종 확인 — 영구 삭제됩니다. 정말 삭제할까요?"))) break;
        try {
          await api.studyAdminAction(target.id, { action: "delete" });
          if (selected?.id === target.id) setSelected(null);
          setRefreshKey((k) => k + 1);
        } catch (e) { alert(e instanceof Error ? e.message : tr("삭제 실패")); }
        break;
      case "adm_move": case "adm_copy": {
        if (!target) break;
        const isMove = a === "adm_move";
        const verb = isMove ? "이동(재귀속)" : "복제";
        const raw = prompt(isMove
          ? tr("검사를 이동(재귀속)할 대상 병원 ID(숫자)를 입력하세요")
          : tr("복제 대상 병원 ID(숫자) — 비우면 같은 병원에 사본을 만듭니다"));
        if (raw === null) break;              // 취소
        const hid = raw.trim();
        if (isMove && !hid) break;            // 이동은 대상 필수
        if (hid && !/^\d+$/.test(hid)) { alert(tr("병원 ID는 숫자여야 합니다")); break; }
        try {
          await api.studyAdminAction(target.id, {
            action: isMove ? "move" : "copy",
            ...(hid ? { target_hid: Number(hid) } : {}),
          });
          // 이동 시 검사가 현재 병원 스코프에서 빠질 수 있어 선택 해제 후 목록 갱신
          if (a === "adm_move" && selected?.id === target.id) setSelected(null);
          setRefreshKey((k) => k + 1);
          alert(`${tr("검사")} ${tr(verb)} ${tr("완료")}`);
        } catch (e) { alert(e instanceof Error ? e.message : `${tr(verb)} ${tr("실패")}`); }
        break;
      }
      case "adm_match": {
        if (!target) break;
        const oid = prompt(tr("매칭할 오더 ID를 입력하세요 (오더/예약 패널의 오더)"))?.trim();
        if (!oid) break;
        try {
          await api.studyAdminAction(target.id, { action: "match", order_id: oid });
          onChanged();
          alert(tr("오더 매칭 완료"));
        } catch (e) { alert(e instanceof Error ? e.message : tr("매칭 실패")); }
        break;
      }
      case "adm_unmatch":
        if (!target) break;
        if (!window.confirm(tr("이 검사의 오더 매칭을 해제(언매칭)할까요?"))) break;
        try {
          await api.studyAdminAction(target.id, { action: "unmatch" });
          onChanged();
        } catch (e) { alert(e instanceof Error ? e.message : tr("언매칭 실패")); }
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, onSelect, openStudy, onChanged, dblAction, withOpen, withOpenMode, openV2, localMode, liveMode, items, selectedIds, reloadList]);

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
      `${tr("현재 검사 + 비교세트")} ${compareSet.length}${tr("건을 하나의 판독으로 병합(묶음판독)합니다.")}\n` +
      tr("부속 검사 소견은 [MOD 검사일] 태그로 합쳐집니다. 진행할까요?"))) return;
    try {
      await api.mergeReports([selected.id, ...compareSet.map((c) => c.id)]);
      setCompareSet([]);
      onChanged();
      alert(tr("묶음판독 초안이 생성되었습니다 — REPORT 패널에서 검토하세요."));
    } catch (e) {
      alert(e instanceof Error ? e.message : tr("묶음판독 실패"));
    }
  }, [selected, compareSet, onChanged]);

  // S1 자연어 검색: 변환 → 미리보기 배너 → 사용자 적용
  const onNlSearch = useCallback(async (text: string) => {
    setNlBusy(true);
    try { setNlPreview(await api.nlQuery(text)); }
    catch (e) { alert(e instanceof Error ? e.message : tr("자연어 검색 실패")); }
    finally { setNlBusy(false); }
  }, []);

  /* ── UBPACS-Z 페이지 탭 + 검색 폴더 ── */
  // 탭별 라이브 상태 — 탭을 오가도 각 탭의 검색조건·설정이 독립 보존된다
  const tabLive = useRef<Record<string, {
    filters: Record<string, string>; searchText: string; datePreset: string; selNodeId: string | null;
  }>>({});
  // 탭 전환: 현재 탭 상태를 스냅샷하고, 대상 탭의 라이브 상태(있으면) 또는 저장된 정의를 적용.
  // ⚠ 복원한 조건을 **같은 호출로** 커밋해야 한다(applyAndSearch 에 값을 명시로 넘김) —
  //   setFilters 직후 filtersRef 를 읽으면 아직 옛 탭 조건이라 옛 목록이 조회된다.
  const pickTab = (tab: WorklistTab) => {
    tabLive.current[activeTabId] = {
      filters: filtersRef.current, searchText: searchRef.current, datePreset, selNodeId,
    };
    setActiveTabId(tab.id);
    const live = tabLive.current[tab.id];
    if (live) {
      setDatePreset(live.datePreset);
      setSelNodeId(live.selNodeId);
      applyAndSearch({ filters: live.filters, searchText: live.searchText });
    } else {
      setSelNodeId(null);
      setDatePreset(tab.filter.date ?? "all");
      applyAndSearch({ filters: folderToFilters(tab.filter), searchText: "" });
    }
  };

  // 새 페이지 등록 (최대 10) — 새 탭은 빈 검색으로 시작해 독립적으로 조건을 설정한다.
  // (검색 폴더에서 만들면 그 폴더 조건으로 시작)
  const addTab = useCallback(async (treeFilter?: { label: string; filter: WorklistTab["filter"] }) => {
    if (tabs.length >= 10) { alert(tr("워크리스트 페이지는 최대 10개입니다 (UBPACS-Z 규격)")); return; }
    const label = prompt(tr("새 페이지 이름 — 새 검색으로 시작합니다 (예: CR, 응급실)"),
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
    setDatePreset(tab.filter.date ?? "all");
    applyAndSearch({ filters: folderToFilters(tab.filter), searchText: "" });
    try { await saveTabs(next); } catch (e) { alert(e instanceof Error ? e.message : tr("페이지 저장 실패")); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, datePreset, activeTabId, selNodeId, applyAndSearch]);

  const removeTab = useCallback(async (id: string) => {
    const t = tabs.find((x) => x.id === id);
    if (!t || !window.confirm(`'${t.label}' ${tr("페이지를 삭제할까요?")}`)) return;
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
    // 폴더 클릭 = 명시적 사용자 액션 → 조건 적용 + 즉시 조회(커밋)
    applyAndSearch({ filters: folderToFilters(merged) });
  }, [treeNodes, applyAndSearch]);

  const onTreeChange = useCallback((next: TreeNode[]) => {
    setTreeNodes(next);
    saveTree(next).catch((e) => alert(e instanceof Error ? e.message : tr("검색 폴더 저장 실패")));
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
    setNlPreview(null);
    // [적용] 버튼 = 명시적 사용자 액션 → 변환된 조건을 입력칸에 넣고 그 자리에서 커밋
    applyAndSearch({ filters: next });
  }, [nlPreview, applyAndSearch]);

  const emergencyCount = useMemo(() => items.filter((i) => i.emergency).length, [items]);

  // In 모드 워크리스트 배치 — 선택 뷰어(viewer.prefs.client_viewer)=infi 면 INFINITT 원본 7구역 배치,
  // ty 면 현행(TY) 배치 유지. 설정 저장/⟳Refresh 시 refreshKey 로 즉시 재적용.
  const [infiMode, setInfiMode] = useState(false);
  // SAINT VIEW 모드 — client_viewer=sv 면 SAINT VIEW 워크리스트 스킨(상태 카운트 바 + SV 컬럼, infi 7구역 레이아웃 재사용)
  const [svMode, setSvMode] = useState(false);
  // 뷰어별 레이아웃 해석 — 활성 스킨(sv/infi/ty)에 맞춰 컬럼·패널·크기를 원본 prefs 에서 재구성.
  //  ty  = legacy 키(columns/panels/layout_sizes)
  //  sv·infi = 뷰어별 버킷(by_viewer / panels_by_viewer / sizes_by_viewer) + 없으면 뷰어 기본값
  useEffect(() => {
    const vk: ViewerKey = svMode ? "sv" : infiMode ? "infi" : "ty";
    vkRef.current = vk;
    const v = wlPrefsRef.current as {
      panels?: Record<string, boolean>;
      panels_by_viewer?: Partial<Record<ViewerKey, Record<string, boolean> | null>>;
      layout_sizes?: Partial<LayoutSizes>;
      sizes_by_viewer?: Partial<Record<ViewerKey, (Partial<LayoutSizes> & Partial<InfiSizes>) | null>>;
      infi_sizes?: Partial<InfiSizes>;
    };
    // ── 컬럼 ──
    const ov = wlByViewerRef.current[vk];
    const base = vk === "ty" ? wlColsBaseRef.current : VIEWER_COL_DEFAULT[vk];
    const cols = ov?.length ? ov.filter((c) => COLUMN_DEFS[c]) : base;
    if (cols?.length) setColumns(cols.includes("read_state") ? cols : ["read_state", ...cols]);
    // 컬럼 폭(계정별·뷰어별) — 헤더 가장자리 드래그로 조정한 값 복원
    const cwBag = (v as { col_widths_by_viewer?: Partial<Record<ViewerKey, Record<string, number>>> })
      .col_widths_by_viewer;
    setColW(cwBag?.[vk] ?? {});
    // ── 패널 표시/숨김 ──
    setPanelsOn(vk === "ty"
      ? { ...DEFAULT_TY_PANELS, ...(v.panels ?? {}) }
      : { ...DEFAULT_SVINFI_PANELS, ...(v.panels_by_viewer?.[vk] ?? {}) });
    // ── 크기 ──
    if (vk === "ty") {
      setSizes({ ...DEFAULT_SIZES, ...(v.layout_sizes ?? {}) });
    } else {
      const bag = v.sizes_by_viewer?.[vk] ?? {};
      setSizes({ ...DEFAULT_SIZES, railW: bag.railW ?? v.layout_sizes?.railW ?? DEFAULT_SIZES.railW });
      setInfiSz({
        prevH: bag.prevH ?? v.infi_sizes?.prevH ?? DEFAULT_INFI_SIZES.prevH,
        priorH: bag.priorH ?? v.infi_sizes?.priorH ?? DEFAULT_INFI_SIZES.priorH,
        repH: bag.repH ?? v.infi_sizes?.repH ?? DEFAULT_INFI_SIZES.repH,
      });
    }
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
    // 설정 저장(settingsTick)에서 뷰어 스킨을 즉시 재해석한다. refreshKey 도 유지해
    // ⟳ 새로고침·명시적 재조회 때 함께 재확인 — 예전 동작(설정 저장=refreshKey)과 결과가 같다.
  }, [refreshKey, settingsTick]);
  // (infiSz 상태·infiSzRef·persistInfiSz 는 상단 레이아웃 크기 블록으로 이동 — 뷰어별 저장)

  // In/SAINT VIEW 좌측 검색레일 스크롤 보장 — flex 체인 대신 실제 top 을 측정해 뷰포트 기준 maxHeight 를
  // 직접 지정한다(상단 바 구성이 바뀌어도 정확, 브라우저 환경차 무관). 렌더/리사이즈마다 재측정.
  const railScrollRef = useRef<HTMLDivElement | null>(null);
  const fitRail = useCallback(() => {
    const el = railScrollRef.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    // 아래 여백 = Preview 표시 시 (prevH + 스플리터/마진), 숨김 시 재열기 바(약 22px). 최소 80px 보장.
    // 상태를 직접 읽어(ref 지연 없이) 매 렌더 재측정 — preview 토글·드래그 즉시 반영.
    const reserve = panelsOn.preview ? infiSz.prevH + 14 : 22;
    const h = Math.max(80, Math.round(window.innerHeight - top - reserve));
    el.style.maxHeight = `${h}px`;
  }, [panelsOn.preview, infiSz.prevH]);
  useLayoutEffect(fitRail);   // 매 렌더 후 재측정(조건부 상단 바 출현/사라짐까지 반영)
  useEffect(() => {
    window.addEventListener("resize", fitRail);
    return () => window.removeEventListener("resize", fitRail);
  }, [fitRail]);

  // In 모드 ① 상단 아이콘 툴바 (INFINITT 원본 13종) — 기존 doAction + 특수 동작 매핑
  const infiTool = (act: string) => {
    // LOCAL 모드 — Import/Export/Print/Refresh/Logout 만 허용, 나머지 서버 액션 차단
    if (localMode && !LOCAL_OK_ACTIONS.has(act) && act !== "refresh") { alert(tr(LOCAL_DENIED_TIP)); return; }
    // LIVE 모드 — 원격 미지원 기능 차단(열람·판독·Reading 은 허용)
    if (liveMode && !LIVE_OK_ACTIONS.has(act) && act !== "refresh") { alert(tr(LIVE_DENIED_TIP)); return; }
    switch (act) {
      case "import": setImportOpen(true); break;  // Import DICOM — USB/CD .dcm 등록
      case "reading": {   // Report 창 — 판독 작성 (모니터 설정 반영, 선택 연동은 sync)
        if (!selected) { alert(tr("검사를 먼저 선택하세요")); break; }
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
      case "csv": {   // Export — 선택한 Exam 의 **DICOM 영상** 반출 (목록 CSV 는 대화상자 안에)
        // Ctrl/Shift 다중선택이 있으면 그 전부, 없으면 지금 선택한 한 건
        const chosen = selectedIds.size
          ? items.filter((r) => selectedIds.has(r.id))
          : selected ? [selected] : [];
        if (!chosen.length) { alert(tr("내보낼 검사를 선택하세요 (Shift·Ctrl 로 여러 건 선택)")); break; }
        setExportRows(chosen);
        break;
      }
      case "print": window.print(); break;
      case "logout":
        localStorage.setItem("sv_logout", String(Date.now()));   // 뷰어 창도 닫기
        localStorage.removeItem("sv_token"); sessionStorage.removeItem("sv_token");
        // ★ 다운로드 모드로 받아 둔 **환자 영상을 반드시 폐기**한다. OPFS 는 탐색기에 안 보일
        //   뿐 '없는 것'이 아니다 — 공용 판독 PC 에서 로그아웃 후에도 남으면 사고다.
        //   (09 세션이 같은 논리로 픽셀 쿠키 sv_pix 폐기를 강제했다.)
        //   ⚠ location.href 를 먼저 때리면 삭제가 중간에 끊길 수 있다 — **끝난 뒤에** 이동한다.
        //   (삭제가 걸려 있으면 3초 뒤 그냥 이동. 로그아웃이 막히는 편이 더 나쁘다.)
        dlReset();
        void Promise.race([opfsWipe(), new Promise((r) => setTimeout(r, 3000))])
          .finally(() => { location.href = "/"; });
        break;
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
    { i: "📤", l: "Export — 선택 검사의 DICOM 내보내기 (CD/USB/폴더)", a: "csv" },
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
                       viewerName={svMode ? "SaintView" : infiMode ? "I-View" : "T-View"}
                       onPick={(t) => { setExamCtl(false); pickTab(t); }}
                       onAdd={() => { setExamCtl(false); void addTab(); }}
                       onRemove={(id) => void removeTab(id)}
                       serverMode={serverMode} onServerMode={pickServerMode}
                       onWebPacs={() => setWebPacsOpen(true)}
                       extraTab={isAdminRole && (
                         /* 관리자 전용 EXAM CONTROL 탭 — 기존 탭과 동일 스타일 + 보라 포인트 */
                         <div onClick={() => setExamCtl(true)}
                              title={tr("Exam Control — 관리자 검사 QC (삭제·복구·Unassign·Assign)")}
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
                             ["csv", "📤 Export", "Export — 선택 검사의 DICOM 내보내기 (CD/USB/폴더)"],
                             ["print", "🖨 Print", "Print — 화면 인쇄"],
                             ["pdf", "📄 PDF", "판독서 PDF"],
                             ["emergency", "⚠ Emergency", "응급 우선순위 토글 (F-15)"],
                             ["regen", "🤖 AI", "AI — 초안 재생성"],
                             ["batch", "📋 일괄 검토", "AI 초안 일괄 검토 (F-22)"],
                             ["refresh", "🔄 새로고침", "목록 새로고침"],
                           ] as const).map(([a, label, title]) => {
                             // LOCAL 모드: 서버 전용 액션은 비활성+안내 툴팁 (Import/Export/Print/새로고침만 활성)
                             const localBlocked = localMode && !LOCAL_OK_ACTIONS.has(a);
                             const liveBlockedBtn = liveMode && !LIVE_OK_ACTIONS.has(a);
                             const ok = allowedAction(a) && !localBlocked && !liveBlockedBtn;
                             return (
                               <button key={a} disabled={!ok}
                                       title={ok ? tr(title) : localBlocked ? tr(LOCAL_DENIED_TIP)
                                              : liveBlockedBtn ? tr(LIVE_DENIED_TIP) : tr(PERM_DENIED_TIP)}
                                       onClick={() => infiTool(a)}
                                       style={{ padding: "2px 8px", fontSize: 11, whiteSpace: "nowrap" }}>
                                 {tr(label)}
                               </button>
                             );
                           })}
                         </>
                       )} />
      {/* EXAM CONTROL 본문 (레인 F) — 관리자 검사 QC. 선택 시 워크리스트 본문 전체를 대체.
          source: Local Server 모드(sv_server_mode=local)면 로컬 PACS(/api/local/examctl), 아니면 서버(/api/examctl) */}
      {examCtl ? (
        <Suspense fallback={<div style={{ padding: 20, color: "var(--text-secondary)" }}>{tr("Exam Control 로딩…")}</div>}>
          <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 8, display: "flex", flexDirection: "column" }}>
            <ExamControl source={serverMode === "local" ? "local" : "server"} />
          </div>
        </Suspense>
      ) : (
      <>
      {/* LIVE 모드 배지 — 원격 A(webpacs_api) 직결 표시(복사 없음, 5초 실시간 폴링) */}
      {liveMode && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 10px",
                      background: "rgba(34,197,94,0.10)", borderBottom: "1px solid #22c55e", fontSize: 12 }}>
          <b style={{ color: "#22c55e" }}>{tr("LIVE 모드")}</b>
          <span>
            {tr("원격 PACS 직결(복사 없음) — 판독·주석은 원격 DB 에 저장, 5초 실시간 동기")}
            {liveErr && <span style={{ color: "var(--stat-emergency)" }}> · ⚠ {liveErr}</span>}
          </span>
          <span style={{ marginLeft: "auto", color: "var(--text-secondary)", fontSize: 11 }}>
            {tr("접속 설정: [WebPACS] 버튼 — 해제: Web Server")}
          </span>
        </div>
      )}
      {/* LOCAL 모드 배지 — 데이터 소스·루트 표시 + 서버 데이터 숨김 안내 (레인 F) */}
      {localMode && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 10px",
                      background: "rgba(245,158,11,0.12)", borderBottom: "1px solid #f59e0b", fontSize: 12 }}>
          <b style={{ color: "#f59e0b" }}>{tr("LOCAL 모드")}</b>
          <span>{tr("서버 데이터 숨김 · 데이터:")} <code style={{ fontSize: 11 }}>
            {localRoot || (localErr ? `${tr("⚠ 준비 중")} (${localErr})` : tr("확인 중…"))}</code></span>
          <span style={{ marginLeft: "auto", color: "var(--text-secondary)", fontSize: 11 }}>
            {tr("Import·새로고침·로컬 뷰어(더블클릭)만 사용 가능 — 해제: Web Server")}
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
              // 유효 권한 게이트 + LOCAL/LIVE 모드 게이트 — 비활성+안내 툴팁 (UX 목적)
              const localBlocked = localMode && !LOCAL_OK_ACTIONS.has(t.a);
              const liveBlockedBtn = liveMode && !LIVE_OK_ACTIONS.has(t.a);
              const ok = allowedAction(t.a) && !localBlocked && !liveBlockedBtn;
              return (
                <button key={t.a} disabled={!ok}
                        title={ok ? tr(t.l) : `${tr(t.l)} — ${localBlocked ? tr(LOCAL_DENIED_TIP)
                                : liveBlockedBtn ? tr(LIVE_DENIED_TIP) : tr(PERM_DENIED_TIP)}`}
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
            /* 카운트 칩도 **커밋된** queryParams 로 집계한다 — 입력 상태로 물리면 타건마다
               /api/worklist/counts 가 나가고 칩 숫자가 목록보다 먼저 움직인다. */
            : <SvStatusBar queryParams={queryParams} refreshKey={refreshKey} items={items} pageOnly={liveMode}
                           onStatus={(p) => applyAndSearch({ filters: (f) => ({ ...f, ...p }) })}
                           onRefresh={reloadList} />}
        </>
      )}
      <ActionToolbar selected={selected} onAction={(a) => doAction(a)}
                     searchText={searchText} setSearchText={setSearchText}
                     onSearch={runSearch} dirty={queryDirty}
                     onNlSearch={onNlSearch}
                     searchMode={searchMode} setSearchMode={setSearchMode}
                     withOpen={withOpen} setWithOpen={setWithOpen}
                     withOpenMode={withOpenMode} setWithOpenMode={setWithOpenMode}
                     ohifOn={ohifOn} allowed={allowedAction} />
      <FilterBar filters={filters} setFilters={setFilters} fields={findFields}
                 onSearch={runSearch} dirty={queryDirty} />

      {/* 수동 갱신 중 원격(A)에 변경이 생겼을 때 — 목록은 그대로 두고 알리기만 한다.
          판독 중 목록이 저 혼자 바뀌지 않으면서도 '새 검사가 왔다'는 사실은 놓치지 않게. */}
      {pendingChange && refreshMode === "manual" && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 12px",
                      background: "rgba(250,204,21,0.14)", borderBottom: "1px solid var(--border)",
                      fontSize: 12 }}>
          <b>{tr("원격 워크리스트에 변경이 있습니다")}</b>
          <span style={{ color: "var(--text-secondary)" }}>
            {tr("수동 갱신 모드라 목록을 그대로 두었습니다 — 설정 > 환경에서 자동으로 바꿀 수 있습니다.")}
          </span>
          {/* 원격 변경만 반영한다 — 사용자가 타이핑해 둔 미커밋 필터까지 함께 적용하면
              '새로고침을 눌렀는데 조건이 바뀐다' 가 되어 SEARCH 와 구분이 사라진다. */}
          <button className="primary" style={{ marginLeft: "auto", padding: "2px 12px" }}
                  onClick={reloadList}>{tr("지금 갱신")}</button>
          <button style={{ padding: "2px 10px" }} onClick={() => setPendingChange(false)}>{tr("닫기")}</button>
        </div>
      )}

      {/* 다중선택 상태 바 — Shift(범위)/Ctrl·Cmd(개별) 로 여러 Exam 선택 시 표시 */}
      {selectedIds.size > 1 && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 12px",
                      background: "var(--accent-subtle, rgba(96,165,250,0.12))", borderBottom: "1px solid var(--border)", fontSize: 12 }}>
          <b>{selectedIds.size}{tr("개 Exam 선택됨")}</b>
          <button style={{ padding: "2px 10px" }} onClick={() => { setSelectedIds(new Set(items.map((r) => r.id))); selAnchorRef.current = items[0]?.id ?? null; }}>{tr("모두 선택")}</button>
          <button style={{ padding: "2px 10px" }} onClick={() => { setSelectedIds(new Set(selected ? [selected.id] : [])); selAnchorRef.current = selected?.id ?? null; }}>{tr("선택 해제")}</button>
          <button className="primary" style={{ padding: "2px 10px" }}
                  onClick={() => setExportRows(items.filter((r) => selectedIds.has(r.id)))}>
            {tr("📤 DICOM 내보내기")}
          </button>
          <span style={{ marginLeft: "auto", color: "var(--text-secondary)", fontSize: 11 }}>
            {tr("Shift+클릭 = 범위 · Ctrl/Cmd+클릭 = 개별 토글")}
          </span>
        </div>
      )}

      {/* S1 자연어 검색 미리보기 — 적용 전 사용자 확인(03b: AI 결과는 항상 라벨링) */}
      {(nlBusy || nlPreview) && (
        <div style={{
          display: "flex", gap: 8, alignItems: "center", padding: "5px 10px",
          background: "var(--bg-panel)", borderBottom: "1px solid var(--ai)", fontSize: 12.5,
        }}>
          <span className="badge ai">{tr("AI 검색")}</span>
          {nlBusy ? (
            <span style={{ color: "var(--text-secondary)" }}>{tr("변환 중…")}</span>
          ) : nlPreview && (
            <>
              <span>{tr("해석:")} <b>{nlPreview.explanation}</b></span>
              {nlPreview.source !== "live" && (
                <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>
                  ({nlPreview.source === "mock" ? tr("규칙 기반") : tr("AI 실패 — 규칙 기반 폴백")})
                </span>
              )}
              <button className="primary" style={{ padding: "1px 12px", fontSize: 12 }} onClick={applyNlPreview}>{tr("적용")}</button>
              <button style={{ padding: "1px 10px", fontSize: 12 }} onClick={() => setNlPreview(null)}>{tr("취소")}</button>
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
              {/* 모달리티 칩·기간 프리셋은 '눌렀다' = 명시적 액션 → 조건 반영 + 즉시 커밋(조회) */}
              <SearchRail width={sizes.railW} active={datePreset} unifiedScroll
                          mods={modCounts} activeMod={filters.modality ?? ""}
                          onMod={(m) => applyAndSearch({ filters: (f) => ({ ...f, modality: m }) })}
                          onPick={(key, from) => {
                            setDatePreset(key);
                            applyAndSearch({ filters: (f) => ({ ...f, tree_from: from, date_from_iso: "", date_to_iso: "" }) });
                          }} tree={
                <FolderTreeEditor nodes={treeNodes} onChange={onTreeChange}
                                  selectedId={selNodeId} onSelect={applyFolder} applyHint />
              } />
            </div>
            {/* ⑤ Preview — 선택 검사 미리보기 (원본 좌하단 흑배경). 스플리터 최소까지 드래그=숨김 */}
            {panelsOn.preview ? (
              <>
                <Splitter dir="h" onEnd={() => endInfiRegion("preview")} onReset={() => resetInfiRegion("prevH")}
                          onDrag={(dy) => dragInfiRegion("preview", "prevH", 60, 600, dy)} />
                <div style={{ height: infiSz.prevH, flexShrink: 0, background: "#000", border: "1px solid var(--border)",
                              borderRadius: 4, overflow: "hidden", display: "flex" }}>
                  <ThumbnailPanel detail={selected} onOpen={() => void doAction("viewdraft")} />
                </div>
              </>
            ) : (
              <ReopenBar label={tr(SVINFI_PANEL_LABEL.preview)} onExpand={() => setPanelShown("preview", true)} />
            )}
          </div>
          {/* 좌|우 세로 스플리터 (railW) */}
          <Splitter dir="v" onEnd={persistSizes}
                    onDrag={(dx) => setSizes((s) => ({ ...s, railW: clampSz(s.railW + dx, 100, 460) }))} />
          {/* 우열: Grid(위) ─h─ Related(priorH) ─h─ Report(repH) */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
            <div style={{ flex: 1, minHeight: 60, display: "flex",
                          ...(searchFlash ? { animation: `${searchFlash % 2 ? "wlSearchFlashA" : "wlSearchFlashB"} 0.5s ease` } : {}) }}>
              <StudyGrid items={items} columns={columns} variant="infi" selectedId={focusId ?? selected?.id ?? null} selectedIds={selectedIds}
                         treeDisabled={localMode}
                         colWidths={colW} onReorder={reorderColumns} onResize={resizeColumn}
                         onSelect={onSelect}
                         onOpen={(r) => { if (localMode) setLocalViewerRow(r); else void doAction("viewdraft", r); }}
                         onContext={(e, r) => setCtx({ x: e.clientX, y: e.clientY, row: r })} />
            </div>
            {panelsOn.related ? (
              <>
                <Splitter dir="h" onEnd={() => endInfiRegion("related")} onReset={() => resetInfiRegion("priorH")}
                          onDrag={(dy) => dragInfiRegion("related", "priorH", 40, 320, dy)} />
                <div style={{ height: infiSz.priorH, flexShrink: 0, display: "flex" }}>
                  <PriorStudiesGrid detail={selected} onOpen={openPrior}
                                    onAddCompare={(e) => setCompareSet((prev) =>
                                      prev.some((c) => c.study_uid === e.study_uid) ? prev : [...prev, e])} />
                </div>
              </>
            ) : (
              <ReopenBar label={tr(SVINFI_PANEL_LABEL.related)} onExpand={() => setPanelShown("related", true)} />
            )}
            {panelsOn.report ? (
              <>
                <Splitter dir="h" onEnd={() => endInfiRegion("report")} onReset={() => resetInfiRegion("repH")}
                          onDrag={(dy) => dragInfiRegion("report", "repH", 56, 640, dy)} />
                <div style={{ height: infiSz.repH, flexShrink: 0, display: "flex" }}>
                  <InfiReport detail={selected} />
                </div>
              </>
            ) : (
              <ReopenBar label={tr(SVINFI_PANEL_LABEL.report)} onExpand={() => setPanelShown("report", true)} />
            )}
          </div>
        </div>
      )}

      {/* 중단: 검색 레일(기간+폴더 트리) + 메인 그리드 — 좌우 스플리터 (TY 배치) */}
      {!infiMode && !svMode && (
      <div style={{ display: "flex", flex: 2.2, minHeight: 0 }}>
        {/* 모달리티 칩·기간 프리셋은 '눌렀다' = 명시적 액션 → 조건 반영 + 즉시 커밋(조회) */}
        <SearchRail width={sizes.railW} active={datePreset}
                    mods={modCounts} activeMod={filters.modality ?? ""}
                    onMod={(m) => applyAndSearch({ filters: (f) => ({ ...f, modality: m }) })}
                    onPick={(key, from) => {
          setDatePreset(key);
          applyAndSearch({ filters: (f) => ({ ...f, tree_from: from, date_from_iso: "", date_to_iso: "" }) });
        }} tree={
          <FolderTreeEditor nodes={treeNodes} onChange={onTreeChange}
                            selectedId={selNodeId} onSelect={applyFolder} applyHint />
        } />
        <Splitter dir="v" onEnd={persistSizes}
                  onDrag={(dx) => setSizes((s) => ({ ...s, railW: clampSz(s.railW + dx, 100, 420) }))} />
        <div style={{ flex: 1, minWidth: 0, display: "flex",
                      ...(searchFlash ? { animation: `${searchFlash % 2 ? "wlSearchFlashA" : "wlSearchFlashB"} 0.5s ease` } : {}) }}>
          <StudyGrid items={items} columns={columns} selectedId={focusId ?? selected?.id ?? null} selectedIds={selectedIds}
                     treeDisabled={localMode}
                     colWidths={colW} onReorder={reorderColumns} onResize={resizeColumn}
                     onSelect={onSelect}
                     onOpen={(r) => { if (localMode) setLocalViewerRow(r); else void doAction("viewdraft", r); }}
                     onContext={(e, r) => setCtx({ x: e.clientX, y: e.clientY, row: r })} />
        </div>
      </div>
      )}

      {/* 하단1 (UBPACS p.8): Order | Related Study List-1 | Related Study List-2 — 드래그 재배치 + 상하 스플리터 */}
      {!infiMode && !svMode && panelOrder.d.some((k) => panelsOn[k]) && (
        <Splitter dir="h" onEnd={persistSizes}
                  onReset={() => { setSizes((s) => ({ ...s, dH: DEFAULT_SIZES.dH })); persistSizes(); }}
                  onDrag={(dy) => setSizes((s) => ({ ...s, dH: clampSz(s.dH - dy, 80, 420) }))} />
      )}
      {!infiMode && !svMode && panelOrder.d.some((k) => panelsOn[k]) && (
        <div style={{ display: "flex", gap: 3, height: sizes.dH, padding: "3px 3px 0", flexShrink: 0 }}>
          {panelOrder.d.filter((k) => panelsOn[k]).map((k) => (
            <DraggablePanel key={k} zone="d" k={k} onDrop={onPanelDrop} onHide={() => setPanelShown(k, false)} style={{ flex: 1 }}>
              {k === "orders" ? <OrdersPanel refreshKey={refreshKey} />
                : k === "prior" ? (
                  <PriorStudiesGrid detail={selected} onOpen={openPrior}
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
                  onReset={() => { setSizes((s) => ({ ...s, eH: DEFAULT_SIZES.eH })); persistSizes(); }}
                  onDrag={(dy) => setSizes((s) => ({ ...s, eH: clampSz(s.eH - dy, 140, 640) }))} />
      )}
      {!infiMode && !svMode && panelOrder.e.some((k) => panelsOn[k]) && (
        <div style={{ display: "flex", gap: 3, height: sizes.eH, flexShrink: 0, padding: 3 }}>
          {(() => {
            const arr = panelOrder.e.filter((k) => panelsOn[k]);
            return arr.flatMap((k, i) => {
              const out = [(
                <DraggablePanel key={k} zone="e" k={k} onDrop={onPanelDrop} onHide={() => setPanelShown(k, false)}
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
        {/* 8000 은 본체 포트다 — 스위트는 8010. 실제 나가는 곳을 그대로 표시한다. */}
        <span>[Q][H] Server: {import.meta.env.VITE_API_BASE || window.location.origin}</span>
        <span>{total} results {selected ? "1 selected" : "0 selected"}</span>
        {emergencyCount > 0 && <span style={{ color: "var(--stat-emergency)" }}>⚠ Emergency {emergencyCount}{tr("건")}</span>}
        <span style={{ marginLeft: "auto" }}>{new Date().toLocaleString("ko-KR")}</span>
      </footer>

      {exportRows && (
        <ExportDialog rows={exportRows} onClose={() => setExportRows(null)}
                      onCsv={() => {
                        // 예전 Export(목록 CSV)도 남겨 둔다 — 영상이 아니라 표가 필요할 때
                        const rows = [
                          ["PatientID", "Name", "Sex", "Modality", "StudyDate", "Description", "Status"].join(","),
                          ...items.map((r) => [r.patient_key, r.patient_name, r.sex, r.modality, r.study_date,
                                               (r.study_desc ?? "").replaceAll(",", " "), r.status].join(",")),
                        ].join("\n");
                        const url = URL.createObjectURL(
                          new Blob([String.fromCharCode(0xfeff) + rows], { type: "text/csv;charset=utf-8" }));
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `worklist_${new Date().toISOString().slice(0, 10)}.csv`;
                        a.click();
                        URL.revokeObjectURL(url);
                      }} />
      )}
      {batchOpen && <BatchReviewModal onClose={() => setBatchOpen(false)} onDone={() => setRefreshKey((k) => k + 1)} />}
      {importOpen && (
        <Suspense fallback={null}>
          <ImportDialog onClose={() => setImportOpen(false)}
                        localMode={localMode} localRoot={localRoot}
                        onDone={() => {
                          // CD 영상은 검사일이 과거인 경우가 많아 기간 필터를 '전체'로 풀어 바로 보이게 한다
                          // (가져오기 완료 = 명시적 액션 → 조건 완화 + 즉시 커밋)
                          setDatePreset("all");
                          applyAndSearch({ filters: (f) => ({ ...f, tree_from: "", date_from_iso: "", date_to_iso: "" }) });
                        }} />
        </Suspense>
      )}
      {/* WebPACS 브리지 — 인계 PACS(webpacs_api) 검사 검색·가져오기 → 우리 뷰어로 열기 */}
      {webPacsOpen && (
        <Suspense fallback={null}>
          <WebPacsBrowser isAdmin={isAdminRole}
                          onImported={() => setRefreshKey((k) => k + 1)}
                          onOpenStudy={async (id) => {
                            try {
                              const d = await api.study(id);
                              selectAndSync(d);
                              localStorage.setItem("sv_infi_exams", "[]");   // View 교체 시맨틱
                              void openV2({ detail: d });
                            } catch { alert(tr("검사 열기에 실패했습니다 — 워크리스트에서 다시 시도하세요")); }
                          }}
                          onClose={() => setWebPacsOpen(false)} />
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
            {tr("3D 뷰어 로딩…")}
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
            {tr("🗔 로컬 뷰어 열기")}
          </div>
          <div className="sv-fav-row" style={{ padding: "5px 10px", borderRadius: 4, cursor: "pointer",
                                               color: "var(--stat-emergency)" }}
               onClick={() => {
                 const r = ctx.row;
                 setCtx(null);
                 if (!window.confirm(
                   `${tr("로컬 검사 삭제 —")} ${r.patient_name || r.patient_key} · ${r.modality} · ${r.study_date}\n` +
                   tr("로컬 Image 파일과 local.db 등록이 함께 삭제됩니다. 진행할까요?"))) return;
                 api.localDelete(r.id)
                   .then(() => setRefreshKey((k) => k + 1))
                   .catch((e) => alert(e instanceof Error ? e.message : tr("삭제 실패 — ⚠ 준비 중")));
               }}>
            {tr("🗑 검사 삭제 (로컬)")}
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
