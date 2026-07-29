/* 2D 행잉 우선순위 규정 회귀 테스트 — lib/viewerConfig.ts 의 pickHang2d 를 '실제로' 부른다.
 *
 * 지키는 규정(설정 화면 문구 = 기획 원문):
 *   ① MG 는 언제나 제외 — 맘모는 뷰어 공통 단일 규정(표준 2×2 + mg_hang).
 *   ② 공통 우선 체크 on(키 없음=on): 공통 맵만. 뷰어별은 무시 — 폴백 없음.
 *   ③ 체크 off: 그 뷰어 맵만. 공통은 적용 안 함 — 폴백 없음.
 *
 * 폴백을 되살리면(`commonMap[m] ?? perVMap[m]` 류) 아래 케이스가 실패한다.
 * 실행: node frontend/tests/hang2d_rule.test.mjs   (Node 의 TS 타입 스트리핑으로 원본 .ts 를 그대로 import)
 */
import assert from "node:assert/strict";
import test from "node:test";
import { HANG2D_ANY, HANG2D_MODS, activeHang2dMap, hang2dViewerKey, migrateHang2d, normHang2d, pickHang2d }
  from "../src/lib/viewerConfig.ts";

const VIEWERS = ["sv", "ty", "infi"];

/** 공통엔 CR·CT 만, 뷰어별엔 MR 만 — 편집기가 '만진 모달리티만' 쓰기 때문에 키 결손이 기본 상태다. */
const prefs = (commonOn) => ({
  hanging2d: { CR: { s: "1x1", i: "1x1" }, CT: { s: "2x2", i: "1x1" }, MG: { s: "3x3", i: "2x2" } },
  hanging2d_common_on: commonOn,
  hanging2d_by_viewer: {
    sv:   { MR: { s: "3x3", i: "1x1" }, MG: { s: "1x1", i: "2x2" } },
    ty:   { MR: { s: "3x3", i: "1x1" }, MG: { s: "1x1", i: "2x2" } },
    infi: { MR: { s: "3x3", i: "1x1" }, MG: { s: "1x1", i: "2x2" } },
  },
});

test("② 체크 on — 공통 맵만 적용, 뷰어별은 무시(폴백 없음)", () => {
  const p = prefs(true);
  for (const vk of VIEWERS) {
    assert.deepEqual(pickHang2d(p, vk, "CR"), { s: "1x1", i: "1x1" }, `${vk} CR`);
    assert.deepEqual(pickHang2d(p, vk, "CT"), { s: "2x2", i: "1x1" }, `${vk} CT`);
    // 공통에 없는 MR — 예전 구현은 여기서 뷰어별 3x3 으로 떨어졌다(공통 우선이 무의미해짐)
    assert.equal(pickHang2d(p, vk, "MR"), null, `${vk} MR 은 공통에 없으므로 '설정 없음'`);
    assert.equal(pickHang2d(p, vk, "US"), null, `${vk} US 는 어디에도 없음`);
  }
});

test("③ 체크 off — 그 뷰어 맵만 적용, 공통은 적용 안 함(폴백 없음)", () => {
  const p = prefs(false);
  for (const vk of VIEWERS) {
    assert.deepEqual(pickHang2d(p, vk, "MR"), { s: "3x3", i: "1x1" }, `${vk} MR`);
    // 뷰어별에 없는 CR/CT — 예전 구현은 공통 값으로 떨어졌다
    assert.equal(pickHang2d(p, vk, "CR"), null, `${vk} CR 은 뷰어별에 없으므로 '설정 없음'`);
    assert.equal(pickHang2d(p, vk, "CT"), null, `${vk} CT`);
  }
});

test("① MG 는 체크 on/off·뷰어와 무관하게 언제나 제외(맘모는 뷰어 공통 mg_hang 규정)", () => {
  for (const commonOn of [true, false]) {
    for (const vk of VIEWERS) {
      assert.equal(pickHang2d(prefs(commonOn), vk, "MG"), null,
        `MG 는 2D 행잉 표 밖 (commonOn=${commonOn}, ${vk})`);
    }
  }
});

test("키 없음(hanging2d_common_on 미저장) = 체크 on — 구 계정이 전 모달리티 자동으로 떨어지면 안 된다", () => {
  const p = { hanging2d: { CR: { s: "2x2", i: "1x1" } }, hanging2d_by_viewer: { ty: { CR: { s: "4x4", i: "1x1" } } } };
  assert.deepEqual(pickHang2d(p, "ty", "CR"), { s: "2x2", i: "1x1" });
});

