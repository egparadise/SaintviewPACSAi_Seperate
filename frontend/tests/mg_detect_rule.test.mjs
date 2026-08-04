/* 2D-MG 맘모 판정(뷰 신호) — 재발 방지 계약.
 *
 * 실제 사고(sv70): 맘모 장비가 **CR 코드**로 보내는 병원에서 검사·시리즈 modality 가 모두 CR →
 * 구 술어(mgPaneIs — modality 만 봄)가 false → 2D-MG(여백 제거·공유 배율·표준 배치)가
 * 체크를 켜도 전혀 돌지 않았다. 스크린샷 증거: 탭 "MG BREAST" · 헤더 "CR, Chest-검진" ·
 * 시리즈 "RCC" — 이름과 뷰 태그에만 맘모 신호가 있다.
 *
 * 계약: 판정은 lib/viewerConfig 의 mgSeriesLooksMammo / mgExamLooksMammo **한 곳**.
 *       적용 여부는 mgCfg.on(선택 시만 — CLAUDE.md)이며 여기서는 판정만 검증한다.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mgExamLooksMammo, mgSeriesLooksMammo } from "../src/lib/viewerConfig.ts";

const S = (over = {}) => ({ modality: "CR", series_desc: "", instances: [], ...over });

test("★ CR 코드 맘모 — 시리즈 설명(RCC/LCC/RMLO/LMLO)으로 잡는다", () => {
  for (const d of ["RCC", "LCC", "RMLO", "LMLO", "R CC", "L MLO"]) {
    assert.equal(mgSeriesLooksMammo(S({ series_desc: d }), "CR"), true, d);
  }
});

test("★ CR 코드 맘모 — 인스턴스 태그(ViewPosition/Laterality)로 잡는다", () => {
  const inst = (vp, lat) => ({ view_position: vp, laterality: lat });
  // 4뷰가 한 시리즈: 태그 2장 이상
  assert.equal(mgSeriesLooksMammo(S({
    series_desc: "BREAST", instances: [inst("CC", "R"), inst("CC", "L"), inst("MLO", "R"), inst("MLO", "L")],
  }), "CR"), true);
  // 뷰별 시리즈(1장짜리): 태그 1장이어도 잡는다
  assert.equal(mgSeriesLooksMammo(S({ series_desc: "S1", instances: [inst("MLO", "L")] }), "CR"), true);
});

test("일반 CR(흉부 등)은 맘모가 아니다 — 오탐 금지", () => {
  assert.equal(mgSeriesLooksMammo(S({ series_desc: "CHEST PA" }), "CR"), false);
  assert.equal(mgSeriesLooksMammo(S({ series_desc: "L-SPINE LAT" }), "CR"), false, "LAT 의 L 로 오탐하면 안 된다");
  assert.equal(mgSeriesLooksMammo(S({ series_desc: "", instances: [{ view_position: "PA" }] }), "CR"), false);
});

test("시리즈 modality 가 MG 면 그것으로 충분하다", () => {
  assert.equal(mgSeriesLooksMammo(S({ modality: "MG", series_desc: "" }), ""), true);
});

test("신호가 없으면 구 계약(mgPaneIs)으로 폴백 — 시리즈 modality 미상이면 검사 modality", () => {
  assert.equal(mgSeriesLooksMammo(S({ modality: "", series_desc: "" }), "MG"), true);
  assert.equal(mgSeriesLooksMammo(S({ modality: "", series_desc: "" }), "CT"), false);
  assert.equal(mgSeriesLooksMammo(null, "MG"), true);
});

test("검사 단위 — 시리즈 중 하나라도 맘모 신호면 맘모 검사", () => {
  assert.equal(mgExamLooksMammo("CR", [S({ series_desc: "RCC" }), S({ series_desc: "LCC" })]), true);
  assert.equal(mgExamLooksMammo("CR", [S({ series_desc: "CHEST PA" })]), false);
  assert.equal(mgExamLooksMammo("MG", []), true, "modality MG 는 시리즈가 없어도 맘모");
  assert.equal(mgExamLooksMammo("", null), false);
});
