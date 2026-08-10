/* 협진 공유 표면 규칙 — lib/collabSurface.ts 를 **실제로** 부른다.
 *
 * 여기 있는 규칙은 전부 화면만 봐서는 틀린 줄 모르는 것들이다:
 *   ① 창 크기가 서로 달라도 **같은 프레임 좌표**가 나와야 한다
 *      (자기 창에서는 언제나 맞아 보인다 — 남의 창에서 어긋난다)
 *   ② 검은 여백(레터박스)에 마크가 찍히면 안 된다 — 아무 데도 안 가리키는 마크가 된다
 *   ③ '전환'(검사·시리즈·레이아웃)과 '움직임'(팬·줌·W-L)을 구분해야 한다
 *      전환을 놓치면 서로 다른 검사를 같은 것으로 믿고 논의한다(오진 경로)
 *      움직임까지 전환으로 보면 팬 한 번에 전원이 끌려가 아무도 작업을 못 한다
 *   ④ 표면이 섞이면 화이트보드 낙서가 DICOM 영상 위로 쏟아진다
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  LASER_TTL, clearSurface, frameBox, fromFrame, laserAlpha, navKey,
  onSurface, pruneLaser, surfaceOf, toFrame,
} from "../src/lib/collabSurface.ts";

const snap = (over = {}) => ({
  v: 1, study: 7, layout: "2x2",
  panes: {
    p0: { u: "1.2.3", s: "S1", i: 5, z: 1, x: 0, y: 0, r: 0,
          fh: false, fv: false, iv: false, wl: "40,400", fx: "", sh: null },
    p1: { u: "1.2.3", s: "S2", i: 0, z: 1, x: 0, y: 0, r: 0,
          fh: false, fv: false, iv: false, wl: "40,400", fx: "", sh: null },
  },
  active: "p0", sel: "S1", max: null,
  ...over,
});
const withPane = (pid, over) => {
  const s = snap();
  s.panes[pid] = { ...s.panes[pid], ...over };
  return s;
};

/* ── ① 창 크기가 달라도 같은 지점을 가리킨다 (이 기능의 급소) ── */

test("frameBox — 16:9 영상을 4:3 박스에 넣으면 위아래에 레터박스가 생긴다", () => {
  // 800×600 박스에 1920×1080 영상 → scale = min(800/1920, 600/1080) = 0.41666
  const b = frameBox(800, 600, 1920, 1080);
  assert.equal(Math.round(b.w), 800);
  assert.equal(Math.round(b.h), 450);
  assert.equal(Math.round(b.x), 0);
  assert.equal(Math.round(b.y), 75);          // (600-450)/2 — 위아래 75px 검은 여백
});

test("frameBox — 4:3 영상을 와이드 박스에 넣으면 좌우에 레터박스가 생긴다", () => {
  const b = frameBox(1600, 600, 1024, 768);   // scale = 600/768
  assert.equal(Math.round(b.h), 600);
  assert.equal(Math.round(b.w), 800);
  assert.equal(Math.round(b.x), 400);
  assert.equal(Math.round(b.y), 0);
});

test("toFrame — 창 크기가 서로 달라도 같은 프레임 좌표가 나온다 (핵심 계약)", () => {
  // 같은 1920×1080 화면 공유를 A 는 800×600, B 는 1280×900 창으로 본다.
  const A = frameBox(800, 600, 1920, 1080);
  const B = frameBox(1280, 900, 1920, 1080);

  // A 가 자기 창에서 영상의 정중앙을 클릭
  const aCenter = toFrame(A.x + A.w / 2, A.y + A.h / 2, A);
  // B 창에서 그 프레임 좌표가 놓이는 자리
  const [bx, by] = fromFrame(aCenter[0], aCenter[1], B);
  const bBack = toFrame(bx, by, B);

  assert.ok(Math.abs(aCenter[0] - 0.5) < 1e-9 && Math.abs(aCenter[1] - 0.5) < 1e-9);
  assert.ok(Math.abs(bBack[0] - aCenter[0]) < 1e-9, "창 크기가 다르면 다른 곳을 가리킨다");
  assert.ok(Math.abs(bBack[1] - aCenter[1]) < 1e-9);
  // B 창에서의 실제 픽셀 위치도 그 창 기준 정중앙이어야 한다
  assert.ok(Math.abs(bx - (B.x + B.w / 2)) < 1e-9);
});

