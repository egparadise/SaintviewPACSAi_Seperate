/* Search Favorite 조건 나열·저장 계약(2026-08-19 사용자 확정 · 2026-08-20 보정).
 *
 * 사용자 예시를 그대로 고정한다: `센터#MR#병원명#미판독`
 *   · 판독 상태(요청=미판독 / 확정=판독 / 판독중)를 조건으로 쓸 수 있다
 *   · 워크리스트 항목 구성의 **모든 값**을 조건으로 쓸 수 있다 — 사용자는 **값만** 쓴다
 *   · 토큰 사이는 AND (조건을 나열한 것이므로 전부 만족해야 한다)
 *   · 서버가 아는 것(status·modality)만 질의로, 나머지는 받은 목록에서 거른다
 *
 * ⚠ **`#` 은 문법이 아니다**(2026-08-20 사용자 확정) — 조건 사이를 끊는 구분자일 뿐이다.
 *   조건이 하나면 `#` 이 없다(`CT`). 그러니 `#` 유무로 Fav 검색을 판정하면 안 되고,
 *   판정은 검색창 **모드**(FAV)가 한다. `항목=값` 같은 문법도 사용자에게 요구하지 않는다.
 *
 * 실행: node --test --experimental-strip-types frontend/tests/search_fav_rule.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyFavFilter, clientCondsFor, matchesCond, parseFavQuery, readFavs, removeFav, upsertFav,
} from "../src/lib/searchFav.ts";
import { buildWorklistQuery, toLiveParams } from "../src/lib/worklistQuery.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");

test("사용자 예시 — 센터#MR#병원명#미판독 을 조건으로 갈라 읽는다", () => {
  const q = parseFavQuery("센터#MR#병원명#미판독");
  assert.equal(q.server.modality, "MR", "장비는 서버 필터로");
  assert.equal(q.server.status, "received", "미판독 = 요청(received)");
  assert.deepEqual(q.client.map((c) => c.value), ["센터", "병원명"], "나머지는 값 조건 AND");
  assert.ok(q.client.every((c) => c.field === ""), "사용자는 값만 쓴다 — 필드 지정 없음");
});

test("`#` 은 구분자일 뿐 — 조건이 하나면 없어도 그대로 읽는다", () => {
  const one = parseFavQuery("CT");
  assert.equal(one.server.modality, "CT", "`#` 없이 한 조건만 써도 인식한다");
  const free = parseFavQuery("Brain");
  assert.deepEqual(free.client, [{ field: "", value: "Brain" }]);
});

test("판독 상태 3종 — 요청(미판독)·판독중·확정(판독)", () => {
  assert.equal(parseFavQuery("요청").server.status, "received");
  assert.equal(parseFavQuery("미판독").server.status, "received");
  assert.equal(parseFavQuery("판독중").server.status, "reading");
  assert.equal(parseFavQuery("확정").server.status, "finalized");
  assert.equal(parseFavQuery("판독").server.status, "finalized");
});

test("항목 구성 전 컬럼 — 값만 써도 그 컬럼에서 찾는다(문법 없음)", () => {
  const q = parseFavQuery("대자인#조윤희");
  assert.deepEqual(q.client, [
    { field: "", value: "대자인" },
    { field: "", value: "조윤희" },
  ], "어느 항목인지는 프로그램이 알아본다 — 사용자가 `항목=값` 을 외우지 않는다");
  const rows = [
    { hospital_name: "대자인병원", assigned_doctor: "조윤희" },
    { hospital_name: "대자인병원", assigned_doctor: "김민수" },
  ];
  assert.equal(applyFavFilter(rows, q.client).length, 1, "서로 다른 컬럼의 값이어도 AND 로 좁힌다");
});

test("`=` 나 `:` 가 값에 섞여 있어도 문법으로 오해하지 않는다", () => {
  // 시각(10:30)·비율(1:2)·수식 표기가 조건에 섞이는 것은 흔하다
  assert.deepEqual(parseFavQuery("10:30").client, [{ field: "", value: "10:30" }]);
  assert.deepEqual(parseFavQuery("A=B").client, [{ field: "", value: "A=B" }]);
});

test("모달리티 별칭·빈 토큰·공백 — 흔한 입력을 관용적으로 받는다", () => {
  assert.equal(parseFavQuery("MRI").server.modality, "MR");
  assert.equal(parseFavQuery("PET").server.modality, "PT");
  assert.equal(parseFavQuery("ct").server.modality, "CT", "소문자도 인식");
  assert.deepEqual(parseFavQuery("##  ##").client, [], "빈 토큰은 버린다");
  assert.deepEqual(parseFavQuery("  CT  #  뇌 ").client.map((c) => c.value), ["뇌"], "앞뒤 공백 제거");
});

test("행 필터 — 토큰 사이는 AND, 값은 항목 전체와 대조한다", () => {
  const rows = [
    { patient_name: "김지숙", hospital_name: "대자인병원", center_name: "써밋영상의원", modality: "CT" },
    { patient_name: "이종만", hospital_name: "누리한방병원", center_name: "강남미래", modality: "CT" },
  ];
  assert.equal(applyFavFilter(rows, parseFavQuery("대자인").client).length, 1);
  assert.equal(applyFavFilter(rows, parseFavQuery("대자인#써밋").client).length, 1, "AND 로 좁힌다");
  assert.equal(applyFavFilter(rows, parseFavQuery("대자인#강남").client).length, 0, "둘 다 맞아야 한다");
  assert.equal(matchesCond(rows[0], { field: "", value: "" }), true, "빈 조건은 통과");
  assert.deepEqual(applyFavFilter(rows, []), rows, "조건이 없으면 원본 그대로");
});

test("판정은 모드가 한다 — `#` 유무를 보는 코드가 남아 있으면 안 된다", () => {
  const f = src("src/lib/searchFav.ts");
  const w = src("src/pages/Worklist.tsx");
  const q = src("src/lib/worklistQuery.ts");
  assert.ok(!/looksLikeFavQuery/.test(f + w + q),
    "`#` 유무로 Fav 를 판정하던 함수는 폐지됐다(조건이 하나면 `#` 이 없다)");
  assert.match(w, /searchModeRef\.current === "fav"/, "검색창 모드가 판정한다");
  assert.match(q, /if \(c\.favMode\) \{/, "FAV 모드면 서버 파라미터를 조건 나열용으로 바꾼다");
  assert.match(q, /p\.qop = "and"/, "토큰끼리는 AND");
});

test("`항목=값` 문법을 사용자에게 안내하지 않는다", () => {
  const w = src("src/pages/Worklist.tsx");
  assert.ok(!/항목=값/.test(w), "문법 안내가 남아 있으면 사용자가 외워야 할 것이 생긴다");
});

test("저장 목록 — 추가·같은 이름 덮어쓰기·삭제·깨진 값 방어", () => {
  let list = upsertFav([], { name: "미판독 MR", query: "MR#미판독" });
  assert.deepEqual(list, [{ name: "미판독 MR", query: "MR#미판독" }]);
  list = upsertFav(list, { name: "미판독 MR", query: "MR#미판독#대자인" });
  assert.equal(list.length, 1, "같은 이름은 덮어쓴다(수정)");
  assert.equal(list[0].query, "MR#미판독#대자인");
  list = upsertFav(list, { name: "  ", query: "x" });
  assert.equal(list.length, 1, "이름 없는 저장은 무시");
  list = upsertFav(list, { name: "확정 CT", query: "CT#확정" });
  assert.equal(list.length, 2);
  assert.deepEqual(removeFav(list, "미판독 MR").map((f) => f.name), ["확정 CT"]);
  // 저장소가 깨져 있어도 화면이 죽지 않는다
  assert.deepEqual(readFavs(null), []);
  assert.deepEqual(readFavs({ search_favs: "nope" }), []);
  assert.deepEqual(readFavs({ search_favs: [{ name: "a", query: "b" }, { bad: 1 }] }), [{ name: "a", query: "b" }]);
});

test("배선 — 워크리스트가 파서를 쓰고, 검색 UI 토글 7종이 뷰어별로 저장된다", () => {
  const w = src("src/pages/Worklist.tsx");
  assert.match(w, /parseFavQuery\(/, "검색 실행이 파서를 지난다");
  assert.match(w, /applyFavFilter\(/, "받은 목록에 클라이언트 조건 적용");
  assert.match(w, /export const SEARCH_UI_KEYS/, "표시 토글 키 목록(설정과 공유)");
  for (const k of ["favsearch", "rail_filter", "rail_favs", "rail_folder", "tb_shortcut", "tb_savefav", "tb_search"]) {
    assert.ok(w.includes(`"${k}"`), `토글 키 ${k}`);
  }
  const s = src("src/pages/SettingsModal.tsx");
  assert.match(s, /SEARCH_UI_KEYS/, "설정이 같은 키 목록을 쓴다(갈리지 않게)");
});

/* ── 실제 사고(2026-08-20): "CT#Brain 이 언제나 0건" ────────────────────────
 * 원문 식이 서버 검색어 q 로 그대로 나갔다. 서버 q 의 기본 범위는 pid·pname 뿐이라
 * (study_service 기본값) 환자 ID/이름에서 "CT#Brain" 을 찾다가 무조건 0건이 됐다.
 * 'CT' 단독은 modality 승격 덕에 되는 것처럼 보여 원인이 더 가려졌다. */

