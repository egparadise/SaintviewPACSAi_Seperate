// 협진 세션 패널 — 참가자·제어권 · 룸 채팅 · 화상/음성 타일 (스크린샷 우측 열 + Room 창)
//
// 세 덩어리를 한 컬럼에 세로로 쌓는다: [비디오 타일] / [참가자·제어권] / [룸 채팅].
// 판독 화면 옆에 붙는 폭 좁은 패널이라, 각 덩어리는 접을 수 있어야 실사용이 된다.
import { useEffect, useRef, useState } from "react";
import { api, type CollabMessage, type CollabSession, type CollabUser } from "../api";
import { collab, type CollabEvent } from "../lib/collab";
import { colorOf, sessionRoom } from "../lib/collabState";
import { closeAllPopouts, popoutStream, syncPopout } from "../lib/collabPopout";
import { t as tr, useLang } from "../lib/i18n";
import { mesh, type PeerView } from "../lib/webrtcMesh";
import { showToast } from "../lib/toast";

/** 위임 가능한 협진 capability — 백엔드 permissions.COLLAB_CAPS 와 같은 키.
 *  ⚠ 여기에 report.write 같은 실권한을 적어 보내도 서버가 화이트리스트로 걸러 버린다.
 *    UI 는 안내일 뿐이고 판정은 서버가 한다(sanitize_collab_caps). */
const CAP_LABEL: Record<string, string> = {
  "collab.viewport": "화면 조작 (줌·팬·W/L·시리즈·레이아웃)",
  "collab.annotate": "계측·주석 (세션 한정)",
  "collab.text": "텍스트·글쓰기 (세션 한정)",
  "collab.navigate": "검사 탭 전환",
  "collab.present": "발표자 되기",
};
const ALL_CAPS = Object.keys(CAP_LABEL);
/** 참가자가 '요청' 할 수 있는 것 — 발표자는 Master 가 넘겨 주는 것이라 요청 목록에서 뺀다 */
const REQUESTABLE_CAPS = ALL_CAPS.filter((c) => c !== "collab.present");

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

export function VideoTile({ id, name, stream, muted, color, label, popoutFeatures }: {
  id: number; name: string; stream: MediaStream | null; muted?: boolean;
  color: string; label?: string;
  /** 다중 모니터 배치용 window.open features — 호출부가 미리 계산해 둔 것(제스처 안에서 await 금지) */
  popoutFeatures?: string;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [, setTrackRevision] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    // 열려 있는 팝아웃도 같은 스트림으로 따라간다 — 화면 공유를 껐다 켜면 트랙이 새로 생겨
    // 참조가 바뀐다. 이게 없으면 팝아웃 창만 옛 스트림(검은 화면)에 붙어 있게 된다.
    syncPopout(String(id), stream);
    if (stream) void el.play().catch(() => { /* 자동재생 차단은 무시 — 사용자 조작 후 붙는다 */ });
    const changed = () => setTrackRevision((v) => v + 1);
    const tracks = stream?.getTracks() ?? [];
    for (const track of tracks) {
      track.addEventListener("mute", changed);
      track.addEventListener("unmute", changed);
      track.addEventListener("ended", changed);
    }
    return () => {
      for (const track of tracks) {
        track.removeEventListener("mute", changed);
        track.removeEventListener("unmute", changed);
        track.removeEventListener("ended", changed);
      }
    };
  }, [stream]);
  const hasVideo = !!stream?.getVideoTracks().some(
    (t) => t.enabled && !t.muted && t.readyState === "live");
  return (
    <div style={{ position: "relative", border: `2px solid ${color}`, borderRadius: 4,
                  overflow: "hidden", background: "#000", aspectRatio: "4 / 3" }}>
      <video ref={ref} muted={muted} autoPlay playsInline
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
      {/* 별도 창으로 — 공유 화면은 이 4:3 축소판에서 글자를 읽을 수 없다.
          다중 모니터가 기본인 판독 환경에서 "공유 화면은 옆 모니터에 크게" 가 실제 사용 방식이다.
          ⚠ onClick 안에서 **동기적으로** 열어야 한다(팝업 차단기는 제스처 밖 window.open 을 막는다). */}
      {hasVideo && (
        <button title={tr("별도 창으로 크게 보기 (다른 모니터로 옮길 수 있습니다)")}
                onClick={() => {
                  if (!popoutStream(String(id), stream, name, popoutFeatures)) {
                    showToast(tr("팝업이 차단되었습니다 — 이 사이트의 팝업을 허용해 주세요"), "error");
                  }
                }}
                style={{ position: "absolute", right: 2, top: 2, fontSize: 10, lineHeight: 1,
                         padding: "2px 5px", background: "rgba(0,0,0,.55)", color: "#fff",
                         border: "1px solid rgba(255,255,255,.35)", borderRadius: 3,
                         cursor: "pointer" }}>⧉</button>
      )}
      {/* id 는 색과 짝지어 원격 커서와 대응시키는 값이라 화면에는 굳이 노출하지 않는다 */}
      <span hidden>{id}</span>
    </div>
  );
}

