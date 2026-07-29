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
import { dlInvalidateStudies } from "./dlCache";
import { showToast } from "./toast";
import { liveViewerSlots } from "./viewerSlots";
import { liveHeldStudyUids } from "./dlHeld";
import { LOCK_BUSY_NOTE, decideLockNote } from "./dlLock";
import {
  applyEviction, computeProtectedUids, doneCount, evictConfigKey, newLoopState,
  pickNextStudy, releaseEvicted, shouldWarnNearLimit, skippedCount,
} from "./dlQueueRule";
import {
  dlKey, dlSupportReason, opfsHas, opfsPut, opfsPrune, opfsPersist,
  opfsEvictStudy, opfsLimitBytes, pendingTasks, type DlMeta, type EvictPolicy,
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
  // ── 용량 초과 정책(설정>환경>영상 취득. lib/dlPrefs.ts 가 해석한 값 그대로) ──
  autoEvict: boolean;   // 상한 초과 시 자동 삭제. 끄면 '상한 도달 시 더 받지 않기'로 바뀐다
  evictBy: EvictPolicy; // date = 과거 검사일부터(기본) / lru = 오래 안 본 것부터
  warnNearLimit: boolean;
  warnAtPct: number;
}

export interface DlProgress {
  running: boolean;     // 이 창이 다운로더인가(Web Lock 보유)
  done: number;         // 완료 검사 수
  total: number;        // 대상 검사 수
  current: string;      // 현재 검사 라벨
  files: number;        // 이번 세션에 받은 파일 수
  note: string;         // 사용자에게 보일 사유/상태
}

let cfg: DlConfig = {
  enabled: false, limitGb: 2, concurrency: 2, scope: "list", recentN: 50,
  autoEvict: true, evictBy: "date", warnNearLimit: true, warnAtPct: 90,
};
let queue: DlQueueItem[] = [];
// 승격/중지 토큰 — 값이 바뀌면 진행 중인 검사 루프를 그 자리에서 그만둔다
// (framePrefetch.ts:57 의 warmToken 패턴과 동형).
let promoteTick = 0;
// 큐 상태(완료·용량축출·실패백오프) — 판정은 전부 lib/dlQueueRule.ts 의 순수 함수가 한다.
//  · done    : 이번 세션에 끝낸 검사(재큐잉 방지)
//  · evicted : 용량 때문에 지운 검사 = **종결 상태**. 설정 변경/비우기/사용자 오픈에서만 풀린다.
//  · failUntil: 실패 백오프. 이게 없으면 seriesTree 가 실패하는 검사 하나가 0.3초마다 영원히
//    재시도되며 원격 A 를 두들긴다(선다운로드가 부하 사고로 바뀌는 가장 쉬운 경로).
//    ⚠ **네트워크 실패 전용**이다. 용량 축출에 쓰면 '10분 뒤 다시 받는' 트레드밀이 된다.
const st = newLoopState();
const doneUids = st.done;
const failUntil = st.failUntil;
const failTries = new Map<string, number>();
const FAIL_BACKOFF = 60_000;
const FAIL_GIVEUP = 3;   // 영구 502(손상 인스턴스)를 1분마다 영원히 다시 두들기지 않는다
let stopped = true;
// 정지 **세대** — dlStop 마다 오른다. acquire()/loop() 는 진입 시 이 값을 캡처해, 자기 세대가
// 낡았으면 즉시 접는다.
// ★ stopped 플래그만으로는 새는 경합이 있었다: 뷰어를 닫자마자(dlStop) 다시 여는(dlResume) 흐름에서
//   옛 loop 이 fetch 를 await 하는 사이 stopped 가 false 로 되돌아가면, 옛 loop 이 while 검사를
//   빠져나가지 못하고 Web Lock 을 계속 쥔다. 그러면 새 acquire() 는 ifAvailable 실패로 5초마다
//   영원히 도는 유령 루프가 되고, 이 창인데도 '다른 창이 다운로드를 맡고 있습니다' 라는 틀린
//   안내를 띄운다(반복하면 유령 루프가 하나씩 누적된다).
let gen = 0;
let lockHeld = false;
// 마지막 dlStop 시각 — Lock 확보 실패를 '이 창의 옛 loop 이 놓는 중' 과 '진짜 다른 창' 으로
// 가르는 근거다(lib/dlLock.decideLockNote). 0 = 이 세션에 아직 멈춘 적 없음.
let lastStopAt = 0;
let yieldUntil = 0;                          // 사용자가 검사를 여는 순간 잠시 감속(양보)
let filesGot = 0;
let curLabel = "";
let curUid = "";                             // 지금 받고 있는 검사 — 범위에서 빠졌는지 판정용
// 방금 다 받은 검사 — 게이트 진입에서 curUid 를 비우는 순간 보호가 풀려 '상한보다 큰 검사 하나'가
// 다 받자마자 자기 자신을 지우는 경로가 있었다. 짧게(유계) 한 주기 더 보호한다.
let recentUid = "";
let recentUntil = 0;
const RECENT_PROTECT_MS = 30_000;
let note = "";
// 정리(prune) 주기 기준 — **파일 수가 아니라 누적 바이트**다. 40KB 썸네일과 20MB 프레임을
// 같은 1건으로 세면 초과분이 바이트로 통제되지 않는다(썸네일만 받는 구간에서는 2GB 를 넘겨도
// 50건이 안 차고, 프레임 구간에서는 50건이 1GB 를 넘긴다).
let sinceBytes = 0;
const PRUNE_BYTES = 256 * 1024 * 1024;
const listeners = new Set<() => void>();
// 상한 도달 게이트 — 자동 삭제가 꺼져 있거나(사용자 선택) 보호 때문에 못 지운 경우 **더 받지
// 않는다**. 안 그러면 할당량이 터져 브라우저가 v1/ 트리를 통째로 조용히 지운다.
let overLimit = false;
// 보호 대상만으로 상한을 넘은 상태가 몇 번 연속인가 — 안내 문구를 '실행 가능한' 것으로 바꾸는 기준.
let blockedStreak = 0;
const BLOCKED_NOTE_STREAK = 3;
let gateNote = false;                        // note 를 게이트 사유로 채웠는가(풀릴 때 되돌리려고)
let idleNote = false;                        // note 를 '용량으로 건너뜀' 안내로 채웠는가
// 축출 판단에 영향을 주는 설정의 지문 — 바뀌었을 때만 종결(evicted)을 푼다(dlQueueRule.evictConfigKey).
let evictCfgKey = "";
let warnArmed = true;                        // 상한 근접 알림은 세션 1회(임계 아래로 내려가면 재무장)
let maintaining = false;
let lastMaint = 0;
const MAINT_MIN_MS = 30_000;                 // 무효화 자체는 검사 단위지만, 축출 판정 왕복은 아껴야 한다