test("FAV — 토큰이 전 항목을 OR 로 훑고 토큰끼리 AND (서버가 처리)", () => {
  const q = buildWorklistQuery({ filters: { modality: "CT" }, searchText: "대자인병원#CT#CHEST", favMode: true });
  // 원문이 통째로 나가면 '#' 이 섞인 덩어리를 찾다가 언제나 0건이 된다(실제 사고)
  assert.ok(!q.q.includes("#"), "원문을 그대로 보내지 않는다");
  assert.equal(q.q, "대자인병원 CHEST", "장비는 전용 필터로 빠지고 나머지는 공백 구분 토큰");
  assert.equal(q.qop, "and", "토큰끼리 AND — 셋 다 어딘가에 있어야 한다");
  assert.ok(q.qf.split(",").includes("body_part"), "부위도 훑는 범위에");
  assert.ok(q.qf.split(",").includes("institution"), "기관(센터명)도");
  assert.ok(q.qf.split(",").includes("modality"), "장비도 — 순서·필드 지정 없이 통하려면 필요");
  assert.equal(q.modality, "CT", "장비는 정확 일치 필터로 좁힌다");

  // `#` 없는 한 조건도 같은 경로 — 이게 'CT 가 0건'이던 원인이다
  const one = buildWorklistQuery({ filters: { modality: "CT" }, searchText: "CT", favMode: true });
  assert.equal(one.q, "", "장비로 승격되면 남는 토큰이 없다");
  assert.equal(one.modality, "CT");
});

