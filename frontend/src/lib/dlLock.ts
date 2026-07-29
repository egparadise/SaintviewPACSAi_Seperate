/* 다운로더 Web Lock 확보 실패의 **해석** — 순수 함수 모듈(의존 0).
 *
 * 왜 별도 파일인가: dlScheduler.ts 는 첫 줄이 `import { api }`(→ import.meta.env·localStorage)라
 * node 가 부를 수 없다. 이 저장소는 그 이유로 축출 규칙 테스트가 0건이었던 전례가 있어
 * (tests/dl_evict_rule.test.mjs 헤더 참조), 판정만 여기로 빼서 테스트가 원본을 직접 부르게 한다.
 *
 * ── 무엇이 틀렸었나 ─────────────────────────────────────────────────────────
 * acquire() 는 Lock 실패 **횟수**로 '다른 창이 맡고 있다'를 판정했다: 첫 실패는 조용히 700ms 뒤
 * 재시도하고, 두 번째부터 곧바로 "다른 창이 다운로드를 맡고 있습니다" 를 띄우고 5초를 잤다.
 * 그 전제 — '700ms 면 이 창의 옛 loop 이 Lock 을 놓는다' — 가 성립하지 않는다:
 *   · dlStop 이 promoteTick 을 올려도 pump 워커는 `await fetchBlob(t.url)` 이 **끝난 뒤에야**
 *     루프 상단 가드에 닿고(dlScheduler.ts 의 pump),
 *   · loop 은 `Promise.all(워커 4개)` 가 전부 끝나야 반환해 Lock 을 놓는다.
 *   ⇒ 해제 지연 = **가장 늦게 끝나는 in-flight fetch 시간**이다. 원격 A 가 느린 사이트에서
 *     rendered 프레임 한 장이 700ms 를 넘는 것은 드물지 않다.
 * 결과: 뷰어를 닫자마자 다시 여는 흐름(dlStop→dlResume)에서 **이 창인데도** '다른 창이…' 라는
 * 틀린 안내가 뜨고, 재개가 최대 5초씩 밀렸다.
 *
 * ── 그래서 횟수가 아니라 사실로 판정한다 ──────────────────────────────────
 *   ① lockHeld — 이 창이 아직 Lock 을 쥐고 있는가. 참이면 '이 창의 옛 loop 이 놓는 중' 이라는
 *      **직접 증거**다(가장 정확한 근거). '다른 창' 은 그 자리에서 거짓말이므로 절대 띄우지 않는다.
 *   ② msSinceStop — 마지막 dlStop 이후 경과. lockHeld 는 옛 run() 의 finally 가 지나가면 곧
 *      false 가 되는데, Web Lock 실제 해제와 다음 acquire 시도 사이에 한 틱이 더 걸릴 수 있어
 *      ①만으로는 경계에서 샌다. 정지 직후 유예 안의 실패는 여전히 '우리 탓' 으로 본다.
 *   ③ 그 밖에는 예전 그대로 — 첫 실패는 조용히 한 번 더, 그 뒤부터 진짜 '다른 창'.
 */

/** 이 창의 옛 loop 이 놓는 중이라고 보는 유예. in-flight fetch 하나가 끝나는 시간을 넉넉히 덮어야
 *  한다(700ms 로는 유계가 아니다 — 위 주석). 너무 길게 잡으면 진짜 다른 창이 맡은 배치에서
 *  안내가 늦어질 뿐이라, 오안내보다 안전한 쪽으로 기울인다. */
export const LOCK_STOP_GRACE_MS = 15_000;
/** 짧은 재시도 — '곧 풀릴 것' 으로 볼 때 */
export const LOCK_RETRY_FAST_MS = 700;
/** 긴 재시도 — 진짜 다른 창이 맡고 있을 때(그 창이 닫힐 때까지 기다리는 폴이므로 느려도 된다) */
export const LOCK_RETRY_SLOW_MS = 5000;
/** 이 문구를 note 에 실었는지로 '내가 띄운 안내' 를 식별한다(풀릴 때 되돌리려고). */
export const LOCK_BUSY_NOTE = "다른 창이 다운로드를 맡고 있습니다.";

export interface LockNoteDecision {
  /** 사용자에게 LOCK_BUSY_NOTE 를 보일 것인가 */
  note: boolean;
  /** 다음 재시도까지 기다릴 ms */
  waitMs: number;
  /** 진단용 — 왜 그렇게 판정했는가 */
  reason: "handoff" | "just-stopped" | "first-miss" | "other-window";
}

/**
 * Lock 확보 실패 1회분의 해석.
 *  misses      : 이번 acquire 루프에서 연속 실패한 횟수(1부터)
 *  msSinceStop : 마지막 dlStop 이후 경과 ms. 정지한 적이 없으면 Infinity 를 넘긴다
 *                (0 을 넘기면 '방금 멈췄다' 로 오해돼 안내가 영영 안 뜬다).
 *  lockHeld    : 이 창이 아직 Web Lock 을 쥐고 있는가(옛 loop 이 놓는 중).
 */
export function decideLockNote(misses: number, msSinceStop: number, lockHeld: boolean): LockNoteDecision {
  if (lockHeld) return { note: false, waitMs: LOCK_RETRY_FAST_MS, reason: "handoff" };
  if (Number.isFinite(msSinceStop) && msSinceStop >= 0 && msSinceStop < LOCK_STOP_GRACE_MS)
    return { note: false, waitMs: LOCK_RETRY_FAST_MS, reason: "just-stopped" };
  if (misses <= 1) return { note: false, waitMs: LOCK_RETRY_FAST_MS, reason: "first-miss" };
  return { note: true, waitMs: LOCK_RETRY_SLOW_MS, reason: "other-window" };
}
