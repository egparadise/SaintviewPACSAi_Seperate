// 다중 모니터 뷰어 "슬롯" 공유 상태 — 어느 모니터 창이 **살아 있고** 무슨 검사를 물고 있는가 +
// 라운드로빈 순번. 워크리스트·뷰어·판독창이 같은 상태를 보고 창을 배치한다.
//
// ── 규칙(사용자 확정, 2026-07-29) ──────────────────────────────────────────────
//  ① 사이클 시작(살아 있는 뷰어 창이 0개)인 **첫 오픈**  = 선택된 전 모니터에 창을 열고 모두 같은 검사.
//  ② 두 번째 오픈부터                                   = 모니터 번호순으로 **대상 창 하나만** 리로드,
//                                                         나머지 모니터는 Exam 탭만 추가(리로드 없음).
//  이는 커밋 109c2cb(전 모니터 오픈) + 6da23e0(라운드로빈)을 합친 것이다. 6da23e0 이 109c2cb 의
//  forEach 를 통째로 라운드로빈 단일 오픈으로 바꾸면서 ①의 부트스트랩이 사라진 것이 회귀였다.
//
// ── 왜 localStorage 인가 ──────────────────────────────────────────────────────
//  예전엔 라운드로빈 카운터와 열린 창 맵이 Worklist.tsx 의 **모듈 변수**였다. 워크리스트 탭을 F5 하면
//  그 문서만 새로 뜨는데 뷰어 창(sv_viewer / sv_viewer_slot*)은 브라우저에 그대로 살아 있다 →
//  카운터만 0 으로 돌아가 1번 모니터부터 다시 덮어썼다("3번에 떠야 할 영상이 1번에 뜬다").
//  순번은 워크리스트 문서 수명이 아니라 **모니터 벽의 실제 상태**에 종속돼야 한다.
//
// ── 왜 창마다 키를 나누나 ────────────────────────────────────────────────────
//  하나의 JSON 을 여러 창이 read-modify-write 하면 항목이 유실된다(이 저장소가 sv_infi_exams 로
//  실제로 겪은 경합). 창 하나 = 키 하나면 서로 덮어쓸 일이 없다.
//
// ── 왜 pagehide 에서 지우지 않고 TTL + 유예인가 ──────────────────────────────
//  라운드로빈 대상 창은 URL 로 **리로드**된다. 리로드도 pagehide 를 발생시키므로 거기서 항목을 지우면
//  "창이 하나도 없다"로 오판해 ①의 부트스트랩이 다시 돌아 전 모니터가 같은 검사로 덮인다.
//  그래서 pagehide 는 지우지 않고 "내려가는 중" 표식(u)만 남긴다 — 리로드면 새 문서의 첫 하트비트가
//  즉시 표식을 지우고, 진짜 닫힘이면 유예(SLOT_UNLOAD_GRACE_MS) 뒤 만료된다.
//  정상 닫기 경로는 releaseViewerSlot() 이 즉시 반납한다. 크래시·강제종료는 TTL 이 마지막 안전망.
//
// ── 왜 TTL 이 90초인가(예전엔 6초였다) ───────────────────────────────────────
//  Chrome 은 hidden 문서의 setInterval 을 1초로 정렬하고, hidden 5분이 지나면 **1분에 1회**까지
//  늦춘다(intensive throttling). Windows 는 완전히 가려진 창도 occlusion 으로 hidden 처리한다.
//  TTL 이 6초면 멀쩡히 살아 있는 뷰어 창이 '죽은 것'으로 보여 ①부트스트랩이 전 모니터를 덮어썼다
//  (= "다른 앱 쓰다 돌아오니 첫 영상이 사라진다"). TTL 을 스로틀 주기보다 넉넉히 크게 두고,
//  '진짜 닫힘'의 반응성은 releaseViewerSlot() + pagehide 유예가 담당한다.
//
// ── 한계: 교차 출처(VITE_VIEWER_BASE) 배치 ──────────────────────────────────
//  localStorage 는 **오리진별**이다. VIEWER_BASE 를 설정해 뷰어 창을 다른 포트/호스트로 띄우면
//  뷰어의 하트비트는 그쪽 오리진에 쌓이고 워크리스트 오리진에서는 **보이지 않는다**.
//  그래서 워크리스트는 이 장부만 믿지 않고 자기가 들고 있는 창 핸들(!w.closed — 교차 출처에서도
//  읽힌다)을 합집합으로 함께 본다(Worklist.openV2 의 liveHere). 워크리스트를 F5 하면 그 핸들도
//  사라지므로 교차 출처 배치에서는 F5 직후 한 번 ①부트스트랩으로 떨어질 수 있다(같은 오리진
//  배치에서는 장부가 남아 순번이 이어진다). opfsStore 처럼 기능을 끄지는 않는다 — 배치는 여전히
//  동작하고 순번만 재시작되기 때문.

