// 협진 세션 패널 — 참가자·제어권 · 룸 채팅 · 화상/음성 타일 (스크린샷 우측 열 + Room 창)
//
// 세 덩어리를 한 컬럼에 세로로 쌓는다: [비디오 타일] / [참가자·제어권] / [룸 채팅].
// 판독 화면 옆에 붙는 폭 좁은 패널이라, 각 덩어리는 접을 수 있어야 실사용이 된다.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CollabMessage, type CollabSession, type CollabUser } from "../api";
import { collab, type CollabEvent } from "../lib/collab";
import { colorOf, sessionRoom } from "../lib/collabState";
import { mesh, type PeerView } from "../lib/webrtcMesh";
import { showToast } from "../lib/toast";

/** 위임 가능한 협진 capability — 백엔드 permissions.COLLAB_CAPS 와 같은 키.
 *  ⚠ 여기에 report.write 같은 실권한을 적어 보내도 서버가 화이트리스트로 걸러 버린다.
 *    UI 는 안내일 뿐이고 판정은 서버가 한다(sanitize_collab_caps). */
const CAP_LABEL: Record<string, string> = {
  "collab.viewport": "화면 조작 (줌·팬·W/L·시리즈·레이아웃)",
  "collab.annotate": "계측·주석 (세션 한정)",
  "collab.navigate": "검사 탭 전환",
};
const ALL_CAPS = Object.keys(CAP_LABEL);

/** 접이식 구획.
 *  ⚠ 컴포넌트 **바깥**에 둬야 한다. 부모 렌더 안에서 정의하면 렌더마다 새 컴포넌트 타입이 되어
 *    React 가 하위 트리를 통째로 언마운트→재마운트한다. 그러면 이 안에 있는 채팅 입력칸이
 *    한 글자 칠 때마다 포커스를 잃는다(setDraft → 재렌더 → 재마운트). */
function Section({ title, open, onToggle, children }: {
  title: string; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div style={{ borderBottom: "1px solid var(--border)", display: "flex",
                  flexDirection: "column", minHeight: 0 }}>
      <button onClick={onToggle}
              style={{ display: "flex", alignItems: "center", gap: 4, width: "100%", padding: "4px 8px",
                       background: "var(--bg-canvas)", border: "none", cursor: "pointer",
                       color: "var(--text-secondary)", fontSize: 11, textAlign: "left" }}>
        <span>{open ? "▾" : "▸"}</span>{title}
      </button>
      {open && children}
    </div>
  );
}

function VideoTile({ id, name, stream, muted, color, label }: {
  id: number; name: string; stream: MediaStream | null; muted?: boolean;
  color: string; label?: string;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    if (stream) void el.play().catch(() => { /* 자동재생 차단은 무시 — 사용자 조작 후 붙는다 */ });
  }, [stream]);
  const hasVideo = !!stream?.getVideoTracks().some((t) => t.enabled && t.readyState === "live");
  return (
    <div style={{ position: "relative", border: `2px solid ${color}`, borderRadius: 4,
                  overflow: "hidden", background: "#000", aspectRatio: "4 / 3" }}>
      <video ref={ref} muted={muted} playsInline
             style={{ width: "100%", height: "100%", objectFit: "cover",
                      display: hasVideo ? "block" : "none" }} />
      {!hasVideo && (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center",
                      color: "var(--text-disabled)", fontSize: 22 }}>
          {(name || "?").charAt(0).toUpperCase()}
        </div>
      )}
      <div style={{ position: "absolute", left: 0, bottom: 0, right: 0, fontSize: 10.5,
                    padding: "1px 4px", background: "rgba(0,0,0,.55)", color: "#fff",
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {name}{label ? ` · ${label}` : ""}
      </div>
      {/* id 는 색과 짝지어 원격 커서와 대응시키는 값이라 화면에는 굳이 노출하지 않는다 */}
      <span hidden>{id}</span>
    </div>
  );
}

