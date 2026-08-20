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
  applyFavFilter, matchesCond, parseFavQuery, readFavs, removeFav, upsertFav,
} from "../src/lib/searchFav.ts";
import { buildWorklistQuery } from "../src/lib/worklistQuery.ts";

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
  assert.match(q, /c\.favMode \? "" :/, "FAV 모드면 원문을 서버 검색어로 보내지 않는다");
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

test("FAV 모드면 원문을 서버 검색어로 보내지 않는다 — 0건 사고 방어", () => {
  const q = buildWorklistQuery({ filters: { modality: "CT" }, searchText: "CT#Brain", favMode: true });
  assert.equal(q.q, "", "원문이 q 로 새면 pid·pname 에서 찾다가 언제나 0건이다");
  assert.equal(q.modality, "CT", "서버가 아는 축(장비)은 필터로 좁힌다");
  // `#` 없는 한 조건도 마찬가지 — 이게 'CT 가 0건'이던 원인이다
  assert.equal(buildWorklistQuery({ filters: { modality: "CT" }, searchText: "CT", favMode: true }).q, "");
});

test("일반(비 FAV) 검색어는 종전대로 서버 q 로 나간다", () => {
  const q = buildWorklistQuery({ filters: {}, searchText: "김지숙" });
  assert.equal(q.q, "김지숙", "FAV 모드가 아니면 기존 통합 검색 그대로");
  assert.equal(buildWorklistQuery({ filters: {}, searchText: "CT#Brain" }).q, "CT#Brain",
    "모드가 아니면 `#` 이 있어도 손대지 않는다 — 판정 축은 오직 모드다");
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
