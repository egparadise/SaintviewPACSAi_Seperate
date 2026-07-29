// 다운로드 모드 — **백그라운드 선다운로드 스케줄러**(워크리스트 창 1곳에서만 돈다).
//
// 사용자 확정 순서를 그대로 구현한다:
//   ① 최근 환자(=워크리스트 현재 목록 순서) → ② 검사별 시리즈 대표 **썸네일 전부**
//   → ③ 시리즈 순서대로 각 시리즈의 **이미지 전부**
// 정렬은 서버가 이미 최신순으로 보장한다(study_service.py:227 / webpacs_live.py:285).
// 프론트에서 재정렬하지 않는다 — 두 곳이 순서를 정하면 반드시 어긋난다.
//
// ⚠ 동시 실행 방지: 워크리스트 창과 뷰어 창(window.open)이 같은 오리진의 OPFS 를 공유하므로
//   스케줄러가 창마다 뜨면 같은 SOP 를 중복으로 받는다. Web Locks 로 **한 창만** 다운로더가 된다.
//   ★ 근거: 백엔드에서 _INFLIGHT/_sop_lock 경합으로 같은 시리즈를 4~7배 중복 프리인코딩한
//     전례가 있다(3e2099f).
//
// ⚠ 동시 fetch 기본값 2: 백엔드가 검사 오픈마다 이미 A→B 8워커 병렬 프리페치를 돌린다.
//   프론트가 8을 더 얹으면 '내 화면은 빨라지고 남의 화면은 느려진다'가 된다.
import { api } from "../api";
import { authHeader, fixedFormatTag, fixedImageFormat, fixedRenderedParams } from "./imageFormat";
import { LIVE_DICOMWEB_ROOT } from "./liveUids";
import { dlInvalidateCache } from "./dlCache";
import {
  dlKey, dlSupportReason, opfsHas, opfsPut, opfsPrune, opfsPersist,
  opfsEvictStudy, opfsLimitBytes, type DlMeta,
} from "./opfsStore";

export interface DlQueueItem {
  studyId: number;
  studyUid: string;
  patientKey: string;
  studyDate: string;
  modality: string;
  label: string;      // 진행 표시용(환자명 등)
}

export interface DlConfig {
  enabled: boolean;
  limitGb: number;      // 상한(GB)
  concurrency: number;  // 동시 fetch
  scope: "list" | "recent";
  recentN: number;      // scope=recent 일 때 상위 N 건
}

export interface DlProgress {
  running: boolean;     // 이 창이 다운로더인가(Web Lock 보유)
  done: number;         // 완료 검사 수
  total: number;        // 대상 검사 수
  current: string;      // 현재 검사 라벨
  files: number;        // 이번 세션에 받은 파일 수
  note: string;         // 사용자에게 보일 사유/상태
}

let cfg: DlConfig = { enabled: false, limitGb: 2, concurrency: 2, scope: "list", recentN: 50 };
let queue: DlQueueItem[] = [];
// 승격/중지 토큰 — 값이 바뀌면 진행 중인 검사 루프를 그 자리에서 그만둔다
// (framePrefetch.ts:57 의 warmToken 패턴과 동형).
let promoteTick = 0;
const doneUids = new Set<string>();          // 이번 세션에 끝낸 검사(재큐잉 방지)
// 실패 백오프 — 이게 없으면 seriesTree 가 실패하는 검사 하나가 0.3초마다 영원히 재시도되며
// 원격 A 를 두들긴다(선다운로드가 부하 사고로 바뀌는 가장 쉬운 경로).
const failUntil = new Map<string, number>();
const failTries = new Map<string, number>();
const FAIL_BACKOFF = 60_000;
const FAIL_GIVEUP = 3;   // 영구 502(손상 인스턴스)를 1분마다 영원히 다시 두들기지 않는다
let stopped = true;
let lockHeld = false;
let yieldUntil = 0;                          // 사용자가 검사를 여는 순간 잠시 감속(양보)
let filesGot = 0;
let curLabel = "";
let note = "";
let sincePrune = 0;
const listeners = new Set<() => void>();

