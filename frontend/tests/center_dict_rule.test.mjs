/* 판독센터 사전 계약(2026-08-21) — 조건 나열 검색에서 '이 토큰은 센터다' 를 알아본다.
 *
 * 배경: A 의 워크리스트 free-text 검색이 OR 로 훑는 컬럼은
 *   study_modality · study_description · study_body_part · patient_name · patient_id ·
 *   patient_idx · **hospital_name**   (webpacs_api dependencies/Study.get_study_search)
 * 여기에 **center_name 만 빠져 있다**. 그 하나 때문에 자유어를 통째로 A 에 못 보내고 받은
 * 목록(건수 상한 안)에서만 걸러야 했다. 센터를 알아보면 A 가 필드로 걸러 준다.
 *
 * ⚠ A 의 /center/list 는 **관리자 전용**이라 판독의 계정으로는 못 받는다. 병원 목록 API 는 없다.
 *   그래서 **이미 화면에 온 행에서** 모은다 — 행에서 왔다는 것은 A 에 실재하는 값이라는 뜻이라,
 *   승격해도 0건이 되지 않는다(추측이 아니다).
 *
 * 실행: node --test --experimental-strip-types frontend/tests/center_dict_rule.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CENTER_DICT_MAX, EMPTY_DICT, collectDict, dictEmpty, isCenterName, readDict,
} from "../src/lib/centerDict.ts";
import { clientCondsFor, parseFavQuery, promoteCenter } from "../src/lib/searchFav.ts";
import { LIVE_QUERY_KEYS, WL_PASSTHROUGH_KEYS, buildWorklistQuery, toLiveParams }
  from "../src/lib/worklistQuery.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");

const ROWS = [
  { center_name: "써밋영상의원", hospital_name: "대자인병원" },
  { center_name: "강남미래영상의학과", hospital_name: "구월한방병원" },
  { center_name: "", hospital_name: "신한방병원" },
];

test("본 목록에서 사전이 자란다", () => {
  const d = collectDict(EMPTY_DICT, ROWS);
  assert.deepEqual(d.centers, ["써밋영상의원", "강남미래영상의학과"], "빈 값은 담지 않는다");
  assert.ok(d.hospitals.includes("신한방병원"));
  // 누적된다(같은 값은 한 번만)
  const d2 = collectDict(d, [{ center_name: "써밋영상의원" }, { center_name: "판독센터A" }]);
  assert.deepEqual(d2.centers, ["써밋영상의원", "강남미래영상의학과", "판독센터A"]);
});

test("사전 크기 상한 — 오래된 것부터 버린다", () => {
  const many = Array.from({ length: CENTER_DICT_MAX + 50 }, (_, i) => ({ center_name: `C${i}` }));
  const d = collectDict(EMPTY_DICT, many);
  assert.equal(d.centers.length, CENTER_DICT_MAX);
  assert.equal(d.centers.at(-1), `C${CENTER_DICT_MAX + 49}`, "최근 것이 남는다");
});

test("① 정확 일치만 센터로 본다 — 일부만 쓰면 승격하지 않는다", () => {
  const d = collectDict(EMPTY_DICT, ROWS);
  assert.equal(isCenterName(d, "써밋영상의원"), true);
  assert.equal(isCenterName(d, "써밋"), false,
    "A 의 center_name 매칭이 부분 일치인지 확실하지 않다 — 모르면 승격하지 않는다");
  assert.equal(isCenterName(d, " 써밋영상의원 "), true, "앞뒤 공백은 다듬는다");
  assert.equal(isCenterName(d, ""), false);
});

test("② 병원명과 겹치면 승격하지 않는다 — 센터로 좁혔다가 검사가 사라진다", () => {
  const d = collectDict(EMPTY_DICT, [
    { center_name: "한마음", hospital_name: "한마음" },   // 같은 이름이 양쪽에 쓰인다
    { center_name: "써밋영상의원", hospital_name: "대자인병원" },
  ]);
  assert.equal(isCenterName(d, "한마음"), false, "애매하면 클라이언트가 거르는 쪽이 안전하다");
  assert.equal(isCenterName(d, "써밋영상의원"), true);
});

test("③ 사전이 비면 아무 일도 하지 않는다 — 처음 쓰는 사용자에게 무변화", () => {
  assert.equal(dictEmpty(EMPTY_DICT), true);
  const q = parseFavQuery("써밋영상의원#CT");
  assert.strictEqual(promoteCenter(q, () => false), q, "승격할 것이 없으면 원본 그대로");
});

test("승격 — 센터는 서버 조건으로 가고 클라이언트에서 빠진다", () => {
  const d = collectDict(EMPTY_DICT, ROWS);
  const q = promoteCenter(parseFavQuery("써밋영상의원#CT#CHEST"), (t) => isCenterName(d, t));
  assert.equal(q.server.center, "써밋영상의원");
  assert.equal(q.server.modality, "CT", "장비 승격은 그대로");
  assert.deepEqual(q.client.map((c) => c.value), ["CHEST"], "센터는 빠지고 나머지만 남는다");
  // Live 에서 클라이언트가 걸러야 할 조건도 그만큼 준다
  const conds = clientCondsFor(q, { liveMode: true, statusOnServer: () => false });
  assert.deepEqual(conds.map((c) => c.value), ["CHEST"]);
});

test("★ 조건이 증발하지 않는다 — 승격했으면 서버 파라미터까지 흘러가야 한다", () => {
  // 승격된 센터는 filters 를 타고 Live 파라미터가 된다
  assert.ok(WL_PASSTHROUGH_KEYS.includes("center"), "filters → 쿼리 파라미터");
  assert.ok(LIVE_QUERY_KEYS.includes("center"), "쿼리 파라미터 → A");
  const p = buildWorklistQuery({ filters: { center: "써밋영상의원", modality: "CT" }, searchText: "" });
  assert.equal(p.center, "써밋영상의원");
  assert.equal(toLiveParams(p).center, "써밋영상의원");
});

test("승격은 Live 에서만 — 로컬 DB 에는 센터 원천이 없다", () => {
  const w = src("src/pages/Worklist.tsx");
  assert.match(w, /if \(!liveModeRef\.current \|\| dictEmpty\(d\)\) return q;/,
    "로컬에서 승격하면 서버가 못 거르는데 클라이언트 조건에서도 빠져 **조건이 증발**한다");
  // 파싱·승격이 한 곳(favOf)이어야 조회와 표시 필터가 갈리지 않는다
  assert.match(w, /const favOf = useCallback/);
  assert.match(w, /clientCondsFor\(favOf\(committed\.searchText\)/, "조회");
  assert.match(w, /clientCondsFor\(favOf\(q\)/, "표시 필터");
  assert.match(w, /favOfRef\.current\(nextQ\)/, "커밋 경로도 같은 함수");
});

test("사전은 받은 행에서 갱신되고 기기에 남는다", () => {
  const w = src("src/pages/Worklist.tsx");
  assert.match(w, /collectDict\(centerDictRef\.current, r\.items\)/);
  assert.match(w, /saveDict\(nd\)/);
  // 깨진 저장값 방어
  assert.deepEqual(readDict(null), EMPTY_DICT);
  assert.deepEqual(readDict("깨진값"), EMPTY_DICT);
  assert.deepEqual(readDict('{"centers":["A",1,""],"hospitals":null}'), { centers: ["A"], hospitals: [] });
});

test("백엔드가 center 를 A 의 center_name 으로 보낸다", () => {
  const live = readFileSync(join(ROOT, "..", "backend/app/services/webpacs_live.py"), "utf8");
  assert.match(live, /q\["center_name"\] = str\(params\["center"\]\)/);
});
