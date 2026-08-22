/* 다중 모니터 Compare — 창 사이 스크롤·시네·Combine·Crosslink 동기 계약(2026-08-20 사용자 확정).
 *
 * 사용자 요구 원문:
 *  "다중모니터에서 Compare 로 비교영상을 옆 모니터에 열어서 Combine 실행 시, 두 모니터의 비교
 *   master·slave 모두 마우스로 스크롤이 동시에 진행하고, 자동 플레이 기능(삼각형 sec 조정 플레이
 *   버튼)과 Crosslink·AutoSync 기능이 서로 다른 모니터끼리도 Link 되고 Sync 되어 영상이 함께
 *   마우스 스크롤과 자동으로 넘길 수 있게 해줘."
 *
 * 순수 부분(메시지 만들기·기하 추리기)은 실제로 실행하고, 창을 띄워야만 확인되는 부분
 * (BroadcastChannel 왕복·React 상태)은 **배선 계약**을 소스에서 확인한다.
 *
 * 실행: node --test --experimental-strip-types frontend/tests/cmp_window_sync.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { geomOfInstance } from "../src/lib/cmpSync.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");
const v2 = src("src/pages/Viewer2D.tsx");
const mod = src("src/lib/cmpSync.ts");

test("기하 추리기 — nearestSlice 가 읽는 필드만, 부실하면 null", () => {
  const inst = {
    position: [1, 2, 3], orientation: [1, 0, 0, 0, 1, 0], pixel_spacing: [0.5, 0.5],
    rows: 512, cols: 512, frame_of_reference_uid: "1.2.3",
    sop_uid: "버려야 할 것", annotations: [1, 2, 3],
  };
  const g = geomOfInstance(inst);
  assert.deepEqual(Object.keys(g).sort(),
    ["cols", "frame_of_reference_uid", "orientation", "pixel_spacing", "position", "rows"],
    "주석 같은 무거운 필드는 싣지 않는다");
  assert.equal(g.frame_of_reference_uid, "1.2.3", "FoR 는 정합 판정에 필요하다");

  assert.equal(geomOfInstance(null), null);
  assert.equal(geomOfInstance({ position: [1, 2] }), null, "좌표가 부실하면 null(수신 측이 델타로)");
  assert.equal(geomOfInstance({ position: [1, 2, 3] }), null, "방향이 없어도 null");
});

test("에코 금지 — 자기 창이 보낸 것은 걸러진다", () => {
  assert.match(mod, /if \(m\.from && m\.from === selfName\(\)\) return;/,
    "이게 없으면 두 창이 서로의 스크롤에 반응하며 끝없이 밀어 댄다");
  assert.match(v2, /const cmpRemoteRef = useRef\(false\);/,
    "수신 처리 중에는 되쏘지 않도록 플래그가 필요하다");
  // step 의 방송은 원격 이동일 때 건너뛴다
  const i = v2.indexOf("const step = useCallback");
  const body = v2.slice(i, i + 4200);
  assert.match(body, /if \(!cmpRemoteRef\.current && cmpActiveRef\.current && xlinkRef\.current\.crosslink\)/,
    "원격에서 온 이동은 다시 방송하지 않는다");
});

test("시네를 따로 보내지 않는다 — 스크롤 한 종류가 마우스 휠도 자동 플레이도 나른다", () => {
  assert.ok(!/postCmpCine|kind: "cine"/.test(mod + v2),
    "창마다 타이머를 따로 돌리면 어긋난다(drift) — 마스터 tick 을 따르게 한다");
  // 시네가 step 을 부르는 구조가 유지되어야 이 설계가 성립한다
  assert.match(v2, /cineRef\.current = window\.setInterval\([\s\S]{0,300}step\(activePane, 1\)/,
    "자동 플레이는 step 을 주기적으로 부른다 — 그래서 step 의 방송만으로 함께 넘어간다");
});

test("수신 — 좌표 정합이 서면 좌표로, 아니면 같은 만큼 델타로", () => {
  const i = v2.indexOf("const applyRemoteScroll = useCallback");
  assert.ok(i > 0, "원격 스크롤 적용 함수를 찾지 못했다");
  const body = v2.slice(i, i + 1600);
  assert.match(body, /nearestSlice\(geom as InstanceNode, tp\.series\.instances\)/,
    "창 안에서 쓰는 정합 규칙(spatialSync)을 창 사이에도 그대로 쓴다");
  assert.match(body, /ti != null \? ti : \(\(\(tp\.index \+ delta\) % len\) \+ len\) % len/,
    "정합이 성립하지 않으면 델타 — 슬라이스 수가 달라도 자연스럽게 따라간다");
  assert.match(body, /instances\.length <= 1/, "1장짜리는 건너뛴다(창 안 규칙과 같다)");
});

test("수신 게이트 — 비교 창이고 Crosslink 가 켜졌을 때만 따라간다", () => {
  const i = v2.indexOf('case "scroll":');
  assert.ok(i > 0);
  const body = v2.slice(i, i + 400);
  assert.match(body, /if \(!cmpActiveRef\.current \|\| !xlinkRef\.current\.crosslink\) return;/,
    "일반 창까지 끌고 다니면 안 된다");
});

test("Combine — 옆 모니터 창도 같은 상태가 된다", () => {
  const i = v2.indexOf("const combineSeries = (remote = false)");
  assert.ok(i > 0, "combineSeries 가 원격 플래그를 받아야 한다");
  const body = v2.slice(i, i + 900);
  assert.match(body, /if \(!remote && cmpActiveRef\.current\) postCmpCombine\(!off\);/,
    "내가 누른 것만 방송한다(원격 수신으로 또 방송하면 무한 왕복)");
  assert.match(v2, /combineSeriesRef\.current\?\.\(true\)/, "수신 측은 원격 플래그로 실행한다");
});

test("Crosslink·AutoSync·SyncOther 가 창 사이로 전파된다", () => {
  // 토글(단축키)과 체크박스 두 곳 모두
  assert.ok((v2.match(/postCmpXlink\(/g) ?? []).length >= 4,
    "단축키·체크박스(툴바·패널)·비교 시작·hello 응답에서 모두 전파해야 한다");
  assert.match(v2, /case "xlink":[\s\S]{0,200}setXlink\(\(x\) => \(\{ \.\.\.x, \.\.\.m\.xlink \}\)\)/,
    "수신 창은 받은 플래그를 그대로 반영한다");
});

test("다중 모니터 비교 시작 때 동기를 켜고 알린다", () => {
  const i = v2.indexOf("const openCompare = async ()");
  const body = v2.slice(i, i + 2200);
  assert.match(body, /crosslink: true, auto_sync: true, sync_other: true/,
    "옆 모니터 비교도 인플레이스 비교와 같은 동기 상태로 시작한다");
  assert.match(body, /postCmpXlink\(cmpXl\)/, "슬레이브 창에도 알린다");
});

test("늦게 뜬 슬레이브 구제 — hello 로 상태를 다시 받아 간다", () => {
  assert.match(v2, /if \(new URLSearchParams\(window\.location\.search\)\.get\("cmprole"\)\) postCmpHello\(\);/,
    "슬레이브 창은 준비되면 인사한다(마스터가 켠 방송을 로드 중에 놓쳤을 수 있다)");
  assert.match(v2, /case "hello":[\s\S]{0,200}postCmpXlink\(xlinkRef\.current\)/,
    "마스터는 현재 동기 상태를 되돌려 준다");
});

test("전용 채널 — 환자 동기(sv_sync)와 섞지 않는다", () => {
  assert.match(mod, /new BroadcastChannel\("sv_cmp"\)/,
    "비교 동기는 초당 여러 번 오간다(시네) — 환자 전환 채널과 섞으면 서로를 방해한다");
  assert.match(mod, /typeof BroadcastChannel !== "undefined"/, "미지원 환경에서도 죽지 않는다");
});

/* ── 2026-08-22 전수 점검 ──────────────────────────────────────────────────
 * 두 뷰어 모두 옆 모니터에 비교 창을 띄운다(placeCompareSlaves). 그런데 창끼리의 동기는
 * SaintViewer 에만 있어, I-View 로 열면 M/S 가 따로 놀았다 — 사용자에겐 같은 'Compare' 다.
 * I-View 에는 좌표 정합(spatialSync)이 없어 델타로만 맞춘다. 그건 lib 가 이미 허용한다
 * (geom=null → '같은 만큼' 넘김). */

