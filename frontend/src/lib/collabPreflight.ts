// 협진 사전 점검 — "서버(sv70)가 막고 있는가" 를 **시도 전에** 가려낸다.
//
// 왜 필요한가: 화상·음성·화면 공유가 안 될 때 화면에 뜨는 것은 늘 브라우저의 같은 오류다
// (NotAllowedError). 그런데 원인은 셋 중 하나이고 **조치할 사람이 서로 다르다**:
//   ① 사용자가 거부했다        → 사용자가 주소창 사이트 설정에서 허용 (lib/mediaPerms 담당)
//   ② 장치가 없다/점유 중이다  → 사용자가 장치를 확인 (lib/mediaPerms 담당)
//   ③ **서버가 막고 있다**     → 서버 관리자가 nginx 를 고쳐야 한다. 사용자가 아무리
//                                시도해도 영원히 안 된다  ← 이 파일이 담당한다
// ③ 을 ① 로 오인하면 사용자는 사이트 설정만 계속 만지다 포기한다. 실제로 sv70 에서
// WebSocket 이 nginx 때문에 막혀 있을 때 "메시지가 안 보내진다"로만 보였다.
//
// ■ 서버가 막을 수 있는 지점 4가지 (전부 여기서 탐지한다)
//   · HTTPS 미설정      → 브라우저가 카메라·마이크·화면 공유를 **원천 차단**(보안 컨텍스트)
//   · Permissions-Policy → nginx 가 보내는 헤더 하나로 기능이 통째로 죽는다
//   · WS 업그레이드 차단 → location /api/ 의 Connection "" 가 101 을 못 만들게 한다
//   · TURN 부재          → 다른 망(타 병원) 참가자와 P2P 가 안 붙는다
//
// ⚠ 이 파일의 판정 함수는 전부 **순수 함수**다(window·fetch 를 안 쓴다). 서버 차단 판정은
//   눈으로 확인할 수 없는 규칙이라 node 테스트로 고정한다 — 잘못 판정하면 멀쩡한 서버를
//   고치라고 하거나(거짓 양성), 진짜 막힌 것을 사용자 탓으로 돌린다(거짓 음성).

export type BlockCode =
  | "insecure_context"    // 서버: HTTPS 미설정
  | "policy_blocked"      // 서버: Permissions-Policy 헤더
  | "ws_blocked"          // 서버: nginx WebSocket 업그레이드
  | "no_turn"             // 서버: 타 망 참가자용 TURN 부재(경고)
  | "no_api"              // 브라우저: 지원하지 않음
  | "user_denied"         // 사용자: 거부
  | "no_device"           // 사용자: 장치 없음/점유 중
  | "unknown";

/** 점검 대상 기능 — 이름이 Permissions-Policy 지시자와 그대로 맞다(우연이 아니라 맞춘 것). */
export type MediaKind = "microphone" | "camera" | "display-capture";

export interface BlockItem {
  code: BlockCode;
  /** true = 이 상태로는 기능이 **아예** 안 된다(시도해 봐야 소용없다) */
  blocking: boolean;
  /** true = 서버 관리자가 조치해야 한다. false = 사용자가 자기 PC 에서 해결한다 */
  serverSide: boolean;
  title: string;
  why: string;
  /** 조치 설명(산문). 실제 명령·설정은 code 에 따로 둔다 — 설정 문법은 번역 대상이 아니다 */
  action: string;
  /** 그대로 붙여 넣을 nginx 설정·셸 명령. **번역하지 않는다**(계약 값과 같은 성질) */
  snippet?: string;
  /** 어떤 기능에 대한 항목인가(마이크/카메라/화면 공유). 창이 따로 tr() 한다.
   *  ⚠ title·why·action 본문에 이 값을 **템플릿으로 끼워 넣으면 안 된다** — 이 저장소의
   *    msgid 는 원문 정확 일치라, 보간된 문장은 사전 키가 될 수 없어 영영 번역되지 않는다
   *    (i18n_rule 테스트도 리터럴만 보므로 잡지 못한다). 그래서 필드로 분리했다. */
  subject?: string;
}

