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
  encodeSnapshot, makeThrottle, mergeAnno, removeAnno, sameSnapshot,
  type CollabCursor, type CollabSnapshot, type MirrorSource, type SessionAnno,
} from "./collabState";
import { LASER_TTL, navKey, onSurface, pruneLaser, type Surface } from "./collabSurface";
import { t as tr } from "./i18n";
import { showToast } from "./toast";

/** 미러 송출 주기(ms) — 10Hz. 사람이 마우스로 움직이는 화면에는 충분히 매끄럽고,
 *  스냅샷 2~4KB × 10 = 초당 20~40KB 로 대역폭도 무시할 수준이다. */
const MIRROR_MS = 100;
/** 커서는 더 자주 — 상대가 "여기 보세요" 하고 가리키는 동작이라 지연이 바로 느껴진다 */
const CURSOR_MS = 60;

/** 협진 capability — 백엔드 permissions.COLLAB_CAPS 와 같은 키.
 *  Master 는 자기 세션이므로 전부 갖는다(서버 can_control 도 같게 판정). */
export const ALL_CAPS: string[] = [
  "collab.viewport", "collab.annotate", "collab.text", "collab.navigate", "collab.present",
];

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
  /** 내가 지금 발표자인가 — 뷰포트를 전원에게 송출하는 사람(세션당 1명) */
  isPresenter: boolean;
  /** 발표자를 따라가는 중인가. 내가 화면을 건드리면 자동으로 false(자유 보기)가 된다 */
  following: boolean;
  /** 다시 발표자 화면으로 복귀 */
  follow: () => void;
  /** 내가 화면을 움직였다 → 자유 보기로 빠진다. 뷰어의 조작 진입점이 부른다 */
  detach: () => void;
  /** 내가 가진 협진 capability (Master 는 전부) */
  caps: string[];
  can: (cap: string) => boolean;
  /** 뷰포트가 잠겨 있나 = 세션 중이고 내가 발표자가 아니며 따라가는 중.
   *  ⚠ 예전엔 '조작 전체 잠금'이었지만 이제는 **뷰포트 축만**이다.
   *    주석·글쓰기는 caps 로 따로 판정한다(can) — 그래야 여러 명이 동시에 그린다. */
  readOnly: boolean;
  /** 세션 주석 — 여러 명이 동시에 그린 것. 작성자(by)별 색으로 그린다.
   *  ⚠ 표면이 섞여 있다. 뷰포트에 그릴 때는 반드시 `annosOf("pane")` 을 쓴다 —
   *  화이트보드·화면 마크는 좌표계가 달라서 그대로 그리면 엉뚱한 곳에 찍힌다. */
  annos: SessionAnno[];
  /** 그 표면의 것만. 레이저 만료분은 이미 걸러져 있다. */
  annosOf: (s: Surface) => SessionAnno[];
  addAnno: (a: Omit<SessionAnno, "id" | "by">) => void;
  updateAnno: (id: string, a: Omit<SessionAnno, "id" | "by">) => void;
  removeAnno: (id: string) => void;
  /** 그 표면의 마크를 전부 지운다 — 내 것만(Master 는 전원 것). 화면 공유 재시작 시 자동 호출. */
  clearSurfaceMarks: (s: Surface) => void;
  /** 발표권을 **가져온다** — Master 승인을 기다리지 않는다(collab.present 보유자 누구나). */
  takePresent: () => void;
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
  const [annos, setAnnos] = useState<SessionAnno[]>([]);
  // 발표자를 따라가는 중인가. 내가 화면을 건드리면 자동으로 풀린다(자유 보기).
  // 이게 "전부 동시" 를 성립시키는 장치다 — 안 그러면 내가 팬한 직후 발표자의 다음
  // 스냅샷(100ms 뒤)이 내 화면을 되돌려 버려서 사실상 조작이 불가능하다.
  const [following, setFollowing] = useState(true);

  // 최신 콜백 참조 — 렌더가 아니라 effect 에서 갱신한다(렌더 중 ref 쓰기는 React 규칙 위반).
  // 한 렌더만큼 뒤처질 수 있지만 applySnapshot 은 호출부에서 안정적인 useCallback 이라 무해하다.
  const applyRef = useRef(applySnapshot);
  useEffect(() => { applyRef.current = applySnapshot; }, [applySnapshot]);
  // WS 핸들러(effect 안)가 최신 following 을 봐야 한다 — dep 에 넣으면 following 이 바뀔 때마다
  // 구독을 다시 걸어 그 찰나의 이벤트를 놓친다.
  const followRef = useRef(true);
  useEffect(() => { followRef.current = following; }, [following]);
  const lastSent = useRef<CollabSnapshot | null>(null);
  // 발표자가 마지막으로 보여 준 '무엇을'(검사·시리즈·레이아웃). 이 값이 바뀌면 전환이다.
  // null = 아직 한 장도 못 받음 → 첫 스냅샷을 전환으로 오인해 토스트를 띄우지 않는다.
  const lastNav = useRef<string | null>(null);
  // 수신 직후에는 송출하지 않는다 — 받은 상태를 적용한 렌더가 다시 '변경됨'으로 잡혀
  // 되돌아가는 에코 루프가 생긴다. 제어권자만 송출하므로 실제로는 잘 안 생기지만,
  // 제어권이 넘어가는 찰나에 양쪽이 잠깐 송출자가 되는 순간이 있어 방어한다.
  const suppressUntil = useRef(0);

  const isHost = !!session && session.host_id === meId;
  const mySeat = session?.participants.find((p) => p.id === meId);
  const isPresenter = !!session && mySeat?.control === "granted";
  // 뷰포트 송출자 = 발표자. 세션이 없으면 당연히 내 마음대로.
  const canControl = !session || isPresenter;
  // 따라가는 중일 때만 잠긴다 — 자유 보기로 빠지면 내 화면은 내가 움직인다.
  const readOnly = !!session && !canControl && following;
  // 내가 가진 capability. Master 는 자기 세션이라 전부(뷰포트는 발표자 축에서 따로 판정).
  const caps = useMemo<string[]>(
    () => (!session ? [] : isHost ? ALL_CAPS : (mySeat?.caps ?? [])),
    [session, isHost, mySeat?.caps]);
  const can = useCallback(
    (cap: string) => !session || caps.includes(cap), [session, caps]);

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
          setAnnos([]);               // 세션 주석은 세션과 함께 사라진다(설계상 세션 한정)
          showToast("협진 세션이 종료되었습니다");
          break;
        case "state": {
          const snap = e.d as CollabSnapshot;
          if (!snap || snap.v !== 1) break;
          // ── 발표 '전환' 은 자유 보기도 끌어온다 (2026-08-10 사용자 확정) ──
          // 발표자가 검사·시리즈·레이아웃을 바꾼 것은 "이제 이걸 봅시다"라는 신호다.
          // 자유 보기로 빠진 사람을 두고 가면 서로 다른 검사를 같은 것으로 믿고 논의하게
          // 된다 — 오진 경로다. 반대로 팬·줌까지 끌어오면 남의 화면을 뺏는 것이라
          // 아무도 작업을 못 한다. navKey 가 그 둘을 가른다(lib/collabSurface).
          const key = navKey(snap);
          const switched = lastNav.current !== null && lastNav.current !== key;
          lastNav.current = key;
          if (switched && !followRef.current) {
            followRef.current = true;   // ref 를 먼저 — 아래 적용이 같은 틱에 일어난다
            setFollowing(true);
            showToast(tr("발표자가 화면을 전환했습니다 — 같은 화면으로 돌아갑니다"));
          }
          // 자유 보기 중이면 발표자 화면을 **적용하지 않는다**. 적용하면 내가 방금 움직인
          // 화면이 100ms 뒤 되돌아가서 조작 자체가 불가능해진다("전부 동시"가 성립하는 지점).
          if (!followRef.current) break;
          suppressUntil.current = Date.now() + MIRROR_MS * 2;
          lastSent.current = snap;      // 내 상태 = 방금 받은 것 → 즉시 되쏘지 않는다
          applyRef.current(snap);
          break;
        }
        // ── 세션 주석 — 여러 명이 동시에 그린다. 서버가 진실이고 여기는 따라간다 ──
        // ⚠ at(도착 시각)은 **여기서** 찍는다. 보낸 쪽 시계를 쓰면 좌석 간 시계 차이만큼
        //   레이저가 즉시 사라지거나 영원히 안 사라진다(그래서 서버도 at 을 안 나른다).
        case "anno.sync":
          setAnnos(Array.isArray(e.d)
            ? (e.d as SessionAnno[]).map((a) => ({ ...a, at: Date.now() }))
            : []);
          break;
        case "anno.add":
        case "anno.update": {
          const row = e.d as SessionAnno;
          if (row?.id) setAnnos((prev) => mergeAnno(prev, { ...row, at: Date.now() }));
          break;
        }
        case "anno.remove":
          setAnnos((prev) => removeAnno(prev, e.id));
          break;
        case "adopted":
          if (e.target === collab.me?.id) {
            showToast(`Master 가 내 표시 ${e.n}건을 판독 주석으로 채택했습니다`);
          }
          break;
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
  useEffect(() => {
    if (!session) { mirror.cancel(); cursorThrottle.cancel(); setFollowing(true); setAnnos([]); }
  }, [session, mirror, cursorThrottle]);

  // 내가 발표자가 되면 따라갈 대상이 없다 — 자동으로 따라가기 해제(내 화면이 곧 기준이다)
  useEffect(() => { if (isPresenter) setFollowing(false); }, [isPresenter]);

  // ── 자유 보기 ────────────────────────────────────────────────────────────
  const detach = useCallback(() => {
    // 발표자는 detach 할 대상이 없다(자기 화면이 기준). 세션 밖도 무의미.
    if (!session || isPresenter) return;
    setFollowing((f) => (f ? false : f));
  }, [session, isPresenter]);

  const follow = useCallback(() => {
    if (!session || isPresenter) return;
    lastSent.current = null;      // 복귀 직후 발표자 스냅샷을 반드시 적용받도록
    setFollowing(true);
  }, [session, isPresenter]);

  // ── 세션 주석 송출 ───────────────────────────────────────────────────────
  // 스로틀하지 않는다: 주석은 '한 번 확정된 도형'이라 빈도가 낮고(그리기 종료 시 1건),
  // 유실되면 남들 화면에 안 보이는 채로 끝난다. 뷰포트 미러와 성질이 다르다.
  const addAnno = useCallback((a: Omit<SessionAnno, "id" | "by">) => {
    if (!session) return;
    collab.send({ t: "anno.add", d: a });
  }, [session]);

  const updateAnno = useCallback((id: string, a: Omit<SessionAnno, "id" | "by">) => {
    if (!session) return;
    collab.send({ t: "anno.update", id, d: a });
  }, [session]);

  const removeAnnoById = useCallback((id: string) => {
    if (!session) return;
    collab.send({ t: "anno.remove", id });
  }, [session]);

  // ── 표면별 분리 ──────────────────────────────────────────────────────────
  // 🔴 이 셀렉터를 거치지 않고 annos 를 그대로 뷰포트에 그리면, 화이트보드·화면 마크는
  //    sop_uid 가 없어서 Viewer2D 의 "sop_uid 없으면 이 검사 것" 필터를 통과해 **DICOM
  //    영상 위로 쏟아진다**. 좌표계가 다르므로 위치도 전부 틀린다.
  const annosOf = useCallback(
    (s: Surface) => onSurface(annos, s), [annos]);

  const clearSurfaceMarks = useCallback((s: Surface) => {
    if (!session) return;
    // 내 것만 지운다(서버가 소유자 검사). Master 는 서버 쪽에서 force 로 남의 것도 지운다.
    for (const a of onSurface(annos, s)) {
      if (isHost || a.by === meId) collab.send({ t: "anno.remove", id: a.id });
    }
  }, [session, annos, isHost, meId]);

  // 레이저 소멸 — 화면에서 지우기만 한다(서버에 remove 를 보내지 않는다).
  // 보내면 N명이 같은 삭제를 동시에 쏘고, 소유자가 아니면 서버가 거절해 로그만 더러워진다.
  // 각자 자기 화면에서 시간이 지나면 지우는 것으로 충분하다 — 결과가 모두 같다.
  useEffect(() => {
    if (!annos.some((a) => a.life === "laser")) return;
    const id = window.setInterval(() => {
      setAnnos((prev) => {
        const next = pruneLaser(prev, Date.now());
        return next.length === prev.length ? prev : next;
      });
    }, Math.max(200, LASER_TTL / 6));
    return () => window.clearInterval(id);
  }, [annos]);

  /** 발표권 가져오기 — 요청이 아니라 '가져오기'다(회의에서 발언권이 넘어가듯).
   *  서버가 collab.present 보유 여부를 확인하고, 전원에게 ctl.granted 를 뿌린다. */
  const takePresent = useCallback(() => {
    if (!session || isPresenter) return;
    collab.send({ t: "ctl.take" });
  }, [session, isPresenter]);

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
    session, isHost, meId, isPresenter, following, follow, detach, caps, can,
    annos, annosOf, addAnno, updateAnno, removeAnno: removeAnnoById,
    clearSurfaceMarks, takePresent,
    readOnly, cursors, invite,
    startSession, inviteUser, acceptInvite, declineInvite, leaveSession, sendCursor,
  };
}
