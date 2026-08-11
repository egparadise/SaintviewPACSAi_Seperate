/* 판독문 단어 자동 완성(2026-08-11 사용자 확정) — 순수 로직 + 배선 계약.
 *
 *  · 초성(ㅍㄹ)·첫 글자 접두로 예측 → Enter 완성 → 계속 입력하면 후보가 좁혀진다.
 *  · 어휘원 = 템플릿 문장 + 과거 판독문(저장 시 계정 코퍼스 누적, 상위 3000 캡).
 *  · 기본 uncheck — 판독창 Word completion 체크와 설정>판독 '문장 자동 완성'이 같은 키.
 *
 * 실행: node --test --experimental-strip-types frontend/tests/word_complete_rule.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildVocab, chosungKey, currentPrefix, isChosungOnly, matchesPrefix, mergeVocab, suggestWords,
  tokenizeWords,
} from "../src/lib/wordComplete.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");

test("토큰화 — 한글 2음절+·영문 3자+ 단어만(1~2자 잡음 제외)", () => {
  assert.deepEqual(tokenizeWords("폐렴 소견. No acute infiltration, 좌 s ab"),
                   ["폐렴", "소견", "acute", "infiltration"]);
});

test("초성 매칭 — 'ㅍㄹ' 로 '폐렴'을 찾는다(사용자 예시)", () => {
  assert.equal(isChosungOnly("ㅍㄹ"), true);
  assert.equal(isChosungOnly("폐ㄹ"), false, "음절이 섞이면 일반 접두");
  assert.equal(chosungKey("폐렴"), "ㅍㄹ");
  assert.equal(matchesPrefix("폐렴", "ㅍㄹ"), true);
  assert.equal(matchesPrefix("폐렴", "폐"), true);
  assert.equal(matchesPrefix("폐렴", "간"), false);
  assert.equal(matchesPrefix("Infiltration", "inf"), true, "영문 대소문자 무시");
});

test("예측·정제 — 빈도 우선, 입력을 이어가면 후보가 좁혀지고, 정확 일치는 제외", () => {
  const v = buildVocab(["폐렴 폐렴 폐부종 폐결절 간낭종", "폐렴 의증"]);
  assert.deepEqual(suggestWords("ㅍ", v, 3), ["폐렴", "폐결절", "폐부종"], "빈도 desc → 길이 asc → 사전순");
  assert.deepEqual(suggestWords("폐부", v, 3), ["폐부종"], "입력 계속 → 좁혀짐");
  assert.deepEqual(suggestWords("폐렴", v, 3), [], "이미 완성된 단어는 제안하지 않는다");
  assert.deepEqual(suggestWords("", v, 3), [], "빈 접두는 무제안");
});

test("캐럿 접두 — 마지막 단어 조각만(공백·구두점 뒤는 새 단어)", () => {
  assert.equal(currentPrefix("No acute inf", 12), "inf");
  assert.equal(currentPrefix("소견: 폐", 6), "폐");
  assert.equal(currentPrefix("소견. ", 6), "", "공백 뒤는 조각 없음");
  assert.equal(currentPrefix("ㅍㄹ", 2), "ㅍㄹ", "초성 입력도 조각");
});

test("코퍼스 누적 — 기존 빈도 위에 더하고 상위 cap 만 유지", () => {
  const w1 = mergeVocab({}, ["폐렴 폐렴 소견"]);
  assert.equal(w1["폐렴"], 2);
  const w2 = mergeVocab(w1, ["폐렴 결절"]);
  assert.equal(w2["폐렴"], 3, "저장할 때마다 누적");
  // 토크나이저는 한글+숫자 혼합을 단어로 안 본다 — 서로 다른 음절로 60개 생성
  const many = mergeVocab({}, [Array.from({ length: 60 }, (_, i) => "단어" + String.fromCharCode(0xac00 + i)).join(" ")], 10);
  assert.equal(Object.keys(many).length, 10, "cap 초과분 버림");
});

test("판독창 배선 — Worklist 체크 옆 토글(기본 uncheck)·Enter 완성·저장 시 누적", () => {
  const s = src("src/pages/ReportWindow.tsx");
  assert.match(s, /Word completion\s*<\/label>\s*<label title=\{tr\("CVR Notice/, "Worklist·CVR 사이 위치");
  assert.match(s, /v\.word_complete === true\) setWcOn\(true\)/, "기본 uncheck — 정확히 true 만");
  assert.match(s, /word_complete: on \}, "user"\)/, "설정과 같은 키로 저장(양방향)");
  assert.match(s, /e\.key === "Enter" && !e\.shiftKey && !e\.nativeEvent\.isComposing\) \{ e\.preventDefault\(\); wcAccept\(\); \}/,
               "제안이 떠 있을 때만 Enter 가 완성으로");
  assert.match(s, /mergeVocab\(/, "저장 시 코퍼스 누적");
  assert.match(s, /suggestWords\(prefix, wcVocab, 5\)/, "입력 변화마다 재예측(좁혀짐)");
});

test("설정>판독 '문장 자동 완성' — 사용·적용 범위(템플릿/과거 판독문)", () => {
  const s = src("src/pages/SettingsModal.tsx");
  assert.ok(s.includes('tr("문장 자동 완성")') && s.includes('tr("적용 범위")'));
  assert.match(s, /rdOpts\.word_complete === true/, "설정 체크 = 같은 키");
  assert.match(s, /\[\["templates", "템플릿"\], \[\"history\", \"과거 판독문\"\]\]/, "범위 2종");
  const st = src("../backend/app/api/settings.py");
  assert.equal((st.match(/"report\.corpus"/g) || []).length >= 2, true, "코퍼스 키 화이트리스트(user 전용)");
});
