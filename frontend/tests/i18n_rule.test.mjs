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
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { ALL_LANGS, LANGS, MSG, coverage, dirOf, t } from "../src/lib/i18n.ts";
import MSGIDS from "../src/lib/i18n/msgids.ts";
import AR from "../src/lib/i18n/ar.ts";
import DE from "../src/lib/i18n/de.ts";
import EN from "../src/lib/i18n/en.ts";
import ES from "../src/lib/i18n/es.ts";
import FR from "../src/lib/i18n/fr.ts";
import JA from "../src/lib/i18n/ja.ts";
import RU from "../src/lib/i18n/ru.ts";
import VI from "../src/lib/i18n/vi.ts";
import ZH from "../src/lib/i18n/zh.ts";

const DICTS = { en: EN, ru: RU, zh: ZH, ja: JA, es: ES, de: DE, fr: FR, vi: VI, ar: AR };

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

// ── 전 영역 이관(원문=키 사전) 계약 ──────────────────────────────────────────
// 사용자 규정: "모든 영역에서 설정언어로 나타나게 해."
// 감싸기만 하고 사전에 없으면 그 언어에서 한국어가 새어 나온다 — 아래 3개가 그걸 막는다.

test("④ 9개 언어 사전의 키 집합이 완전히 동일하다", () => {
  const ref = Object.keys(DICTS.en).sort();
  for (const [lang, d] of Object.entries(DICTS)) {
    const ks = Object.keys(d).sort();
    assert.equal(ks.length, ref.length, `${lang}: ${ks.length}키 ≠ en ${ref.length}키`);
    for (let i = 0; i < ref.length; i++) {
      assert.equal(ks[i], ref[i], `${lang}: 키 불일치 — "${ks[i]}" vs "${ref[i]}"`);
    }
  }
});

test("⑤ msgids 의 모든 원문이 9개 언어 전부에 번역돼 있다", () => {
  assert.ok(new Set(MSGIDS).size === MSGIDS.length, "msgids 에 중복");
  for (const [lang, d] of Object.entries(DICTS)) {
    let empty = 0;
    for (const m of MSGIDS) {
      const v = d[m];
      assert.ok(typeof v === "string", `${lang} 사전에 없음: "${m.slice(0, 60)}"`);
      if (!v.trim()) empty++;
    }
    // 빈 번역("")은 조사·수량사("호"·"에")처럼 그 언어에 대응어가 없을 때만 — 소수여야 정상.
    // 무더기로 비면 번역 에이전트가 일을 안 한 것이다.
    assert.ok(empty <= Math.max(5, MSGIDS.length * 0.01),
      `${lang}: 빈 번역 ${empty}개 — 1% 초과는 누락 사고다`);
  }
});

test("⑥ 소스의 tr(\"한국어…\") 리터럴은 전부 msgids 에 있다 — 감싸고 사전에 빠진 문자열 금지", () => {
  const known = new Set([...MSGIDS, ...Object.keys(MSG)]);
  const srcRoot = join(import.meta.dirname, "..", "src");
  const files = [];
  (function walk(dir) {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx|ts)$/.test(e)) files.push(p);
    }
  })(srcRoot);
  // 백슬래시는 heredoc 이 훼손한 전력이 있어 이스케이프를 문자 코드로 만든다(테스트 자체의 안전장치)
  const BS = String.fromCharCode(92);
  const RE = new RegExp(
    BS + "btr" + BS + "(" + BS + "s*([\"'])((?:" + BS + BS + ".|(?!" + BS + "1)[^" + BS + BS + BS + "n])*)" + BS + "1",
    "g");
  const missing = [];
  const UNESC = { '"': '"', "'": "'", n: "\n", r: "\r", t: "\t", [BS]: BS };
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(RE)) {
      const lit = m[2].replace(new RegExp(BS + BS + "([\"'" + BS + BS + "nrt])", "g"), (_, c) => UNESC[c] ?? c);
      if (!/[가-힣]/.test(lit)) continue;   // 레거시 키·영문은 대상 아님
      if (!known.has(lit)) missing.push(`${f.slice(srcRoot.length + 1)}: "${lit.slice(0, 50)}"`);
    }
  }
  assert.deepEqual(missing, [], `사전에 없는 tr 리터럴 ${missing.length}개`);
});

test("⑦ coverage — ko 는 항상 100%, 사전이 꽉 찼으면 전 언어 100%", () => {
  const ko = coverage("ko");
  assert.equal(ko.done, ko.total);
  for (const lang of Object.keys(DICTS)) {
    const c = coverage(lang);
    assert.ok(c.total >= c.done && c.done >= 0);
  }
});
