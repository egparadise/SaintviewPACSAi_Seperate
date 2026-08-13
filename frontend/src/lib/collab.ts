// 협진(Co-Reading) WebSocket 클라이언트 — 프레즌스·메신저·화면 미러·제어권·WebRTC 시그널링
//
// ⚠ **창마다 소켓 1개**다(sync.ts 의 BroadcastChannel 처럼 리더를 뽑지 않는다).
//   이 스위트는 다중 모니터로 뷰어 창을 여러 개 띄우는 것이 정상 사용이고, Master 가 2번
//   모니터에서 조작한 것도 Slave 에 반영돼야 한다. 소켓을 한 창에 몰면 그 창이 닫히는 순간
//   미러가 통째로 죽고, 어느 창이 조작했는지도 서버가 구분하지 못한다.
//   백엔드 허브가 계정당 소켓 8개까지 받도록 설계된 이유가 이것이다(collab_hub.MAX_SOCKETS_PER_ACCOUNT).
//
// 인증은 서브프로토콜로 넣는다: `new WebSocket(url, ["sv.bearer", token])`.
// 브라우저 WebSocket API 는 헤더를 못 붙이고, 쿼리 토큰은 nginx 로그에 남기 때문이다
// (백엔드 app/api/deps.py 의 ws_user 주석과 같은 근거).

import { getToken } from "../api";

// ── 서버와 주고받는 표현 ─────────────────────────────────────────────────────
export interface CollabUser {
  id: number;
  username: string;
  name: string;
  role: string;            // 계정 등급 — radiologist | doctor | technologist | staff | admin
  title: string;
  hospital_id: number | null;
  hospital: string;
  online?: boolean;
  relation?: string;       // 디렉터리 검색 결과에만 — pending | accepted | declined | blocked
  relation_mine?: boolean; // 그 pending 을 내가 보냈나
}

/** 세션 참가자 — seat(host|guest)은 협진 좌석, role 은 계정 등급(둘은 다른 축이다) */
export interface CollabSeat extends CollabUser {
  seat: "host" | "guest";
  state: "invited" | "joined" | "left" | "denied";
  control: "none" | "requested" | "granted";
  caps: string[];
}

export interface CollabSession {
  code: string;
  status: "open" | "closed";
  title: string;
  host_id: number;
  study_id: number;
  study_uid: string;
  created_at: string;
  participants: CollabSeat[];
  max_participants: number;
}

export interface CollabMessage {
  id: number;
  room: string;
  kind: "text" | "system" | "invite";
  body: string;
  sender_id: number;
  sender: string;
  at: string;
  read: boolean;
}

/** 서버 → 클라 이벤트. `t` 로 판별한다(백엔드 collab_ws.py 와 1:1). */
export type CollabEvent =
  // ice_servers: 서버(AppSetting collab.ice_servers)가 정한 STUN/TURN. **null = 미설정**
  // (클라이언트 기본 로직으로), [] = 명시적으로 끔(폐쇄망). lib/collabIce 가 해석한다.
  | { t: "hello"; me: CollabUser; online: number[]; sessions: CollabSession[];
      ice_servers?: RTCIceServer[] | null }
  | { t: "pong" }
  | { t: "presence"; id: number; online: boolean }
  | { t: "friend.request"; from: CollabUser; message?: string }
  | { t: "friend.accepted"; from: CollabUser }
  // 친구 삭제로 그 DM 대화가 **양쪽에서** 지워졌다. 룸 하나에 행 하나라 한쪽만의 삭제는
  // 없다 — 받은 쪽도 화면을 즉시 비워야 한다(없는 메시지에 답장하려다 실패하지 않게).
  | { t: "dm.purged"; room: string; by: number; n: number }
  | { t: "invite"; code: string; from: CollabUser; title: string; study_uid: string }
  | { t: "declined"; code: string; id: number }
  | { t: "session"; d: CollabSession }
  | { t: "joined"; id: number; d: CollabSession }
  | { t: "left"; id: number }
  | { t: "chat"; d: CollabMessage }
  | { t: "state"; from: number; d: unknown }
  | { t: "cursor"; from: number; d: unknown }
  | { t: "ctl.requested" | "ctl.granted" | "ctl.revoked"; d: CollabSession; by: number; target: number | null }
  | { t: "exam"; d: CollabSession; granted: number[] }
  | { t: "anno.sync"; d: unknown[] }
  | { t: "anno.add" | "anno.update"; d: unknown }
  | { t: "anno.remove"; id: string; by: number }
  | { t: "adopted"; target: number; n: number }
  | { t: "rtc.ready" | "rtc.offer" | "rtc.answer" | "rtc.ice" | "rtc.leave"; from: number; d: unknown; room?: string }
  | { t: "session.closed"; code: string }
  | { t: "error"; detail: string };

