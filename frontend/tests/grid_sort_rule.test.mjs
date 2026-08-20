/* 그리드 헤더 클릭 정렬 계약(2026-08-19 사용자 확정).
 *
 * "의뢰 일시는 한 번 누르면 최신 시간별로, 다시 누르면 역순, 또 누르면 최신순.
 *  이름은 ㄱ·ㄴ / a·b 순 또는 역순. 모든 항목이 그렇게."
 *
 * 실행: node --test --experimental-strip-types frontend/tests/grid_sort_rule.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  compareValues, firstDir, nextSort, sortMark, sortRows, sortValue,
} from "../src/lib/gridSort.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");

test("첫 클릭 방향 — 날짜·수량은 최신·많은 것부터, 글자는 ㄱ·a 부터", () => {
  assert.equal(firstDir("request_datetime"), "desc", "의뢰 일시는 최신부터");
  assert.equal(firstDir("study_date"), "desc");
  assert.equal(firstDir("instance_count"), "desc");
  assert.equal(firstDir("patient_name"), "asc", "이름은 ㄱ 부터");
  assert.equal(firstDir("hospital_name"), "asc");
});

test("클릭할 때마다 순 ↔ 역 (무한 반복)", () => {
  let s = nextSort(null, "request_datetime");
  assert.deepEqual(s, { key: "request_datetime", dir: "desc" }, "1클릭 = 최신순");
  s = nextSort(s, "request_datetime");
  assert.deepEqual(s, { key: "request_datetime", dir: "asc" }, "2클릭 = 역순");
  s = nextSort(s, "request_datetime");
  assert.deepEqual(s, { key: "request_datetime", dir: "desc" }, "3클릭 = 다시 최신순");
  // 다른 컬럼을 누르면 그 컬럼의 기본 방향부터
  s = nextSort(s, "patient_name");
  assert.deepEqual(s, { key: "patient_name", dir: "asc" });
});

test("한글·영문 이름 — 사전 순서와 역순", () => {
  const rows = [{ patient_name: "이종만" }, { patient_name: "김지숙" }, { patient_name: "박용성" }];
  assert.deepEqual(sortRows(rows, { key: "patient_name", dir: "asc" }).map((r) => r.patient_name),
                   ["김지숙", "박용성", "이종만"]);
  assert.deepEqual(sortRows(rows, { key: "patient_name", dir: "desc" }).map((r) => r.patient_name),
                   ["이종만", "박용성", "김지숙"]);
  const en = [{ patient_name: "Charlie" }, { patient_name: "alice" }, { patient_name: "Bob" }];
  assert.deepEqual(sortRows(en, { key: "patient_name", dir: "asc" }).map((r) => r.patient_name),
                   ["alice", "Bob", "Charlie"], "대소문자 섞여도 사전 순");
});

test("숫자로 보이는 값은 숫자로 — '9' 가 '10' 뒤로 가지 않는다", () => {
  const rows = [{ instance_count: "10" }, { instance_count: "9" }, { instance_count: "100" }];
  assert.deepEqual(sortRows(rows, { key: "instance_count", dir: "asc" }).map((r) => r.instance_count),
                   ["9", "10", "100"]);
  assert.equal(sortValue({ instance_count: "42" }, "instance_count"), 42);
});

test("빈 값은 방향과 무관하게 항상 뒤로", () => {
  const rows = [{ center_name: "" }, { center_name: "써밋" }, { center_name: "강남미래" }];
  assert.deepEqual(sortRows(rows, { key: "center_name", dir: "asc" }).map((r) => r.center_name),
                   ["강남미래", "써밋", ""]);
  assert.deepEqual(sortRows(rows, { key: "center_name", dir: "desc" }).map((r) => r.center_name),
                   ["써밋", "강남미래", ""], "역순으로 뒤집어도 빈 칸이 위로 오지 않는다");
  assert.equal(compareValues("", "가"), 1);
  assert.equal(compareValues("가", ""), -1);
});

test("표시 컬럼 ↔ 데이터 필드가 다른 것들도 정렬된다", () => {
  assert.equal(sortValue({ emergency: true }, "priority"), 1, "응급이 위로");
  assert.equal(sortValue({ emergency: false }, "priority"), 0);
  assert.equal(sortValue({ institution: "대자인" }, "hospital_name"), "대자인", "병원명 폴백");
  assert.equal(sortValue({ impression_preview: "폐렴" }, "impression"), "폐렴");
});

test("정렬 없음·안정성 — 원본을 건드리지 않는다", () => {
  const rows = [{ a: 2 }, { a: 1 }];
  assert.strictEqual(sortRows(rows, null), rows, "상태가 없으면 서버가 준 순서 그대로");
  const sorted = sortRows(rows, { key: "a", dir: "asc" });
  assert.notStrictEqual(sorted, rows, "새 배열을 준다");
  assert.deepEqual(rows.map((r) => r.a), [2, 1], "원본 불변");
  assert.equal(sortMark({ key: "a", dir: "asc" }, "a"), " ▲");
  assert.equal(sortMark({ key: "a", dir: "desc" }, "a"), " ▼");
  assert.equal(sortMark({ key: "a", dir: "asc" }, "b"), "", "다른 컬럼엔 표식 없음");
});

test("배선 — 그리드 헤더가 클릭 정렬을 태우고, 컬럼 이동 드래그와 충돌하지 않는다", () => {
  const w = src("src/pages/Worklist.tsx");
  assert.match(w, /nextSort\(/, "헤더 클릭이 다음 정렬 상태로");
  assert.match(w, /sortRows\(/, "표시 목록에 적용");
  assert.match(w, /sortMark\(/, "▲▼ 표식");
  assert.match(w, /dragCol/, "컬럼 이동 DnD 와 같은 헤더 — 드래그 중 클릭 정렬이 끼어들면 안 된다");
});
