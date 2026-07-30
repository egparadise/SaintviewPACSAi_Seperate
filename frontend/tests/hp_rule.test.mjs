/* 행잉 프로토콜(HP) 데이터 계약 회귀 테스트 — lib/hangingProtocol.ts 의 **원본**을 그대로 부른다.
 *
 * 지키는 것(되돌리면 여기서 실패한다):
 *   ① 기존 저장값 보존 — 구 규칙(displays·s·i 만 있는 것)을 읽어도 값이 사라지지 않는다.
 *   ② 구 규칙의 부위 출처는 body_part 하나뿐이다(구 구현이 그것만 봤다). 마이그레이션이 넓히지 않는다.
 *   ③ '가장 우선 적용'(priority)은 기본 false 이고, 켜지면 저장 순서를 이기고 먼저 걸린다.
 *   ④ 'Exam 열 때 HP 사용' 이 꺼진 규칙은 **건너뛰고 다음 규칙**을 본다(Viewer2D 가 통째로 포기하던 버그).
 *   ⑤ 시간대 슬롯의 기준점은 **지금 보는 검사의 검사일**이고 같은 날은 포함, 미래는 제외
 *      — backend/app/services/compare_basis.py 와 같은 규칙.
 *   ⑥ 사용자가 추가한 장비명이 저장·복원된다(고정 목록 금지).
 *
 * 실행: node --test frontend/tests/hp_rule.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_HP_PART_FIELDS, DEFAULT_HP_SLOT, HP_EDITOR_CHROME, HP_MODALITY_PRESETS, HP_OPTION_FIELDS, HP_PART_FIELDS, HP_PART_FIELDS_UNAVAILABLE, HP_SLOTS,
  HP_SLOT_LABEL, LEGACY_HP_PART_FIELDS, fitHpCells,
  hpExamOf, hpHaystack, hpModalityOptions, hpOptionRowMinWidth, hpPartFieldGaps, hpPartTerms,
  hpRuleMatches, hpRuleOrder, hpScreensFromMonitors, hpSettingsMinWidth,
  hpSlotCutoff, hpSlotDays, hpSlotIsPrior, hpSlotLabel, hpSlotStudies,
  matchHpRule, newHpRule, readHpDoc, readHpRule, readHpSlot, syncHpLegacy, writeHpDoc,
} from "../src/lib/hangingProtocol.ts";

const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

/* ══════════ ① 기존 저장값 보존 ══════════ */

/** 배포본이 실제로 저장하던 모양 — screens·body_part_fields·priority 가 **없다**. */
const LEGACY_RULE = {
  id: "hp1", name: "Chest 표준", modality: "CR", body_part: "CHEST", projection: "PA",
  description: "흉부 기본", s: { r: 2, c: 2 }, i: { r: 1, c: 2 }, wl: "-600,1500",
  use_on_exam_open: true, full_link: true, full_scroll_sync: false, cross_link: true, scout_image: false,
  displays: [
    { id: "d1", role: "viewer", label: "1-2", resolution: "2560 * 1080 (100%)",
      grid: { r: 2, c: 2 }, cells: [1, null, 3, null] },
    { id: "d2", role: "worklist_report", label: "2-1", resolution: "1600 * 1067 (150%)",
      grid: { r: 1, c: 1 }, cells: [null] },
  ],
};

test("① 구 저장본을 읽어도 값이 하나도 사라지지 않는다", () => {
  const r = readHpRule(LEGACY_RULE);
  assert.equal(r.name, "Chest 표준");
  assert.equal(r.modality, "CR");
  assert.equal(r.body_part, "CHEST");
  assert.equal(r.projection, "PA");
  assert.equal(r.description, "흉부 기본");
  assert.equal(r.wl, "-600,1500");
  assert.deepEqual(r.s, { r: 2, c: 2 });
  assert.deepEqual(r.i, { r: 1, c: 2 });
  // 체크박스 5개
  assert.equal(r.use_on_exam_open, true);
  assert.equal(r.full_link, true);
  assert.equal(r.full_scroll_sync, false);
  assert.equal(r.cross_link, true);
  assert.equal(r.scout_image, false);
});

