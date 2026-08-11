// 협진 미디어 시작 가드 — 마이크·카메라·화면 공유를 켤 때마다 **서버가 막고 있는지 먼저
// 확인**하고, 막혀 있으면 시도하지 않고 조치를 알린다.
//
// 왜 훅으로 빼는가: 협진 패널(뷰어)과 협진 도크(워크리스트) 두 곳에 같은 버튼이 있다.
// 두 곳에 따로 쓰면 안내가 갈린다 — MediaPermPanel 을 한 컴포넌트로 공유하는 것과 같은 이유다.
//
// 순서가 중요하다:
//   ① 켤 때만 점검한다(끌 때 점검하면 끄지도 못한다)
//   ② HTTPS·정책 → 그 다음 WebSocket → 그 다음 실제 시도
//      HTTPS 가 아니면 나머지는 전부 그것 때문이라, 한꺼번에 늘어놓으면 관리자가 엉뚱한
//      것부터 고친다(collabPreflight.checkMedia 가 그래서 첫 항목에서 멈춘다)
//   ③ 실패하면 오류를 원인별로 갈라서 '서버 조치'와 '이 PC 에서 해결'을 구분한다
import { useCallback, useState } from "react";
import { api } from "../api";
import type { CollabSeat } from "./collab";
import { collab } from "./collab";
import {
  checkSocket, checkTurn, classifyMediaError, preflightMedia, shouldAlert,
  type BlockItem, type MediaKind,
} from "./collabPreflight";
import { t as tr } from "./i18n";
import { showToast } from "./toast";

/** 서버가 막고 있다는 판정을 **서버에 남긴다**.
 *
 *  화면에만 띄우고 끝내면 관리자에게 닿지 않는다 — 판독의는 "안 돼요" 라고만 말하지
 *  원인 코드를 옮겨 적지 않는다. 서버가 같은 원인을 5분에 한 번만 기록하므로(재연결
 *  루프로 초당 몇 번씩 와도) 여기서는 걸러 내지 않는다.
 *  기록 실패는 삼킨다 — 진단이 안 됐다고 협진을 막으면 본말이 전도된다. */
export function reportServerBlocks(items: BlockItem[]): void {
  for (const it of items) {
    if (!it.serverSide) continue;      // 이 PC 문제는 서버에 남길 이유가 없다
    void api.collabDiagReport(it.code, true, it.title, it.subject ?? "")
      .catch(() => { /* 무해 */ });
  }
}

/** 설정에 넣어 둔 ICE 서버 개수 — TURN 경고 판정용(webrtcMesh 와 같은 저장 키). */
function iceCount(): number {
  try {
    const v = JSON.parse(localStorage.getItem("sv_collab_ice") ?? "[]");
    return Array.isArray(v) ? v.length : 0;
  } catch { return 0; }
}

/** 참가자 중 나와 **다른 병원**이 있나 — 있으면 망이 갈릴 가능성이 크다(TURN 경고). */
export function hasCrossSitePeer(seats: CollabSeat[] | undefined, meId: number): boolean {
  const joined = (seats ?? []).filter((p) => p.state === "joined");
  const mine = joined.find((p) => p.id === meId)?.hospital_id ?? null;
  return joined.some((p) => p.id !== meId && (p.hospital_id ?? null) !== mine);
}

export interface MediaGuard {
  busy: string;
  blocks: BlockItem[];
  dismiss: () => void;
  /** 미디어 시도와 무관하게 알림 창을 띄운다 — 상시 감시 배너의 [조치 보기] 용. */
  showBlocks: (items: BlockItem[]) => void;
  /** 미디어 토글 실행. `turningOn` 이 true 일 때만 사전 점검한다. */
  run: (kind: MediaKind, label: string, turningOn: boolean,
        work: () => Promise<void>) => Promise<void>;
}

export function useMediaGuard(seats?: CollabSeat[], meId = 0): MediaGuard {
  const [busy, setBusy] = useState("");
  const [blocks, setBlocks] = useState<BlockItem[]>([]);
  const dismiss = useCallback(() => setBlocks([]), []);

  const run = useCallback(async (kind: MediaKind, label: string, turningOn: boolean,
                                 work: () => Promise<void>) => {
    if (busy) return;
    setBusy(label);
    try {
      if (turningOn) {
        // ── ① 서버 사전 점검 ──────────────────────────────────────────────
        const pre = await preflightMedia(kind);
        const ws = checkSocket({
          status: collab.status, everOpened: collab.everOpened,
          lastCloseCode: collab.lastCloseCode,
        });
        const stop = [...pre, ...ws].filter((i) => i.blocking);
        if (stop.length) {
          // 시도조차 하지 않는다 — 어차피 실패하고, 실패 오류가 원인을 덮어 버린다
          setBlocks([...pre, ...ws]);
          reportServerBlocks([...pre, ...ws]);
          return;
        }
      }
      // ── ② 실제 시도 ────────────────────────────────────────────────────
      await work();
      // ── ③ 켜졌으면 타 망 경고 ─────────────────────────────────────────
      if (turningOn) {
        const warn = checkTurn(hasCrossSitePeer(seats, meId), iceCount());
        if (warn.length) { setBlocks(warn); reportServerBlocks(warn); }
      }
    } catch (e) {
      const item = classifyMediaError(kind, (e as { name?: string })?.name ?? "",
                                      e instanceof Error ? e.message : String(e));
      if (shouldAlert([item])) { setBlocks([item]); reportServerBlocks([item]); }
      else showToast(`${label} — ${tr(item.title)}`);   // 사용자가 취소한 것 등
    } finally {
      setBusy("");
    }
  }, [busy, seats, meId]);

  return { busy, blocks, dismiss, showBlocks: setBlocks, run };
}