test("4×3 진리표 — (체크 on/off) × (공통만/뷰어별만/양쪽/양쪽없음)", () => {
  const C = { s: "1x2", i: "1x1" }, V = { s: "4x4", i: "1x1" };
  const mk = (commonOn, inCommon, inViewer) => ({
    hanging2d: inCommon ? { CT: C } : {},
    hanging2d_common_on: commonOn,
    hanging2d_by_viewer: { ty: inViewer ? { CT: V } : {} },
  });
  const rows = [
    // commonOn, 공통에있음, 뷰어별에있음, 기대
    [true,  true,  true,  C],
    [true,  true,  false, C],
    [true,  false, true,  null],   // ← 폴백 금지 (공통 켰는데 뷰어별이 먹던 버그)
    [true,  false, false, null],
    [false, true,  true,  V],
    [false, true,  false, null],   // ← 폴백 금지 (공통 껐는데 공통이 먹던 버그)
    [false, false, true,  V],
    [false, false, false, null],
  ];
  for (const [on, ic, iv, want] of rows) {
    assert.deepEqual(pickHang2d(mk(on, ic, iv), "ty", "CT"), want,
      `commonOn=${on} 공통=${ic} 뷰어별=${iv}`);
  }
});

test("읽히는 맵의 키 집합만 — 반대쪽 키가 섞이면 '무시'가 깨진다(ViewerInfi defMap 루프)", () => {
  assert.deepEqual(Object.keys(activeHang2dMap(prefs(true), "infi")).sort(), ["CR", "CT", "MG"]);
  assert.deepEqual(Object.keys(activeHang2dMap(prefs(false), "infi")).sort(), ["MG", "MR"]);
});

test("구 형식(문자열=Series 만)·빈 값 정규화", () => {
  const p = { hanging2d: { XA: "2x2", NM: "", PT: { s: "", i: "" } }, hanging2d_common_on: true };
  assert.deepEqual(pickHang2d(p, "sv", "XA"), { s: "2x2" });   // Image 는 미지정 → 자동
  assert.equal(pickHang2d(p, "sv", "NM"), null);
  assert.equal(pickHang2d(p, "sv", "PT"), null);
  assert.equal(normHang2d(undefined), null);
});

test("스킨 → 맵 키 산출은 한 곳에서만 (SaintView·T-View 는 엔진 공유·맵 분리)", () => {
  assert.equal(hang2dViewerKey("saint"), "sv");
  assert.equal(hang2dViewerKey("sv"), "sv");
  assert.equal(hang2dViewerKey("ty"), "ty");
  assert.equal(hang2dViewerKey(undefined), "ty");
  assert.equal(hang2dViewerKey("infi"), "infi");
});

/* ── 저장본 1회 정리(migrateHang2d) — 폴백을 없애면 화면이 바뀌는 계정을 위한 이관 ── */

test("MG 는 편집 목록에 없다 (맘모 = 뷰어 공통 mg_hang 단일 규정)", () => {
  assert.equal(HANG2D_MODS.includes("MG"), false);
});

test("정리 ① 저장본의 MG 키는 공통·뷰어별 어디서든 제거된다", () => {
  const out = migrateHang2d({ MG: { s: "3x3", i: "2x2" } },
                            { ty: { MG: { s: "1x1", i: "2x2" } } }, true, {});
  assert.equal("MG" in out.common, false);
  assert.equal("MG" in out.byViewer.ty, false);
});

test("정리 ② 체크 on — 세 뷰어 값이 같을 때만 공통으로 승격(그때만 아무 화면도 안 바뀐다)", () => {
  const V = { s: "3x3", i: "1x1" };
  const out = migrateHang2d({ CR: { s: "1x1", i: "1x1" } }, { sv: { MR: V }, infi: { MR: V }, ty: { MR: V } }, true, {});
  assert.deepEqual(out.common.MR, V);
  assert.deepEqual(out.common.CR, { s: "1x1", i: "1x1" });   // 이미 있던 공통 값은 안 건드린다
  assert.equal(out.pending.length, 0);
  // 승격 뒤에는 규정만으로 같은 결과가 나온다
  for (const vk of VIEWERS) {
    assert.deepEqual(pickHang2d({ hanging2d: out.common, hanging2d_common_on: true,
                                  hanging2d_by_viewer: out.byViewer }, vk, "MR"), V);
  }
});

test("정리 ② 체크 on — 한 뷰어에만 있던 값은 승격하지 않는다(나머지 두 뷰어는 원래 '자동'이었다)", () => {
  const out = migrateHang2d({}, { sv: { MR: { s: "3x3", i: "1x1" } } }, true, {});
  assert.equal("MR" in out.common, false, "설정이 없던 ty·infi 까지 바꾸면 안 된다");
  assert.deepEqual(out.byViewer.sv.MR, { s: "3x3", i: "1x1" }, "값은 지우지 않는다 — 체크를 해제하면 다시 산다");
  assert.deepEqual(out.pending.map((p) => [p.m, p.cur.map((x) => x.v), p.auto]),
                   [["MR", ["sv"], ["infi", "ty"]]], "안내에 모달리티·뷰어를 찍어 사용자가 정하게 한다");
  const p = { hanging2d: out.common, hanging2d_common_on: true, hanging2d_by_viewer: out.byViewer };
  for (const vk of VIEWERS) assert.equal(pickHang2d(p, vk, "MR"), null);
});

