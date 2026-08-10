/* WORKLIST 창 전면(2026-08-10 사용자 확정) — 세 뷰어(SaintView·T-View = Viewer2D,
 * I-View = ViewerInfi) 어디서든, 워크리스트 창이 다른 창(판독뷰어 등)에 가려져 있으면
 * (같은 모니터든 다른 모니터든) 가장 앞으로 끌어온다.
 *
 * 구현이 named window 재-open 인 이유: 워크리스트 창은 자기 이름을 "sv_worklist" 로 등록한다
 * (Worklist.tsx). 같은 이름으로 window.open("") 하면 브라우저가 **그 창을 raise** 한다 —
 * opener.focus() 는 대부분의 브라우저가 무시하므로 폴백으로만 둔다(I-View 검증 패턴).
 * 워크리스트 창이 정말 닫혀 있으면 빈 창이 새로 열리므로 홈으로 보낸다.
 *
 * ⚠ 구현은 이 함수 한 곳이다 — 뷰어마다 복사하면 반드시 갈린다(2D 분할 사고와 같은 패턴). */
export function focusWorklistWindow(): void {
  try {
    const w = window.open("", "sv_worklist");
    if (w) {
      try {
        if (w.location.href === "about:blank") w.location.href = `${window.location.origin}/`;
      } catch { /* 교차 출처 접근 제약 — 무시 */ }
      w.focus();
      return;
    }
  } catch { /* 무시 — 아래 폴백 */ }
  try {
    if (window.opener && !window.opener.closed) window.opener.focus();
    else window.open("/", "_blank");
  } catch { /* 무시 */ }
}
