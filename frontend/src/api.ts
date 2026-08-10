// API 클라이언트 — 백엔드 FastAPI
import { registerLiveStudyUid, registerLiveStudyVid } from "./lib/liveUids";
import { opfsWipe } from "./lib/opfsStore";
import { dlResetCache } from "./lib/dlCache";

const BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";
const OHIF_BASE = import.meta.env.VITE_OHIF_BASE ?? "http://localhost:3000";
/** 뷰어 창 베이스 — 별도 포트로 띄우려면 frontend/.env에 VITE_VIEWER_BASE=https://localhost:5176
 *  설정 후 `npm run dev:viewer`(5176)를 함께 실행(HTTPS 전용 — vite가 https로 고정). 빈값=같은 출처(포트) 사용.
 *  ⚠ 5173/5174/5175 는 포털 예약 포트(Landing/관리자/Client) — 뷰어 분리 포트로 쓰면 역할 가드와 충돌 */
export const VIEWER_BASE: string = import.meta.env.VITE_VIEWER_BASE ?? "";

/** WebPACS Live — 인계 PACS(A) 직결 모드의 가상 검사 id 대역(복사 없음, A DB 단일 원본).
 *  이 대역이면 api.* 가 /api/webpacs/live/… 로 자동 라우팅 — 뷰어·판독 컴포넌트는 무수정. */
export const VID_BASE = 90_000_000;
export const isLiveId = (id: number) => id >= VID_BASE;
const LIVE = "/api/webpacs/live";
const liveBlocked = (what: string) =>
  Promise.reject(new Error(`Live 모드(원격 PACS 직결) — ${what} 기능은 지원되지 않습니다`));

/** View&Draft 동선: OHIF 뷰어를 해당 검사로 오픈 (디자인 §3.1 [A]).
 *  F-18: hangingProtocolId — 모달리티별 매핑(viewer.prefs.hanging)을 호출부에서 전달 */
export function openViewer(studyUid: string, hangingProtocolId?: string) {
  const hp = hangingProtocolId && hangingProtocolId !== "default"
    ? `&hangingProtocolId=${encodeURIComponent(hangingProtocolId)}`
    : "";
  window.open(
    `${OHIF_BASE}/viewer?StudyInstanceUIDs=${encodeURIComponent(studyUid)}${hp}`,
    "_blank",
  );
}

// 자동 로그인(UBPACS-Z §1): remember=localStorage, 아니면 sessionStorage
let token: string | null = localStorage.getItem("sv_token") ?? sessionStorage.getItem("sv_token");

// 새 창 뷰어(window.open) 토큰 인계 — sessionStorage는 탭 간 공유되지 않으므로
// opener의 전역에서 가져온다(동일 출처만 접근 가능).
declare global {
  interface Window { __svToken?: string | null }
}
if (!token && window.opener) {
  try {
    token = (window.opener as Window).__svToken ?? null;
    if (token) sessionStorage.setItem("sv_token", token);
  } catch { /* cross-origin opener — ensureToken()의 postMessage 핸드셰이크 사용 */ }
}
window.__svToken = token;

// 뷰어 창(타 포트=타 출처)의 토큰 요청에 응답 — 허용 출처만 (postMessage 핸드셰이크)
window.addEventListener("message", (e: MessageEvent) => {
  const allowed = e.origin === window.location.origin || (VIEWER_BASE && e.origin === new URL(VIEWER_BASE).origin);
  if (!allowed || !token) return;
  if ((e.data as { type?: string })?.type === "sv:req-token") {
    (e.source as Window | null)?.postMessage({ type: "sv:token", token }, e.origin);
  }
});

/** 새 창(타 출처 포함)에서 토큰 확보 — 직접 인계 실패 시 opener에 postMessage 요청 */
export function ensureToken(timeoutMs = 3000): Promise<boolean> {
  if (token) return Promise.resolve(true);
  if (!window.opener) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (ok: boolean) => { window.removeEventListener("message", onMsg); resolve(ok); };
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; token?: string };
      if (d?.type === "sv:token" && d.token) {
        token = d.token;
        window.__svToken = token;
        try { sessionStorage.setItem("sv_token", token); } catch { /* 무시 */ }
        done(true);
      }
    };
    window.addEventListener("message", onMsg);
    try { (window.opener as Window).postMessage({ type: "sv:req-token" }, "*"); } catch { done(false); return; }
    setTimeout(() => done(!!token), timeoutMs);
  });
}

/** 서버 로그아웃 — 세션 종료 + 픽셀 쿠키(sv_pix) 폐기.
 *  픽셀 쿠키는 HttpOnly 라 JS 가 지울 수 없다. 서버가 지우지 않으면 '로그아웃했는데
 *  브라우저에 영상 열람 자격이 남는' 상태가 되므로 토큰을 버릴 때 반드시 함께 호출한다.
 *  ⚠ req() 를 쓰지 않는다 — req 의 401 처리기가 다시 setToken(null) 을 불러 무한 재귀한다.
 *  실패는 무시한다(로그아웃은 로컬 상태 정리가 우선). */
function serverLogout(prevToken: string) {
  try {
    void fetch(`${BASE}/api/auth/logout`, {
      method: "POST",
      credentials: "include",
      headers: { Authorization: `Bearer ${prevToken}` },
    }).catch(() => { /* 오프라인·서버 다운 — 무시 */ });
  } catch { /* 무시 */ }
}

/** 마지막 저장본 삭제 작업 — 진행 중이면 그 Promise, 아니면 즉시 완료.
 *  401 처리기가 window.location.reload() **전에** 이것을 기다린다(최대 3초). */
let lastWipe: Promise<void> | null = null;
export function opfsWipeDone(): Promise<void> { return lastWipe ?? Promise.resolve(); }

/** 현재 토큰 — 협진 WebSocket 전용 접근자.
 *  fetch 경로는 req()/panelFetch 가 알아서 헤더를 붙이지만, 브라우저 WebSocket API 는
 *  헤더를 못 붙여 토큰을 **서브프로토콜**로 넘겨야 한다(lib/collab.ts 참조).
 *  폴백 순서는 panelFetch 와 동일 — 메모리 우선(새 창 인계 커버), 없으면 저장소. */
export function getToken(): string | null {
  return token ?? localStorage.getItem("sv_token") ?? sessionStorage.getItem("sv_token");
}

export function setToken(t: string | null, remember = false) {
  const prev = token;
  token = t;
  window.__svToken = t;
  sessionStorage.removeItem("sv_token");
  localStorage.removeItem("sv_token");
  if (t) (remember ? localStorage : sessionStorage).setItem("sv_token", t);
  // ⚠ 토큰이 **있었을 때만** 서버 로그아웃을 보낸다.
  //   예전에는 prev 가 null 이어도 자격증명 없는 POST /api/auth/logout 을 보냈다. 그 응답의
  //   Set-Cookie 가 sv_pix 를 지우는데, 쿠키 항아리는 브라우저 단위(탭 공유)라 **다른 탭의
  //   영상이 조용히 죽었다**: 로그인 화면에서 비번을 한 번 틀리면(401 → reqRaw 가 setToken(null))
  //   판독 중이던 탭의 <img> 만 401 이 된다(JWT 는 그 탭 sessionStorage 에 멀쩡해서 JSON API 는
  //   200 → 화면에 오류가 뜨지 않는다). 토큰이 없던 호출자는 서버에 끊을 세션도 없으므로
  //   logout 을 보낼 이유가 애초에 없다. 서버도 같은 원인을 막는다(auth.logout has_credential).
  else if (prev) {
    serverLogout(prev);
    // ★ 다운로드 모드 저장본 폐기 — 로그아웃·세션 만료·계정 전환 어느 경로든 여기를 지난다
    //   (App.logout 의 setToken(null), req() 401 처리기). 환자 영상이 브라우저에 남는 표면을
    //   새로 만드는 일이라, 자격이 사라지는 순간 저장본도 함께 사라져야 한다 — sv_pix 폐기와 같은 논리.
    // ⚠ 순서: **다운로더를 먼저 세우고** 지운다(워크리스트 로그아웃 버튼과 같은 규칙).
    //   안 세우면 in-flight 였던 fetch 가 삭제 뒤에 opfsPut 으로 트리를 되살린다.
    //   dlScheduler 를 직접 import 하면 순환(dlScheduler → api)이라 이벤트로 알린다.
    try { window.dispatchEvent(new Event("sv-auth-cleared")); } catch { /* 무시 */ }
    dlResetCache();
    // ★ 삭제 Promise 를 보관한다 — 401 처리기가 reload 전에 이것을 기다린다.
    //   기다리지 않고 reload 하면 삭제가 중간에 끊겨 파일이 남을 수 있다(opfsWipe 참조).
    lastWipe = opfsWipe().catch(() => {});
  }
}


export function hasToken() {
  return !!token;
}

/* ⚡ GET 인플라이트 합류(dedupe) — 같은 GET 이 짧은 시간에 중복 발사되는 것을 1회로 합친다.
 *
 * 뷰어 열기 1회에 실측으로 `GET /api/studies/{id}` 가 4회(워크리스트 onSelect ×2 · doAction ·
 * 뷰어창), `GET /api/settings/viewer.prefs` 가 5회 발사됐다. 원격(RTT 큰 회선)에서는 이 중복이
 * 그대로 지연이 된다. 진행 중인 동일 GET 이 있으면 그 Promise 에 합류시키고, 완료 후에도
 * 아주 짧게(TTL) 결과를 공유해 마운트 폭풍을 흡수한다.
 * ⚠ 상태가 바뀌는 요청과 폴링을 방해하면 안 되므로 (a) GET 만 (b) TTL 을 아주 짧게 (c) 화이트리스트
 *   경로(열기 경로에서만 중복되는 읽기)만 적용한다. */
const DEDUPE_TTL_MS = 1500;
const DEDUPE_RE = /^\/api\/(studies\/\d+$|settings\/|hospitals\/\d+\/image-format$|auth\/profile$)/;
const _inflight = new Map<string, { at: number; p: Promise<unknown> }>();

function dedupeKey(path: string, init?: RequestInit): string | null {
  const isGet = !init?.method || init.method.toUpperCase() === "GET";
  if (!isGet || !DEDUPE_RE.test(path)) return null;
  return path;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const key = dedupeKey(path, init);
  if (key) {
    const hit = _inflight.get(key);
    if (hit && Date.now() - hit.at < DEDUPE_TTL_MS) return hit.p as Promise<T>;
    const p = reqRaw<T>(path, init);
    _inflight.set(key, { at: Date.now(), p: p as Promise<unknown> });
    // 실패는 캐시하지 않는다(다음 호출이 정상 재시도하도록)
    p.catch(() => _inflight.delete(key));
    return p;
  }
  return reqRaw<T>(path, init);
}

async function reqRaw<T>(path: string, init?: RequestInit): Promise<T> {
  // FormData(파일 업로드)는 브라우저가 multipart boundary 를 직접 설정 — Content-Type 강제 금지
  const isForm = init?.body instanceof FormData;
  // 일시 장애 자동 재시도 — 백엔드 재시작/프록시 순단(502/503/504, 네트워크 오류) 시
  // 멱등한 GET 만 1s→3s 백오프로 2회 재시도. 패널에 'HTTP 502'가 남는 문제 방지.
  const isGet = !init?.method || init.method.toUpperCase() === "GET";
  const RETRY_DELAYS = [1000, 3000];
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        ...init,
        // 픽셀 쿠키(sv_pix, HttpOnly) 수신·전송용. 같은 출처(VITE_API_BASE 빈값 = 기본 배치)
        // 에서는 fetch 기본값과 동작이 같아 무해하고, API 를 다른 호스트에 둔 배치에서는
        // 이게 없으면 로그인 응답의 Set-Cookie 가 통째로 버려져 영상이 401 이 된다.
        credentials: "include",
        headers: {
          ...(isForm ? {} : { "Content-Type": "application/json" }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(init?.headers ?? {}),
        },
      });
    } catch (e) {
      // fetch 자체 실패(네트워크/프록시 다운) — GET 이면 재시도
      if (isGet && attempt < RETRY_DELAYS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
        continue;
      }
      throw e;
    }
    if (isGet && attempt < RETRY_DELAYS.length && [502, 503, 504].includes(res.status)) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      continue;
    }
    if (res.status === 401 && !path.startsWith("/api/collab/")) {
      // ⚠ 협진 경로는 전역 로그아웃에서 **면제**한다.
      //   실제 사고: 협진 계정 행이 없는 사용자의 /api/collab/* 가 401 을 내자 이 처리기가
      //   '세션 만료' 로 오인해 강제 리로드 — 협진 버튼을 누르는 순간 로그인 화면으로 튕겼다.
      //   백엔드는 403 으로 고쳤지만, 구 백엔드가 섞인 배포 전환기에도 튕기지 않도록
      //   프론트에도 같은 선을 긋는다. 진짜 세션 만료는 다음 일반 API 호출이 처리한다.
      // ★ 저장본 삭제가 끝난 **뒤에** 리로드한다.
      //   예전에는 setToken(null) 바로 뒤에 reload 를 때렸는데, setToken 안의 삭제는 대기하지
      //   않는 `void opfsWipe()` 라 리로드가 JS 컨텍스트를 내리면서 삭제가 중간에 끊겼다 —
      //   공용 판독 PC 의 OPFS 에 환자 영상이 그대로 남는다(opfsStore.opfsWipe 주석의 그 사고).
      //   워크리스트 로그아웃 버튼이 이미 쓰는 처리(Promise.race + 3초)를 세션 만료에도 적용한다.
      //   세션 만료는 로그아웃 버튼보다 흔한 경로다.
      setToken(null);
      void Promise.race([opfsWipeDone(), new Promise((r) => setTimeout(r, 3000))])
        .finally(() => window.location.reload());
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail ?? `HTTP ${res.status}`);
    }
    return res.json();
  }
}