test("toFrame ↔ fromFrame — 왕복이 항등이다", () => {
  const b = frameBox(1000, 700, 1920, 1080);
  for (const [fx, fy] of [[0, 0], [1, 1], [0.25, 0.8], [0.5, 0.5]]) {
    const [ex, ey] = fromFrame(fx, fy, b);
    const back = toFrame(ex, ey, b);
    assert.ok(Math.abs(back[0] - fx) < 1e-9 && Math.abs(back[1] - fy) < 1e-9,
              `왕복 실패 ${fx},${fy}`);
  }
});

/* ── ② 검은 여백에는 찍히지 않는다 ── */

test("toFrame — 레터박스 여백을 클릭하면 null (아무 데도 안 가리키는 마크 금지)", () => {
  const b = frameBox(800, 600, 1920, 1080);   // 위아래 75px 여백
  assert.equal(toFrame(400, 10, b), null, "위쪽 검은 여백에 마크가 생겼다");
  assert.equal(toFrame(400, 590, b), null, "아래쪽 검은 여백에 마크가 생겼다");
  assert.notEqual(toFrame(400, 300, b), null, "영상 한가운데인데 거부됐다");
});

test("toFrame(clamp) — 드래그 중 손이 여백으로 나가도 획이 끊기지 않는다", () => {
  const b = frameBox(800, 600, 1920, 1080);
  const p = toFrame(400, -50, b, true);
  assert.deepEqual(p, [0.5, 0], "clamp 인데 null 이 나오거나 범위를 벗어났다");
  assert.deepEqual(toFrame(-100, 9999, b, true), [0, 1]);
});

test("frameBox — 영상 크기를 아직 모르면 element 전체 (호출부가 그리기를 막는다)", () => {
  assert.deepEqual(frameBox(800, 600, 0, 0), { x: 0, y: 0, w: 800, h: 600 });
  // element 조차 없으면 0 — toFrame 이 null 을 내어 아무것도 안 그려진다
  assert.deepEqual(frameBox(0, 0, 1920, 1080), { x: 0, y: 0, w: 0, h: 0 });
  assert.equal(toFrame(0, 0, frameBox(0, 0, 1920, 1080)), null);
});

/* ── ③ '전환' 과 '움직임' 을 가른다 ── */

test("navKey — 팬·줌·W-L·슬라이스는 전환이 아니다 (전원을 끌어오면 안 된다)", () => {
  const base = navKey(snap());
  for (const [k, v] of [["z", 3], ["x", 120], ["y", -40], ["r", 90],
                        ["wl", "80,800"], ["i", 42], ["iv", true], ["fx", "sharpen"]]) {
    assert.equal(navKey(withPane("p0", { [k]: v })), base,
                 `${k} 변경이 '전환'으로 판정됐다 — 팬 한 번에 전원이 끌려간다`);
  }
  // 활성 페인만 바뀐 것도 전환이 아니다
  assert.equal(navKey(snap({ active: "p1" })), base);
});

test("navKey — 검사·시리즈·레이아웃·최대화는 전환이다 (전원을 끌어와야 한다)", () => {
  const base = navKey(snap());
  assert.notEqual(navKey(snap({ study: 9 })), base, "검사 전환을 놓쳤다");
  assert.notEqual(navKey(snap({ layout: "1x1" })), base, "레이아웃 전환을 놓쳤다");
  assert.notEqual(navKey(snap({ max: "p0" })), base, "최대화를 놓쳤다");
  assert.notEqual(navKey(withPane("p1", { s: "S9" })), base, "시리즈 전환을 놓쳤다");
  assert.notEqual(navKey(withPane("p1", { u: "9.9.9" })), base, "페인 검사 전환을 놓쳤다");
});