test("정리 ② 뷰어마다 값이 다르면 임의로 하나를 골라 승격하지 않는다", () => {
  const out = migrateHang2d({}, { sv: { CT: { s: "2x2", i: "1x1" } }, infi: { CT: { s: "3x3", i: "1x1" } },
                                  ty: { CT: { s: "2x2", i: "1x1" } } }, true, {});
  assert.equal("CT" in out.common, false);
  assert.equal(out.pending.length, 1);
  assert.deepEqual(out.pending[0].cur.map((x) => `${x.v}:${x.s}`), ["sv:2x2", "infi:3x3", "ty:2x2"]);
});

test("정리 ② 체크 off — 폴백으로 적용되던 공통 값을 세 뷰어에 복사", () => {
  const out = migrateHang2d({ CT: { s: "2x2", i: "1x1" } }, { ty: { CT: { s: "4x4", i: "1x1" } } }, false, {});
  assert.deepEqual(out.byViewer.ty.CT, { s: "4x4", i: "1x1" });   // 뷰어별 값이 우선(덮어쓰지 않는다)
  assert.deepEqual(out.byViewer.sv.CT, { s: "2x2", i: "1x1" });
  assert.deepEqual(out.byViewer.infi.CT, { s: "2x2", i: "1x1" });
  assert.equal(out.pending.length, 0);   // 체크 off 복사는 어느 뷰어의 화면도 바꾸지 않는다
});

test("정리 ③ 구 infi_default_layout 은 뷰어별 infi 로 접힌다 — DX·'*' 포함, 빈 값은 제외", () => {
  const out = migrateHang2d({}, {}, false,
    { CT: { s: "2x2", i: "3x3" }, MR: { s: "", i: "" },
      DX: { s: "1x2", i: "1x1" }, "*": { s: "1x2", i: "1x1" } });
  assert.deepEqual(out.byViewer.infi.CT, { s: "2x2", i: "3x3" });
  assert.equal("MR" in out.byViewer.infi, false);   // 빈 값 = 설정 없음 (1x1 로 굳히면 없던 설정이 생긴다)
  // DX·'*' 는 구 I-View 편집기(CT/MR/CR/DX/US/XA/*)의 행이었다 — 접지 않으면 값만 남고 아무도 안 읽는다
  assert.deepEqual(out.byViewer.infi.DX, { s: "1x2", i: "1x1" });
  assert.deepEqual(out.byViewer.infi[HANG2D_ANY], { s: "1x2", i: "1x1" });
  assert.deepEqual(out.dropped, []);
  // 사용자가 이미 지정한 뷰어별 값은 구 값이 덮지 않는다
  const keep = migrateHang2d({}, { infi: { CT: { s: "1x1", i: "1x1" } } }, false, { CT: { s: "9x9", i: "1x1" } });
  assert.deepEqual(keep.byViewer.infi.CT, { s: "1x1", i: "1x1" });
});

test("정리 ③ 체크 off — 공통 값이 구 infi_default_layout 보다 우선(배포본 폴백 순서)", () => {
  // 배포본 ViewerInfi: 뷰어별 → 공통 → infi_default_layout. 구 값을 먼저 접으면 I-View 만 다르게 뜬다.
  const out = migrateHang2d({ CT: { s: "2x2", i: "1x1" } }, {}, false, { CT: { s: "9x9", i: "1x1" } });
  assert.deepEqual(out.byViewer.infi.CT, { s: "2x2", i: "1x1" });
});

test("구 I-View 전용 값(infi_default_layout)이 SaintView·T-View 로 번지면 안 된다", () => {
  // 변경 전에 이 키를 읽는 코드는 ViewerInfi 한 곳뿐이었다 — sv/ty 는 이 값을 본 적이 없다.
  const out = migrateHang2d({}, {}, true, { CT: { s: "3x3", i: "1x1" }, MR: { s: "2x2", i: "1x1" } });
  assert.deepEqual(out.common, {}, "I-View 전용 값이 공통 표로 올라가면 세 뷰어가 전부 바뀐다");
  const p = { hanging2d: out.common, hanging2d_common_on: true, hanging2d_by_viewer: out.byViewer };
  for (const vk of ["sv", "ty"]) for (const m of ["CT", "MR"]) assert.equal(pickHang2d(p, vk, m), null, `${vk} ${m}`);
  assert.deepEqual(out.pending.map((x) => x.m).sort(), ["CT", "MR"]);
});

