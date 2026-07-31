// 협진 화상·음성 — P2P mesh WebRTC
//
// 왜 mesh 인가(SFU 가 아니라):
//   · 미디어가 **서버를 거치지 않는다**. 환자 영상이 떠 있는 화면 앞의 음성·얼굴이
//     PACS 서버를 경유하지 않는 편이 PHI 관점에서 낫다.
//   · 신규 컨테이너가 없다. 이 스위트는 docker compose 3종(DB·Orthanc·OHIF)으로 끝나는데
//     SFU 를 넣으면 운영 대상이 하나 더 는다.
//   · 협진 정원이 6명이다(백엔드 collab_service.MAX_PARTICIPANTS). N=6 이면 각자 5개
//     업링크인데, 아래처럼 저해상(320×240/15fps)으로 묶으면 일반 사무망에서 충분하다.
//     정원을 늘리려면 SFU 가 먼저다 — mesh 는 참가자 PC 의 CPU·업로드가 먼저 무너진다.
//
// 시그널링은 협진 WebSocket 을 그대로 쓴다(rtc.offer/answer/ice). 서버는 SDP·ICE 를
// 열어 보지 않고 지정 상대에게 넘기기만 한다(백엔드 collab_ws.py 릴레이 분기).

import { collab } from "./collab";

/** 저해상 고정 — 판독 화면 옆의 작은 타일이 목적이지 화상회의 품질이 목적이 아니다.
 *  이 값이 mesh 정원 6명을 성립시키는 근거다(올리려면 SFU 부터). */
const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 20 },
};
const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true, noiseSuppression: true, autoGainControl: true,
};

/** ICE 서버 — 기본은 **비어 있다**(사내망 host candidate 만으로 연결된다).
 *  병원 밖 협진이 필요하면 설정에서 STUN/TURN 을 넣는다. 공개 STUN 을 기본값으로 박아 두면
 *  폐쇄망 병원에서 매 통화마다 못 나가는 외부 주소로 질의하다 연결이 느려진다. */
function iceServers(): RTCIceServer[] {
  try {
    const raw = localStorage.getItem("sv_collab_ice");
    if (!raw) return [];
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as RTCIceServer[]) : [];
  } catch { return []; }
}

export interface PeerView {
  id: number;                 // account_id
  stream: MediaStream | null;
  state: RTCPeerConnectionState;
}

type Listener = (peers: PeerView[]) => void;

class WebrtcMesh {
  private pcs = new Map<number, RTCPeerConnection>();
  private streams = new Map<number, MediaStream>();
  private states = new Map<number, RTCPeerConnectionState>();
  private local: MediaStream | null = null;
  private listeners = new Set<Listener>();
  private off: (() => void) | null = null;
  private myId = 0;

  micOn = false;
  camOn = false;