const KIND_LABEL: Record<MediaKind, string> = {
  microphone: "마이크", camera: "카메라", "display-capture": "화면 공유",
};

// ── Permissions-Policy 파싱 ─────────────────────────────────────────────────

export type PolicyVerdict = "allowed" | "blocked" | "absent";

/** 응답 헤더의 Permissions-Policy(구 Feature-Policy)에서 그 기능의 상태를 읽는다.
 *
 *  문법: `camera=(), microphone=(self "https://x"), display-capture=*`
 *   · `기능=()`      → 아무도 못 쓴다 = **차단**
 *   · `기능=*`       → 전부 허용
 *   · `기능=(self …)`→ 이 오리진 허용
 *   · 지시자가 없다  → 기본값(대개 허용) = absent. 여기서 blocked 라고 단정하면 안 된다.
 *
 *  구 Feature-Policy 는 `camera 'none'; microphone 'self'` 처럼 공백 문법이라 따로 본다. */
export function parsePermissionsPolicy(header: string | null | undefined,
                                       feature: MediaKind): PolicyVerdict {
  if (!header) return "absent";
  const h = header.trim();
  if (!h) return "absent";

  // 구 Feature-Policy — 세미콜론 구분, 값은 공백 구분 토큰
  if (!h.includes("=")) {
    for (const part of h.split(";")) {
      const seg = part.trim();
      if (!seg.startsWith(feature)) continue;
      const rest = seg.slice(feature.length).trim();
      if (!rest || /'none'/i.test(rest)) return "blocked";
      return "allowed";
    }
    return "absent";
  }

  // Permissions-Policy — 쉼표 구분. 괄호 안에 쉼표는 오지 않는다(공백 구분).
  for (const part of h.split(",")) {
    const seg = part.trim();
    const eq = seg.indexOf("=");
    if (eq < 0) continue;
    if (seg.slice(0, eq).trim().toLowerCase() !== feature) continue;
    const val = seg.slice(eq + 1).trim();
    if (val === "*") return "allowed";
    const inner = val.startsWith("(") ? val.slice(1, val.endsWith(")") ? -1 : undefined) : val;
    return inner.trim() === "" ? "blocked" : "allowed";
  }
  return "absent";
}

// ── 판정 ────────────────────────────────────────────────────────────────────

/** 사전 점검 입력 — 전부 호출부가 관측해서 넣는다(이 모듈은 브라우저를 모른다). */
export interface PreflightEnv {
  secureContext: boolean;
  /** navigator.mediaDevices.getUserMedia / getDisplayMedia 존재 여부 */
  hasApi: boolean;
  /** 서버 응답에서 읽은 Permissions-Policy 판정. 못 읽었으면 "absent" */
  policy: PolicyVerdict;
  /** document.featurePolicy.allowsFeature() — 지원 브라우저에서만. 모르면 null */
  featureAllowed: boolean | null;
}

const NGINX_TLS = `server {
    listen 443 ssl http2;
    ssl_certificate     /etc/nginx/certs/<서버>.crt;
    ssl_certificate_key /etc/nginx/certs/<서버>.key;
    # … 기존 location 들 …
}
server { listen 80; return 301 https://$host$request_uri; }`;

const NGINX_POLICY = `# 1) 지금 무엇을 보내는지 확인
sudo nginx -T | grep -i -E 'permissions-policy|feature-policy'
# 2) 그 add_header 를 지우거나, 이 오리진을 허용하도록 바꾼다
add_header Permissions-Policy "camera=(self), microphone=(self), display-capture=(self)" always;
sudo nginx -t && sudo systemctl reload nginx`;

