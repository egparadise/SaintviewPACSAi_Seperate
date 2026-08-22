/* 단축키 조합 — 등록·표시·판정을 한 곳에서(2026-08-22 사용자 확정).
 *
 * 사용자 요구:
 *   "판독-단축키 설정은 Alt, Control, 숫자, 알파벳, Alt+알파벳(혹은 숫자), Control+알파벳(혹은 숫자),
 *    Alt+Shift+알파벳(혹은 숫자), Control+Shift+알파벳(혹은 숫자) — **모든 조합이 가능**하도록."
 *
 * ── 그전에는 ────────────────────────────────────────────────────────────
 * 상용구 단축키는 **Alt 고정**이었다. 저장값이 글자 하나("D")뿐이고 화면은 `Alt+D` 로 그렸다.
 * 시스템 단축키(리포트 저장 Ctrl+S 등)는 이미 조합 문자열을 쓰고 있었으니, 상용구만 뒤처져 있었다.
 *
 * ── 표기 ────────────────────────────────────────────────────────────────
 * `Ctrl+Shift+Alt+KEY` **순서 고정**. 순서를 자유롭게 두면 같은 조합이 두 문자열이 되어
 * 중복 검사도 매칭도 새어 나간다.
 *
 * ── 저장 형식과 구값 호환 ───────────────────────────────────────────────
 * 글자 하나만 저장된 옛 항목은 **`Alt+X` 로 읽는다**. 예전 계약이 그랬으므로 그렇게 읽어야
 * 쓰던 단축키가 그대로 동작한다(마이그레이션 없이).
 *
 * 그래서 **수식어 없는 단독 키**(사용자가 새로 요구한 `A`·`1`)는 글자 하나로 저장할 수 없다 —
 * 구값과 구분이 안 되기 때문이다. 저장할 때만 `Key+A` 로 적고, 읽을 때 벗겨서 `A` 로 쓴다.
 * 화면·매칭에서는 언제나 `A` 다(접두사는 저장 형식일 뿐 사용자에게 보이지 않는다).
 *
 * ── ⚠ 수식어 없는 단축키의 위험 ────────────────────────────────────────
 * 사용자가 요구한 대로 `A`·`1` 같은 **단독 키도 등록할 수 있다**. 그런데 판독문을 쓰는 화면에서
 * 그대로 두면 글자를 칠 때마다 상용구가 끼어든다. 그래서 **입력 중(input/textarea/편집영역)에는
 * 수식어 없는 단축키를 발동하지 않는다**. 수식어가 하나라도 있으면 입력 중에도 동작한다
 * (Alt+D 로 상용구를 넣는 것이 이 기능의 본래 쓰임이다).
 *
 * react·DOM 타입 무의존(KeyboardEvent 만 읽는다) — node 테스트가 직접 부른다.
 */

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

/** 표시·비교에 쓰는 키 이름 — 한 글자는 대문자로, 그 밖은 그대로(F2·Enter…). */
export function keyName(key: string): string {
  const k = String(key ?? "");
  return k.length === 1 ? k.toUpperCase() : k;
}

/** 이벤트 → 조합 문자열(Ctrl+Shift+Alt+KEY 순서 고정). */
export function comboOf(e: KeyLike): string {
  return [e.ctrlKey && "Ctrl", e.shiftKey && "Shift", e.altKey && "Alt", keyName(e.key)]
    .filter(Boolean).join("+");
}

/** 수식어 키 자체를 누른 것인가 — 조합을 등록받는 중에는 무시해야 한다. */
export function isModifierKey(key: string): boolean {
  return ["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock", "OS"].includes(String(key ?? ""));
}

/**
 * 저장값 → 정규 조합 문자열.
 * - 빈 값 → ""
 * - 글자 하나("d") → **"Alt+D"**(구 계약 호환)
 * - "alt+shift+d" → "Alt+Shift+D"(순서·대소문자 정규화)
 */