export function onDlProgress(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
function ping(): void { listeners.forEach((cb) => cb()); }

export function dlProgress(): DlProgress {
  const target = scoped();
  return {
    running: lockHeld && !stopped,
    done: target.filter((q) => doneUids.has(q.studyUid)).length,
    total: target.length,
    current: curLabel, files: filesGot, note,
  };
}

function scoped(): DlQueueItem[] {
  return cfg.scope === "recent" ? queue.slice(0, Math.max(1, cfg.recentN)) : queue;
}

/** 워크리스트가 목록을 갱신할 때마다 호출 — 순서는 서버가 준 그대로 유지한다. */
export function dlSetQueue(items: DlQueueItem[]): void {
  queue = items.filter((i) => i.studyUid);
  ping();
}

/** 사용자가 검사를 여는 순간 — 그 검사를 큐 맨 앞으로 올리고, 선다운로드를 잠시 감속한다.
 *  (열린 검사의 영상이 최우선이고, 동시에 A 를 때리는 총량을 줄인다) */
export function dlPromote(studyUid: string, ms = 4000): void {
  yieldUntil = Date.now() + ms;
  const i = queue.findIndex((q) => q.studyUid === studyUid);
  if (i > 0) { const [it] = queue.splice(i, 1); queue.unshift(it); }
  doneUids.delete(studyUid);   // 다시 확인(부분 다운로드였을 수 있다) — 이미 받은 파일은 건너뛴다
  failUntil.delete(studyUid); failTries.delete(studyUid);   // 사용자가 직접 열었다 — 백오프를 기다리게 하지 않는다
  promoteTick++;
}

/** A 에서 픽셀이 바뀐 검사 폐기 — SSE changed_studies 구독자가 호출한다.
 *  ★ '무효화 함수를 만들었는데 프로덕션 호출자가 0' 이었던 전례(invalidate_tree, 3e2099f)를
 *    반복하지 않는다. 호출자: Worklist 의 SSE 틱.
 *
 *  ⚠ 인자는 **워크리스트 행 id(vid = VID_BASE + A study_idx)** 다. SSE 가 주는 값은 A 원본
 *    study_idx(작은 정수)라 그대로 넘기면 `ids.has(q.studyId)` 가 **구조적으로 절대 참이 될 수
 *    없어** 무효화가 영구 무동작이 된다(실제로 그 상태였다 — 낡은 영상이 만료 없이 계속 히트).
 *    변환 책임은 호출부(Worklist)에 있고, 여기서는 그 계약을 주석으로 못 박는다.
 *  ⚠ 폐기는 **창을 넘어야** 한다 — 뷰어는 별도 창이라 이 창에서 파일만 지우면 뷰어의 blob URL
 *    캐시가 낡은 영상을 계속 반환한다. dlInvalidateCache() 가 BroadcastChannel 로 알린다. */
export async function dlInvalidate(studyIds: number[]): Promise<void> {
  if (!studyIds.length) return;
  const ids = new Set(studyIds);
  let hit = 0;
  for (const q of queue) {
    if (!ids.has(q.studyId)) continue;
    try { await opfsEvictStudy(q.studyUid); } catch { /* 항목 단위 무시 */ }
    doneUids.delete(q.studyUid);
    hit++;
  }
  if (hit) dlInvalidateCache();   // 이 창 + 열려 있는 뷰어 창들의 blob 캐시 폐기 → 재조회
  ping();
}

/** 저장소를 통째로 비운 뒤(설정 '지금 비우기') 호출 — **다시 받게** 만든다.
 *  doneUids 를 그대로 두면 loop() 의 `!doneUids.has(...)` 필터에 전부 걸려, 저장소는 비었는데
 *  아무것도 재다운로드되지 않고 진행 표시만 '검사 N/N' 으로 남는다(사용량 0 과 모순).
 *  dlReset 과 달리 enabled 를 끄지 않는다 — 비우기는 종료가 아니라 재시작이다. */
export function dlForgetDone(): void {
  doneUids.clear(); failUntil.clear(); failTries.clear();
  filesGot = 0; sincePrune = 0;
  promoteTick++;   // 진행 중이던 검사 루프를 그 자리에서 접는다(지워진 파일을 이어받지 않게)
  ping();
}

/* ── 다운로드 ── */
async function fetchBlob(url: string): Promise<Blob | null> {
  try {
    // ★ 쿠키가 아니라 Bearer 로 받는다 — pixel_user 가 Bearer 를 쿠키보다 먼저 본다
    //   (deps.py:118-134). fetch 는 헤더를 붙일 수 있으므로 sv_pix 의 Path 스코프·SameSite·
    //   다중 탭 세션 문제에 얽힐 이유가 없다. 백엔드 변경 0 — 기존 thumb/rendered 를 그대로 소비.
    const r = await fetch(url, { headers: authHeader(), credentials: "include" });
    if (!r.ok) return null;
    const b = await r.blob();
    return b.size ? b : null;
  } catch { return null; }
}

/** ★ 다운로드 URL 은 **회선 자동판정을 뺀 관리자 설정**으로 만든다(imageFormat.fixedRenderedParams).
 *  · renderedParams() 를 그대로 쓰면 안 되는 이유: 회선 상태(Network Information API)에 따라
 *    결과가 바뀌어(autoJpegForSlowLink) 같은 이미지가 회선별로 다른 바이트가 되고 캐시가 갈린다.
 *  · 그렇다고 accept=image/jpeg&quality=90 을 하드코딩하면 **관리자의 무손실(PNG) 설정을 조용히
 *    덮는다** — 실제로 그랬다(예전 코드). 회선 의존만 빼고 관리자 설정은 존중한다.
 *  window 파라미터는 붙이지 않는다(= 검사 기본 W/L. 조회 측도 wl 이 빈 경우에만 히트시킨다). */
function fullUrl(studyUid: string, seriesUid: string, sopUid: string,
                 f: ReturnType<typeof fixedImageFormat>): string {
  return `${LIVE_DICOMWEB_ROOT}/studies/${studyUid}/series/${seriesUid}/instances/${sopUid}` +
         `/rendered${fixedRenderedParams(false, f)}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Task { key: string; url: string; kind: "th" | "full"; sop: string; fmt: string }

/** 작업 목록을 동시 N 개로 처리 — 토큰이 바뀌면(승격·중지) 즉시 그만둔다.
 *  진행 중이던 fetch 는 취소하지 않는다(이미 받은 바이트를 버리는 셈이다).
 *  반환값 = 실패 건수. 한 장이라도 실패하면 그 검사를 '완료'로 찍지 않는다 — 안 그러면
 *  A 가 잠깐 흔들린 사이 빠진 프레임이 세션 내내 영영 안 채워진다. */
async function pump(tasks: Task[], meta: DlMeta, token: number): Promise<number> {
  let i = 0;
  let failed = 0;
  const n = Math.max(1, Math.min(4, cfg.concurrency || 2));
  const worker = async () => {
    for (;;) {
      if (stopped || token !== promoteTick) return;
      if (Date.now() < yieldUntil) { await sleep(400); continue; }
      const t = tasks[i++];
      if (!t) return;
      if (await opfsHas(t.key)) continue;
      const blob = await fetchBlob(t.url);
      if (!blob) { failed++; continue; }
      if (await opfsPut(t.key, blob, t.kind, t.sop, meta, t.fmt)) {
        filesGot++;
        if (++sincePrune >= 50) {
          sincePrune = 0;
          try { await opfsPrune(await opfsLimitBytes(cfg.limitGb)); } catch { /* 무시 */ }
        }
        if (filesGot % 10 === 0) ping();
      } else failed++;
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
  return failed;
}

async function downloadStudy(item: DlQueueItem, token: number): Promise<boolean> {
  curLabel = item.label || item.studyUid.slice(-8);
  ping();
  let tree: Awaited<ReturnType<typeof api.seriesTree>>;
  try { tree = await api.seriesTree(item.studyId); } catch { return false; }
  const stu = tree.study_uid || item.studyUid;
  const meta: DlMeta = {
    studyUid: stu, patientKey: item.patientKey, studyDate: item.studyDate, modality: item.modality,
  };
  // ① 모든 시리즈의 **대표 썸네일 먼저** — ≈40KB 급이라 검사 전체가 순식간에 채워지고,
  //    뷰어에서 '썸네일 먼저 표시 → 본 영상 무음 전환'의 언더레이 입력이 된다.
  //    ⚠ 실제로 쓰이는지 확인할 것: previewUrlOf(liveUids.ts)가 **로컬 썸네일을 A 의 ?preview=1
  //      보다 먼저** 쓴다. 예전에는 순서가 반대라 Live 에서 로컬 썸네일이 한 번도 안 쓰였다
  //      (받기만 하고 안 쓰는 상태 = A 요청·용량만 소모).
  //    ⚠ 저장 대상은 **시리즈 첫 인스턴스뿐**이다(대표 1장). 나머지 프레임은 언더레이가 없고
  //      영구 미스이므로, dlCache 는 썸네일 미스를 길게(2분) 기억해 재조회를 줄인다.
  const thumbs: Task[] = [];
  for (const s of tree.series) {
    const first = s.instances[0];
    if (!first?.preview_url) continue;
    thumbs.push({ key: dlKey("th", first.sop_uid), url: first.preview_url, kind: "th", sop: first.sop_uid, fmt: "" });
  }
  let failed = await pump(thumbs, meta, token);
  if (stopped || token !== promoteTick) return false;
  // ② 시리즈 순서대로 각 시리즈의 이미지 전부
  // 형식 태그는 검사 하나를 받는 동안 고정한다 — 도중에 관리자 설정이 바뀌어도 한 검사 안에서
  // 형식이 섞이면 안 된다(같은 시리즈를 스크롤하는데 슬라이스마다 화질이 달라진다).
  const ff = fixedImageFormat();
  const fmt = fixedFormatTag(ff);
  for (const s of tree.series) {
    const tasks: Task[] = s.instances.map((i) => ({
      key: dlKey("full", i.sop_uid, fmt), url: fullUrl(stu, s.series_uid, i.sop_uid, ff),
      kind: "full" as const, sop: i.sop_uid, fmt,
    }));
    failed += await pump(tasks, meta, token);
    if (stopped || token !== promoteTick) return false;
  }
  return failed === 0;
}

async function loop(): Promise<void> {
  try { await opfsPersist(); } catch { /* 무시 */ }
  while (!stopped) {
    const token = promoteTick;
    const now = Date.now();
    const next = scoped().find((q) =>
      !doneUids.has(q.studyUid) && (failUntil.get(q.studyUid) ?? 0) <= now);
    if (!next) { curLabel = ""; ping(); await sleep(2000); continue; }
    const ok = await downloadStudy(next, token);
    if (ok) {
      doneUids.add(next.studyUid);
      failUntil.delete(next.studyUid); failTries.delete(next.studyUid);
      ping();
    } else if (!stopped && token === promoteTick) {
      // 중단(승격·정지)이 아니라 **진짜 실패**일 때만 백오프를 건다 — 승격 때문에 그만둔 검사를
      // 1분 벌세우면 사용자가 방금 연 검사가 뒤로 밀린다.
      const tries = (failTries.get(next.studyUid) ?? 0) + 1;
      failTries.set(next.studyUid, tries);
      if (tries >= FAIL_GIVEUP) doneUids.add(next.studyUid);   // 포기 — 못 받은 장은 서버 렌더로 본다
      else failUntil.set(next.studyUid, Date.now() + FAIL_BACKOFF);
      ping();
    }
    await sleep(300);   // 검사 사이 숨 고르기 — A 에 몰아치지 않는다
  }
  curLabel = ""; ping();
}

export function dlConfigure(next: DlConfig): void {
  cfg = { ...next, concurrency: Math.max(1, Math.min(4, next.concurrency || 2)) };
  // ⚠ '이전 값과 달라졌을 때만' 기동하면 안 된다 — 워크리스트가 언마운트되며 dlStop() 한 뒤
  //   다시 마운트되면 cfg.enabled 는 그대로 true 라 '변화 없음'으로 판정돼 다운로더가 영영
  //   안 돌아온다. dlStart/dlStop 은 둘 다 멱등하므로 매번 현재 상태를 그대로 반영한다.
  if (cfg.enabled) dlStart(); else dlStop();
  ping();
}

/** 스케줄러 기동 — Web Lock 을 잡은 창 **하나만** 실제로 돈다(다른 창은 대기하다 조용히 끝난다). */
export function dlStart(): void {
  const why = dlSupportReason();
  if (why) { note = why; ping(); return; }
  if (!stopped) return;
  stopped = false;
  note = "";
  void acquire();
}

/** Web Lock 확보 → 루프. ifAvailable 로 **즉시 포기**하고 5초 뒤 재시도한다.
 *  대기 큐에 쌓아 두면 다운로더 창이 닫힐 때 뒤늦게 깨어나 예상 못 한 시점에 다운로드가 시작된다. */
async function acquire(): Promise<void> {
  while (!stopped) {
    let got = false;
    const run = async () => {
      got = true; lockHeld = true; note = ""; ping();
      try { await loop(); } finally { lockHeld = false; ping(); }
    };
    if (navigator.locks?.request) {
      await navigator.locks.request("sv-dl-scheduler", { mode: "exclusive", ifAvailable: true },
        async (lock) => { if (lock) await run(); }).catch(() => { lockHeld = false; });
    } else {
      await run();   // Web Locks 미지원 — 창 1개 가정(중복은 opfsHas 스킵으로 완화)
    }
    if (stopped) break;
    if (!got) { note = "다른 창이 다운로드를 맡고 있습니다."; ping(); await sleep(5000); }
  }
}

export function dlStop(): void {
  stopped = true;
  curLabel = "";
  ping();
}

/** 세션 종료 시 상태 초기화 — 다음 로그인이 남은 진행률을 물려받지 않게 한다. */
export function dlReset(): void {
  dlStop();
  cfg = { ...cfg, enabled: false };
  queue = []; doneUids.clear(); failUntil.clear(); failTries.clear(); filesGot = 0; note = "";
  ping();
}

// ★ 세션 만료(401)에서도 다운로더를 세운다.
//   워크리스트의 로그아웃 버튼은 dlReset() → opfsWipe() 순서를 지키는데, 401 경로(api.ts 의
//   setToken(null))에는 그 정지가 빠져 있었다. 그러면 (a) 자격이 사라진 뒤에도 루프가 A 에
//   401 요청을 계속 쏘고 (b) 토큰이 지워지기 직전에 200 으로 끝난 fetch 의 blob 이 opfsWipe
//   **뒤에** opfsPut 으로 기록돼 — opfsPut 은 create:true 라 지운 트리를 되살린다 —
//   로그아웃 후에도 환자 영상이 브라우저에 남는다.
//   ⚠ dlScheduler → api.ts 는 이미 import 가 있으므로 반대 방향(api → dlScheduler)을 만들면
//     순환이 된다. 그래서 이 저장소가 이미 쓰는 커스텀 이벤트 패턴(sv-settings-saved)과 동형으로,
//     api.ts 가 'sv-auth-cleared' 를 발행하고 여기서 받는다(가장 얕은 결합).
//   ⚠ 이것만으로는 in-flight 레이스 창이 남는다 — opfsStore.opfsPut 의 토큰 가드가 그 창을 닫는다.
if (typeof window !== "undefined") window.addEventListener("sv-auth-cleared", () => dlReset());