export function onDlProgress(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
function ping(): void { listeners.forEach((cb) => cb()); }

export function dlProgress(): DlProgress {
  const target = scoped();
  return {
    running: lockHeld && !stopped,
    // ★ 축출된 검사는 완료로 세지 않는다(doneCount 가 evicted 를 뺀다). '저장소는 비었는데 N/N'
    //   이라는 모순 화면은 여기서 푸는 것이지, 큐를 되살려서 푸는 게 아니다 — 그렇게 풀었다가
    //   10분마다 다시 받고 다시 지우는 트레드밀이 됐다.
    done: doneCount(target, st),
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
  // ⚠ 대상에서 **빠진** 검사를 받고 있었다면 그 자리에서 접는다. downloadStudy/pump 는 queue 를
  //   다시 읽지 않고 stopped/promoteTick 만 보므로, 토큰을 올리지 않으면 새 조건과 무관한 검사가
  //   끝까지 받아진다(검색 조건을 좁혔는데 옛 조건의 검사를 계속 내려받는다).
  //   ⚠ 반대로 **매번** 올리면 안 된다 — 목록 자동 갱신마다 진행 중인 검사가 중단·재시작되며
  //     seriesTree 를 왕복한다. 그래서 '지금 받는 것이 범위 밖일 때만'.
  if (curUid && !scoped().some((q) => q.studyUid === curUid)) promoteTick++;
  ping();
}

/** 사용자가 검사를 여는 순간 — 그 검사를 큐 맨 앞으로 올리고, 선다운로드를 잠시 감속한다.
 *  (열린 검사의 영상이 최우선이고, 동시에 A 를 때리는 총량을 줄인다) */
export function dlPromote(studyUid: string, ms = 4000): void {
  yieldUntil = Date.now() + ms;
  const i = queue.findIndex((q) => q.studyUid === studyUid);
  if (i > 0) { const [it] = queue.splice(i, 1); queue.unshift(it); }
  // 다시 확인(부분 다운로드였을 수 있다) — 이미 받은 파일은 건너뛴다.
  // ★ 용량 축출로 종결된 검사를 되살리는 **유일한 자동 계기**가 여기다. 사용자가 그 검사를 여는
  //   순간만이 재다운로드가 정말 필요한 시점이고, 그 밖의 자동 재큐잉은 전부 트레드밀이 된다.
  releaseEvicted(st, studyUid);
  failTries.delete(studyUid);   // 사용자가 직접 열었다 — 백오프를 기다리게 하지 않는다
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
  const hit: string[] = [];
  for (const q of queue) {
    if (!ids.has(q.studyId)) continue;
    try { await opfsEvictStudy(q.studyUid); } catch { /* 항목 단위 무시 */ }
    // 픽셀이 바뀐 검사는 **다시 받아야** 한다 — 용량 축출(종결)과 성질이 반대다.
    releaseEvicted(st, q.studyUid);
    hit.push(q.studyUid);
  }
  // 이 창 + 열려 있는 뷰어 창들의 blob 캐시 폐기 → 재조회. **그 검사만** 버린다.
  if (hit.length) dlInvalidateStudies(hit);
  ping();
}

/** 저장소를 통째로 비운 뒤(설정 '지금 비우기') 호출 — **다시 받게** 만든다.
 *  doneUids 를 그대로 두면 loop() 의 `!doneUids.has(...)` 필터에 전부 걸려, 저장소는 비었는데
 *  아무것도 재다운로드되지 않고 진행 표시만 '검사 N/N' 으로 남는다(사용량 0 과 모순).
 *  dlReset 과 달리 enabled 를 끄지 않는다 — 비우기는 종료가 아니라 재시작이다. */
export function dlForgetDone(): void {
  // ★ 축출 종결(evicted) 해제 계기 ⑵ — 저장소를 비웠으니 '용량 때문에 담지 않는다'는 결론도 없다.
  releaseEvicted(st);
  doneUids.clear(); failUntil.clear(); failTries.clear();
  filesGot = 0; sinceBytes = 0;
  // 저장소가 비었으니 상한 게이트·근접 알림도 원상복구한다 — 안 그러면 '비웠는데도 더 안 받는다'
  // 가 되고(게이트가 선 채로 남는다) 알림은 세션 내내 다시 뜨지 않는다.
  overLimit = false; warnArmed = true; blockedStreak = 0;
  recentUid = ""; recentUntil = 0;
  if (gateNote || idleNote) { note = ""; gateNote = false; idleNote = false; }
  lastMaint = 0;   // 다음 maintain 이 최소 주기에 막히지 않게
  promoteTick++;   // 진행 중이던 검사 루프를 그 자리에서 접는다(지워진 파일을 이어받지 않게)
  ping();
}

/* ── 용량 초과 자동 삭제 ─────────────────────────────────────────────────────
 * 예전에는 정리(opfsPrune)의 호출자가 pump 안 '성공 저장 50건마다' **하나뿐**이었다. 그래서
 *   · 상한을 20GB→2GB 로 낮춰도 저장이 일어나기 전까지 아무 일도 안 났고,
 *   · 큐를 다 받아 idle 이면 영원히 안 돌았고,
 *   · download→live 로 바꾸면 dlStop 만 돌아 초과분이 로그아웃까지 남았다.
 * 이제 호출자는 넷이다: dlConfigure 직후 / loop 진입 / loop 의 idle·검사 사이 틱 / pump 의
 * 누적 바이트 임계. 전부 maintain() 하나를 부르고, maintain 은 멱등하며 실패를 삼킨다.
 */

/** 지우면 안 되는 검사 — 판정 본체는 dlQueueRule.computeProtectedUids(순수 함수)다.
 *  여기서는 장부를 읽어 넘기기만 한다(그래야 node 테스트가 '큐에서 빠진 prior' 같은 케이스를
 *  직접 못 박을 수 있다 — tests/dl_protect_rule.test.mjs).
 *
 *  출처는 **만료되는 신호만** 쓴다:
 *   (a) 지금 받는 중인 검사(curUid) + 방금 받은 검사(recentUid, 30초) — 자기삭제 되돌이 차단.
 *   (b) 뷰어 창들이 직접 남긴 uid 장부(dlHeld, TTL 90s) — 열려 있는 **모든** Exam 탭을 덮는다.
 *   (c) 살아 있는 뷰어 슬롯(viewerSlots, TTL 90s)의 studyId → 큐로 uid 변환(보조).
 *
 *  ⚠ 예전 (c) 였던 localStorage `sv_viewer_tabs` 는 뺐다 — Viewer2D 전용이라 ViewerInfi 에서는
 *    항상 비었고, 만료가 없어 브라우저 X 로 닫은 창의 8건이 무기한 축출 불가로 남아 게이트를
 *    잠갔다(그때 안내는 '창을 닫으면 이어받습니다' 인데 사용자는 이미 다 닫은 상태다).
 *    그 장부는 '탭 복원용 UI 장부' 라는 원래 역할로 되돌렸다. 자세한 근거는 lib/dlHeld.ts 머리말.
 *  ⚠ 장부는 localStorage = **오리진별**이다. VITE_VIEWER_BASE 배치(뷰어 창이 다른 포트)에서는
 *    워크리스트 창에서 보이지 않는다. 다만 그 배치는 dlSupportReason() 이 다운로드 기능 자체를
 *    끄므로(opfsStore.ts) 현재 노출은 없다 — 그 전제가 깨지면 여기부터 다시 봐야 한다.
 *  ⚠ 뷰어는 첫 로드 뒤 blob URL 을 메모리에 들고 있어 opfsGet 을 다시 부르지 않는다(=lastUsed 가
 *    갱신되지 않는다). 그래서 '보고 있는 검사'를 lastUsed 로는 알 수 없고, 이 장부가 유일한 근거다. */
function protectedUids(): string[] {
  let held: string[] = [];
  let slotIds: number[] = [];
  try { held = liveHeldStudyUids(); } catch { /* 접근 불가 — (a) 만으로도 자기삭제는 닫힌다 */ }
  try { slotIds = [...liveViewerSlots().values()]; } catch { /* 무시 */ }
  return computeProtectedUids({
    now: Date.now(), curUid, recentUid, recentUntil,
    heldUids: held, slotStudyIds: slotIds, queue,
  });
}

/** 상한 근접 알림 — 워크리스트 창에서만 뜬다(이 모듈이 워크리스트 창에서만 돌기 때문).
 *  판독 중인 뷰어 창에 토스트가 겹치면 방해가 된다.
 *  띄울지 말지의 판정은 dlQueueRule.shouldWarnNearLimit 이 한다 — 자동 삭제가 정상 작동 중인
 *  '상한 100%' 는 정상 착지값이지 경보가 아니다(그 주석 참조). */
function warnCheck(used: number, limit: number, blocked: boolean): void {
  const r = shouldWarnNearLimit({
    enabled: cfg.warnNearLimit, autoEvict: cfg.autoEvict, blocked,
    used, limit, warnAtPct: cfg.warnAtPct, armed: warnArmed,
  });
  warnArmed = r.armed;
  if (!r.warn) return;
  const pct = Math.round((used / limit) * 100);
  showToast(
    `받아 둔 영상이 저장 상한의 ${pct}% 입니다` +
    (blocked
      ? " — 열려 있는 검사만으로 상한을 넘어 더 받지 못합니다."
      : " — 자동 삭제가 꺼져 있어 곧 중지됩니다."),
    "error");
}

/** 상한 유지 1회분 — 정리 + 게이트 판정 + 근접 알림. 멱등, 실패는 삼킨다.
 *  force=false 면 최소 주기(MAINT_MIN_MS)를 지킨다(인덱스 전량 조회 왕복을 아낀다).
 *  ★ 예전에는 이 주기가 '판독 중 blob 캐시 전멸' 을 막는 유일한 방벽이었는데, pump 의 누적 바이트
 *    경로가 force=true 로 그걸 대놓고 우회해서 사실상 무방비였다. 지금은 무효화가 **검사 단위**라
 *    (dlInvalidateStudies) 지워진 검사의 blob URL 만 폐기된다 — 보고 있는 검사는 그대로 남는다. */
async function maintain(force = false): Promise<void> {
  if (maintaining || dlSupportReason()) return;
  const now = Date.now();
  if (!force && now - lastMaint < MAINT_MIN_MS) return;
  maintaining = true;
  lastMaint = now;
  try {
    const limit = await opfsLimitBytes(cfg.limitGb);
    const r = await opfsPrune(limit, {
      policy: cfg.evictBy,
      protectedUids: protectedUids(),
      dryRun: !cfg.autoEvict,       // 자동 삭제 OFF = 지우지 않고 '얼마나 찼는지'만 본다
    });
    if (r.evicted.length) {
      // 축출 후처리 — **종결 상태**로 만든다(dlQueueRule.applyEviction).
      //  · doneUids 에서 빼면 그 검사가 곧바로 다시 최우선 후보가 된다 = 다운로드→삭제 트레드밀.
      //    진행률의 정직함은 dlProgress 의 doneCount(evicted 제외)가 담당한다.
      //  · failUntil 은 네트워크 실패용이라 용량 사유에는 구조적으로 맞지 않는다(지연일 뿐 종결이 아니다).
      //  · 무효화를 안 하면 뷰어 창이 **지워진 파일의 blob URL** 을 계속 서빙한다 —
      //    다만 **그 검사만** 버린다(dlInvalidateStudies). 전량 폐기는 판독 중 화면을 서버 렌더로 되돌린다.
      applyEviction(st, r.evicted);
      dlInvalidateStudies(r.evicted);
    }
    const used = Math.max(0, r.totalBytes - r.freed);
    // 게이트: 자동 삭제 OFF 이거나(사용자 선택) 보호 때문에 못 지운 경우 더 받지 않는다.
    //  · 자동 삭제 ON: 정리 뒤에도 상한을 **넘었을** 때만(정리는 상한 이하로 맞추므로 정상이면 꺼진다)
    //  · 자동 삭제 OFF: 상한에 **도달**하면 곧바로(넘기고 나서 멈추면 그 초과분이 그대로 남는다)
    overLimit = r.blocked || (cfg.autoEvict ? used > limit : used >= limit);
    blockedStreak = r.blocked ? blockedStreak + 1 : 0;
    // 사유는 note 로 실어 설정>영상 취득의 '진행' Row 에 그대로 뜨게 한다 — 조용히 멈추면
    // '켰는데 안 받는다'는 진단 불가 버그가 된다(dlSupportReason 이 사유를 내는 것과 같은 규약).
    if (overLimit) {
      note = !cfg.autoEvict
        ? "저장 상한에 도달했습니다 — 자동 삭제가 꺼져 있어 더 받지 않습니다."
        : blockedStreak >= BLOCKED_NOTE_STREAK
          // ★ '창을 닫으세요' 만 안내하면 안 된다 — 이미 다 닫았는데 풀리지 않는 상황이 있었고
          //   (만료 없는 탭 장부), 그때 실제 복구 수단은 이 두 가지뿐이다.
          ? "열려 있는 검사만으로 저장 상한을 넘었습니다 — 설정 > 환경 > 영상 취득에서 [지금 비우기] 를 누르거나 저장 상한을 올려야 이어받습니다."
          : "저장 상한에 도달했습니다 — 보고 있는 검사는 지우지 않으므로, 뷰어 창을 닫거나 상한을 늘리면 이어받습니다.";
      gateNote = true; idleNote = false;
    } else if (gateNote) { note = ""; gateNote = false; }
    warnCheck(used, limit, r.blocked);
    ping();
  } catch { /* 정리는 보조 경로다 — 실패해도 다운로드를 막지 않는다 */ }
  finally { maintaining = false; }
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
  if (stopped || token !== promoteTick) return 0;
  // 이미 받아 둔 것은 여기서 걸러낸다 — 규칙 본체는 opfsStore.pendingTasks(주석 참조).
  // 재개(뷰어를 닫았다 다시 열기)가 '처음부터 다시 받기'가 되지 않는 근거가 이 한 줄이다.
  const todo = await pendingTasks(tasks, opfsHas);
  let i = 0;
  let failed = 0;
  const n = Math.max(1, Math.min(4, cfg.concurrency || 2));
  const worker = async () => {
    for (;;) {
      if (stopped || token !== promoteTick) return;
      if (Date.now() < yieldUntil) { await sleep(400); continue; }
      const t = todo[i++];
      if (!t) return;
      const blob = await fetchBlob(t.url);
      if (!blob) { failed++; continue; }
      if (await opfsPut(t.key, blob, t.kind, t.sop, meta, t.fmt)) {
        filesGot++;
        // 누적 **바이트** 기준(위 sinceBytes 주석). force=true 인 이유: 임계 자체가 이미
        // 충분한 감속기다(256MB 를 받는 동안 최소 주기가 또 걸리면 상한을 크게 넘긴다).
        // ⚠ 예전에는 이 force 가 '판독 중 blob 캐시 전멸' 을 막던 30초 가드를 대놓고 우회하는
        //   경로였다. 지금은 무효화가 검사 단위라(dlInvalidateStudies) 지워진 검사만 폐기된다.
        sinceBytes += blob.size;
        if (sinceBytes >= PRUNE_BYTES) { sinceBytes = 0; await maintain(true); }
        if (filesGot % 10 === 0) ping();
      } else failed++;
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
  return failed;
}

async function downloadStudy(item: DlQueueItem, token: number): Promise<boolean> {
  curLabel = item.label || item.studyUid.slice(-8);
  curUid = item.studyUid;
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

/** idle 안내 — 용량 때문에 건너뛴 검사가 있으면 조용히 멈추지 않고 이유를 남긴다.
 *  (게이트 사유가 이미 실려 있으면 건드리지 않는다 — 게이트가 더 급한 정보다.) */
function noteSkipped(): void {
  if (gateNote) return;
  const n = skippedCount(scoped(), st);
  const want = n
    ? `저장 상한에 맞춰 과거 검사 ${n}건을 삭제했습니다 — 그 검사는 워크리스트에서 열 때 다시 받습니다.`
    : "";
  if (note === want) return;
  if (note && !idleNote) return;   // 다른 사유(지원 불가·다른 창)를 덮지 않는다
  note = want; idleNote = !!want;
}

/** myGen: 진입 시점의 정지 세대. dlStop 이 gen 을 올리면 stopped 가 곧바로 false 로 뒤집혀도
 *  (닫자마자 다시 열기) 이 루프는 자기 세대가 낡은 것을 보고 접는다 — 그래야 Web Lock 을 놓는다.
 *  ⚠ 진행 중이던 fetch 는 취소하지 않는다(이미 받은 바이트를 버리는 셈 — pump 주석의 결정).
 *    따라서 '닫았는데 잠깐 더 받는다'는 꼬리가 남지만 **유계**다: 동시 fetch(≤concurrency, 최대 4)
 *    + seriesTree 1건이 끝나는 시간까지. 이걸 없애려고 AbortController 를 넣으면 재개 시 그 파일을
 *    처음부터 다시 받게 되므로 별건으로 다룬다. */
async function loop(myGen: number): Promise<void> {
  try { await opfsPersist(); } catch { /* 무시 */ }
  await maintain(true);   // 진입 1회 — 설정을 낮춘 채 창을 다시 열었을 때도 즉시 반영된다
  while (!stopped && myGen === gen) {
    const token = promoteTick;
    const now = Date.now();
    // ★ 상한 게이트는 **검사 단위**다(pump 안이 아니라 여기). 받는 중인 검사는 끝까지 받게 두고
    //   다음 검사를 시작하지 않는다 — pump 안에서 끊으면 반쪽 검사가 남아 실패로 집계되고,
    //   백오프·재시도를 반복하다 FAIL_GIVEUP 으로 '포기' 처리돼 세션 내내 안 채워진다.
    if (overLimit) {
      curLabel = ""; curUid = "";   // 사유(note)는 maintain 이 이미 실어 두었다
      ping();
      await sleep(5000);
      await maintain();   // 사용자가 상한을 올리거나 창을 닫으면 여기서 게이트가 풀린다
      continue;
    }
    await maintain();     // 검사 사이 주기 정리(최소 주기 내면 즉시 반환)
    // ★ 후보 선택은 dlQueueRule.pickNextStudy 하나다 — 용량 축출된 검사(evicted)는 여기서
    //   **완전히** 빠진다. 이것이 '큐가 상한보다 클 때 상태가 수렴하는' 유일한 근거다.
    const next = pickNextStudy(scoped(), st, now);
    if (!next) {
      curLabel = ""; curUid = ""; noteSkipped();
      ping();
      await sleep(2000);
      await maintain();   // idle 이어도 정리는 돈다 — 예전엔 '저장이 없으면 절대 안 도는' 상태였다
      continue;
    }
    const ok = await downloadStudy(next, token);
    if (ok) {
      doneUids.add(next.studyUid);
      failUntil.delete(next.studyUid); failTries.delete(next.studyUid);
      // 방금 받은 검사를 한 주기 더 보호한다 — 게이트 진입에서 curUid 를 비우는 순간(아래) 보호가
      // 풀려 '상한보다 큰 검사 하나'가 다 받자마자 스스로 지워지는 경로를 닫는다. 유계(30초).
      recentUid = next.studyUid; recentUntil = Date.now() + RECENT_PROTECT_MS;
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
  curLabel = ""; curUid = ""; ping();
}

export function dlConfigure(next: DlConfig): void {
  cfg = { ...next, concurrency: Math.max(1, Math.min(4, next.concurrency || 2)) };
  // ★ 축출 종결(evicted) 해제 계기 ⑴ — 상한·기준·범위·자동삭제가 바뀌면 판정 자체가 달라지므로
  //   '이 조건에서는 담기지 않는다'는 결론을 버린다.
  //   ⚠ **무조건** 풀면 안 된다. dlConfigure 는 워크리스트 마운트·설정 저장·서버모드 전환마다
  //     불리므로, 매번 풀면 축출→재다운로드 트레드밀이 그대로 되살아난다(이 회차 회귀의 재발).
  //     그래서 지문(evictConfigKey)이 실제로 바뀐 경우에만 푼다.
  const key = evictConfigKey(cfg);
  if (evictCfgKey && evictCfgKey !== key) { releaseEvicted(st); blockedStreak = 0; }
  evictCfgKey = key;
  // ⚠ '이전 값과 달라졌을 때만' 기동하면 안 된다 — 워크리스트가 언마운트되며 dlStop() 한 뒤
  //   다시 마운트되면 cfg.enabled 는 그대로 true 라 '변화 없음'으로 판정돼 다운로더가 영영
  //   안 돌아온다. dlStart/dlStop 은 둘 다 멱등하므로 매번 현재 상태를 그대로 반영한다.
  if (cfg.enabled) dlStart(); else dlStop();
  // ★ 설정 저장 직후 **1회 강제 정리**. 이게 없으면 상한을 20GB→2GB 로 낮춰도 다음 '성공 저장'이
  //   일어나기 전까지 아무 일도 안 난다(큐를 다 받아 idle 이면 영원히, download→live 로 껐으면
  //   로그아웃까지 초과분이 남는다). 껐을 때도 돌아야 하므로 enabled 밖에서 부른다.
  //   ⚠ dryRun 이 아니므로 실제로 지운다 — 다만 보호 집합(보고 있는 검사)은 그대로 지켜진다.
  void maintain(true);
  ping();
}

/** 스케줄러 기동 — Web Lock 을 잡은 창 **하나만** 실제로 돈다(다른 창은 대기하다 조용히 끝난다).
 *  ⚠ 이 함수는 cfg.enabled 를 **보지 않는다**(dlConfigure 가 이미 판단한 뒤 부르는 내부 경로다).
 *    설정 상태를 모르는 곳에서 재개하려면 반드시 dlResume() 을 써라 — 맨몸으로 부르면 다운로드
 *    모드가 꺼져 있거나 Live 가 아닐 때도 루프가 돌며 원격 A 에 요청이 나간다(무증상이라 늦게 발견된다). */
export function dlStart(): void {
  const why = dlSupportReason();
  if (why) { note = why; ping(); return; }
  if (!stopped) return;
  stopped = false;
  note = "";
  void acquire(gen);
}

/** 정지된 스케줄러를 **다시** 기동한다 — 뷰어를 닫아(dlStop) 멈춘 뒤 다시 열었을 때의 경로.
 *  다운로드 모드가 꺼져 있거나(설정 '영상 취득'=Live) 비 Live 모드면 아무것도 하지 않는다.
 *  ★ 이 함수가 없으면 '뷰어를 닫으면 멈춘다'가 곧 '그 세션 내내 죽는다'가 된다 — dlStart 는
 *    dlConfigure(설정 저장·서버모드 전환) 안에서만 불렸기 때문. 호출자: Worklist.markDlOpened. */
export function dlResume(): void {
  if (!cfg.enabled) return;
  dlStart();
}

/** Web Lock 확보 → 루프. ifAvailable 로 **즉시 포기**하고 재시도한다.
 *  대기 큐에 쌓아 두면 다운로더 창이 닫힐 때 뒤늦게 깨어나 예상 못 한 시점에 다운로드가 시작된다. */
async function acquire(myGen: number): Promise<void> {
  let misses = 0;
  while (!stopped && myGen === gen) {
    let got = false;
    const run = async () => {
      got = true; lockHeld = true; note = ""; ping();
      try { await loop(myGen); } finally { lockHeld = false; ping(); }
    };
    if (navigator.locks?.request) {
      await navigator.locks.request("sv-dl-scheduler", { mode: "exclusive", ifAvailable: true },
        async (lock) => { if (lock) await run(); }).catch(() => { lockHeld = false; });
    } else {
      await run();   // Web Locks 미지원 — 창 1개 가정(중복은 pendingTasks 스킵으로 완화)
    }
    if (stopped || myGen !== gen) break;
    if (!got) {
      misses++;
      // '다른 창인가' 를 **횟수가 아니라 사실로** 판정한다(진리표·근거는 lib/dlLock.ts).
      //  · lockHeld=true → 이 창의 옛 loop 이 아직 놓는 중이다. 해제 지연은 가장 늦게 끝나는
      //    in-flight fetch 시간이라 700ms 로 유계가 아니다 — 예전 '2회 실패면 다른 창' 규칙은
      //    이 창인데도 '다른 창이…' 라는 틀린 안내를 띄우고 재개를 5초 밀었다.
      //  · dlStop 직후(유예 안)의 실패도 같은 이유로 우리 탓으로 본다.
      const d = decideLockNote(misses, lastStopAt ? Date.now() - lastStopAt : Infinity, lockHeld);
      if (d.note) { if (note !== LOCK_BUSY_NOTE) { note = LOCK_BUSY_NOTE; ping(); } }
      else if (note === LOCK_BUSY_NOTE) { note = ""; ping(); }   // 오안내가 남지 않게 되돌린다
      await sleep(d.waitMs);
    } else misses = 0;
  }
}

export function dlStop(): void {
  stopped = true;
  // ★ 정지 시각을 남긴다 — 옛 loop 이 Web Lock 을 놓는 데 걸리는 시간은 in-flight fetch 에
  //   묶여 유계가 아니므로, 그 직후의 Lock 실패를 '다른 창' 으로 오인하지 않게 한다
  //   (lib/dlLock.decideLockNote). 이 한 줄이 없으면 재개마다 오안내 + 5초 지연이 남는다.
  lastStopAt = Date.now();
  // 세대를 올려 아직 await 중인 옛 acquire/loop 을 무효화하고(위 gen 주석), promoteTick 으로
  // 진행 중이던 pump 워커까지 접는다. stopped 만 세우면 곧바로 dlResume 이 stopped 를 false 로
  // 되돌렸을 때 옛 loop 이 살아남아 Web Lock 을 계속 쥔다.
  gen++;
  promoteTick++;
  curLabel = "";
  curUid = "";
  ping();
}

/** 세션 종료 시 상태 초기화 — 다음 로그인이 남은 진행률을 물려받지 않게 한다. */
export function dlReset(): void {
  dlStop();
  cfg = { ...cfg, enabled: false };
  // ★ 축출 종결(evicted) 해제 계기 ⑶ — 세션이 바뀌면 상태를 물려주지 않는다.
  releaseEvicted(st);
  queue = []; doneUids.clear(); failUntil.clear(); failTries.clear(); filesGot = 0; note = "";
  sinceBytes = 0; overLimit = false; warnArmed = true; gateNote = false; idleNote = false;
  blockedStreak = 0; recentUid = ""; recentUntil = 0; evictCfgKey = ""; lastMaint = 0;
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