export type ViewerSlot = { index: number; features: string };

const SLOT_PREFIX = "sv_vslot_";
const RR_KEY = "sv_viewer_rr";
/** 하트비트 주기 — 리로드 공백(문서 교체)보다 짧아야 유예 안에 들어온다 */
export const SLOT_HEARTBEAT_MS = 2000;
/** 생존 판정 TTL — 스로틀링(hidden 5분 후 1분에 1회)을 견뎌야 한다. 위 주석 참조. */
export const SLOT_TTL_MS = 90_000;
/** pagehide 후 이 시간 안에 하트비트가 다시 오지 않으면 '진짜 닫힘'으로 본다(리로드는 즉시 재기록).
 *  리로드 공백(문서 교체+뷰어 마운트)을 넉넉히 덮어야 한다 — 예전 TTL(6s)이 그 역할을 했으므로
 *  그보다 짧게 잡지 않는다. 이 값을 줄이면 무거운 검사를 리로드하는 동안 창이 '죽은 것'으로 보여
 *  ①부트스트랩이 전 모니터를 덮어쓴다. */
export const SLOT_UNLOAD_GRACE_MS = 8000;

/** 뷰어 창 이름 규약 — 최저번호 모니터는 표준 "sv_viewer"(ReportWindow ◀▶·관련검사 오픈이 참조),
 *  나머지는 "sv_viewer_slot{모니터인덱스}".
 *  ⚠ 이 규약은 예전에 Worklist.openV2 의 nameFor 와 screens.ts 의 openSlaveWindow 두 곳에 각각
 *    하드코딩돼 있었다(한쪽만 바꾸면 같은 모니터에 창이 두 개 생긴다). 여기가 단일 출처다. */
export function viewerSlotName(monitorIndex: number, firstIndex: number | undefined): string {
  return (firstIndex === undefined || monitorIndex === firstIndex)
    ? "sv_viewer" : `sv_viewer_slot${monitorIndex}`;
}

const NAME_RE = /^sv_viewer(_slot\d+)?$/;
export function isViewerSlotName(name: string): boolean { return NAME_RE.test(name); }

/** 이 슬롯(창)이 살아 있고 studyId 를 물고 있음을 기록. 창을 여는 쪽(워크리스트/뷰어)도 즉시 호출해야
 *  한다 — 새 창의 첫 하트비트 전에 다음 오픈이 일어나면 "창 0개"로 오판하기 때문. */
export function noteViewerSlot(name: string, studyId: number): void {
  if (!isViewerSlotName(name)) return;
  // u(내려가는 중 표식)를 싣지 않는다 = 기록하는 순간 표식이 지워진다(리로드 복귀).
  try { localStorage.setItem(SLOT_PREFIX + name, JSON.stringify({ s: studyId, t: Date.now() })); }
  catch { /* quota/차단 — 슬롯 추적 없이도 동작(사이클 시작으로 폴백) */ }
}

/** pagehide — 이 창이 내려간다(리로드일 수도, 진짜 닫힘일 수도). 지우지 않고 표식만 남긴다.
 *  리로드면 새 문서의 첫 noteViewerSlot 이 표식을 지우고, 진짜 닫힘이면 유예 뒤 만료된다. */
export function markViewerSlotUnloading(name: string): void {
  if (!isViewerSlotName(name)) return;
  try {
    const raw = localStorage.getItem(SLOT_PREFIX + name);
    if (!raw) return;
    const rec = JSON.parse(raw) as { s?: number; t?: number };
    localStorage.setItem(SLOT_PREFIX + name, JSON.stringify({ ...rec, u: Date.now() }));
  } catch { /* 무시 */ }
}

