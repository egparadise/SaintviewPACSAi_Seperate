/* 비교세트 후보 계약(2026-08-22 사용자 확정).
 *
 * 사용자 요구:
 *   "T뷰 워크리스트의 비교세트는 Compare 가 '판독의 중심'(판독의사 기준)으로 설정되어 있지
 *    않더라도 **이 부분만큼은 현재 로그인한 사람의 과거 판독문에서** 'Modality·BodyPart·All'
 *    체크박스로 골라 보여 준다. 비교세트 옆에 그 체크박스를 만들고,
 *    Setting>워크리스트>T-View 에 그림1(Compare 기준)과 이 설정을 넣되
 *    **워크리스트 공통과 별도로 T-View 에서만** 동작하게."
 *
 * 실행: node --test --experimental-strip-types frontend/tests/compare_set_rule.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  COMPARE_SET_LABEL, DEFAULT_TV_COMPARE, candidateQuery, pickFresh, readTvCompare, writeTvCompare,
} from "../src/lib/compareSet.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");
const q = (s) => Object.fromEntries(new URLSearchParams(s));

test("★ 후보는 **언제나 판독의사 기준** — Compare 설정이 '환자 기준' 이어도", () => {
  const patientCfg = { basis: { basis: "patient", by_modality: true, by_body_part: true, period: "1y" },
                       set: { modality: false, bodyPart: false } };
  assert.equal(q(candidateQuery(patientCfg, patientCfg.set)).basis, "reader",
    "사용자가 그렇게 못 박았다 — 설정>판독의 Compare 는 뷰어 Compare 창의 기본값이고 이건 워크리스트 비교세트다");
});

test("좁히는 축은 **패널 체크박스**가 정한다 — 설정의 by_modality 를 쓰지 않는다", () => {
  const cfg = { basis: { basis: "reader", by_modality: true, by_body_part: true, period: "all" },
                set: { modality: false, bodyPart: false } };
  const p = q(candidateQuery(cfg, { modality: true, bodyPart: false }));
  assert.equal(p.by_modality, "true");
  assert.equal(p.by_body_part, "false", "설정이 켜져 있어도 체크박스가 이긴다(같은 이름의 다른 축)");
});

test("기간은 T-View 설정에서 온다", () => {
  const cfg = { ...DEFAULT_TV_COMPARE, basis: { ...DEFAULT_TV_COMPARE.basis, period: "3y" } };
  assert.equal(q(candidateQuery(cfg, cfg.set)).period, "3y");
  assert.equal(q(candidateQuery(DEFAULT_TV_COMPARE, DEFAULT_TV_COMPARE.set)).period, "all");
});

test("라벨은 사용자가 쓴 그대로 — Same 접두사 없음", () => {
  assert.deepEqual(COMPARE_SET_LABEL, { modality: "Modality", bodyPart: "Bodypart", all: "All" });
});

test("★ 저장 그릇은 T-View 전용 — 공통·다른 뷰어를 건드리지 않는다", () => {
  const prefs = { columns: ["a"], compare_by_viewer: { sv: { basis: { period: "1y" } } } };
  const cfg = { basis: { basis: "reader", by_modality: true, by_body_part: false, period: "5y" },
                set: { modality: true, bodyPart: false } };
  const next = writeTvCompare(prefs, cfg);
  assert.deepEqual(next.columns, ["a"], "다른 키를 덮어쓰지 않는다");
  assert.deepEqual(next.compare_by_viewer.sv, { basis: { period: "1y" } }, "다른 뷰어 칸은 그대로");
  assert.deepEqual(next.compare_by_viewer.ty, cfg);
  // 읽기 왕복
  const back = readTvCompare(next);
  assert.equal(back.basis.period, "5y");
  assert.deepEqual(back.set, { modality: true, bodyPart: false });
});

test("설정이 없으면 기본값 — 처음 쓰는 사용자에게 무변화", () => {
  assert.deepEqual(readTvCompare(undefined), DEFAULT_TV_COMPARE);
  assert.deepEqual(readTvCompare({}), DEFAULT_TV_COMPARE);
  assert.deepEqual(readTvCompare({ compare_by_viewer: {} }), DEFAULT_TV_COMPARE);
  // 깨진 값도 죽지 않는다
  assert.deepEqual(readTvCompare({ compare_by_viewer: { ty: { set: { modality: "x" } } } }).set,
    { modality: true, bodyPart: false }, "불리언으로 정리한다");
});

test("이미 담긴 것은 후보에서 뺀다 — 같은 줄이 두 번 보이면 헷갈린다", () => {
  const cands = [{ study_uid: "a" }, { study_uid: "b" }, { study_uid: "c" }];
  assert.deepEqual(pickFresh(cands, [{ study_uid: "b" }]).map((x) => x.study_uid), ["a", "c"]);
  assert.deepEqual(pickFresh(cands, []).length, 3);
  assert.deepEqual(pickFresh([], [{ study_uid: "b" }]), []);
});

test("배선 — 패널이 체크박스를 띄우고 후보를 부른다", () => {
  const w = src("src/pages/Worklist.tsx");
  const i = w.indexOf("function ComparisonSetGrid");
  assert.ok(i > 0);
  const body = w.slice(i, i + 5200);
  assert.match(body, /api\.compareCandidates\(current\.id, candidateQuery\(tvCfg, filter\)\)/);
  assert.match(body, /COMPARE_SET_LABEL\[k\]/, "체크박스 3개");
  assert.match(body, /pickFresh\(cands, items\)/, "담긴 것은 후보에서 뺀다");
  assert.match(body, /onAdd\(e\)/, "＋ 로 세트에 담는다");
  // T-View 전용 설정을 워크리스트가 읽는다
  assert.match(w, /setTvCompare\(readTvCompare\(r\.value\)\)/);
});

test("배선 — 설정은 워크리스트>T-View 페이지에만 있고 저장도 그 칸만 바꾼다", () => {
  const s = src("src/pages/SettingsModal.tsx");
  const i = s.indexOf('<Group title={tr("Compare — 비교할 과거 검사를 어디서 고를까 (T-View 전용)")}>');
  assert.ok(i > 0, "T-View 전용 Compare 그룹이 있어야 한다");
  // 그 그룹은 vk === "ty" 안에서만 그려진다
  const before = s.slice(Math.max(0, i - 400), i);
  assert.match(before, /vk === "ty" && \(/, "다른 뷰어 페이지에는 나오면 안 된다");
  assert.match(s, /const cur = writeTvCompare\(cur0, tvCmp\);/,
    "저장은 T-View 칸만 갈아 끼운다(공통 설정 보존)");
  // 라디오 이름이 판독 페이지의 것과 겹치면 두 화면이 서로를 밀어낸다
  assert.match(s, /name="tvcmpbasis"/);
  assert.match(s, /name="cmpbasis"/);
});
