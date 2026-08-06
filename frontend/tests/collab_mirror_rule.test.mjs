/* 협진 화면 미러링 규칙 — lib/collabState.ts 를 **실제로** 부른다.
 *
 * 이 코덱이 협진 기능의 심장이다. 여기가 틀리면 Slave 화면이 Master 와 달라지는데,
 * 판독에서 "다른 화면을 같은 화면이라고 믿는 것"은 오진 경로다. 그래서 규칙을 못박는다:
 *   ① 시리즈는 **uid 로만** 보낸다(SeriesNode 통째로 보내면 인스턴스 수백 개가 매 프레임 나간다)
 *   ② 정지 화면이면 아무것도 보내지 않는다(sameSnapshot)
 *   ③ 못 찾은 시리즈는 **이전 값을 유지**한다(빈 화면 깜빡임 금지)
 *   ④ 룸 키 형식은 백엔드(collab_service.dm_room)와 한 글자도 다르면 안 된다
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPane, colorOf, dmRoom, encodeSnapshot, makeThrottle, mergeAnno, removeAnno,
  sameSnapshot, sessionRoom,
} from "../src/lib/collabState.ts";

const pane = (over = {}) => ({
  studyUid: "1.2.3", series: { series_uid: "S1" }, index: 5,
  zoom: 1.5, tx: 10, ty: -4, rot: 90,
  flipH: false, flipV: true, invert: false,
  wl: "40,400", fx: "", shutter: null,
  ...over,
});

const source = (over = {}) => ({
  studyId: 7, layout: "2x2",
  panes: { p0: pane(), p1: pane({ series: null, index: 0 }) },
  activePane: "p0", selSeries: "S1", maximized: null,
  colFr: [1, 1], rowFr: [1, 1],
  ...over,
});

/* ── ① 시리즈는 uid 로만 나간다 ── */
test("encodeSnapshot — SeriesNode 를 통째로 싣지 않고 series_uid 만 보낸다", () => {
  const big = { series_uid: "S1", instances: new Array(500).fill({ sop_uid: "x" }) };
  const snap = encodeSnapshot(source({ panes: { p0: pane({ series: big }) } }));
  assert.equal(snap.panes.p0.s, "S1");
  const json = JSON.stringify(snap);
  assert.ok(!json.includes("sop_uid"), "인스턴스가 페이로드에 새어 나갔다");
  assert.ok(json.length < 800, `스냅샷이 너무 크다(${json.length}B) — 초당 10회 나간다`);
});

test("encodeSnapshot — 빈 페인은 s:'' 로 나가고 수신 측에서 null 이 된다", () => {
  const snap = encodeSnapshot(source());
  assert.equal(snap.panes.p1.s, "");
  const applied = applyPane(pane(), snap.panes.p1, () => ({ series_uid: "무관" }));
  assert.equal(applied.series, null, "빈 페인인데 시리즈가 붙었다");
});

/* ── ② 정지 화면이면 트래픽 0 ── */
test("sameSnapshot — 상태가 그대로면 같다고 판정한다(정지 화면 트래픽 0)", () => {
  assert.ok(sameSnapshot(encodeSnapshot(source()), encodeSnapshot(source())));
});

test("sameSnapshot — 줌이 실제로 바뀌면 다르다고 판정한다", () => {
  const a = encodeSnapshot(source());
  const b = encodeSnapshot(source({ panes: { p0: pane({ zoom: 2 }), p1: pane({ series: null }) } }));
  assert.ok(!sameSnapshot(a, b));
});

test("sameSnapshot — 사람이 못 알아보는 소수점 차이는 같다고 본다", () => {
  // 이게 없으면 마우스가 멈춰 있어도 부동소수 잡음으로 매 렌더 '변경됨' 이 되어 계속 쏜다
  const a = encodeSnapshot(source({ panes: { p0: pane({ zoom: 1.5000001 }), p1: pane({ series: null }) } }));
  const b = encodeSnapshot(source({ panes: { p0: pane({ zoom: 1.5000002 }), p1: pane({ series: null }) } }));
  assert.ok(sameSnapshot(a, b), "소수 3자리 절단이 동작하지 않는다");
});

test("sameSnapshot — null 취급", () => {
  assert.ok(sameSnapshot(null, null));
  assert.ok(!sameSnapshot(encodeSnapshot(source()), null));
});

/* ── ③ 못 찾은 시리즈는 이전 값 유지 ── */
test("applyPane — 트리에 없는 시리즈는 이전 것을 유지한다(빈 화면 깜빡임 금지)", () => {
  const prev = pane();
  const snap = encodeSnapshot(source({ panes: { p0: pane({ series: { series_uid: "아직없음" } }) } }));
  const out = applyPane(prev, snap.panes.p0, () => null);   // 아직 로드 안 된 트리
  assert.deepEqual(out.series, prev.series, "못 찾았다고 화면을 비우면 안 된다");
});

