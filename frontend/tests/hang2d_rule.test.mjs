/* 2D 분할 우선순위 — **불변 규정(CLAUDE.md · 2026-08-04 사용자 확정)** 회귀 테스트.
 * lib/viewerConfig.ts 의 pickHang2d 를 '실제로' 부른다.
 *
 * 규정:
 *   · 네 기능(Common / 뷰어별 / 행잉 / Mammo)은 각기 독립.
 *   · 표 적용 순서는 **Common → 뷰어별** 캐스케이드. 각 표 안에서 전용 행 → '*' 행.
 *   · MG 는 표 밖 — Mammo 규정은 2D-MG 가 **선택되었을 때만**(resolveHang2d 쪽 테스트).
 *   · 구 hanging2d_common_on(양자택일 체크)은 **판정에 쓰지 않는다** — 그 플래그가 false 인
 *     계정에서 Common 표가 통째로 무시되던 것이 "CT 를 열면 설정이 풀려" 증상이었다.
 *
 * 실행: node --test --experimental-strip-types frontend/tests/hang2d_rule.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { HANG2D_ANY, HANG2D_MODS, hang2dViewerKey, migrateHang2d, normHang2d, pickHang2d }
  from "../src/lib/viewerConfig.ts";

const VIEWERS = ["sv", "ty", "infi"];

/** 공통엔 CR·CT, 뷰어별엔 MR — 편집기가 '만진 모달리티만' 쓰기 때문에 키 결손이 기본 상태다. */
const prefs = (commonOn) => ({
  hanging2d: { CR: { s: "1x1", i: "1x1" }, CT: { s: "2x2", i: "1x1" }, MG: { s: "3x3", i: "2x2" } },
  hanging2d_common_on: commonOn,
  hanging2d_by_viewer: {
    sv:   { MR: { s: "3x3", i: "1x1" }, MG: { s: "1x1", i: "2x2" } },
    ty:   { MR: { s: "3x3", i: "1x1" }, MG: { s: "1x1", i: "2x2" } },
    infi: { MR: { s: "3x3", i: "1x1" }, MG: { s: "1x1", i: "2x2" } },
  },
});

test("★ 캐스케이드 — Common 행이 있으면 Common, 없으면 그 뷰어의 행 (구 체크 값과 무관)", () => {
  // 핵심 회귀 방어: hanging2d_common_on=false 로 저장된 계정에서도 Common 표는 살아 있어야 한다.
  for (const commonOn of [true, false, undefined]) {
    const p = prefs(commonOn);
    for (const vk of VIEWERS) {
      assert.deepEqual(pickHang2d(p, vk, "CT"), { s: "2x2", i: "1x1" },
        `${vk} CT — Common 값 (commonOn=${commonOn} 이어도)`);
      assert.deepEqual(pickHang2d(p, vk, "MR"), { s: "3x3", i: "1x1" },
        `${vk} MR — Common 에 없으므로 뷰어별로 내려간다`);
      assert.equal(pickHang2d(p, vk, "US"), null, `${vk} US — 어디에도 없으면 자동`);
    }
  }
});

test("MG 는 언제나 표 밖 — Mammo 는 별도 기능(2D-MG 선택 시만)", () => {
  for (const commonOn of [true, false]) {
    for (const vk of VIEWERS) {
      assert.equal(pickHang2d(prefs(commonOn), vk, "MG"), null,
        `MG 는 2D 분할 표 밖 (commonOn=${commonOn}, ${vk})`);
    }
  }
});

test("진리표 — (공통에 있음/없음) × (뷰어별에 있음/없음), 플래그는 무시", () => {
  const C = { s: "1x2", i: "1x1" }, V = { s: "4x4", i: "1x1" };
  const mk = (commonOn, inCommon, inViewer) => ({
    hanging2d: inCommon ? { CT: C } : {},
    hanging2d_common_on: commonOn,
    hanging2d_by_viewer: { ty: inViewer ? { CT: V } : {} },
  });
  const rows = [
    // 공통에있음, 뷰어별에있음, 기대 — commonOn true/false 모두 같은 결과여야 한다
    [true,  true,  C],   // Common 우선
    [true,  false, C],
    [false, true,  V],   // Common 에 없으면 뷰어별
    [false, false, null],
  ];
  for (const on of [true, false]) {
    for (const [ic, iv, want] of rows) {
      assert.deepEqual(pickHang2d(mk(on, ic, iv), "ty", "CT"), want,
        `commonOn=${on} 공통=${ic} 뷰어별=${iv}`);
    }
  }
});

test("'*'(기타) — 같은 표 안에서 전용 행 다음. Common 의 '*' 는 뷰어별 전용 행보다 우선", () => {
  const p = { hanging2d: { CT: { s: "3x3", i: "1x1" }, "*": { s: "1x2", i: "1x1" } },
              hanging2d_by_viewer: { ty: { US: { s: "4x4", i: "1x1" }, "*": { s: "2x2", i: "1x1" } } } };
  assert.deepEqual(pickHang2d(p, "ty", "CT"), { s: "3x3", i: "1x1" });   // Common 전용 행
  // Common 에 '*' 가 있으면 그 모달리티는 Common 이 이미 정한 것 — 뷰어별로 내려가지 않는다
  assert.deepEqual(pickHang2d(p, "ty", "US"), { s: "1x2", i: "1x1" });
  assert.equal(pickHang2d(p, "ty", "MG"), null, "MG 는 '*' 도 안 먹는다");
  // Common 이 비어 있으면 뷰어별 전용 행 → 뷰어별 '*'
  const q = { hanging2d: {}, hanging2d_by_viewer: { ty: { US: { s: "4x4", i: "1x1" }, "*": { s: "2x2", i: "1x1" } } } };
  assert.deepEqual(pickHang2d(q, "ty", "US"), { s: "4x4", i: "1x1" });
  assert.deepEqual(pickHang2d(q, "ty", "XA"), { s: "2x2", i: "1x1" });
  assert.equal(pickHang2d(q, "sv", "XA"), null, "다른 뷰어의 '*' 로 새면 안 된다");
});

