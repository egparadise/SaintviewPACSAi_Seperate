// 뷰어 '닫기'의 단일 규정 — 세 뷰어(Viewer2D = SaintView·T-View, ViewerInfi = I-View)와
// 뷰어 껍데기(ViewerWindow)·판독창(ReportWindow)이 **같은 판정**을 쓰게 하는 순수 함수 모음.
//
// ── 왜 여기로 뽑았나 ────────────────────────────────────────────────────────────
//  ① close_scope(전체/현재 모니터) 판정이 두 뷰어에 서로 다른 저장소로 두 번 하드코딩돼 있었다
//     (Viewer2D: prefs.monitor?.close_scope !== "current" / ViewerInfi: closeScopeRef.current !== "current").
//     한쪽만 고치면 또 갈린다 — 실제로 'All Close 버튼'에만 전파가 붙어 있었던 게 이 갈림의 결과다.
//  ② 더 큰 구멍: **전 모니터 전파가 단 하나의 버튼에만** 붙어 있었다. 사용자가 뷰어를 닫는 나머지
//     출구(WORKLIST 버튼 · Esc · 마지막 Exam 탭 ✕ · I-View ⊠Close▸'현재 검사 닫기'로 마지막 검사)는
//     전부 allMonitors=false 로 요청해 방송이 나가지 않았다 → "누른 창만 닫히고 나머지 모니터는 남는다".
//     이제 '창이 통째로 닫히는' 모든 출구가 decideCloseScope 를 지난다.
//
// ── 고칠 수 없는 경로(명시) ───────────────────────────────────────────────────
//  브라우저 자체 ✕ · Ctrl+W · 창 강제 종료는 **어떤 방법으로도 잡을 수 없다**. beforeunload 에서
//  postMessage 는 가능하지만 리로드·탭 이동과 구별할 방법이 없어(다중 모니터는 검사를 열 때마다
//  대상 창을 리로드한다) 멀쩡한 창까지 닫는 오탐이 된다. 그 경로는 워크리스트의 슬롯 폴링
//  (viewerSlots.decideBaselineRelease)이 사후에 정리할 뿐, 동시 닫기는 지원하지 않는다.

/** All Close 범위 설정(Setting>모니터 close_scope) 판정 — 미저장/불명값은 기본 'all'.
 *  ⚠ 'current' 만 예외다. 기본을 'all' 로 두는 이유: 다중 모니터 벽에서 창 하나만 닫히면
 *     남은 창들이 슬롯 장부에 살아 있어 다음 오픈이 ①부트스트랩 대신 라운드로빈으로 떨어진다. */
export function shouldCloseAllMonitors(closeScope?: string | null): boolean {
  return closeScope !== "current";
}

/** 뷰어 창이 닫히는 '출구' — 사용자가 실제로 쓰는 경로 전부.
 *  all_close  : All Close ✕ 버튼 / I-View ⊠Close▸'모든 검사 닫기'
 *  worklist   : 상단 WORKLIST 버튼 (창을 닫고 워크리스트로 돌아감)
 *  esc        : Esc 계층 초기화의 마지막 단계
 *  last_tab   : 주 검사 Exam 탭 ✕ / Opened 목록 ✕ (= 창이 통째로 닫힘)
 *  one_exam   : '이 검사 하나만 닫기'(I-View ⊠Close▸'현재 검사 닫기', Exam 탭 ✕) — 남은 검사가
 *               있으면 창은 살아 있고, 0 이면 창이 통째로 닫힌다. */
export type CloseExit = "all_close" | "worklist" | "esc" | "last_tab" | "one_exam";

