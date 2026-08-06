// 협진 도크 — 친구 목록 · 사용자 검색 · 1:1 메신저 (스크린샷 우측 패널)
//
// 한 패널 안에 탭 3개(친구 / 찾기 / 대화)를 둔다. 판독 화면은 이미 좌우가 꽉 차 있어서
// 협진 UI 가 독립 창을 또 요구하면 실제로는 안 쓰게 된다 — 도크 하나로 접었다 편다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type CollabFriends, type CollabMessage, type CollabUser } from "../api";
import { collab, type CollabEvent } from "../lib/collab";
import { colorOf, dmRoom } from "../lib/collabState";
import { t as tr, useLang } from "../lib/i18n";
import { mesh, type PeerView } from "../lib/webrtcMesh";
import { showToast } from "../lib/toast";
import { VideoTile } from "./CollabSessionPanel";

type Tab = "friends" | "find" | "chat";

const ROLE_LABEL: Record<string, string> = {
  admin: "관리자", doctor: "의사", radiologist: "영상의학과",
  technologist: "방사선사", staff: "의료인",
};

const EMPTY: CollabFriends = { friends: [], incoming: [], outgoing: [], blocked: [], unread: {} };

function Avatar({ user, online }: { user: CollabUser; online?: boolean }) {
  const initial = (user.name || user.username || "?").trim().charAt(0).toUpperCase();
  return (
    <div style={{ position: "relative", width: 30, height: 30, flexShrink: 0 }}>
      <div style={{ width: 30, height: 30, borderRadius: "50%", background: "var(--bg-elevated)",
                    display: "grid", placeItems: "center", fontSize: 13, fontWeight: 600,
                    color: "var(--text-secondary)" }}>{initial}</div>
      {online !== undefined && (
        <span title={online ? tr("접속 중") : tr("오프라인")}
              style={{ position: "absolute", right: -1, bottom: -1, width: 9, height: 9,
                       borderRadius: "50%", border: "2px solid var(--bg-panel)",
                       background: online ? "var(--stat-final)" : "var(--text-disabled)" }} />
      )}
    </div>
  );
}

/** 탭 버튼. Section(CollabSessionPanel)과 같은 이유로 컴포넌트 바깥에 둔다 —
 *  렌더 안에서 정의하면 매 렌더 새 타입이 되어 하위 트리가 재마운트된다. */
function TabBtn({ id, label, badge, active, onPick }: {
  id: Tab; label: string; badge?: number; active: boolean; onPick: (t: Tab) => void;
}) {
  return (
    <button onClick={() => onPick(id)}
            style={{ flex: 1, padding: "6px 4px", fontSize: 12, border: "none", cursor: "pointer",
                     background: active ? "var(--bg-elevated)" : "transparent",
                     color: active ? "var(--text-primary)" : "var(--text-secondary)",
                     borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent" }}>
      {label}
      {!!badge && <span style={{ marginLeft: 4, fontSize: 10, background: "var(--stat-emergency)",
                                 color: "#fff", borderRadius: 8, padding: "1px 5px" }}>{badge}</span>}
    </button>
  );
}

function UserRow({ user, online, right }: {
  user: CollabUser; online?: boolean; right?: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px",
                  borderBottom: "1px solid var(--border)" }}>
      <Avatar user={user} online={online} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden",
                      textOverflow: "ellipsis" }}>{user.name}</div>
        <div style={{ fontSize: 11, color: "var(--text-secondary)", whiteSpace: "nowrap",
                      overflow: "hidden", textOverflow: "ellipsis" }}>
          {[tr(ROLE_LABEL[user.role] ?? user.role), user.hospital].filter(Boolean).join(" · ")}
        </div>
      </div>
      {right}
    </div>
  );
}

