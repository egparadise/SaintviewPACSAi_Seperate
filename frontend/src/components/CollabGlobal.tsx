// 워크리스트(포털) 쪽 협진 레이어 — 친구/메신저 도크 + 초대 배너.
//
// 왜 별도 컴포넌트인가: 워크리스트는 모드마다 레이아웃 분기가 셋(기본 / I-View / SaintView)이라
// 도크를 각 분기에 끼워 넣으면 같은 코드를 세 번 쓰게 된다. 화면 오른쪽에 고정 배치하는
// 오버레이 한 장이면 세 레이아웃 어디서든 같게 동작한다.
//
// 협진 '세션'은 영상을 함께 보는 것이므로 **뷰어 창의 일이다**. 여기서는 초대를 받고
// 수락하는 것까지만 하고, 수락하면 그 검사의 뷰어를 연다(그 창의 useCollab 이 이어받는다).
import { useEffect, useState } from "react";
import { VIEWER_BASE, api, type CollabUser } from "../api";
import { collab, type CollabEvent } from "../lib/collab";
import { t as tr } from "../lib/i18n";
import { CollabDock } from "./CollabDock";
import { CollabInviteBanner } from "./CollabSessionPanel";
import { showToast } from "../lib/toast";

type Invite = { code: string; from: CollabUser; title: string; study_uid: string };

/** 워크리스트 도크 폭 — 이 창(오리진) 로컬. 뷰어의 viewer.prefs.collabW 와는 별개다
 *  (워크리스트는 뷰어 prefs 로밍 대상이 아니라 서버 저장 경로가 없다). */
const DOCK_W_KEY = "sv_collab_dock_w";
const DOCK_W_DEFAULT = 300;

/** 뷰어 창 URL — Worklist.openV2 와 같은 계약(?viewer=2d&study=<id>).
 *  창 이름도 같은 규칙을 써서 이미 열려 있는 뷰어 창이 있으면 그 창이 재사용된다. */
function openViewerFor(studyId: number) {
  const base = VIEWER_BASE
    ? `${VIEWER_BASE.replace(/\/$/, "")}/`
    : `${window.location.origin}${window.location.pathname}`;
  window.open(`${base}?viewer=2d&study=${studyId}&mm=0`, "sv_viewer");
}

export function CollabGlobal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [invite, setInvite] = useState<Invite | null>(null);
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [width, setWidth] = useState(() => {
    const v = Number(localStorage.getItem(DOCK_W_KEY));
    return Number.isFinite(v) && v >= 220 && v <= 720 ? v : DOCK_W_DEFAULT;
  });

  useEffect(() => collab.on((e: CollabEvent) => {
    if (e.t === "invite") {
      setInvite({ code: e.code, from: e.from, title: e.title, study_uid: e.study_uid });
    } else if (e.t === "session" && pendingCode === e.d.code) {
      // 수락 → 서버가 참가 처리(+임시 열람권)까지 끝낸 뒤 이 이벤트가 온다.
      // 이제서야 study_id 를 알 수 있다(타 병원 검사는 참가 전에는 조회조차 안 된다).
      setPendingCode(null);
      if (e.d.study_id) openViewerFor(e.d.study_id);
      else showToast(tr("협진에 참여했습니다 — 공유할 검사를 기다리는 중입니다"));
    } else if (e.t === "error" && pendingCode) {
      setPendingCode(null);
    }
  }), [pendingCode]);

  return (
    <>
      <CollabInviteBanner
        invite={invite}
        onAccept={() => {
          if (!invite) return;
          setPendingCode(invite.code);
          collab.enter(invite.code);
          setInvite(null);
        }}
        onDecline={() => {
          if (invite) void api.collabDecline(invite.code).catch(() => { /* 거절 통지 실패는 무해 */ });
          setInvite(null);
        }} />
      {open && (
        // 워크리스트 쪽 도크도 폭을 조절한다. 다만 여기는 고정 오버레이라 뷰어처럼
        // flex 형제 Splitter 를 쓸 수 없어, 왼쪽 경계에 세로 손잡이를 직접 얹는다.
        // 폭은 이 창에만 남긴다(localStorage) — 워크리스트 창은 뷰어 prefs 로밍 대상이 아니다.
        <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 500,
                      display: "flex", boxShadow: "-6px 0 20px rgba(0,0,0,.4)" }}>
          <div title={tr("드래그하면 폭이 바뀝니다 (더블클릭 = 기본 폭)")}
               onDoubleClick={() => setWidth(DOCK_W_DEFAULT)}
               onPointerDown={(e) => {
                 e.preventDefault();
                 let last = e.clientX;
                 const move = (ev: PointerEvent) => {
                   setWidth((w) => Math.min(720, Math.max(220, w - (ev.clientX - last))));
                   last = ev.clientX;
                 };
                 const up = () => {
                   window.removeEventListener("pointermove", move);
                   window.removeEventListener("pointerup", up);
                   setWidth((w) => { localStorage.setItem(DOCK_W_KEY, String(w)); return w; });
                 };
                 window.addEventListener("pointermove", move);
                 window.addEventListener("pointerup", up);
               }}
               style={{ width: 8, cursor: "col-resize", background: "var(--bg-elevated)",
                        borderRight: "1px solid var(--border)", flexShrink: 0 }} />
          <CollabDock open onClose={onClose} width={width} />
        </div>
      )}
    </>
  );
}
