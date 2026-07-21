// 창 간 환자 동기화 — Worklist · Image Viewer · Reading Viewer (BroadcastChannel)
// 한 창에서 환자(검사)가 바뀌면 다른 창들이 같은 환자를 따라간다.

export type SyncSource = "worklist" | "viewer" | "report";
export interface SyncMsg { type: "study"; id: number; src: SyncSource }
// 다중 모니터 라운드로빈 — 대상 모니터 창만 새 검사를 로드하고, 나머지 뷰어 창은
// 리로드 없이 Exam 탭만 추가하기 위한 브로드캐스트(대상 창은 URL 로 이미 로드됨).
export interface AddTabMsg { type: "viewer-addtab"; id: number; uid: string; label: string }

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

/** 열린 뷰어 창들에 "이 검사를 Exam 탭으로만 추가"(활성 전환·리로드 없음) 요청 */
export function postViewerAddTab(id: number, uid: string, label: string) {
  try { channel?.postMessage({ type: "viewer-addtab", id, uid, label } satisfies AddTabMsg); } catch { /* 무시 */ }
}

export function onViewerAddTab(handler: (id: number, uid: string, label: string) => void): () => void {
  if (!channel) return () => {};
  const fn = (e: MessageEvent) => {
    const m = e.data as AddTabMsg;
    if (m?.type === "viewer-addtab") handler(m.id, m.uid, m.label);
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

export function onViewerCloseAll(handler: () => void): () => void {
  if (!channel) return () => {};
  const fn = (e: MessageEvent) => {
    if ((e.data as { type?: string })?.type === "viewer-closeall") handler();
  };
  channel.addEventListener("message", fn);
  return () => channel.removeEventListener("message", fn);
}
