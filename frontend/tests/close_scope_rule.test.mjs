/* All Close(전 모니터 닫기) 규정 회귀 테스트 — lib/viewerClose.ts 의 **원본 구현**을 부른다.
 *
 * 고친 버그(사용자 보고: "All Close 가 모든 모니터를 닫지 않는다")의 원인 3가지를 각각 못 박는다:
 *   ① 전 모니터 전파가 'All Close ✕' 버튼 **하나에만** 붙어 있었다. 사용자가 실제로 뷰어를 닫는
 *      나머지 출구(WORKLIST 버튼 · Esc · 마지막 Exam 탭 ✕ · I-View ⊠Close▸'현재 검사 닫기'로
 *      마지막 검사)는 전부 requestClose() = allMonitors 기본값 false 라 방송이 나가지 않았다.
 *      → decideCloseScope 가 '창이 통째로 닫히는' 모든 출구에서 allMonitors=true 를 줘야 한다.
 *   ② 수신 구독이 뷰어 컴포넌트 **안**에만 있어, 부팅·리로드·에러 화면(뷰어 미마운트)인 창은
 *      방송을 놓쳤다. → ViewerWindow 껍데기가 함께 구독하되 뷰어가 떠 있으면 저장을 기다린다
 *      (closeAllDelayMs). 0 으로 만들면 주석이 유실된다.
 *   ③ 판독창은 수신 경로 자체가 없었다. → 옵션(기본 끔) + 미저장 원고 보호(shouldCloseReportWindow).
 *
 * 되돌림 감지: 아래 단언들은 다음 회귀에서 각각 실패한다 —
 *   · closesWindow 인데 allMonitors 를 false 로 되돌림(= 출구별 하드코딩 부활)
 *   · close_scope 기본값을 'current' 쪽으로 뒤집음
 *   · '이 검사 하나만 닫기'(남은 검사 있음)에까지 전파를 붙임(= 멀쩡한 다른 모니터가 닫힌다)
 *   · Esc 의 확인 강제(forceAsk) 제거(= Esc 오타 한 번에 모니터 3대가 동시에 닫힌다)
 *     또는 반대로 '다른 창이 하나도 없을 때'까지 강제(= 단일 모니터 사용자에게 없던 다이얼로그가
 *     생기고, close_mode='묻지 않기' 설정이 Esc 에서만 무시된다)
 *   · Exam 탭 장부(sv_viewer_tabs) 폐기를 전파 플래그에 다시 묶음(= WORKLIST 한 번에 +Add 로
 *     쌓아 둔 탭이 전부 사라진다 — dropsTabStack 은 All Close 출구에만 붙는다)
 *   · ViewerWindow 안전망이 뷰어 마운트 여부와 무관하게 즉시 닫도록 변경(= 주석 유실)
 *   · 판독창 기본값을 '닫음'으로 바꾸거나 미저장 보호를 제거
 *
 * 실행: node --test frontend/tests/close_scope_rule.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  VIEWER_CLOSE_GRACE_MS,
  VIEWER_CLOSE_HARD_CAP_MS,
  closeAllDelayMs,
  decideCloseScope,
  isViewerClosing,
  isViewerMounted,
  markViewerClosing,
  markViewerMounted,
  resetViewerMounted,
  shouldCloseAllMonitors,
  shouldCloseReportWindow,
  shouldForceCloseNow,
} from "../src/lib/viewerClose.ts";

// ── ① close_scope 판정은 한 곳 ─────────────────────────────────────────────
test("close_scope: 'current' 만 자기 창만 닫는다 (미설정·불명값은 전체)", () => {
  assert.equal(shouldCloseAllMonitors("current"), false);
  assert.equal(shouldCloseAllMonitors("all"), true);
  assert.equal(shouldCloseAllMonitors(undefined), true);   // 미저장 계정 = 전체(기본)
  assert.equal(shouldCloseAllMonitors(null), true);
  assert.equal(shouldCloseAllMonitors(""), true);
});

// ── ② 창이 통째로 닫히는 **모든 출구**가 전파한다 (버그 본체) ──────────────
test("All Close ✕ 이외의 출구도 전 모니터로 전파한다", () => {
  for (const exit of ["all_close", "worklist", "esc", "last_tab"]) {
    const d = decideCloseScope(exit, 0, "all");
    assert.equal(d.closesWindow, true, `${exit}: 창이 닫히는 출구다`);
    assert.equal(d.allMonitors, true, `${exit}: 전 모니터 전파가 빠지면 누른 창만 닫힌다`);
  }
});

test("close_scope='current' 면 어떤 출구도 전파하지 않는다", () => {
  for (const exit of ["all_close", "worklist", "esc", "last_tab", "one_exam"]) {
    assert.equal(decideCloseScope(exit, 0, "current").allMonitors, false, exit);
  }
});

// ── ③ '이 검사 하나만 닫기' — 창이 남으면 절대 전파하지 않는다 ─────────────
test("검사 하나만 닫기: 남은 검사가 있으면 창도 안 닫고 전파도 없다", () => {
  const d = decideCloseScope("one_exam", 2, "all");
  assert.equal(d.closesWindow, false);
  assert.equal(d.allMonitors, false);   // 여기서 전파하면 멀쩡한 다른 모니터가 닫힌다
  assert.equal(d.forceAsk, false);
});

test("검사 하나만 닫기: 그것이 마지막이면 창이 사라지므로 전 모니터 전파", () => {
  for (const remain of [0, -1]) {
    const d = decideCloseScope("one_exam", remain, "all");
    assert.equal(d.closesWindow, true);
    assert.equal(d.allMonitors, true);   // I-View 의 ⊠Close▸'현재 검사 닫기' 마지막 1건 = 창 종료
  }
});

// ── ④ Esc 오발 방어 — 단, '실제로 다른 창이 닫힐 때'로 좁힌다 ───────────────
test("Esc 는 다른 뷰어 창이 함께 닫힐 때만 확인 다이얼로그를 강제한다", () => {
  assert.equal(decideCloseScope("esc", 0, "all", 2).forceAsk, true);     // 다른 모니터 2대 = 되돌릴 수 없다
  assert.equal(decideCloseScope("esc", 0, "current", 2).forceAsk, false); // 자기 창만 = 예전 그대로
  // 단일 모니터(닫힐 다른 창이 0) — 여기서 강제하면 설정을 만진 적 없는 사용자 전원에게
  // (close_scope 기본 'all') 없던 다이얼로그가 새로 생기고, close_mode='묻지 않기'가 무시된다.
  assert.equal(decideCloseScope("esc", 0, "all", 0).forceAsk, false);
  assert.equal(decideCloseScope("esc", 0, "all").forceAsk, false);        // 인자 미주입 = 강제 없음(안전한 쪽)
  // 버튼 경로는 사용자가 명시적으로 누른 것이라 강제하지 않는다(close_mode 설정을 따른다)
  for (const exit of ["all_close", "worklist", "last_tab", "one_exam"]) {
    assert.equal(decideCloseScope(exit, 0, "all", 3).forceAsk, false, exit);
  }
});

// ── ④' 탭 장부 폐기는 '전파'가 아니라 '출구 종류'에 묶인다 ──────────────────
test("Exam 탭 장부(sv_viewer_tabs)는 All Close 로 나갈 때만 버린다", () => {
  assert.equal(decideCloseScope("all_close", 0, "all", 2).dropsTabStack, true);
  // 되돌림 감지: 이 삭제를 다시 allMonitors 에 묶으면 아래 세 출구가 true 가 되고,
  // Related +Add 로 쌓아 둔 Exam 탭이 WORKLIST 한 번에 전부 사라진다(단일 모니터도 동일).
  for (const exit of ["worklist", "esc", "last_tab", "one_exam"]) {
    assert.equal(decideCloseScope(exit, 0, "all", 2).dropsTabStack, false, exit);
  }
  // close_scope='current' 의 All Close 는 이 창만 닫는다 — 장부는 모니터가 공유하므로
  // 여기서 지우면 아직 열려 있는 다른 창들의 탭 복원 근거까지 날아간다(예전 동작 그대로 유지).
  assert.equal(decideCloseScope("all_close", 0, "current").dropsTabStack, false);
  // 요약: dropsTabStack 은 '예전에 지우던 경우(전파되는 닫기)'의 **부분집합**이다.
  // 새로 지우는 경로는 없고, All Close 가 아닌 출구에서만 지우기를 뺐다.
  for (const exit of ["all_close", "worklist", "esc", "last_tab", "one_exam"]) {
    const d = decideCloseScope(exit, 0, "all", 2);
    if (d.dropsTabStack) assert.equal(d.allMonitors, true, exit);
  }
});

// ── ⑤ ViewerWindow 안전망 — 뷰어가 떠 있으면 저장을 기다린다 ───────────────
test("뷰어 미마운트 창(부팅·리로드·에러 화면)은 즉시 닫고, 마운트 중이면 유예", () => {
  assert.equal(closeAllDelayMs(false), 0);                       // 귀머거리 구간 = 즉시
  assert.equal(closeAllDelayMs(true), VIEWER_CLOSE_GRACE_MS);
  assert.ok(VIEWER_CLOSE_GRACE_MS > 0, "0 이면 저장(await) 전에 닫혀 주석이 유실된다");
});

test("안전망은 '저장 중'이면 하드 캡까지 양보한다 (주석 유실 금지)", () => {
  // 뷰어가 방송을 접수해 저장 중 — 첫 만료(1.5초)에서 닫으면 주석이 날아간다
  assert.equal(shouldForceCloseNow(true, VIEWER_CLOSE_GRACE_MS), false);
  assert.equal(shouldForceCloseNow(true, VIEWER_CLOSE_HARD_CAP_MS - 1), false);
  // 하드 캡 — 백엔드가 죽어 await 가 영영 안 끝나는 창을 남기지는 않는다
  assert.equal(shouldForceCloseNow(true, VIEWER_CLOSE_HARD_CAP_MS), true);
  // 뷰어가 마운트는 됐는데 접수를 못 했다(핸들러 사망·구독 유실) → 첫 만료에서 닫는다.
  // 이게 빠지면 '뷰어 로딩…' 창이 그대로 남는 원래 버그로 되돌아간다.
  assert.equal(shouldForceCloseNow(false, VIEWER_CLOSE_GRACE_MS), true);
  assert.ok(VIEWER_CLOSE_HARD_CAP_MS > VIEWER_CLOSE_GRACE_MS);
});

test("markViewerClosing — 뷰어 핸들러 접수 표식", () => {
  resetViewerMounted();
  assert.equal(isViewerClosing(), false);
  markViewerClosing();
  assert.equal(isViewerClosing(), true);
  resetViewerMounted();
  assert.equal(isViewerClosing(), false);
});

test("markViewerMounted 는 중첩(전환기·StrictMode 이중 마운트)을 견딘다", () => {
  resetViewerMounted();
  assert.equal(isViewerMounted(), false);
  const off1 = markViewerMounted();
  const off2 = markViewerMounted();
  assert.equal(isViewerMounted(), true);
  off1();
  assert.equal(isViewerMounted(), true, "하나가 언마운트돼도 남은 뷰어가 있으면 양보해야 한다");
  off2();
  assert.equal(isViewerMounted(), false);
  off2();                                    // 중복 해제도 음수로 내려가지 않는다
  assert.equal(isViewerMounted(), false);
});

// ── ⑥ 판독창 — 기본 닫지 않음 + 미저장 원고 보호 ──────────────────────────
test("판독창은 기본으로 닫지 않고, 켜도 미저장 입력이 있으면 닫지 않는다", () => {
  assert.equal(shouldCloseReportWindow(undefined, false), false);  // 미설정 = 끔
  assert.equal(shouldCloseReportWindow(false, false), false);
  assert.equal(shouldCloseReportWindow(true, true), false);        // 작성 중 원고 보호
  assert.equal(shouldCloseReportWindow(true, false), true);        // 켜짐 + 저장할 것 없음 → 닫는다
});