test("★ Compare 를 가진 **모든 뷰어**가 창끼리 동기한다", () => {
  const VIEWERS = {
    "SaintViewer/T-View(Viewer2D)": "src/pages/Viewer2D.tsx",
    "I-View(ViewerInfi)": "src/pages/ViewerInfi.tsx",
  };
  for (const [label, f] of Object.entries(VIEWERS)) {
    const t = src(f);
    assert.match(t, /from "\.\.\/lib\/cmpSync"/, `${label}: 같은 채널`);
    assert.match(t, /postCmpScroll\(/, `${label}: 스크롤을 알린다`);
    assert.match(t, /postCmpXlink\(/, `${label}: Crosslink 상태를 알린다`);
    assert.match(t, /postCmpCombine\(/, `${label}: Combine 을 알린다`);
    assert.match(t, /postCmpHello\(\)/, `${label}: 늦게 뜬 슬레이브 구제`);
    assert.match(t, /onCmpSync\(/, `${label}: 받는다`);
    // 에코 금지 — 없으면 두 창이 서로 밀며 끝없이 넘어간다
    assert.match(t, /cmpRemoteRef\.current/, `${label}: 원격 이동을 되쏘지 않는다`);
    // 수신 게이트 — 비교 창이 아니면 따라가지 않는다
    assert.match(t, /!cmpActiveRef\.current \|\| !xlinkRef\.current\.crosslink/,
      `${label}: 일반 창을 끌고 다니면 안 된다`);
  }
});

test("I-View 시네도 옆 모니터와 함께 넘어간다 — 창마다 타이머를 돌리지 않는다", () => {
  const inf = src("src/pages/ViewerInfi.tsx");
  const i = inf.indexOf("cineLast.current[k] = now");
  assert.ok(i > 0, "시네 틱을 찾지 못했다");
  assert.match(inf.slice(i, i + 700), /postCmpScroll\(step, null/,
    "시네가 스크롤과 같은 방송을 타야 마우스 휠·플레이가 한 규칙으로 움직인다");
});