test("applyPane — 찾으면 그 시리즈로 교체하고 시각 상태를 그대로 옮긴다", () => {
  const target = { series_uid: "S9" };
  const snap = encodeSnapshot(source({
    panes: { p0: pane({ series: target, zoom: 3, rot: 180, invert: true, wl: "0,1" }) },
  }));
  const out = applyPane(pane(), snap.panes.p0, (uid) => (uid === "S9" ? target : null));
  assert.equal(out.series, target);
  assert.equal(out.zoom, 3);
  assert.equal(out.rot, 180);
  assert.equal(out.invert, true);
  assert.equal(out.wl, "0,1");
});

/* ── ④ 룸 키는 백엔드와 한 글자도 다르면 안 된다 ── */
test("dmRoom — 작은 id 가 앞. 방향이 달라도 같은 방이어야 한다", () => {
  assert.equal(dmRoom(7, 3), "dm:3:7");
  assert.equal(dmRoom(3, 7), dmRoom(7, 3), "A→B 와 B→A 가 다른 방이 되면 대화가 갈린다");
});

test("sessionRoom — sess:<code>", () => {
  assert.equal(sessionRoom("abc123"), "sess:abc123");
});

/* ── 스로틀 — 드래그 중에도 '마지막 상태'가 반드시 도착해야 한다 ── */
test("makeThrottle — 첫 호출은 즉시(leading), 마지막 값은 반드시 도착(trailing)", async () => {
  const got = [];
  const th = makeThrottle((v) => got.push(v), 30);
  th.push("a");
  assert.deepEqual(got, ["a"], "첫 값이 지연되면 반응이 굼떠 보인다");
  th.push("b"); th.push("c"); th.push("d");
  assert.deepEqual(got, ["a"], "연속 호출이 그대로 다 나가면 스로틀이 아니다");
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(got, ["a", "d"], "드래그를 멈춘 최종 위치가 유실됐다");
});

test("makeThrottle — flush 는 대기분을 즉시 내보낸다", () => {
  const got = [];
  const th = makeThrottle((v) => got.push(v), 1000);
  th.push("x"); th.push("y");
  th.flush();
  assert.deepEqual(got, ["x", "y"]);
});

test("makeThrottle — cancel 은 대기분을 버린다(끝난 세션에 프레임이 새지 않게)", async () => {
  const got = [];
  const th = makeThrottle((v) => got.push(v), 20);
  th.push("1"); th.push("2");
  th.cancel();
  await new Promise((r) => setTimeout(r, 45));
  assert.deepEqual(got, ["1"], "세션을 나간 뒤에도 상태가 나갔다");
});

/* ── 참가자 색 — 커서와 비디오 테두리가 같은 색이어야 누가 누구인지 안다 ── */
test("colorOf — 같은 id 는 항상 같은 색, 음수 id 도 안전", () => {
  assert.equal(colorOf(3), colorOf(3));
  assert.ok(colorOf(-1).startsWith("#"), "음수 id 에서 undefined 가 나오면 테두리가 사라진다");
  assert.ok(colorOf(0) !== colorOf(1));
});

/* ── 세션 주석 병합 — 다학제에서 여러 명이 동시에 그린 것을 한 목록으로 ── */
const anno = (id, by, over = {}) => ({
  id, by, kind: "arrow", points: [[0.1, 0.1], [0.2, 0.2]], text: "fibrosis", ...over,
});

test("mergeAnno — 새 id 는 추가, 같은 id 는 교체(add 재전송에도 중복되지 않는다)", () => {
  let list = [];
  list = mergeAnno(list, anno("s1", 7));
  list = mergeAnno(list, anno("s2", 9));
  assert.equal(list.length, 2);
  list = mergeAnno(list, anno("s1", 7, { text: "고침" }));
  assert.equal(list.length, 2, "같은 id 가 두 번 들어갔다");
  assert.equal(list.find((a) => a.id === "s1").text, "고침");
});

test("mergeAnno — 원본 배열을 건드리지 않는다(React state 로 쓰므로 불변이어야 한다)", () => {
  const before = [anno("s1", 7)];
  const after = mergeAnno(before, anno("s2", 9));
  assert.equal(before.length, 1, "입력 배열이 변형됐다 — 화면이 안 갱신된다");
  assert.notEqual(before, after);
});

test("mergeAnno — 서로 다른 사람의 주석이 함께 남는다(동시 작업의 핵심)", () => {
  let list = [];
  for (const [id, by] of [["s1", 7], ["s2", 9], ["s3", 11]]) list = mergeAnno(list, anno(id, by));
  assert.deepEqual(list.map((a) => a.by), [7, 9, 11]);
  // 각자 다른 색이어야 누가 그렸는지 구분된다
  const colors = new Set(list.map((a) => colorOf(a.by)));
  assert.equal(colors.size, 3, "세 사람의 주석 색이 겹친다 — 누가 그렸는지 구분이 안 된다");
});

test("removeAnno — 그 id 만 빠지고 나머지는 그대로", () => {
  const list = [anno("s1", 7), anno("s2", 9), anno("s3", 7)];
  const out = removeAnno(list, "s2");
  assert.deepEqual(out.map((a) => a.id), ["s1", "s3"]);
  assert.equal(list.length, 3, "입력 배열이 변형됐다");
  assert.deepEqual(removeAnno(list, "없는id").map((a) => a.id), ["s1", "s2", "s3"]);
});