test("정리는 멱등 — 두 번 돌려도 더 옮길 것이 없다", () => {
  const a = migrateHang2d({ CR: { s: "1x1", i: "1x1" } }, { ty: { MR: { s: "3x3", i: "1x1" } } }, true,
                          { CT: { s: "2x2", i: "1x1" } });
  const b = migrateHang2d(a.common, a.byViewer, true, {});
  assert.equal(b.moved, 0);
  assert.deepEqual(b.common, a.common);
  assert.deepEqual(b.byViewer, a.byViewer);
});

/* ── '공통 우선 적용' 체크 토글 — 저장 직전 재정리가 없으면 행잉이 전멸한다 ── */

/** 설정 화면이 하는 일 그대로: 체크를 뒤집고 그 상태로 다시 정리한 뒤 저장. */
const toggleAndSave = (prefs, nextOn) => {
  const mig = migrateHang2d(prefs.hanging2d ?? {}, prefs.hanging2d_by_viewer ?? {}, nextOn, {});
  return { hanging2d: mig.common, hanging2d_common_on: nextOn, hanging2d_by_viewer: mig.byViewer };
};

test("체크 on→off 토글 후에도 pickHang2d 결과가 유지된다(공통만 있던 구 계정)", () => {
  const CT = { s: "2x2", i: "1x1" };
  // hanging2d_common_on 미저장 = on. 로드 시 정리는 아무것도 옮기지 않는다(공통이 이미 읽히는 맵).
  const loaded = migrateHang2d({ CT }, {}, true, {});
  assert.equal(loaded.moved, 0);
  const after = toggleAndSave({ hanging2d: loaded.common, hanging2d_by_viewer: loaded.byViewer }, false);
  for (const vk of VIEWERS) assert.deepEqual(pickHang2d(after, vk, "CT"), CT, `${vk} — 체크 해제로 초기화되면 안 된다`);
});

test("체크 off→on 토글 후에도 pickHang2d 결과가 유지된다(세 뷰어가 같은 값)", () => {
  const CT = { s: "4x4", i: "1x1" };
  const before = { hanging2d: {}, hanging2d_common_on: false,
                   hanging2d_by_viewer: { sv: { CT }, infi: { CT }, ty: { CT } } };
  const after = toggleAndSave(before, true);
  for (const vk of VIEWERS) assert.deepEqual(pickHang2d(after, vk, "CT"), CT, `${vk} — 체크로 초기화되면 안 된다`);
});

test("체크를 왕복(on→off→on)해도 값이 사라지지 않는다", () => {
  const start = { hanging2d: { CT: { s: "2x2", i: "1x1" }, MR: { s: "3x3", i: "1x1" } },
                  hanging2d_common_on: true, hanging2d_by_viewer: {} };
  const back = toggleAndSave(toggleAndSave(start, false), true);
  assert.deepEqual(back.hanging2d, start.hanging2d);
  for (const vk of VIEWERS) assert.deepEqual(pickHang2d(back, vk, "MR"), { s: "3x3", i: "1x1" });
});

/* ── ④ '기타(전체)' 행 — 같은 맵 안에서만 나머지 모달리티를 받는다 ── */

test("④ '*' 는 같은 맵 안에서만 폴백한다 (맵을 건너뛰면 ②③ 위반)", () => {
  assert.ok(HANG2D_MODS.includes(HANG2D_ANY), "'기타(전체)' 행이 편집기에 있어야 다시 지정할 수 있다");
  const p = { hanging2d: { CT: { s: "3x3", i: "1x1" }, "*": { s: "1x2", i: "1x1" } },
              hanging2d_common_on: true,
              hanging2d_by_viewer: { ty: { "*": { s: "4x4", i: "1x1" } } } };
  assert.deepEqual(pickHang2d(p, "ty", "CT"), { s: "3x3", i: "1x1" });   // 자기 행이 우선
  assert.deepEqual(pickHang2d(p, "ty", "US"), { s: "1x2", i: "1x1" });   // 행이 없으면 같은 맵의 '*'
  assert.equal(pickHang2d(p, "ty", "MG"), null);                          // ① MG 는 '*' 도 안 먹는다
  const off = { ...p, hanging2d_common_on: false };
  assert.deepEqual(pickHang2d(off, "ty", "US"), { s: "4x4", i: "1x1" });  // 체크 off 면 그 뷰어의 '*'
  assert.equal(pickHang2d(off, "sv", "US"), null);                        // 공통의 '*' 로 떨어지지 않는다
});

test("DX 는 2D 행잉 표에 있어야 한다 (일반촬영 표준 코드는 CR/DX)", () => {
  assert.ok(HANG2D_MODS.includes("DX"), "DX 가 없으면 DX 검사 계정은 2D 행잉을 지정할 방법이 없다");
});
