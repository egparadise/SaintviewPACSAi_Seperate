// 협진 뷰어 훅 — Viewer2D 에 붙는 단일 진입점.
//
// Viewer2D 는 5,000줄이 넘는다. 협진 로직을 그 안에 흩뿌리면 두 기능이 서로를 망가뜨린다.
// 그래서 미러 송출·수신·세션 수명·원격 커서를 전부 여기로 모으고, 뷰어 쪽 수정은
//   ① 이 훅 호출 ② 읽기전용 오버레이 1개 ③ 키보드 가드 1줄 ④ 우측 패널 렌더
// 네 곳으로 끝낸다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type CollabSession, type CollabUser } from "../api";
import { collab, type CollabEvent } from "./collab";
import {
  encodeSnapshot, makeThrottle, sameSnapshot,
  type CollabCursor, type CollabSnapshot, type MirrorSource,
} from "./collabState";
import { showToast } from "./toast";

/** 미러 송출 주기(ms) — 10Hz. 사람이 마우스로 움직이는 화면에는 충분히 매끄럽고,
 *  스냅샷 2~4KB × 10 = 초당 20~40KB 로 대역폭도 무시할 수준이다. */
const MIRROR_MS = 100;
/** 커서는 더 자주 — 상대가 "여기 보세요" 하고 가리키는 동작이라 지연이 바로 느껴진다 */
const CURSOR_MS = 60;

export interface RemoteCursor extends CollabCursor {
  id: number;
  name: string;
  at: number;      // 마지막 수신 시각 — 오래된 커서는 지운다
}

export interface CollabInvite {
  code: string; from: CollabUser; title: string; study_uid: string;
}

export interface UseCollab {
  session: CollabSession | null;
  isHost: boolean;
  meId: number;
  /** 이 창의 조작이 잠겨 있나 — 세션 중이고 내가 제어권자가 아니면 true */
  readOnly: boolean;
  cursors: RemoteCursor[];
  invite: CollabInvite | null;
  /** 세션 개설 → 만들어진 세션(실패 시 null). 곧바로 초대하려면 이 반환값의 code 를 쓴다
   *  (setSession 은 비동기라 직후의 inviteUser 는 아직 null 인 session 을 본다). */
  startSession: (title?: string) => Promise<CollabSession | null>;
  inviteUser: (u: CollabUser, code?: string) => Promise<void>;
  acceptInvite: () => void;
  declineInvite: () => void;
  leaveSession: () => Promise<void>;
  /** 마우스가 움직였다 — 페인 내 정규화 좌표(0~1) */
  sendCursor: (pid: string, x: number, y: number) => void;
}

