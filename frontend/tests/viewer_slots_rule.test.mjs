/* 다중 모니터 뷰어 배치 규칙 회귀 테스트 — lib/viewerSlots.ts 의 **원본 구현**을 부른다.
 *
 * 지키는 규칙(사용자 확정 원문):
 *   ① 사이클 시작(살아 있는 뷰어 창이 0개)인 **첫 오픈** = 선택된 전 모니터에 같은 검사.
 *   ② 두 번째 오픈부터 = 모니터 번호순으로 대상 창 하나만(2,3,…,1,2,3…).
 *   ③ 순번은 워크리스트 문서가 아니라 **살아 있는 창**에 종속 — 워크리스트 F5 로 리셋되면 안 된다.
 *
 * 회귀 이력 1: 커밋 6da23e0 이 109c2cb 의 "선택 모니터 전부 오픈"(forEach)을 라운드로빈 단일 오픈으로
 * 통째로 대체하면서 ①이 사라졌고, 카운터가 Worklist.tsx 모듈 변수라 ③이 깨져 있었다.
 *
 * 회귀 이력 2(이 파일이 고쳐진 이유): 예전 이 테스트의 openStudy() 는 Worklist.openV2 의 배치 결정부를
 * **테스트 파일 안에 복사**한 것이었다. 그래서 제품 코드의 부트스트랩 분기를 죽이거나(liveHere.length<0),
 * 루프의 noteViewerSlot 을 지우거나, 대상 인덱스를 rr+1 로 어긋내도 10개가 전부 초록이었다.
 * 지금은 결정부(planViewerOpen)와 적용부(openByPlan)가 lib 에 있고 이 테스트가 그 원본을 직접 부른다 —
 * 위 세 변형은 각각 여기서 실패한다. Worklist.openV2 는 그 결과대로 window.open 만 한다.
 *
 * 실행: node frontend/tests/viewer_slots_rule.test.mjs
 */
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