/* ── 영상 팝아웃 — 창 재사용·스트림 추적·정리 규칙 (lib/collabPopout.ts) ──
   창을 여는 것은 브라우저 일이지만, **어떤 창을 언제 재사용/정리하는가** 는 순수 규칙이라
   여기서 고정한다. 이게 틀리면 (a) 같은 사람 창이 여러 개 뜨거나 (b) 환자 화면이 떠 있는
   창이 세션 종료 후에도 남는다(공용 판독 PC 에서는 PHI 노출이다). */
const { closeAllPopouts, closePopout, isPopoutOpen, popoutStream, syncPopout } =
  await import("../src/lib/collabPopout.ts");

/** window.open 을 대신하는 가짜 창 — document.write/getElementById 만 흉내 낸다 */
function fakeWindowFactory(opened) {
  return (_url, name, features) => {
    const video = { srcObject: null, play: () => Promise.resolve() };
    const cap = { textContent: "" };
    const win = {
      name, features, closed: false,
      focused: 0,
      document: {
        open() {}, close() {}, write() {},
        getElementById: (id) => (id === "v" ? video : cap),
      },
      focus() { this.focused++; },
      close() { this.closed = true; },
      addEventListener() {},
    };
    opened.push(win);
    return win;
  };
}

function withFakeWindow(fn) {
  const opened = [];
  const g = globalThis;
  const prev = g.window;
  g.window = { open: fakeWindowFactory(opened), addEventListener() {} };
  try { fn(opened); } finally { g.window = prev; closeAllPopouts(); }
}

test("popoutStream — 스트림이 없으면 창을 열지 않는다", () => {
  withFakeWindow((opened) => {
    assert.equal(popoutStream("7", null, "이순신"), false);
    assert.equal(opened.length, 0, "빈 창이 떴다");
  });
});

test("popoutStream — 같은 대상을 다시 누르면 새 창이 아니라 기존 창을 앞으로", () => {
  withFakeWindow((opened) => {
    const s1 = { id: "s1" };
    assert.equal(popoutStream("7", s1, "이순신"), true);
    assert.equal(opened.length, 1);
    assert.equal(popoutStream("7", s1, "이순신"), true);
    assert.equal(opened.length, 1, "같은 사람 창이 두 개 떴다");
    assert.equal(opened[0].focused, 1, "기존 창을 앞으로 가져오지 않았다");
  });
});

test("popoutStream — 사람이 다르면 창도 따로", () => {
  withFakeWindow((opened) => {
    popoutStream("7", { id: "a" }, "A");
    popoutStream("9", { id: "b" }, "B");
    assert.equal(opened.length, 2);
    assert.ok(opened[0].name !== opened[1].name, "창 이름이 같아 서로 덮어쓴다");
  });
});

test("popoutStream — 화면 공유를 껐다 켜면 새 트랙으로 갈아 끼운다", () => {
  withFakeWindow((opened) => {
    const before = { id: "before" }, after = { id: "after" };
    popoutStream("7", before, "이순신");
    const video = opened[0].document.getElementById("v");
    assert.equal(video.srcObject, before);
    popoutStream("7", after, "이순신");          // 재클릭
    assert.equal(video.srcObject, after, "옛 스트림(검은 화면)에 그대로 붙어 있다");
  });
});

test("syncPopout — 열린 창만 따라가고, 스트림이 끊기면 창을 닫는다", () => {
  withFakeWindow((opened) => {
    const s = { id: "s" };
    popoutStream("7", s, "이순신");
    const next = { id: "next" };
    syncPopout("7", next);
    assert.equal(opened[0].document.getElementById("v").srcObject, next);
    syncPopout("7", null);                       // 상대가 공유 중지
    assert.equal(opened[0].closed, true, "검은 창이 남았다");
    assert.equal(isPopoutOpen("7"), false);
  });
});

test("syncPopout — 열린 적 없는 대상은 창을 만들지 않는다(자동 팝업 금지)", () => {
  withFakeWindow((opened) => {
    syncPopout("42", { id: "x" });
    assert.equal(opened.length, 0, "사용자가 누르지도 않았는데 창이 떴다");
  });
});

test("closeAllPopouts — 세션 종료 시 전부 닫힌다(PHI 가 뜬 창을 남기지 않는다)", () => {
  withFakeWindow((opened) => {
    popoutStream("1", { id: "a" }, "A");
    popoutStream("2", { id: "b" }, "B");
    closeAllPopouts();
    assert.deepEqual(opened.map((w) => w.closed), [true, true]);
    assert.equal(isPopoutOpen("1"), false);
    assert.equal(isPopoutOpen("2"), false);
  });
});

test("closePopout — 사용자가 창을 직접 닫았어도 상태가 정리된다", () => {
  withFakeWindow((opened) => {
    popoutStream("7", { id: "a" }, "A");
    opened[0].closed = true;                     // 사용자가 ✕ 로 닫음
    assert.equal(isPopoutOpen("7"), false, "닫힌 창을 열린 것으로 본다");
    closePopout("7");                            // 이미 닫힌 창에도 안전해야 한다
  });
});