const NGINX_WS = `# location /api/ 의 Connection "" 가 업그레이드를 죽인다.
# **더 구체적인** 블록을 그 앞에 넣는다:
location /api/collab/ws {
    proxy_pass http://127.0.0.1:8000;        # 기존 /api/ 의 proxy_pass 와 같게
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
    proxy_buffering off;
}
# 배포 스크립트가 자동으로 넣는다:
sudo sh update_server.sh --apply <패키지>
sudo sh update_server.sh --check`;

const TURN_SETUP = `# 서버에 coturn 을 두고 Setting > 협진 > ICE 서버에 등록
sudo apt install coturn
# /etc/turnserver.conf : listening-port=3478, realm=<도메인>, use-auth-secret
[{"urls":"turn:<서버>:3478","username":"<id>","credential":"<pw>"}]`;

/** 미디어(마이크·카메라·화면 공유) 사전 점검 — **시도하기 전에** 부른다. */
export function checkMedia(kind: MediaKind, env: PreflightEnv): BlockItem[] {
  const out: BlockItem[] = [];
  const what = KIND_LABEL[kind];

  if (!env.secureContext) {
    // 이게 1순위다. HTTPS 가 아니면 아래 것들을 아무리 고쳐도 안 된다.
    out.push({
      code: "insecure_context", blocking: true, serverSide: true,
      title: "서버가 HTTPS 가 아닙니다", subject: what,
      why: "브라우저는 http:// 로 열린 페이지에서 카메라·마이크·화면 공유를 원천 차단합니다."
         + " 사이트 설정에서 허용해도 소용없습니다(보안 컨텍스트 규칙).",
      action: "sv70 nginx 에 TLS 인증서를 붙이고 80 → 443 으로 넘기세요.",
      snippet: NGINX_TLS,
    });
    return out;   // 이 상태에서 나머지 판정은 의미가 없다(전부 이것 때문이다)
  }

  // 서버 헤더가 확정적으로 막고 있다 — 브라우저 API 유무보다 먼저 본다(원인이 더 구체적).
  if (env.policy === "blocked" || env.featureAllowed === false) {
    out.push({
      code: "policy_blocked", blocking: true, serverSide: true,
      title: "서버가 Permissions-Policy 로 막고 있습니다", subject: what,
      why: "서버 응답 헤더가 이 기능을 금지하고 있습니다."
         + " 이 헤더가 있으면 사용자가 허용해도 브라우저가 거부합니다.",
      action: "sv70 nginx 의 Permissions-Policy 헤더를 지우거나 이 오리진을 허용하세요.",
      snippet: NGINX_POLICY,
    });
    return out;
  }

  if (!env.hasApi) {
    // HTTPS 이고 정책도 안 막는데 API 가 없다 = 브라우저 문제(구버전·비표준 웹뷰)
    out.push({
      code: "no_api", blocking: true, serverSide: false,
      title: "이 브라우저가 지원하지 않습니다", subject: what,
      why: "이 브라우저에서 해당 API 를 쓸 수 없습니다.",
      action: "최신 Chrome·Edge 로 여세요. 데스크톱 앱 웹뷰라면 앱을 업데이트하세요.",
    });
  }
  return out;
}

/** 협진 WebSocket 이 서버에서 막혔나 — 화상·음성의 **시그널링**이 이 소켓이라,
 *  이게 막히면 미디어 권한이 아무리 정상이어도 통화가 성립하지 않는다. */