export interface CloseScopeDecision {
  /** 이 출구로 **이 창이 실제로 닫히는가** (닫히지 않으면 전파는 절대 하지 않는다) */
  closesWindow: boolean;
  /** 다른 모니터의 뷰어 창에도 닫기를 전파하는가 (postViewerCloseAll) */
  allMonitors: boolean;
  /** close_mode 설정과 무관하게 확인 다이얼로그를 강제하는가.
   *  Esc 는 계층 초기화의 마지막 단계라 오발이 잦다 — 그 한 번으로 **다른 모니터의 창까지** 동시에
   *  닫히면 되돌릴 방법이 없으므로, 그 경우에만 확인을 강제한다.
   *  ⚠ 조건에 otherLiveViewers>0 이 들어가는 이유: close_scope 는 미저장 기본이 'all' 이라
   *    설정을 만진 적 없는 사용자 전원이 allMonitors=true 다. 그것만 보고 강제하면 **모니터가 한
   *    대뿐이고 닫을 다른 창이 하나도 없는 사용자**까지 Esc 마다 다이얼로그를 보게 되고,
   *    close_mode 를 'ask' 아닌 값(save_current/discard 등)으로 '묻지 말라'고 명시한 설정이
   *    Esc 에서만 무시된다. 실제로 잃을 것이 있을 때(다른 뷰어 창이 살아 있을 때)만 묻는다.
   *  (close_scope="current" 인 Esc 도 예전 그대로 — 자기 창만 닫으므로 확인을 끼얹지 않는다.) */
  forceAsk: boolean;
  /** Exam 탭 장부(localStorage sv_viewer_tabs)를 통째로 버리는가.
   *  ⚠ '전파한다(allMonitors)' **하나에만** 묶지 마라 — 한때 doClose 가 전파 플래그에 이 삭제를
   *    묶어 두어, WORKLIST 버튼·Esc·주 검사 탭 ✕ 로 나가도 Related +Add 로 쌓아 둔 Exam 탭이 전부
   *    날아갔다(모니터가 1대뿐이라 전파의 이득이 없는 배치에서도 손실만 남았다). 장부를 버리는 것은
   *    '창이 닫힌다'가 아니라 **'다 봤으니 전부 치운다'(All Close)** 의 의미다.
   *  ⚠ 그렇다고 출구 종류만 봐도 안 된다 — 이 장부는 **모니터가 공유**한다(mergePersistedTabs).
   *    close_scope='current' 의 All Close 는 이 창만 닫으므로, 지우면 아직 열려 있는 다른 모니터
   *    창들의 탭 복원 근거까지 함께 날아간다. 그래서 '벽 전체가 닫히는 All Close' 로 좁힌다
   *    (= 이 조건은 예전 동작의 부분집합이다 — 새로 지우는 경로는 하나도 없다). */
  dropsTabStack: boolean;
}

/** 닫기 출구 → {창이 닫히나 · 전 모니터로 전파하나 · 확인을 강제하나 · 탭 장부를 버리나}.
 *  remainingTabs      : one_exam 에서만 의미가 있다(그 검사를 뺀 뒤 남는 검사 수).
 *  otherLiveViewers   : **이 창을 뺀** 살아 있는 뷰어 창 수(viewerSlots.otherLiveViewerCount()).
 *                       순수 함수를 유지하려고 호출부가 값을 주입한다. 모르면 0 = 확인 강제 없음
 *                       (= Esc 가 예전과 똑같이 동작하는 안전한 쪽). */
export function decideCloseScope(
  exit: CloseExit,
  remainingTabs: number,
  closeScope?: string | null,
  otherLiveViewers = 0,
): CloseScopeDecision {
  const closesWindow = exit === "one_exam" ? remainingTabs <= 0 : true;
  const allMonitors = closesWindow && shouldCloseAllMonitors(closeScope);
  return {
    closesWindow,
    allMonitors,
    forceAsk: allMonitors && exit === "esc" && otherLiveViewers > 0,
    dropsTabStack: allMonitors && exit === "all_close",
  };
}

// ── 수신 측: '귀머거리 구간' 보강 ───────────────────────────────────────────────
//  All Close 방송의 수신 구독이 Viewer2D/ViewerInfi **안**에만 있으면, ViewerWindow 가 아직
//  뷰어를 마운트하지 않은 창(api.study() 응답 대기 · lazy 청크 다운로드 중 · 에러 화면)은
//  방송을 통째로 놓친다. 다중 모니터는 검사를 열 때마다 대상 창을 URL 로 리로드하므로 이 구간을
//  상시 지나간다 = "All Close 를 눌렀는데 한 창이 '뷰어 로딩…' 상태로 남는다".
//  그래서 ViewerWindow 최상단(로그아웃 리스너 옆)에도 구독을 두되, **뷰어에 양보**한다 —
//  뷰어가 마운트돼 있으면 그쪽이 주석 저장(await api.saveAnnotations)을 끝내고 스스로 닫아야 하고,
//  여기서 먼저 window.close() 하면 주석이 유실된다.