/** 레인 패널(HL7·인프라·보안) 공용 인증 fetch — 각 패널의 중복 로컬 헬퍼를 승격(동작 무변경).
 *  api 내부 req() 와 달리 401 자동 로그아웃·리로드를 하지 않는다(패널이 오류 메시지로 표시).
 *  오류 문구 형식은 패널마다 달랐으므로 fmtErr 로 기존 형식을 그대로 유지한다. */
export async function panelFetch<T>(
  path: string,
  init?: RequestInit,
  fmtErr: (status: number, statusText: string, detail?: string) => string
    = (s, st, d) => (d ? `${s} · ${d}` : `${s} ${st}`),
): Promise<T> {
  // 토큰: 메모리 우선(새 창 인계 커버), 없으면 저장소(sv_token) 조회 — 기존 패널 동작과 동일
  const t = token ?? localStorage.getItem("sv_token") ?? sessionStorage.getItem("sv_token");
  // req() 와 동일한 일시 장애 재시도 — 멱등한 GET 만 502/503/504·네트워크 오류 시 1s→3s 2회
  const isGet = !init?.method || init.method.toUpperCase() === "GET";
  const RETRY_DELAYS = [1000, 3000];
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(t ? { Authorization: `Bearer ${t}` } : {}),
          ...(init?.headers ?? {}),
        },
      });
    } catch (e) {
      if (isGet && attempt < RETRY_DELAYS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
        continue;
      }
      throw e;
    }
    if (isGet && attempt < RETRY_DELAYS.length && [502, 503, 504].includes(res.status)) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      continue;
    }
    if (!res.ok) {
      let detail: string | undefined;
      try { detail = ((await res.json()) as { detail?: string }).detail; } catch { /* 본문 없음 */ }
      throw new Error(fmtErr(res.status, res.statusText, detail));
    }
    return res.json() as Promise<T>;
  }
}

// ---- 타입 (백엔드 응답 1:1) ----
export interface StudyRow {
  id: number;
  study_uid: string;
  patient_key: string;
  patient_name: string;
  sex: string;
  birth_date: string;
  accession_no: string;
  study_date: string;
  study_time: string;
  modality: string;
  body_part: string;
  study_desc: string;
  status: string;
  emergency: boolean;
  has_key?: boolean;   // 키이미지 등록 검사 (F-16 — 워크리스트 🔑 표시)
  critical: boolean;
  series_count: number;
  instance_count: number;
  report_status: string | null;
  impression_preview: string;
  // DICOM 헤더 기반 확장 컬럼 (UBPACS-Z Filter Setting)
  institution: string;
  // 원격판독 운영 4항목(2026-08-10) — Live 는 A 원천, 로컬은 공란(병원명=institution)
  request_datetime?: string;   // 의뢰 일시(등록) — 표시 형식은 설정>워크리스트
  hospital_name?: string;      // 의뢰병원
  center_name?: string;        // 원격판독 센터(강남미래·써밋 등)
  assigned_doctor?: string;    // 센터별 배정 판독의
  referring_physician: string;
  memo: string;
  finalized_at: string;
  department: string;
  source_aet: string;
  bookmark: boolean;
  order_name: string;
  // 행잉 프로토콜 '부위 출처'(사양 ③) — 시리즈 레벨 DICOM 태그, 로컬(Orthanc) 검사만 값이 있다
  protocol_name?: string;
  procedure_code?: string;
  step_desc?: string;
  // QC/판독 상태 (read_state 아이콘 — 서버 계산, 워크리스트 '판독' 컬럼)
  read_state?: "fixed" | "read" | "reading" | "open" | "unread";
  merged?: boolean;          // 병합(Merge)된 환자의 검사 — 이름 앞 병합 아이콘
  report_locked?: boolean;   // 판독 확정(잠금) — 변경 금지 (🔒)
  has_report_text?: boolean; // DB에 판독문 존재
  report_typing?: boolean;   // 판독문 입력 진행 중(실시간 하트비트)
  viewer_open?: boolean;     // 뷰어에 열려 있음
  image_changed?: boolean;   // 최초 상태와 다름(주석/키이미지/QC 변경)
}

export interface RelatedExam {
  id: number;
  study_uid: string;
  study_date: string;
  modality: string;
  study_desc: string;
  status: string;
  // ↓ Compare 후보(compareCandidates)에만 실린다. 판독의사 기준은 **다른 환자**가 섞이므로
  //   환자명을 반드시 함께 보여 줘야 한다(같은 환자로 오인하면 위험하다).
  body_part?: string;
  patient_name?: string;
  patient_key?: string;
}

export interface StudyDetail extends StudyRow {
  clinical_info: string;
  related_exams: RelatedExam[];
}

export interface Report {
  id: number;
  study_id: number;
  version: number;
  status: string;
  sr_json: SrJson;
  narrative_text: string;
  created_by: string;
  reviewed_by: string;
  finalized_at: string | null;
  ai_model: string;
  ai_sources: { prior_report_ids?: number[] };
  diff_metrics: Record<string, unknown>;
}

export interface SrJson {
  exam: { modality: string; body_part: string; technique: string };
  comparison: { prior_study_refs: string[]; summary: string };
  findings: { organ: string; observation: string; severity: string; measurements: unknown[] }[];
  impression: { rank: number; statement: string; confidence: string; codes: string[] }[];
  recommendations: { action: string; timeframe: string }[];
  ai_meta: { caveats: string[] };
}

