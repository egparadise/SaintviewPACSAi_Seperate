/* 음성 판독(STT) 언어(2026-08-11 사용자 확정) — "한글로 쓰다가 영어로 바꿔 말하면 영어로
 * 기록"이 되도록, 마이크 아이콘 옆 언어 칩(클릭)·Alt+L(단축키)로 인식 언어를 전환한다.
 *
 * · 후보 = UI 설정 언어와 같은 10개(코드도 lib/i18n LANGS 와 동일 — Whisper ISO 639-1 그대로).
 * · 사용 집합은 설정>판독>음성 판독에서 **최소 2개** 선택(기본 한국어·영어) —
 *   report.prefs.stt_langs 계정 로밍 + localStorage(sv_stt_langs) 이 PC 미러.
 * · 현재 언어(sv_stt_lang)는 이 PC 전용 — 말하는 도중의 전환 상태라 로밍하지 않는다.
 * · 이 모듈은 react·api 를 모르는 순수 로직(+localStorage 가드) — node 테스트가 직접 부른다.
 *   localStorage 가 없으면(node) 메모리 폴백으로 동작한다.
 */

// 라벨은 IME 한/영 전환키 스타일의 **단일 글리프**(2026-08-11 사용자 확정 — "가"/"A" 처럼
// 하나의 아이콘이 눌리면 현재 언어 글자로 바뀐다). 각 언어의 대표 글자를 쓴다.
export const STT_LANGS: { code: string; label: string; bcp: string }[] = [
  { code: "ko", label: "가", bcp: "ko-KR" },
  { code: "en", label: "A", bcp: "en-US" },
  { code: "ru", label: "Я", bcp: "ru-RU" },
  { code: "zh", label: "中", bcp: "zh-CN" },
  { code: "ja", label: "あ", bcp: "ja-JP" },
  { code: "es", label: "Ñ", bcp: "es-ES" },
  { code: "de", label: "Ä", bcp: "de-DE" },
  { code: "fr", label: "É", bcp: "fr-FR" },
  { code: "vi", label: "Đ", bcp: "vi-VN" },
  { code: "ar", label: "ع", bcp: "ar-SA" },
];

export const STT_DEFAULT_ENABLED = ["ko", "en"];   // 기본: 한국어·영어(사용자 확정)
const LANGS_KEY = "sv_stt_langs";
const CUR_KEY = "sv_stt_lang";

const mem: { langs?: string[]; cur?: string } = {};   // localStorage 부재(node) 폴백
const subs = new Set<() => void>();

function lsGet(k: string): string | null {
  try { return typeof localStorage !== "undefined" ? localStorage.getItem(k) : null; }
  catch { return null; }
}
function lsSet(k: string, v: string): void {
  try { if (typeof localStorage !== "undefined") localStorage.setItem(k, v); } catch { /* 무시 */ }
}
function notify(): void { subs.forEach((f) => f()); }

const valid = (c: unknown): c is string => STT_LANGS.some((l) => l.code === c);

/** 사용 언어 집합 — 최소 2개 보장(미달·손상이면 기본 한/영). */
export function sttEnabled(): string[] {
  const raw = mem.langs ?? (lsGet(LANGS_KEY) ?? "").split(",");
  const ok = raw.filter(valid);
  return ok.length >= 2 ? ok : [...STT_DEFAULT_ENABLED];
}

/** 사용 집합 갱신(설정·report.prefs 로밍 수신) — 2개 미만은 거부(계약). */
export function setSttEnabled(codes: string[]): void {
  const ok = codes.filter(valid);
  if (ok.length < 2) return;
  mem.langs = ok;
  lsSet(LANGS_KEY, ok.join(","));
  if (!ok.includes(sttLang())) setSttLang(ok[0]);   // 현재 언어가 집합 밖이면 첫 언어로
  else notify();
}

export function sttLang(): string {
  const c = mem.cur ?? lsGet(CUR_KEY);
  const en = sttEnabled();
  return valid(c) && en.includes(c) ? c : en[0];
}

export function setSttLang(code: string): void {
  if (!valid(code)) return;
  mem.cur = code;
  lsSet(CUR_KEY, code);
  notify();
}

/** 다음 언어로 순환(칩 클릭·Alt+L) — 새 언어 코드를 돌려준다. */
export function cycleSttLang(): string {
  const en = sttEnabled();
  const next = en[(en.indexOf(sttLang()) + 1) % en.length];
  setSttLang(next);
  return next;
}

export function sttBcp(code: string): string {
  return STT_LANGS.find((l) => l.code === code)?.bcp ?? "ko-KR";
}
export function sttLabel(code: string): string {
  return STT_LANGS.find((l) => l.code === code)?.label ?? "가";
}

export function onSttLang(cb: () => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}

/** Alt+L 전환 단축키 — 창(문서)당 1회만 등록(칩이 여러 개 떠도 한 번만 순환). */
let hotkeyOn = false;
export function initSttHotkey(): void {
  if (hotkeyOn || typeof window === "undefined") return;
  hotkeyOn = true;
  window.addEventListener("keydown", (e) => {
    // Alt+L (한글 자판 'ㅣ' 키 = KeyL). Ctrl/Meta 조합은 다른 단축키와 충돌하므로 제외.
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyL") {
      e.preventDefault();
      cycleSttLang();
    }
  });
}
