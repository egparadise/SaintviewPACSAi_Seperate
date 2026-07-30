/* 사양 6 '직접설정' 왕복 회귀 테스트 — lib/hpCapture.ts 의 **원본**을 그대로 부른다.
 *
 * 지키는 것(되돌리면 여기서 실패한다):
 *   ① 이 창이 몇 번 모니터인지 window.name 규약으로 역산한다(viewerSlots.viewerSlotName 의 역함수).
 *   ② 슬롯 배정: 바로 이전 검사=prev, 나머지는 그 검사를 **포함하는 가장 좁은** 기간. 1년 초과는 년 단위.
 *   ③ 되돌릴 때 과거검사를 **칸 순서대로 소진**한다 — 같은 검사가 두 칸에 겹쳐 뜨지 않는다.
 *      (슬롯별로 따로 세면 prev 칸과 '1년 내' 칸에 같은 검사가 뜬다)
 *   ④ **왕복** — 화면 읽기 → 규칙 → 저장(writeHpDoc) → 로드(readHpDoc) → 되돌리기가 같은 배치를 준다.
 *   ⑤ 왕복하지 못하는 것은 **경고로 알린다**(칸 순서 ≠ 날짜 순서 / 후보에 없는 검사).
 *   ⑥ 뷰어 저장 규칙의 기본값: use_on_exam_open=false('골라야 적용'), priority=false, source="viewer",
 *      body_part 는 비운다(사양 3 은 자유 입력이라 추측하지 않는다).
 *   ⑦ 덮어쓰기는 설정에서 넣은 매칭 조건(부위·출처·Projection)과 다른 모니터 화면을 **보존**한다.
 *
 * 실행: node --test frontend/tests/hp_capture.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  findHpRuleByName, hpCaptureScreen, hpDaysBefore, hpMonitorIndex, hpPlanCells, hpPriorsByRecency,
  hpRuleFromScreen, hpRoundTripWarnings, hpScreenHasPlacement, hpSlotOfPrior, mergeHpScreen,
  pickHpScreen, upsertHpRule,
} from "../src/lib/hpCapture.ts";
import { readHpDoc, writeHpDoc } from "../src/lib/hangingProtocol.ts";

const ANCHOR = "20260701";
const CUR = "u-cur";
const PRIORS = [
  { id: 11, study_date: "20260628", study_uid: "u-a" },   // 3일 전
  { id: 12, study_date: "20260601", study_uid: "u-b" },   // 30일 전
  { id: 13, study_date: "20250101", study_uid: "u-c" },   // 546일 전
  { id: 14, study_date: "20270101", study_uid: "u-f" },   // 미래 — 후보가 아니다
  { id: 15, study_date: "", study_uid: "u-x" },           // 날짜 불명 — 후보가 아니다
];
const CTX = { currentUid: CUR, anchorDate: ANCHOR, priors: PRIORS, currentId: 10 };

/* ══════════ ① 모니터 역산 ══════════ */

test("① window.name → 모니터 인덱스 (viewerSlotName 의 역함수)", () => {
  assert.equal(hpMonitorIndex("sv_viewer_slot3", [0, 3]), 3);
  // "sv_viewer" 는 인덱스를 담고 있지 않다 — Setting>모니터 선택의 **최저 번호**가 그 창이다
  assert.equal(hpMonitorIndex("sv_viewer", [3, 1, 5]), 1);
  assert.equal(hpMonitorIndex("sv_viewer", []), null);      // 선택 없음 = 미지정 화면
  assert.equal(hpMonitorIndex("sv_viewer", undefined), null);
  assert.equal(hpMonitorIndex("", [0, 1]), null);           // 일반 탭(창 이름 없음)
  assert.equal(hpMonitorIndex("sv_report", [0, 1]), null);
});

/* ══════════ ② 슬롯 배정 ══════════ */

test("② 최신순 후보 — 미래·날짜불명은 빠지고 아주 오래된 것도 남는다(하한 없음)", () => {
  const list = hpPriorsByRecency(CTX);
  assert.deepEqual(list.map((p) => p.study_uid), ["u-a", "u-b", "u-c"]);
});

test("② 같은 날 검사는 후보에 포함된다(오전/오후 촬영 비교)", () => {
  const same = hpPriorsByRecency({ ...CTX, priors: [{ id: 20, study_date: ANCHOR, study_uid: "u-s" }] });
  assert.deepEqual(same.map((p) => p.id), [20]);
});

