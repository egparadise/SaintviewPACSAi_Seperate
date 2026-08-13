// 협진 ICE 서버 해석 — 통화가 지나갈 네트워크 길(STUN/TURN)을 어디서 가져올지 정한다.
//
// 왜 이 모듈이 생겼나(실사고 2026-08-12): sv70 에서 1:1 통화가 "연결 중…" 이 떴다가
// 사라졌다. 신호(offer/answer)는 서버로 정상으로 오갔는데 **두 PC 사이의 미디어 경로**를
// 못 찾은 것이다(ICE 실패). 원인은 ICE 기본값이 빈 배열이었던 것 —
//   · sv70 은 클라우드 서버다. 사용자들이 서로 다른 망(다른 건물·집)에서 접속한다.
//     STUN 없이는 서로 다른 NAT 사이에 경로 자체가 없다.
//   · 같은 LAN 이어도 요즘 브라우저는 호스트 후보를 mDNS(.local)로 가린다 —
//     멀티캐스트가 막힌 병원망에서는 같은 책상 옆자리끼리도 P2P 가 안 붙는다.
// "폐쇄망에서 외부 STUN 질의 금지"라는 원래 걱정은 **접속 주소가 사설이면 기본을 끄는**
// 휴리스틱으로 남긴다(클라우드 배치는 공인 도메인, 폐쇄망 배치는 내부 IP/사설 도메인).
//
// 세 층 우선순위 (위가 이긴다):
//   ① 이 PC 설정(localStorage)  — 좌석별 예외. **빈 배열도 존중**한다(명시적 '끔')
//   ② 서버 설정(AppSetting collab.ice_servers, WS hello 로 배달) — 기관 전체. 빈 배열 존중
//   ③ 기본값 — 공인 주소로 접속했으면 공개 STUN, 사설 주소면 없음
//
// ⚠ 순수 모듈이다(window·localStorage 를 직접 읽지 않는다) — 이 우선순위가 틀리면
//   "관리자가 TURN 을 넣었는데 안 먹는" 류의 사고가 되므로 node 테스트로 고정한다.

export const ICE_LS_KEY = "sv_collab_ice";

/** 기본 공개 STUN — 구글 공용. 공인망 배치에서 '설정 없이도 대부분 연결'을 성립시킨다.
 *  TURN 이 아니므로 일부 망(대칭 NAT 양쪽)은 여전히 실패한다 — 그때는 서버 설정에 TURN. */
export const DEFAULT_STUN: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

export type IceSource = "local" | "server" | "default" | "none";

/** JSON 문자열 → RTCIceServer[]. null = "설정 없음"(파싱 불가 포함 — 없는 것으로 강등).
 *  [] 는 **유효한 값**이다(명시적으로 끈 것) — null 과 절대 섞지 않는다. */
export function parseIceJson(raw: string | null | undefined): RTCIceServer[] | null {
  if (raw == null || raw.trim() === "") return null;
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    return sanitizeIceServers(v);
  } catch { return null; }
}

/** 서버/설정에서 온 목록 정규화 — urls 가 stun:/turn:/turns: 인 항목만, 아는 키만 남긴다.
 *  (설정 오타·주입이 RTCPeerConnection 생성 예외로 이어지면 통화가 통째로 죽는다) */
export function sanitizeIceServers(list: unknown): RTCIceServer[] {
  if (!Array.isArray(list)) return [];
  const out: RTCIceServer[] = [];
  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    const o = it as { urls?: unknown; username?: unknown; credential?: unknown };
    const urls = (Array.isArray(o.urls) ? o.urls : [o.urls])
      .filter((u): u is string => typeof u === "string")
      .filter((u) => /^(stun|turn|turns):/i.test(u.trim()))
      .map((u) => u.trim());
    if (!urls.length) continue;
    const row: RTCIceServer = { urls };
    if (typeof o.username === "string" && o.username) row.username = o.username;
    if (typeof o.credential === "string" && o.credential) row.credential = o.credential;
    out.push(row);
  }
  return out;
}

/** 접속 주소가 사설망인가 — 사설이면 기본 STUN 을 켜지 않는다(폐쇄망 배려).
 *  판정 대상은 **내가 접속한 주소**다(내 PC 의 IP 가 아니라). 폐쇄망 배치는 내부
 *  IP·사설 도메인으로 접속하고, 클라우드 배치는 공인 도메인으로 접속한다는 사실을 쓴다. */
export function isPrivateHost(hostname: string): boolean {
  const h = (hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".local") || h.endsWith(".localhost")) return true;
  if (h === "::1") return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;                        // 이름(도메인)은 공인으로 본다
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;     // link-local
  return false;
}

export interface IceResolution {
  servers: RTCIceServer[];
  source: IceSource;
}

/** 최종 ICE 목록 — 우선순위: 이 PC 설정 > 서버 설정 > 기본(공인 주소일 때 STUN). */
export function resolveIceServers(opts: {
  /** localStorage 원문(JSON). 없으면 null */
  localRaw: string | null;
  /** 서버(hello)가 준 목록. **미설정이면 null** — [] 는 '명시적으로 끔' */
  server: RTCIceServer[] | null;
  hostname: string;
}): IceResolution {
  const local = parseIceJson(opts.localRaw);
  if (local !== null) return { servers: local, source: "local" };
  if (opts.server !== null && Array.isArray(opts.server)) {
    return { servers: sanitizeIceServers(opts.server), source: "server" };
  }
  if (isPrivateHost(opts.hostname)) return { servers: [], source: "none" };
  return { servers: DEFAULT_STUN, source: "default" };
}

/** TURN 이 하나라도 있나 — 대칭 NAT 안내문 판정용(STUN 만으로는 일부 망이 실패한다). */
export function hasTurn(servers: RTCIceServer[]): boolean {
  return servers.some((s) => (Array.isArray(s.urls) ? s.urls : [s.urls])
    .some((u) => typeof u === "string" && /^turns?:/i.test(u)));
}