/** 클라 → 서버 메시지 */
export type CollabSend =
  | { t: "ping" }
  | { t: "session.enter"; code: string }
  | { t: "session.exit" }
  | { t: "chat"; room: string; body: string }
  | { t: "state"; d: unknown }
  | { t: "cursor"; d: unknown }
  | { t: "ctl.request"; caps?: string[] }
  | { t: "ctl.grant"; target: number; caps?: string[] }
  | { t: "ctl.revoke" }
  // 발표권 **가져오기** — Master 승인을 기다리지 않는다. 서버가 collab.present 보유를
  // 확인하고 전원에게 ctl.granted 를 뿌린다(회의에서 발언권이 넘어가는 방식).
  | { t: "ctl.take" }
  | { t: "exam.switch"; study_id: number }
  // 세션 주석 — id·by 는 서버가 박는다(클라가 보낸 값은 버려진다)
  | { t: "anno.add"; d: unknown }
  | { t: "anno.update"; id: string; d: unknown }
  | { t: "anno.remove"; id: string }
  | { t: "rtc.ready" | "rtc.offer" | "rtc.answer" | "rtc.ice" | "rtc.leave"; to: number; d: unknown; room?: string };

export type CollabStatus = "idle" | "connecting" | "open" | "closed";

// ── 연결 ────────────────────────────────────────────────────────────────────
const SUBPROTOCOL = "sv.bearer";
/** 재연결 백오프 — 서버 재시작(1~2초)은 빨리 붙고, 장기 장애는 30초 간격으로 조용히 기다린다 */
const BACKOFF_MS = [500, 1000, 2000, 5000, 10000, 30000];
/** 하트비트 — 프록시(nginx proxy_read_timeout)와 중간 장비의 유휴 끊김 방지 */
const PING_MS = 25000;
/** 인증 실패 close 코드 — 재연결해 봐야 같은 결과라 즉시 포기한다(무한 재시도 폭주 방지) */
const CLOSE_UNAUTHORIZED = 4401;
/** 토큰은 유효한데 협진 계정 행이 없다(백엔드 CLOSE_NO_ACCOUNT) — 재로그인하면 미러가 생긴다 */
const CLOSE_NO_ACCOUNT = 4403;
const CLOSE_TOO_MANY = 4429;

