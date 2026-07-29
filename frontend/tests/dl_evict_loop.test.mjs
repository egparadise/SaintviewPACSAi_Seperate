/* 용량 초과 자동 삭제가 **수렴하는가** — 다운로드→삭제 트레드밀 회귀.
 *
 * 왜 이 파일이 필요했나: 축출 후처리가 `doneUids.delete(uid)` + `failUntil.set(uid, now+600_000)`
 * 이었고, 후보 선택은 `!done && failUntil<=now` 뿐이었다. 즉 **용량이 없어서 지운 바로 그 검사가
 * 10분 뒤 다시 최우선 후보**가 됐다. 받으면 또 상한을 넘고 planEvictions 가 또 가장 오래된 검사를
 * 지운다 — 종료 조건이 없다. 큐(워크리스트)가 실효 상한보다 크면 세션 내내 돈다.
 *   · 당시 코드: 400분에 다운로드 400건 / 축출 390건 / 재다운로드 379건, 전송 80GB 중 78GB 폐기.
 *   · 보관 상태는 재큐잉이 없을 때와 **동일**(10건 2.00GB). 얻는 것 0, 원격 A 부하만 6.7배.
 * dl_evict_rule.test.mjs 는 planEvictions 의 '순서'만 보므로 이 성질을 구조적으로 못 잡는다.
 *
 * 지키는 규정:
 *   ① 큐가 상한보다 커도 **총 다운로드 건수가 큐 길이를 넘지 않는다**(재다운로드 0).
 *   ② 상태가 수렴한다 — 어느 시점부터 다운로드도 축출도 더 일어나지 않는다.
 *   ③ 검사 하나가 실효 상한보다 커도 딱 1회만 받는다(받자마자 지우고 다시 받기 금지).
 *   ④ 축출은 **종결 상태**다 — 백오프 만료로 되살아나지 않는다.
 *   ⑤ 해제 계기는 셋뿐이다: 설정 변경 / 비우기·리셋 / 사용자가 그 검사를 직접 열기(dlPromote).
 *   ⑥ 진행률의 done 은 축출분을 빼고 센다(모순 화면은 표시로 풀지, 큐를 되살려 풀지 않는다).
 *
 * 판정부는 전부 **원본**을 부른다: 축출 순서는 opfsStore.planEvictions, 큐 결정은
 * dlQueueRule.{pickNextStudy,applyEviction,releaseEvicted,doneCount,computeProtectedUids}.
 * (시뮬레이터가 판정을 복사해 들고 있으면 제품 코드를 죽여도 초록이 된다 — 이 저장소가 viewerSlots
 *  에서 이미 겪은 유형이라 글루만 여기 둔다.)
 *
 * 실행: node frontend/tests/dl_evict_loop.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { planEvictions } from "../src/lib/opfsStore.ts";
import {
  applyEviction, computeProtectedUids, doneCount, evictConfigKey, newLoopState,
  pickNextStudy, releaseEvicted, skippedCount,
} from "../src/lib/dlQueueRule.ts";

const MB = 1024 * 1024;
const GB = 1024 * MB;
// ⚠ 시뮬레이터 시계는 **실제 현재 시각**에서 출발한다. T0 를 고정 과거로 두면, 축출 후처리가
//   `failUntil.set(uid, Date.now() + 600_000)`(옛 코드)로 되돌아가도 그 만료 시각이 가짜 시계보다
//   훨씬 미래라 재큐잉이 나타나지 않는다 = 회귀를 못 잡는다.
const T0 = Date.now();
const STEP = 60_000;            // 검사 1건 받는 데 1분
const RECENT_PROTECT_MS = 30_000;   // dlScheduler 의 '방금 받은 검사' 보호(유계)

/** 워크리스트 큐 — 서버가 준 **최신순**. 그래서 스케줄러는 최신→과거로 받고,
 *  policy=date 축출은 과거부터 지운다(둘이 정확히 반대로 맞물린다는 것이 이 회귀의 배경이다). */
