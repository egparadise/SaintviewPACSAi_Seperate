/* 워크리스트 '수동 갱신' 계약 회귀 테스트 — lib/worklistQuery.ts 를 '실제로' 부른다.
 *
 * 지키는 계약(커밋 7c5d360 메시지 본문 = 기획 원문):
 *   · 기본 **수동** — SEARCH 를 눌러야만 갱신된다. Live 도 같은 규칙을 따른다.
 *   · 수동의 뜻은 '내가 SEARCH 를 누를 때만 바뀐다'.
 *
 * 그 계약의 코드상 표현이 committed(확정 조건)와 filters/searchText(입력 상태)의 분리다.
 * 조회 파라미터는 committed 에서만 만들어져야 한다 — 그래서 여기서는
 *   ① buildWorklistQuery 가 committed 스냅샷만 읽는지(입력 상태는 인자로 들어올 수조차 없다)
 *   ② 날짜 우선순위(tree_from > date_from_iso) 규칙
 *   ③ Live 는 지원 키만 넘어가는지 ("Live 도 같은 규칙")
 *   ④ isQueryDirty 가 '입력했지만 아직 SEARCH 안 누름' 을 정확히 판정하는지 (오탐 = 항상 빨간 점)
 * 를 검증한다.
 *
 * 실행: node frontend/tests/worklist_query.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorklistQuery,
  defaultStatusInjection,
  freshChangedVids,
  isQueryDirty,
  sameFilters,
  toLiveParams,
} from "../src/lib/worklistQuery.ts";

const VID_BASE = 90_000_000;   // api.ts 와 같은 값(순수 모듈이라 인자로 받는다)

test("① 조회 파라미터는 확정 조건(committed)에서만 만들어진다", () => {
  const committed = {
    filters: { pid: "P1", modality: "CT", status: "unread", tree_from: "" },
    searchText: "kim",
  };
  assert.deepEqual(buildWorklistQuery(committed), {
    q: "kim", pid: "P1", modality: "CT", status: "unread",
  });
  // 빈 값은 파라미터로 나가지 않는다(서버에 status= 같은 빈 필터가 가면 결과가 달라진다)
  assert.deepEqual(buildWorklistQuery({ filters: { pid: "", desc: "" }, searchText: "" }), { q: "" });
});

test("① 입력 상태를 섞어 넣을 수 있는 통로가 없다 — 인자는 committed 하나뿐", () => {
  // 회귀 방지: 예전 구현은 useMemo(..., [filters, searchText]) 라 타건마다 새 파라미터가 나왔다.
  // 순수 함수로 뺀 지금은 '무엇으로 조회하는가'가 인자 하나로 못 박혀 있다.
  assert.equal(buildWorklistQuery.length, 1);
});

test("② 날짜 우선순위 — 검색 폴더/기간 프리셋(tree_from)이 직접 입력 From 을 덮는다", () => {
  const q = buildWorklistQuery({
    filters: { date_from_iso: "2026-01-02", date_to_iso: "2026-03-04", tree_from: "20260701" },
    searchText: "",
  });
  assert.equal(q.date_from, "20260701", "폴더/프리셋이 이긴다");
  assert.equal(q.date_to, "20260304", "To 는 직접 입력이 그대로 남는다");
  // tree_from 이 없으면 직접 입력 From 이 ISO 하이픈을 떼고 그대로
  const q2 = buildWorklistQuery({ filters: { date_from_iso: "2026-01-02" }, searchText: "" });
  assert.equal(q2.date_from, "20260102");
});

test("③ Live 는 지원 키만 넘긴다 (나머지 필터는 원격에서 무시)", () => {
  const q = buildWorklistQuery({
    filters: { pid: "P1", pname: "홍", modality: "MR", status: "unread", finding: "nodule", tree_from: "20260101" },
    searchText: "abc",
  });
  const lp = toLiveParams(q);
  assert.deepEqual(lp, { q: "abc", pid: "P1", pname: "홍", modality: "MR", date_from: "20260101" });
  assert.equal("status" in lp, false, "Live 가 모르는 필터를 보내면 원격이 400 을 준다");
  assert.equal("finding" in lp, false);
});

test("④ isQueryDirty — 입력했지만 아직 커밋(SEARCH) 안 한 상태를 잡는다", () => {
  const committed = { filters: { modality: "CT" }, searchText: "kim" };
  // 같은 조건 → 깨끗함
  assert.equal(isQueryDirty(committed, { modality: "CT" }, "kim"), false);
  // 키 순서/빈 값 차이는 변경이 아니다(항상 빨간 점이 켜지면 표시가 무의미해진다)
  assert.equal(isQueryDirty(committed, { pid: "", modality: "CT", desc: "" }, " kim "), false);
  // 한 글자 타이핑 → 변경됨(그러나 목록은 그대로여야 한다 — 이 값은 '표시' 용도다)
  assert.equal(isQueryDirty(committed, { modality: "CT" }, "kimx"), true);
  // 셀렉트 변경 → 변경됨
  assert.equal(isQueryDirty(committed, { modality: "MR" }, "kim"), true);
  // 필터 제거 → 변경됨
  assert.equal(isQueryDirty(committed, {}, "kim"), true);
});

test("④ sameFilters — 빈 값 무시, 값이 다르면 다름", () => {
  assert.equal(sameFilters({ a: "1" }, { a: "1", b: "" }), true);
  assert.equal(sameFilters({ a: "1" }, { a: "2" }), false);
  assert.equal(sameFilters({}, {}), true);
});

/* ⑤ 설정 '기본 상태 필터' 재주입 규칙 — 양쪽으로 한 번씩 기울어 두 번 지적받은 자리다.
     같은 값 저장 = 미주입(사용자 필터 보존) / 다른 값 저장 = 주입(설정이 그 자리에서 먹는다). */
