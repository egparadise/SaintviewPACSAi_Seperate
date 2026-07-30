/* 프론트 요청 상한·폴링 가드 — lib/netLimit.ts 를 **실제로** 부른다.
 *
 * 고정하는 계약(실제로 났던 사고에서 나온 것):
 *   · 판독창 오픈이 과거검사 전건에 요청을 **동시에** 쏘지 않는다 (동시 실행 ≤ cap)
 *   · 폴링이 **직전 요청과 겹치지 않는다** — A 가 주기보다 느려도 요청이 쌓이면 안 된다
 *   · 실패가 이어지면 간격을 늘린다 — 서버가 아플 때 더 세게 때리면 안 된다
 */
import assert from "node:assert/strict";
import test from "node:test";
import { limitedMap, pollWithGuard } from "../src/lib/netLimit.ts";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test("limitedMap — 동시 실행이 상한을 넘지 않는다", async () => {
  let live = 0, peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  await limitedMap(items, 3, async (x) => {
    live++; peak = Math.max(peak, live);
    await tick(1);
    live--;
    return x * 2;
  });
  assert.ok(peak <= 3, `동시 실행 ${peak} — 상한 3 을 넘었다`);
});

test("limitedMap — 결과 순서는 입력 순서와 같다 (완료 순서가 아니다)", async () => {
  const out = await limitedMap([5, 1, 3], 3, async (x) => {
    await tick(x);            // 늦게 끝나는 것이 앞에 있다
    return x;
  });
  assert.deepEqual(out, [5, 1, 3]);
});

test("limitedMap — 빈 배열은 요청을 하나도 안 낸다", async () => {
  let calls = 0;
  const out = await limitedMap([], 4, async () => { calls++; return 1; });
  assert.deepEqual(out, []);
  assert.equal(calls, 0);
});

test("limitedMap — 항목이 상한보다 적으면 그만큼만 띄운다", async () => {
  let live = 0, peak = 0;
  await limitedMap([1, 2], 8, async (x) => {
    live++; peak = Math.max(peak, live);
    await tick(1); live--; return x;
  });
  assert.equal(peak, 2);
});

test("폴링 — 직전 요청이 안 끝났으면 겹쳐 보내지 않는다 (핵심 회귀 방어)", async () => {
  let live = 0, peak = 0, started = 0;
  const h = pollWithGuard(async () => {
    started++; live++; peak = Math.max(peak, live);
    await tick(60);                       // 주기(10ms)보다 훨씬 느린 응답
    live--;
  }, 10);
  await tick(200);
  h.stop();
  assert.equal(peak, 1, `요청이 ${peak} 개 겹쳤다 — 느려질수록 쌓이는 그 버그다`);
  assert.ok(started < 20, `주기마다 새로 쏘고 있다(${started}건)`);
});

test("폴링 — 실패가 이어지면 간격이 늘어난다", async () => {
  const at = [];
  const h = pollWithGuard(async () => {
    at.push(Date.now());
    throw new Error("A 가 아프다");
  }, 10, { maxBackoffMs: 200 });
  await tick(260);
  h.stop();
  const gaps = at.slice(1).map((t, i) => t - at[i]);
  assert.ok(gaps.length >= 2, "표본이 모자라다");
  assert.ok(gaps[gaps.length - 1] > gaps[0],
            `간격이 안 늘었다: ${JSON.stringify(gaps)} — 아픈 서버를 계속 같은 속도로 때린다`);
});

test("폴링 — stop() 후에는 더 이상 부르지 않는다 (창을 닫아도 계속 나가면 안 된다)", async () => {
  let calls = 0;
  const h = pollWithGuard(async () => { calls++; }, 5);
  await tick(30);
  h.stop();
  const after = calls;
  await tick(40);
  assert.equal(calls, after, "stop 후에도 요청이 나갔다");
});

test("폴링 — immediate:false 면 첫 주기를 기다린다", async () => {
  let calls = 0;
  const h = pollWithGuard(async () => { calls++; }, 40, { immediate: false });
  await tick(10);
  assert.equal(calls, 0, "즉시 쏘면 안 된다");
  h.stop();
});