// ---- 호출 ----
export const api = {
  login: (username: string, password: string) =>
    req<LoginResp>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  // Client 뷰어 로그인 — 병원 ID/이름 + 개별 ID + Password. 중복 세션이면 {duplicate:true} 반환.
  clientLogin: (hospital_id: string, username: string, password: string) =>
    req<LoginResp & { duplicate?: boolean; hospital_name?: string }>("/api/auth/client-login", {
      method: "POST",
      body: JSON.stringify({ hospital_id, username, password }),
    }),
  // 중복 로그인 인계 — 기존 세션 종료 카운트다운 걸고 새 세션 로그인
  clientLoginForce: (hospital_id: string, username: string, password: string) =>
    req<LoginResp>("/api/auth/client-login/force", {
      method: "POST",
      body: JSON.stringify({ hospital_id, username, password }),
    }),
  // 세션 poll — 인계 예고(종료 카운트다운) 여부 + 하트비트
  sessionStatus: () =>
    req<{ revoked: boolean; reason: string; seconds_left: number }>("/api/auth/session-status"),
  // 공개 서버 상태 — 홈(초기) 페이지 연동
  status: () => req<ServerStatus>("/api/status"),
  // 가입(공개) — 병원 + 초기 관리자 계정 생성
  signupEnabled: () => req<{ enabled: boolean }>("/api/signup/enabled"),
  signup: (body: SignupRequest) =>
    req<{ ok: boolean; hospital_id: number; hospital_code: string; username: string; message: string }>(
      "/api/signup", { method: "POST", body: JSON.stringify(body) }),
  adminOverview: () => req<AdminOverview>("/api/admin/overview"),
  serverStatusAll: () => req<ServerStatusAll>("/api/admin/server-status"),
  worklist: (params: Record<string, string>) => {
    // 선택한 병원(병원선택→PACS Viewer 흐름)으로 스코프
    const hid = localStorage.getItem("sv_active_hospital");
    const p = { ...params, ...(hid ? { hospital_id: hid } : {}) };
    return req<{ items: StudyRow[]; total: number }>(`/api/worklist?${new URLSearchParams(p)}`);
  },
  // SAINT VIEW 상태 카운트 바 — 목록과 동일 스코프/필터(상태·응급 제외)에서 상태별 전 검사 정확 집계
  worklistCounts: (params: Record<string, string>) => {
    const hid = localStorage.getItem("sv_active_hospital");
    const p = { ...params, ...(hid ? { hospital_id: hid } : {}) };
    return req<{ total: number; emergency: number; unread: number; reading: number; draft_ready: number; finalized: number }>(
      `/api/worklist/counts?${new URLSearchParams(p)}`);
  },
  // 병원 선택 → 자원관리 → Client 선택 흐름
  myHospitals: () => req<MyHospitals>("/api/my/hospitals"),
  hospitalResources: (hid: number) => req<HospitalResources>(`/api/hospitals/${hid}/resources`),
  clients: (hid: number) => req<{ items: ClientRow[] }>(`/api/hospitals/${hid}/clients`),
  createClient: (hid: number, body: { name: string; location?: string; enabled?: boolean; role?: string; password?: string }) =>
    req<ClientRow>(`/api/hospitals/${hid}/clients`, { method: "POST", body: JSON.stringify(body) }),
  updateClient: (hid: number, cid: number, body: { name: string; location?: string; enabled?: boolean; role?: string }) =>
    req<ClientRow>(`/api/hospitals/${hid}/clients/${cid}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteClient: (hid: number, cid: number) =>
    req<{ ok: boolean }>(`/api/hospitals/${hid}/clients/${cid}`, { method: "DELETE" }),
  // admin 비번 관리 — 수정(지정)/리셋(→1111)/전체리셋(→1111)
  setClientPassword: (hid: number, cid: number, password: string) =>
    req<{ ok: boolean; password: string }>(`/api/hospitals/${hid}/clients/${cid}/password`, { method: "PUT", body: JSON.stringify({ password }) }),
  resetClientPassword: (hid: number, cid: number) =>
    req<{ ok: boolean; password: string }>(`/api/hospitals/${hid}/clients/${cid}/reset`, { method: "PUT" }),
  resetAllClientPasswords: (hid: number) =>
    req<{ ok: boolean; count: number; password: string }>(`/api/hospitals/${hid}/clients/reset-all`, { method: "POST" }),
  // 휴대폰 촬영(QR) — 세션 생성/상태 폴링
  mobileCapture: (studyId: number, origin: string) =>
    isLiveId(studyId)
      ? liveBlocked("휴대폰 촬영(QR)") as Promise<{ token: string; url: string; qr: string; expires_in: number }>
      : req<{ token: string; url: string; qr: string; expires_in: number }>(
          `/api/studies/${studyId}/mobile-capture`, { method: "POST", body: JSON.stringify({ origin }) }),
  mobileCaptureStatus: (token: string) =>
    req<{ uploaded: number; done: boolean; series_uid: string }>(`/api/mobile-capture/${token}/status`),
  // 병원별 뷰어 영상 전송 형식 — rendered 호출 포맷/품질
  hospImageFormat: (hid: number) =>
    req<{ format: string; quality: number; wado_ts?: string }>(`/api/hospitals/${hid}/image-format`),
  hospImageFormatTsSupport: (hid: number) =>
    req<{ options: { uid: string; label: string; supported: boolean }[] }>(
      `/api/hospitals/${hid}/image-format/ts-support`),
  hospImageFormatPut: (hid: number, body: { format: string; quality: number; wado_ts?: string }) =>
    req(`/api/hospitals/${hid}/image-format`, { method: "PUT", body: JSON.stringify(body) }),
  // 병원별 Storage — 현황/정책/수동백업/이력/보존
  hospStorageSummary: (hid: number) =>
    req<{ studies: number; series: number; instances: number;
          disk: { path: string; free_gb: number | null; total_gb: number | null };
          retention_days: number; retention_over: number }>(`/api/hospitals/${hid}/storage/summary`),
  hospStoragePolicy: (hid: number) =>
    req<{ enabled: boolean; schedule_time: string; retention_days: number; compression: string; target_dir: string }>(
      `/api/hospitals/${hid}/storage/policy`),
  hospStoragePolicyPut: (hid: number, body: { enabled: boolean; schedule_time: string; retention_days: number; compression: string; target_dir: string }) =>
    req(`/api/hospitals/${hid}/storage/policy`, { method: "PUT", body: JSON.stringify(body) }),
  hospStorageCompressions: (hid: number) =>
    req<{ items: { key: string; label: string }[] }>(`/api/hospitals/${hid}/storage/compressions`),
  hospStorageBackup: (hid: number, body: { compression?: string; date_from?: string; date_to?: string }) =>
    req(`/api/hospitals/${hid}/storage/backup`, { method: "POST", body: JSON.stringify(body) }),
  hospStorageJobs: (hid: number) =>
    req<{ items: { id: number; kind: string; status: string; compression: string; study_count: number | null;
                   instance_count: number | null; total_bytes: number | null; error: string | null;
                   finished_at: string | null }[] }>(`/api/hospitals/${hid}/storage/jobs`),
  hospStoragePurgePreview: (hid: number, retention_days: number) =>
    req<{ count: number; items: { id: number; study_date: string; modality: string; study_desc: string }[] }>(
      `/api/hospitals/${hid}/storage/purge-preview`, { method: "POST", body: JSON.stringify({ retention_days }) }),
  hospStoragePurge: (hid: number, retention_days: number) =>
    req<{ ok: boolean; deleted: number; orthanc_removed: number }>(
      `/api/hospitals/${hid}/storage/purge`, { method: "POST", body: JSON.stringify({ retention_days, confirm: true }) }),
  // 병원·계정 설정 백업/복원 — 항목 선택 → JSON export/import
  backupHospital: (hid: number, items: string[]) =>
    req<{ meta: { hospital: string; hospital_id: number; code: string; generated_at: string; version: number; items: string[] }; data: Record<string, unknown> }>(
      `/api/hospitals/${hid}/backup`, { method: "POST", body: JSON.stringify({ items }) }),
  restoreHospital: (hid: number, backup: unknown, items: string[]) =>
    req<{ ok: boolean; restored: string[] }>(`/api/hospitals/${hid}/restore`, { method: "POST", body: JSON.stringify({ backup, items }) }),
  // 비밀번호 변경(최초 로그인 강제변경·자율변경 공용) — 현재 비번 재확인 + 새 비번
  changePassword: (current_password: string, new_password: string) =>
    req<{ ok: boolean }>("/api/auth/change-password", { method: "POST", body: JSON.stringify({ current_password, new_password }) }),
  enterClient: (hid: number, cid: number) =>
    req<{ ok: boolean; hospital_id: number; client_id: number; client_name: string }>(
      `/api/hospitals/${hid}/clients/${cid}/enter`, { method: "POST" }),
  clientHeartbeat: (hid: number, cid: number) =>
    req<{ ok: boolean }>(`/api/hospitals/${hid}/clients/${cid}/heartbeat`, { method: "POST" }),
  /** 검사 상세. opts.related=false 면 과거검사 목록을 빼고 받는다(뷰어 오픈 경로).
   *  Live 는 A 의 환자별 검사 검색이 느린 사이트가 있어(실측 4.11s) 이것이 오픈을 막았다. */
  study: (id: number, opts?: { related?: boolean }) => {
    const skip = opts?.related === false && isLiveId(id);
    return req<StudyDetail>(
      isLiveId(id) ? `${LIVE}/studies/${id}${skip ? "?related=0" : ""}` : `/api/studies/${id}`,
    ).then((d) => {
      if (isLiveId(id)) registerLiveStudyVid(d.study_uid, id);   // rendered 루트 + 3D vid 역참조
      return d;
    });
  },
  /** 과거검사(동일 환자) — 화면을 띄운 뒤 따로 채운다. Live 전용(로컬은 study 응답에 이미 포함). */
  relatedExams: (id: number) =>
    isLiveId(id)
      ? req<{ items: StudyDetail["related_exams"] }>(`${LIVE}/studies/${id}/related`)
          .then((r) => r.items ?? [])
      : Promise.resolve([] as StudyDetail["related_exams"]),
  reports: (studyId: number) =>
    req<{ items: Report[] }>(isLiveId(studyId) ? `${LIVE}/studies/${studyId}/reports`
                                               : `/api/studies/${studyId}/reports`),
  analyze: (studyId: number) =>
    isLiveId(studyId) ? liveBlocked("AI 분석") as Promise<{ job_id: number }>
      : req<{ job_id: number }>(`/api/studies/${studyId}/analyze`, { method: "POST" }),
  updateReport: (id: number, sr_json: SrJson, cvr = false) =>
    req<Report>(isLiveId(id) ? `${LIVE}/reports/${id}` : `/api/reports/${id}`,
                { method: "PUT", body: JSON.stringify(isLiveId(id) ? { sr_json, cvr } : { sr_json }) }),
  finalizeReport: (id: number, cvr = false) =>
    req<Report>(isLiveId(id) ? `${LIVE}/reports/${id}/finalize` : `/api/reports/${id}/finalize`,
                { method: "POST", ...(isLiveId(id) ? { body: JSON.stringify({ cvr }) } : {}) }),
  batchReview: () => req<{ items: BatchCandidate[] }>("/api/batch-review"),
  batchFinalize: (report_ids: number[]) =>
    req<{ finalized: number; total: number }>("/api/reports/batch-finalize", {
      method: "POST",
      body: JSON.stringify({ report_ids }),
    }),
  suspendReport: (id: number) =>
    isLiveId(id) ? liveBlocked("판독 보류") as Promise<Report>
      : req<Report>(`/api/reports/${id}/suspend`, { method: "POST" }),
  confirm2Report: (id: number) =>
    isLiveId(id) ? liveBlocked("2차 승인") as Promise<Report>
      : req<Report>(`/api/reports/${id}/confirm2`, { method: "POST" }),
  sendSr: (reportId: number) =>
    isLiveId(reportId) ? liveBlocked("DICOM SR 전송") as Promise<{ ok: boolean; sop_instance_uid: string }>
      : req<{ ok: boolean; sop_instance_uid: string }>(`/api/reports/${reportId}/send-sr`, {
          method: "POST",
        }),
  getSetting: (key: string) => req<{ key: string; value: Record<string, unknown> }>(`/api/settings/${key}`),
  putSetting: (key: string, value: Record<string, unknown>, scope: "user" | "global") =>
    req<{ ok: boolean }>(`/api/settings/${key}`, {
      method: "PUT",
      body: JSON.stringify({ value, scope }),
    }),
  aiQuality: () => req<AiQuality>("/api/admin/ai-quality"),
  instances: (studyId: number) =>
    req<{ items: InstanceThumb[]; key_images: KeyImage[] }>(
      isLiveId(studyId) ? `${LIVE}/studies/${studyId}/instances`
                        : `/api/studies/${studyId}/instances`),
  setKeyImages: (studyId: number, items: KeyImage[]) =>
    isLiveId(studyId) ? liveBlocked("키이미지 등록") as Promise<{ ok: boolean }>
      : req<{ ok: boolean }>(`/api/studies/${studyId}/key-images`, {
          method: "PUT",
          body: JSON.stringify({ items }),
        }),
  sendKos: (studyId: number) =>
    isLiveId(studyId) ? liveBlocked("KOS 전송") as Promise<{ ok: boolean }>
      : req<{ ok: boolean }>(`/api/studies/${studyId}/send-kos`, { method: "POST" }),
  setPriority: (studyId: number, emergency: boolean) =>
    req<{ ok: boolean }>(
      isLiveId(studyId) ? `${LIVE}/studies/${studyId}/priority` : `/api/studies/${studyId}/priority`, {
        method: "PUT",
        body: JSON.stringify({ emergency }),
      }),
  orthancStatus: () => req<OrthancStatus>("/api/admin/orthanc-status"),
  importDicom: (files: File[]) => {
    const fd = new FormData();
    for (const f of files) fd.append("files", f, f.name);
    // 선택 병원 귀속 — 병원 스코프 워크리스트에서도 Import 검사가 보이도록
    const hid = localStorage.getItem("sv_active_hospital");
    return req<{ processed: number; uploaded: number; registered: number; saved_dir?: string;
                 results: { filename: string; size: number; status: string }[] }>(
      `/api/import-dicom${hid ? `?hospital_id=${hid}` : ""}`, { method: "POST", body: fd });
  },
  // ── DICOM 내보내기 — 워크리스트 선택 검사를 폴더/USB·ZIP·CD용 ISO 로 반출 ──
  exportManifest: (studyIds: string) =>
    req<{ studies: { id: number; patient_key: string; patient_name: string; study_date: string;
                     modality: string; study_desc: string; count: number;
                     files: { path: string; sop_uid: string; series_uid: string }[] }[];
          total_files: number }>(`/api/export/manifest?study_ids=${encodeURIComponent(studyIds)}`),
  /** 단일 DICOM — 폴더/USB 저장이 한 장씩 받아 기록한다 */
  exportFile: async (studyId: number, sopUid: string): Promise<ArrayBuffer> => {
    const r = await fetch(
      `${BASE}/api/export/file?study_id=${studyId}&sop_uid=${encodeURIComponent(sopUid)}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
    if (!r.ok) throw new Error(`영상 취득 실패 (${r.status})`);
    return r.arrayBuffer();
  },
  /** ZIP·ISO 내려받기 URL — 브라우저가 직접 받도록 토큰을 쿼리로 실어 준다(다운로드는 헤더를 못 붙임) */
  exportPackageUrl: (studyIds: string, format: "zip" | "iso") => {
    const t = token ?? localStorage.getItem("sv_token") ?? sessionStorage.getItem("sv_token") ?? "";
    return `${BASE}/api/export/package?study_ids=${encodeURIComponent(studyIds)}`
         + `&format=${format}&token=${encodeURIComponent(t)}`;
  },
  // ── WebPACS 브리지 — 인계 웹서비스(webpacs_api) 검사 탐색·가져오기 ──
  webpacsConfig: () => req<{ value: WebPacsConfig }>("/api/webpacs/config"),
  webpacsSaveConfig: (value: Partial<WebPacsConfig> & { password?: string }) =>
    req<{ ok: boolean; value: WebPacsConfig }>("/api/webpacs/config", {
      method: "PUT", body: JSON.stringify({ value }),
    }),
  webpacsTest: () => req<{ ok: boolean; study_count?: number; detail?: string }>(
    "/api/webpacs/test", { method: "POST" }),
  webpacsStudies: (params: Record<string, string | number>) => {
    const qs = Object.entries(params).filter(([, v]) => v !== "" && v !== undefined)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
    return req<{ items: WebPacsStudy[]; total: number }>(`/api/webpacs/studies${qs ? `?${qs}` : ""}`);
  },
  webpacsImport: (remoteIdx: number) =>
    req<{ status: string; study_id?: number }>(`/api/webpacs/import/${remoteIdx}`, { method: "POST" }),
  webpacsImportStatus: (remoteIdx: number) =>
    req<{ status: string; study_id?: number | null; total?: number; done?: number;
          failed?: number; error?: string | null }>(`/api/webpacs/import/${remoteIdx}/status`),
  /** Compare 후보 — 환자 기준/판독의사 기준. Live(vid) 든 로컬이든 같은 계약. */
  compareCandidates: (studyId: number, query: string) =>
    req<{ items: RelatedExam[]; basis: string; period: string;
          by_modality: boolean; by_body_part: boolean }>(
      (isLiveId(studyId) ? `${LIVE}/studies/${studyId}/compare-candidates`
                         : `/api/studies/${studyId}/compare-candidates`) + `?${query}`),
  /** 배정의 판독 대기 배지 — A 세션 없으면 pending:null(숨김) */
  liveMyPending: () => req<{ pending: number | null }>(`${LIVE}/my-pending`),
  seriesTree: (studyId: number) =>
    req<{ study_uid: string; series: SeriesNode[] }>(
      isLiveId(studyId) ? `${LIVE}/studies/${studyId}/series-tree`
                        : `/api/studies/${studyId}/series-tree`)
      .then((tree) => {
        if (isLiveId(studyId)) {
          registerLiveStudyVid(tree.study_uid, studyId);
          for (const s of tree.series) {
            for (const i of s.instances) registerLiveStudyUid(i.study_uid);
          }
        }
        return tree;
      }),
  // ── WebPACS Live — 원격 PACS(A) 계정으로 직접 로그인(per-user, 요구4) ──
  webpacsLogin: (user_id: string, user_passwd: string, base_url = "") =>
    req<{ token: string; username: string; role: string; a_user_name: string; a_user_idx: number | null }>(
      "/api/auth/webpacs-login", { method: "POST", body: JSON.stringify({ user_id, user_passwd, base_url }) }),
  // ── WebPACS Live 전용 — 실시간 상태/presence·선점 ──
  liveWorklist: (params: Record<string, string | number>) => {
    const qs = Object.entries(params).filter(([, v]) => v !== "" && v !== undefined)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
    return req<{ items: StudyRow[]; total: number }>(`${LIVE}/worklist${qs ? `?${qs}` : ""}`);
  },
  liveState: (studyId: number) =>
    req<{ study_status: string; status: string; read_state: string; report_locked: boolean;
          assignee: string; report_status: string; report_updated: string;
          report_writer: string; viewers: string[];
          other_writing: boolean; other_writers: string[] }>(`${LIVE}/studies/${studyId}/state`),
  /** A SSE 구독 상태 — rev 가 바뀌면 원격에 변경이 생긴 것(폴링 대체).
   *  connected=false 면 호출부가 기존 주기 폴링으로 폴백한다. */
  liveSseStatus: () =>
    req<{ enabled: boolean; connected: boolean; rev: number; last_event_at: number;
          changed_studies: number[]; error: string }>(`${LIVE}/sse-status`),
  // 검사 오픈 시 A→B 원본 병렬 예열(지연 은닉) — 실패해도 온디맨드 렌더로 폴백
  livePrefetch: (studyId: number) =>
    req<{ ok: boolean }>(`${LIVE}/studies/${studyId}/prefetch`, { method: "POST" }).catch(() => ({ ok: false })),
  liveClaim: (studyId: number) =>
    req<{ status: number; message: string }>(`${LIVE}/studies/${studyId}/claim`, { method: "POST" }),
  liveRelease: (studyId: number) =>
    req<{ status: number; message: string }>(`${LIVE}/studies/${studyId}/release`, { method: "POST" }),
  nlQuery: (text: string) =>
    req<NlQueryResult>("/api/worklist/nl-query", { method: "POST", body: JSON.stringify({ text }) }),
  mergeReports: (study_ids: number[]) =>
    req<Report>("/api/reports/merge", { method: "POST", body: JSON.stringify({ study_ids }) }),
  // 저장 표시상태(시리즈별) — 적용 툴 값. shutter 는 {kind, pts(정규화 0~1)} 또는 null
  annotations: (studyId: number) =>
    req<{ items: Anno[] }>(isLiveId(studyId) ? `${LIVE}/studies/${studyId}/annotations`
                                             : `/api/studies/${studyId}/annotations`),
  saveAnnotations: (studyId: number, items: Anno[]) =>
    req<{ ok: boolean; count: number }>(
      isLiveId(studyId) ? `${LIVE}/studies/${studyId}/annotations`
                        : `/api/studies/${studyId}/annotations`, {
      method: "PUT", body: JSON.stringify({ items }),
    }),
  // 검사 표시상태(적용 툴: W/L·방향·필터·셔터) 저장/로드 — 재오픈 시 재현. series 는 {series_uid: PState}
  savePresentation: (studyId: number, series: Record<string, PState>) =>
    req<{ ok: boolean; series: number }>(
      isLiveId(studyId) ? `${LIVE}/studies/${studyId}/presentation`
                        : `/api/studies/${studyId}/presentation`, {
      method: "PUT", body: JSON.stringify({ series }),
    }),
  presentation: (studyId: number) =>
    req<{ series: Record<string, PState> }>(
      isLiveId(studyId) ? `${LIVE}/studies/${studyId}/presentation`
                        : `/api/studies/${studyId}/presentation`),
  ctr: (studyId: number) =>
    isLiveId(studyId) ? liveBlocked("CTR 자동계측") as Promise<CtrResult>
      : req<CtrResult>(`/api/studies/${studyId}/ctr`, { method: "POST" }),
  sendGsps: (studyId: number, body: {
    images: { sop_uid: string; series_uid: string; rows: number; cols: number }[];
    annotations: Anno[]; wc?: number | null; ww?: number | null; label?: string;
  }) =>
    isLiveId(studyId) ? liveBlocked("GSPS 전송") as Promise<{ ok: boolean; sop_instance_uid: string }>
      : req<{ ok: boolean; sop_instance_uid: string }>(`/api/studies/${studyId}/send-gsps`, {
          method: "POST", body: JSON.stringify(body),
        }),
  /** GSPS 불러오기 — 검사에 귀속된 PR(타사 포함) 주석·W/L 파싱. Live=빈 목록 */
  loadGsps: (studyId: number) =>
    isLiveId(studyId) ? Promise.resolve({ items: [] as GspsItem[] })
      : req<{ items: GspsItem[] }>(`/api/studies/${studyId}/gsps`),
  /** ROI HU 통계(드래그 W/L·HU ROI 통계) — points는 0~1 정규화. Live 도 서버 픽셀 경로 지원 */
  roiStats: (studyId: number, body: { sop_uid: string; kind: string; points: number[][] }) =>
    req<RoiStats>(isLiveId(studyId) ? `${LIVE}/studies/${studyId}/roi-stats`
                                    : `/api/studies/${studyId}/roi-stats`,
                  { method: "POST", body: JSON.stringify(body) }),
  orders: (params: Record<string, string> = {}) =>
    req<{ items: OrderRow[] }>(`/api/orders?${new URLSearchParams(params)}`),
  createOrder: (body: Partial<OrderRow>) =>
    req<OrderRow>("/api/orders", { method: "POST", body: JSON.stringify(body) }),
  setOrderStatus: (id: number, status: string) =>
    req<OrderRow>(`/api/orders/${id}/status`, { method: "PUT", body: JSON.stringify({ status }) }),
  /** 오더 수정 — scheduled 상태만 허용(그 외 409) */
  updateOrder: (id: number, body: Partial<OrderRow>) =>
    req<OrderRow>(`/api/orders/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  /** 오더 삭제 */
  deleteOrder: (id: number) =>
    req<{ ok: boolean }>(`/api/orders/${id}`, { method: "DELETE" }),
  exportMwl: () =>
    req<{ ok: boolean; count: number; dir: string }>("/api/orders/export-mwl", { method: "POST" }),
  setBookmark: (studyId: number, bookmark: boolean) =>
    req<{ ok: boolean; bookmark: boolean }>(
      isLiveId(studyId) ? `${LIVE}/studies/${studyId}/bookmark` : `/api/studies/${studyId}/bookmark`, {
        method: "PUT", body: JSON.stringify({ bookmark }),
      }),
  setMemo: (studyId: number, memo: string) =>
    // Live: A study_comment 로 저장(요구5 — 무성 유실 제거)
    req<{ ok: boolean }>(
      isLiveId(studyId) ? `${LIVE}/studies/${studyId}/memo` : `/api/studies/${studyId}/memo`, {
        method: "PUT", body: JSON.stringify({ memo }),
      }),
  phrases: () => req<{ items: PhraseRow[] }>("/api/phrases"),
  createPhrase: (body: Partial<PhraseRow>) =>
    req<PhraseRow>("/api/phrases", { method: "POST", body: JSON.stringify(body) }),
  updatePhrase: (id: number, body: Partial<PhraseRow>) =>
    req<PhraseRow>(`/api/phrases/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deletePhrase: (id: number) =>
    req<{ ok: boolean }>(`/api/phrases/${id}`, { method: "DELETE" }),
  profile: () => req<Profile>("/api/auth/profile"),
  putProfile: (display_name: string, license_no: string, major_no = "") =>
    req<{ ok: boolean }>("/api/auth/profile", {
      method: "PUT", body: JSON.stringify({ display_name, license_no, major_no }),
    }),
  /** 공유 폴더 목록 — sub=상대 하위경로(생략=루트). 폴더 클릭 진입 지원 */
  shareList: (sub?: string) =>
    req<{ dir: string; sub: string; items: { name: string; is_dir: boolean; size: number; mtime: number }[] }>(
      `/api/share${sub ? `?sub=${encodeURIComponent(sub)}` : ""}`),
  /** 현재 공유 디렉토리 설정 조회 — 미설정이어도 404 아님(설정 화면 초기 표시용) */
  shareConfig: () =>
    req<{ dir: string; exists: boolean }>("/api/share/config"),
  /** 서버측 폴더 탐색(관리자 전용) — path 빈값=드라이브 목록+현재 공유 디렉토리.
   *  files 지정(확장자, 예 "exe") 시 해당 확장자 파일 목록도 반환(실행 파일 선택용). */
  shareFs: (path?: string, files?: string) =>
    req<{ path: string; parent: string | null; dirs: { name: string; path: string }[];
          files: { name: string; path: string }[]; exists: boolean; share_dir?: string }>(
      `/api/share/fs?path=${encodeURIComponent(path ?? "")}${files ? `&files=${encodeURIComponent(files)}` : ""}`),
  netPing: (ip: string, port?: number) =>
    req<{ ok: boolean; icmp: boolean; icmp_ms: number; tcp: boolean | null }>("/api/admin/net-test/ping", {
      method: "POST", body: JSON.stringify({ ip, port }),
    }),
  netEcho: (ip: string, port: number, ae_title: string) =>
    req<{ ok: boolean; detail: string }>("/api/admin/net-test/echo", {
      method: "POST", body: JSON.stringify({ ip, port, ae_title }),
    }),
  netDb: () =>
    req<{ ok: boolean; latency_ms?: number; dialect?: string; target?: string; detail?: string }>(
      "/api/admin/net-test/db", { method: "POST" }),
  applyDicomNodes: () =>
    req<{ ok: boolean; applied: number; errors: string[] }>("/api/admin/dicom-nodes/apply", {
      method: "POST",
    }),

  // ── 서버 관리 1단계: 역할·병원·계정·장비·SCP ──
  roleCatalog: () => req<RoleCatalog>("/api/admin/roles"),
  hospitals: () => req<{ items: HospitalRow[] }>("/api/admin/hospitals"),
  createHospital: (body: Partial<HospitalRow>) =>
    req<HospitalRow>("/api/admin/hospitals", { method: "POST", body: JSON.stringify(body) }),
  updateHospital: (id: number, body: Partial<HospitalRow>) =>
    req<HospitalRow>(`/api/admin/hospitals/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteHospital: (id: number) =>
    req<{ ok: boolean }>(`/api/admin/hospitals/${id}`, { method: "DELETE" }),
  hospitalNetTest: (id: number) =>
    req<HospitalNetResult>(`/api/admin/hospitals/${id}/net-test`, { method: "POST" }),
  claimStudies: (id: number) =>
    req<{ ok: boolean; assigned: number }>(`/api/admin/hospitals/${id}/claim-studies`, { method: "POST" }),

  // ── 병원별 관리 (레인 F/B 공통 계약 — 백엔드는 레인 B가 병렬 구현) ──
  /** 병원별 DB·Storage 사용량 */
  hospitalUsage: (hid: number) => req<HospitalUsage>(`/api/hospitals/${hid}/usage`),
  /** 병원별 등급 권한 매트릭스 (GET=기본값 폴백 병합) */
  // 병원 기본 워크리스트·뷰어 설정 — 설정>워크리스트와 동일 구현(계정 설정 없으면 이 값으로 폴백)
  hospWlSetting: (hid: number, key: string) =>
    req<{ key: string; value: Record<string, unknown> }>(`/api/hospitals/${hid}/wl-setting/${key}`),
  putHospWlSetting: (hid: number, key: string, value: Record<string, unknown>) =>
    req<{ ok: boolean }>(`/api/hospitals/${hid}/wl-setting/${key}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),
  permMatrix: (hid: number) => req<PermMatrixResp>(`/api/hospitals/${hid}/perm-matrix`),
  /** 병원별 권한 매트릭스 저장 (관리자 — hospital 스코프 setting 'perm.matrix') */
  putPermMatrix: (hid: number, matrix: Record<string, string[]>) =>
    req<PermMatrixResp>(`/api/hospitals/${hid}/perm-matrix`, { method: "PUT", body: JSON.stringify({ matrix }) }),
  /** 병원별 SCP Modality 노드 목록 (setting 'modality.nodes') */
  hospitalModalities: (hid: number) => req<{ items: ModalityNode[] }>(`/api/hospitals/${hid}/modalities`),
  putHospitalModalities: (hid: number, items: ModalityNode[]) =>
    req<{ items: ModalityNode[] }>(`/api/hospitals/${hid}/modalities`, { method: "PUT", body: JSON.stringify({ items }) }),
  /** 병원별 Modality 연결 테스트 (ping/echo — admin net-test 재사용, 병원 접근 가드) */
  testHospitalModality: (hid: number, body: { ip: string; port: number; ae_title?: string; mode: "ping" | "echo" }) =>
    req<ModalityTestResult>(`/api/hospitals/${hid}/modalities/test`, { method: "POST", body: JSON.stringify(body) }),
  /** 병원 SCU/식별 정보 (병원명·ae_title=Hospital 컬럼, ip/port=setting 'hospital.scu') */
  hospitalScu: (hid: number) => req<HospitalScu>(`/api/hospitals/${hid}/scu`),
  putHospitalScu: (hid: number, body: HospitalScu) =>
    req<HospitalScu>(`/api/hospitals/${hid}/scu`, { method: "PUT", body: JSON.stringify(body) }),
  /** 내 유효 권한 (병원 매트릭스 반영 — 워크리스트/뷰어 게이트용) */
  permMe: () => req<PermMe>("/api/perm/me"),

  // ── 협진(Co-Reading) — 실시간 경로는 lib/collab.ts(WebSocket)가 담당하고,
  //    여기는 최초 로드 목록과 WS 가 끊겼을 때도 되어야 하는 조작만 맡는다. ──
  collabDirectory: (q = "", otherOnly = false) =>
    req<{ items: CollabUser[]; caps: Record<string, string> }>(
      `/api/collab/directory?q=${encodeURIComponent(q)}${otherOnly ? "&other_only=true" : ""}`),
  collabFriends: () => req<CollabFriends>("/api/collab/friends"),
  collabRequestFriend: (target_id: number, message = "") =>
    req<{ ok: boolean; result: string }>("/api/collab/friends/request",
      { method: "POST", body: JSON.stringify({ target_id, message }) }),
  collabRespondFriend: (other_id: number, accept: boolean) =>
    req<{ ok: boolean }>("/api/collab/friends/respond",
      { method: "POST", body: JSON.stringify({ other_id, accept }) }),
  collabBlockFriend: (other_id: number, blocked: boolean) =>
    req<{ ok: boolean }>(`/api/collab/friends/block?blocked=${blocked}`,
      { method: "POST", body: JSON.stringify({ other_id }) }),
  collabRemoveFriend: (other_id: number) =>
    req<{ ok: boolean }>("/api/collab/friends/remove",
      { method: "POST", body: JSON.stringify({ other_id }) }),
  /** 룸 백필 — WS 로는 신규만 오므로 과거 메시지는 여기서 읽는다(before_id = 무한 스크롤) */
  collabMessages: (room: string, before_id = 0) =>
    req<{ items: CollabMessage[] }>(
      `/api/collab/messages?room=${encodeURIComponent(room)}${before_id ? `&before_id=${before_id}` : ""}`),
  collabMarkRead: (room: string) =>
    req<{ ok: boolean; marked: number }>("/api/collab/messages/read",
      { method: "POST", body: JSON.stringify({ room }) }),
  collabOpenSession: (study_id: number, title = "") =>
    req<CollabSession>("/api/collab/sessions",
      { method: "POST", body: JSON.stringify({ study_id, title }) }),
  collabSessions: () => req<{ items: CollabSession[] }>("/api/collab/sessions"),
  collabSession: (code: string) => req<CollabSession>(`/api/collab/sessions/${code}`),
  collabInvite: (code: string, target_id: number) =>
    req<CollabSession>(`/api/collab/sessions/${code}/invite`,
      { method: "POST", body: JSON.stringify({ target_id }) }),
  collabDecline: (code: string) =>
    req<{ ok: boolean }>(`/api/collab/sessions/${code}/decline`, { method: "POST" }),
  collabLeave: (code: string) =>
    req<{ ok: boolean }>(`/api/collab/sessions/${code}/leave`, { method: "POST" }),
  /** 세션 종료(Master 전용) — 전 참가자의 임시 열람권이 이 시점에 무효화된다 */
  collabClose: (code: string) =>
    req<{ ok: boolean }>(`/api/collab/sessions/${code}/close`, { method: "POST" }),
  /** 참가자 한 사람의 허용 범위 조정(Master 전용) — 남의 권한은 건드리지 않는다 */
  collabSetCaps: (code: string, target_id: number, caps: string[]) =>
    req<CollabSession>(`/api/collab/sessions/${code}/caps`,
      { method: "POST", body: JSON.stringify({ target_id, caps }) }),
  /** 참가자의 세션 주석을 정식 판독 주석으로 채택(Master 전용) */
  collabAdopt: (code: string, target_id: number) =>
    req<{ ok: boolean; adopted: number }>(`/api/collab/sessions/${code}/adopt`,
      { method: "POST", body: JSON.stringify({ target_id }) }),
  /** 검사 관리 작업 (삭제/이동/매칭/언매칭/복제 — 유효 권한 강제, 403 시 안내) */
  studyAdminAction: (id: number, body: { action: StudyAdminActionKind; target_hid?: number; order_id?: number | string }) =>
    req<{ ok: boolean; detail?: string }>(`/api/studies/${id}/admin-action`, { method: "POST", body: JSON.stringify(body) }),
  /** 특정 병원 스코프 워크리스트 (관리 콘솔 — localStorage 선택 병원과 무관) */
  hospitalWorklist: (hid: number, params: Record<string, string> = {}) =>
    req<{ items: StudyRow[]; total: number }>(
      `/api/worklist?${new URLSearchParams({ ...params, hospital_id: String(hid) })}`),
  accounts: () => req<{ items: AccountRow[] }>("/api/admin/accounts"),
  createAccount: (body: AccountCreateBody) =>
    req<AccountRow>("/api/admin/accounts", { method: "POST", body: JSON.stringify(body) }),
  updateAccount: (id: number, body: Partial<AccountCreateBody>) =>
    req<AccountRow>(`/api/admin/accounts/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteAccount: (id: number) =>
    req<{ ok: boolean }>(`/api/admin/accounts/${id}`, { method: "DELETE" }),
  modalities: () => req<{ items: ModalityRow[] }>("/api/admin/modalities"),
  createModality: (body: Partial<ModalityRow>) =>
    req<ModalityRow>("/api/admin/modalities", { method: "POST", body: JSON.stringify(body) }),
  updateModality: (id: number, body: Partial<ModalityRow>) =>
    req<ModalityRow>(`/api/admin/modalities/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteModality: (id: number) =>
    req<{ ok: boolean }>(`/api/admin/modalities/${id}`, { method: "DELETE" }),
  applyModalities: () =>
    req<{ ok: boolean; applied: number; removed: number; errors: string[]; detail?: string }>(
      "/api/admin/modalities/apply", { method: "POST" }),
  scpStatus: () => req<ScpStatus>("/api/admin/scp-status"),
  scpConfig: (body: { receive_enabled: boolean; registered_only: boolean; check_called_aet: boolean }) =>
    req<{ ok: boolean; config: ScpConfig; generated_files: string[]; note: string }>(
      "/api/admin/scp-config", { method: "POST", body: JSON.stringify(body) }),

  // ── 서버 관리 2단계: 저장공간·백업·압축 ──
  storage: () => req<StorageOverview>("/api/admin/storage"),
  backupPolicy: () => req<BackupPolicy>("/api/admin/backup/policy"),
  putBackupPolicy: (body: BackupPolicy) =>
    req<BackupPolicy>("/api/admin/backup/policy", { method: "PUT", body: JSON.stringify(body) }),
  backupCompressions: () =>
    req<{ items: { key: string; label: string }[] }>("/api/admin/backup/compressions"),
  runBackup: (body: { compression?: string; target_dir?: string; date_from?: string; date_to?: string }) =>
    req<BackupJobRow>("/api/admin/backup/run", { method: "POST", body: JSON.stringify(body) }),
  backupJobs: () => req<{ items: BackupJobRow[] }>("/api/admin/backup/jobs"),
  purgePreview: (retention_days: number) =>
    req<{ count: number; items: { id: number; study_uid: string; study_date: string; modality: string; study_desc: string }[] }>(
      "/api/admin/storage/purge-preview", { method: "POST", body: JSON.stringify({ retention_days }) }),
  purge: (retention_days: number) =>
    req<{ ok: boolean; deleted: number; orthanc_removed: number }>(
      "/api/admin/storage/purge", { method: "POST", body: JSON.stringify({ retention_days, confirm: true }) }),

  // ── 서버 유지보수 (14개 요구 — 레인 F/B 공통 계약, 백엔드는 레인 B 병렬 구현) ──
  /** 저장 공간 현황 — DB/Image/Backup 크기·디스크 여유 */
  maintStorage: () => req<MaintStorage>("/api/maintenance/storage"),
  /** 백업 정책(확장) — 반복 5종·시:분:초·quota·미러·DB백업 */
  maintBackupPolicy: () => req<MaintBackupPolicy>("/api/maintenance/backup-policy"),
  putMaintBackupPolicy: (body: MaintBackupPolicy) =>
    req<MaintBackupPolicy>("/api/maintenance/backup-policy", { method: "PUT", body: JSON.stringify(body) }),
  /** 지금 백업 실행 — kind: dicom | db | both (응답 items = 생성된 작업들) */
  maintBackupRun: (kind: "dicom" | "db" | "both") =>
    req<{ ok: boolean; detail?: string; items?: MaintBackupItem[] }>("/api/maintenance/backup-run", { method: "POST", body: JSON.stringify({ kind }) }),
  /** 백업 이력 */
  maintBackups: () => req<{ items: MaintBackupItem[] }>("/api/maintenance/backups"),
  /** 복원 — dry=true 는 복원 요약만(미리보기) */
  maintRestore: (body: { backup_id: number | string; scope: "system" | "hospital"; hid?: number; dry?: boolean }) =>
    req<MaintRestoreResult>("/api/maintenance/restore", { method: "POST", body: JSON.stringify(body) }),
  /** 데이터 지우기(파괴적) — confirm 은 반드시 'WIPE' 문자열 */
  maintWipe: (body: { scope: "hospital" | "system"; hid?: number; confirm: string }) =>
    req<{ ok: boolean; detail?: string; deleted?: number; orthanc_removed?: number }>(
      "/api/maintenance/wipe", { method: "POST", body: JSON.stringify(body) }),
  /** 시스템 미러링 실행 */
  maintMirrorRun: () =>
    req<{ ok: boolean; detail?: string; copied?: number; skipped?: number; errors?: string[] }>(
      "/api/maintenance/mirror-run", { method: "POST" }),

  // ── 서버 포털 리스너 (서버 설정 IP:Port → 실제 응답하는 리다이렉트 리스너) ──
  /** 포털 리스너 현재 상태 */
  portalStatus: () => req<PortalStatus>("/api/maintenance/portal/status"),
  /** 지정 IP:Port 에 포털 리스너 (재)기동 — 바인드 실패는 예외(400) */
  portalApply: (ip: string, port: number) =>
    req<PortalStatus & { ok: boolean; warning?: string }>(
      "/api/maintenance/portal/apply", { method: "POST", body: JSON.stringify({ ip, port }) }),
  /** 포털 리스너 중지 */
  portalStop: () =>
    req<PortalStatus & { ok: boolean }>("/api/maintenance/portal/stop", { method: "POST" }),

  // ── 서버 인사이트 (DB 구조 · 시스템 로그 · 사용량 통계) ──
  /** DB 구조(read-only introspection) — 테이블/컬럼/행수 */
  insightsDbSchema: () => req<DbSchemaResp>("/api/insights/db-schema"),
  /** 외부 DB 도구 서버측 실행 — 설정키 server.dbtool(path) */
  insightsDbToolOpen: () => req<{ ok: boolean; detail?: string }>("/api/insights/db-tool-open", { method: "POST" }),
  /** 서버 PC 에 설치된 흔한 DB 도구 자동 탐지 — 경로 미설정 시 기본값 제안 */
  insightsDbToolDetect: () =>
    req<{ items: { label: string; path: string }[] }>("/api/insights/db-tool-detect"),
  /** 시스템 로그 — type=event|network|dicom, 날짜·검색·병원 필터 */
  insightsLogs: (params: Record<string, string>) =>
    req<{ items: LogItem[] }>(`/api/insights/logs?${new URLSearchParams(params)}`),
  /** 사용량 통계 — group=hospital|modality|department|report_status */
  insightsStats: (params: Record<string, string>) =>
    req<StatsResp>(`/api/insights/stats?${new URLSearchParams(params)}`),

  // ── 인프라 (시스템 구조도 — InfraPanel 로컬 fetch 와 동일 계약 /api/infra/hospitals) ──
  /** 병원별 Orthanc 컨테이너 현황 — state/ports/aet (미프로비저닝=entry null → 공유 Orthanc 폴백) */
  infraHospitals: () => req<InfraHospitalsRes>("/api/infra/hospitals"),
  /** 메인 컨테이너(saintview-*) 개별 제어 — start|stop|restart */
  infraContainerAction: (name: string, action: "start" | "stop" | "restart") =>
    req<{ ok: boolean; detail: string }>(`/api/infra/containers/${encodeURIComponent(name)}/action`,
      { method: "POST", body: JSON.stringify({ action }) }),
  /** 병원(자식) 컨테이너 제어 — start|stop|restart */
  infraHospitalAction: (hid: number, action: "start" | "stop" | "restart") =>
    req<{ ok: boolean; detail: string }>(`/api/infra/hospitals/${hid}/action`,
      { method: "POST", body: JSON.stringify({ action }) }),
  /** 메인 docker 스택(db·orthanc·ohif) 일괄 제어 — 부모 컨테이너 On/Off */
  infraMainAction: (action: "start" | "stop" | "restart") =>
    req<{ ok: boolean; detail: string }>("/api/infra/main/action",
      { method: "POST", body: JSON.stringify({ action }) }),
  /** 백엔드 API 프로세스 자체 재시작/중지 (Windows 서버측 분리 실행) */
  serverControl: (action: "restart" | "stop") =>
    req<{ ok: boolean; detail: string }>("/api/admin/server-control",
      { method: "POST", body: JSON.stringify({ action }) }),

  // ── Local Server 모드 (레인 F/B 공통 계약 /api/local — 서버 Orthanc/DB 와 완전 분리) ──
  /** 로컬 루트(server.network.local_share_dir) 하위 DB/Image/Temp 폴더 구조 생성(멱등) */
  localInit: () => req<{ ok: boolean; root: string; dirs: Record<string, string> }>("/api/local/init", { method: "POST" }),
  /** 로컬 Import — Temp 저장→pydicom 파싱→Image 배치→local.db 등록 */
  localImport: (files: File[]) => {
    const fd = new FormData();
    for (const f of files) fd.append("files", f, f.name);
    return req<{ imported: number; skipped: number; studies: LocalStudyRow[] }>(
      "/api/local/import", { method: "POST", body: fd });
  },
  /** 로컬 검사 목록 (local.db — 서버 worklist 와 무관) */
  localStudies: (q?: string) =>
    req<{ items: LocalStudyRow[] }>(`/api/local/studies${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  /** 로컬 검사 Series→Instance 트리 */
  localTree: (id: number) => req<{ series: LocalSeriesNode[] }>(`/api/local/studies/${id}/tree`),
  /** 로컬 검사 삭제 (파일+local.db) */
  localDelete: (id: number) => req<{ ok: boolean }>(`/api/local/studies/${id}`, { method: "DELETE" }),

  // ── Local Exam Control (레인 F/B 공통 계약 /api/local/examctl — 서버 examctl 과 동형 응답, local.db 소프트 삭제) ──
  /** 로컬 검사 목록(삭제 제외) — 서버 examctlStudies 동형 items */
  localExamctlStudies: (q?: string) =>
    req<{ items: StudyRow[]; total?: number }>(
      `/api/local/examctl/studies${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  /** 로컬 검사 Series→Image 트리(deleted 포함) — 인스턴스는 preview_url 대신 iid(프리뷰=localRendered) */
  localExamctlTree: (studyId: number) =>
    req<{ series: LocalExamCtlSeries[] }>(`/api/local/examctl/studies/${studyId}/tree`),
  /** 로컬 소프트 삭제(local.db deleted 컬럼) — Recovery 복구 가능 */
  localExamctlDelete: (body: ExamCtlUids) =>
    req<{ deleted_series: number; deleted_images: number }>(
      "/api/local/examctl/delete", { method: "POST", body: JSON.stringify(body) }),
  /** 로컬 휴지통 복구 */
  localExamctlRestore: (body: ExamCtlUids) =>
    req<{ ok?: boolean; restored_series?: number; restored_images?: number }>(
      "/api/local/examctl/restore", { method: "POST", body: JSON.stringify(body) }),
  /** 로컬 휴지통 목록 */
  localExamctlTrash: () => req<{ items: ExamCtlTrashItem[] }>("/api/local/examctl/trash"),
  /** 로컬 Unassign — 로컬 UNASSIGNED 버킷 검사로 이동 */
  localExamctlUnassign: (body: ExamCtlUids) =>
    req<{ moved: number; bucket_study_id: number }>(
      "/api/local/examctl/unassign", { method: "POST", body: JSON.stringify(body) }),
  /** 로컬 Assign — 로컬 검사 간 이동(자기 자신 400, sop 이동 시 시리즈 분할 — base UID 왕복 규칙 동일) */
  localExamctlAssign: (body: ExamCtlUids & { target_study_id: number }) =>
    req<{ moved: number }>("/api/local/examctl/assign", { method: "POST", body: JSON.stringify(body) }),

  // ── Exam Control (관리자 검사 QC — 레인 F/B 공통 계약 /api/examctl, 전부 감사 로그) ──
  /** 검사 목록(deleted 제외) — hid 생략 시 접근 가능한 전체 */
  examctlStudies: (hid?: number, q?: string) => {
    const p = new URLSearchParams();
    if (hid) p.set("hid", String(hid));
    if (q) p.set("q", q);
    const qs = p.toString();
    return req<{ items: StudyRow[]; total?: number }>(`/api/examctl/studies${qs ? `?${qs}` : ""}`);
  },
  /** 선택 검사의 Series→Image 트리(deleted 포함 — 표시는 회색 취소선) */
  examctlTree: (studyId: number) =>
    req<{ series: ExamCtlSeries[] }>(`/api/examctl/studies/${studyId}/tree`),
  /** 소프트 삭제(휴지통) — Recovery 로 복구 가능 */
  examctlDelete: (body: ExamCtlUids) =>
    req<{ deleted_series: number; deleted_images: number }>(
      "/api/examctl/delete", { method: "POST", body: JSON.stringify(body) }),
  /** 휴지통 복구 */
  examctlRestore: (body: ExamCtlUids) =>
    req<{ ok?: boolean; restored_series?: number; restored_images?: number }>(
      "/api/examctl/restore", { method: "POST", body: JSON.stringify(body) }),
  /** 휴지통 목록(검사/시리즈/이미지 단위 표시용) */
  examctlTrash: (hid?: number) =>
    req<{ items: ExamCtlTrashItem[] }>(`/api/examctl/trash${hid ? `?hid=${hid}` : ""}`),
  /** 현재 검사에서 분리 → 병원별 미배정(UNASSIGNED) 버킷 검사로 이동 */
  examctlUnassign: (body: ExamCtlUids) =>
    req<{ moved: number; bucket_study_id: number }>(
      "/api/examctl/unassign", { method: "POST", body: JSON.stringify(body) }),
  /** 대상 검사로 이동(재귀속) — 앱 DB 계층만 변경, Orthanc 원본·DICOM 태그 불변 */
  examctlAssign: (body: ExamCtlUids & { target_study_id: number }) =>
    req<{ moved: number }>("/api/examctl/assign", { method: "POST", body: JSON.stringify(body) }),

  // ── 환자 병합 (Exam Control Merge — 레인 F/B 공통 계약) ──
  /** 환자 병합 — Slave 환자의 전 검사를 Master 환자로 귀속(앱 DB 계층, Orthanc 불변) */
  examctlMerge: (body: { master_study_id: number; slave_study_id: number }) =>
    req<MergeResp>("/api/examctl/merge", { method: "POST", body: JSON.stringify(body) }),
  /** 병합 해제 — study_id(병합 환자의 아무 검사) 또는 merge_id 로 원상 복구 */
  examctlUnmerge: (body: { study_id?: number; merge_id?: number }) =>
    req<{ restored: number }>("/api/examctl/unmerge", { method: "POST", body: JSON.stringify(body) }),
  /** 활성(미해제) 병합 목록 */
  examctlMerges: (hid?: number) =>
    req<{ items: MergeItem[] }>(`/api/examctl/merges${hid ? `?hid=${hid}` : ""}`),
  /** 로컬 환자 병합 — 서버 merge 와 동형 (local.db) */
  localExamctlMerge: (body: { master_study_id: number; slave_study_id: number }) =>
    req<MergeResp>("/api/local/examctl/merge", { method: "POST", body: JSON.stringify(body) }),
  localExamctlUnmerge: (body: { study_id?: number; merge_id?: number }) =>
    req<{ restored: number }>("/api/local/examctl/unmerge", { method: "POST", body: JSON.stringify(body) }),
  localExamctlMerges: () => req<{ items: MergeItem[] }>("/api/local/examctl/merges"),

  // ── 판독 상태 (read_state — 하트비트/확정 잠금) ──
  /** 검사 활동 하트비트 — 뷰어 열림(viewer)/판독 작업(report). 45s 주기 권장, 서버 TTL 120s */
  activityHeartbeat: (study_ids: number[], kind: "viewer" | "report", typing = false) => {
    // Live(vid)와 로컬 id 분리 전송 — Live 는 인메모리 presence(B 클라이언트 간 열람 표시)
    const liveIds = study_ids.filter(isLiveId);
    const localIds = study_ids.filter((i) => !isLiveId(i));
    const calls: Promise<{ ok: boolean }>[] = [];
    if (localIds.length) {
      calls.push(req<{ ok: boolean }>("/api/activity/heartbeat", {
        method: "POST", body: JSON.stringify({ study_ids: localIds, kind, typing }) }));
    }
    if (liveIds.length) {
      calls.push(req<{ ok: boolean }>(`${LIVE}/heartbeat`, {
        method: "POST", body: JSON.stringify({ study_ids: liveIds, kind, typing }) }));
    }
    return Promise.all(calls).then(() => ({ ok: true }));
  },
  /** 판독 확정(잠금) 토글 — 잠금 중 판독 수정·확정·재생성·병합 전부 409.
   *  Live 는 원격 승인 상태(A/RA)가 곧 잠금 — 수동 토글 미지원 */
  reportLock: (studyId: number, locked: boolean) =>
    isLiveId(studyId) ? liveBlocked("확정 잠금 토글(원격 승인 상태를 따름)") as Promise<{ locked: boolean }>
      : req<{ locked: boolean }>(`/api/studies/${studyId}/report-lock`, {
          method: "POST", body: JSON.stringify({ locked }) }),
};

// ── Exam Control 타입 (레인 F/B 공통 계약 /api/examctl) ──
export interface ExamCtlUids { series_uids?: string[]; sop_uids?: string[] }
export interface ExamCtlImage {
  sop_uid: string;
  instance_number: number;
  rows: number;
  cols: number;
  deleted: boolean;
  preview_url: string;
}
export interface ExamCtlSeries {
  series_uid: string;
  series_number: number;
  series_desc: string;
  modality: string;
  deleted: boolean;
  instances: ExamCtlImage[];
}
/** 휴지통 항목 — kind+uid 가 계약 최소, 나머지는 표시 보조(없으면 '—') */
export interface ExamCtlTrashItem {
  kind: "study" | "series" | "image";
  study_id?: number;
  patient_name?: string;
  patient_key?: string;
  modality?: string;
  study_date?: string;
  study_desc?: string;
  series_uid?: string;
  series_desc?: string;
  sop_uid?: string;
  instance_number?: number;
  deleted_at?: string;
}
/** 환자 병합 항목 — master/slave 환자 스냅샷 (Unmerge 대상 선택용) */
export interface MergeItem {
  id: number;
  master: { patient_key: string; patient_name: string };
  slave: { patient_key: string; patient_name: string };
  moved_study_ids: number[];
  created_at: string;
}
export interface MergeResp { merge_id: number; moved: number }

// ── WebPACS 브리지 타입 — 인계 웹서비스(webpacs_api) 연동 ──
export interface WebPacsConfig {
  enabled: boolean;
  base_url: string;
  user_id: string;
  has_password?: boolean;   // GET 응답 — 비밀번호 자체는 서버가 마스킹
  verify_ssl: boolean;
  hospital_id: number;
  auto_sync: boolean;
  auto_sync_limit: number;
}
export interface WebPacsStudy {
  study_idx: number;            // 원격 내부 PK (인계 서버 study_idx)
  study_uid: string;
  patient_id: string;
  patient_name: string;
  patient_sex: string;
  patient_birth: string;
  study_datetime: string;
  modality: string;
  body_part: string;
  study_desc: string;
  series_count: number;
  image_count: number;
  study_status: string;
  hospital_name: string;
  imported_study_id: number | null;  // 로컬 보유 시 우리 검사 id (→열기)
}

// ── Local Server 모드 타입 (레인 F/B 공통 계약) ──
export interface LocalStudyRow {
  id: number;
  patient_key: string;
  patient_name: string;
  sex: string;
  study_date: string;
  modality: string;
  study_desc: string;
  images: number;
}
export interface LocalInstanceNode {
  iid: number;
  sop_uid: string;
  instance_number: number;
  rows: number;
  cols: number;
}
export interface LocalSeriesNode {
  series_uid: string;
  series_number: number;
  series_desc: string;
  modality: string;
  instances: LocalInstanceNode[];
}
/** 로컬 Exam Control 트리 — 서버 ExamCtlSeries 동형이나 인스턴스가 preview_url 대신 iid(→localRendered) */
export interface LocalExamCtlImage {
  iid: number;
  sop_uid: string;
  instance_number: number;
  rows: number;
  cols: number;
  deleted: boolean;
}
export interface LocalExamCtlSeries {
  series_uid: string;
  series_number: number;
  series_desc: string;
  modality: string;
  deleted: boolean;
  instances: LocalExamCtlImage[];
}

/** 로컬 인스턴스 렌더 PNG — 인증 헤더가 필요하므로 fetch→blob 방식 (wc/ww 생략=자동 W/L) */
export async function localRendered(iid: number, wc?: number, ww?: number): Promise<Blob> {
  const p = new URLSearchParams();
  if (wc !== undefined) p.set("wc", String(wc));
  if (ww !== undefined) p.set("ww", String(ww));
  const qs = p.toString();
  const res = await fetch(`${BASE}/api/local/instances/${iid}/rendered${qs ? `?${qs}` : ""}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    let detail = "";
    try { detail = ((await res.json()) as { detail?: string }).detail ?? ""; } catch { /* 본문 없음 */ }
    throw new Error(detail || `이미지 로드 실패 (HTTP ${res.status})`);
  }
  return res.blob();
}

// ── 인프라 타입 (시스템 구조도·InfraPanel 공통 계약) ──
export interface InfraHospitalEntry {
  container: string; url: string; dicom_port: number; web_port: number; volume: string; aet: string;
}
export interface InfraHospitalRow {
  hid: number; code: string; name: string; provisioned: boolean;
  entry: InfraHospitalEntry | null; state: string; status: string;
}
export interface InfraHospitalsRes { docker_ok: boolean; items: InfraHospitalRow[]; db_note: string }

// ── 저장공간/백업 타입 ──
export interface BackupPolicy {
  enabled: boolean;
  schedule_time: string;   // HH:MM
  retention_days: number;  // 0=무제한
  compression: string;     // backup_service.TRANSFER_SYNTAX 키
  target_dir: string;
}
export interface BackupJobRow {
  id: number;
  kind: string;            // manual | scheduled
  status: string;          // queued | running | done | failed
  compression: string;
  target_dir: string;
  date_from: string;
  date_to: string;
  study_count: number;
  instance_count: number;
  total_bytes: number;
  error: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string | null;
}
export interface StorageOverview {
  policy: BackupPolicy;
  db: { studies: number };
  orthanc: {
    alive: boolean;
    studies?: number;
    series?: number;
    instances?: number;
    disk_size?: number;
    uncompressed_size?: number;
    error?: string;
  } | null;
  disk: { path: string; total?: number; used?: number; free?: number; error?: string };
  retention: { retention_days: number; candidate_studies: number; cutoff_date?: string };
}

export interface LoginResp {
  token: string; username: string; role: string;
  hospital_id: number | null; hospital_name?: string;
  must_change?: boolean;   // 발급 계정 최초 로그인 → 비번 1회 강제 변경
}

// ── 병원 선택 / 자원관리 / Client ──
export interface MyHospital {
  id: number; code: string; name: string; departments: string;
  license_clients: number; clients: number; online_clients: number;
  studies: number; modality_limit: number;
}
export interface MyHospitals {
  items: MyHospital[]; role: string; is_admin: boolean;
}
export interface ClientRow {
  id: number; hospital_id?: number; name: string; code: string; location: string;
  enabled: boolean; online: boolean; last_seen: string | null; last_user: string;
  /** 계정 등급 — doctor|radiologist|technologist|staff (레인 B 확장, 미구현 서버는 미포함) */
  role?: string; role_label?: string;
  /** 발급 계정 로그인 — login_id(=코드)/복원 비번(admin)/최초강제변경/연동계정 유무 */
  login_id?: string; password?: string; must_change?: boolean; has_login?: boolean;
}

// ── 병원별 관리 계약 타입 (레인 F/B 공통) ──
export interface HospitalUsage {
  db: { studies: number; reports: number; annotations: number };
  storage: { disk_mb: number; instances: number; orthanc_ok: boolean };
}
export interface PermMatrixResp {
  roles: { key: string; label: string }[];
  permissions: { key: string; label: string }[];
  matrix: Record<string, string[]>;
}
export interface ModalityNode {
  name: string; ae_title: string; ip: string; port: number; kind: "scp" | "scu";
}
export interface ModalityTestResult {
  ok: boolean; detail?: string; icmp?: boolean; icmp_ms?: number; tcp?: boolean | null;
}
export interface HospitalScu { name: string; ae_title: string; ip: string; port: number }
export interface PermMe { role: string; hospital_id: number | null; perms: string[] }

// 협진 — 서버 표현은 lib/collab.ts 가 단일 원천이다(WS 이벤트와 같은 모양이어야 하므로).
// 여기서는 재수출만 해 호출부가 api 하나만 import 해도 되게 한다.
export type { CollabUser, CollabSeat, CollabSession, CollabMessage } from "./lib/collab";
import type { CollabUser, CollabSession, CollabMessage } from "./lib/collab";
export interface CollabFriends {
  friends: CollabUser[];
  incoming: CollabUser[];   // 내가 받은 요청
  outgoing: CollabUser[];   // 내가 보낸 요청
  blocked: CollabUser[];
  unread: Record<string, number>;   // room_key → 안읽음 수
}
export type StudyAdminActionKind = "delete" | "move" | "match" | "unmatch" | "copy";

/* ── 유효 권한 게이트 (레인 W) — GET /api/perm/me 1회 로드·캐시 ──
 * 서버가 관리·판독 API 에서 유효 권한을 403 으로 강제하므로,
 * 프론트 게이트(버튼 비활성+툴팁)는 어디까지나 UX(사전 안내) 목적이다.
 * 로드 실패 시 null = 전 기능 허용 폴백(권한 API 미구현 서버·기존 사용자 회귀 방지). */
export const PERM_DENIED_TIP = "권한 없음 — 관리자에게 문의";
let permMePromise: Promise<PermMe | null> | null = null;
export function loadPermMe(force = false): Promise<PermMe | null> {
  if (force || !permMePromise) permMePromise = api.permMe().catch(() => null);
  return permMePromise;
}
/** me=null(미로드·실패 폴백)=허용. 그 외에는 병원 매트릭스가 반영된 perms 로 판단 */
export function hasPerm(me: PermMe | null, key: string): boolean {
  return !me || me.perms.includes(key);
}
export interface HospitalResources {
  hospital: { id: number; code: string; name: string; departments: string; address: string; phone: string };
  image: { studies: number; series: number; instances: number; bytes_estimate: number | null; orthanc_total_bytes: number | null };
  db: { studies: number; reports: number; annotations: number };
  clients: { total: number; online: number; license: number; items: ClientRow[] };
  modalities: { count: number; limit: number };
  accounts: number;
}

// ── 공개 서버 상태 ──
export interface ServerStatus {
  api: boolean;
  orthanc: boolean;
  orthanc_url: string;
  ai_mode: string;
  mpps: boolean;
  version: string;
}

// ── 메인 서버 페이지(통합 상태) ──
export interface ServiceStatus {
  name: string;
  url: string;
  kind: string;       // api | orthanc | ohif | db | appdb | mpps
  ok: boolean;
  detail: string;
  manage?: string;    // 관리 UI 링크(있으면)
  container?: string; // docker 컨테이너 이름(있으면 시작/중지/재시작 제어 가능)
}
export interface ServerStatusAll {
  services: ServiceStatus[];
  healthy: number;
  total: number;
}

// ── 가입 / 관리자 감독 타입 ──
export interface SignupRequest {
  hospital: {
    name: string; zip?: string; address?: string; address_detail?: string;
    departments?: string; phone?: string; fax?: string;
    homepage?: string; license_clients?: number; modality_limit?: number;
  };
  registrant: {
    name: string; title?: string; sex?: string; birth6?: string; phone?: string;
    mobile?: string; email?: string; username: string; password: string; password_confirm: string;
  };
  billing: { method: string; card_last4?: string };
}
export interface OverviewHospital {
  id: number; code: string; name: string; enabled: boolean; departments: string; phone: string;
  accounts: number; active_accounts: number; license_clients: number;
  modalities: number; modality_limit: number; studies: number; billing_method: string;
}
export interface AdminOverview {
  hospitals: OverviewHospital[];
  totals: { hospitals: number; accounts: number; modalities: number; studies: number; audit_logs: number };
  server: { api: boolean; orthanc: boolean; mpps: { enabled: boolean; port: number }; ai_mode: string };
}

// ── 서버 관리 타입 ──
export interface RoleCatalog {
  roles: { key: string; label: string; perms: string[] }[];
  permissions: { key: string; label: string }[];
}
export interface HospitalRow {
  id: number;
  code: string;
  name: string;
  ae_title: string;
  address: string;
  phone: string;
  fax: string;
  homepage: string;
  departments: string;
  contact: string;
  max_accounts: number;
  license_clients: number;
  modality_limit: number;
  enforce_isolation: boolean;
  enabled: boolean;
  note: string;
  account_count?: number;
  // 병원별 DICOM 네트워크
  server_host: string;
  scp_aet: string;
  scp_port: number;
  qr_aet: string;
  qr_port: number;
}
export interface EndpointTest {
  host: string; port: number; aet: string;
  tcp: boolean | null; echo: boolean | null; detail?: string;
}
export interface HospitalNetResult { scp: EndpointTest; qr: EndpointTest }
export interface AccountRow {
  id: number;
  username: string;
  role: string;
  role_label: string;
  hospital_id: number | null;
  hospital_name: string;
  display_name: string;
  license_no: string;
  email: string;
  enabled: boolean;
  last_login: string | null;
}
export interface AccountCreateBody {
  username: string;
  password: string;
  role: string;
  hospital_id: number | null;
  display_name?: string;
  license_no?: string;
  email?: string;
  enabled?: boolean;
}
export interface ModalityRow {
  id: number;
  name: string;
  ae_title: string;
  host: string;
  port: number;
  modality_type: string;
  role: string;        // scu | scp | both
  manufacturer: string;
  hospital_id: number | null;
  hospital_name: string;
  allow_receive: boolean;
  enabled: boolean;
  note: string;
}
export interface ScpConfig {
  receive_enabled: boolean;
  registered_only: boolean;
  check_called_aet: boolean;
}
export interface ScpStatus {
  config: ScpConfig;
  modalities_total: number;
  modalities_active: number;
  mpps?: { enabled: boolean; port: number; aet: string };
  orthanc: {
    alive: boolean;
    aet?: string;
    dicom_port?: number;
    registered_modalities?: string[];
  } | null;
}

/** S1 자연어 검색 — 적용 전 미리보기(explanation) 필수 */
export interface NlQueryResult {
  filter: {
    patient_id: string; patient_name: string; sex: string; modality: string;
    body_part: string; study_desc: string; status: string;
    date_from: string; date_to: string; finding: string; emergency: boolean;
  };
  explanation: string;
  source: "mock" | "live" | "live_fallback";
}

export interface InstanceNode {
  orthanc_id: string;
  sop_uid: string;
  instance_number: number;
  preview_url: string;
  rows: number;
  cols: number;
  pixel_spacing: number[];   // [row, col] mm — 없으면 []
  position: number[];        // ImagePositionPatient [x,y,z]
  orientation: number[];     // ImageOrientationPatient 6개
  series_uid?: string;       // Combine(여러 시리즈를 한 시리즈처럼) 시 인스턴스의 원본 시리즈 UID — 렌더 URL 이 이를 우선 사용
  study_uid?: string;        // Combine 시 인스턴스의 원본 검사 UID — 다른 검사(과거/비교) 시리즈 결합 시 정확한 스터디로 요청
  view_position?: string;    // (0018,5101) MG 뷰(CC/MLO) — 4-view 표준 배치의 근거
  laterality?: string;       // (0020,0062) 좌우 — R 은 화면 왼쪽, L 은 오른쪽에 걸어야 한다
}

export interface SeriesNode {
  series_uid: string;
  modality: string;
  series_desc: string;
  series_number: number;
  instances: InstanceNode[];
}

/** 주석/계측 (07 A.4) — 좌표는 이미지 정규화(0~1) */
export interface Anno {
  id?: number;
  series_uid: string;
  sop_uid: string;
  kind: string;              // length|angle|rect|ellipse|arrow|text|ctr
  points: number[][];
  value?: number | null;
  unit?: string;
  text?: string;
  source?: "user" | "ai" | "external";
  confidence?: number | null;
  verified?: boolean;
  /** 협진 세션 주석의 작성자(account id) — 있으면 그 사람 색으로 그린다.
   *  DB 에서 온 주석에는 없다(옵셔널이라 저장 경로에 영향이 없다). */
  by?: number;
}

/** 저장 표시상태(시리즈별 적용 툴 값) — 재오픈 시 재현. 좌표는 정규화(0~1) */
export interface PState {
  wl?: string;                 // "center,width"
  invert?: boolean;
  flipH?: boolean;
  flipV?: boolean;
  rot?: number;                // 0/90/180/270
  fx?: string;                 // sharpen|smooth|pseudo|""
  shutter?: { kind: "rect" | "ellipse" | "poly"; pts: number[][] } | null;
}

/** GSPS 불러오기 결과 1건(PR 객체) — annotations는 source="external" */
export interface GspsItem {
  sop_instance_uid: string;
  label: string;
  creator: string;
  wc: number | null;
  ww: number | null;
  annotations: Anno[];
}

/** ROI HU 통계 결과 */
export interface RoiStats {
  count?: number;
  mean?: number;
  min?: number;
  max?: number;
  std?: number;
  unit?: string;
  area_mm2?: number | null;
  wc?: number;
  ww?: number;
  error?: string;
}

export interface CtrResult {
  ctr: number | null;
  cardiac: { x1: number; x2: number; y: number } | null;
  thoracic: { x1: number; x2: number; y: number } | null;
  confidence: number;
  note: string;
  verified: boolean;
  verify_note: string;
  source: string;
}

export interface OrderRow {
  id: number;
  patient_key: string;
  patient_name: string;      // DICOM PN: Last^First
  birth_date?: string;
  sex?: string;
  accession_no: string;
  modality: string;
  scheduled_date: string;
  scheduled_time: string;
  procedure_desc: string;
  station_aet: string;
  status: string;            // scheduled|in_progress|completed|cancelled (MPPS 매핑)
  body_part: string;
  projection: string;        // PA/AP/LAT…
  dicom_study_id: string;    // DICOM StudyID (0020,0010)
  physician?: string;        // 의뢰의 (MWL ReferringPhysicianName)
  department?: string;
  hospital_id?: number | null;
  taken_aet?: string;        // 장비가 MWL 로 가져간 경우 호출 AET (관찰 기록)
  taken_at?: string | null;  // 가져간 시각 (ISO)
}

/** 상용구/템플릿 — DB 테이블(phrases). kind=phrase(단축키)|template, text=결론, reading_text=판독 */
export interface PhraseRow {
  id: number;
  name: string;
  text: string;
  reading_text: string;
  modality: string;
  body_part: string;
  category: string;
  shortcut: string;
  kind: "phrase" | "template";
  created_by: string;
}

/** 서버 네트워크 설정 (Setting>서버 네트워크 — 전역) */
export interface ServerNetwork {
  local_share_dir?: string;
  web?: { ip?: string; port?: number | string; name?: string; ae_title?: string };
}

export interface Profile {
  username: string;
  role: string;
  display_name: string;
  license_no: string;
  major_no?: string;   // 전문의 번호(2026-08-10) — A 자동 채움, 없으면 공란
}

export interface OrthancStatus {
  alive: boolean;
  url: string;
  name?: string;
  aet?: string;
  dicom_port?: number;
  version?: string;
  studies_count?: number;
  error?: string;
}

/** 비교세트 열기: OHIF는 StudyInstanceUIDs 콤마 연결로 다중 검사 비교 지원 */
export function openViewerCompare(studyUids: string[], hangingProtocolId?: string) {
  const hp = hangingProtocolId && hangingProtocolId !== "default"
    ? `&hangingProtocolId=${encodeURIComponent(hangingProtocolId)}`
    : "";
  window.open(
    `${OHIF_BASE}/viewer?StudyInstanceUIDs=${studyUids.map(encodeURIComponent).join(",")}${hp}`,
    "_blank",
  );
}

export interface InstanceThumb {
  orthanc_id: string;
  sop_uid: string;
  instance_number: number;
  preview_url: string;
}
export interface KeyImage {
  sop_uid: string;
  orthanc_id: string;
  instance_number: number;
}

export interface AiQuality {
  finalized_total: number;
  with_ai_draft: number;
  accepted_unmodified?: number;
  acceptance_rate?: number;
  avg_modified_ratio?: number;
  critical_dropped?: number;
  critical_added?: number;
}

export interface BatchCandidate {
  report_id: number;
  study_id: number;
  patient_key: string;
  patient_name: string;
  modality: string;
  study_date: string;
  study_desc: string;
  impression: string;
  confidence: string;
}

/** 음성 판독 서버 STT (Whisper 로컬/OpenAI API) — FormData라 req() 미사용 */
export async function sttTranscribe(blob: Blob): Promise<{ text: string; engine: string }> {
  const fd = new FormData();
  fd.append("audio", blob, "dictation.webm");
  const res = await fetch(`${BASE}/api/stt`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: fd,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `HTTP ${res.status}`);
  }
  return res.json();
}

/** STT 엔진 설치·설정 상태 (관리자 설정·Client 마이크 UI 소비) */
export interface SttStatus {
  engine: "browser" | "whisper_local" | "openai_api";
  model: string;
  ready: boolean;
  available: { faster_whisper: boolean; openai_whisper: boolean; whisper_local: boolean; openai_api_key: boolean };
}
export const sttStatus = () => req<SttStatus>("/api/stt/status");

// ── 서버 유지보수·인사이트 타입 (레인 F/B 공통 계약) ──
export interface MaintStorage {
  db: { size_mb: number; detail?: string };
  image: { size_mb: number; instances: number; disk_free_gb: number; disk_total_gb: number };
  backup: { path: string; size_mb: number; quota_gb: number };
}
export type MaintRepeat = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";
export interface MaintBackupPolicy {
  enabled: boolean;
  at: string;                 // 'HH:MM:SS'
  repeat: MaintRepeat;
  weekday?: number;           // repeat=weekly (0=월 … 6=일)
  day?: number;               // repeat=monthly/quarterly/yearly — 일(day of month)
  retention_days: number;
  format: string;             // 압축 포맷(기존 backup_service 키 유지)
  path: string;
  quota_gb?: number;          // 백업 용량 상한(GB, 0=무제한)
  mirror_path?: string;       // 시스템 미러링 대상 경로
  db_backup: boolean;         // DB 백업 포함
}
export interface MaintBackupItem {
  id: number | string; kind: string; ts: string; size_mb: number; path: string; status: string;
}
export interface MaintRestoreResult {
  ok: boolean; dry?: boolean; executed?: boolean; kind?: string;
  summary?: string;           // 사람이 읽는 한 줄 요약(백엔드 계약)
  detail?: string;
  guidance?: string;          // DB 복원 시 수동 절차 안내(자동 실행 안 함 — 우아 강등)
  prepared_file?: string;     // DB 복원 준비 파일 경로
  files_found?: number; size_mb?: number; studies?: number; instances?: number;
  uploaded?: number; failed?: number; studies_registered?: number;
}
/** 서버 포털 리다이렉트 리스너 상태 (서버 설정 IP:Port 가 실제 응답하는지) */
export interface PortalStatus {
  running: boolean;
  host: string;
  port: number;
  target: string;       // 고정 리다이렉트 대상(빈값=요청 Host 기준 랜딩 포털 추정)
  since?: number | null; // 기동 시각(epoch)
  error?: string;        // 바인드 실패 등 원인
}
export interface DbSchemaResp {
  tables: { name: string; rows: number; columns: { name: string; type: string }[] }[];
}
export interface LogItem {
  ts: string; type: string; actor: string; hospital_id: number | null; action: string;
  detail: Record<string, unknown>;  // 백엔드는 객체(dict)로 반환 — 표시 시 문자열화 필요
}
export interface StatsRow { key: string; label: string; studies: number; reports: number; unreported: number }
export interface StatsResp { group: string; rows: StatsRow[] }
/** 가입 환경 설정 필드 정의 — settings 키 signup.fields.hospital|client|modality */
export interface SignupFieldDef { key: string; label: string; enabled: boolean; required: boolean }
export interface SignupFieldsCfg { fields: SignupFieldDef[] }
/** AI 등록 항목 — settings 키 ai.providers ({items:[…]}) */
export interface AiProvider {
  name: string; kind: "oss" | "api"; endpoint: string; model: string;
  api_key_ref: string; enabled: boolean; note: string;
}

/** 시스템 로그 CSV 다운로드 — 인증 헤더 필요라 fetch→blob 방식 */
export async function downloadLogsCsv(params: Record<string, string>) {
  const res = await fetch(`${BASE}/api/insights/logs.csv?${new URLSearchParams(params)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) throw new Error(`CSV 다운로드 실패 (HTTP ${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `logs_${params.type ?? "all"}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** 사용량 통계 Excel(.xlsx) 다운로드 — 인증 헤더 필요라 fetch→blob 방식 (downloadLogsCsv 패턴) */
export async function downloadStatsXlsx(params: Record<string, string>) {
  const res = await fetch(`${BASE}/api/insights/stats.xlsx?${new URLSearchParams(params)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) throw new Error(`Excel 다운로드 실패 (HTTP ${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `stats_${params.group ?? "all"}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

/** 가입 필드 설정 로드(가입 화면용) — 실패/미설정=null(기존 폼 그대로).
 *  가입 화면은 무인증(공개)이므로 인증이 필요한 /api/settings 대신
 *  공개 엔드포인트 GET /api/signup/fields/{kind} 를 사용한다(빈 목록=미설정=null). */
export async function fetchSignupFields(kind: "hospital" | "client" | "modality"): Promise<SignupFieldsCfg | null> {
  try {
    const res = await fetch(`${BASE}/api/signup/fields/${kind}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { fields?: SignupFieldDef[] };
    return Array.isArray(body?.fields) && body.fields.length > 0 ? { fields: body.fields } : null;
  } catch {
    return null;
  }
}

/** PDF 다운로드 — 인증 헤더가 필요하므로 fetch→blob 방식 */
export async function downloadReportPdf(reportId: number) {
  const url = isLiveId(reportId)
    ? `${BASE}/api/webpacs/live/reports/${reportId}/pdf`   // Live: A 판독 데이터 → 우리 PDF 렌더러
    : `${BASE}/api/reports/${reportId}/export?format=pdf`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${localStorage.getItem("sv_token") ?? sessionStorage.getItem("sv_token")}` },
  });
  if (!res.ok) throw new Error("PDF 생성 실패");
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = res.headers.get("Content-Disposition")?.match(/filename="(.+)"/)?.[1] ?? "report.pdf";
  a.click();
  URL.revokeObjectURL(blobUrl);
}
