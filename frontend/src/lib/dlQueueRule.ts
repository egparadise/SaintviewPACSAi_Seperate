// 다운로드 스케줄러의 **큐 결정 규칙** — 브라우저 API 의존 0.
//
// 왜 별도 모듈인가: dlScheduler.ts 는 api·imageFormat·dlCache·toast 를 import 하므로 node --test 가
// 통째로 부를 수 없다. 그래서 '무엇을 다음에 받는가 / 축출이 상태를 어떻게 바꾸는가 / 무엇을 보호하는가'
// 라는 **판정부**만 여기로 뺀다. 회귀 테스트(tests/dl_evict_loop.test.mjs, tests/dl_protect_rule.test.mjs)는
// 이 원본 함수를 그대로 부른다 — 판정을 테스트에 복사하면 제품 코드를 죽여도 초록이 된다(이 저장소가
// viewerSlots 에서 이미 겪은 유형이다).
//
// ── 핵심 규정: 용량 축출은 '지연' 이 아니라 **종결 상태** 다 ──────────────────────────────
// 예전에는 축출한 검사를 doneUids 에서 빼고 failUntil 에 10분 백오프만 걸었다. 그런데 후보 선택은
// `!done && failUntil<=now` 뿐이라 10분 뒤 **그 검사가 다시 최우선 후보**가 됐다. 받으면 또 상한을
// 넘고 planEvictions 가 또 가장 오래된 검사를 지운다 — 종료 조건이 없다.
// 큐 60건×200MB·상한 2GB 시뮬레이션에서 400분간 다운로드 400건·재다운로드 379건(전송 80GB 중 78GB
// 폐기)이 나왔고 보관 상태는 처음 10건과 같았다. 즉 재큐잉으로 얻는 것은 0, 원격 A 부하만 6.7배.
// failUntil 은 **네트워크 실패용** 이므로 용량 사유에는 구조적으로 맞지 않는다. 별도 skip 집합으로 옮기고
// 해제 계기를 셋으로 못 박는다: ⑴ 축출 관련 설정 변경 ⑵ '지금 비우기'/세션 리셋 ⑶ 사용자가 직접 오픈.

/** 스케줄러의 큐 상태 — dlScheduler 의 모듈 변수를 그대로 담는 뷰(복사본이 아니다). */
export interface DlLoopState {
  /** 이번 세션에 끝낸 검사 */
  done: Set<string>;
  /** 용량 때문에 지운 검사 = **종결**. 위 세 계기에서만 풀린다 */
  evicted: Set<string>;
  /** 네트워크 실패 백오프(만료 시각 ms). 용량 축출에는 쓰지 않는다 */
  failUntil: Map<string, number>;
}

export function newLoopState(): DlLoopState {
  return { done: new Set(), evicted: new Set(), failUntil: new Map() };
}

/** 다음에 받을 검사. **evicted 는 후보에서 완전히 빠진다** — 이것이 수렴의 유일한 근거다. */
export function pickNextStudy<T extends { studyUid: string }>(
  candidates: readonly T[], st: DlLoopState, now: number,
): T | undefined {
  return candidates.find((q) =>
    !!q.studyUid &&
    !st.done.has(q.studyUid) &&
    !st.evicted.has(q.studyUid) &&
    (st.failUntil.get(q.studyUid) ?? 0) <= now);
}

/** 축출 후처리 — 재큐잉을 만들지 않는다.
 *  ⚠ done 은 **건드리지 않는다**. 진행률의 정직함은 doneCount 가 evicted 를 빼면서 담당하고,
 *    done 에서 빼면 그 순간 후보로 되살아난다(그게 정확히 트레드밀이었다). */
export function applyEviction(st: DlLoopState, evicted: readonly string[]): void {
  for (const uid of evicted) {
    if (!uid) continue;
    st.evicted.add(uid);
    st.failUntil.delete(uid);   // 용량 사유는 백오프로 표현하지 않는다
  }
}

/** 축출 종결 해제 — 인자가 없으면 전부(설정 변경·비우기), 있으면 그 검사만(사용자가 직접 열었다).
 *  done 까지 함께 지워야 실제로 **다시 받는다**(evicted 만 지우면 done 필터에 걸려 그대로 멈춘다). */
export function releaseEvicted(st: DlLoopState, uid?: string): void {
  const kill = uid ? [uid] : [...st.evicted];
  for (const u of kill) { st.evicted.delete(u); st.done.delete(u); st.failUntil.delete(u); }
}

/** 진행률의 done — 축출된 검사는 **저장소에 없으므로** 완료로 세지 않는다.
 *  ('저장소는 비었는데 N/N' 이라는 모순 화면은 여기서 푼다. 큐를 되살려서 푸는 게 아니다.) */
export function doneCount<T extends { studyUid: string }>(
  candidates: readonly T[], st: DlLoopState,
): number {
  let n = 0;
  for (const q of candidates) if (st.done.has(q.studyUid) && !st.evicted.has(q.studyUid)) n++;
  return n;
}

/** 이번 범위에서 용량 때문에 건너뛴 검사 수 — 사용자 안내용. */
export function skippedCount<T extends { studyUid: string }>(
  candidates: readonly T[], st: DlLoopState,
): number {
  let n = 0;
  for (const q of candidates) if (st.evicted.has(q.studyUid)) n++;
  return n;
}

