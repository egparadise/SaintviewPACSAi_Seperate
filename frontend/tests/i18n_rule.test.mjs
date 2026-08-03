// UI 언어(i18n) 계약 — lib/i18n.ts
//
// 사용자 규정: 설정-환경 최상단에서 언어를 고르면 전체 표기가 그 언어를 따른다.
// 지원 언어는 10개(한글·영어·러시아어·중국어·일본어·스페인어·독일어·프랑스어·베트남어·아랍어).
//
// 여기서 지키는 계약:
//  ① 사전의 **모든 키는 10개 언어를 전부** 채운다 — 일부만 채우면 "영어는 되는데
//     러시아어는 한국어" 같은 반쪽 번역이 생기고, 그건 코드리뷰로는 안 잡힌다.
//  ② 미등록 키·미지원 언어는 **한국어 폴백** — 화면이 키 이름으로 깨지면 안 된다.
//  ③ 아랍어만 RTL — 나머지는 전부 LTR.
import { test } from "node:test";
import assert from "node:assert/strict";

import { ALL_LANGS, LANGS, MSG, dirOf, t } from "../src/lib/i18n.ts";

test("지원 언어는 정확히 10개, 중복 없음", () => {
  assert.equal(LANGS.length, 10);
  assert.equal(new Set(ALL_LANGS).size, 10);
  for (const l of LANGS) assert.ok(l.native.length > 0, `${l.code}: 네이티브 표기가 비었다`);
});

test("① 모든 키가 10개 언어를 전부 채운다 — 반쪽 번역 금지", () => {
  const keys = Object.keys(MSG);
  assert.ok(keys.length >= 30, `사전이 비정상적으로 작다 (${keys.length}키)`);
  for (const k of keys) {
    for (const lang of ALL_LANGS) {
      const v = MSG[k][lang];
      assert.ok(typeof v === "string" && v.trim().length > 0,
        `MSG["${k}"].${lang} 이 비었다 — 키를 추가할 때는 10개 언어를 전부 채운다`);
    }
  }
});

test("② 폴백 — 미등록 키는 키 그대로, 등록 키는 요청 언어 값", () => {
  assert.equal(t("이런키는없다"), "이런키는없다");
  assert.equal(t("language", "en"), "Language");
  assert.equal(t("language", "ar"), "اللغة");
  assert.equal(t("collab", "ko"), "협진");
});

test("③ 아랍어만 RTL", () => {
  for (const lang of ALL_LANGS) {
    assert.equal(dirOf(lang), lang === "ar" ? "rtl" : "ltr", `dirOf(${lang})`);
  }
});

test("번역값에 앞뒤 공백·개행이 없다 — 버튼 라벨이 밀리는 원인", () => {
  for (const [k, e] of Object.entries(MSG)) {
    for (const lang of ALL_LANGS) {
      assert.equal(e[lang], e[lang].trim(), `MSG["${k}"].${lang} 에 앞뒤 공백`);
      assert.ok(!e[lang].includes("\n"), `MSG["${k}"].${lang} 에 개행`);
    }
  }
});