test("구 형식(문자열=Series 만)·빈 값 정규화", () => {
  const p = { hanging2d: { XA: "2x2", NM: "", PT: { s: "", i: "" } } };
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

/* ── 저장본 정리(migrateHang2d) — 캐스케이드 이후엔 이동·승격이 없다 ── */

test("MG 는 편집 목록에 없다 (Mammo = 별도 선택 기능)", () => {
  assert.equal(HANG2D_MODS.includes("MG"), false);
});

test("정리 ① 저장본의 MG 키는 공통·뷰어별 어디서든 제거된다", () => {
  const out = migrateHang2d({ MG: { s: "3x3", i: "2x2" } },
                            { ty: { MG: { s: "1x1", i: "2x2" } } }, true, {});
  assert.equal("MG" in out.common, false);
  assert.equal("MG" in out.byViewer.ty, false);
});

test("정리 ② 캐스케이드에선 맵 간 이동·승격이 없다 — 두 표 모두 읽히므로 '안 읽히는 값' 이 없다", () => {
  const V = { s: "3x3", i: "1x1" };
  for (const on of [true, false]) {
    const out = migrateHang2d({ CR: { s: "1x1", i: "1x1" } },
                              { sv: { MR: V }, infi: { MR: V }, ty: { MR: V } }, on, {});
    assert.equal("MR" in out.common, false, "뷰어별 값을 공통으로 승격하면 안 된다(뷰어별은 뷰어별)");
    assert.deepEqual(out.common.CR, { s: "1x1", i: "1x1" });
    for (const vk of VIEWERS) assert.deepEqual(out.byViewer[vk].MR, V, `${vk} 값 보존`);
    assert.equal(out.pending.length, 0, "승격 안내(pending)도 없다");
    // 규정만으로 MR 이 나온다 — 캐스케이드가 뷰어별을 읽기 때문
    const p = { hanging2d: out.common, hanging2d_by_viewer: out.byViewer };
    for (const vk of VIEWERS) assert.deepEqual(pickHang2d(p, vk, "MR"), V);
  }
});

test("정리 ③ 구 infi_default_layout 은 뷰어별 infi 로 접힌다 — DX·'*' 포함, 빈 값은 제외", () => {
  const out = migrateHang2d({}, {}, false,
    { CT: { s: "2x2", i: "3x3" }, MR: { s: "", i: "" },
      DX: { s: "1x2", i: "1x1" }, "*": { s: "1x2", i: "1x1" } });
  assert.deepEqual(out.byViewer.infi.CT, { s: "2x2", i: "3x3" });
  assert.equal("MR" in out.byViewer.infi, false);   // 빈 값 = 설정 없음 (1x1 로 굳히면 없던 설정이 생긴다)
  assert.deepEqual(out.byViewer.infi.DX, { s: "1x2", i: "1x1" });
  assert.deepEqual(out.byViewer.infi[HANG2D_ANY], { s: "1x2", i: "1x1" });
  assert.deepEqual(out.dropped, []);
  // 사용자가 이미 지정한 뷰어별 값은 구 값이 덮지 않는다
  const keep = migrateHang2d({}, { infi: { CT: { s: "1x1", i: "1x1" } } }, false, { CT: { s: "9x9", i: "1x1" } });
  assert.deepEqual(keep.byViewer.infi.CT, { s: "1x1", i: "1x1" });
});

test("구 I-View 전용 값(infi_default_layout)이 공통·다른 뷰어로 번지면 안 된다", () => {
  const out = migrateHang2d({}, {}, true, { CT: { s: "3x3", i: "1x1" }, MR: { s: "2x2", i: "1x1" } });
  assert.deepEqual(out.common, {}, "I-View 전용 값이 공통 표로 올라가면 세 뷰어가 전부 바뀐다");
  const p = { hanging2d: out.common, hanging2d_by_viewer: out.byViewer };
  for (const vk of ["sv", "ty"]) for (const m of ["CT", "MR"]) assert.equal(pickHang2d(p, vk, m), null, `${vk} ${m}`);
  // infi 는 하위호환으로 살아 있다(뷰어별 infi 로 접혔으므로)
  assert.deepEqual(pickHang2d(p, "infi", "CT"), { s: "3x3", i: "1x1" });
});

test("정리는 멱등 — 두 번 돌려도 더 옮길 것이 없다", () => {
  const a = migrateHang2d({ CR: { s: "1x1", i: "1x1" } }, { ty: { MR: { s: "3x3", i: "1x1" } } }, true,
                          { CT: { s: "2x2", i: "1x1" } });
  const b = migrateHang2d(a.common, a.byViewer, true, {});
  assert.equal(b.moved, 0);
  assert.deepEqual(b.common, a.common);
  assert.deepEqual(b.byViewer, a.byViewer);
});

test("DX 는 2D 분할 표에 있어야 한다 (일반촬영 표준 코드는 CR/DX)", () => {
  assert.ok(HANG2D_MODS.includes("DX"), "DX 가 없으면 DX 검사 계정은 2D 분할을 지정할 방법이 없다");
});