export function checkSocket(s: { status: string; everOpened: boolean; lastCloseCode: number }):
BlockItem[] {
  if (s.status === "open") return [];
  // 🔴 핵심 판정: **한 번도 열린 적이 없다** = 101 이 온 적이 없다 = 프록시가 업그레이드를
  //    안 해 준다. 열렸다가 닫힌 것이면 서버 재시작·순단이라 조치가 전혀 다르다.
  if (!s.everOpened) {
    // 4401/4403/4429 는 서버 앱이 **의도적으로** 닫은 것이다 — nginx 는 정상이다.
    if (s.lastCloseCode >= 4000) return [];
    return [{
      code: "ws_blocked", blocking: true, serverSide: true,
      title: "서버가 WebSocket 연결을 막고 있습니다",
      why: "협진 연결이 한 번도 성립하지 않았습니다(핸드셰이크 101 이 오지 않음)."
         + " nginx 의 location /api/ 가 Connection \"\" 로 되어 있으면 업그레이드가 죽습니다.",
      action: "sv70 nginx 에 /api/collab/ws 업그레이드 블록을 추가하세요."
            + " 배포 스크립트가 자동으로 넣어 줍니다.",
      snippet: NGINX_WS,
    }];
  }
  return [{
    code: "unknown", blocking: true, serverSide: false,
    title: "협진 서버와 연결이 끊겼습니다",
    why: "연결은 정상적으로 되었던 적이 있습니다 — 서버 재시작이나 네트워크 순단입니다."
       + " 자동으로 다시 붙습니다.",
    action: "잠시 기다렸다가 다시 시도하세요. 계속되면 서버 상태를 확인하세요.",
  }];
}

/** 타 망(타 병원) 참가자가 있는데 TURN 이 없다 — 막힌 것은 아니지만 붙지 않을 수 있다. */
export function checkTurn(crossSite: boolean, iceCount: number): BlockItem[] {
  if (!crossSite || iceCount > 0) return [];
  return [{
    code: "no_turn", blocking: false, serverSide: true,
    title: "다른 망 참가자와는 연결이 안 될 수 있습니다",
    why: "STUN/TURN 서버가 없어 사내망 밖 상대와는 P2P 경로를 못 찾을 수 있습니다."
       + " 같은 망끼리는 지금도 정상입니다.",
    action: "TURN 서버를 두고 Setting > 협진 > ICE 서버에 등록하세요.",
    snippet: TURN_SETUP,
  }];
}

/** 실제 시도가 실패했을 때 — 오류를 원인별로 가른다.
 *  ⚠ 여기서 서버 탓과 사용자 탓을 잘못 가르면 안내가 통째로 헛돈다. */
export function classifyMediaError(kind: MediaKind, name: string, message: string): BlockItem {
  const what = KIND_LABEL[kind];
  const m = (message || "").toLowerCase();
  // Chrome 은 Permissions-Policy 차단도 NotAllowedError 로 준다 — 메시지로만 구별된다.
  if (/permissions?\s*policy|feature\s*policy|disallowed by/.test(m)) {
    return {
      code: "policy_blocked", blocking: true, serverSide: true,
      title: "서버가 Permissions-Policy 로 막고 있습니다", subject: what,
      why: "브라우저가 '정책으로 금지됨' 이라고 답했습니다 — 서버 응답 헤더가 이 기능을 막습니다.",
      action: "sv70 nginx 의 Permissions-Policy 헤더를 지우거나 이 오리진을 허용하세요.",
      snippet: NGINX_POLICY,
    };
  }
  if (name === "SecurityError") {
    return {
      code: "insecure_context", blocking: true, serverSide: true, subject: what,
      title: "보안 제약으로 차단됐습니다",
      why: "HTTPS 가 아니거나 iframe 권한이 없습니다.",
      action: "sv70 nginx 에 TLS 를 켜세요.",
      snippet: NGINX_TLS,
    };
  }
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return {
      code: "user_denied", blocking: true, serverSide: false,
      title: "브라우저에서 차단되어 있습니다", subject: what,
      why: "이 사이트의 해당 권한이 거부 상태입니다. 서버 문제가 아닙니다.",
      action: "주소창의 자물쇠(사이트 설정)에서 허용으로 바꾼 뒤 새로고침하세요.",
    };
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError"
      || name === "NotReadableError" || name === "TrackStartError"
      || name === "OverconstrainedError") {
    return {
      code: "no_device", blocking: true, serverSide: false,
      title: "장치를 쓸 수 없습니다", subject: what,
      why: "장치가 없거나 다른 프로그램이 사용 중입니다. 서버 문제가 아닙니다.",
      action: "연결(플러그·블루투스)을 확인하고, 그 장치를 쓰는 프로그램을 닫으세요.",
    };
  }
  // 사용자가 화면 선택 창에서 취소한 경우 — 오류가 아니다(호출부가 조용히 넘긴다)
  if (name === "AbortError" || name === "NotSupportedError") {
    return {
      code: "unknown", blocking: false, serverSide: false,
      title: "취소되었습니다", why: "", action: "",
    };
  }
  return {
    code: "unknown", blocking: true, serverSide: false,
    title: "시작할 수 없습니다", subject: what,
    // 브라우저 원문 메시지는 번역 대상이 아니다(사전에 있을 수 없다) — 창이 그대로 보여 준다
    why: message || "알 수 없는 오류입니다.",
    action: "다시 시도해 보고, 계속되면 서버 관리자에게 이 메시지를 전달하세요.",
  };
}