test("② 슬롯은 '포함하는 가장 좁은 기간' — 넓게 잡으면 다른 검사가 걸려 들어온다", () => {
  assert.deepEqual(hpSlotOfPrior(ANCHOR, "20260628", 0), { kind: "prev" });   // rank 0 = 바로 이전
  assert.deepEqual(hpSlotOfPrior(ANCHOR, "20260628", 1), { kind: "1w" });     // 3일
  assert.deepEqual(hpSlotOfPrior(ANCHOR, "20260601", 1), { kind: "1m" });     // 30일(경계 포함)
  assert.deepEqual(hpSlotOfPrior(ANCHOR, "20260101", 1), { kind: "1y" });     // 181일
  // 1년을 넘으면 년 단위 올림 — 절대 날짜로 저장하면 다른 검사에 적용했을 때 후보가 0건이 된다
  assert.deepEqual(hpSlotOfPrior(ANCHOR, "20250101", 2), { kind: "custom", n: 2, unit: "y" });
  assert.equal(hpDaysBefore(ANCHOR, "20250101"), 546);
  assert.equal(hpDaysBefore("", "20250101"), null);
});

/* ══════════ ③ 되돌리기 — 칸 순서대로 소진 ══════════ */

const screenOf = (cells, s = { r: 1, c: cells.length }) => ({
  id: "sc1", role: "viewer", label: "1", monitor: 0, resolution: "", s, i: { r: 1, c: 1 }, cells,
});

test("③ 서로 다른 슬롯이라도 같은 검사를 두 칸에 넣지 않는다(칸 순서대로 소진)", () => {
  // prev(=가장 최근)와 '1개월 내'는 같은 검사를 가리킬 수 있다 — 소진하지 않으면 두 칸에 u-a 가 뜬다
  const plan = hpPlanCells(screenOf([
    { series: null, slot: { kind: "prev" } },
    { series: null, slot: { kind: "1m" } },
    { series: null, slot: { kind: "custom", n: 2, unit: "y" } },
  ]), CTX);
  assert.deepEqual(plan.map((p) => p.prior?.study_uid), ["u-a", "u-b", "u-c"]);
});

test("③ 같은 슬롯이 여러 칸이면 최신순으로 다른 검사가 들어간다", () => {
  const plan = hpPlanCells(screenOf([
    { series: null, slot: { kind: "1y" } },
    { series: null, slot: { kind: "1y" } },
  ]), CTX);
  assert.deepEqual(plan.map((p) => p.prior?.study_uid), ["u-a", "u-b"]);
});

test("③ 현재 검사 칸·후보 없음·3D 는 각각 구분된다(조용히 비우지 않는다)", () => {
  const plan = hpPlanCells(screenOf([
    { series: 2, slot: { kind: "current" } },
    { series: null, slot: { kind: "1w" } },
    { series: null, slot: { kind: "1w" } },   // 1주 내 후보는 u-a 하나뿐 → 두 번째 칸은 없음
    { series: null, slot: { kind: "3d" } },
  ]), CTX);
  assert.equal(plan[0].prior, null);
  assert.equal(plan[0].series, 2);            // 시리즈 순번(구 cells 값)은 그대로 살아난다
  assert.equal(plan[0].skip, undefined);
  assert.equal(plan[1].prior?.study_uid, "u-a");
  assert.equal(plan[2].skip, "none");
  assert.equal(plan[3].skip, "3d");           // 3D 는 뷰어가 복원하지 못한다 — 표시해서 알린다
});

test("③ prev 는 언제나 1건뿐 — 두 칸이 prev 면 둘째는 비어야 한다", () => {
  const plan = hpPlanCells(screenOf([
    { series: null, slot: { kind: "prev" } },
    { series: null, slot: { kind: "prev" } },
  ]), CTX);
  assert.equal(plan[0].prior?.study_uid, "u-a");
  assert.equal(plan[1].skip, "none");
});

