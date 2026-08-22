/* Combine 규칙 — Scout(정위) 시리즈 제외 계약(2026-08-20 사용자 확정).
 *
 * 사용자 요구:
 *   "Setting 뷰어 공통에 'Combine 규칙' 항목을 만들고, 체크박스 'Scout Image 제외' 기능을 만들어.
 *    ① 체크되면 Scout Image 가 있는 첫 번째 Series 는 제외하고 두 번째 Series 부터 Combine.
 *    ② 체크박스는 'CT Scout Image 제외' · 'MRI Scout Image 제외' 두 개."
 *
 * 실행: node --test --experimental-strip-types frontend/tests/combine_rule.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  COMBINE_RULE_DEFAULT, dropScoutSeries, knowsImageType, looksScoutByName, readCombineRule, ruleOnFor,
} from "../src/lib/combineRule.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");

const ser = (n, imgs, desc = "") => ({
  series_number: n, series_desc: desc, instances: Array.from({ length: imgs }, (_, i) => i),
});
const nums = (list) => list.map((s) => s.series_number);
const CT_ON = { skip_scout_ct: true, skip_scout_mr: false };

test("기본은 꺼져 있다 — 켜지 않으면 동작이 예전 그대로", () => {
  assert.deepEqual(COMBINE_RULE_DEFAULT, { skip_scout_ct: false, skip_scout_mr: false });
  const list = [ser(1, 2), ser(2, 67), ser(3, 67)];
  assert.strictEqual(dropScoutSeries(list, "CT", COMBINE_RULE_DEFAULT).kept, list,
    "원본 참조 그대로 — 규칙이 꺼져 있으면 아무것도 하지 않는다");
});

test("모달리티별로 따로 켠다 — CT 만 켜면 MR 은 건드리지 않는다", () => {
  assert.equal(ruleOnFor("CT", CT_ON), true);
  assert.equal(ruleOnFor("MR", CT_ON), false);
  assert.equal(ruleOnFor("MRI", { skip_scout_mr: true }), true, "MRI 표기도 받는다");
  assert.equal(ruleOnFor("DX", { skip_scout_ct: true, skip_scout_mr: true }), false,
    "사용자가 지정한 것은 CT·MRI 둘뿐이다");
});

test("① 이름으로 확실한 Scout — 위치와 무관하게 뺀다", () => {
  assert.equal(looksScoutByName({ series_desc: "Scout" }), true);
  assert.equal(looksScoutByName({ series_desc: "LOCALIZER" }), true);
  assert.equal(looksScoutByName({ series_desc: "Topogram 0.6 T20f" }), true);
  assert.equal(looksScoutByName({ image_type: "DERIVED\\SECONDARY\\LOCALIZER" }), true);
  assert.equal(looksScoutByName({ series_desc: "Chest 1.0 B70f" }), false);

  const list = [ser(1, 67, "AX"), ser(2, 2, "Scout"), ser(3, 67, "AX")];
  const { kept, dropped } = dropScoutSeries(list, "CT", CT_ON);
  assert.deepEqual(nums(kept), [1, 3]);
  assert.deepEqual(nums(dropped), [2], "중간에 있어도 진단 영상이 아니다");
});

test("③ 이름이 없어도 맨 앞의 아주 짧은 시리즈는 Scout 으로 본다 — 사용자 그림의 S1(2장)", () => {
  // 그림: S1 2장(COR) · S2 1장 · S3 67장 · S4 67장 — 앞의 짧은 둘을 건너뛰고 S3 부터
  const list = [ser(1, 2), ser(2, 1), ser(3, 67), ser(4, 67)];
  const { kept, dropped } = dropScoutSeries(list, "CT", CT_ON);
  assert.deepEqual(nums(kept), [3, 4], "두 번째(진단) 시리즈부터 결합한다");
  assert.deepEqual(nums(dropped), [1, 2]);
});

test("③ 은 앞쪽에서만 — 진단 시리즈를 지난 뒤의 짧은 시리즈는 건드리지 않는다", () => {
  const list = [ser(1, 67), ser(2, 2), ser(3, 67)];
  assert.deepEqual(nums(dropScoutSeries(list, "CT", CT_ON).kept), [1, 2, 3],
    "중간의 짧은 시리즈는 Scout 이라는 근거가 없다(이름이 있으면 그때 뺀다)");
});

test("③ 은 '훨씬 큰 시리즈가 따로 있을 때'만 — 전부 짧으면 손대지 않는다", () => {
  const list = [ser(1, 2), ser(2, 3), ser(3, 2)];
  assert.deepEqual(nums(dropScoutSeries(list, "CT", CT_ON).kept), [1, 2, 3],
    "짧은 검사(예: 몇 장짜리 촬영)에서 앞 시리즈를 빼면 진단 영상이 사라진다");
});

test("배열 순서가 시리즈 번호와 달라도 '맨 앞'을 옳게 고른다", () => {
  const list = [ser(3, 67), ser(1, 2), ser(2, 67)];
  const { kept, dropped } = dropScoutSeries(list, "CT", CT_ON);
  assert.deepEqual(nums(dropped), [1], "번호 기준으로 맨 앞을 본다");
  assert.deepEqual(nums(kept), [3, 2], "원본 순서는 유지한다(정렬은 호출부가 한다)");
});

test("안전장치 — 규칙 때문에 결합이 불가능해지면 적용하지 않는다", () => {
  const list = [ser(1, 2, "Scout"), ser(2, 67)];
  assert.deepEqual(nums(dropScoutSeries(list, "CT", CT_ON).kept), [1, 2],
    "빼면 1개만 남아 Combine 자체가 안 된다 — 그럴 바엔 예전대로 둔다");
});

test("저장값이 깨져 있어도 화면이 죽지 않는다", () => {
  assert.deepEqual(readCombineRule(null), { skip_scout_ct: false, skip_scout_mr: false });
  assert.deepEqual(readCombineRule({ skip_scout_ct: 1, skip_scout_mr: "y" }),
    { skip_scout_ct: true, skip_scout_mr: true });
});

test("배선 — 설정은 뷰어 공통에, 판정은 lib 한 곳에서만", () => {
  const st = src("src/pages/SettingsModal.tsx");
  const i = st.indexOf('<Group title={tr("Combine 규칙")}>');
  assert.ok(i > 0, "뷰어 공통에 'Combine 규칙' 그룹이 있어야 한다");
  const g = st.slice(i - 200, i + 1400);
  assert.match(g, /page === "viewer"/, "위치는 뷰어 공통(사용자 지정)");
  assert.match(g, /CT Scout Image 제외/);
  assert.match(g, /MRI Scout Image 제외/);
  assert.match(st, /combine: combRule/, "viewer.prefs 에 저장");

  const v2 = src("src/pages/Viewer2D.tsx");
  assert.match(v2, /dropScoutSeries\(\s*raw, detail\.modality, readCombineRule\(prefsRef\.current\.combine\)\)/,
    "Combine 실행이 규칙을 지난다");
  assert.ok(!/SCOUT_DESC_RE|looksScoutByName\s*=/.test(v2),
    "판정 규칙을 뷰어에 복제하면 반드시 갈린다(이 저장소의 반복 사고)");
  assert.match(v2, /tr\("Scout 제외"\)/, "뺀 시리즈를 화면에 알린다(추측 판정이 섞이므로 투명해야 한다)");
});

/* ── 2026-08-21: 서버가 ImageType(0008,0008)을 시리즈마다 실어 준다 ────────────
 * 그전에는 태그가 없어 '맨 앞의 아주 짧은 시리즈' 라는 **추측**에 기댈 수밖에 없었다.
 * 이제 DICOM 이 스스로 밝힌 값을 쓰고, 아는 검사에서는 추측을 아예 쓰지 않는다. */