  /** 내 로컬 스트림(자기 화면 미리보기용) */
  localStream(): MediaStream | null { return this.local; }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => { this.listeners.delete(fn); };
  }

  private snapshot(): PeerView[] {
    return [...this.pcs.keys()].map((id) => ({
      id, stream: this.streams.get(id) ?? null,
      state: this.states.get(id) ?? "new",
    }));
  }

  private emit() {
    const snap = this.snapshot();
    for (const fn of [...this.listeners]) {
      try { fn(snap); } catch { /* 리스너 하나의 예외가 나머지를 막지 않게 */ }
    }
  }

  /** 세션 참가 시 1회 — 시그널링 구독을 건다(미디어는 아직 켜지 않는다). */
  start(myAccountId: number): void {
    this.myId = myAccountId;
    if (this.off) return;
    this.off = collab.on((e) => {
      if (e.t === "rtc.offer") void this.onOffer(e.from, e.d as RTCSessionDescriptionInit);
      else if (e.t === "rtc.answer") void this.onAnswer(e.from, e.d as RTCSessionDescriptionInit);
      else if (e.t === "rtc.ice") void this.onIce(e.from, e.d as RTCIceCandidateInit);
      else if (e.t === "rtc.leave") this.dropPeer(e.from);
      else if (e.t === "left") this.dropPeer(e.id);
      else if (e.t === "session.closed") this.stop();
    });
  }

  stop(): void {
    for (const id of [...this.pcs.keys()]) {
      collab.send({ t: "rtc.leave", to: id, d: null });
      this.dropPeer(id);
    }
    this.off?.();
    this.off = null;
    this.stopLocal();
    this.emit();
  }

  // ── 로컬 미디어 ───────────────────────────────────────────────────────────
  /** 마이크·카메라 토글. 둘 다 끄면 로컬 스트림을 완전히 해제한다(카메라 LED 가 꺼져야 한다). */
  async setMedia(mic: boolean, cam: boolean): Promise<void> {
    if (!mic && !cam) {
      this.stopLocal();
      this.micOn = this.camOn = false;
      for (const pc of this.pcs.values()) {
        for (const s of pc.getSenders()) { if (s.track) await s.replaceTrack(null).catch(() => {}); }
      }
      this.emit();
      return;
    }
    const want: MediaStreamConstraints = {
      audio: mic ? AUDIO_CONSTRAINTS : false,
      video: cam ? VIDEO_CONSTRAINTS : false,
    };
    const next = await navigator.mediaDevices.getUserMedia(want);
    this.stopLocal();
    this.local = next;
    this.micOn = mic;
    this.camOn = cam;
    // 이미 붙어 있는 피어에는 트랙을 교체한다 — 재협상 없이 켜고 끌 수 있다
    for (const pc of this.pcs.values()) this.attachTracks(pc);
    this.emit();
  }

  private stopLocal() {
    this.local?.getTracks().forEach((t) => t.stop());
    this.local = null;
  }

  private attachTracks(pc: RTCPeerConnection) {
    const senders = pc.getSenders();
    for (const kind of ["audio", "video"] as const) {
      const track = this.local?.getTracks().find((t) => t.kind === kind) ?? null;
      const sender = senders.find((s) => s.track?.kind === kind)
        ?? senders.find((s) => !s.track && (s as RTCRtpSender & { _kind?: string })._kind === kind);
      if (sender) void sender.replaceTrack(track).catch(() => {});
      else if (track && this.local) pc.addTrack(track, this.local);
    }
  }

  // ── 피어 연결 ─────────────────────────────────────────────────────────────
  private peer(id: number): RTCPeerConnection {
    const found = this.pcs.get(id);
    if (found) return found;
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    this.pcs.set(id, pc);
    pc.onicecandidate = (ev) => {
      if (ev.candidate) collab.send({ t: "rtc.ice", to: id, d: ev.candidate.toJSON() });
    };
    pc.ontrack = (ev) => {
      const ms = this.streams.get(id) ?? new MediaStream();
      // 같은 트랙이 두 번 오는 브라우저가 있어 중복을 막는다
      if (!ms.getTracks().some((t) => t.id === ev.track.id)) ms.addTrack(ev.track);
      this.streams.set(id, ms);
      this.emit();
    };
    pc.onconnectionstatechange = () => {
      this.states.set(id, pc.connectionState);
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.dropPeer(id);
      else this.emit();
    };
    if (this.local) this.attachTracks(pc);
    return pc;
  }

  /** 새 참가자와 연결 시작. **id 가 큰 쪽이 offer 를 건다** — 양쪽이 동시에 offer 를 보내
   *  glare(협상 충돌)가 나는 것을 규칙 하나로 막는다(Perfect Negotiation 의 간이판). */
  async connectTo(id: number): Promise<void> {
    if (id === this.myId || this.pcs.has(id)) return;
    if (this.myId < id) { this.peer(id); return; }   // 상대가 걸어 온다 — 받을 준비만
    const pc = this.peer(id);
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    collab.send({ t: "rtc.offer", to: id, d: offer });
  }

  /** 세션 참가자 명단과 현재 연결을 맞춘다(들어온 사람은 연결, 나간 사람은 정리) */
  syncPeers(memberIds: number[]): void {
    const want = new Set(memberIds.filter((x) => x !== this.myId));
    for (const id of want) void this.connectTo(id);
    for (const id of [...this.pcs.keys()]) if (!want.has(id)) this.dropPeer(id);
  }

  private async onOffer(from: number, sdp: RTCSessionDescriptionInit) {
    const pc = this.peer(from);
    await pc.setRemoteDescription(sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    collab.send({ t: "rtc.answer", to: from, d: answer });
  }

  private async onAnswer(from: number, sdp: RTCSessionDescriptionInit) {
    const pc = this.pcs.get(from);
    if (!pc || pc.signalingState === "stable") return;   // 늦게 온 answer 는 버린다
    await pc.setRemoteDescription(sdp).catch(() => { /* 상태 불일치는 무시 — 재협상이 덮는다 */ });
  }

  private async onIce(from: number, cand: RTCIceCandidateInit) {
    const pc = this.pcs.get(from);
    if (!pc) return;
    // remoteDescription 이전에 도착한 후보는 브라우저가 큐에 넣거나 던진다 — 던지면 무시
    await pc.addIceCandidate(cand).catch(() => {});
  }

  private dropPeer(id: number) {
    const pc = this.pcs.get(id);
    if (pc) { try { pc.close(); } catch { /* 무시 */ } }
    this.pcs.delete(id);
    this.streams.delete(id);
    this.states.delete(id);
    this.emit();
  }
}

export const mesh = new WebrtcMesh();