export function useCollab(opts: {
  /** 지금 뷰어가 보고 있는 검사 id */
  studyId: number;
  /** 매 렌더의 최신 뷰어 상태 — 훅이 알아서 변경분만 보낸다 */
  source: MirrorSource;
  /** 수신 스냅샷을 뷰어 상태로 반영 */
  applySnapshot: (s: CollabSnapshot) => void;
}): UseCollab {
  const { studyId, source, applySnapshot } = opts;
  const [session, setSession] = useState<CollabSession | null>(null);
  const [invite, setInvite] = useState<CollabInvite | null>(null);
  const [cursors, setCursors] = useState<RemoteCursor[]>([]);
  const [meId, setMeId] = useState(collab.me?.id ?? 0);

  // 최신 콜백 참조 — 렌더가 아니라 effect 에서 갱신한다(렌더 중 ref 쓰기는 React 규칙 위반).
  // 한 렌더만큼 뒤처질 수 있지만 applySnapshot 은 호출부에서 안정적인 useCallback 이라 무해하다.
  const applyRef = useRef(applySnapshot);
  useEffect(() => { applyRef.current = applySnapshot; }, [applySnapshot]);
  const lastSent = useRef<CollabSnapshot | null>(null);
  // 수신 직후에는 송출하지 않는다 — 받은 상태를 적용한 렌더가 다시 '변경됨'으로 잡혀
  // 되돌아가는 에코 루프가 생긴다. 제어권자만 송출하므로 실제로는 잘 안 생기지만,
  // 제어권이 넘어가는 찰나에 양쪽이 잠깐 송출자가 되는 순간이 있어 방어한다.
  const suppressUntil = useRef(0);

  const isHost = !!session && session.host_id === meId;
  const mySeat = session?.participants.find((p) => p.id === meId);
  const canControl = !session || mySeat?.control === "granted";
  const readOnly = !!session && !canControl;

  // ── WS 이벤트 ────────────────────────────────────────────────────────────
  useEffect(() => {
    return collab.on((e: CollabEvent) => {
      switch (e.t) {
        case "hello":
          setMeId(e.me.id);
          // 재접속 — 아직 열려 있는 내 세션이 있으면 자동 복귀(사용자가 다시 누르지 않게)
          if (!session && e.sessions.length) {
            const mine = e.sessions.find((s) => s.participants.some(
              (p) => p.id === e.me.id && p.state === "joined"));
            if (mine) { setSession(mine); collab.enter(mine.code); }
          }
          break;
        case "session":
          setSession(e.d);
          break;
        case "joined":
        case "ctl.requested":
        case "ctl.granted":
        case "ctl.revoked":
          setSession(e.d);
          if (e.t === "ctl.granted" && e.target === collab.me?.id) {
            showToast("화면 조작 권한을 받았습니다");
          } else if (e.t === "ctl.revoked") {
            showToast("화면 조작 권한이 Master 에게 돌아갔습니다");
          }
          break;
        case "exam":
          setSession(e.d);
          if (e.granted?.includes(collab.me?.id ?? -1)) {
            showToast("Master 가 다른 검사로 이동했습니다 — 해당 검사 열람이 허용됩니다");
          }
          break;
        case "left":
          setSession((prev) => prev && ({
            ...prev,
            participants: prev.participants.map(
              (p) => (p.id === e.id ? { ...p, state: "left" as const, control: "none" as const } : p)),
          }));
          setCursors((prev) => prev.filter((c) => c.id !== e.id));
          break;
        case "invite":
          setInvite({ code: e.code, from: e.from, title: e.title, study_uid: e.study_uid });
          break;
        case "session.closed":
          setSession(null);
          setCursors([]);
          showToast("협진 세션이 종료되었습니다");
          break;
        case "state": {
          const snap = e.d as CollabSnapshot;
          if (!snap || snap.v !== 1) break;
          suppressUntil.current = Date.now() + MIRROR_MS * 2;
          lastSent.current = snap;      // 내 상태 = 방금 받은 것 → 즉시 되쏘지 않는다
          applyRef.current(snap);
          break;
        }
        case "cursor": {
          const c = e.d as CollabCursor;
          if (!c) break;
          setCursors((prev) => {
            const name = session?.participants.find((p) => p.id === e.from)?.name ?? "";
            const next = prev.filter((x) => x.id !== e.from);
            next.push({ id: e.from, name, pid: c.pid, x: c.x, y: c.y, at: Date.now() });
            return next;
          });
          break;
        }
        case "error":
          showToast(e.detail, "error");
          break;
      }
    });
  }, [session]);

  // 오래된 커서 정리 — 상대가 마우스를 멈추면 3초 뒤 사라진다(유령 커서 방지)
  useEffect(() => {
    if (!cursors.length) return;
    const id = window.setInterval(() => {
      const cut = Date.now() - 3000;
      setCursors((prev) => (prev.some((c) => c.at < cut) ? prev.filter((c) => c.at >= cut) : prev));
    }, 1000);
    return () => window.clearInterval(id);
  }, [cursors.length]);

  // ── 미러 송출 ────────────────────────────────────────────────────────────
  const mirror = useMemo(() => makeThrottle<CollabSnapshot>(
    (snap) => { collab.send({ t: "state", d: snap }); }, MIRROR_MS), []);
  const cursorThrottle = useMemo(() => makeThrottle<CollabCursor>(
    (c) => { collab.send({ t: "cursor", d: c }); }, CURSOR_MS), []);

  // 의존성 배열이 없다 = 매 렌더 실행. 대신 스냅샷이 **실제로 달라졌을 때만** 보낸다
  // (정지 화면에서는 트래픽 0). 뷰어 상태를 일일이 dep 으로 나열하는 것보다 정확하고,
  // 새 상태가 추가돼도 여기를 고칠 필요가 없다.
  useEffect(() => {
    if (!session || !canControl) return;
    if (Date.now() < suppressUntil.current) return;
    const snap = encodeSnapshot(source);
    if (sameSnapshot(snap, lastSent.current)) return;
    lastSent.current = snap;
    mirror.push(snap);
  });

  // 세션을 나가면 대기 중인 송출을 버린다(끝난 세션에 프레임이 새어 나가지 않게)
  useEffect(() => { if (!session) { mirror.cancel(); cursorThrottle.cancel(); } },
            [session, mirror, cursorThrottle]);

  const sendCursor = useCallback((pid: string, x: number, y: number) => {
    if (!session) return;
    cursorThrottle.push({ pid, x, y });
  }, [session, cursorThrottle]);

  // ── 세션 조작 ────────────────────────────────────────────────────────────
  const startSession = useCallback(async (title?: string): Promise<CollabSession | null> => {
    try {
      const s = await api.collabOpenSession(studyId, title ?? "");
      setSession(s);
      collab.enter(s.code);
      lastSent.current = null;      // 첫 스냅샷은 반드시 나가야 한다
      showToast("협진을 시작했습니다 — 친구를 초대하세요");
      return s;
    } catch (e) {
      showToast(e instanceof Error ? e.message : "협진을 시작하지 못했습니다", "error");
      return null;
    }
  }, [studyId]);

  const inviteUser = useCallback(async (u: CollabUser, code?: string) => {
    const target = code ?? session?.code;
    if (!target) return;
    try {
      setSession(await api.collabInvite(target, u.id));
      showToast(`${u.name} 님을 초대했습니다`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "초대에 실패했습니다", "error");
    }
  }, [session]);

  const acceptInvite = useCallback(() => {
    if (!invite) return;
    collab.enter(invite.code);       // 서버가 참가 처리 후 `session` 이벤트로 답한다
    setInvite(null);
  }, [invite]);

  const declineInvite = useCallback(() => {
    if (!invite) return;
    void api.collabDecline(invite.code).catch(() => { /* 거절 통지 실패는 무해 */ });
    setInvite(null);
  }, [invite]);

  const leaveSession = useCallback(async () => {
    if (!session) return;
    const code = session.code;
    const host = session.host_id === meId;
    setSession(null);
    setCursors([]);
    collab.exit();
    try {
      // Master 가 나가면 세션 자체를 닫는다 — 그래야 전원의 임시 열람권이 즉시 회수된다.
      await (host ? api.collabClose(code) : api.collabLeave(code));
    } catch { /* 이미 닫혔을 수 있다 — 화면은 이미 정리됐으므로 무해 */ }
  }, [session, meId]);

  const shareStudy = useCallback((id: number) => {
    if (!session || session.host_id !== meId || !id || id === session.study_id) return;
    collab.send({ t: "exam.switch", study_id: id });
  }, [session, meId]);

  // Master 가 다른 Exam 탭으로 옮기면 자동으로 공유 검사를 바꾼다
  useEffect(() => { shareStudy(studyId); }, [studyId, shareStudy]);

  return {
    session, isHost, meId, readOnly, cursors, invite,
    startSession, inviteUser, acceptInvite, declineInvite, leaveSession, sendCursor,
  };
}
