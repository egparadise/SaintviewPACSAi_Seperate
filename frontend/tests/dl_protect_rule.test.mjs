/* '보고 있는 검사는 삭제하지 않습니다' 가 **실제로** 성립하는가 — 축출 보호 회귀.
 *
 * dl_evict_rule.test.mjs 의 ② 테스트는 이 보증을 검증한다고 적혀 있지만, protectedUids 를 부르지
 * 않고 손으로 만든 배열을 planEvictions 에 넘긴다. 그래서 '보호 집합을 **산출하는** 쪽'의 구멍을
 * 구조적으로 못 잡는다. 실제로 두 경로가 뚫려 있었다:
 *   (a) 보호 출처가 Viewer2D 전용 장부(sv_viewer_tabs)라 **ViewerInfi 에서는 항상 빈 배열**이었다
 *       (In-View 자기 장부 sv_infi_exams 는 uid 없는 id 배열이라 읽을 수도 없다).
 *       단일 모니터 + In-View 조합에서는 보호가 슬롯 하나로 줄었다.
 *   (b) 슬롯(viewerSlots)은 **큐를 통해서만** studyId→uid 로 바뀐다. 환자 X 를 검색해 2019년 prior
 *       까지 받아 두고 그 prior 를 띄운 채 환자 Y 로 재검색하면 prior 는 큐에 없다 → 변환 불가 →
 *       보호 밖. policy=date 기준으로 그 prior 가 **1순위 희생자**다.
 *   (c) sv_viewer_tabs 에는 만료가 없다. 브라우저 X·Ctrl+W 로 닫으면 최대 8건이 무기한 축출 불가로
 *       남아 게이트를 잠갔고, 그때 안내는 '창을 닫으면 이어받습니다' 였다(이미 다 닫은 상태).
 *
 * 지키는 규정:
 *   ① 뷰어 장부는 **만료된다**(TTL) — 닫힌 창의 항목이 영구히 보호되지 않는다.
 *   ② 장부는 uid 를 **직접** 싣는다 — 큐에서 빠진 prior 도 보호된다(뷰어 종류와 무관).
 *   ③ 비활성 Exam 탭의 비교 검사도 보호된다(슬롯은 활성 1건만 하트비트한다).
 *   ④ 받는 중 + 방금 받은 검사(유계)는 보호되고, 그 보호는 **만료된다**(영구 게이트 금지).
 *   ⑤ 상한 근접 알림은 '곧 중지될 때' 만 뜬다 — 자동 삭제가 정상 작동하는 100% 는 경보가 아니다.
 *
 * 실행: node frontend/tests/dl_protect_rule.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { HELD_TTL_MS, heldStudyUids } from "../src/lib/dlHeld.ts";
import { computeProtectedUids, shouldWarnNearLimit } from "../src/lib/dlQueueRule.ts";
import { planEvictions } from "../src/lib/opfsStore.ts";

const GB = 1024 * 1024 * 1024;
const NOW = Date.parse("2026-07-29T12:00:00Z");

test("① 뷰어 장부는 만료된다 — 브라우저 X 로 닫은 창의 검사가 영구 보호되지 않는다", () => {
  const live = { u: ["LIVE1", "LIVE2"], t: NOW - 3_000 };
  const dead = { u: ["CLOSED_LONG_AGO"], t: NOW - HELD_TTL_MS - 1 };
  assert.deepEqual(heldStudyUids([live, dead], NOW).sort(), ["LIVE1", "LIVE2"],
    "만료가 없으면 닫힌 창의 검사가 축출 불가로 남아 상한 게이트가 잠긴다(그때 안내는 '창을 닫으세요' 다)");
  // 경계에서 살아 있는 창을 죽었다고 보면 판독 중 저장본이 지워진다 — TTL 직전은 살아 있어야 한다.
  assert.deepEqual(heldStudyUids([{ u: ["EDGE"], t: NOW - HELD_TTL_MS + 1 }], NOW), ["EDGE"]);
  // 창이 여럿이면 합집합이고 중복은 접힌다(창마다 키가 갈려 있어 read-modify-write 경합이 없다).
  assert.deepEqual(
    heldStudyUids([{ u: ["A", "B"], t: NOW }, { u: ["B", "C"], t: NOW }], NOW).sort(), ["A", "B", "C"]);
  // 깨진 항목은 무시한다(장부가 깨져도 보호만 줄지 폭주하지 않는다)
  assert.deepEqual(heldStudyUids([null, undefined, { t: NOW }, { u: "x", t: NOW }, { u: [1, ""], t: NOW }], NOW), []);
});

test("② ViewerInfi 단일 모니터 + 큐에서 빠진 prior — 장부가 uid 를 직접 실어 보호된다", () => {
  // 환자 X 의 2019년 prior 를 In-View 로 띄워 둔 채 환자 Y 로 재검색 → 큐는 Y 로 통째로 교체됐다.
  const queue = [
    { studyId: 901, studyUid: "Y_TODAY" },
    { studyId: 902, studyUid: "Y_2025" },
  ];
  // In-View 는 sv_viewer_tabs 를 쓰지 않는다. 슬롯 하트비트가 남긴 studyId(701)는 큐에 없어 변환 불가.
  const slotStudyIds = [701];
  const held = ["X_PRIOR_2019"];   // ← 뷰어가 직접 남긴 uid(dlHeld)

  const prot = computeProtectedUids({ now: NOW, curUid: "", heldUids: held, slotStudyIds, queue });
  assert.ok(prot.includes("X_PRIOR_2019"),
    "큐에서 빠진 prior 가 보호 밖이다 — policy=date 에서 정확히 1순위 희생자가 된다");

  // 옛 구조(장부 없음) — 같은 상황에서 보호가 **빈 배열**이 된다는 것을 명시적으로 남긴다.
  assert.deepEqual(
    computeProtectedUids({ now: NOW, curUid: "", slotStudyIds, queue }), [],
    "이 케이스가 예전에는 보호 0 이었다(그래서 판독 중 화면이 서버 렌더로 되돌아갔다)");

  // 원본 planEvictions 로 끝까지 확인 — 보호가 실제로 축출을 막는다.
  const records = [
    { studyUid: "X_PRIOR_2019", bytes: 0.9 * GB, lastUsed: NOW - 3600_000, studyDate: "20190510" },
    { studyUid: "Y_2025", bytes: 0.8 * GB, lastUsed: NOW - 60_000, studyDate: "20250101" },
    { studyUid: "Y_TODAY", bytes: 0.8 * GB, lastUsed: NOW, studyDate: "20260729" },
  ];
  const p = planEvictions({ records, limitBytes: 2 * GB, protectedUids: prot });
  assert.ok(!p.evict.includes("X_PRIOR_2019"), "판독 중인 prior 가 지워졌다");
  assert.deepEqual(p.evict, ["Y_2025"]);
});

test("③ 비활성 Exam 탭의 비교 검사도 보호된다 — 슬롯은 활성 1건만 하트비트한다", () => {
  // 슬롯 장부는 '활성 검사' 하나(=TODAY)만 싣는다. 비교로 띄워 둔 두 건은 여기 안 잡힌다.
  const queue = [{ studyId: 1, studyUid: "TODAY" }, { studyId: 2, studyUid: "CMP_A" }, { studyId: 3, studyUid: "CMP_B" }];
  const slotOnly = computeProtectedUids({ now: NOW, slotStudyIds: [1], queue });
  assert.deepEqual(slotOnly, ["TODAY"]);
  // 장부는 그 창이 물고 있는 **모든** 탭의 uid 를 싣는다.
  const withHeld = computeProtectedUids({
    now: NOW, slotStudyIds: [1], queue, heldUids: ["TODAY", "CMP_A", "CMP_B"],
  });
  assert.deepEqual(withHeld.sort(), ["CMP_A", "CMP_B", "TODAY"]);
});

test("④ 받는 중 + 방금 받은 검사는 보호되고, 그 보호는 만료된다", () => {
  assert.deepEqual(computeProtectedUids({ now: NOW, curUid: "CUR" }), ["CUR"]);
  // 방금 받은 검사 — 게이트 진입에서 curUid 가 비는 순간의 자기삭제를 막는다.
  assert.deepEqual(
    computeProtectedUids({ now: NOW, curUid: "", recentUid: "JUSTDONE", recentUntil: NOW + 1 }), ["JUSTDONE"]);
  // 만료 뒤에는 풀린다 — 안 풀리면 '보호 대상만으로 상한 초과' 게이트가 영구히 선다.
  assert.deepEqual(
    computeProtectedUids({ now: NOW, curUid: "", recentUid: "JUSTDONE", recentUntil: NOW }), []);
  // 슬롯 id 가 0/음수면 무시한다(장부 초기값·깨진 값)
  assert.deepEqual(
    computeProtectedUids({ now: NOW, slotStudyIds: [0, -1], queue: [{ studyId: 0, studyUid: "ZERO" }] }), []);
});

test("⑤ 자동 삭제가 정상 작동하는 100% 는 경보가 아니다 — 알림은 '곧 중지될 때' 만", () => {
  const base = { used: 2 * GB, limit: 2 * GB, warnAtPct: 90, armed: true, blocked: false };
  // planEvictions 는 `total - freed <= limit` 에서 멈추므로 축출 직후 사용량은 늘 상한에 붙는다.
  // 자동 삭제 ON = '초과분은 자동 삭제됩니다' = 아무 조치도 필요 없다 → 빨간 ⚠ 를 띄울 이유가 없다.
  assert.equal(shouldWarnNearLimit({ ...base, enabled: true, autoEvict: true }).warn, false,
    "자동 삭제가 정상 작동 중인데 경보가 뜬다 — 워크리스트를 띄울 때마다 오류처럼 보인다");
  // 자동 삭제 OFF = '곧 중지됩니다' 라는 실제 예고 → 뜬다. 그리고 세션 1회.
  const off = shouldWarnNearLimit({ ...base, enabled: true, autoEvict: false });
  assert.equal(off.warn, true);
  assert.equal(off.armed, false);
  assert.equal(shouldWarnNearLimit({ ...base, enabled: true, autoEvict: false, armed: false }).warn, false);
  // 자동 삭제 ON 이라도 보호 때문에 못 지우면(blocked) 실제로 더 못 받는다 → 뜬다.
  assert.equal(shouldWarnNearLimit({ ...base, enabled: true, autoEvict: true, blocked: true }).warn, true);
  // 히스테리시스 재무장 — 임계-5%p 아래로 내려가야 다시 무장한다.
  assert.equal(shouldWarnNearLimit({
    ...base, enabled: true, autoEvict: false, armed: false, used: 1.6 * GB,   // 80%
  }).armed, true);
  assert.equal(shouldWarnNearLimit({
    ...base, enabled: true, autoEvict: false, armed: false, used: 1.75 * GB,  // 87.5% — 재무장 금지 구간
  }).armed, false);
  // 알림 자체를 끈 경우·상한 미상은 아무것도 하지 않는다.
  assert.equal(shouldWarnNearLimit({ ...base, enabled: false, autoEvict: false }).warn, false);
  assert.equal(shouldWarnNearLimit({ ...base, enabled: true, autoEvict: false, limit: 0 }).warn, false);
});