test("① displays → screens 승격 — 그리드·셀 시리즈 순번·역할이 그대로 살아 있다", () => {
  const r = readHpRule(LEGACY_RULE);
  assert.equal(r.screens.length, 2);
  const [v, wr] = r.screens;
  assert.equal(v.role, "viewer");
  assert.deepEqual(v.s, { r: 2, c: 2 }, "Series layout = 구 displays.grid");
  assert.deepEqual(v.i, { r: 1, c: 2 }, "Image layout = 구 rule.i (구 규칙은 뷰어 전체에 하나뿐이었다)");
  assert.deepEqual(v.cells.map((c) => c.series), [1, null, 3, null], "셀별 시리즈 순번 보존");
  // 구 저장본의 칸은 전부 '현재 검사' — 과거검사 슬롯은 새 기능이라 없던 뜻을 만들어 내면 안 된다
  assert.deepEqual(v.cells.map((c) => c.slot.kind), ["current", "current", "current", "current"]);
  assert.equal(v.monitor, null, "구 형식에는 모니터 인덱스가 없다 — 미지정");
  assert.equal(wr.role, "worklist_report");
});

test("① screens 로 저장해도 구 필드(s·i·displays)가 되채워진다 — 구 빌드/구 호출부 보호", () => {
  const r = readHpRule(LEGACY_RULE);
  r.screens[0].s = { r: 3, c: 3 };
  r.screens[0].i = { r: 2, c: 2 };
  r.screens[0].cells = Array.from({ length: 9 }, (_, k) => ({ series: k === 0 ? 5 : null, slot: { kind: "current" } }));
  const out = syncHpLegacy(r);
  assert.deepEqual(out.s, { r: 3, c: 3 }, "rule.s 는 첫 viewer 화면의 Series layout");
  assert.deepEqual(out.i, { r: 2, c: 2 });
  assert.deepEqual(out.displays[0].grid, { r: 3, c: 3 });
  assert.deepEqual(out.displays[0].cells.slice(0, 2), [5, null]);
  assert.equal(out.displays[0].cells.length, 9);
});

test("① 규칙이 전혀 없거나 깨져 있어도 던지지 않는다(설정 화면은 떠야 한다)", () => {
  assert.deepEqual(readHpDoc(undefined), { rules: [], modalities: [] });
  assert.deepEqual(readHpDoc({ rules: "쓰레기" }), { rules: [], modalities: [] });
  const r = readHpRule({});
  assert.ok(r.id, "id 가 없으면 만들어 준다");
  assert.deepEqual(r.s, { r: 1, c: 1 });
  assert.equal(r.screens.length, 2, "displays 도 없으면 기본 배치(뷰어 1 + 워크리스트+판독 1)");
});

test("① 왕복(read → write → read)이 값을 바꾸지 않는다", () => {
  const once = readHpDoc({ rules: [LEGACY_RULE] });
  const saved = writeHpDoc(once);
  const twice = readHpDoc(saved);
  assert.deepEqual(twice.rules, once.rules);
});

/* ══════════ ② 부위 출처(DICOM 필드) ══════════ */

test("② 구 저장본의 부위 출처는 body_part 하나뿐 — 마이그레이션이 넓히지 않는다", () => {
  const r = readHpRule(LEGACY_RULE);
  assert.deepEqual(r.body_part_fields, LEGACY_HP_PART_FIELDS);
  assert.deepEqual(LEGACY_HP_PART_FIELDS, ["body_part"]);
  // 넓혔다면 아래가 걸린다 — study_desc 에 CHEST 가 있어도 구 규칙은 안 걸려야 한다(어제와 같은 결과)
  assert.equal(hpRuleMatches(r, { modality: "CR", body_part: "", study_desc: "CHEST PA" }), false);
  assert.equal(hpRuleMatches(r, { modality: "CR", body_part: "CHEST", study_desc: "CHEST PA" }), true);
});

test("② 새 규칙의 기본 출처는 body_part + study_desc (로컬·Live 양쪽에서 최소 하나는 값이 있다)", () => {
  assert.deepEqual(DEFAULT_HP_PART_FIELDS, ["body_part", "study_desc"]);
  assert.deepEqual(newHpRule().body_part_fields, ["body_part", "study_desc"]);
});

test("② 고른 출처에서만 찾는다 — order_name/series_desc 포함", () => {
  const base = readHpRule({ ...LEGACY_RULE, projection: "" });
  const local = { modality: "CR", body_part: "", study_desc: "흉부 단순촬영",
                  order_name: "CHEST PA (Erect)", series_descs: ["SCOUT", "CHEST"] };
  assert.equal(hpRuleMatches({ ...base, body_part_fields: ["body_part"] }, local), false);
  assert.equal(hpRuleMatches({ ...base, body_part_fields: ["study_desc"] }, local), false);
  assert.equal(hpRuleMatches({ ...base, body_part_fields: ["order_name"] }, local), true);
  assert.equal(hpRuleMatches({ ...base, body_part_fields: ["series_desc"] }, local), true);
  assert.equal(hpRuleMatches({ ...base, body_part_fields: ["body_part", "order_name"] }, local), true);
});