export function CollabDock({ open, onClose, onInvite, inviteLabel, width = 260,
                            popoutFeatures }: {
  open: boolean;
  onClose: () => void;
  /** 협진 초대 — 뷰어에서 열었을 때만 준다(워크리스트에서는 초대할 검사가 없다) */
  onInvite?: (user: CollabUser) => void;
  inviteLabel?: string;
  /** 패널 폭 — 호출부가 Splitter 로 조절해 내려 준다(계정 로밍 저장) */
  width?: number;
  /** 팝아웃 창 배치 features — 다중 모니터. 제스처 안에서 await 할 수 없어 미리 받는다 */
  popoutFeatures?: string;
}) {
  useLang();
  const [tab, setTab] = useState<Tab>("friends");
  const [data, setData] = useState<CollabFriends>(EMPTY);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<CollabUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [peer, setPeer] = useState<CollabUser | null>(null);
  const [msgs, setMsgs] = useState<CollabMessage[]>([]);
  // 채팅 초안은 DOM 이 소유한다. 협진 WS 프레즌스/메시지로 부모가 다시 그려져도
  // IME 조합과 입력 포커스가 흔들리지 않아야 한다(특히 초대받은 쪽에서 재현됐던 문제).
  const draftRef = useRef<HTMLDivElement | null>(null);
  const [peers, setPeers] = useState<PeerView[]>([]);
  const [mic, setMic] = useState(false);
  const [cam, setCam] = useState(false);
  const [screen, setScreen] = useState(false);
  const [mediaBusy, setMediaBusy] = useState("");
  const [online, setOnline] = useState<Set<number>>(() => new Set(collab.online));
  // 연결 표시등은 **구독**해야 한다. collab.status 를 렌더 중에 읽기만 하면 WS 가 끊겨도
  // 이 컴포넌트가 다시 그려질 이유가 없어 초록불이 그대로 남는다(거짓 안심).
  const [wsOpen, setWsOpen] = useState(collab.status === "open");
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const meId = collab.me?.id ?? 0;

  useEffect(() => collab.onStatus((s) => setWsOpen(s === "open")), []);
  useEffect(() => mesh.onChange(setPeers), []);
  useEffect(() => mesh.onMediaChange((s) => {
    setMic(s.mic); setCam(s.camera); setScreen(s.screen);
  }), []);

  const reload = useCallback(() => {
    api.collabFriends().then(setData).catch(() => { /* 목록 실패는 조용히 — 도크가 비어 보일 뿐 */ });
  }, []);

  useEffect(() => { if (open) reload(); }, [open, reload]);

  // WS 이벤트 — 친구 요청/수락·프레즌스·새 메시지
  useEffect(() => collab.on((e: CollabEvent) => {
    if (e.t === "presence") {
      setOnline((prev) => {
        const next = new Set(prev);
        if (e.online) next.add(e.id); else next.delete(e.id);
        return next;
      });
    } else if (e.t === "hello") {
      setOnline(new Set(e.online));
    } else if (e.t === "friend.request") {
      showToast(`${e.from.name} ${tr("님이 친구 요청을 보냈습니다")}`);
      reload();
    } else if (e.t === "friend.accepted") {
      showToast(`${e.from.name} ${tr("님과 친구가 되었습니다")}`);
      reload();
    } else if (e.t === "chat") {
      const m = e.d;
      setMsgs((prev) => {
        // 현재 열어 둔 대화방이 아니면 목록만 갱신(배지)
        if (!peer || m.room !== dmRoom(meId, peer.id)) return prev;
        return prev.some((x) => x.id === m.id) ? prev : [...prev, m];
      });
      if (!peer || m.room !== dmRoom(meId, peer.id)) reload();
    }
  }), [peer, meId, reload]);

  // 대화 열기 — 백필 + 읽음 처리
  const openChat = useCallback((u: CollabUser) => {
    setPeer(u);
    setTab("chat");
    const room = dmRoom(meId, u.id);
    api.collabMessages(room).then((r) => setMsgs(r.items)).catch(() => setMsgs([]));
    api.collabMarkRead(room).then(reload).catch(() => { /* 배지 갱신 실패는 무해 */ });
  }, [meId, reload]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: "end" }); }, [msgs]);

  // 친구 목록에서 대화를 열면 편집기가 새로 마운트된 뒤 바로 포커스한다.
  // 열린 패널에 HMR 수정이 적용될 때도 예전 input DOM에 포커스가 남지 않는다.
  useEffect(() => {
    if (!open || tab !== "chat" || !peer) return;
    const frame = window.requestAnimationFrame(() => draftRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open, tab, peer]);

  // 1:1 대화도 검사 협진 세션과 같은 P2P mesh를 쓴다. room 컨텍스트를 넣어
  // 다른 친구·다른 창의 SDP/ICE가 섞이지 않게 하고, 대화를 닫으면 장치도 끈다.
  const peerOnline = !!peer && (online.has(peer.id) || peer.online === true);
  useEffect(() => {
    if (!open || tab !== "chat" || !peer || !meId || !peerOnline) {
      return;
    }
    const room = dmRoom(meId, peer.id);
    mesh.start(meId, room);
    mesh.syncPeers([peer.id]);
    return () => mesh.stop();
  }, [open, tab, peer, meId, peerOnline]);

  // 검색 — 입력 후 300ms 디바운스(타이핑마다 서버를 때리지 않는다)
  useEffect(() => {
    if (tab !== "find") return;
    const id = window.setTimeout(() => {
      setSearching(true);
      api.collabDirectory(query)
        .then((r) => setFound(r.items))
        .catch(() => setFound([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => window.clearTimeout(id);
  }, [query, tab]);

  const send = () => {
    const body = draftRef.current?.innerText.trim() ?? "";
    if (!body || !peer) return;
    if (!collab.send({ t: "chat", room: dmRoom(meId, peer.id), body })) {
      showToast(tr("연결이 끊겨 메시지를 보내지 못했습니다"), "error");
      return;
    }
    if (draftRef.current) draftRef.current.textContent = "";
  };

  const runMedia = async (work: () => Promise<void>, label: string) => {
    if (mediaBusy) return;
    setMediaBusy(label);
    try {
      await work();
    } catch (e) {
      const reason = e instanceof Error ? e.message : tr("권한 또는 장치를 확인하세요");
      showToast(`${label} — ${tr("시작할 수 없습니다")}: ${reason}`, "error");
    } finally {
      setMediaBusy("");
    }
  };

  const act = (p: Promise<unknown>, ok: string) =>
    p.then(() => { showToast(ok); reload(); })
     .catch((e) => showToast(e instanceof Error ? e.message : tr("실패"), "error"));

  const incomingCount = data.incoming.length;
  const unreadTotal = useMemo(
    () => Object.values(data.unread ?? {}).reduce((a, b) => a + b, 0), [data.unread]);

  if (!open) return null;

  return (
    <div style={{ width, flexShrink: 0, display: "flex", flexDirection: "column", height: "100%",
                  background: "var(--bg-panel)", borderLeft: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px",
                    borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontSize: 12.5, fontWeight: 700 }}>{tr("협진")}</span>
        <span title={wsOpen ? tr("실시간 연결됨") : tr("연결 끊김 — 자동 재연결 중")}
              style={{ width: 7, height: 7, borderRadius: "50%",
                       background: wsOpen ? "var(--stat-final)" : "var(--stat-reading)" }} />
        <div style={{ flex: 1 }} />
        <button onClick={onClose} title={tr("닫기")}
                style={{ background: "none", border: "none", color: "var(--text-secondary)",
                         cursor: "pointer", fontSize: 14, lineHeight: 1 }}>✕</button>
      </div>

      <div style={{ display: "flex", borderBottom: "1px solid var(--border)" }}>
        <TabBtn id="friends" label={tr("친구")} badge={incomingCount || unreadTotal}
                active={tab === "friends"} onPick={setTab} />
        <TabBtn id="find" label={tr("찾기")} active={tab === "find"} onPick={setTab} />
        <TabBtn id="chat" label={tr("대화")} active={tab === "chat"} onPick={setTab} />
      </div>

      {tab === "friends" && (
        <div style={{ flex: 1, overflowY: "auto" }}>
          {incomingCount > 0 && (
            <>
              <div style={{ padding: "4px 8px", fontSize: 11, color: "var(--text-secondary)",
                            background: "var(--bg-canvas)" }}>{tr("받은 요청")}</div>
              {data.incoming.map((u) => (
                <UserRow key={u.id} user={u} online={online.has(u.id)} right={
                  <span style={{ display: "flex", gap: 3 }}>
                    <button style={{ fontSize: 11, padding: "2px 6px" }}
                            onClick={() => act(api.collabRespondFriend(u.id, true), tr("수락했습니다"))}>{tr("수락")}</button>
                    <button style={{ fontSize: 11, padding: "2px 6px" }}
                            onClick={() => act(api.collabRespondFriend(u.id, false), tr("거절했습니다"))}>{tr("거절")}</button>
                  </span>
                } />
              ))}
            </>
          )}
          <div style={{ padding: "4px 8px", fontSize: 11, color: "var(--text-secondary)",
                        background: "var(--bg-canvas)" }}>{tr("친구")} {data.friends.length}</div>
          {data.friends.length === 0 && (
            <div style={{ padding: 12, fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.6 }}>
              {tr("아직 친구가 없습니다.")}<br />
              {tr("[찾기] 탭에서 같은 병원 또는 다른 병원 사용자를 검색해 친구 요청을 보내세요.")}
            </div>
          )}
          {data.friends.map((u) => {
            const unread = data.unread?.[dmRoom(meId, u.id)] ?? 0;
            return (
              <UserRow key={u.id} user={u} online={online.has(u.id)} right={
                <span style={{ display: "flex", gap: 3, alignItems: "center" }}>
                  {!!unread && <span style={{ fontSize: 10, background: "var(--stat-emergency)",
                                              color: "#fff", borderRadius: 8, padding: "1px 5px" }}>{unread}</span>}
                  <button style={{ fontSize: 11, padding: "2px 6px" }}
                          onClick={() => openChat(u)} title={tr("1:1 대화")}>💬</button>
                  {onInvite && (
                    <button className="primary" style={{ fontSize: 11, padding: "2px 6px" }}
                            disabled={!online.has(u.id)}
                            title={online.has(u.id) ? tr(inviteLabel ?? "협진 초대") : tr("오프라인 — 초대할 수 없습니다")}
                            onClick={() => onInvite(u)}>{tr("초대")}</button>
                  )}
                </span>
              } />
            );
          })}
          {data.outgoing.length > 0 && (
            <>
              <div style={{ padding: "4px 8px", fontSize: 11, color: "var(--text-secondary)",
                            background: "var(--bg-canvas)" }}>{tr("보낸 요청 (대기 중)")}</div>
              {data.outgoing.map((u) => (
                <UserRow key={u.id} user={u} online={online.has(u.id)} right={
                  <button style={{ fontSize: 11, padding: "2px 6px" }}
                          onClick={() => act(api.collabRemoveFriend(u.id), tr("요청을 취소했습니다"))}>{tr("취소")}</button>
                } />
              ))}
            </>
          )}
        </div>
      )}

      {tab === "find" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ padding: 8 }}>
            <input value={query} onChange={(e) => setQuery(e.target.value)} name="collab_find"
                   autoComplete="off" placeholder={tr("이름 · 아이디 · 직책으로 검색")}
                   style={{ width: "100%", fontSize: 12 }} />
            <div style={{ fontSize: 10.5, color: "var(--text-secondary)", marginTop: 4 }}>
              {tr("같은 병원 · 다른 병원 사용자가 모두 검색됩니다.")}
            </div>
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {searching && <div style={{ padding: 10, fontSize: 11.5, color: "var(--text-secondary)" }}>{tr("검색 중…")}</div>}
            {!searching && found.length === 0 && (
              <div style={{ padding: 10, fontSize: 11.5, color: "var(--text-secondary)" }}>{tr("결과가 없습니다.")}</div>
            )}
            {found.map((u) => (
              <UserRow key={u.id} user={u} online={u.online} right={
                u.relation === "accepted" ? <span style={{ fontSize: 11, color: "var(--stat-final)" }}>{tr("친구")}</span>
                  : u.relation === "pending" ? <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                      {u.relation_mine ? tr("대기 중") : tr("요청 받음")}</span>
                    : u.relation === "blocked" ? <span style={{ fontSize: 11, color: "var(--text-disabled)" }}>{tr("차단")}</span>
                      : <button className="primary" style={{ fontSize: 11, padding: "2px 6px" }}
                                onClick={() => act(api.collabRequestFriend(u.id), tr("친구 요청을 보냈습니다"))
                                  .then(() => api.collabDirectory(query).then((r) => setFound(r.items)).catch(() => {}))}>
                          {tr("친구 요청")}
                        </button>
              } />
            ))}
          </div>
        </div>
      )}

      {tab === "chat" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {!peer && (
            <div style={{ padding: 12, fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.6 }}>
              {tr("[친구] 탭에서 💬 를 눌러 대화를 시작하세요.")}
            </div>
          )}
          {peer && (
            <>
              <div style={{ padding: "5px 8px", borderBottom: "1px solid var(--border)",
                            fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
                <Avatar user={peer} online={online.has(peer.id)} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{peer.name}</div>
                  <div style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>{peer.hospital}</div>
                </div>
              </div>
              {/* 1:1 통화 — 검사 협진 세션을 먼저 만들지 않아도 친구 대화에서 바로 사용. */}
              <div style={{ padding: 6, borderBottom: "1px solid var(--border)",
                            background: "var(--bg-canvas)" }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
                  <button onClick={() => void runMedia(() => mesh.setMicrophone(!mic), tr("음성"))}
                          disabled={!!mediaBusy || !peerOnline}
                          className={mic ? "primary" : undefined}
                          style={{ fontSize: 11, padding: "4px 2px" }}
                          title={mic ? tr("마이크 끄기") : tr("음성 통화")}>
                    {mic ? `🎤 ${tr("음성 켜짐")}` : `🎤 ${tr("음성")}`}
                  </button>
                  <button onClick={() => void runMedia(() => mesh.setCamera(!cam), tr("화상"))}
                          disabled={!!mediaBusy || !peerOnline}
                          className={cam ? "primary" : undefined}
                          style={{ fontSize: 11, padding: "4px 2px" }}
                          title={cam ? tr("카메라 끄기") : tr("화상 통화")}>
                    {cam ? `📹 ${tr("화상 켜짐")}` : `📹 ${tr("화상")}`}
                  </button>
                  <button onClick={() => void runMedia(() => mesh.setScreenShare(!screen), tr("화면 공유"))}
                          disabled={!!mediaBusy || !peerOnline}
                          className={screen ? "primary" : undefined}
                          style={{ fontSize: 11, padding: "4px 2px" }}
                          title={screen ? tr("화면 공유 중지") : tr("화면 공유")}>
                    {screen ? `🖥 ${tr("공유 중")}` : `🖥 ${tr("화면")}`}
                  </button>
                </div>
                {!peerOnline && (
                  <div style={{ marginTop: 4, fontSize: 10, color: "var(--text-disabled)" }}>
                    {tr("상대가 오프라인입니다. 접속하면 통화 버튼이 활성화됩니다.")}
                  </div>
                )}
                {mediaBusy && (
                  <div style={{ marginTop: 4, fontSize: 10, color: "var(--text-secondary)" }}>
                    {mediaBusy} — {tr("권한 확인 중…")}
                  </div>
                )}
                {(mic || cam || screen || peers.some((p) => (p.stream?.getTracks().length ?? 0) > 0)) && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, marginTop: 6 }}>
                    <VideoTile id={meId} name={tr("나")} stream={mesh.localStream()} muted
                               color={colorOf(meId)} popoutFeatures={popoutFeatures}
                               label={screen ? tr("화면 공유") : undefined} />
                    {peers.map((p) => (
                      <VideoTile key={p.id} id={p.id} name={peer.name} stream={p.stream}
                                 color={colorOf(p.id)} popoutFeatures={popoutFeatures}
                                 label={p.state === "connected" ? undefined : tr("연결 중…")} />
                    ))}
                  </div>
                )}
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: 8, display: "flex",
                            flexDirection: "column", gap: 6 }}>
                {msgs.map((m) => {
                  const mine = m.sender_id === meId;
                  return (
                    <div key={m.id} style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "85%" }}>
                      {!mine && <div style={{ fontSize: 10, color: "var(--text-secondary)" }}>{m.sender}</div>}
                      <div style={{ background: mine ? "var(--accent-subtle)" : "var(--bg-elevated)",
                                    borderRadius: 6, padding: "5px 8px", fontSize: 12,
                                    whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.body}</div>
                      <div style={{ fontSize: 9.5, color: "var(--text-disabled)",
                                    textAlign: mine ? "right" : "left" }}>
                        {m.at ? new Date(m.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) : ""}
                      </div>
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>
              <div style={{ display: "flex", gap: 4, padding: 6, borderTop: "1px solid var(--border)" }}>
                <div key="collab-dm-editor-v3" ref={draftRef}
                       className="collab-chat-editor" contentEditable={true}
                       suppressContentEditableWarning role="textbox" tabIndex={0}
                       aria-label={tr("대화 내용")} aria-placeholder={tr("내용을 입력하세요.")}
                       data-placeholder={tr("내용을 입력하세요.")}
                       onPointerDown={(e) => e.stopPropagation()}
                       onClick={(e) => e.stopPropagation()}
                       onBeforeInput={(e) => e.stopPropagation()}
                       onInput={(e) => e.stopPropagation()}
                       onKeyDown={(e) => {
                         // 뷰어/워크리스트 전역 단축키까지 전파되면 일반 계정의 관전 모드에서
                         // 키 입력을 도구 명령으로 오인할 수 있다. IME 조합 Enter 도 전송하지 않는다.
                         e.stopPropagation();
                         if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                           e.preventDefault(); send();
                         }
                       }}
                       onKeyUp={(e) => e.stopPropagation()}
                       style={{ flex: 1, fontSize: 12 }} />
                <button className="primary" onClick={send} style={{ fontSize: 12 }}>{tr("전송")}</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