function makeQueue(n, bytes) {
  return Array.from({ length: n }, (_, i) => ({
    studyUid: `UID${String(i).padStart(3, "0")}`,
    // i=0 이 가장 최신. 20260729 에서 하루씩 거슬러 올라간다.
    studyDate: new Date(Date.parse("2026-07-29T00:00:00Z") - i * 86400_000)
      .toISOString().slice(0, 10).replace(/-/g, ""),
    bytes,
  }));
}

/** 스케줄러 loop + maintain 의 **글루만** 재현한다(판정은 전부 원본 함수). */
function simulate({ queue, limitBytes, ticks, policy = "date", promoteAt = null }) {
  const st = newLoopState();
  const store = new Map();          // uid → {bytes, studyDate, lastUsed}  (= OPFS 인덱스)
  const dlCount = new Map();
  let now = T0, downloads = 0, evictions = 0;
  let curUid = "", recentUid = "", recentUntil = 0;
  let firstIdleTick = -1;

  const maintain = () => {
    const records = [...store.entries()].map(([uid, v]) => ({
      studyUid: uid, bytes: v.bytes, lastUsed: v.lastUsed, studyDate: v.studyDate,
    }));
    const prot = computeProtectedUids({ now, curUid, recentUid, recentUntil });
    const plan = planEvictions({ records, limitBytes, policy, protectedUids: prot });
    for (const uid of plan.evict) { store.delete(uid); evictions++; }
    applyEviction(st, plan.evict);   // ← 원본. 여기서 done 을 지우면 ①이 깨진다.
    return plan;
  };

  for (let t = 0; t < ticks; t++) {
    if (promoteAt && promoteAt.tick === t) releaseEvicted(st, promoteAt.uid);   // 사용자가 직접 열었다
    const next = pickNextStudy(queue, st, now);   // ← 원본. evicted 를 안 빼면 ①이 깨진다.
    if (!next) {
      if (firstIdleTick < 0) firstIdleTick = t;
      now += STEP;
      maintain();
      continue;
    }
    curUid = next.studyUid;
    store.set(next.studyUid, { bytes: next.bytes, studyDate: next.studyDate, lastUsed: now });
    downloads++;
    dlCount.set(next.studyUid, (dlCount.get(next.studyUid) ?? 0) + 1);
    st.done.add(next.studyUid);
    now += STEP;
    curUid = "";
    recentUid = next.studyUid; recentUntil = now + RECENT_PROTECT_MS;
    maintain();
  }
  const used = [...store.values()].reduce((a, v) => a + v.bytes, 0);
  const redl = [...dlCount.values()].filter((n) => n > 1).length;
  return { st, store, used, downloads, evictions, redl, firstIdleTick };
}

test("① 큐가 상한보다 커도 총 다운로드가 큐 길이를 넘지 않는다(재다운로드 0)", () => {
  // 재현 조건 그대로: 큐 60건 × 200MB(=12GB) · 상한 2GB · 검사당 1분 · 400분.
  const queue = makeQueue(60, 200 * MB);
  const r = simulate({ queue, limitBytes: 2 * GB, ticks: 400 });
  assert.equal(r.downloads, 60,
    `총 다운로드가 큐 길이를 넘었다(${r.downloads}건) — 축출한 검사가 다시 큐에 들어온다(트레드밀).`);
  assert.equal(r.redl, 0, "같은 검사를 두 번 이상 받았다 — 원격 A 를 영구히 두들기는 경로다");
  // 보관 상태는 '재큐잉 없음' 과 같아야 한다 — 재큐잉으로 얻는 것이 없다는 근거.
  assert.equal(r.store.size, 10);
  assert.equal(r.used, 2000 * MB);
  assert.equal(r.evictions, 50, "축출 건수도 큐 길이 안에서 끝나야 한다");
});