function wsUrl(): string {
  const base = import.meta.env.VITE_API_BASE ?? "";
  if (base) {
    // API 를 다른 호스트에 둔 배치 — http→ws, https→wss 로 스킴만 바꾼다
    const u = new URL(base);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return `${u.origin}/api/collab/ws`;
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/collab/ws`;
}

type Handler = (e: CollabEvent) => void;

class CollabClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private statusHandlers = new Set<(s: CollabStatus) => void>();
  private retry = 0;
  private timer: number | null = null;
  private ping: number | null = null;
  private closedByUs = false;
  private fatal = "";           // 인증 실패 등 — 재연결하지 않을 사유

  status: CollabStatus = "idle";
  me: CollabUser | null = null;
  online = new Set<number>();
  /** 서버 설정 ICE(hello). null = 서버 미설정 — 그때만 클라이언트 기본 로직이 돈다. */
  iceServers: RTCIceServer[] | null = null;

  /** 이 창에서 핸드셰이크가 **한 번이라도** 성립했나. 서버 진단의 핵심 근거다 —
   *  false 인 채 계속 닫히면 nginx 가 업그레이드를 막고 있는 것이고(101 이 안 온다),
   *  true 였다가 닫히면 서버 재시작·네트워크 순단이다. 이 둘의 조치가 완전히 다르다. */
  everOpened = false;
  /** 마지막 close 코드. 1006(close 프레임 없음) + everOpened=false = 프록시가 끊은 것. */
  lastCloseCode = 0;

  /** 지금 이 창이 들어가 있는 세션 code — session.enter 성공 시 채워진다 */
  sessionCode: string | null = null;

  connect(): void {
    if (this.ws || this.fatal) return;
    const token = getToken();
    if (!token) return;                 // 로그인 전 — 로그인 후 다시 부른다
    this.closedByUs = false;
    this.setStatus("connecting");
    let sock: WebSocket;
    try {
      sock = new WebSocket(wsUrl(), [SUBPROTOCOL, token]);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = sock;
    sock.onopen = () => {
      this.retry = 0;
      this.everOpened = true;
      this.setStatus("open");
      this.startPing();
      // 재연결이면 있던 세션에 자동 복귀 — 사용자가 다시 누르게 하지 않는다
      if (this.sessionCode) this.send({ t: "session.enter", code: this.sessionCode });
    };
    sock.onmessage = (ev) => {
      let msg: CollabEvent;
      try { msg = JSON.parse(ev.data as string) as CollabEvent; } catch { return; }
      if (msg.t === "pong") return;
      if (msg.t === "hello") {
        this.me = msg.me;
        this.online = new Set(msg.online ?? []);
        // 서버가 정한 ICE — mesh 가 연결을 만들 때 lib/collabIce 로 해석한다.
        this.iceServers = msg.ice_servers === undefined ? null : msg.ice_servers;
      } else if (msg.t === "presence") {
        if (msg.online) this.online.add(msg.id); else this.online.delete(msg.id);
      } else if (msg.t === "session") {
        this.sessionCode = msg.d.code;
      } else if (msg.t === "session.closed" && msg.code === this.sessionCode) {
        this.sessionCode = null;
      }
      for (const h of [...this.handlers]) {
        try { h(msg); } catch { /* 핸들러 하나의 예외가 나머지를 막지 않게 */ }
      }
    };
    sock.onclose = (ev) => {
      this.ws = null;
      this.lastCloseCode = ev.code;
      this.stopPing();
      if (ev.code === CLOSE_UNAUTHORIZED) {
        // 토큰이 죽었다 — 재연결해도 같은 결과다. api.ts 의 401 처리가 곧 로그아웃시킨다.
        this.fatal = "인증이 만료되었습니다";
      } else if (ev.code === CLOSE_NO_ACCOUNT) {
        // 세션은 멀쩡하다 — 협진 계정 행만 없다(구 로그인). 재연결해 봐야 같으므로 멈추되,
        // '인증 만료' 라고 말하면 거짓 안내다. 재로그인하면 미러가 생겨 해결된다.
        this.fatal = "협진을 쓸 수 없는 계정입니다 — 로그아웃 후 다시 로그인하면 등록됩니다";
      } else if (ev.code === CLOSE_TOO_MANY) {
        this.fatal = "협진 연결 수가 한도를 넘었습니다 — 사용하지 않는 뷰어 창을 닫으세요";
      }
      this.setStatus("closed");
      if (!this.closedByUs && !this.fatal) this.scheduleReconnect();
      else if (this.fatal) this.emitLocal({ t: "error", detail: this.fatal });
    };
    sock.onerror = () => { /* onclose 가 뒤따른다 — 여기서는 아무것도 하지 않는다 */ };
  }

  close(): void {
    this.closedByUs = true;
    if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
    this.stopPing();
    this.sessionCode = null;
    try { this.ws?.close(1000); } catch { /* 무시 */ }
    this.ws = null;
    this.setStatus("idle");
  }

  /** 로그인 직후·재로그인 — fatal 을 풀고 다시 붙는다 */
  reset(): void {
    this.fatal = "";
    this.retry = 0;
    this.close();
    this.closedByUs = false;
    this.connect();
  }

  send(msg: CollabSend): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try { this.ws.send(JSON.stringify(msg)); return true; } catch { return false; }
  }

  /** 세션 입장 — 서버가 참가 처리(+임시 열람권 발급)한 뒤 `session` 이벤트로 답한다 */
  enter(code: string): void {
    this.sessionCode = code;
    this.send({ t: "session.enter", code });
  }

  exit(): void {
    this.sessionCode = null;
    this.send({ t: "session.exit" });
  }

  on(h: Handler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  onStatus(h: (s: CollabStatus) => void): () => void {
    this.statusHandlers.add(h);
    h(this.status);
    return () => this.statusHandlers.delete(h);
  }

  private emitLocal(e: CollabEvent) {
    for (const h of [...this.handlers]) {
      try { h(e); } catch { /* 무시 */ }
    }
  }

  private setStatus(s: CollabStatus) {
    if (this.status === s) return;
    this.status = s;
    for (const h of [...this.statusHandlers]) {
      try { h(s); } catch { /* 무시 */ }
    }
  }

  private scheduleReconnect() {
    if (this.timer !== null) return;
    const wait = BACKOFF_MS[Math.min(this.retry, BACKOFF_MS.length - 1)];
    this.retry++;
    this.timer = window.setTimeout(() => { this.timer = null; this.connect(); }, wait);
  }

  private startPing() {
    this.stopPing();
    this.ping = window.setInterval(() => this.send({ t: "ping" }), PING_MS);
  }

  private stopPing() {
    if (this.ping !== null) { window.clearInterval(this.ping); this.ping = null; }
  }
}

export const collab = new CollabClient();

// 창이 닫힐 때 정리 — 서버가 프레즌스를 즉시 내리게 한다(TCP 타임아웃을 기다리지 않게)
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => collab.close());
}
