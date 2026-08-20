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
  compareValues, firstDir, nextChipSort, nextSort, sortMark, sortRows, sortValue,
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

/* ── 상단 카운트 칩 클릭 정렬(2026-08-20 사용자 확정) ──
 * "그림의 각 항목(전체·응급·미판독·판독중·판독저장·승인)을 클릭해서도 Sorting 이 될 수 있도록 해줘." */

test("칩 정렬 — 그 상태를 맨 위로, 다시 누르면 맨 아래로, 한 번 더 누르면 해제", () => {
  let s = nextChipSort(null, "read_state", "unread");
  assert.deepEqual(s, { key: "read_state", dir: "asc", pin: "unread" }, "1클릭 = 미판독을 위로");
  s = nextChipSort(s, "read_state", "unread");
  assert.deepEqual(s, { key: "read_state", dir: "desc", pin: "unread" }, "2클릭 = 역순(아래로)");
  assert.equal(nextChipSort(s, "read_state", "unread"), null, "3클릭 = 해제(원래 순서)");
  // 다른 칩을 누르면 그 칩의 첫 상태부터
  const t = nextChipSort(s, "status", "finalized");
  assert.deepEqual(t, { key: "status", dir: "asc", pin: "finalized" });
});

test("칩 정렬 — pin 은 일치하는 줄만 위로 모으고 그 안 순서는 서버 순서 그대로", () => {
  const rows = [
    { id: 1, read_state: "finalized" }, { id: 2, read_state: "unread" },
    { id: 3, read_state: "reading" },   { id: 4, read_state: "unread" },
  ];
  const up = sortRows(rows, { key: "read_state", dir: "asc", pin: "unread" });
  assert.deepEqual(up.map((r) => r.id), [2, 4, 1, 3],
                   "미판독 2·4 가 위로, 서로의 순서(의뢰 최신순)는 유지");
  const down = sortRows(rows, { key: "read_state", dir: "desc", pin: "unread" });
  assert.deepEqual(down.map((r) => r.id), [1, 3, 2, 4], "역순이면 미판독이 아래로");
});

test("칩 정렬 — pin 없는 칩(응급)은 값 크기로 순/역만 오간다", () => {
  const s1 = nextChipSort(null, "priority");
  assert.deepEqual(s1, { key: "priority", dir: "desc" }, "응급이 먼저");
  const rows = [{ emergency: false, id: 1 }, { emergency: true, id: 2 }];
  assert.deepEqual(sortRows(rows, s1).map((r) => r.id), [2, 1]);
  const s2 = nextChipSort(s1, "priority");
  assert.deepEqual(s2, { key: "priority", dir: "asc" });
  assert.equal(nextChipSort(s2, "priority"), null, "세 번째 = 해제");
});

test("칩 정렬 배선 — 칩이 필터와 정렬을 함께 걸고, 헤더와 같은 정렬 상태를 쓴다", () => {
  const w = src("src/pages/Worklist.tsx");
  assert.match(w, /nextChipSort\(/, "칩 클릭이 다음 정렬 상태로");
  assert.match(w, /onChipSort\?\.\(ch\.sk, ch\.pin\)/, "칩마다 정렬 키·pin 을 넘긴다");
  assert.match(w, /ch\.onClick\(\);/, "기존 상태 필터도 그대로 걸린다(기능 손실 금지)");
  assert.match(w, /sort=\{sort\} onChipSort=\{onChipSort\}/, "그리드 헤더와 같은 sort 상태를 공유");
});
