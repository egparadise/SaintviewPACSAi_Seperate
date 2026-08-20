/* History 과거검사 분류 계약 — SameModality · SameBodyPart · All (2026-08-20 사용자 확정).
 *
 * 사용자 요구:
 *   "History 의 과거 영상 바로 위에 3개의 체크박스 버튼을 만들고, 클릭하면 같은 환자의 과거 검사
 *    History 가 세 가지로 분류되어 보이게 —
 *      1. SameModality : 같은 장비에서 촬영한 과거 Study
 *      2. SameBodyPart : 같은 BodyPart (예: Chest / Abdomen / Brain)
 *      3. All          : 전부"
 *
 * 실행: node --test --experimental-strip-types frontend/tests/prior_filter_rule.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PRIOR_FILTER_OFF, filterPriors, isAll, nextPriorFilter, normPart, priorMatches, readPriorFilter,
} from "../src/lib/priorFilter.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");

const CUR = { modality: "CT", body_part: "CHEST" };
const PRIORS = [
  { id: 1, modality: "CT", body_part: "CHEST" },     // 장비·부위 모두 같음
  { id: 2, modality: "CT", body_part: "ABDOMEN" },   // 장비만 같음
  { id: 3, modality: "CR", body_part: "Chest" },     // 부위만 같음(표기 다름)
  { id: 4, modality: "MR", body_part: "BRAIN" },     // 둘 다 다름
  { id: 5, modality: "CT", body_part: "" },          // 부위를 모름
];
const ids = (list) => list.map((p) => p.id);

test("All — 아무것도 안 켜면 전부 보인다", () => {
  assert.equal(isAll(PRIOR_FILTER_OFF), true);
  assert.deepEqual(ids(filterPriors(CUR, PRIORS, PRIOR_FILTER_OFF)), [1, 2, 3, 4, 5]);
  assert.strictEqual(filterPriors(CUR, PRIORS, PRIOR_FILTER_OFF), PRIORS,
    "All 이면 원본 참조 그대로 — 쓸데없는 리렌더를 만들지 않는다");
});

test("SameModality — 같은 장비만", () => {
  const f = nextPriorFilter(PRIOR_FILTER_OFF, "modality");
  assert.deepEqual(f, { modality: true, bodyPart: false });
  assert.deepEqual(ids(filterPriors(CUR, PRIORS, f)), [1, 2, 5], "CT 만");
});

test("SameBodyPart — 같은 부위만(표기 차이는 무시)", () => {
  const f = nextPriorFilter(PRIOR_FILTER_OFF, "bodyPart");
  assert.deepEqual(ids(filterPriors(CUR, PRIORS, f)), [1, 3],
    "'CHEST' 와 'Chest' 는 같은 부위다");
  assert.equal(normPart("C-Spine"), "cspine");
  assert.equal(normPart("C SPINE"), "cspine");
  assert.equal(normPart("c_spine"), "cspine", "장비·병원마다 표기가 다르다");
});

test("둘 다 켜면 AND — 같은 장비 그리고 같은 부위", () => {
  let f = nextPriorFilter(PRIOR_FILTER_OFF, "modality");
  f = nextPriorFilter(f, "bodyPart");
  assert.deepEqual(f, { modality: true, bodyPart: true });
  assert.deepEqual(ids(filterPriors(CUR, PRIORS, f)), [1],
    "OR 로 하면 필터를 더 걸수록 목록이 늘어나 조작 감각이 뒤집힌다");
});

test("모르는 값은 그 축을 걸 때 제외한다 — 다른 부위가 섞이면 위험하다", () => {
  const f = { modality: false, bodyPart: true };
  assert.equal(priorMatches(CUR, { modality: "CT", body_part: "" }, f), false, "부위를 모르는 과거검사");
  assert.equal(priorMatches({ modality: "CT", body_part: "" }, PRIORS[0], f), false,
    "현재 검사의 부위를 모르면 비교 기준이 없다");
  // 장비 축도 같은 규칙
  assert.equal(priorMatches(CUR, { modality: "", body_part: "CHEST" }, { modality: true, bodyPart: false }), false);
});

test("All 을 누르면 나머지가 꺼진다 — 목록이 통째로 비는 상태를 실수로 만들 수 없게", () => {
  const both = { modality: true, bodyPart: true };
  assert.deepEqual(nextPriorFilter(both, "all"), { modality: false, bodyPart: false });
  // 반대로 축을 켜면 자동으로 All 이 아니게 된다(isAll 이 거짓)
  assert.equal(isAll(nextPriorFilter(PRIOR_FILTER_OFF, "modality")), false);
});

test("기억값이 깨져 있어도 화면이 죽지 않는다", () => {
  assert.deepEqual(readPriorFilter(null), PRIOR_FILTER_OFF);
  assert.deepEqual(readPriorFilter("깨진값"), PRIOR_FILTER_OFF);
  assert.deepEqual(readPriorFilter('{"modality":1,"bodyPart":"x"}'), { modality: true, bodyPart: true },
    "값이 이상해도 불리언으로 정리한다");
});

test("배선 — 도크가 필터를 쓰고, 썸네일은 전체 기준으로 미리 받는다", () => {
  const d = src("src/components/ReportDock.tsx");
  assert.match(d, /filterPriors\(detail, relAll, pf\)/, "화면에는 필터된 목록만");
  assert.match(d, /\(relAll\.slice\(0, 12\)\)\.forEach/,
    "썸네일은 전체 기준으로 미리 받는다 — 필터를 바꿀 때마다 다시 받으면 전환이 굼뜨다");
  for (const k of ["SameModality", "SameBodyPart", "All"]) {
    assert.ok(src("src/lib/priorFilter.ts").includes(`"${k}"`), `라벨 ${k}`);
  }
  assert.match(d, /savePriorFilter\(nx\)/, "고른 분류를 기억한다");
});

test("백엔드 — 과거검사에 body_part 가 실린다(없으면 SameBodyPart 가 통째로 빈다)", () => {
  const local = readFileSync(join(ROOT, "..", "backend/app/services/study_service.py"), "utf8");
  const live = readFileSync(join(ROOT, "..", "backend/app/services/webpacs_live.py"), "utf8");
  // 로컬: related 목록 구성부
  const i = local.indexOf("# F-14 Related Exams");
  assert.ok(i > 0, "related_exams 구성부를 찾지 못했다");
  assert.match(local.slice(i, i + 900), /"body_part": s\.body_part/);
  // Live: live_related 구성부
  const j = live.indexOf("def live_related");
  assert.match(live.slice(j, j + 2600), /"body_part": str\(o\.get\("study_body_part"\) or ""\)/);
});