test("navKey — 페인 키 순서가 달라도 같은 값 (Object 순서에 의존하지 않는다)", () => {
  const a = snap();
  const b = { ...a, panes: { p1: a.panes.p1, p0: a.panes.p0 } };
  assert.equal(navKey(b), navKey(a));
  assert.equal(navKey(null), "");
});

/* ── ④ 표면이 섞이지 않는다 ── */

test("surfaceOf — surface 가 없으면 pane (구버전 클라이언트 호환)", () => {
  assert.equal(surfaceOf({}), "pane");
  assert.equal(surfaceOf(undefined), "pane");
  assert.equal(surfaceOf({ surface: "wb" }), "wb");
  assert.equal(surfaceOf({ surface: "screen" }), "screen");
  assert.equal(surfaceOf({ surface: "구라" }), "pane", "모르는 값은 pane 으로 떨어져야 한다");
});

test("onSurface — 화이트보드·화면 마크가 뷰포트 목록에 새지 않는다", () => {
  // ⚠ 이게 깨지면 Viewer2D 의 sop_uid 필터를 통과해 DICOM 영상 위로 쏟아진다
  const list = [
    { id: "1", sop_uid: "A" },                       // 구버전 = pane
    { id: "2", surface: "pane", sop_uid: "A" },
    { id: "3", surface: "wb" },                      // sop_uid 없음
    { id: "4", surface: "screen" },                  // sop_uid 없음
  ];
  assert.deepEqual(onSurface(list, "pane").map((a) => a.id), ["1", "2"]);
  assert.deepEqual(onSurface(list, "wb").map((a) => a.id), ["3"]);
  assert.deepEqual(onSurface(list, "screen").map((a) => a.id), ["4"]);
});

test("clearSurface — 공유를 껐다 켜면 그 표면만 비운다", () => {
  const list = [{ id: "1", surface: "pane" }, { id: "2", surface: "screen" },
                { id: "3", surface: "wb" }];
  assert.deepEqual(clearSurface(list, "screen").map((a) => a.id), ["1", "3"]);
});

/* ── ⑤ 레이저 수명 ── */

test("pruneLaser — 만료된 레이저만 사라지고 핀·일반 마크는 남는다", () => {
  const now = 100_000;
  const list = [
    { id: "laser-old", life: "laser", at: now - LASER_TTL - 1 },
    { id: "laser-new", life: "laser", at: now - 500 },
    { id: "pinned", life: "pin", at: now - 999_999 },
    { id: "plain", at: now - 999_999 },
  ];
  assert.deepEqual(pruneLaser(list, now).map((a) => a.id),
                   ["laser-new", "pinned", "plain"]);
});

test("pruneLaser — at 이 없는 레이저는 지우지 않는다 (조용히 사라지는 것이 더 나쁘다)", () => {
  const list = [{ id: "x", life: "laser" }];
  assert.deepEqual(pruneLaser(list, 1e12).map((a) => a.id), ["x"]);
});

test("laserAlpha — 방금 1, 절반이면 0.5, 만료 후 0 이하로 안 내려간다", () => {
  const now = 50_000;
  assert.equal(laserAlpha({ life: "laser", at: now }, now), 1);
  assert.ok(Math.abs(laserAlpha({ life: "laser", at: now - LASER_TTL / 2 }, now) - 0.5) < 1e-9);
  assert.equal(laserAlpha({ life: "laser", at: now - LASER_TTL * 5 }, now), 0);
  assert.equal(laserAlpha({ life: "pin", at: 0 }, now), 1, "핀은 흐려지면 안 된다");
});
