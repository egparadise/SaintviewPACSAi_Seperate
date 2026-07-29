// 창 간 환자 동기화 — Worklist · Image Viewer · Reading Viewer (BroadcastChannel)
// 한 창에서 환자(검사)가 바뀌면 다른 창들이 같은 환자를 따라간다.

export type SyncSource = "worklist" | "viewer" | "report";
export interface SyncMsg { type: "study"; id: number; src: SyncSource }
// 다중 모니터 라운드로빈 — 대상 모니터 창만 새 검사를 로드하고, 나머지 뷰어 창은
// 리로드 없이 Exam 탭만 추가하기 위한 브로드캐스트(대상 창은 URL 로 이미 로드됨).
// except: **수신자 주소** — BroadcastChannel 은 같은 오리진 전 창에 뿌리므로 "지금 URL 로 통째로
// 리로드되는 대상 모니터 창"까지 이 메시지를 받는다. 그 창의 (곧 버려질) 문서가 study+seriesTree 를
// 왕복하고 sv_infi_exams 를 다시 써서, 워크리스트 선등록으로 없앤 read-modify-write 경합이 되살아난다.
// 그래서 대상 창 이름을 실어 그 창만 무시하게 한다.
export interface AddTabMsg { type: "viewer-addtab"; id: number; uid: string; label: string; except?: string }
// Exam 탭 ✕ — 공유 탭 레지스트리(sv_viewer_tabs)에서 하나가 빠졌음을 다른 모니터 창에 알린다.
// 없으면 닫은 탭이 그 창에서만 사라지고, 다른 창은 자기 목록에 계속 들고 있다가 리로드 때
// 되살려 놓는다. except 규약은 AddTabMsg 와 동일(발신 창 스스로는 이미 처리했으므로 통상 불필요).
export interface DelTabMsg { type: "viewer-deltab"; id: number; except?: string }

const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("sv_sync") : null;

export function postStudySync(id: number, src: SyncSource) {
  try { channel?.postMessage({ type: "study", id, src } satisfies SyncMsg); } catch { /* 무시 */ }
}

export function onStudySync(self: SyncSource, handler: (id: number, src: SyncSource) => void): () => void {
  if (!channel) return () => {};
  const fn = (e: MessageEvent) => {
    const m = e.data as SyncMsg;
    if (m?.type === "study" && m.src !== self) handler(m.id, m.src);
  };
  channel.addEventListener("message", fn);
  return () => channel.removeEventListener("message", fn);
}

/** 열린 뷰어 창들에 "이 검사를 Exam 탭으로만 추가"(활성 전환·리로드 없음) 요청.
 *  exceptWindowName: 이 검사를 URL 로 직접 로드하는 대상 창 이름(그 창은 무시 — 위 AddTabMsg 주석). */
export function postViewerAddTab(id: number, uid: string, label: string, exceptWindowName?: string) {
  try {
    channel?.postMessage({ type: "viewer-addtab", id, uid, label, except: exceptWindowName } satisfies AddTabMsg);
  } catch { /* 무시 */ }
}

export function onViewerAddTab(handler: (id: number, uid: string, label: string) => void): () => void {
  if (!channel) return () => {};
  const fn = (e: MessageEvent) => {
    const m = e.data as AddTabMsg;
    if (m?.type !== "viewer-addtab") return;
    // 대상 모니터 창은 곧 URL 로 전체 로드된다 → 여기서 또 조회/기록하지 않는다(중복 왕복·레지스트리 경합)
    if (m.except && typeof window !== "undefined" && window.name === m.except) return;
    handler(m.id, m.uid, m.label);
  };
  channel.addEventListener("message", fn);
  return () => channel.removeEventListener("message", fn);
}

/** Exam 탭 ✕ 를 다른 모니터 창에도 전파 — 수신 창은 자기 openTabs 에서 같은 id 를 뺀다.
 *  (공유 레지스트리 자체는 발신 창이 dropPersistedTab 으로 이미 정리한다 — 여기선 화면 정합만.) */
export function postViewerDelTab(id: number, exceptWindowName?: string) {
  try { channel?.postMessage({ type: "viewer-deltab", id, except: exceptWindowName } satisfies DelTabMsg); }
  catch { /* 무시 */ }
}

export function onViewerDelTab(handler: (id: number) => void): () => void {
  if (!channel) return () => {};
  const fn = (e: MessageEvent) => {
    const m = e.data as DelTabMsg;
    if (m?.type !== "viewer-deltab") return;
    if (m.except && typeof window !== "undefined" && window.name === m.except) return;
    handler(m.id);
  };
  channel.addEventListener("message", fn);
  return () => channel.removeEventListener("message", fn);
}

// 다중 모니터 — All Close 시 모든 모니터의 뷰어 창을 함께 닫기(설정 close_scope="all").
// BroadcastChannel 은 자기 자신에게는 전달되지 않으므로, 발신 창은 자체 닫기 흐름으로, 수신 창들은
// onViewerCloseAll 로 각자 닫는다(에코 없음 → 스톰/재귀 없음).
export function postViewerCloseAll() {
  try { channel?.postMessage({ type: "viewer-closeall" }); } catch { /* 무시 */ }
}

// 다운로드 모드 저장본 무효화 — **창을 넘는 신호**.
// 뷰어는 언제나 window.open 으로 뜬 별도 창이라 모듈 상태(dlCache 의 blob URL 캐시)가 창마다
// 따로 논다. 워크리스트 창에서 OPFS 파일을 지워도(SSE 무효화·설정 '지금 비우기') 열려 있는
// 뷰어는 이미 만들어 둔 blob URL 을 계속 반환해 **낡은 영상을 무기한 띄운다**(파일이 지워진 뒤
// 새 <img> 를 붙이면 반대로 깨진 이미지가 된다). 그래서 신호를 창 간으로 만든다.
// 페이로드는 검사 UID 목록이지만(진단용) 수신 측은 통째로 비운다 — 무효화는 드문 사건이고,
// dlCache 는 sop→검사 소속을 모른다. 비운 뒤 재조회가 일어나 화면이 스스로 복구된다.
export function postDlInvalidate(studyUids: string[] = []) {
  try { channel?.postMessage({ type: "dl-invalidate", uids: studyUids }); } catch { /* 무시 */ }
}

export function onDlInvalidate(handler: (uids: string[]) => void): () => void {
  if (!channel) return () => {};
  const fn = (e: MessageEvent) => {
    const m = e.data as { type?: string; uids?: string[] };
    if (m?.type === "dl-invalidate") handler(m.uids ?? []);
  };
  channel.addEventListener("message", fn);
  return () => channel.removeEventListener("message", fn);
}

export function onViewerCloseAll(handler: () => void): () => void {
  if (!channel) return () => {};
  const fn = (e: MessageEvent) => {
    if ((e.data as { type?: string })?.type === "viewer-closeall") handler();
  };
  channel.addEventListener("message", fn);
  return () => channel.removeEventListener("message", fn);
}