export function CollabSessionPanel({ session, onLeave, isHost, meId, width = 250,
                                    popoutFeatures }: {
  /** 세션 상태의 소유자는 호출부(뷰어)다 — WS 이벤트로 갱신된 것을 내려받아 그리기만 한다 */
  session: CollabSession;
  onLeave: () => void;
  isHost: boolean;
  /** 패널 폭 — 호출부가 Splitter 로 조절해 내려 준다(계정 로밍 저장) */
  width?: number;
  /** 팝아웃 창 배치 features — 다중 모니터. 제스처 안에서 await 할 수 없어 미리 받는다 */
  popoutFeatures?: string;
  meId: number;
}) {
  useLang();
  const [peers, setPeers] = useState<PeerView[]>([]);
  const [msgs, setMsgs] = useState<CollabMessage[]>([]);
  const draftRef = useRef<HTMLDivElement | null>(null);
  const [mic, setMic] = useState(false);
  const [cam, setCam] = useState(false);
  const [screen, setScreen] = useState(false);
  const [mediaBusy, setMediaBusy] = useState("");
  const [showChat, setShowChat] = useState(true);
  const [showVideo, setShowVideo] = useState(true);
  const [wantCaps, setWantCaps] = useState<string[]>(["collab.viewport"]);
  const [capOpen, setCapOpen] = useState<number | null>(null);   // 허용 범위 패널을 연 참가자
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
    return () => {
      mesh.stop();
      // 세션이 끝나면 팝아웃 창도 함께 닫는다 — 남겨 두면 환자 화면이 떠 있는 창이
      // 주인 없이 방치된다(공용 판독 PC 에서 그건 PHI 노출이다).
      closeAllPopouts();
    };
  }, [meId]);
  useEffect(() => mesh.onChange(setPeers), []);
  useEffect(() => mesh.onMediaChange((s) => {
    setMic(s.mic); setCam(s.camera); setScreen(s.screen);
  }), []);
  useEffect(() => {
    mesh.syncPeers(joined.map((p) => p.id));
  }, [joined.map((p) => p.id).sort().join(",")]);   // eslint-disable-line react-hooks/exhaustive-deps

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

  const send = () => {
    const body = draftRef.current?.innerText.trim() ?? "";
    if (!body) return;
    if (!collab.send({ t: "chat", room, body })) { showToast(tr("연결이 끊겼습니다"), "error"); return; }
    if (draftRef.current) draftRef.current.textContent = "";
  };

  const nameOf = (id: number) => joined.find((p) => p.id === id)?.name ?? `#${id}`;

  /** 한 사람의 허용 범위 적용 — 서버가 화이트리스트로 한 번 더 거른다(UI 는 안내일 뿐). */
  const applyCaps = async (targetId: number, caps: string[]) => {
    try {
      await api.collabSetCaps(session.code, targetId, caps);
    } catch (e) {
      showToast(e instanceof Error ? e.message : tr("권한 변경 실패"), "error");
    }
  };

  /** [표시 채택] — 그 사람의 세션 주석을 정식 판독 주석으로 저장한다(Master 책임). */
  const adopt = async (targetId: number, name: string) => {
    try {
      const r = await api.collabAdopt(session.code, targetId);
      showToast(r.adopted
        ? `${name} ${tr("님의 표시")} ${r.adopted}${tr("건을 판독 주석으로 채택했습니다")}`
        : tr("채택할 표시가 없습니다"));
    } catch (e) {
      showToast(e instanceof Error ? e.message : tr("채택 실패"), "error");
    }
  };

  return (
    <div style={{ width, flexShrink: 0, display: "flex", flexDirection: "column", height: "100%",
                  background: "var(--bg-panel)", borderLeft: "1px solid var(--border)" }}>
      {/* ── 헤더: 역할 · 종료 ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px",
                    borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontSize: 12.5, fontWeight: 700 }}>{tr("협진")}</span>
        <span style={{ fontSize: 10.5, padding: "1px 6px", borderRadius: 8,
                       background: isHost ? "var(--accent-subtle)" : "var(--bg-elevated)",
                       color: isHost ? "#9ec5fb" : "var(--text-secondary)" }}>
          {isHost ? "Master" : "Slave"}
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={onLeave} title={isHost ? tr("세션을 종료합니다(전원 나감)") : tr("협진에서 나갑니다")}
                style={{ fontSize: 11, padding: "2px 6px" }}>
          {isHost ? tr("종료") : tr("나가기")}
        </button>
      </div>

      {/* ── 제어권 상태 ── */}
      <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", fontSize: 11.5 }}>
        <div style={{ color: "var(--text-secondary)" }}>
          {tr("화면 조작권:")} <b style={{ color: iControl ? "var(--stat-final)" : "var(--text-primary)" }}>
            {controller ? (controller.id === meId ? tr("나") : controller.name) : tr("없음")}
          </b>
        </div>
        {!isHost && !iControl && (
          <div style={{ marginTop: 4 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 4 }}>
              {REQUESTABLE_CAPS.map((c) => (
                <label key={c} style={{ display: "flex", gap: 4, alignItems: "flex-start", fontSize: 10.5 }}>
                  <input type="checkbox" checked={wantCaps.includes(c)}
                         onChange={(e) => setWantCaps((prev) =>
                           e.target.checked ? [...prev, c] : prev.filter((x) => x !== c))} />
                  <span>{tr(CAP_LABEL[c])}</span>
                </label>
              ))}
            </div>
            <button className="primary" style={{ fontSize: 11, padding: "3px 8px", width: "100%" }}
                    disabled={mySeat?.control === "requested"}
                    onClick={() => collab.send({ t: "ctl.request", caps: wantCaps })}>
              {mySeat?.control === "requested" ? tr("승인 대기 중…") : tr("조작 권한 요청")}
            </button>
            <div style={{ fontSize: 10, color: "var(--text-disabled)", marginTop: 3, lineHeight: 1.5 }}>
              {tr("판독 수정 · 영상 삭제는 협진으로 위임되지 않습니다.")}
            </div>
          </div>
        )}
        {iControl && !isHost && (
          <button style={{ fontSize: 11, padding: "3px 8px", width: "100%", marginTop: 4 }}
                  onClick={() => collab.send({ t: "ctl.revoke" })}>{tr("조작 권한 반납")}</button>
        )}
        {isHost && controller?.id !== meId && (
          <button style={{ fontSize: 11, padding: "3px 8px", width: "100%", marginTop: 4 }}
                  onClick={() => collab.send({ t: "ctl.revoke" })}>{tr("조작 권한 회수")}</button>
        )}
        {isHost && pending.length > 0 && (
          <div style={{ marginTop: 6 }}>
            {pending.map((p) => (
              <div key={p.id} style={{ background: "var(--bg-elevated)", borderRadius: 4,
                                       padding: "5px 6px", marginBottom: 4 }}>
                <div style={{ fontSize: 11 }}><b>{p.name}</b> {tr("님이 조작 권한을 요청했습니다")}</div>
                <div style={{ fontSize: 10, color: "var(--text-secondary)", margin: "2px 0 4px" }}>
                  {(p.caps ?? []).map((c) => tr(CAP_LABEL[c] ?? c)).join(" · ") || tr("화면 조작")}
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  <button className="primary" style={{ fontSize: 11, padding: "2px 6px", flex: 1 }}
                          onClick={() => collab.send({ t: "ctl.grant", target: p.id, caps: p.caps })}>{tr("승인")}</button>
                  <button style={{ fontSize: 11, padding: "2px 6px", flex: 1 }}
                          onClick={() => collab.send({ t: "ctl.revoke" })}>{tr("거절")}</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── 화상·음성 ── */}
      <Section title={`${tr("화상채팅")} (${joined.length}${tr("명")})`} open={showVideo} onToggle={() => setShowVideo((v) => !v)}>
        <div style={{ padding: 6 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4, marginBottom: 6 }}>
            <button onClick={() => void runMedia(() => mesh.setMicrophone(!mic), tr("마이크"))}
                    disabled={!!mediaBusy}
                    className={mic ? "primary" : undefined}
                    style={{ flex: 1, fontSize: 11, padding: "3px 4px" }}
                    title={mic ? tr("마이크 끄기") : tr("마이크 켜기")}>{mic ? `🎙 ${tr("켜짐")}` : `🎙 ${tr("꺼짐")}`}</button>
            <button onClick={() => void runMedia(() => mesh.setCamera(!cam), tr("카메라"))}
                    disabled={!!mediaBusy}
                    className={cam ? "primary" : undefined}
                    style={{ flex: 1, fontSize: 11, padding: "3px 4px" }}
                    title={cam ? tr("카메라 끄기") : screen ? tr("화면 공유를 끄고 카메라 켜기") : tr("카메라 켜기")}>
              {cam ? `📹 ${tr("켜짐")}` : `📹 ${tr("꺼짐")}`}
            </button>
            <button onClick={() => void runMedia(() => mesh.setScreenShare(!screen), tr("화면 공유"))}
                    disabled={!!mediaBusy}
                    className={screen ? "primary" : undefined}
                    style={{ flex: 1, fontSize: 11, padding: "3px 4px" }}
                    title={screen ? tr("화면 공유 중지") : cam ? tr("카메라를 끄고 화면 공유") : tr("화면 공유")}>
              {screen ? `🖥 ${tr("공유 중")}` : `🖥 ${tr("화면")}`}
            </button>
          </div>
          {mediaBusy && (
            <div style={{ fontSize: 10, color: "var(--text-secondary)", margin: "-2px 0 5px" }}>
              {mediaBusy} — {tr("권한 확인 중…")}
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
            <VideoTile id={meId} name={tr("나")} stream={mesh.localStream()} muted
                       color={colorOf(meId)} popoutFeatures={popoutFeatures}
                       label={screen ? tr("화면 공유")
                         : iControl ? tr("조작 중") : undefined} />
            {peers.map((p) => (
              <VideoTile key={p.id} id={p.id} name={nameOf(p.id)} stream={p.stream}
                         color={colorOf(p.id)} popoutFeatures={popoutFeatures}
                         label={p.state !== "connected" ? tr("연결 중…")
                           : controller?.id === p.id ? tr("조작 중") : undefined} />
            ))}
          </div>
          {joined.length > 1 && peers.length === 0 && (
            <div style={{ fontSize: 10, color: "var(--text-disabled)", marginTop: 4, lineHeight: 1.5 }}>
              {tr("마이크·카메라·화면 공유 중 하나를 켜면 상대와 연결됩니다.")}
            </div>
          )}
        </div>
      </Section>

      {/* ── 룸 채팅 ── */}
      <Section title={tr("채팅")} open={showChat} onToggle={() => setShowChat((v) => !v)}>
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
            <div key="collab-room-editor-v3" ref={draftRef}
                   className="collab-chat-editor" contentEditable={true}
                   suppressContentEditableWarning role="textbox" tabIndex={0}
                   aria-label={tr("협진 채팅 내용")} aria-placeholder={tr("내용을 입력하세요.")}
                   data-placeholder={tr("내용을 입력하세요.")}
                   onPointerDown={(e) => e.stopPropagation()}
                   onClick={(e) => e.stopPropagation()}
                   onBeforeInput={(e) => e.stopPropagation()}
                   onInput={(e) => e.stopPropagation()}
                   onKeyDown={(e) => {
                     // 뷰어/워크리스트 전역 단축키까지 전파되면 관전 모드에서 키 입력을
                     // 도구 명령으로 오인할 수 있다. IME 조합 Enter 도 전송하지 않는다.
                     e.stopPropagation();
                     if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                       e.preventDefault(); send();
                     }
                   }}
                   onKeyUp={(e) => e.stopPropagation()}
                   style={{ flex: 1, fontSize: 11.5 }} />
            <button className="primary" onClick={send} style={{ fontSize: 11.5 }}>{tr("전송")}</button>
          </div>
        </div>
      </Section>

      {/* ── 참가자 · 허용 범위 ──
          다학제의 조작면이다. Master 는 사람마다 체크박스로 즉시 켜고 끈다 —
          여러 명이 같은 권한을 **동시에** 갖는 것이 정상이라 남의 것은 건드리지 않는다.
          기본값은 Setting > 협진 에서 정하고, 여기서의 조정이 최종이다. */}
      <div style={{ overflowY: "auto", flexShrink: 0 }}>
        <div style={{ padding: "4px 8px", fontSize: 11, color: "var(--text-secondary)",
                      background: "var(--bg-canvas)" }}>{tr("참가자 · 허용 범위")}</div>
        {session.participants.filter((p) => p.state !== "denied").map((p) => {
          const isMasterRow = p.seat === "host";
          const open = capOpen === p.id;
          return (
            <div key={p.id} style={{ borderBottom: "1px solid var(--border)",
                                     opacity: p.state === "joined" ? 1 : 0.5 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px",
                            fontSize: 11.5 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: colorOf(p.id),
                               flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden",
                               textOverflow: "ellipsis" }}>
                  {p.name}
                  <span style={{ color: "var(--text-secondary)", fontSize: 10 }}>
                    {" "}{p.hospital}
                  </span>
                </span>
                {p.control === "granted" && (
                  <span title={tr("발표자 — 이 사람의 화면이 전원에게 보입니다")}
                        style={{ fontSize: 9.5, background: "var(--accent)", color: "#fff",
                                 borderRadius: 7, padding: "0 5px" }}>{tr("발표")}</span>
                )}
                <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>
                  {isMasterRow ? "Master" : p.state === "joined" ? "Slave" : tr("초대됨")}
                </span>
                {isHost && !isMasterRow && p.state === "joined" && (
                  <button onClick={() => setCapOpen(open ? null : p.id)}
                          title={tr("허용 범위 설정")}
                          style={{ fontSize: 10, padding: "1px 5px" }}>{open ? "▾" : "⚙"}</button>
                )}
              </div>
              {open && isHost && !isMasterRow && (
                <div style={{ padding: "2px 8px 6px 22px", background: "var(--bg-canvas)" }}>
                  {ALL_CAPS.filter((c) => c !== "collab.present").map((c) => (
                    <label key={c} style={{ display: "flex", gap: 4, alignItems: "flex-start",
                                            fontSize: 10.5, padding: "1px 0" }}>
                      <input type="checkbox" checked={(p.caps ?? []).includes(c)}
                             disabled={c === "collab.viewport"}
                             title={c === "collab.viewport"
                               ? tr("화면 조작은 '발표자 넘기기' 로 정합니다 — 세션당 1명")
                               : undefined}
                             onChange={(e) => {
                               const next = e.target.checked
                                 ? [...(p.caps ?? []), c]
                                 : (p.caps ?? []).filter((x) => x !== c);
                               void applyCaps(p.id, next);
                             }} />
                      <span>{CAP_LABEL[c] ?? c}</span>
                    </label>
                  ))}
                  <div style={{ display: "flex", gap: 4, marginTop: 5 }}>
                    <button style={{ fontSize: 10.5, padding: "2px 6px", flex: 1 }}
                            title={tr("이 사람의 화면을 전원에게 보여 줍니다")}
                            onClick={() => collab.send({ t: "ctl.grant", target: p.id,
                                                         caps: p.caps ?? [] })}>
                      {tr("발표자 넘기기")}
                    </button>
                    <button style={{ fontSize: 10.5, padding: "2px 6px", flex: 1 }}
                            title={tr("이 사람이 그린 표시를 정식 판독 주석으로 저장합니다")}
                            onClick={() => void adopt(p.id, p.name)}>
                      {tr("표시 채택")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
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
  useLang();
  if (!invite) return null;
  return (
    <div style={{ position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)",
                  zIndex: 100000, background: "var(--bg-elevated)", border: "1px solid var(--accent)",
                  borderRadius: 8, padding: "12px 16px", boxShadow: "0 6px 24px rgba(0,0,0,.5)",
                  minWidth: 320 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{tr("협진 초대")}</div>
      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 10 }}>
        <b style={{ color: "var(--text-primary)" }}>{invite.from.name}</b>
        {invite.from.hospital ? ` (${invite.from.hospital})` : ""} {tr("님이 협진에 초대했습니다.")}
        {invite.title && <div style={{ marginTop: 2 }}>{invite.title}</div>}
      </div>
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <button onClick={onDecline} style={{ fontSize: 12 }}>{tr("거절")}</button>
        <button className="primary" onClick={onAccept} style={{ fontSize: 12 }}>{tr("참여")}</button>
      </div>
    </div>
  );
}