/** 축출 판단에 영향을 주는 설정의 지문 — 이 값이 바뀌었을 때만 종결 상태를 푼다.
 *  dlConfigure 는 워크리스트가 마운트·설정 저장·모드 전환마다 부르므로, 무조건 풀면 트레드밀이
 *  그대로 되살아난다(=이 회차 회귀의 재발). */
export function evictConfigKey(c: {
  limitGb: number; evictBy: string; scope: string; recentN: number; autoEvict: boolean;
}): string {
  return `${c.limitGb}|${c.evictBy}|${c.scope}|${c.recentN}|${c.autoEvict ? 1 : 0}`;
}

/* ── 보호 집합 ─────────────────────────────────────────────────────────────── */

export interface ProtectInput {
  now: number;
  /** 지금 받는 중인 검사 */
  curUid?: string;
  /** 방금 다 받은 검사 — recentUntil 까지 한 주기 더 보호한다.
   *  게이트 진입에서 curUid 를 비우는 순간(다음 검사를 시작하지 않는다) 보호가 풀려, 상한보다 큰
   *  검사 하나를 다 받자마자 스스로 지우는 경로가 있었다. 유계(짧은 만료)라 영구 게이트가 되지 않는다. */
  recentUid?: string;
  recentUntil?: number;
  /** 뷰어 창들이 **자기 uid 를 직접** 남긴 장부(TTL 적용 뒤 값) — 1차이자 주 출처 */
  heldUids?: Iterable<string>;
  /** 살아 있는 뷰어 슬롯의 studyId(보조) — 큐를 통해서만 uid 로 바뀌므로 큐 밖 검사는 못 덮는다 */
  slotStudyIds?: Iterable<number>;
  queue?: readonly { studyId: number; studyUid: string }[];
}

/** 지우면 안 되는 검사 — 출처는 **만료되는 신호만** 쓴다.
 *
 *  ⚠ 예전에는 localStorage `sv_viewer_tabs` 의 최근 8건을 보호 출처로 썼다. 그 장부는
 *    ① Viewer2D 전용이라 ViewerInfi 에서는 **항상 비어 있었고**,
 *    ② 만료가 없어 브라우저 X·Ctrl+W 로 닫은 창의 검사 8건이 무기한 축출 불가로 남았다
 *       (그 합계가 상한을 넘으면 blockedByProtection → 다운로드가 완전히 멈춘다. 그때 뜨는 안내는
 *        '창을 닫으면 이어받습니다' 인데 사용자는 이미 다 닫은 상태다),
 *    ③ slice(-8) 은 '최근 8건' 이 아니라 '나중에 append 된 8건' 이라 먼저 연 과거 prior 는 빠졌다.
 *    그래서 보호 출처에서 뺐다. 지금은 뷰어 두 종이 같은 TTL 장부(lib/dlHeld.ts)에 **열려 있는 모든
 *    Exam 탭의 uid** 를 직접 남긴다 — 큐 조회에 의존하지 않으므로 검색 조건을 바꿔 큐에서 빠진
 *    prior 도 보호된다. */
export function computeProtectedUids(i: ProtectInput): string[] {
  const out = new Set<string>();
  if (i.curUid) out.add(i.curUid);
  if (i.recentUid && (i.recentUntil ?? 0) > i.now) out.add(i.recentUid);
  for (const u of i.heldUids ?? []) if (u) out.add(u);
  const ids = new Set<number>();
  for (const n of i.slotStudyIds ?? []) if (n > 0) ids.add(n);
  if (ids.size) for (const q of i.queue ?? []) if (ids.has(q.studyId) && q.studyUid) out.add(q.studyUid);
  return [...out];
}

/* ── 상한 근접 알림 ────────────────────────────────────────────────────────── */

/** 자동 삭제가 **정상 작동하는 상태의 100%** 는 경보가 아니다.
 *  planEvictions 는 `total - freed <= limit` 이 되는 순간 멈추므로 축출 직후 사용량은 늘
 *  (limit − 검사 1건, limit] 에 착지한다. 임계 90%·재무장 85% 조건에서는 그 상태가 **영구 경보**가
 *  되어, 저장소를 한 번 채운 사용자는 워크리스트를 띄울 때마다 빨간 ⚠ 를 본다(기능은 정상인데).
 *  알림이 의미를 갖는 경우는 둘뿐이다: ⑴ 자동 삭제 OFF = '곧 중지됩니다' 라는 실제 예고,
 *  ⑵ 보호 대상만으로 상한을 넘어(blocked) 실제로 더 못 받게 됐을 때. */
export function shouldWarnNearLimit(i: {
  enabled: boolean; autoEvict: boolean; blocked: boolean;
  used: number; limit: number; warnAtPct: number; armed: boolean;
}): { warn: boolean; armed: boolean } {
  if (!i.enabled || !(i.limit > 0)) return { warn: false, armed: i.armed };
  const pct = (i.used / i.limit) * 100;
  if (pct < i.warnAtPct - 5) return { warn: false, armed: true };   // 히스테리시스 재무장
  if (pct < i.warnAtPct) return { warn: false, armed: i.armed };
  if (i.autoEvict && !i.blocked) return { warn: false, armed: i.armed };   // 정상 착지값
  if (!i.armed) return { warn: false, armed: false };
  return { warn: true, armed: false };
}