test("② ImageType 이 LOCALIZER 면 위치와 무관하게 Scout", () => {
  const t = (n, imgs, it) => ({ series_number: n, instances: Array(imgs).fill(0), image_type: it });
  const list = [
    t(1, 2, "ORIGINAL\\PRIMARY\\LOCALIZER"),
    t(2, 67, "ORIGINAL\\PRIMARY\\AXIAL"),
    t(3, 67, "ORIGINAL\\PRIMARY\\AXIAL"),
  ];
  const { kept, dropped } = dropScoutSeries(list, "CT", { skip_scout_ct: true });
  assert.deepEqual(dropped.map((x) => x.series_number), [1]);
  assert.deepEqual(kept.map((x) => x.series_number), [2, 3]);
});

test("★ 태그를 아는 검사에서는 형태 추측을 쓰지 않는다 — 짧은 진단 시리즈를 지킨다", () => {
  const t = (n, imgs, it) => ({ series_number: n, instances: Array(imgs).fill(0), image_type: it });
  // 맨 앞이 2장이지만 DICOM 은 AXIAL 이라고 말한다 — 예전 규칙이라면 빼 버렸을 자리다
  const list = [
    t(1, 2, "ORIGINAL\\PRIMARY\\AXIAL"),
    t(2, 67, "ORIGINAL\\PRIMARY\\AXIAL"),
  ];
  assert.deepEqual(dropScoutSeries(list, "CT", { skip_scout_ct: true }).dropped, [],
    "태그가 'LOCALIZER 아님' 이라고 말하면 장수로 뒤집지 않는다");
  assert.equal(knowsImageType(list), true);
});