/* ⚠ 위 테스트는 series_descs 를 **손으로** 먹인다 — 순수 함수만 맞으면 통과한다.
   실제로 제품은 그 값을 아무도 안 넣어서 'Series Description' 을 고른 규칙이 어떤 검사에도
   걸리지 않았다(공허한 초록). 아래 두 테스트가 그 구멍을 막는다:
   ① 뷰어가 쓰는 빌더(hpExamOf)가 series_descs 를 실제로 채우는가
   ② 뷰어 두 곳이 그 빌더를 부르는가(객체 리터럴로 되돌리면 깨진다) */

test("② hpExamOf — 뷰어가 넘기는 HpExam 을 만드는 유일한 빌더가 series_descs 를 채운다", () => {
  const detail = { modality: "CR", body_part: "", study_desc: "흉부 단순촬영",
                   order_name: "", study_date: "20260729" };
  const series = [{ series_desc: "SCOUT" }, { series_desc: " CHEST " }, { series_desc: "" },
                  { series_desc: "CHEST" }];
  const exam = hpExamOf(detail, series);
  assert.deepEqual(exam.series_descs, ["SCOUT", "CHEST"], "공백 정리 + 빈값 제거 + 중복 제거");
  assert.equal(exam.study_desc, "흉부 단순촬영");
  assert.equal(exam.study_date, "20260729");
  // 이 exam 이면 'Series Description' 단독 규칙이 **실제로 걸린다**
  const r = readHpRule({ id: "x", name: "x", body_part: "CHEST", body_part_fields: ["series_desc"] });
  assert.equal(hpRuleMatches(r, exam), true);
  assert.equal(hpRuleMatches(r, hpExamOf(detail)), false, "시리즈를 안 넘기면(구 동작) 안 걸린다");
  // '아직 모른다'(시리즈 도착 전)와 '없다'를 호출부가 구분할 수 있어야 한다
  assert.equal(hpExamOf(detail).series_descs, undefined);
  assert.equal(hpExamOf(detail, []).series_descs, undefined);
  assert.equal(hpExamOf(detail, null).series_descs, undefined);
});

