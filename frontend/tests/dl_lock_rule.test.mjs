/* 다운로더 Web Lock 실패 해석 회귀 — lib/dlLock.ts 의 **원본**을 그대로 부른다.
 *
 * 왜 이 파일이 필요했나: 판정이 dlScheduler.acquire() 안에 인라인으로 `misses > 1` 하나로 들어
 * 있었고, dlScheduler.ts 는 첫 줄이 `import { api }`(→ import.meta.env·localStorage)라 node 가
 * 부를 수 없어 테스트가 0건이었다. 그래서 아래 사실이 검증되지 않은 채 남아 있었다:
 *
 *   dlStop 은 promoteTick 을 올릴 뿐이고, pump 워커는 `await fetchBlob(url)` 이 **끝난 뒤에야**
 *   루프 상단 가드에 닿는다. loop 은 Promise.all(워커 4개)이 전부 끝나야 반환해 Lock 을 놓는다.
 *   ⇒ Lock 해제 지연 = 가장 늦게 끝나는 in-flight fetch 시간. 700ms 로 유계가 아니다.
 *
 * 그래서 '2회 실패 = 다른 창' 규칙은 뷰어를 닫자마자 다시 여는 흐름(dlStop→dlResume)에서
 * **이 창인데도** "다른 창이 다운로드를 맡고 있습니다" 라는 틀린 안내를 띄우고 재개를 5초 밀었다.
 *
 * 되돌리면(판정을 `misses > 1` 로 되돌리면) ①②③ 이 실패한다.
 *
 * 실행: node frontend/tests/dl_lock_rule.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCK_BUSY_NOTE, LOCK_RETRY_FAST_MS, LOCK_RETRY_SLOW_MS, LOCK_STOP_GRACE_MS, decideLockNote,
} from "../src/lib/dlLock.ts";

const NEVER_STOPPED = Infinity;   // dlScheduler 가 lastStopAt=0 일 때 넘기는 값

test("① 이 창이 아직 Lock 을 쥐고 있으면 '다른 창' 은 거짓말이다 — 몇 번을 실패하든 안내 금지", () => {
  for (const misses of [1, 2, 5, 50]) {
    const d = decideLockNote(misses, NEVER_STOPPED, true);
    assert.equal(d.note, false, `misses=${misses} 에서 오안내(옛 loop 이 놓는 중인데 '다른 창')`);
    assert.equal(d.waitMs, LOCK_RETRY_FAST_MS, "놓는 중이면 짧게 계속 노려야 재개가 안 밀린다");
    assert.equal(d.reason, "handoff");
  }
});

test("② dlStop 직후 유예 안의 실패는 '우리 탓' — 느린 A 에서 프레임 한 장이 700ms 를 넘는다", () => {
  // 유예 경계 바로 안쪽: lockHeld 가 이미 false 로 떨어진 뒤에도 Web Lock 실제 해제까지 한 틱이 남는다
  for (const ms of [0, 700, 3000, LOCK_STOP_GRACE_MS - 1]) {
    const d = decideLockNote(9, ms, false);
    assert.equal(d.note, false, `정지 ${ms}ms 뒤 실패인데 '다른 창' 이라고 했다`);
    assert.equal(d.waitMs, LOCK_RETRY_FAST_MS, "5초를 자면 재개가 그만큼 밀린다");
    assert.equal(d.reason, "just-stopped");
  }
});

test("③ 유예를 벗어난 반복 실패만 진짜 '다른 창' — 안내와 느린 폴", () => {
  const d = decideLockNote(2, LOCK_STOP_GRACE_MS, false);
  assert.equal(d.note, true);
  assert.equal(d.waitMs, LOCK_RETRY_SLOW_MS);
  assert.equal(d.reason, "other-window");
  assert.ok(LOCK_BUSY_NOTE.includes("다른 창"), "안내 문구는 이 모듈이 단일 출처여야 되돌릴 수 있다");
});

test("④ 첫 실패는 예전 그대로 조용히 한 번 더 (워크리스트 2창 배치에서 깜빡임 금지)", () => {
  const d = decideLockNote(1, NEVER_STOPPED, false);
  assert.equal(d.note, false);
  assert.equal(d.waitMs, LOCK_RETRY_FAST_MS);
  assert.equal(d.reason, "first-miss");
});

test("⑤ 멈춘 적이 없으면(Infinity) 유예가 열려 있으면 안 된다 — 안 그러면 안내가 영영 안 뜬다", () => {
  // lastStopAt=0 을 그대로 빼서 msSinceStop=Date.now() 를 넘기는 실수도 여기서 걸린다(그 값은 거대).
  assert.equal(decideLockNote(3, NEVER_STOPPED, false).note, true);
  assert.equal(decideLockNote(3, Date.now(), false).note, true);
  // 음수(시계 되감김·다른 창의 시각)는 '방금 멈춤'으로 보지 않는다
  assert.equal(decideLockNote(3, -1000, false).note, true);
});

test("⑥ 유예는 in-flight fetch 하나를 덮을 만큼 길고, 짧은 재시도는 유예보다 훨씬 짧다", () => {
  assert.ok(LOCK_STOP_GRACE_MS >= 10_000,
    `유예(${LOCK_STOP_GRACE_MS}ms)가 짧으면 느린 사이트에서 오안내가 되살아난다`);
  assert.ok(LOCK_RETRY_FAST_MS < LOCK_RETRY_SLOW_MS);
  assert.ok(LOCK_RETRY_FAST_MS * 3 < LOCK_STOP_GRACE_MS, "유예 안에 재시도가 여러 번 들어가야 한다");
});