test("태그가 없는 검사(구형 데이터)는 종전대로 형태로 추측한다", () => {
  const t = (n, imgs) => ({ series_number: n, instances: Array(imgs).fill(0) });
  const list = [t(1, 2), t(2, 67), t(3, 67)];
  assert.deepEqual(dropScoutSeries(list, "CT", { skip_scout_ct: true }).dropped.map((x) => x.series_number),
    [1], "태그가 실리기 전 데이터에서도 사용자 그림의 S1 은 잡혀야 한다");
  assert.equal(knowsImageType(list), false);
  assert.equal(knowsImageType([{ image_type: "  " }]), false, "공백만 있으면 모르는 것");
});

test("백엔드가 ImageType 을 시리즈에 싣는다 — 로컬·Live 양쪽", () => {
  const REPO = join(ROOT, "..");
  const orth = readFileSync(join(REPO, "backend/app/dicom/orthanc.py"), "utf8");
  const live = readFileSync(join(REPO, "backend/app/services/webpacs_live.py"), "utf8");
  assert.match(orth, /FrameOfReferenceUID;ImageType;/, "요청 태그에 포함");
  assert.match(orth, /"image_type": image_type,/, "시리즈 레벨에 싣는다");
  assert.match(orth, /inst\.pop\("image_type", None\)/,
    "인스턴스마다 들고 있으면 큰 검사에서 트리 응답이 부푼다");
  assert.match(live, /"00080008"/, "Live 는 v2 메타에서 뽑는다");
  assert.match(live, /"image_type":/);
});

/* ── 2026-08-22 전수 점검 ──────────────────────────────────────────────────
 * 설정 이름이 '뷰어 **공통**' 인데 SaintViewer 만 규칙을 따랐다. I-Viewer 는 Combine all 이
 * 따로 구현돼 있어(buildCombined 를 각자 부른다) Scout 이 그대로 맨 앞에 붙었다.
 * 사용자는 같은 체크박스를 켜 두고 뷰어에 따라 다른 결과를 봤다. */

test("★ Combine 을 가진 **모든 뷰어**가 같은 규칙을 지난다", () => {
  const VIEWERS = {
    "SaintViewer(Viewer2D)": "src/pages/Viewer2D.tsx",
    "I-Viewer(ViewerInfi)": "src/pages/ViewerInfi.tsx",
  };
  for (const [label, f] of Object.entries(VIEWERS)) {
    const t = src(f);
    assert.match(t, /dropScoutSeries\(/, `${label}: Combine all 이 규칙을 지나야 한다`);
    assert.match(t, /from "\.\.\/lib\/combineRule"/, `${label}: 판정은 lib 한 곳`);
    assert.match(t, /readCombineRule\(/, `${label}: 같은 설정 키(viewer.prefs.combine)`);
    assert.match(t, /tr\("Scout 제외"\)/, `${label}: 뺀 시리즈를 알린다`);
    assert.ok(!/SCOUT_DESC_RE|looksScoutByName\s*=/.test(t), `${label}: 판정 복제 금지`);
  }
});