/** 알림 창을 띄울 만한가 — 조용히 넘길 것(취소 등)과 가른다. */
export function shouldAlert(items: BlockItem[]): boolean {
  return items.some((i) => i.blocking || i.serverSide);
}

// ── 실제 관측 (브라우저 전용) ────────────────────────────────────────────────
//
// 위 판정 함수들은 순수하다. 아래만 브라우저를 만진다 — 관측과 판정을 갈라 두면
// 판정 규칙 전체를 node 에서 검증할 수 있다.

/** 서버가 실제로 보내는 Permissions-Policy 를 읽는다.
 *
 *  같은 오리진 응답이면 **모든 헤더를 읽을 수 있다**(CORS 안전목록 제한은 교차 오리진에만
 *  적용된다). 그래서 sv70 이 직접 서빙하는 배치에서는 이게 추측이 아니라 관측이다.
 *  30초 캐시 — 버튼을 누를 때마다 왕복하면 시작이 느려진다(설정은 그 사이에 안 바뀐다). */
let policyCache: { at: number; header: string | null } | null = null;
const POLICY_TTL = 30_000;

export async function readServerPolicy(): Promise<string | null> {
  const now = Date.now();
  if (policyCache && now - policyCache.at < POLICY_TTL) return policyCache.header;
  let header: string | null;
  try {
    // 지금 이 문서 자체를 다시 받아 본다 — 정적 페이지에 붙는 헤더가 정책의 출처다.
    const r = await fetch(window.location.pathname, { method: "HEAD", cache: "no-store" });
    header = r.headers.get("permissions-policy") ?? r.headers.get("feature-policy");
  } catch {
    header = null;       // 못 읽었으면 "없음"이 아니라 "모름" — absent 로 떨어져 단정하지 않는다
  }
  policyCache = { at: now, header };
  return header;
}

/** document.featurePolicy — Chrome/Edge 에만 있다. 없으면 null(모름). */
function featureAllowed(kind: MediaKind): boolean | null {
  const fp = (document as unknown as {
    featurePolicy?: { allowsFeature(f: string): boolean };
  }).featurePolicy;
  if (!fp?.allowsFeature) return null;
  try { return fp.allowsFeature(kind); } catch { return null; }
}

/** 미디어 시작 **직전** 사전 점검. 서버가 막고 있으면 시도하지 않고 항목을 돌려준다. */
export async function preflightMedia(kind: MediaKind): Promise<BlockItem[]> {
  const md = navigator.mediaDevices as MediaDevices | undefined;
  const hasApi = kind === "display-capture"
    ? typeof md?.getDisplayMedia === "function"
    : typeof md?.getUserMedia === "function";
  const header = await readServerPolicy();
  return checkMedia(kind, {
    secureContext: window.isSecureContext !== false,
    hasApi,
    policy: parsePermissionsPolicy(header, kind),
    featureAllowed: featureAllowed(kind),
  });
}