export function forgetViewerSlot(name: string): void {
  try { localStorage.removeItem(SLOT_PREFIX + name); } catch { /* 무시 */ }
}

/** 살아 있는 뷰어 슬롯 — 창이름 → 그 창이 물고 있는 studyId. 만료분은 훑는 김에 정리한다. */
export function liveViewerSlots(): Map<string, number> {
  const out = new Map<string, number>();
  const dead: string[] = [];
  try {
    const now = Date.now();
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(SLOT_PREFIX)) continue;
      let rec: { s?: number; t?: number; u?: number } | null = null;
      try { rec = JSON.parse(localStorage.getItem(k) ?? "null") as { s?: number; t?: number; u?: number } | null; }
      catch { rec = null; }
      const t = Number(rec?.t) || 0;
      const u = Number(rec?.u) || 0;   // pagehide 표식 — 유예 안에 하트비트가 안 오면 진짜 닫힘
      if (!rec || now - t > SLOT_TTL_MS || (u > 0 && now - u > SLOT_UNLOAD_GRACE_MS)) { dead.push(k); continue; }
      out.set(k.slice(SLOT_PREFIX.length), Number(rec.s) || 0);
    }
    for (const k of dead) localStorage.removeItem(k);
  } catch { /* 접근 불가 — 빈 결과(=사이클 시작) */ }
  return out;
}

/** All Close(전체 모니터) — 벽 전체가 비었으므로 다음 오픈은 다시 ①부트스트랩이어야 한다. */
export function clearViewerSlots(): void {
  try {
    const kill: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(SLOT_PREFIX)) kill.push(k);
    }
    for (const k of kill) localStorage.removeItem(k);
    localStorage.removeItem(RR_KEY);
  } catch { /* 무시 */ }
}

/** 다음 오픈이 쓸 슬롯 인덱스(모니터 번호 오름차순 목록의 위치). */
export function readViewerRoundRobin(): number {
  try {
    const n = Number(localStorage.getItem(RR_KEY));
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  } catch { return 0; }
}
export function writeViewerRoundRobin(n: number): void {
  try { localStorage.setItem(RR_KEY, String(Math.max(0, Math.floor(n)))); } catch { /* 무시 */ }
}

// ── ①②배치 규칙 본체 ────────────────────────────────────────────────────────
//  ⚠ 이 두 함수가 규칙의 **유일한 구현**이다. 예전엔 Worklist.openV2 안에 인라인으로 들어 있었고
//    회귀 테스트는 그 결정부를 테스트 파일에 '복사'해 검증했다 — 그래서 제품 코드의 분기를 죽여도
//    테스트가 전부 통과했다(부트스트랩 분기 삭제·noteViewerSlot 삭제·순번 오프셋 변경 모두 초록).
//    이제 워크리스트는 planViewerOpen 의 결과대로 window.open 만 하고, 테스트는 이 원본을 부른다.

export type ViewerOpenTarget = { index: number; features: string; name: string };
export type ViewerOpenPlan = {
  /** bootstrap = ①사이클 시작(선택 전 모니터에 같은 검사) / roundrobin = ②대상 창 하나만 */
  mode: "bootstrap" | "roundrobin";
  targets: ViewerOpenTarget[];
  /** 이번 오픈을 반영한 다음 순번 — openByPlan 이 기록한다 */
  nextRr: number;
};

/** 이번 오픈이 어느 창(들)을 쓸지 결정한다. 부작용 없음(장부를 읽지도 쓰지도 않는다 — 호출부가 넘긴
 *  liveNames/rr 만 본다). 그래야 워크리스트가 교차 출처 배치에서 창 핸들을 합집합으로 넣을 수 있다.
 *
 *  liveNames: 지금 살아 있다고 판단되는 창 이름들(슬롯 장부 ∪ 워크리스트가 든 !w.closed 핸들).
 *             현재 선택 슬롯에 속하지 않는 이름은 여기서 걸러진다(모니터 설정 축소 시 고아 창).
 *  rr:        readViewerRoundRobin() 값. */