export function CollabSessionPanel({ session, onLeave, isHost, meId }: {
  /** 세션 상태의 소유자는 호출부(뷰어)다 — WS 이벤트로 갱신된 것을 내려받아 그리기만 한다 */
  session: CollabSession;
  onLeave: () => void;
  isHost: boolean;
  meId: number;
}) {
  const [peers, setPeers] = useState<PeerView[]>([]);
  const [msgs, setMsgs] = useState<CollabMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [mic, setMic] = useState(false);
  const [cam, setCam] = useState(false);
  const [showChat, setShowChat] = useState(true);
  const [showVideo, setShowVideo] = useState(true);
  const [wantCaps, setWantCaps] = useState<string[]>(["collab.viewport"]);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const room = sessionRoom(session.code);

  const joined = session.participants.filter((p) => p.state === "joined");
  const controller = joined.find((p) => p.control === "granted");
  const iControl = controller?.id === meId;
  const mySeat = joined.find((p) => p.id === meId);
  const pending = joined.filter((p) => p.control === "requested");

  // 룸 채팅 백필 + 실시간 수신
  useEffect(() => {
    api.collabMessages(room).then((r) => setMsgs(r.items)).catch(() => setMsgs([]));
  }, [room]);
  useEffect(() => collab.on((e: CollabEvent) => {
    if (e.t === "chat" && e.d.room === room) {
      setMsgs((prev) => (prev.some((x) => x.id === e.d.id) ? prev : [...prev, e.d]));
    }
  }), [room]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: "end" }); }, [msgs]);

  // WebRTC — 세션 참가자 명단이 바뀔 때마다 연결을 맞춘다
  useEffect(() => {
    mesh.start(meId);
    return () => mesh.stop();
  }, [meId]);
  useEffect(() => mesh.onChange(setPeers), []);
  useEffect(() => {
    mesh.syncPeers(joined.map((p) => p.id));
  }, [joined.map((p) => p.id).sort().join(",")]);   // eslint-disable-line react-hooks/exhaustive-deps

  const toggleMedia = useCallback(async (nextMic: boolean, nextCam: boolean) => {
    try {
      await mesh.setMedia(nextMic, nextCam);
      setMic(nextMic); setCam(nextCam);
    } catch (e) {
      showToast(e instanceof Error ? `장치를 열 수 없습니다 — ${e.message}` : "장치를 열 수 없습니다", "error");
    }
  }, []);

  const send = () => {
    const body = draft.trim();
    if (!body) return;
    if (!collab.send({ t: "chat", room, body })) { showToast("연결이 끊겼습니다", "error"); return; }
    setDraft("");
  };

  const nameOf = (id: number) => joined.find((p) => p.id === id)?.name ?? `#${id}`;

  return (
    <div style={{ width: 250, display: "flex", flexDirection: "column", height: "100%",
                  background: "var(--bg-panel)", borderLeft: "1px solid var(--border)" }}>
      {/* ── 헤더: 역할 · 종료 ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px",
                    borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontSize: 12.5, fontWeight: 700 }}>협진</span>
        <span style={{ fontSize: 10.5, padding: "1px 6px", borderRadius: 8,
                       background: isHost ? "var(--accent-subtle)" : "var(--bg-elevated)",
                       color: isHost ? "#9ec5fb" : "var(--text-secondary)" }}>
          {isHost ? "Master" : "Slave"}
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={onLeave} title={isHost ? "세션을 종료합니다(전원 나감)" : "협진에서 나갑니다"}
                style={{ fontSize: 11, padding: "2px 6px" }}>
          {isHost ? "종료" : "나가기"}
        </button>
      </div>

      {/* ── 제어권 상태 ── */}
      <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", fontSize: 11.5 }}>
        <div style={{ color: "var(--text-secondary)" }}>
          화면 조작권: <b style={{ color: iControl ? "var(--stat-final)" : "var(--text-primary)" }}>
            {controller ? (controller.id === meId ? "나" : controller.name) : "없음"}
          </b>
        </div>
        {!isHost && !iControl && (
          <div style={{ marginTop: 4 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 4 }}>
              {ALL_CAPS.map((c) => (
                <label key={c} style={{ display: "flex", gap: 4, alignItems: "flex-start", fontSize: 10.5 }}>
                  <input type="checkbox" checked={wantCaps.includes(c)}
                         onChange={(e) => setWantCaps((prev) =>
                           e.target.checked ? [...prev, c] : prev.filter((x) => x !== c))} />
                  <span>{CAP_LABEL[c]}</span>
                </label>
              ))}
            </div>
            <button className="primary" style={{ fontSize: 11, padding: "3px 8px", width: "100%" }}
                    disabled={mySeat?.control === "requested"}
                    onClick={() => collab.send({ t: "ctl.request", caps: wantCaps })}>
              {mySeat?.control === "requested" ? "승인 대기 중…" : "조작 권한 요청"}
            </button>
            <div style={{ fontSize: 10, color: "var(--text-disabled)", marginTop: 3, lineHeight: 1.5 }}>
              판독 수정 · 영상 삭제는 협진으로 위임되지 않습니다.
            </div>
          </div>
        )}
        {iControl && !isHost && (
          <button style={{ fontSize: 11, padding: "3px 8px", width: "100%", marginTop: 4 }}
                  onClick={() => collab.send({ t: "ctl.revoke" })}>조작 권한 반납</button>
        )}
        {isHost && controller?.id !== meId && (
          <button style={{ fontSize: 11, padding: "3px 8px", width: "100%", marginTop: 4 }}
                  onClick={() => collab.send({ t: "ctl.revoke" })}>조작 권한 회수</button>
        )}
        {isHost && pending.length > 0 && (
          <div style={{ marginTop: 6 }}>
            {pending.map((p) => (
              <div key={p.id} style={{ background: "var(--bg-elevated)", borderRadius: 4,
                                       padding: "5px 6px", marginBottom: 4 }}>
                <div style={{ fontSize: 11 }}><b>{p.name}</b> 님이 조작 권한을 요청했습니다</div>
                <div style={{ fontSize: 10, color: "var(--text-secondary)", margin: "2px 0 4px" }}>
                  {(p.caps ?? []).map((c) => CAP_LABEL[c] ?? c).join(" · ") || "화면 조작"}
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  <button className="primary" style={{ fontSize: 11, padding: "2px 6px", flex: 1 }}
                          onClick={() => collab.send({ t: "ctl.grant", target: p.id, caps: p.caps })}>승인</button>
                  <button style={{ fontSize: 11, padding: "2px 6px", flex: 1 }}
                          onClick={() => collab.send({ t: "ctl.revoke" })}>거절</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── 화상·음성 ── */}
      <Section title={`화상채팅 (${joined.length}명)`} open={showVideo} onToggle={() => setShowVideo((v) => !v)}>
        <div style={{ padding: 6 }}>
          <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
            <button onClick={() => void toggleMedia(!mic, cam)}
                    className={mic ? "primary" : undefined}
                    style={{ flex: 1, fontSize: 11, padding: "3px 4px" }}
                    title={mic ? "마이크 끄기" : "마이크 켜기"}>{mic ? "🎙 켜짐" : "🎙 꺼짐"}</button>
            <button onClick={() => void toggleMedia(mic, !cam)}
                    className={cam ? "primary" : undefined}
                    style={{ flex: 1, fontSize: 11, padding: "3px 4px" }}
                    title={cam ? "카메라 끄기" : "카메라 켜기"}>{cam ? "📹 켜짐" : "📹 꺼짐"}</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
            <VideoTile id={meId} name="나" stream={mesh.localStream()} muted
                       color={colorOf(meId)} label={iControl ? "조작 중" : undefined} />
            {peers.map((p) => (
              <VideoTile key={p.id} id={p.id} name={nameOf(p.id)} stream={p.stream}
                         color={colorOf(p.id)}
                         label={p.state !== "connected" ? "연결 중…"
                           : controller?.id === p.id ? "조작 중" : undefined} />
            ))}
          </div>
          {joined.length > 1 && peers.length === 0 && (
            <div style={{ fontSize: 10, color: "var(--text-disabled)", marginTop: 4, lineHeight: 1.5 }}>
              마이크나 카메라를 켜면 상대와 연결됩니다.
            </div>
          )}
        </div>
      </Section>

      {/* ── 룸 채팅 ── */}
      <Section title="채팅" open={showChat} onToggle={() => setShowChat((v) => !v)}>
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
          <div style={{ flex: 1, overflowY: "auto", padding: 6, display: "flex",
                        flexDirection: "column", gap: 5, maxHeight: 260 }}>
            {msgs.map((m) => {
              const mine = m.sender_id === meId;
              return (
                <div key={m.id} style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "88%" }}>
                  {!mine && (
                    <div style={{ fontSize: 10, color: colorOf(m.sender_id) }}>{m.sender}</div>
                  )}
                  <div style={{ background: mine ? "var(--accent-subtle)" : "var(--bg-elevated)",
                                borderRadius: 6, padding: "4px 7px", fontSize: 11.5,
                                whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.body}</div>
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>
          <div style={{ display: "flex", gap: 4, padding: 5, borderTop: "1px solid var(--border)" }}>
            <input value={draft} onChange={(e) => setDraft(e.target.value)} name="collab_room_msg"
                   autoComplete="off" placeholder="내용을 입력하세요."
                   onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                   style={{ flex: 1, fontSize: 11.5 }} />
            <button className="primary" onClick={send} style={{ fontSize: 11.5 }}>전송</button>
          </div>
        </div>
      </Section>

      {/* ── 참가자 ── */}
      <div style={{ overflowY: "auto", flexShrink: 0 }}>
        <div style={{ padding: "4px 8px", fontSize: 11, color: "var(--text-secondary)",
                      background: "var(--bg-canvas)" }}>참가자</div>
        {session.participants.filter((p) => p.state !== "denied").map((p) => (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px",
                                   fontSize: 11.5, borderBottom: "1px solid var(--border)",
                                   opacity: p.state === "joined" ? 1 : 0.5 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: colorOf(p.id),
                           flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden",
                           textOverflow: "ellipsis" }}>
              {p.name}
              <span style={{ color: "var(--text-secondary)", fontSize: 10 }}>
                {" "}{p.hospital}
              </span>
            </span>
            <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>
              {p.seat === "host" ? "Master" : p.state === "joined" ? "Slave" : "초대됨"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 초대 수신 배너 — 어느 화면에서든 뜨는 전역 알림. 수락하면 그 검사의 뷰어가 열린다. */
export function CollabInviteBanner({ invite, onAccept, onDecline }: {
  invite: { code: string; from: CollabUser; title: string; study_uid: string } | null;
  onAccept: () => void;
  onDecline: () => void;
}) {
  if (!invite) return null;
  return (
    <div style={{ position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)",
                  zIndex: 100000, background: "var(--bg-elevated)", border: "1px solid var(--accent)",
                  borderRadius: 8, padding: "12px 16px", boxShadow: "0 6px 24px rgba(0,0,0,.5)",
                  minWidth: 320 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>협진 초대</div>
      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 10 }}>
        <b style={{ color: "var(--text-primary)" }}>{invite.from.name}</b>
        {invite.from.hospital ? ` (${invite.from.hospital})` : ""} 님이 협진에 초대했습니다.
        {invite.title && <div style={{ marginTop: 2 }}>{invite.title}</div>}
      </div>
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <button onClick={onDecline} style={{ fontSize: 12 }}>거절</button>
        <button className="primary" onClick={onAccept} style={{ fontSize: 12 }}>참여</button>
      </div>
    </div>
  );
}
