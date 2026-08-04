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
export interface MediaState { mic: boolean; camera: boolean; screen: boolean }
type MediaListener = (state: MediaState) => void;

export class WebrtcMesh {
  private pcs = new Map<number, RTCPeerConnection>();
  private streams = new Map<number, MediaStream>();
  private states = new Map<number, RTCPeerConnectionState>();
  private pendingIce = new Map<number, RTCIceCandidateInit[]>();
  private local: MediaStream | null = null;
  private audioTrack: MediaStreamTrack | null = null;
  private videoTrack: MediaStreamTrack | null = null;
  private videoSource: "camera" | "screen" | null = null;
  private listeners = new Set<Listener>();
  private mediaListeners = new Set<MediaListener>();
  private off: (() => void) | null = null;
  private myId = 0;
  // null=검사 기반 협진 세션, dm:...=1:1 친구 통화. 서로 다른 통화의
  // SDP/ICE가 한 창의 mesh에 섞이지 않도록 수신·송신 모두에 넣는 컨텍스트다.
  private signalRoom: string | null = null;

  micOn = false;
  camOn = false;
  screenOn = false;

  /** 내 로컬 스트림(자기 화면 미리보기용) */
  localStream(): MediaStream | null { return this.local; }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => { this.listeners.delete(fn); };
  }

  onMediaChange(fn: MediaListener): () => void {
    this.mediaListeners.add(fn);
    fn(this.mediaState());
    return () => { this.mediaListeners.delete(fn); };
  }

  private mediaState(): MediaState {
    return { mic: this.micOn, camera: this.camOn, screen: this.screenOn };
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
    const media = this.mediaState();
    for (const fn of [...this.mediaListeners]) {
      try { fn(media); } catch { /* 미디어 UI 하나의 예외를 격리 */ }
    }
  }

  /** 세션/DM 대화 진입 시 1회 — 시그널링 구독을 건다(미디어는 아직 켜지 않는다). */
  start(myAccountId: number, signalRoom: string | null = null): void {
    if (this.off && (this.myId !== myAccountId || this.signalRoom !== signalRoom)) this.stop();
    this.myId = myAccountId;
    this.signalRoom = signalRoom;
    if (this.off) return;
    this.off = collab.on((e) => {
      if (e.t === "rtc.ready" || e.t === "rtc.offer" || e.t === "rtc.answer"
          || e.t === "rtc.ice" || e.t === "rtc.leave") {
        if ((e.room ?? null) !== this.signalRoom) return;
        if (e.t === "rtc.ready") {
          // ready 는 **유실된 offer 를 되살리는 복구 신호**다. 이미 붙어 있는 연결에까지
          // 반응해 dropPeer 하면, 세션에 누가 들어오고 나갈 때마다(syncPeers) 통화가
          // 전원 끊겼다 다시 붙는다. 살아 있는 연결은 건드리지 않는다.
          const live = this.states.get(e.from);
          if (live === "connected" || live === "connecting") return;
          // 상대가 나중에 대화창을 열면 이전 offer는 그 브라우저에서 유실됐다.
          // ID가 큰 쪽(offer 담당)이 연결을 새로 만들어 재전송한다.
          if (this.myId > e.from) {
            this.dropPeer(e.from);
            void this.connectTo(e.from);
          } else {
            this.peer(e.from);
          }
        }
        else if (e.t === "rtc.offer") void this.onOffer(e.from, e.d as RTCSessionDescriptionInit);
        else if (e.t === "rtc.answer") void this.onAnswer(e.from, e.d as RTCSessionDescriptionInit);
        else if (e.t === "rtc.ice") void this.onIce(e.from, e.d as RTCIceCandidateInit);
        else this.dropPeer(e.from);
      }
      else if (e.t === "left") this.dropPeer(e.id);
      else if (e.t === "session.closed" && this.signalRoom === null) this.stop();
    });
  }

  stop(): void {
    for (const id of [...this.pcs.keys()]) {
      this.sendRtc("rtc.leave", id, null);
      this.dropPeer(id);
    }
    this.off?.();
    this.off = null;
    this.stopLocal();
    this.signalRoom = null;
    this.emit();
  }

  private sendRtc(t: "rtc.ready" | "rtc.offer" | "rtc.answer" | "rtc.ice" | "rtc.leave",
                  to: number, d: unknown): boolean {
    return collab.send(this.signalRoom ? { t, to, d, room: this.signalRoom } : { t, to, d });
  }

  // ── 로컬 미디어 ───────────────────────────────────────────────────────────
  /** 이전 호출부 호환용 — mic/cam 두 값만 받으므로 화면 공유는 종료한다. */
  async setMedia(mic: boolean, cam: boolean): Promise<void> {
    if (this.screenOn) await this.setScreenShare(false);
    await this.setMicrophone(mic);
    await this.setCamera(cam);
  }

  async setMicrophone(enabled: boolean): Promise<void> {
    if (enabled === this.micOn) return;
    if (!enabled) {
      this.replaceAudio(null);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("이 브라우저는 마이크를 지원하지 않습니다");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: false });
    const track = stream.getAudioTracks()[0];
    if (!track) { stream.getTracks().forEach((t) => t.stop()); throw new Error("사용 가능한 마이크가 없습니다"); }
    stream.getTracks().filter((t) => t !== track).forEach((t) => t.stop());
    this.replaceAudio(track);
  }

  async setCamera(enabled: boolean): Promise<void> {
    if (enabled === this.camOn) return;
    if (!enabled) {
      if (this.videoSource === "camera") this.replaceVideo(null, null);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("이 브라우저는 카메라를 지원하지 않습니다");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: VIDEO_CONSTRAINTS });
    const track = stream.getVideoTracks()[0];
    if (!track) { stream.getTracks().forEach((t) => t.stop()); throw new Error("사용 가능한 카메라가 없습니다"); }
    stream.getTracks().filter((t) => t !== track).forEach((t) => t.stop());
    this.replaceVideo(track, "camera");       // 화면 공유 중이었다면 카메라로 교체
  }

  async setScreenShare(enabled: boolean): Promise<void> {
    if (enabled === this.screenOn) return;
    if (!enabled) {
      if (this.videoSource === "screen") this.replaceVideo(null, null);
      return;
    }
    const getDisplay = navigator.mediaDevices?.getDisplayMedia?.bind(navigator.mediaDevices);
    if (!getDisplay) throw new Error("이 브라우저는 화면 공유를 지원하지 않습니다");
    const stream = await getDisplay({
      video: { frameRate: { ideal: 15, max: 20 } }, audio: false,
    });
    const track = stream.getVideoTracks()[0];
    if (!track) { stream.getTracks().forEach((t) => t.stop()); throw new Error("공유할 화면을 선택하지 않았습니다"); }
    stream.getTracks().filter((t) => t !== track).forEach((t) => t.stop());
    this.replaceVideo(track, "screen");       // 카메라 중이었다면 화면으로 교체
    track.addEventListener("ended", () => {
      // 브라우저의 [공유 중지] 버튼으로 종료한 경우에도 UI와 송신 트랙을 즉시 맞춘다.
      if (this.videoTrack === track && this.videoSource === "screen") this.replaceVideo(null, null);
    }, { once: true });
  }

  private replaceAudio(track: MediaStreamTrack | null) {
    if (this.audioTrack && this.audioTrack !== track) this.audioTrack.stop();
    this.audioTrack = track;
    this.micOn = !!track;
    this.rebuildLocal();
  }

  private replaceVideo(track: MediaStreamTrack | null, source: "camera" | "screen" | null) {
    if (this.videoTrack && this.videoTrack !== track) this.videoTrack.stop();
    this.videoTrack = track;
    this.videoSource = track ? source : null;
    this.camOn = this.videoSource === "camera";
    this.screenOn = this.videoSource === "screen";
    this.rebuildLocal();
  }

  private rebuildLocal() {
    const tracks = [this.audioTrack, this.videoTrack].filter((t): t is MediaStreamTrack => !!t);
    this.local = tracks.length ? new MediaStream(tracks) : null;
    // 연결을 만들 때 audio/video transceiver 를 미리 확보하므로 replaceTrack 만으로 즉시 송신된다.
    for (const pc of this.pcs.values()) this.attachTracks(pc);
    this.emit();
  }

  private stopLocal() {
    this.audioTrack?.stop();
    this.videoTrack?.stop();
    this.audioTrack = this.videoTrack = null;
    this.videoSource = null;
    this.local = null;
    this.micOn = this.camOn = this.screenOn = false;
    this.emit();
  }

  private attachTracks(pc: RTCPeerConnection) {
    for (const kind of ["audio", "video"] as const) {
      const track = kind === "audio" ? this.audioTrack : this.videoTrack;
      const txs = pc.getTransceivers().filter((t) => t.receiver.track.kind === kind);
      // ⚠ 원격 offer 를 적용하면 브라우저가 m-line 마다 **새 transceiver** 를 만든다.
      //   미리 선점해 둔 것은 mid=null 고아로 남고, 거기 붙인 트랙은 영영 나가지 않는다.
      //   실브라우저 2탭 검증에서 "응답한 쪽의 음성·영상이 한 방향도 안 흐르는" 원인이 이것이었다.
      //   → 실제로 연결된(mid 있는) transceiver 를 우선 쓰고, 없을 때만 선점분을 쓴다.
      const tx = txs.find((t) => t.mid !== null) ?? txs[0];
      if (!tx) continue;
      // 브라우저가 만든 associated transceiver 는 기본이 recvonly 다. 그대로 answer 하면
      // 내 미디어가 나갈 자리가 없다 — 장치를 나중에 켜도 되도록 항상 sendrecv 로 열어 둔다.
      if (tx.direction === "recvonly" || tx.direction === "inactive") tx.direction = "sendrecv";
      void tx.sender.replaceTrack(track).catch(() => {});
    }
  }

  // ── 피어 연결 ─────────────────────────────────────────────────────────────
  private peer(id: number): RTCPeerConnection {
    const found = this.pcs.get(id);
    if (found) return found;
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    this.pcs.set(id, pc);
    this.states.set(id, "new");
    // 핵심: 로컬 장치를 켜기 **전에** 송수신 m-line 을 협상한다. 이후 마이크/카메라/화면을
    // 켜도 addTrack 재협상 없이 replaceTrack 으로 상대에게 바로 전달된다.
    pc.addTransceiver("audio", { direction: "sendrecv" });
    pc.addTransceiver("video", { direction: "sendrecv" });
    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.sendRtc("rtc.ice", id, ev.candidate.toJSON());
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
    try {
      const offer = await pc.createOffer();
      if (this.pcs.get(id) !== pc) return;  // rtc.ready가 중간에 재연결을 시작함
      await pc.setLocalDescription(offer);
      if (this.pcs.get(id) === pc) this.sendRtc("rtc.offer", id, offer);
    } catch {
      if (this.pcs.get(id) === pc) this.dropPeer(id);
    }
  }

  /** 세션 참가자 명단과 현재 연결을 맞춘다(들어온 사람은 연결, 나간 사람은 정리) */
  syncPeers(memberIds: number[]): void {
    const want = new Set(memberIds.filter((x) => x !== this.myId));
    for (const id of want) {
      // connectTo 가 pc 를 만들기 **전에** 신규 여부를 봐야 한다(연결 뒤엔 항상 has=true).
      const fresh = !this.pcs.has(id);
      void this.connectTo(id);
      // 내가 지금 수신 준비됐음을 알린다. 먼저 열어 둔 상대의 유실 offer를 복구한다.
      // 이미 연결이 있으면 복구할 것이 없다 — 보내면 상대가 멀쩡한 통화를 끊는다.
      if (fresh && this.myId < id) this.sendRtc("rtc.ready", id, null);
    }
    for (const id of [...this.pcs.keys()]) if (!want.has(id)) this.dropPeer(id);
  }

  private async onOffer(from: number, sdp: RTCSessionDescriptionInit) {
    const pc = this.peer(from);
    await pc.setRemoteDescription(sdp);
    await this.flushIce(from, pc);
    // answer 를 만들기 **전에** 붙여야 한다. 여기서 associated transceiver 를 sendrecv 로 열지
    // 않으면 answer 가 recvonly 로 나가고, 그 뒤엔 재협상 없이는 내 미디어를 보낼 수 없다.
    this.attachTracks(pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.sendRtc("rtc.answer", from, answer);
  }

  private async onAnswer(from: number, sdp: RTCSessionDescriptionInit) {
    const pc = this.pcs.get(from);
    if (!pc || pc.signalingState === "stable") return;   // 늦게 온 answer 는 버린다
    await pc.setRemoteDescription(sdp).catch(() => { /* 상태 불일치는 무시 — 재협상이 덮는다 */ });
    await this.flushIce(from, pc);
  }

  private async onIce(from: number, cand: RTCIceCandidateInit) {
    const pc = this.pcs.get(from);
    if (!pc) return;
    if (!pc.remoteDescription) {
      const queued = this.pendingIce.get(from) ?? [];
      queued.push(cand);
      this.pendingIce.set(from, queued);
      return;
    }
    await pc.addIceCandidate(cand).catch(() => {});
  }

  private async flushIce(id: number, pc: RTCPeerConnection) {
    const queued = this.pendingIce.get(id) ?? [];
    this.pendingIce.delete(id);
    for (const cand of queued) await pc.addIceCandidate(cand).catch(() => {});
  }

  private dropPeer(id: number) {
    const pc = this.pcs.get(id);
    if (pc) { try { pc.close(); } catch { /* 무시 */ } }
    this.pcs.delete(id);
    this.streams.delete(id);
    this.states.delete(id);
    this.pendingIce.delete(id);
    this.emit();
  }
}

export const mesh = new WebrtcMesh();