export function planViewerOpen(slots: ViewerSlot[], liveNames: Iterable<string>, rr: number): ViewerOpenPlan {
  const first = slots[0]?.index;
  const target = (s: ViewerSlot): ViewerOpenTarget =>
    ({ index: s.index, features: s.features, name: viewerSlotName(s.index, first) });
  if (!slots.length) return { mode: "bootstrap", targets: [], nextRr: 0 };
  const valid = new Set(slots.map((s) => viewerSlotName(s.index, first)));
  const live = [...liveNames].filter((n) => valid.has(n));
  if (live.length === 0) {
    // ① 부트스트랩 — 선택된 전 모니터에 같은 검사. 다음 순번은 slots[1](2번 모니터)부터.
    //    0 으로 두면 두 번째 검사가 1번 모니터를 덮어써 "첫 영상이 사라진다".
    return { mode: "bootstrap", targets: slots.map(target), nextRr: 1 % slots.length };
  }
  // ② 라운드로빈 — 모니터 번호순 한 대씩.
  const i = ((Math.floor(rr) % slots.length) + slots.length) % slots.length;
  return { mode: "roundrobin", targets: [target(slots[i])], nextRr: (i + 1) % slots.length };
}

/** 계획대로 창을 열고(open 콜백) 장부·순번을 갱신한다. 반환: 실제로 열린 창 수(팝업 차단 감지용).
 *  open 은 window.open 을 감싼 호출부 콜백 — 사용자 클릭 활성화를 잃지 않도록 **동기**로 돌린다.
 *  noteViewerSlot 을 여기서 하는 이유: 새 창의 첫 하트비트 전에 다음 오픈이 오면 '창 0개'로 오판해
 *  부트스트랩이 다시 돌아 전 모니터를 덮어쓴다. */
export function openByPlan(
  plan: ViewerOpenPlan,
  studyId: number,
  open: (t: ViewerOpenTarget) => boolean,
): number {
  let opened = 0;
  for (const t of plan.targets) {
    if (!open(t)) continue;
    noteViewerSlot(t.name, studyId);
    opened += 1;
  }
  writeViewerRoundRobin(plan.nextRr);
  return opened;
}

// ── 뷰어 창 쪽 하트비트 ──────────────────────────────────────────────────────
let released = false;

/** 뷰어 창이 자기 슬롯의 생존을 주기적으로 알린다. 창 이름이 슬롯 규약이 아니면(일반 탭) 아무것도 안 함.
 *  getStudyId 는 "지금 이 창이 보여 주는 검사" — 워크리스트가 모니터별 배치 상태를 알 수 있게. */
export function startViewerSlotHeartbeat(getStudyId: () => number): () => void {
  if (typeof window === "undefined") return () => {};
  const name = window.name;
  if (!isViewerSlotName(name)) return () => {};
  released = false;
  let unloading = false;
  const beat = () => { if (!released && !unloading) noteViewerSlot(name, getStudyId()); };
  beat();
  const timer = window.setInterval(beat, SLOT_HEARTBEAT_MS);
  // 타이머만으로는 부족하다 — Chrome 은 hidden 문서의 인터벌을 1초→(5분 뒤)1분에 1회로 늦춘다.
  // 창이 다시 보이는 순간(visibilitychange/pageshow/focus) 즉시 슬롯을 되살려, 가려져 있던 동안
  // 벌어진 공백 때문에 워크리스트가 "창이 하나도 없다"로 오판하는 창을 최소화한다.
  const revive = () => { unloading = false; beat(); };
  const onHide = () => { unloading = true; markViewerSlotUnloading(name); };
  window.addEventListener("pagehide", onHide);
  window.addEventListener("pageshow", revive);
  window.addEventListener("focus", revive);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", revive);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener("pagehide", onHide);
    window.removeEventListener("pageshow", revive);
    window.removeEventListener("focus", revive);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", revive);
  };
}

/** 이 창이 **진짜로** 닫힌다(리로드 아님) — 슬롯을 즉시 반납해 다음 오픈이 TTL 을 기다리지 않게 한다.
 *  released 플래그로 닫히는 중의 잔여 하트비트가 슬롯을 되살리는 것을 막는다. */
export function releaseViewerSlot(): void {
  released = true;
  if (typeof window !== "undefined") forgetViewerSlot(window.name);
}