test("FAV — 상태만 예외로 별도 필터(텍스트로는 잡히지 않는 코드값)", () => {
  const q = buildWorklistQuery({ filters: { status: "received" }, searchText: "대자인병원#미판독", favMode: true });
  assert.equal(q.q, "대자인병원", "상태 낱말은 토큰에서 빠진다");
  assert.equal(q.status, "received", "status 필터로 따로 건다");
});

test("일반(비 FAV) 검색어는 종전대로 서버 q 로 나간다", () => {
  const q = buildWorklistQuery({ filters: {}, searchText: "김지숙" });
  assert.equal(q.q, "김지숙", "FAV 모드가 아니면 기존 통합 검색 그대로");
  assert.equal(q.qf, undefined, "범위·결합도 건드리지 않는다(사용자 설정 검색 범위가 그대로 쓰인다)");
  assert.equal(buildWorklistQuery({ filters: {}, searchText: "CT#Brain" }).q, "CT#Brain",
    "모드가 아니면 `#` 이 있어도 손대지 않는다 — 판정 축은 오직 모드다");
});

test("일반 모드에서는 받은 목록을 다시 거르지 않는다 — 이중 필터로 0건 되는 사고 방지", () => {
  const fav = parseFavQuery("대자인병원#CHEST");
  assert.deepEqual(clientCondsFor(fav, { liveMode: false }), [],
    "서버가 q·qf·qop 로 전부 걸렀다");
  assert.equal(clientCondsFor(fav, { liveMode: true }).length, 2,
    "Live 는 q 를 보내지 않으므로 여기서 전부 건다");
});

test("Live 는 조건 나열에서 q 를 A 로 보내지 않는다 — 누락 방지", () => {
  const p = buildWorklistQuery({ filters: { modality: "CT" }, searchText: "대자인병원#CT", favMode: true });
  const live = toLiveParams(p, { favMode: true });
  assert.equal(live.q, undefined,
    "A 의 study_search 범위를 우리가 정할 수 없다 — 보냈다가 못 찾으면 그 행은 아예 오지 않는다");
  assert.equal(live.modality, "CT", "장비·기간은 A 가 정확히 거를 수 있다");
  assert.equal(toLiveParams(p).q, "대자인병원", "FAV 가 아니면 종전대로 q 를 보낸다");
});