test("② 상태가 수렴한다 — 한 바퀴 뒤에는 idle 이고 그 뒤로 아무 일도 없다", () => {
  const queue = makeQueue(60, 200 * MB);
  const short = simulate({ queue, limitBytes: 2 * GB, ticks: 61 });
  const long = simulate({ queue, limitBytes: 2 * GB, ticks: 400 });
  assert.ok(short.firstIdleTick >= 0, "한 바퀴 안에 idle 에 도달하지 못했다");
  assert.equal(short.downloads, long.downloads, "idle 이후에도 다운로드가 늘어난다(수렴하지 않는다)");
  assert.equal(short.evictions, long.evictions, "idle 이후에도 축출이 계속된다(반복 무효화·반복 토스트의 원인)");
  assert.deepEqual([...long.store.keys()].sort(), [...short.store.keys()].sort());
});

test("③ 검사 하나가 실효 상한보다 커도 딱 1회만 받는다", () => {
  // 상한 0.5GB · 검사 0.75GB. 예전에는 다 받은 뒤 게이트 진입에서 보호가 풀려 ~30초 뒤 통째로
  // 지워지고, 백오프가 만료되면 또 받았다(코드 주석은 '받는 중 보호로 차단' 이라고 주장했지만
  // 보호는 **받는 동안에만** 유효했다).
  const queue = [{ studyUid: "BIG", studyDate: "20260729", bytes: 0.75 * GB }];
  const r = simulate({ queue, limitBytes: 0.5 * GB, ticks: 200 });
  assert.equal(r.downloads, 1, `상한보다 큰 검사를 ${r.downloads}회 받았다 — 받고 지우기를 반복한다`);
  assert.equal(r.store.size, 0, "상한을 못 맞추면 결국 지워지는 것은 맞다(다만 다시 받지 않는다)");
  assert.ok(r.st.evicted.has("BIG"));
});

test("③ 다 받은 직후 한 주기 보호 — 즉시 자기삭제가 일어나지 않는다", () => {
  const now = T0;
  const prot = computeProtectedUids({ now, curUid: "", recentUid: "BIG", recentUntil: now + 30_000 });
  assert.deepEqual(prot, ["BIG"], "방금 받은 검사가 곧바로 1순위 희생자가 된다");
  const p = planEvictions({
    records: [{ studyUid: "BIG", bytes: 0.75 * GB, lastUsed: now, studyDate: "20260729" }],
    limitBytes: 0.5 * GB, protectedUids: prot,
  });
  assert.deepEqual(p.evict, []);
  // 보호는 **만료된다** — 영구 게이트가 되면 안 된다(그러면 아무것도 못 지운다).
  assert.deepEqual(computeProtectedUids({ now: now + 31_000, recentUid: "BIG", recentUntil: now + 30_000 }), []);
});

test("④ 축출은 종결 상태다 — 백오프 만료로 되살아나지 않는다", () => {
  const st = newLoopState();
  const q = [{ studyUid: "A" }, { studyUid: "B" }];
  st.done.add("A");
  applyEviction(st, ["A"]);
  assert.equal(st.failUntil.has("A"), false,
    "용량 축출을 failUntil 로 표현했다 — failUntil 은 네트워크 실패용이고 만료되면 다시 큐에 들어온다");
  // 10분(옛 EVICT_BACKOFF)이 지나도, 1년이 지나도 후보가 되지 않는다.
  for (const dt of [0, 600_001, 365 * 86400_000]) {
    assert.equal(pickNextStudy(q, st, T0 + dt)?.studyUid, "B",
      `t+${dt}ms 에 축출된 검사가 다시 후보가 됐다 — 트레드밀이 되살아났다`);
  }
  // ★ '완료(done)' 만으로는 부족하다 — **받는 도중에** 축출되는 경우가 있다(maintain 은 pump 안
  //   누적 바이트 임계에서도 돈다). 그때 그 검사는 done 에 없으므로, 후보 필터가 evicted 를 보지
  //   않으면 곧바로 다시 선택돼 같은 자리에서 도돌이표가 된다.
  const mid = newLoopState();
  applyEviction(mid, ["A"]);              // done 에 넣지 않는다 = 부분 다운로드 중 축출
  assert.equal(mid.done.has("A"), false);
  assert.equal(pickNextStudy(q, mid, T0)?.studyUid, "B",
    "받는 도중 축출된 검사가 즉시 다시 후보가 됐다 — 후보 필터가 evicted 를 보지 않는다");
});