// ── localStorage / window 최소 스텁 (jsdom 없이) ────────────────────────────
class MemStore {
  constructor() { this.m = new Map(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
globalThis.localStorage = new MemStore();
globalThis.window = { name: "", localStorage: globalThis.localStorage, setInterval: () => 0, clearInterval: () => {} };

const {
  clearViewerSlots, decideBaselineArm, decideBaselineRelease, forgetViewerSlot, isViewerSlotName, liveViewerSlots,
  markViewerSlotUnloading, noteViewerSlot, openByPlan, otherLiveViewerCount, planViewerOpen,
  readViewerRoundRobin, viewerSlotName, writeViewerRoundRobin,
  SLOT_HEARTBEAT_MS, SLOT_TTL_MS, SLOT_UNLOAD_GRACE_MS,
} = await import("../src/lib/viewerSlots.ts");

beforeEach(() => {
  globalThis.localStorage = new MemStore();
  globalThis.window.localStorage = globalThis.localStorage;
  globalThis.window.name = "";
});

/** Worklist.openV2 가 하는 일 그대로 — 살아 있는 창 목록을 만들어 원본에 넘기고, 계획대로 "연다".
 *  여기서 '연다'는 window.open 대신 성공(true)을 반환하는 스텁. 규칙 판정·장부 기록·순번 갱신은
 *  전부 lib 원본(planViewerOpen/openByPlan)이 한다 — 이 함수에는 규칙이 한 줄도 없다.
 *  반환: 이번 오픈으로 검사가 실린 창 이름 목록(부트스트랩이면 전 모니터). */
function openStudy(slots, studyId, { blocked = new Set() } = {}) {
  const live = liveViewerSlots().keys();
  const plan = planViewerOpen(slots, live, readViewerRoundRobin());
  const done = [];
  openByPlan(plan, studyId, (t) => {
    if (blocked.has(t.name)) return false;   // 팝업 차단 시뮬레이션
    done.push(t.name);
    return true;
  });
  return done;
}

const SLOTS3 = [{ index: 0, features: "" }, { index: 1, features: "" }, { index: 2, features: "" }];
const N = SLOTS3.map((s) => viewerSlotName(s.index, 0));   // [sv_viewer, sv_viewer_slot1, sv_viewer_slot2]

test("창 이름 규약은 한 곳에서만 — 최저번호=sv_viewer, 나머지=sv_viewer_slot{index}", () => {
  assert.deepEqual(N, ["sv_viewer", "sv_viewer_slot1", "sv_viewer_slot2"]);
  // 비연속 선택(1·3·4)에서도 '첫 슬롯'이 sv_viewer — screens.ts openSlaveWindow 와 같은 규약이어야 한다
  assert.equal(viewerSlotName(2, 2), "sv_viewer");
  assert.equal(viewerSlotName(4, 2), "sv_viewer_slot4");
  assert.ok(isViewerSlotName("sv_viewer") && isViewerSlotName("sv_viewer_slot3"));
  assert.ok(!isViewerSlotName("sv_worklist") && !isViewerSlotName(""));
});

test("① 첫 오픈은 선택한 전 모니터에 같은 검사 (6da23e0 이 지운 부트스트랩)", () => {
  const plan = planViewerOpen(SLOTS3, [], 0);
  assert.equal(plan.mode, "bootstrap");
  assert.deepEqual(plan.targets.map((t) => t.name), N, "3모니터면 3창 모두가 대상");
  assert.deepEqual(openStudy(SLOTS3, 101), N);
  const live = liveViewerSlots();
  assert.equal(live.size, 3);
  for (const n of N) assert.equal(live.get(n), 101, `${n} 에도 검사 A 가 걸려야 한다`);
});

test("① 부트스트랩은 슬롯 features/index 를 그대로 실어 준다 (모니터 배치 정보 유실 금지)", () => {
  const slots = [{ index: 1, features: "left=0" }, { index: 3, features: "left=1920" }];
  const plan = planViewerOpen(slots, [], 0);
  assert.deepEqual(plan.targets, [
    { index: 1, features: "left=0", name: "sv_viewer" },
    { index: 3, features: "left=1920", name: "sv_viewer_slot3" },
  ]);
});

test("② 두 번째부터는 2→3→1 순으로 한 대씩 (첫 영상이 1번에 남아 있어야 한다)", () => {
  openStudy(SLOTS3, 101);
  assert.deepEqual(openStudy(SLOTS3, 102), ["sv_viewer_slot1"], "둘째는 2번 모니터");
  assert.deepEqual(openStudy(SLOTS3, 103), ["sv_viewer_slot2"], "셋째는 3번 모니터");
  assert.deepEqual(openStudy(SLOTS3, 104), ["sv_viewer"], "넷째에 비로소 1번 모니터");
  const live = liveViewerSlots();
  assert.deepEqual([live.get(N[0]), live.get(N[1]), live.get(N[2])], [104, 102, 103]);
});

test("② 부트스트랩 직후 순번이 0 이면 '첫 영상이 사라진다' — 시작값은 반드시 slots[1]", () => {
  assert.equal(planViewerOpen(SLOTS3, [], 0).nextRr, 1, "0 이면 둘째 검사가 1번 모니터를 덮어쓴다");
  openStudy(SLOTS3, 101);
  assert.equal(readViewerRoundRobin(), 1);
  // 단일 슬롯이면 0(자기 자신) — 1 % 1
  assert.equal(planViewerOpen([SLOTS3[0]], [], 0).nextRr, 0);
});

test("③ 워크리스트 F5 후에도 순서가 이어진다 — 카운터가 창 상태에 종속 (모듈 변수 회귀)", () => {
  openStudy(SLOTS3, 101);   // 1·2·3 = A
  openStudy(SLOTS3, 102);   // 2번 = B
  // 워크리스트 문서만 새로 뜬 상황: 모듈 변수(viewerRoundRobin·openedViewerWindows)는 사라지지만
  // 뷰어 창 3개는 그대로 살아 있다(= 하트비트 유지). 공유 장부만 보고 판단해야 한다.
  assert.equal(readViewerRoundRobin(), 2);
  assert.deepEqual(openStudy(SLOTS3, 103), ["sv_viewer_slot2"], "F5 해도 3번 모니터 차례");
  assert.equal(liveViewerSlots().get("sv_viewer"), 101, "1번 모니터의 첫 영상이 살아 있어야 한다");
});

test("살아 있는 창이 하나라도 있으면 ②라운드로빈 — 장부 밖 근거(창 핸들)도 받는다", () => {
  // 교차 출처(VIEWER_BASE) 배치: 뷰어 하트비트가 이 오리진 장부에 안 보인다. 워크리스트는 자기
  // 창 핸들(!w.closed)을 liveNames 로 넘겨 순번이 돌게 한다 — 장부가 비어도 부트스트랩이면 안 된다.
  assert.equal(liveViewerSlots().size, 0);
  const plan = planViewerOpen(SLOTS3, ["sv_viewer_slot1"], 1);
  assert.equal(plan.mode, "roundrobin");
  assert.deepEqual(plan.targets.map((t) => t.name), ["sv_viewer_slot1"]);
  assert.equal(plan.nextRr, 2);
});

test("현재 선택 슬롯 밖의 창 이름은 생존 근거가 되지 못한다 (모니터 설정 축소 후 고아 창)", () => {
  // 3→2 축소: sv_viewer_slot2 가 아직 살아 있어도 2슬롯 배치에서는 사이클 시작이어야 한다
  const slots2 = SLOTS3.slice(0, 2);
  const plan = planViewerOpen(slots2, ["sv_viewer_slot2"], 0);
  assert.equal(plan.mode, "bootstrap");
  assert.deepEqual(plan.targets.map((t) => t.name), ["sv_viewer", "sv_viewer_slot1"]);
});

test("팝업이 차단돼 한 대도 못 열려도 순번은 전진한다 + 열린 창만 장부에 남는다", () => {
  const opened = openStudy(SLOTS3, 101, { blocked: new Set(["sv_viewer_slot1"]) });
  assert.deepEqual(opened, ["sv_viewer", "sv_viewer_slot2"], "차단된 창은 열리지 않는다");
  assert.deepEqual([...liveViewerSlots().keys()].sort(), ["sv_viewer", "sv_viewer_slot2"],
    "열리지 않은 창을 '살아있음'으로 기록하면 다음 오픈이 부트스트랩을 건너뛴다");
  assert.equal(readViewerRoundRobin(), 1);
});

test("모든 창이 닫히면(TTL 만료) 다시 ① 부트스트랩 — 사이클이 새로 시작된다", () => {
  openStudy(SLOTS3, 101);
  openStudy(SLOTS3, 102);
  // 하트비트가 끊긴 지 TTL 초과 = 창이 닫힘
  for (const n of N) {
    const rec = JSON.parse(localStorage.getItem(`sv_vslot_${n}`));
    localStorage.setItem(`sv_vslot_${n}`, JSON.stringify({ ...rec, t: rec.t - SLOT_TTL_MS - 1 }));
  }
  assert.equal(liveViewerSlots().size, 0, "만료분은 살아있는 슬롯에서 빠지고 정리된다");
  assert.deepEqual(openStudy(SLOTS3, 201), N, "다시 전 모니터");
});

test("TTL 은 브라우저 타이머 스로틀링(hidden 5분 후 1분에 1회)보다 넉넉해야 한다", () => {
  // 6초였을 때: 가려진 뷰어 창이 '죽은 것'으로 보여 ①부트스트랩이 전 모니터를 덮어썼다
  // (= "다른 앱 쓰다 돌아오니 첫 영상이 사라진다"). 진짜 닫힘은 releaseViewerSlot + pagehide 유예 담당.
  assert.ok(SLOT_TTL_MS > 60_000, `TTL(${SLOT_TTL_MS}ms)이 스로틀 주기 60s 보다 크지 않다`);
  assert.ok(SLOT_HEARTBEAT_MS < SLOT_TTL_MS);
  // 유예는 '리로드 공백(문서 교체+마운트)'을 덮어야 한다 — 예전 TTL 6s 가 그 역할이었으므로 그 이상.
  assert.ok(SLOT_UNLOAD_GRACE_MS >= 6000, "유예가 짧으면 리로드 중인 창이 죽은 것으로 보인다");
  assert.ok(SLOT_UNLOAD_GRACE_MS > SLOT_HEARTBEAT_MS && SLOT_UNLOAD_GRACE_MS < SLOT_TTL_MS);
});

test("pagehide 유예 — 리로드는 살리고 진짜 닫힘은 TTL 을 기다리지 않고 만료", () => {
  openStudy(SLOTS3, 101);
  // (1) 리로드: pagehide 표식 → 새 문서의 첫 하트비트가 표식을 지운다
  markViewerSlotUnloading("sv_viewer_slot1");
  noteViewerSlot("sv_viewer_slot1", 101);
  // (2) 진짜 닫힘: 표식만 남고 하트비트가 안 온다 → 유예 경과분은 죽은 것으로 본다
  markViewerSlotUnloading("sv_viewer_slot2");
  const rec = JSON.parse(localStorage.getItem("sv_vslot_sv_viewer_slot2"));
  localStorage.setItem("sv_vslot_sv_viewer_slot2",
    JSON.stringify({ ...rec, u: rec.u - SLOT_UNLOAD_GRACE_MS - 1 }));
  const live = liveViewerSlots();
  assert.ok(live.has("sv_viewer_slot1"), "리로드 중인 창을 죽였다 — 부트스트랩이 전 모니터를 덮어쓴다");
  assert.ok(!live.has("sv_viewer_slot2"), "닫힌 창이 TTL 끝까지 살아 있으면 순번이 빈 모니터로 간다");
});

test("All Close(clearViewerSlots) 후 첫 오픈도 전 모니터", () => {
  openStudy(SLOTS3, 101);
  openStudy(SLOTS3, 102);
  clearViewerSlots();
  assert.equal(liveViewerSlots().size, 0);
  assert.equal(readViewerRoundRobin(), 0);
  assert.deepEqual(openStudy(SLOTS3, 301), N);
});

test("모니터 설정 축소(3→2) — 고아 슬롯은 장부에서도 빠져야 순번이 어긋나지 않는다", () => {
  openStudy(SLOTS3, 101);
  const slots2 = SLOTS3.slice(0, 2);
  forgetViewerSlot("sv_viewer_slot2");   // openV2 의 고아 창 정리 경로
  assert.deepEqual([...liveViewerSlots().keys()].sort(), ["sv_viewer", "sv_viewer_slot1"]);
  writeViewerRoundRobin(1);
  assert.deepEqual(openStudy(slots2, 102), ["sv_viewer_slot1"]);
  assert.deepEqual(openStudy(slots2, 103), ["sv_viewer"], "2슬롯이면 1↔2 만 순환");
});

test("max_open 캡이 걸린 슬롯 목록에서도 규칙은 동일(2슬롯 순환)", () => {
  const capped = SLOTS3.slice(0, 2);    // max_open=2 → screenFeaturesList 가 잘라 준 목록
  assert.deepEqual(openStudy(capped, 401), ["sv_viewer", "sv_viewer_slot1"]);
  assert.deepEqual(openStudy(capped, 402), ["sv_viewer_slot1"]);
  assert.deepEqual(openStudy(capped, 403), ["sv_viewer"]);
});

test("순번이 슬롯 수를 넘어가도(설정 축소 직후) 범위 안으로 접힌다", () => {
  writeViewerRoundRobin(7);
  const plan = planViewerOpen(SLOTS3, ["sv_viewer"], 7);   // 7 % 3 = 1
  assert.deepEqual(plan.targets.map((t) => t.name), ["sv_viewer_slot1"]);
  assert.equal(plan.nextRr, 2);
});

/* ── 다운로드 모드 기준선 해제 판정 (decideBaselineRelease) ────────────────────────────
 * 요구: "뷰어가 닫히면 다운로드를 멈추고 기준선을 푼다. 다시 열면 그때 연 영상이 새 기준."
 * 워크리스트는 2초 폴로 '살아 있는 창 목록'(슬롯 장부 ∪ !w.closed 창 핸들)을 만들어 이 함수에
 * 물어보고, release=true 일 때만 clearDlOpened()→dlStop() 한다.
 *
 * 되돌리면 실패한다:
 *   · 레벨 트리거(live===0 이면 해제)로 바꾸면 ①⑤ 가 실패한다.
 *   · '마지막 창' 조건을 지우고 창 하나가 줄어든 것으로 판정하면 ③ 이 실패한다.
 *   · isViewerSlotName 필터를 빼면 ⑥ 이 실패한다.
 */
test("① 한 번도 살아 있는 창을 못 봤고 지금도 0 → 해제하지 않는다 (F5·미오픈에서 기준선 유지)", () => {
  // 워크리스트를 F5 하면 창 핸들 맵이 사라지고, 교차 출처(VIEWER_BASE) 배치면 장부도 안 보인다.
  // 여기서 풀어 버리면 판독 중인데 기준선이 날아가고 다운로드가 멈춘다.
  assert.deepEqual(decideBaselineRelease(false, []), { seenLive: false, release: false });
});

test("② 0 → 1 : 래치만 세운다(해제 없음)", () => {
  assert.deepEqual(decideBaselineRelease(false, ["sv_viewer"]), { seenLive: true, release: false });
});

test("③ 2 → 1 : 한 창만 닫혀도 절대 풀리지 않는다 (판독 중 기준선 소실 금지)", () => {
  // 다중 모니터 ①부트스트랩은 창을 2~3개 띄우고, 사용자가 그중 하나만 닫는 일이 흔하다.
  const d = decideBaselineRelease(true, ["sv_viewer_slot1"]);
  assert.deepEqual(d, { seenLive: true, release: false });
});

test("④ 2 → 0 : 마지막 창이 닫힌 하강 에지에서만 해제", () => {
  assert.deepEqual(decideBaselineRelease(true, []), { seenLive: false, release: true });
});

test("⑤ 해제 직후 0 → 0 : 다시 해제하지 않는다 (dlStop 반복 → stop/start 진동 금지)", () => {
  const first = decideBaselineRelease(true, []);
  assert.equal(first.release, true);
  const second = decideBaselineRelease(first.seenLive, []);
  assert.deepEqual(second, { seenLive: false, release: false });
});

test("⑥ 뷰어 슬롯이 아닌 창 이름(sv_report 등)은 '살아 있는 뷰어'로 세지 않는다", () => {
  // 판독창이 떠 있다고 뷰어가 살아 있는 것은 아니다 — 세면 기준선이 영영 안 풀린다.
  assert.deepEqual(decideBaselineRelease(true, ["sv_report", "sv_worklist"]),
    { seenLive: false, release: true });
  // 반대로 진짜 슬롯 이름이 섞여 있으면 살아 있는 것이다
  assert.deepEqual(decideBaselineRelease(true, ["sv_report", "sv_viewer_slot2"]),
    { seenLive: true, release: false });
  // 중복 이름이 들어와도 '개수'가 부풀지 않는다(장부 ∪ 핸들 합집합이므로 같은 이름이 두 번 올 수 있다)
  assert.deepEqual(decideBaselineRelease(true, ["sv_viewer", "sv_viewer"]),
    { seenLive: true, release: false });
});

test("장부 레벨 — pagehide 유예 안에서는 여전히 살아 있다(해제 없음), 둘 다 만료돼야 해제", () => {
  // 창 2개가 살아 있다 → 래치 on
  noteViewerSlot("sv_viewer", 101);
  noteViewerSlot("sv_viewer_slot1", 101);
  let seen = false;
  let d = decideBaselineRelease(seen, liveViewerSlots().keys());
  seen = d.seenLive;
  assert.deepEqual([d.seenLive, d.release], [true, false]);

  // 한 창이 내려간다(리로드일 수도 있다) — 유예 안이면 아직 살아 있는 것으로 센다
  markViewerSlotUnloading("sv_viewer_slot1");
  assert.equal(liveViewerSlots().size, 2, "유예 안의 창을 죽이면 리로드 중에 기준선이 날아간다");
  d = decideBaselineRelease(seen, liveViewerSlots().keys());
  seen = d.seenLive;
  assert.deepEqual([d.seenLive, d.release], [true, false]);

  // 유예 초과 = 진짜 닫힘. 그래도 남은 창이 1개이므로 해제하지 않는다(위 규칙 ③)
  const r1 = JSON.parse(localStorage.getItem("sv_vslot_sv_viewer_slot1"));
  localStorage.setItem("sv_vslot_sv_viewer_slot1",
    JSON.stringify({ ...r1, u: r1.u - SLOT_UNLOAD_GRACE_MS - 1 }));
  assert.equal(liveViewerSlots().size, 1);
  d = decideBaselineRelease(seen, liveViewerSlots().keys());
  seen = d.seenLive;
  assert.deepEqual([d.seenLive, d.release], [true, false], "한 창이 남았는데 풀면 판독 중 기준선 소실");

  // 마지막 창까지 닫히면 그제서야 해제
  markViewerSlotUnloading("sv_viewer");
  const r0 = JSON.parse(localStorage.getItem("sv_vslot_sv_viewer"));
  localStorage.setItem("sv_vslot_sv_viewer",
    JSON.stringify({ ...r0, u: r0.u - SLOT_UNLOAD_GRACE_MS - 1 }));
  assert.equal(liveViewerSlots().size, 0);
  d = decideBaselineRelease(seen, liveViewerSlots().keys());
  assert.deepEqual([d.seenLive, d.release], [false, true]);
});

test("localStorage 가 막혀도 던지지 않는다 (사생활 모드·quota) — 사이클 시작으로 폴백", () => {
  const boom = { get length() { throw new Error("blocked"); }, key() { throw new Error("blocked"); },
                 getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); },
                 removeItem() { throw new Error("blocked"); } };
  globalThis.localStorage = boom;
  assert.equal(liveViewerSlots().size, 0);
  assert.equal(readViewerRoundRobin(), 0);
  assert.doesNotThrow(() => {
    noteViewerSlot("sv_viewer", 1); markViewerSlotUnloading("sv_viewer");
    writeViewerRoundRobin(2); clearViewerSlots();
    openByPlan(planViewerOpen(SLOTS3, [], 0), 1, () => true);
  });
});

// ── otherLiveViewerCount — '지금 닫기를 전파해서 실제로 닫을 창이 있는가' ──────
//  Esc 확인 강제(viewerClose.decideCloseScope.forceAsk)의 유일한 근거다. 자기 자신을 세면
//  단일 모니터 사용자도 항상 1 이 되어, 닫힐 다른 창이 없는데 확인 다이얼로그가 뜬다.
test("otherLiveViewerCount 는 자기 창(window.name)을 빼고 센다", () => {
  globalThis.window.name = "sv_viewer";
  noteViewerSlot("sv_viewer", 1);
  assert.equal(otherLiveViewerCount(), 0, "단일 모니터 = 전파해도 닫을 다른 창이 없다");

  noteViewerSlot("sv_viewer_slot1", 1);
  noteViewerSlot("sv_viewer_slot2", 1);
  assert.equal(otherLiveViewerCount(), 2);

  // 만료된 창은 세지 않는다(liveViewerSlots 의 TTL 판정을 그대로 탄다)
  const r = JSON.parse(localStorage.getItem("sv_vslot_sv_viewer_slot2"));
  localStorage.setItem("sv_vslot_sv_viewer_slot2", JSON.stringify({ ...r, t: r.t - SLOT_TTL_MS - 1 }));
  assert.equal(otherLiveViewerCount(), 1);

  // 슬롯 규약이 아닌 일반 탭(name="") — 자기 것이 장부에 없으므로 전부가 '다른 창'
  globalThis.window.name = "";
  assert.equal(otherLiveViewerCount(), 2);
});

/* ── 다운로드 모드 기준선 **상승** 에지 판정 (decideBaselineArm) ────────────────────────
 * 요구의 뒷면이다: "뷰어가 닫히면 멈춘다" 를 배선하면 **재개**도 같은 자리에 있어야 한다.
 *
 * 회귀 이력(이 블록이 생긴 이유): 해제(하강 에지)는 뷰어가 전부 닫히면 무조건 걸리는데 재개는
 * Worklist.openV2 **하나뿐**이었다. 그런데 sv_viewer 창을 여는 곳은 openV2 만이 아니다 —
 * 판독창(ReportWindow)의 ◀▶ 넘기기(:351)와 과거검사 Compare(:114)는 `window.open(..., "sv_viewer")`
 * 로 **다른 창의 다른 문서**에서 연다(markDlOpened 를 부를 수 없다). 그래서
 *     뷰어 ✕(→dlStop) → 판독창 ◀▶ 로 다음 검사 → 뷰어는 멀쩡히 떠 있는데 다운로드는 죽은 채
 * 가 그 세션 내내 이어졌다(워크리스트에서 다시 더블클릭해야 복구).
 *
 * 그래서 **금지 상태**를 여기서 못 박는다: '뷰어가 살아 있는데 기준선이 0' 은 존재할 수 없다.
 * 되돌리면(폴링 훅의 게이트를 `if (!dlOpenedAt) return` 으로 되돌리거나 arm 호출을 지우면)
 * 아래 ①③④ 가 실패한다.
 */
test("① 뷰어가 살아 있는데 기준선이 없다 → 반드시 재개한다 (금지 상태)", () => {
  assert.deepEqual(decideBaselineArm(false, ["sv_viewer"]), { arm: true });
  assert.deepEqual(decideBaselineArm(false, ["sv_viewer_slot2"]), { arm: true });
});

test("② 기준선이 이미 있으면 다시 세우지 않는다 (매 폴마다 markDlOpened 폭주 금지)", () => {
  assert.deepEqual(decideBaselineArm(true, ["sv_viewer"]), { arm: false });
});

test("③ 뷰어가 하나도 없으면 세우지 않는다 (열지도 않았는데 전체 아카이브를 받기 시작 금지)", () => {
  assert.deepEqual(decideBaselineArm(false, []), { arm: false });
  // 판독창만 떠 있는 것은 '뷰어가 살아 있다'가 아니다 — 세면 영상을 안 열었는데 받기 시작한다
  assert.deepEqual(decideBaselineArm(false, ["sv_report", "sv_worklist"]), { arm: false });
});

test("④ 해제 → 재오픈 왕복: 하강/상승이 서로를 되돌린다 (한 번 닫으면 세션 내내 죽는 상태 금지)", () => {
  let seen = false;
  let baseline = 0;
  const poll = (names) => {
    const r = decideBaselineRelease(seen, names);
    seen = r.seenLive;
    if (r.release) { baseline = 0; return; }          // clearDlOpened → dlStop
    if (decideBaselineArm(!!baseline, names).arm) baseline = 1;   // markDlOpened → dlResume
  };
  poll(["sv_viewer"]);                 // 워크리스트에서 오픈
  assert.equal(baseline, 1);
  poll([]);                            // 뷰어 ✕ → 정지
  assert.equal(baseline, 0);
  poll([]);                            // 아무 일 없음(진동 금지)
  assert.equal(baseline, 0);
  poll(["sv_viewer"]);                 // 판독창 ◀▶ 로 다시 열림 — 워크리스트는 이 사실을 상태로만 안다
  assert.equal(baseline, 1, "재개 경로가 openV2 하나뿐이면 여기가 0 으로 남는다(도입된 회귀)");
});

test("⑤ 장부 레벨 — 다른 창/다른 탭이 연 뷰어도 관측된다(localStorage 공유)", () => {
  // 워크리스트 탭이 2개인 배치: 기준선(sessionStorage)과 dlStop(모듈 변수)은 탭별이지만
  // 슬롯 장부는 오리진 공유라, 탭 B 가 연 뷰어를 탭 A 도 본다.
  assert.deepEqual(decideBaselineArm(false, liveViewerSlots().keys()), { arm: false });
  noteViewerSlot("sv_viewer", 777);
  assert.deepEqual(decideBaselineArm(false, liveViewerSlots().keys()), { arm: true });
  forgetViewerSlot("sv_viewer");
  assert.deepEqual(decideBaselineArm(false, liveViewerSlots().keys()), { arm: false });
});