/** 뷰어가 마운트돼 있을 때 ViewerWindow 안전망이 기다려 주는 시간(ms).
 *  저장 왕복(주석 + GSPS)을 덮되, 백엔드가 죽어 있어도 창이 영영 남지는 않을 만큼. */
export const VIEWER_CLOSE_GRACE_MS = 1500;

/** 저장이 아무리 늦어도 여기서는 강제로 닫는다 — 백엔드가 죽어 있으면 뷰어의 await 가 영영
 *  끝나지 않아 '닫히지 않는 창'이 남는다. 주석 유실보다는 낫지만 그 반대도 참이라 넉넉히 잡는다. */
export const VIEWER_CLOSE_HARD_CAP_MS = 15_000;

/** ViewerWindow 수신 핸들러의 window.close() 지연(ms). 0 = 즉시(뷰어 미마운트 = 저장할 것이 없다). */
export function closeAllDelayMs(viewerMounted: boolean): number {
  return viewerMounted ? VIEWER_CLOSE_GRACE_MS : 0;
}

/** 안전망 타이머가 한 번 울렸다 — 지금 강제로 닫아도 되는가?
 *  ⚠ 여기서 무조건 닫으면 저장(await api.saveAnnotations)이 끝나기 전에 문서가 사라져 **주석이
 *    유실된다**. 백엔드가 느린 사이트에서 1.5초는 흔히 넘는다. 그래서 '뷰어가 아직 닫는 중'이면
 *    하드 캡까지 계속 양보하고, 뷰어가 응답 자체를 못 하는 경우(마운트는 됐는데 핸들러가 죽음)에만
 *    첫 만료에서 닫는다. */
export function shouldForceCloseNow(viewerClosing: boolean, waitedMs: number): boolean {
  return !viewerClosing || waitedMs >= VIEWER_CLOSE_HARD_CAP_MS;
}

// 뷰어 컴포넌트 마운트 여부 — ViewerWindow(같은 문서)가 '양보할지 즉시 닫을지' 판단하는 근거.
// React state 가 아니라 모듈 플래그인 이유: 판단하는 쪽(ViewerWindow 의 이펙트 콜백)은 렌더 밖에서
// 돌고, 뷰어는 lazy 청크라 부모가 자식의 마운트를 동기적으로 알 방법이 없다.
let viewerMounted = 0;

/** 뷰어 컴포넌트가 마운트 이펙트에서 부른다. 반환값을 cleanup 으로 그대로 돌려주면 된다.
 *  (StrictMode 이중 마운트·창 하나에 뷰어가 잠시 둘 겹치는 전환기를 위해 카운터) */
export function markViewerMounted(): () => void {
  viewerMounted += 1;
  return () => { viewerMounted = Math.max(0, viewerMounted - 1); };
}

export function isViewerMounted(): boolean { return viewerMounted > 0; }

// 뷰어가 All Close 를 **접수해서 닫는 중**(저장 await 진행 중)인가 — ViewerWindow 안전망이
// '더 기다릴지 강제로 닫을지'를 정하는 근거. 뷰어의 onViewerCloseAll 핸들러가 진입 즉시 세운다.
let viewerClosing = false;

export function markViewerClosing(): void { viewerClosing = true; }
export function isViewerClosing(): boolean { return viewerClosing; }

/** 테스트 전용 — 모듈 플래그 초기화 */
export function resetViewerMounted(): void { viewerMounted = 0; viewerClosing = false; }

// ── 판독창(ReportWindow) ─────────────────────────────────────────────────────
//  '모든 모니터가 한꺼번에 닫힌다'는 기대에는 판독창도 포함되지만, 판독 원고는 뷰어의 주석과 달리
//  자동 저장이 없다 — 작성 중인 창을 임의로 닫으면 원고가 통째로 날아간다.
//  그래서 **기본값은 '닫지 않음'**이고(Setting>모니터 close_report), 켜더라도 미저장 원고가 있으면
//  닫지 않는다. 켰는데 안 닫히는 이유를 사용자가 알 수 있게 호출부가 안내 문구를 띄운다.

/** 판독창을 All Close 방송으로 닫을 것인가.  dirty = 저장하지 않은 판독 입력이 있는가. */
export function shouldCloseReportWindow(closeReport: boolean | undefined, dirty: boolean): boolean {
  return closeReport === true && !dirty;
}
