// 창 간 환자 동기화 — Worklist · Image Viewer · Reading Viewer (BroadcastChannel)
// 한 창에서 환자(검사)가 바뀌면 다른 창들이 같은 환자를 따라간다.

export type SyncSource = "worklist" | "viewer" | "report";
export interface SyncMsg { type: "study"; id: number; src: SyncSource }

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