test("③ 칸 정보가 없는 구 규칙은 '배치 없음' — 뷰어가 페인을 건드리지 않는다(구 동작 보존)", () => {
  // Setting 에서 그리드만 잡은 구 규칙(칸 전부 미지정 + 현재 검사)을 고르면 레이아웃만 바뀌어야 한다.
  // 여기서 true 를 돌려주면 사용자가 잡아 둔 비교 배치가 규칙 선택만으로 통째로 날아간다.
  assert.equal(hpScreenHasPlacement(screenOf([
    { series: null, slot: { kind: "current" } }, { series: null, slot: { kind: "current" } },
  ])), false);
  assert.equal(hpScreenHasPlacement(screenOf([{ series: 2, slot: { kind: "current" } }])), true);
  assert.equal(hpScreenHasPlacement(screenOf([{ series: null, slot: { kind: "prev" } }])), true);
  assert.equal(hpScreenHasPlacement(null), false);
  // 뷰어 '직접설정'으로 읽은 화면은 시리즈 순번이 들어가므로 항상 배치가 있다
  assert.equal(hpScreenHasPlacement(hpCaptureScreen(SNAP, CTX).screen), true);
});

/* ══════════ ④ 왕복 ══════════ */

const SNAP = {
  monitor: 0, resolution: "2560 * 1080", s: { r: 2, c: 2 }, i: { r: 1, c: 2 },
  panes: [
    { studyUid: CUR, seriesNo: 1 },
    { studyUid: "u-a", seriesNo: 1 },
    { studyUid: "u-b", seriesNo: 2 },
    { studyUid: "u-c", seriesNo: null },
  ],
};

test("④ 읽기 → 되돌리기가 같은 배치를 준다(경고 없음)", () => {
  const { screen, warnings } = hpCaptureScreen(SNAP, CTX);
  assert.deepEqual(warnings, []);
  assert.deepEqual(screen.cells.map((c) => c.slot.kind), ["current", "prev", "1m", "custom"]);
  assert.deepEqual(screen.cells.map((c) => c.series), [1, 1, 2, null]);
  const plan = hpPlanCells(screen, CTX);
  assert.deepEqual(plan.map((p) => p.prior?.study_uid ?? CUR), [CUR, "u-a", "u-b", "u-c"]);
});

test("④ 저장(writeHpDoc) → 로드(readHpDoc) 를 거쳐도 같은 배치가 나온다", () => {
  const { screen } = hpCaptureScreen(SNAP, CTX);
  const rule = hpRuleFromScreen({ name: "흉부 비교", screen, modality: "cr", wl: "-600,1500" });
  const saved = writeHpDoc({ rules: [rule], modalities: [] });
  const back = readHpDoc(JSON.parse(JSON.stringify(saved)));   // 설정 저장(JSON) 왕복까지 흉내낸다
  const sc = pickHpScreen(back.rules[0], 0);
  assert.ok(sc);
  assert.deepEqual(sc.s, { r: 2, c: 2 });
  assert.deepEqual(sc.i, { r: 1, c: 2 });
  const plan = hpPlanCells(sc, CTX);
  assert.deepEqual(plan.map((p) => p.prior?.study_uid ?? CUR), [CUR, "u-a", "u-b", "u-c"]);
  assert.deepEqual(plan.map((p) => p.series), [1, 1, 2, null]);
  // 구 필드(s/i/displays)도 되채워져 구 빌드·구 호출부에서 1×1 로 무너지지 않는다
  assert.deepEqual(back.rules[0].s, { r: 2, c: 2 });
  assert.equal(back.rules[0].displays?.[0].cells.length, 4);
});

/* ══════════ ⑤ 왕복하지 못하는 것은 경고한다 ══════════ */

test("⑤ 칸 순서가 날짜 순서와 다르면 '자리가 바뀔 수 있다'고 알린다", () => {
  const rev = { ...SNAP, s: { r: 1, c: 3 },
                panes: [{ studyUid: "u-c", seriesNo: null }, { studyUid: "u-b", seriesNo: null },
                        { studyUid: "u-a", seriesNo: null }] };
  const { screen, warnings } = hpCaptureScreen(rev, CTX);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /최신순/);
  // 실제로 되돌리면 최신순으로 채워진다(경고 문구가 사실인지까지 고정한다).
  // 1번 칸(가장 오래된 검사를 넣어 뒀다)에 가장 최근 검사가 오고, 마지막 prev 칸은 이미 소진돼 빈다.
  assert.deepEqual(hpPlanCells(screen, CTX).map((p) => p.prior?.study_uid),
                   ["u-a", "u-b", undefined]);
  assert.equal(hpRoundTripWarnings(screen, rev, CTX).length, 1);
});