test("⑤ 아무것도 안 바꾸고 [저장] — 사용자의 상태필터를 덮지 않는다", () => {
  // 마지막으로 반영한 값과 같은 값이 다시 도착 → 주입 없음.
  // (여기서 주입하면 사용자가 카운트칩으로 골라 둔 '미판독' 이 병원 기본값으로 되돌아간다)
  assert.deepEqual(defaultStatusInjection("unread", "unread"), { inject: false, next: "unread" });
  assert.deepEqual(defaultStatusInjection("", ""), { inject: false, next: "" });
  assert.deepEqual(defaultStatusInjection("", undefined), { inject: false, next: "" },
    "미설정(undefined)과 '*Any'('') 는 같은 뜻 — 왕복할 때마다 주입되면 안 된다");
});

test("⑤ 설정에서 값을 실제로 바꿔 저장 — 그 자리에서 반영된다", () => {
  // '최초 1회만' 래치였을 때는 여기서 inject=false 가 되어, 새로고침 전까지 설정이 조용히 안 먹었다
  assert.deepEqual(defaultStatusInjection("unread", "finalized"), { inject: true, next: "finalized" });
  // 기본값을 '*Any' 로 되돌린 경우도 반영 대상이다(빈 값이라고 건너뛰면 되돌리기가 불가능해진다)
  assert.deepEqual(defaultStatusInjection("finalized", ""), { inject: true, next: "" });
  assert.deepEqual(defaultStatusInjection("finalized", null), { inject: true, next: "" });
});

test("⑤ 최초 로드(last=null) — 값이 있으면 주입, 없으면 '' 로 확정만", () => {
  assert.deepEqual(defaultStatusInjection(null, "unread"), { inject: true, next: "unread" });
  // null(못 읽음) 과 ""(*Any) 는 구분된다 — 최초 1회는 '' 라도 기준값을 못 박아 둬야
  // 다음 저장에서 ''→'' 가 변경으로 오탐되지 않는다
  assert.deepEqual(defaultStatusInjection(null, ""), { inject: true, next: "" });
});

/* ⑥ 다운로드 모드 무효화 대상 산출 — freshChangedVids
 *
 * 되돌리면(오프셋을 빼면 / 누적 목록을 통째로 넘기면) 아래가 즉시 깨진다.
 *  · 오프셋 누락: dlInvalidate 의 `ids.has(q.studyId)` 가 절대 참이 안 돼 **낡은 영상이 영원히 히트**한다.
 *  · 누적 통째: rev 가 오를 때마다 200건을 다시 폐기 → 폐기·재다운로드 폭주.
 */
test("⑥ A study_idx 를 워크리스트 행 id(vid)로 올려서 넘긴다", () => {
  const r = freshChangedVids(new Map(), [12345], VID_BASE);
  assert.deepEqual(r.vids, [90012345],
    "vid 로 올리지 않으면 스케줄러 큐의 studyId(90012345)와 절대 매칭되지 않는다");
});

test("⑥ 누적 목록에서 '새로 늘어난 것'만 넘긴다 — 폐기·재다운로드 폭주 방지", () => {
  const a = freshChangedVids(new Map(), [1, 2, 3], VID_BASE);
  assert.deepEqual(a.vids.sort(), [90000001, 90000002, 90000003]);
  // 다음 틱: 백엔드는 같은 목록에 4 만 덧붙여 준다(누적)
  const b = freshChangedVids(a.next, [1, 2, 3, 4], VID_BASE);
  assert.deepEqual(b.vids, [90000004], "이미 처리한 검사를 매 틱 다시 폐기하면 안 된다");
  // 아무 변화가 없으면 대상 0건
  assert.deepEqual(freshChangedVids(b.next, [1, 2, 3, 4], VID_BASE).vids, []);
});

test("⑥ 같은 검사가 다시 바뀌면 다시 폐기 대상이다 — '봤는가'(Set)로 비교하면 놓친다", () => {
  const a = freshChangedVids(new Map(), [7], VID_BASE);
  assert.deepEqual(a.vids, [90000007]);
  // A 에서 같은 검사의 픽셀이 또 교체됨 → 목록에 한 번 더 들어온다
  assert.deepEqual(freshChangedVids(a.next, [7, 7], VID_BASE).vids, [90000007],
    "두 번째 변경을 놓치면 그 검사만 낡은 영상으로 굳는다");
});

test("⑥ 목록이 없거나 비면 대상 0건(빈 호출로 무효화를 트리거하지 않는다)", () => {
  assert.deepEqual(freshChangedVids(new Map(), undefined, VID_BASE).vids, []);
  assert.deepEqual(freshChangedVids(new Map(), [], VID_BASE).vids, []);
});
