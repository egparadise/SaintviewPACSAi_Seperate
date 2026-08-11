/* STT 다국어(2026-08-11 사용자 확정) — "한글로 쓰다가 영어로 바꿔 말하면 영어로 기록".
 *
 * 계약:
 *   · 후보 10개 = UI 설정 언어와 동일 코드(Whisper ISO 639-1 그대로).
 *   · 사용 집합 최소 2개, 기본 한국어·영어. 순환(칩 클릭·Alt+L)은 집합 안에서만.
 *   · 언어는 마이크 옆 칩 **한 벌**(SttLangChip) + 상태는 lib/sttLang **한 곳**.
 *   · 서버 엔진은 전사 시점 언어 적용(녹음 중 전환 반영), 브라우저 엔진은 시작 시점.
 *   · 백엔드는 화이트리스트 밖 언어를 ko 로 폴백(코드가 그대로 Whisper 에 간다).
 *
 * 실행: node --test --experimental-strip-types frontend/tests/stt_lang_rule.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  STT_DEFAULT_ENABLED, STT_LANGS, cycleSttLang, setSttEnabled, setSttLang, sttBcp,
  sttEnabled, sttLabel, sttLang,
} from "../src/lib/sttLang.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");

test("기본·순환 — 한/영 기본, 집합 안에서만 돌고, 2개 미만 설정은 거부", () => {
  assert.deepEqual(STT_DEFAULT_ENABLED, ["ko", "en"]);
  assert.equal(STT_LANGS.length, 10, "UI 설정 언어와 같은 10개");
  assert.deepEqual(sttEnabled(), ["ko", "en"]);
  assert.equal(sttLang(), "ko");
  assert.equal(cycleSttLang(), "en", "한 → EN");
  assert.equal(cycleSttLang(), "ko", "EN → 한 (순환)");

  setSttEnabled(["ja"]);                       // 최소 2개 계약 — 거부
  assert.deepEqual(sttEnabled(), ["ko", "en"]);

  setSttEnabled(["ja", "de", "fr"]);
  assert.deepEqual(sttEnabled(), ["ja", "de", "fr"]);
  assert.equal(sttLang(), "ja", "현재 언어가 집합 밖이면 첫 언어로");
  assert.equal(cycleSttLang(), "de");
  setSttLang("fr");
  assert.equal(sttLang(), "fr");
  setSttEnabled(["ko", "en"]);                 // 복원(모듈 상태 공유 대비)
});

test("표기·BCP 매핑 — 칩 라벨과 브라우저 인식 코드", () => {
  assert.equal(sttLabel("ko"), "가", "IME 전환키 스타일 글리프");
  assert.equal(sttLabel("en"), "A");
  assert.equal(sttBcp("ko"), "ko-KR");
  assert.equal(sttBcp("en"), "en-US");
  assert.equal(sttBcp("없는코드"), "ko-KR", "모르는 코드는 ko 폴백");
});

test("훅 배선 — 브라우저 엔진은 칩 언어로, 서버 엔진은 전사 시점 언어로", () => {
  const s = src("src/lib/useDictation.ts");
  assert.match(s, /rec\.lang = sttBcp\(sttLang\(\)\)/, "Web Speech 언어");
  assert.match(s, /sttTranscribe\(blob, sttLang\(\)\)/, "Whisper/OpenAI 언어 — 전사 시점");
  assert.match(src("src/api.ts"), /fd\.append\("language", lang\)/, "폼 필드로 전송");
});

test("칩 — 모든 마이크(판독창 헤더·뷰어 판독 도크) 옆 + Alt+L 은 창당 1회", () => {
  assert.match(src("src/pages/ReportWindow.tsx"), /<SttLangChip \/>/);
  assert.match(src("src/components/ReportDock.tsx"), /<SttLangChip compact \/>/);
  const lang = src("src/lib/sttLang.ts");
  assert.match(lang, /e\.altKey && !e\.ctrlKey && !e\.metaKey && e\.code === "KeyL"/, "Alt+L(ㅣ)");
  assert.match(lang, /if \(hotkeyOn/, "칩이 여러 개여도 창당 1회 등록");
});

test("설정>판독 '음성 판독' — 최소 2개 체크·로밍(report.prefs.stt_langs)", () => {
  const s = src("src/pages/SettingsModal.tsx");
  assert.ok(s.includes('tr("음성 판독 (STT)")') && s.includes('tr("인식 언어")'));
  assert.match(s, /if \(next\.length < 2\) return;/, "최소 2개 강제");
  assert.match(s, /stt_langs: next/, "report.prefs 로 저장(rdOpts 스프레드)");
  assert.match(src("src/pages/ReportWindow.tsx"), /setSttEnabled\(/, "로밍 수신 → 칩 미러 동기");
});

test("백엔드 — language 파라미터 화이트리스트·폴백, 하드코딩 ko 금지", () => {
  const s = src("../backend/app/api/stt.py");
  assert.match(s, /language: str = Form\("ko"\)/, "폼 파라미터");
  assert.match(s, /_STT_LANGS = \{/, "허용 10개 화이트리스트");
  assert.match(s, /language if language in _STT_LANGS else "ko"/, "허용 밖은 ko 폴백");
  assert.ok(!s.includes('language="ko")  # type'), "전사 호출의 하드코딩 ko 제거");
  assert.equal((s.match(/language=language/g) || []).length >= 2, true, "whisper 두 분기 모두 적용");
});