test("⑤ 후보에 없는 검사(다른 환자 비교·Stack)는 저장하지 않고 알린다", () => {
  const snap = { ...SNAP, s: { r: 1, c: 2 },
                 panes: [{ studyUid: CUR, seriesNo: 1 }, { studyUid: "u-zz", seriesNo: 1 }] };
  const { screen, warnings } = hpCaptureScreen(snap, CTX);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /후보/);
  assert.equal(screen.cells[1].slot.kind, "current");   // 되찾을 수 없으므로 과거검사로 저장하지 않는다
});

test("⑤ 검사일을 모르면(anchor 깨짐) 기간 슬롯이 무너지지 않는다", () => {
  const ctx = { ...CTX, anchorDate: "" };
  const plan = hpPlanCells(screenOf([{ series: null, slot: { kind: "1m" } }]), ctx);
  assert.equal(plan[0].prior?.study_uid, "u-f");   // 하한·상한 없음 → 가장 최근(미래 포함)
});

/* ══════════ ⑥ 뷰어 저장 규칙의 기본값 ══════════ */

test("⑥ 뷰어에서 저장한 규칙은 '골라야 적용'이다 — 자동적용·우선적용 모두 기본 off", () => {
  const { screen } = hpCaptureScreen(SNAP, CTX);
  const r = hpRuleFromScreen({ name: "  내 배치  ", screen, modality: "ct" });
  assert.equal(r.name, "내 배치");
  assert.equal(r.modality, "CT");           // 대문자 정규화(매칭이 대문자 완전일치다)
  assert.equal(r.use_on_exam_open, false);  // ⚠ true 로 만들면 저장하는 순간 그 장비의 모든 검사가 바뀐다
  assert.equal(r.priority, false);          // 사양 6 '가장 우선 적용'은 언체크가 기본
  assert.equal(r.source, "viewer");
  assert.equal(r.body_part, "");            // 사양 3 은 자유 입력 — 헤더에서 추측하지 않는다
  assert.equal(r.screens?.length, 1);
});

test("⑥ 자동적용/우선적용은 켤 수 있다(체크박스가 있는 이유)", () => {
  const { screen } = hpCaptureScreen(SNAP, CTX);
  const r = hpRuleFromScreen({ name: "A", screen, useOnExamOpen: true, priority: true,
                               options: { cross_link: true, scout_image: true } });
  assert.equal(r.use_on_exam_open, true);
  assert.equal(r.priority, true);
  assert.equal(r.cross_link, true);
  assert.equal(r.scout_image, true);
  assert.equal(r.full_link, false);
});

/* ══════════ ⑦ 덮어쓰기·다중 모니터 ══════════ */

test("⑦ 같은 이름으로 저장하면 설정에서 넣은 매칭 조건을 보존하고 배치만 갱신한다", () => {
  const { screen } = hpCaptureScreen(SNAP, CTX);
  const base = {
    ...hpRuleFromScreen({ name: "흉부", screen }),
    id: "hp-old", body_part: "CHEST, LUNG", body_part_fields: ["study_desc"],
    projection: "PA", description: "설정에서 쓴 설명",
  };
  const next = hpRuleFromScreen({ name: "흉부", screen: { ...screen, s: { r: 1, c: 1 }, cells: [screen.cells[0]] }, base });
  assert.equal(next.id, "hp-old");
  assert.equal(next.body_part, "CHEST, LUNG");
  assert.deepEqual(next.body_part_fields, ["study_desc"]);
  assert.equal(next.projection, "PA");
  assert.equal(next.description, "설정에서 쓴 설명");
  assert.deepEqual(next.s, { r: 1, c: 1 });      // 배치는 갱신된다
});