test("CT#Brain — 장비는 서버, 부위는 받은 목록에서 거른다", () => {
  const q = parseFavQuery("CT#Brain");
  assert.equal(q.server.modality, "CT");
  assert.deepEqual(q.client, [{ field: "", value: "Brain" }], "부위는 자유어 조건");
  const rows = [
    { modality: "CT", body_part: "Brain", patient_name: "김지숙" },
    { modality: "CT", body_part: "Chest", patient_name: "박용성" },
  ];
  const hit = applyFavFilter(rows, q.client);
  assert.equal(hit.length, 1, "행의 body_part 값으로 걸러진다");
  assert.equal(hit[0].body_part, "Brain");
});

test("조건이 하나여도(`CT`) FAV 검색으로 동작한다 — 실제 사고", () => {
  const q = parseFavQuery("CT");
  assert.equal(q.server.modality, "CT", "장비로 승격");
  assert.deepEqual(q.client, [], "남는 값 조건 없음 — 받은 목록을 그대로 보여 준다");
});

/* ── 사용자 확인 요청(2026-08-20): 판독센터·부위도 검색되는가 ────────────────── */

test("판독센터(써밋영상의원)·부위(Brain·Chest) — 행에 실린 값으로 걸러진다", () => {
  const rows = [
    { center_name: "써밋영상의원", body_part: "Brain", modality: "CT", patient_name: "김지숙" },
    { center_name: "강남미래", body_part: "Brain", modality: "CT", patient_name: "박용성" },
    { center_name: "써밋영상의원", body_part: "Chest", modality: "CT", patient_name: "이종만" },
  ];
  assert.equal(applyFavFilter(rows, parseFavQuery("써밋영상의원").client).length, 2, "센터 전체 이름");
  assert.equal(applyFavFilter(rows, parseFavQuery("써밋").client).length, 2, "일부만 써도 걸린다");
  assert.equal(applyFavFilter(rows, parseFavQuery("Brain").client).length, 2, "부위");
  assert.equal(applyFavFilter(rows, parseFavQuery("chest").client).length, 1, "대소문자 무관");
  // 조합 — 사용자 원 예시 형태
  const q = parseFavQuery("써밋영상의원#CT#Brain");
  assert.equal(q.server.modality, "CT", "장비는 서버가 좁힌다");
  assert.equal(applyFavFilter(rows, q.client).length, 1, "센터 AND 부위");
});

/* ── 실제 결함(2026-08-20): Live 에서 '미판독' 조건이 증발 ──────────────────
 * Live(원격 A 직결)는 status 파라미터 자체가 없다(LIVE_QUERY_KEYS). 그래서 상태를 서버로
 * 승격만 하고 끝내면 아무 데서도 걸러지지 않아, 미판독만 보려던 목록에 확정 검사가 섞였다. */

test("Live 에서는 상태 조건을 받은 목록에서 거른다 — 증발 금지", () => {
  const q = parseFavQuery("MR#미판독");
  assert.equal(q.server.status, "received");
  assert.deepEqual(q.client, [], "일반 모드에서는 서버가 걸러 준다");

  const live = clientCondsFor(q, { liveMode: true });
  assert.deepEqual(live, [{ field: "status", value: "received", exact: true }],
    "Live 는 status 를 못 보내므로 클라이언트 조건으로 되돌린다");

  const rows = [
    { status: "received", modality: "MR" },
    { status: "finalized", modality: "MR" },
    { status: "reading", modality: "MR" },
  ];
  assert.equal(applyFavFilter(rows, live).length, 1, "미판독만 남는다");
  assert.equal(applyFavFilter(rows, clientCondsFor(q, { liveMode: false })).length, 3,
    "일반 모드는 서버가 이미 걸렀으므로 여기서 또 거르지 않는다");
});

test("상태 코드는 정확히 일치해야 한다 — draft 가 draft_ready 에 걸리지 않게", () => {
  const rows = [{ status: "draft" }, { status: "draft_ready" }];
  assert.equal(applyFavFilter(rows, [{ field: "status", value: "draft", exact: true }]).length, 1);
  assert.equal(applyFavFilter(rows, [{ field: "status", value: "draft" }]).length, 2,
    "exact 가 아니면 종전처럼 부분 일치(자유어 조건의 기존 동작은 그대로)");
});