export function normalizeCombo(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  // 수식어 없는 단독 키의 저장 형식 — 접두사를 벗긴다(사용자에게는 보이지 않는다)
  if (/^key\+/i.test(s)) {
    const base = keyName(s.slice(4).trim());
    return base || "";
  }
  if (s.length === 1) return `Alt+${keyName(s)}`;          // 구 저장값
  const parts = s.split("+").map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return "";
  const has = (n: string) => parts.some((p) => p.toLowerCase() === n);
  const rest = parts.filter((p) => !["ctrl", "control", "shift", "alt"].includes(p.toLowerCase()));
  const base = rest.length ? keyName(rest[rest.length - 1]) : "";
  if (!base) return "";                                     // 수식어만 있으면 조합이 아니다
  return [has("ctrl") || has("control") ? "Ctrl" : null, has("shift") ? "Shift" : null,
          has("alt") ? "Alt" : null, base].filter(Boolean).join("+");
}

/** 사람이 읽을 표기 — 저장값을 그대로 보여 주지 말고 이걸 쓴다. */
export function comboLabel(v: unknown): string {
  return normalizeCombo(v);
}

/** 등록 가능한 조합인가. 수식어만 있는 것·빈 값은 안 된다. */
export function isValidCombo(v: unknown): boolean {
  return normalizeCombo(v) !== "";
}

/** 정규형 문자열에 수식어가 붙어 있는가(내부용 — 이미 normalizeCombo 를 지난 값에만 쓴다). */
const normHasMod = (norm: string): boolean => /^(Ctrl|Shift|Alt)\+/.test(norm);

/** 수식어가 하나라도 있는가 — 없으면 '입력 중 발동 금지' 대상이다.
 *  ⚠ 정규화를 **한 번만** 한다. 이미 정규형인 값을 다시 normalizeCombo 에 넣으면
 *    "A"(단독 키의 정규형)가 구값 규칙에 걸려 "Alt+A" 가 되고, 판정이 뒤집힌다(실제 사고). */
export function hasModifier(v: unknown): boolean {
  return normHasMod(normalizeCombo(v));
}

/** 지금 글자를 치고 있는 자리인가(입력칸·편집영역). */
export function targetIsTyping(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * 이 키 입력이 저장된 단축키와 맞는가.
 *
 * @param e       키 이벤트
 * @param stored  저장값(구 단일 문자도 받는다)
 * @param target  이벤트 대상(입력칸 판정용). 없으면 입력 중이 아니라고 본다.
 */
export function matchesCombo(e: KeyLike, stored: unknown, target?: unknown): boolean {
  const want = normalizeCombo(stored);
  if (!want) return false;
  if (isModifierKey(e.key)) return false;
  // ⚠ 수식어 없는 단축키는 글자를 치는 중에는 발동하지 않는다(판독문에 끼어들면 안 된다).
  //   want 는 이미 정규형이므로 **다시 정규화하지 않는다**(위 hasModifier 주석 참조).
  if (!normHasMod(want) && targetIsTyping(target)) return false;
  return comboOf(e) === want;
}

/**
 * 화면에서 만든 조합 → **저장할 문자열**.
 * 수식어가 없으면 `Key+` 를 붙인다 — 글자 하나로 저장하면 구값(=Alt+X)과 구분되지 않는다.
 */
export function storeCombo(combo: unknown): string {
  const raw = String(combo ?? "").trim();
  if (!raw) return "";
  // ⚠ 여기서는 normalizeCombo 를 먼저 거치면 안 된다 — 화면에서 온 "A" 가 구값 규칙에 걸려
  //   "Alt+A" 가 되어 버린다. 이 값은 **방금 사용자가 만든 조합**이므로 구값 규칙 밖이다.
  const hasMod = /(^|\+)\s*(ctrl|control|shift|alt)\s*\+/i.test(raw);
  if (hasMod) return normalizeCombo(raw);
  const base = keyName(raw.replace(/^key\s*\+/i, "").trim());
  return base ? `Key+${base}` : "";
}

/** 같은 조합이 이미 있는가 — 등록 화면에서 알려 주기 위한 것. */
export function findConflict<T extends { shortcut?: string; id?: number; name?: string }>(
  list: T[], combo: unknown, selfId?: number,
): T | null {
  const want = normalizeCombo(combo);
  if (!want) return null;
  return (list ?? []).find((p) => p.id !== selfId && normalizeCombo(p.shortcut) === want) ?? null;
}
