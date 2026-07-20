// Saintview PACS AI — 프레임
// 흐름: 홈 → (가입) → [관리자 로그인 → 관리자 콘솔] 또는 [Client 뷰어 로그인(병원ID+ID+PW) → PACS Viewer]
// 포트 계약: 5173 Landing(소개+가입) / 5174 관리자 포털 / 5175 Client 포털 / 그 외 'all' 폴백(단일 서빙 전체 기능)
// ⚠ 5174/5175 는 별개 오리진 — localStorage 세션 미공유. 각 포털에서 최초 1회 로그인이 의도된 설계다.
import { useState } from "react";
import "./theme.css";
import { hasToken, setToken, api, type LoginResp } from "./api";
import { portalRole, portalUrl, type PortalTarget } from "./lib/portals";
import { Worklist } from "./pages/Worklist";
import { SettingsModal } from "./pages/SettingsModal";
import { ViewerWindow } from "./pages/ViewerWindow";
import { ReportWindow } from "./pages/ReportWindow";
import { Landing } from "./pages/Landing";
import { Signup } from "./pages/Signup";
import { ClientLogin } from "./pages/ClientLogin";
import { SessionGuard } from "./pages/SessionGuard";
import { MobileCapture } from "./pages/MobileCapture";
import { AdminConsole } from "./pages/AdminConsole";

// 이 오리진의 포털 역할(포트 기반) — 모듈 로드 시 1회 판정
const PORTAL = portalRole();
// 다른 포털로 이동(오리진 교체) — 세션은 오리진별이므로 이동 후 별도 로그인
const gotoPortal = (t: PortalTarget) => { window.location.href = portalUrl(t); };

// 뷰어/판독 새 창 모드 — 워크리스트 없이 전용 페이지
const _params = new URLSearchParams(window.location.search);
const IS_VIEWER_WINDOW = _params.get("viewer") === "2d";
const IS_REPORT_WINDOW = _params.get("report") === "1";
// 공개 딥링크: ?signup=1 가입 · ?login=1 관리자 로그인 · ?client=1 Client 뷰어 로그인
const INITIAL_AUTH_VIEW: AuthView =
  _params.get("signup") === "1" ? "signup"
    : _params.get("client") === "1" ? "clientlogin"
      : _params.get("login") === "1" ? "adminlogin" : "landing";

// 딥링크 호환: landing 포털에서 ?login=1/?client=1 은 해당 포털 오리진으로 이동
if (PORTAL === "landing" && !IS_VIEWER_WINDOW && !IS_REPORT_WINDOW) {
  if (INITIAL_AUTH_VIEW === "adminlogin") window.location.replace(portalUrl("admin"));
  else if (INITIAL_AUTH_VIEW === "clientlogin") window.location.replace(portalUrl("client"));
}

type AuthView = "landing" | "adminlogin" | "clientlogin" | "signup";
type Session = {
  name: string; role: string; mode: "admin" | "client";
  hospitalId: number | null; hospitalName: string;
};

function restoreSession(): Session | null {
  if (!hasToken()) return null;
  const ls = localStorage;
  return {
    name: ls.getItem("sv_user") ?? "", role: ls.getItem("sv_role") ?? "",
    mode: (ls.getItem("sv_mode") as "admin" | "client") ?? "admin",
    hospitalId: ls.getItem("sv_active_hospital") ? Number(ls.getItem("sv_active_hospital")) : null,
    hospitalName: ls.getItem("sv_hname") ?? "",
  };
}