test("⑦ 덮어써도 기존 체크박스(자동적용·우선·링크 4종)가 조용히 꺼지지 않는다", () => {
  // 실제로 났던 사고: Setting>행잉 에서 'Exam 열 때 HP 사용'과 '전체 링크'를 켜 둔 규칙을
  // 뷰어에서 같은 이름으로 배치만 다시 저장하면 체크박스가 전부 false 로 눌려
  // **자동 적용되던 프로토콜이 조용히 수동 전용**이 됐다.
  const { screen } = hpCaptureScreen(SNAP, CTX);
  const base = {
    ...hpRuleFromScreen({ name: "흉부 표준", screen }),
    use_on_exam_open: true, priority: true,
    full_link: true, full_scroll_sync: true, cross_link: true, scout_image: true,
  };
  // 호출자가 아무것도 지정하지 않으면 → base 값 유지
  const keep = hpRuleFromScreen({ name: "흉부 표준", screen, base });
  assert.equal(keep.use_on_exam_open, true, "자동 적용이 살아 있어야 한다");
  assert.equal(keep.priority, true);
  assert.deepEqual(
    [keep.full_link, keep.full_scroll_sync, keep.cross_link, keep.scout_image],
    [true, true, true, true]);
  // 명시하면 그 값으로 바뀐다(체크박스가 있는 이유) — HpMenu 는 기존 값을 프리필해 넘긴다
  const off = hpRuleFromScreen({ name: "흉부 표준", screen, base,
                                 useOnExamOpen: false, priority: false,
                                 options: { full_link: false, full_scroll_sync: true,
                                            cross_link: false, scout_image: false } });
  assert.equal(off.use_on_exam_open, false);
  assert.equal(off.priority, false);
  assert.deepEqual([off.full_link, off.full_scroll_sync, off.cross_link, off.scout_image],
                   [false, true, false, false]);
  // 새 규칙(base 없음)은 사양 6 그대로 전부 off 로 시작한다
  const fresh = hpRuleFromScreen({ name: "새 것", screen });
  assert.equal(fresh.use_on_exam_open, false);
  assert.equal(fresh.priority, false);
  // 뷰어 메뉴가 기존 규칙 값을 체크박스에 프리필하는가(안 하면 저장 순간 사용자가 모르게 바뀐다)
  const menu = readFileSync(new URL("../src/components/HpMenu.tsx", import.meta.url), "utf8");
  assert.match(menu, /findHpRuleByName\(rules, name\)/);
  assert.match(menu, /setAutoOpen\(dup \? dup\.use_on_exam_open !== false : false\)/);
});

test("⑦ 다른 모니터에서 저장하면 화면이 모니터별로 쌓인다(사양 4 다중 모니터)", () => {
  const a = hpCaptureScreen(SNAP, CTX).screen;                       // monitor 0
  const b = hpCaptureScreen({ ...SNAP, monitor: 2, s: { r: 1, c: 1 },
                              panes: [{ studyUid: CUR, seriesNo: 3 }] }, CTX).screen;
  const r1 = hpRuleFromScreen({ name: "두 화면", screen: a });
  const r2 = hpRuleFromScreen({ name: "두 화면", screen: b, base: r1 });
  assert.equal(r2.screens?.length, 2);
  assert.equal(pickHpScreen(r2, 0)?.cells.length, 4);
  assert.equal(pickHpScreen(r2, 2)?.cells.length, 1);
  // 모니터를 모르는 창(단일 모니터·일반 탭)은 첫 viewer 화면으로 폴백한다 — 아무것도 안 걸리면 '고장'으로 보인다
  assert.equal(pickHpScreen(r2, null)?.monitor, 0);
  assert.equal(pickHpScreen(r2, 7)?.monitor, 0);
  assert.equal(pickHpScreen({ screens: [] }, 0), null);
});

test("⑦ 같은 모니터를 다시 저장하면 화면 id 를 유지한 채 갈아끼운다", () => {
  const a = hpCaptureScreen(SNAP, CTX).screen;
  const merged = mergeHpScreen([{ ...a, id: "keep-me" }], { ...a, s: { r: 1, c: 1 }, cells: [a.cells[0]] });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "keep-me");
  assert.deepEqual(merged[0].s, { r: 1, c: 1 });
});

test("⑦ 목록 갱신 — 새 이름은 뒤에 붙고(드롭다운 하단), 같은 이름은 그 자리를 지킨다", () => {
  const { screen } = hpCaptureScreen(SNAP, CTX);
  const r1 = hpRuleFromScreen({ name: "가", screen });
  const r2 = hpRuleFromScreen({ name: "나", screen });
  const list = upsertHpRule(upsertHpRule([], r1), r2);
  assert.deepEqual(list.map((r) => r.name), ["가", "나"]);
  const again = upsertHpRule(list, hpRuleFromScreen({ name: " 가 ", screen }));
  assert.deepEqual(again.map((r) => r.name), ["가", "나"]);   // 자리 유지
  assert.equal(again[0].id, r1.id);                          // id 유지 — 설정 편집기가 id 로 추적한다
  assert.equal(findHpRuleByName(list, "나")?.id, r2.id);
  assert.equal(findHpRuleByName(list, "없음"), null);
  assert.equal(findHpRuleByName(list, "  "), null);
});
