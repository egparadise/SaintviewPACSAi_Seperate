/* Search Favorite 문법·저장 계약(2026-08-19 사용자 확정).
 *
 * 사용자 예시를 그대로 고정한다: `센터#MR#병원명#미판독`
 *   · 판독 상태(요청=미판독 / 확정=판독 / 판독중)를 조건으로 쓸 수 있다
 *   · 워크리스트 항목 구성의 **모든 값**을 조건으로 쓸 수 있다(명시형 `필드=값`)
 *   · 토큰 사이는 AND (조건을 나열한 것이므로 전부 만족해야 한다)
 *   · 서버가 아는 것(status·modality)만 질의로, 나머지는 받은 목록에서 거른다
 *
 * 실행: node --test --experimental-strip-types frontend/tests/search_fav_rule.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyFavFilter, looksLikeFavQuery, matchesCond, parseFavQuery, readFavs, removeFav, upsertFav,
} from "../src/lib/searchFav.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");

const LABELS = { "병원명 (의뢰병원)": "hospital_name", "센터명 (판독센터)": "center_name", "이름": "patient_name" };

test("사용자 예시 — 센터#MR#병원명#미판독 을 조건으로 갈라 읽는다", () => {
  const q = parseFavQuery("센터#MR#병원명#미판독", LABELS);
  assert.equal(q.server.modality, "MR", "장비는 서버 필터로");
  assert.equal(q.server.status, "received", "미판독 = 요청(received)");
  assert.deepEqual(q.client.map((c) => c.value), ["센터", "병원명"], "나머지는 자유어 AND");
  assert.ok(q.client.every((c) => c.field === ""), "자유어는 필드 무지정");
});

test("판독 상태 3종 — 요청(미판독)·판독중·확정(판독)", () => {
  assert.equal(parseFavQuery("요청").server.status, "received");
  assert.equal(parseFavQuery("미판독").server.status, "received");
  assert.equal(parseFavQuery("판독중").server.status, "reading");
  assert.equal(parseFavQuery("확정").server.status, "finalized");
  assert.equal(parseFavQuery("판독").server.status, "finalized");
});

test("항목 구성 전 컬럼 — 명시형 `필드=값`(한글 라벨도 컬럼 키로 옮긴다)", () => {
  const q = parseFavQuery("병원명 (의뢰병원)=대자인#assigned_doctor=조윤희", LABELS);
  assert.deepEqual(q.client, [
    { field: "hospital_name", value: "대자인" },
    { field: "assigned_doctor", value: "조윤희" },
  ]);
  assert.equal(Object.keys(q.server).length, 0, "명시형은 서버 필터가 아니다");
  // 콜론 표기도 같은 뜻
  assert.deepEqual(parseFavQuery("이름:김지숙", LABELS).client, [{ field: "patient_name", value: "김지숙" }]);
});

test("모달리티 별칭·빈 토큰·공백 — 흔한 입력을 관용적으로 받는다", () => {
  assert.equal(parseFavQuery("MRI").server.modality, "MR");
  assert.equal(parseFavQuery("PET").server.modality, "PT");
  assert.equal(parseFavQuery("ct").server.modality, "CT", "소문자도 인식");
  assert.deepEqual(parseFavQuery("##  ##").client, [], "빈 토큰은 버린다");
  assert.deepEqual(parseFavQuery("  CT  #  뇌 ").client.map((c) => c.value), ["뇌"], "앞뒤 공백 제거");
});

test("행 필터 — 토큰 사이는 AND, 명시형은 그 컬럼만 본다", () => {
  const rows = [
    { patient_name: "김지숙", hospital_name: "대자인병원", center_name: "써밋영상의원", modality: "CT" },
    { patient_name: "이종만", hospital_name: "누리한방병원", center_name: "강남미래", modality: "CT" },
  ];
  assert.equal(applyFavFilter(rows, parseFavQuery("대자인", LABELS).client).length, 1);
  assert.equal(applyFavFilter(rows, parseFavQuery("대자인#써밋", LABELS).client).length, 1, "AND 로 좁힌다");
  assert.equal(applyFavFilter(rows, parseFavQuery("대자인#강남", LABELS).client).length, 0, "둘 다 맞아야 한다");
  // 명시형은 다른 컬럼에 같은 글자가 있어도 걸리지 않는다
  assert.equal(applyFavFilter(rows, parseFavQuery("이름=대자인", LABELS).client).length, 0);
  assert.equal(matchesCond(rows[0], { field: "", value: "" }), true, "빈 조건은 통과");
  assert.deepEqual(applyFavFilter(rows, []), rows, "조건이 없으면 원본 그대로");
});

test("문법 감지 — '#' 가 있으면 조건 나열로 읽는다", () => {
  assert.equal(looksLikeFavQuery("센터#MR"), true);
  assert.equal(looksLikeFavQuery("흉부 CT"), false);
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