// 관리자(2필드) 로그인 폼
function AdminLogin({ onLogin, onBack }: { onLogin: (r: LoginResp) => void; onBack: () => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(localStorage.getItem("sv_remember") === "1");
  const [error, setError] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await api.login(username, password);
      setToken(r.token, remember);
      localStorage.setItem("sv_remember", remember ? "1" : "0");
      onLogin(r);
    } catch (err) { setError(err instanceof Error ? err.message : "로그인 실패"); }
  };
  return (
    <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
      <form onSubmit={submit} style={{ background: "var(--bg-panel)", padding: 32, borderRadius: 8,
                                       border: "1px solid var(--border)", width: 320, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 18, fontWeight: 700 }}>Saintview <span style={{ color: "var(--ai)" }}>PACS AI</span></div>
        <div style={{ fontSize: 12.5, color: "var(--text-secondary)", marginTop: -6 }}>관리자 로그인</div>
        <input placeholder="아이디" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input placeholder="비밀번호" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--text-secondary)" }}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> 자동 로그인
        </label>
        {error && <div style={{ color: "var(--stat-emergency)", fontSize: 12 }}>{error}</div>}
        <button className="primary" type="submit">로그인</button>
        <button type="button" onClick={onBack} style={{ background: "none", border: "none", color: "var(--text-secondary)", fontSize: 12, cursor: "pointer" }}>← 홈으로</button>
      </form>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(restoreSession);
  const [authView, setAuthView] = useState<AuthView>(INITIAL_AUTH_VIEW);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const logout = () => {
    // 뷰어 창(sv_viewer)도 닫히도록 신호 — storage 이벤트는 같은 오리진 창에만 전달되므로
    // 이 로그아웃 연쇄는 현재 포털(오리진) 내에서만 동작한다(다른 포털 세션은 영향 없음, 의도된 설계).
    localStorage.setItem("sv_logout", String(Date.now()));
    setToken(null);
    ["sv_user", "sv_role", "sv_mode", "sv_active_hospital", "sv_hname"].forEach((k) => localStorage.removeItem(k));
    setSession(null); setAuthView("landing");
  };

  // 관리자 로그인 성공
  const onAdminLogin = (r: LoginResp) => {
    localStorage.setItem("sv_user", r.username);
    localStorage.setItem("sv_role", r.role);
    localStorage.setItem("sv_mode", "admin");
    localStorage.removeItem("sv_active_hospital");
    setSession({ name: r.username, role: r.role, mode: "admin", hospitalId: r.hospital_id ?? null, hospitalName: "" });
  };
  // Client 뷰어 로그인 성공 — 병원 스코프로 뷰어 진입
  const onClientLogin = (r: LoginResp) => {
    localStorage.setItem("sv_user", r.username);
    localStorage.setItem("sv_role", r.role);
    localStorage.setItem("sv_mode", "client");
    if (r.hospital_id) localStorage.setItem("sv_active_hospital", String(r.hospital_id));
    localStorage.setItem("sv_hname", r.hospital_name ?? "");
    setSession({ name: r.username, role: r.role, mode: "client", hospitalId: r.hospital_id ?? null, hospitalName: r.hospital_name ?? "" });
  };

  // 휴대폰 촬영 페이지 — 토큰이 자격증명(로그인 불필요), QR 로 진입
  const captureToken = new URLSearchParams(window.location.search).get("capture");
  if (captureToken) return <MobileCapture token={captureToken} />;

  // 미인증 — 포털 역할별 강제 라우팅
  if (!session) {
    if (PORTAL === "landing") {
      // Landing 포털: 소개+가입만. 로그인은 각 포털 오리진으로 이동
      if (authView === "signup") return <Signup onCancel={() => setAuthView("landing")} onDone={() => gotoPortal("client")} />;
      return <Landing onSignup={() => setAuthView("signup")} onAdminLogin={() => gotoPortal("admin")} onClientLogin={() => gotoPortal("client")} />;
    }
    if (PORTAL === "admin") return <AdminLogin onLogin={onAdminLogin} onBack={() => gotoPortal("landing")} />;
    if (PORTAL === "client") return <ClientLogin onLogin={onClientLogin} onBack={() => gotoPortal("landing")} />;
    // 'all' 폴백 — 기존 단일 오리진 동작 100% 유지
    if (authView === "signup") return <Signup onCancel={() => setAuthView("landing")} onDone={() => setAuthView("clientlogin")} />;
    if (authView === "adminlogin") return <AdminLogin onLogin={onAdminLogin} onBack={() => setAuthView("landing")} />;
    if (authView === "clientlogin") return <ClientLogin onLogin={onClientLogin} onBack={() => setAuthView("landing")} />;
    return <Landing onSignup={() => setAuthView("signup")} onAdminLogin={() => setAuthView("adminlogin")} onClientLogin={() => setAuthView("clientlogin")} />;
  }

  // 뷰어/판독 새 창 (client 포털 오리진에서 ?viewer=2d / ?report=1 그대로 동작)
  if (IS_VIEWER_WINDOW) return <ViewerWindow />;
  if (IS_REPORT_WINDOW) return <ReportWindow />;

  // Landing 포털: 세션이 있어도 콘솔/워크리스트를 열지 않고 포털 이동 안내 카드만
  if (PORTAL === "landing") {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
        <div style={{ background: "var(--bg-panel)", padding: 32, borderRadius: 8, border: "1px solid var(--border)",
                      width: 360, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>Saintview <span style={{ color: "var(--ai)" }}>PACS AI</span></div>
          <div style={{ fontSize: 12.5, color: "var(--text-secondary)", marginTop: -6 }}>
            {session.name} 님, 작업 화면은 각 포털에서 열립니다.
          </div>
          <button className="primary" onClick={() => gotoPortal("admin")}>관리자 포털로 이동</button>
          <button onClick={() => gotoPortal("client")}>Client 뷰어 포털로 이동</button>
          <button onClick={logout} style={{ background: "none", border: "none", color: "var(--text-secondary)", fontSize: 12, cursor: "pointer" }}>로그아웃</button>
        </div>
      </div>
    );
  }

  // 관리자 포털: admin 모드 세션만 콘솔 진입 — client 모드 세션은 무시(role 불일치 가드)
  if (PORTAL === "admin" && session.mode !== "admin") {
    return <AdminLogin onLogin={onAdminLogin} onBack={() => gotoPortal("landing")} />;
  }

  // Client 포털: AdminConsole 은 절대 렌더하지 않음 — admin 세션이라도 hospitalId 있으면 Worklist, 없으면 ClientLogin
  if (PORTAL === "client" && session.mode === "admin" && !session.hospitalId) {
    return <ClientLogin onLogin={onClientLogin} onBack={() => gotoPortal("landing")} />;
  }

  // 관리자 모드 → 관리자 콘솔(좌측 트리 메뉴) — client 포털에서는 제외
  if (session.mode === "admin" && PORTAL !== "client") {
    return (
      <AdminConsole
        userName={session.name}
        isSystemAdmin={session.role === "admin" && !session.hospitalId}
        onLogout={logout}
      />
    );
  }

  // Client 모드 → PACS Viewer (병원 스코프)
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 12px",
                       background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", height: 40 }}>
        <span style={{ fontWeight: 700 }}>Saintview <span style={{ color: "var(--ai)" }}>AI</span></span>
        {session.hospitalName && <span style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>🏥 {session.hospitalName}</span>}
        <div style={{ flex: 1 }} />
        <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>{session.name} [{session.role}]</span>
        <button onClick={() => setSettingsOpen(true)}>설정</button>
        <button onClick={logout}>로그아웃</button>
      </header>
      {settingsOpen && <SettingsModal role={session.role} scope="viewer" onClose={() => setSettingsOpen(false)} />}
      <main style={{ flex: 1, minHeight: 0 }}><Worklist /></main>
      <SessionGuard onLogout={logout} />
    </div>
  );
}
