/* 판독문 단어 자동 완성(2026-08-11 사용자 확정) — 순수 로직(react·api 무의존, node 직접 테스트).
 *
 * "초성이나 첫음을 보고 예측 단어가 나타나고, 맞으면 Enter 로 완성, 아니면 계속 입력하면
 *  더 가까운 단어로 좁혀진다."
 *
 * · 어휘원: ① 판독자의 템플릿·단축 문장(로컬+SV70 Live) ② 과거 판독문(저장 시 계정 코퍼스로
 *   축적 + 열람한 과거 판독). 어느 것을 쓸지는 설정>판독>문장 자동 완성 '적용 범위'.
 * · 매칭: 접두(prefix) 일치 — 한글은 **초성 전용 입력**(예: "ㅍㄹ")도 각 음절의 초성열로
 *   매칭한다. 영문은 대소문자 무시.
 * · 순위: 빈도 내림차순 → 짧은 단어 우선 → 사전순. 이미 완성된 단어(정확 일치)는 제외.
 */

const CHO = ["ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ", "ㅆ",
             "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"] as const;
const CHO_SET = new Set<string>(CHO);

/** 완성형 한글 음절의 초성(호환 자모) — 그 외 문자는 null. */
export function chosungOf(ch: string): string | null {
  const c = ch.charCodeAt(0);
  if (c >= 0xac00 && c <= 0xd7a3) return CHO[Math.floor((c - 0xac00) / 588)];
  return null;
}

/** 접두가 초성(자음 자모)만으로 구성됐는가 — "ㅍㄹ" 같은 초성 검색 입력. */
export function isChosungOnly(prefix: string): boolean {
  return prefix.length > 0 && [...prefix].every((ch) => CHO_SET.has(ch));
}

/** 단어의 초성열 — 완성형이 아닌 문자가 섞이면 그 문자를 그대로 둔다. */
export function chosungKey(word: string): string {
  return [...word].map((ch) => chosungOf(ch) ?? ch).join("");
}

/** 텍스트 → 단어 목록 — 한글 2음절 이상 · 영문 3자 이상(1~2자는 잡음이 더 많다). */
export function tokenizeWords(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[가-힣]{2,}|[A-Za-z][A-Za-z-]{2,}/g)) out.push(m[0]);
  return out;
}

/** 어휘 사전 구축 — 단어 → 빈도. base 를 주면 그 위에 누적한다. */
export function buildVocab(texts: string[], base?: Map<string, number>): Map<string, number> {
  const v = base ?? new Map<string, number>();
  for (const t of texts) {
    for (const w of tokenizeWords(t)) v.set(w, (v.get(w) ?? 0) + 1);
  }
  return v;
}

/** 계정 코퍼스(report.corpus.words) 누적 — 상위 cap 개만 유지(설정 문서 비대 방지). */
export function mergeVocab(words: Record<string, number>, texts: string[],
                           cap = 3000): Record<string, number> {
  const v = new Map(Object.entries(words).filter(([, n]) => Number.isFinite(n) && n > 0));
  buildVocab(texts, v);
  const top = [...v.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap);
  return Object.fromEntries(top);
}

/** 캐럿 앞의 입력 중인 단어 조각 — 한글 음절·자모(초성 입력)·영문·숫자 연속. */
export function currentPrefix(text: string, caret: number): string {
  const head = text.slice(0, Math.max(0, caret));
  const m = head.match(/[가-힣ㄱ-ㅣA-Za-z0-9-]+$/);
  return m ? m[0] : "";
}

/** 접두 매칭 — 초성 전용이면 초성열, 아니면 일반 startsWith(영문 대소문자 무시). */
export function matchesPrefix(word: string, prefix: string): boolean {
  if (isChosungOnly(prefix)) return chosungKey(word).startsWith(prefix);
  return word.toLowerCase().startsWith(prefix.toLowerCase());
}

/** 예측 후보 — 빈도 desc → 길이 asc → 사전순. 정확 일치는 제외(이미 완성된 단어). */
export function suggestWords(prefix: string, vocab: Map<string, number> | Record<string, number>,
                             limit = 5): string[] {
  if (!prefix) return [];
  const entries = vocab instanceof Map ? [...vocab.entries()] : Object.entries(vocab);
  return entries
    .filter(([w]) => w.toLowerCase() !== prefix.toLowerCase() && matchesPrefix(w, prefix))
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([w]) => w);
}