test("⑤ 해제 계기는 셋뿐 — 사용자 오픈(dlPromote) / 설정 변경 / 비우기·리셋", () => {
  // (1) 사용자가 그 검사를 직접 열었다 = 재다운로드가 정말 필요한 유일한 계기
  {
    const st = newLoopState();
    st.done.add("A"); applyEviction(st, ["A"]);
    releaseEvicted(st, "A");
    assert.equal(pickNextStudy([{ studyUid: "A" }], st, T0)?.studyUid, "A",
      "직접 연 검사가 다시 받아지지 않는다 — evicted 만 지우고 done 을 남기면 이렇게 된다");
  }
  // (2) 전량 해제(설정 변경·'지금 비우기'·dlReset)
  {
    const st = newLoopState();
    st.done.add("A"); st.done.add("B"); applyEviction(st, ["A", "B"]);
    releaseEvicted(st);
    assert.equal(st.evicted.size, 0);
    assert.equal(pickNextStudy([{ studyUid: "A" }], st, T0)?.studyUid, "A");
  }
  // (3) 시뮬레이터로 확인 — 오픈 계기가 있으면 그 1건만 다시 받는다(총 61건)
  {
    const queue = makeQueue(60, 200 * MB);
    const r = simulate({ queue, limitBytes: 2 * GB, ticks: 400, promoteAt: { tick: 120, uid: "UID059" } });
    assert.equal(r.downloads, 61, "사용자 오픈으로 정확히 1건만 더 받아야 한다");
    assert.equal(r.redl, 1);
  }
  // (4) 설정 지문 — 상한·기준·범위·자동삭제가 바뀌면 다르고, 그 외에는 같아야 한다
  //     (매 dlConfigure 마다 풀면 트레드밀이 그대로 되살아난다)
  const base = { limitGb: 2, evictBy: "date", scope: "list", recentN: 50, autoEvict: true };
  assert.equal(evictConfigKey(base), evictConfigKey({ ...base }));
  assert.notEqual(evictConfigKey(base), evictConfigKey({ ...base, limitGb: 4 }));
  assert.notEqual(evictConfigKey(base), evictConfigKey({ ...base, evictBy: "lru" }));
  assert.notEqual(evictConfigKey(base), evictConfigKey({ ...base, autoEvict: false }));
});

test("⑥ 진행률의 done 은 축출분을 뺀다 — 모순 화면을 큐 되살리기로 풀지 않는다", () => {
  const st = newLoopState();
  const q = [{ studyUid: "A" }, { studyUid: "B" }, { studyUid: "C" }];
  st.done.add("A"); st.done.add("B"); st.done.add("C");
  assert.equal(doneCount(q, st), 3);
  applyEviction(st, ["A"]);
  assert.equal(doneCount(q, st), 2, "축출된 검사를 완료로 세면 '저장소는 비었는데 N/N' 모순이 남는다");
  assert.equal(skippedCount(q, st), 1, "건너뛴 건수를 셀 수 없으면 사용자에게 사유를 알릴 수 없다");
  // 그렇다고 done 에서 빼면(옛 코드) 곧바로 후보로 되살아난다 — 그 성질을 여기 못 박는다.
  assert.equal(pickNextStudy(q, st, T0), undefined);
});