test("② 뷰어 두 곳이 hpExamOf 를 부른다 — 객체 리터럴로 되돌리면 여기서 깨진다", () => {
  for (const f of ["../src/pages/Viewer2D.tsx", "../src/pages/ViewerInfi.tsx"]) {
    const code = src(f);
    assert.match(code, /matchHpRule\(\s*hpExamOf\(/, `${f}: matchHpRule 에 hpExamOf 결과를 넘겨야 한다`);
    // 예전 모양(객체 리터럴로 modality/body_part/... 를 직접 나열)이 남아 있으면 series_descs 가 빠진다
    assert.equal(/matchHpRule\(\s*\{/.test(code), false, `${f}: exam 을 리터럴로 만들지 않는다`);
  }
});

test("② 출처 값이 서로 이어붙어 없던 부위가 생기면 안 된다", () => {
  // "CHEST" + "PA" 가 그냥 붙으면 "CHESTPA" 안에 "STPA" 같은 것이 생긴다 — 개행으로 끊는다
  const hay = hpHaystack({ study_desc: "CHEST", order_name: "PA" }, ["study_desc", "order_name"]);
  assert.equal(hay, "CHEST\nPA");
  assert.equal(hay.includes("CHESTPA"), false);
});

test("② 부위 자유 입력은 쉼표/| 로 여러 값 = OR, 공백은 구분자가 아니다", () => {
  assert.deepEqual(hpPartTerms("Chest, Lung | Thorax"), ["CHEST", "LUNG", "THORAX"]);
  assert.deepEqual(hpPartTerms("L SPINE"), ["L SPINE"], "공백으로 쪼개면 'L' 이 온갖 검사에 걸린다");
  const r = readHpRule({ id: "x", name: "x", modality: "", body_part: "Chest, Skull",
                         body_part_fields: ["study_desc"], projection: "" });
  assert.equal(hpRuleMatches(r, { study_desc: "SKULL AP" }), true);
  assert.equal(hpRuleMatches(r, { study_desc: "ABDOMEN" }), false);
});

test("② 사양 ③ 이 이름 댄 출처가 **전부** 목록에 있다", () => {
  // 요구 원문: "Body Part : (들어오는 영상 정보의 DICOM Header 값 기준) …
  //             Protocol Code / Procedure Code / Procedure Description / Procedure Step Description"
  // 한동안 뒤 3개가 빠져 있었다 — 백엔드가 그 시리즈 레벨 태그를 읽지 않았기 때문이다.
  // 이제 OrthancClient.hanging_tags → studies 컬럼 → study detail 로 붙었다.
  const keys = HP_PART_FIELDS.map((f) => f.key);
  for (const k of ["protocol_name", "procedure_code", "step_desc", "order_name"]) {
    assert.ok(keys.includes(k), `사양이 이름 댄 출처가 없다: ${k}`);
  }
  // 이제 '없어서 못 올린 항목' 안내는 비어 있어야 한다
  assert.equal(HP_PART_FIELDS_UNAVAILABLE, "", "빠진 출처가 없으면 안내 문구도 없다");
  // 모든 항목은 local/live 중 최소 한쪽에 값이 있다고 선언해야 한다(둘 다 false 면 죽은 항목)
  for (const f of HP_PART_FIELDS) {
    assert.ok(f.local || f.live, `어디서도 값이 없는 출처를 올렸다: ${f.key}`);
    assert.ok(f.tag && f.label && f.note, `설명이 빈 출처: ${f.key}`);
  }
  // body_part 는 이제 로컬에서도 채워진다(hanging_tags 가 BodyPartExamined 를 넘긴다)
  assert.equal(HP_PART_FIELDS.find((f) => f.key === "body_part").local, true);
  // order_name·신규 3개는 Live(A)에서 값이 없다 — A 응답에 그 필드가 없다
  for (const k of ["order_name", "protocol_name", "procedure_code", "step_desc"]) {
    assert.equal(HP_PART_FIELDS.find((f) => f.key === k).live, false, `${k} 는 Live 에서 값이 없다`);
  }
  const sd = HP_PART_FIELDS.find((f) => f.key === "study_desc");
  assert.ok(sd.local && sd.live, "study_desc 는 양쪽 다 값이 있다");
});

test("② 새 출처들이 실제로 매칭에 쓰인다 — 목록에만 올리고 안 쓰면 죽은 항목이다", () => {
  const exam = { modality: "CT", protocol_name: "CHEST HELICAL",
                 procedure_code: "CT-CHEST-01", step_desc: "CHEST WITH CONTRAST" };
  for (const [field, part] of [["protocol_name", "HELICAL"],
                               ["procedure_code", "CT-CHEST"],
                               ["step_desc", "CONTRAST"]]) {
    const r = newHpRule({ body_part: part, body_part_fields: [field] });
    assert.equal(hpRuleMatches(r, exam), true, `${field} 로 매칭되지 않는다`);
    // 그 출처를 끄면 안 걸려야 한다(값이 다른 필드에서 새어 들어오면 안 된다)
    const other = newHpRule({ body_part: part, body_part_fields: ["study_desc"] });
    assert.equal(hpRuleMatches(other, exam), false, `${field} 값이 study_desc 로 새어 들어왔다`);
  }
});

test("② 설정 화면 경고 판정 — '골라도 그쪽에서는 절대 안 걸리는' 조합을 집어낸다", () => {
  // body_part 는 이제 로컬·Live 양쪽에서 채워진다(hanging_tags 가 시리즈에서 읽는다) → 구멍 없음.
  // 구 저장본(=빈 배열)도 body_part 만 보므로 같은 판정이다.
  assert.deepEqual(hpPartFieldGaps(["body_part"]), { local: false, live: false });
  assert.deepEqual(hpPartFieldGaps([]), { local: false, live: false }, "빈 배열은 구 저장본과 같은 취급");
  assert.deepEqual(hpPartFieldGaps(undefined), { local: false, live: false });
  // 신규 3개는 Live 에서 값이 없다 — 그쪽 구멍을 집어내야 한다
  assert.deepEqual(hpPartFieldGaps(["protocol_name"]), { local: false, live: true });
  assert.deepEqual(hpPartFieldGaps(["procedure_code", "step_desc"]), { local: false, live: true });
  // order_name 은 Live 에서 항상 "" — 반대쪽 구멍
  assert.deepEqual(hpPartFieldGaps(["order_name"]), { local: false, live: true });
  // study_desc 를 넣으면 양쪽 다 값이 있다 = 경고 없음 (편집기가 이것을 권한다)
  assert.deepEqual(hpPartFieldGaps(["study_desc"]), { local: false, live: false });
  assert.deepEqual(hpPartFieldGaps(DEFAULT_HP_PART_FIELDS), { local: false, live: false });
  // 경고가 실제 매칭과 일치하는가 — 로컬 검사(body_part 가 "")에 body_part 단독 규칙은 안 걸린다
  const r = readHpRule({ id: "x", name: "x", modality: "", body_part: "CHEST",
                         body_part_fields: ["body_part"], projection: "" });
  assert.equal(hpRuleMatches(r, { body_part: "", study_desc: "CHEST PA" }), false);
});

/* ══════════ ③④ 매칭 우선순위 ══════════ */

const R = (p) => readHpRule({ id: p.id, name: p.id, modality: p.modality ?? "", body_part: p.body_part ?? "",
                              body_part_fields: p.fields ?? ["study_desc"], projection: p.projection ?? "",
                              priority: p.priority, use_on_exam_open: p.open, s: { r: 1, c: 1 }, i: { r: 1, c: 1 } });

test("③ priority 는 기본 false — 저장본에 없으면 절대 켜지지 않는다", () => {
  assert.equal(readHpRule(LEGACY_RULE).priority, false);
  assert.equal(newHpRule().priority, false);
  assert.equal(readHpRule({ priority: "yes" }).priority, true, "truthy 는 켜짐(사용자가 켠 값)");
});

test("③ '가장 우선 적용' 규칙이 저장 순서를 이긴다", () => {
  const rules = [R({ id: "a", modality: "CT" }), R({ id: "b", modality: "CT", priority: true })];
  assert.equal(matchHpRule({ modality: "CT" }, rules).id, "b");
  // 우선 규칙이 안 걸리면 그 외 규칙이 저장 순서대로
  assert.equal(matchHpRule({ modality: "MR" }, [R({ id: "a", modality: "MR" }), R({ id: "b", modality: "CT", priority: true })]).id, "a");
  // 아무것도 안 걸리면 null = HP 해제
  assert.equal(matchHpRule({ modality: "US" }, rules), null);
  assert.equal(matchHpRule({ modality: "CT" }, []), null);
  assert.equal(matchHpRule({ modality: "CT" }, undefined), null);
});

test("③ 드롭다운 순서 = 매칭 순서(우선 규칙이 위)", () => {
  const rules = [R({ id: "a" }), R({ id: "b", priority: true }), R({ id: "c" })];
  assert.deepEqual(hpRuleOrder(rules).map((r) => r.id), ["b", "a", "c"]);
});

test("④ 'Exam 열 때 HP 사용' 꺼진 규칙은 건너뛰고 다음 규칙을 본다", () => {
  const rules = [R({ id: "a", modality: "CT", open: false }), R({ id: "b", modality: "CT" })];
  // 구 Viewer2D 는 a 를 찾은 뒤 통째로 포기해 b 가 절대 적용되지 않았다
  assert.equal(matchHpRule({ modality: "CT" }, rules, { forExamOpen: true }).id, "b");
  // 수동(드롭다운) 선택 경로는 그 규칙도 고를 수 있어야 한다
  assert.equal(matchHpRule({ modality: "CT" }, rules).id, "a");
  // 우선 규칙이라도 자동적용이 꺼져 있으면 자동 경로에서는 건너뛴다
  const p = [R({ id: "p", modality: "CT", priority: true, open: false }), R({ id: "q", modality: "CT" })];
  assert.equal(matchHpRule({ modality: "CT" }, p, { forExamOpen: true }).id, "q");
});

test("④ 빈 조건은 '무관' — 장비/부위/Projection 이 비면 그 축으로 안 좁힌다", () => {
  const any = R({ id: "any" });
  assert.equal(hpRuleMatches(any, { modality: "MG", study_desc: "무엇이든" }), true);
  const m = R({ id: "m", modality: "ct" });
  assert.equal(hpRuleMatches(m, { modality: "CT" }), true, "장비는 대소문자 무시 완전일치");
  assert.equal(hpRuleMatches(m, { modality: "CTA" }), false, "부분일치면 CT 규칙이 CTA 에 걸린다");
  const pj = R({ id: "p", projection: "lat" });
  assert.equal(hpRuleMatches(pj, { study_desc: "KNEE LAT" }), true);
  assert.equal(hpRuleMatches(pj, { study_desc: "KNEE AP" }), false);
});

/* ══════════ ⑤ 시간대 슬롯 ══════════ */

test("⑤ 슬롯 종류 — current/3d 는 과거검사를 고르지 않는다", () => {
  assert.equal(hpSlotIsPrior({ kind: "current" }), false);
  assert.equal(hpSlotIsPrior({ kind: "3d" }), false);
  assert.equal(hpSlotIsPrior(undefined), false, "기본은 현재 검사");
  for (const k of ["prev", "1w", "1m", "1y", "custom"]) assert.equal(hpSlotIsPrior({ kind: k }), true, k);
  assert.deepEqual(hpSlotStudies({ kind: "current" }, "20260101", [{ id: 1, study_date: "20250101" }]), []);
  assert.deepEqual(hpSlotStudies({ kind: "3d" }, "20260101", [{ id: 1, study_date: "20250101" }]), []);
});

test("⑤ 기간 하한 — 기준점은 지금 보는 검사의 검사일(오늘이 아니다), 1년=365일(백엔드와 같다)", () => {
  assert.equal(hpSlotDays({ kind: "1w" }), 7);
  assert.equal(hpSlotDays({ kind: "1m" }), 30);
  assert.equal(hpSlotDays({ kind: "1y" }), 365);
  assert.equal(hpSlotDays({ kind: "prev" }), 0, "prev 는 하한 없음");
  assert.equal(hpSlotCutoff("20260729", { kind: "1w" }), "20260722");
  assert.equal(hpSlotCutoff("20260729", { kind: "1m" }), "20260629");
  assert.equal(hpSlotCutoff("20260729", { kind: "1y" }), "20250729");
  assert.equal(hpSlotCutoff("20260729", { kind: "prev" }), "");
  // 기준일을 모르면 자르지 않는다 — 오늘로 자르면 과거 검사를 판독할 때 후보가 통째로 사라진다
  assert.equal(hpSlotCutoff("", { kind: "1y" }), "");
  assert.equal(hpSlotCutoff("2026-07-29", { kind: "1y" }), "");
});

test("⑤ 기간 직접 설정 — n·단위, 0/음수/쓰레기는 1 로 (하한이 미래가 되면 후보가 0 건)", () => {
  assert.equal(hpSlotDays({ kind: "custom", n: 3, unit: "y" }), 3 * 365);
  assert.equal(hpSlotDays({ kind: "custom", n: 6, unit: "m" }), 180);
  assert.equal(hpSlotDays({ kind: "custom", n: 10, unit: "d" }), 10);
  assert.equal(hpSlotDays({ kind: "custom", n: 0, unit: "d" }), 1);
  assert.equal(hpSlotDays({ kind: "custom", n: -5, unit: "d" }), 1);
  assert.deepEqual(readHpSlot({ kind: "custom" }), { kind: "custom", n: 1, unit: "m" });
  assert.deepEqual(readHpSlot({ kind: "custom", n: "3", unit: "y" }), { kind: "custom", n: 3, unit: "y" });
  assert.equal(hpSlotLabel({ kind: "custom", n: 6, unit: "m" }), "6개월 내");
  assert.equal(hpSlotLabel({ kind: "prev" }), "바로 이전 영상");
  // 모르는 값은 기본(현재 검사)으로 — 설정이 깨져도 화면은 뜬다
  assert.deepEqual(readHpSlot({ kind: "무엇" }), { kind: "current" });
  assert.deepEqual(readHpSlot("1y"), { kind: "1y" });
});

/** 기준검사 20260729 (id 100) */
const CANDS = [
  { id: 101, study_date: "20260729" },   // 같은 날 — 포함(오전/오후 촬영 비교)
  { id: 102, study_date: "20260725" },   // 4일 전
  { id: 103, study_date: "20260701" },   // 28일 전
  { id: 104, study_date: "20251201" },   // 240일 전
  { id: 105, study_date: "20200101" },   // 6년 전
  { id: 106, study_date: "20261231" },   // 미래 — 제외
  { id: 107, study_date: "" },           // 날짜 불명 — 제외
  { id: 100, study_date: "20260729" },   // 지금 보는 검사 — currentId 로 제외
];

test("⑤ 같은 날은 포함, 미래·날짜불명·현재검사는 제외, 최신순", () => {
  const got = hpSlotStudies({ kind: "1y" }, "20260729", CANDS, 100);
  assert.deepEqual(got.map((c) => c.id), [101, 102, 103, 104]);
});

test("⑤ 창(window)이 실제로 자른다 — 1주/1개월/1년", () => {
  const ids = (k) => hpSlotStudies({ kind: k }, "20260729", CANDS, 100).map((c) => c.id);
  assert.deepEqual(ids("1w"), [101, 102]);
  assert.deepEqual(ids("1m"), [101, 102, 103]);
  assert.deepEqual(ids("1y"), [101, 102, 103, 104]);
  assert.deepEqual(hpSlotStudies({ kind: "custom", n: 10, unit: "y" }, "20260729", CANDS, 100).map((c) => c.id),
    [101, 102, 103, 104, 105]);
});

test("⑤ prev = 가장 최근 1건 (백엔드 period='prev' 와 같다)", () => {
  const got = hpSlotStudies({ kind: "prev" }, "20260729", CANDS, 100);
  assert.equal(got.length, 1);
  assert.equal(got[0].id, 101);
});

test("⑤ 칸 배정은 hpSlotStudies 목록을 소진해 쓴다 — nth 기반 hpSlotPick 은 없다(죽은 API 금지)", () => {
  // 예전엔 hpSlotPick(slot, anchor, cands, nth) 이 있었지만 **제품 호출자가 0건**이었다.
  // 실제 복원 경로(hpCapture.hpPlanCells)는 슬롯 종류를 가리지 않고 used Set 으로 소진한다 —
  // nth 로 고르면 prev 칸과 '1년 내' 칸에 같은 검사가 뜬다. 뜻이 다른 API 를 남겨 두면 다음 사람이 쓴다.
  const list = hpSlotStudies({ kind: "1y" }, "20260729", CANDS, 100);
  assert.deepEqual(list.map((c) => c.id), [101, 102, 103, 104], "칸은 이 목록을 순서대로 소진한다");
  assert.equal(list[9], undefined, "모자라면 빈 칸");
  assert.equal(hpSlotStudies({ kind: "prev" }, "20260729", CANDS, 100)[1], undefined, "prev 는 1건뿐");
  assert.equal(/export function hpSlotPick/.test(src("../src/lib/hangingProtocol.ts")), false,
    "hpSlotPick 을 되살리려면 hpPlanCells 가 실제로 부르게 하고 소진 규칙을 맞춰라");
});

/* ══════════ ⑥ 장비 목록(고정 금지) ══════════ */

test("⑥ 프리셋은 사용자가 확정한 7종, 사용자 추가분은 뒤에 붙는다", () => {
  assert.deepEqual([...HP_MODALITY_PRESETS], ["DX", "DR", "CR", "MG", "US", "CT", "MR"]);
  assert.deepEqual(hpModalityOptions(["xa", "NM", "CT"]),
    ["DX", "DR", "CR", "MG", "US", "CT", "MR", "XA", "NM"], "대문자 정규화 + 중복 제거");
});

test("⑥ 규칙이 쓰는 장비는 옵션에서 사라지지 않는다(편집기를 여는 순간 빈 값이 되면 안 된다)", () => {
  const rules = [readHpRule({ ...LEGACY_RULE, modality: "OT" })];
  assert.ok(hpModalityOptions([], rules).includes("OT"));
  // 저장할 때도 남는다 — modalities 를 안 남기면 다음에 열었을 때 콤보에서 사라진다
  const saved = writeHpDoc({ rules, modalities: [] });
  assert.ok(saved.modalities.includes("OT"));
  assert.equal(saved.modalities.includes("CT"), false, "프리셋은 중복 저장하지 않는다");
  assert.deepEqual(readHpDoc(saved).modalities, ["OT"]);
});

/* ══════════ 모니터 배치 ══════════ */

test("Setting>모니터 선택으로 화면 배치를 만든다 — 모니터 인덱스가 붙는다", () => {
  const sc = hpScreensFromMonitors([0, 2], { r: 2, c: 2 }, { r: 1, c: 2 });
  assert.deepEqual(sc.map((s) => s.monitor), [0, 2]);
  assert.deepEqual(sc[0].s, { r: 2, c: 2 });
  assert.deepEqual(sc[0].i, { r: 1, c: 2 });
  assert.equal(sc[0].cells.length, 4, "칸 수 = Series layout 칸 수");
  assert.deepEqual(sc[0].cells[0], { series: null, slot: { kind: "current" } });
  // 모니터를 하나만 골랐으면 워크리스트+판독 화면을 하나 덧붙인다(그림 등가)
  const one = hpScreensFromMonitors([1]);
  assert.deepEqual(one.map((s) => s.role), ["viewer", "worklist_report"]);
});

test("Series layout 을 바꾸면 칸 수가 따라온다 — 남는 칸은 잘리고 새 칸은 기본값", () => {
  const r = readHpRule({
    ...LEGACY_RULE,
    screens: [{ id: "s1", role: "viewer", label: "1", monitor: 0, resolution: "",
                s: { r: 1, c: 2 }, i: { r: 1, c: 1 },
                cells: [{ series: 7, slot: { kind: "prev" } }] }],
  });
  assert.equal(r.screens[0].cells.length, 2);
  assert.deepEqual(r.screens[0].cells[0], { series: 7, slot: { kind: "prev" } });
  assert.deepEqual(r.screens[0].cells[1], { series: null, slot: { kind: "current" } });
});

test("슬롯 콤보에 뜰 항목 = 사양 4-2 의 6개 + '현재 검사' — 편집기가 이 목록/라벨을 그대로 쓴다", () => {
  assert.deepEqual(HP_SLOTS, ["current", "prev", "1w", "1m", "1y", "custom", "3d"]);
  assert.deepEqual(HP_SLOTS.map((k) => HP_SLOT_LABEL[k]),
    ["현재 검사", "바로 이전 영상", "1주 내", "1개월 내", "1년 내", "기간 직접 설정", "3D 영상 (아직 미지원)"]);
  // ⚠ 3D 칸은 hpPlanCells 가 skip:"3d" 로 건너뛴다(뷰어가 복원하지 못한다). 라벨이 그 사실을
  //   말해 주지 않으면 사용자는 고르고 저장한 뒤 뷰어를 열어야 '빈 칸'이라는 것을 알게 된다.
  //   3D 를 실제로 붙이는 날 이 라벨과 skip 을 함께 지워라.
  assert.match(HP_SLOT_LABEL["3d"], /미지원/);
  assert.deepEqual(DEFAULT_HP_SLOT, { kind: "current" }, "칸의 기본은 현재 검사(열자마자 남의 날짜가 뜨면 안 된다)");
});

/* ══════════ 사양 5 — 체크박스 5개가 '가로 1열' 이 되는 최소 폭 ══════════ */

test("사양 5 — 체크박스 5개 항목·라벨이 lib 에 있고, 설정 창이 한 줄에 담을 폭을 잡는다", () => {
  assert.deepEqual(HP_OPTION_FIELDS.map((o) => o.key),
    ["use_on_exam_open", "full_link", "full_scroll_sync", "cross_link", "scout_image"]);
  const row = hpOptionRowMinWidth();
  // 창 폭에서 체크박스 행이 못 쓰는 부분(트리·스플리터·패딩·카드 목록…)
  const outside = Object.values(HP_EDITOR_CHROME).reduce((a, b) => a + b, 0);
  // 기본 창 폭 860px 으로는 원리적으로 불가능하다 — 편집 영역이 약 363px 뿐이었다(=2~3줄로 접힘).
  const editable860 = 860 - outside;
  assert.ok(row > editable860, `860px 에서는 한 줄이 될 수 없다 (필요 ${row} > 가능 ${editable860})`);
  // 그래서 행잉 페이지는 hpSettingsMinWidth() 로 연다 — 그 폭이면 실제로 담긴다.
  const editable = hpSettingsMinWidth() - outside;
  assert.ok(editable >= row, `hpSettingsMinWidth 가 한 줄을 담아야 한다 (${editable} < ${row})`);
  // 좌측 트리를 넓히면 창도 그만큼 넓어져야 한다(트리 폭은 사용자가 드래그로 바꾼다)
  assert.ok(hpSettingsMinWidth({ tree: 340 }) > hpSettingsMinWidth({ tree: 190 }));
  // 설정 화면이 그 값을 실제로 쓰는가 — 안 쓰면 계산만 하고 창은 그대로다(죽은 함수 금지)
  assert.match(src("../src/pages/SettingsModal.tsx"), /hpSettingsMinWidth\(\{ tree: treeW \}\)/);
});

test("fitHpCells — 편집기가 Series layout 을 바꿀 때 칸 배열을 맞춘다", () => {
  const cur = [{ series: 1, slot: { kind: "prev" } }, { series: 2, slot: { kind: "1y" } }];
  assert.deepEqual(fitHpCells(cur, { r: 1, c: 1 }), [{ series: 1, slot: { kind: "prev" } }]);
  const grown = fitHpCells(cur, { r: 1, c: 3 });
  assert.equal(grown.length, 3);
  assert.deepEqual(grown[2], { series: null, slot: { kind: "current" } });
  assert.deepEqual(fitHpCells(undefined, { r: 2, c: 2 }).length, 4);
});

test("그리드는 1~10 으로 가둔다(0×0 이면 칸이 사라지고 100×100 이면 브라우저가 죽는다)", () => {
  const r = readHpRule({ ...LEGACY_RULE, s: { r: 0, c: 99 }, i: { r: -3, c: 4 } });
  assert.deepEqual(r.s, { r: 1, c: 10 });
  assert.deepEqual(r.i, { r: 1, c: 4 });
});
