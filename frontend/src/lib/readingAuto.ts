/* 판독 자동화 규칙 — Save 뒤에 무엇을 할 것인가(2026-08-20 사용자 확정).
 *
 * 사용자 요구:
 *   "Setting - 판독 - 기본 설정에 '자동화 규칙' 부분을 만들고
 *      1. Save 버튼을 누르면 바로 다음 Study 열기
 *      2. Save 버튼을 누르면 바로 이전 Study 열기
 *      3. Save : 이후 동작 없음
 *    이렇게 선택할 수 있게."
 *
 * ── 설계 ────────────────────────────────────────────────────────────────
 * ① 세 값 중 **하나만** 고른다. 체크박스 두 개로 두면 '다음도 이전도' 라는 모순된 상태가
 *    만들어질 수 있다 — 그래서 라디오(단일 선택)다. 기본은 "none"(이후 동작 없음).
 * ② **저장에 성공했을 때만** 움직인다. 저장이 실패했는데 화면이 다음 검사로 넘어가면
 *    판독문을 잃는다.
 * ③ 이동할 검사가 없으면(목록의 끝) 아무 일도 하지 않는다 — 조용히 제자리.
 * ④ 기존 `open_next_after_save` 는 **확정(Approve)** 뒤 동작이고 이건 **저장(Save)** 뒤 동작이다.
 *    둘은 다른 버튼이라 함께 켜 두어도 서로를 방해하지 않는다.
 *
 * react·api 무의존 — node 테스트가 직접 부른다.
 */

export type AutoAfterSave = "none" | "next" | "prev";

export const AUTO_AFTER_SAVE_DEFAULT: AutoAfterSave = "none";

/** 라디오 항목 — 사용자가 쓴 문장을 그대로 옮긴다(설정 화면에서 tr 로 감싼다). */
export const AUTO_AFTER_SAVE_ITEMS: { value: AutoAfterSave; label: string }[] = [
  { value: "next", label: "Save 버튼을 누르면 바로 다음 Study 열기" },
  { value: "prev", label: "Save 버튼을 누르면 바로 이전 Study 열기" },
  { value: "none", label: "Save : 이후 동작 없음" },
];

/** 저장값 정리 — 모르는 값·깨진 값은 기본(동작 없음)으로. */
export function readAutoAfterSave(v: unknown): AutoAfterSave {
  return v === "next" || v === "prev" ? v : AUTO_AFTER_SAVE_DEFAULT;
}

/**
 * 저장 뒤 이동 방향 — 판독창 ◀▶ 의 시각 방향으로 돌려준다(▶=1, ◀=-1).
 * 이동하지 않아야 하면 null.
 *
 * @param rule 설정값
 * @param ok   저장이 성공했는가(②)
 */
export function navAfterSave(rule: AutoAfterSave, ok: boolean): 1 | -1 | null {
  if (!ok) return null;
  if (rule === "next") return 1;
  if (rule === "prev") return -1;
  return null;
}
