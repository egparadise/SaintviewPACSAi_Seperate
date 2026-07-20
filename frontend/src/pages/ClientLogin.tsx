// Saintview PACS AI Client 뷰어 로그인 — 병원 ID + 개별 ID + Password (3필드)
import { useState } from "react";
import { api, setToken, type LoginResp } from "../api";

const inp: React.CSSProperties = {
  width: "100%", background: "var(--bg-canvas)", color: "var(--text-primary)",
  border: "1px solid var(--border)", borderRadius: 4, padding: "8px 10px", fontSize: 13.5, boxSizing: "border-box",
};

export function ClientLogin({ onLogin, onBack }: {
  onLogin: (r: LoginResp) => void; onBack?: () => void;
}) {
  // 자동 로그인 체크 시 병원ID·개별ID·PW 를 모두 기억(localStorage)하고 다음 로드에 프리필.
  const remembered = localStorage.getItem("sv_remember") === "1";
  const [hospitalId, setHospitalId] = useState(remembered ? (localStorage.getItem("sv_client_hosp") ?? "SAMPLE01") : "SAMPLE01");
  const [username, setUsername] = useState(remembered ? (localStorage.getItem("sv_client_user") ?? "admin") : "admin");
  const [password, setPassword] = useState(remembered ? (localStorage.getItem("sv_client_pw") ?? "") : "");
  const [remember, setRemember] = useState(remembered);
  const [error, setError] = useState("");
  const [dup, setDup] = useState(false);   // 중복 로그인 인계 프롬프트(Yes/No)
  const [mustChange, setMustChange] = useState<LoginResp | null>(null);  // 발급 계정 최초 로그인 강제변경
  const [np1, setNp1] = useState("");      // 새 비번
  const [np2, setNp2] = useState("");      // 새 비번 확인(2회)
  const [cerr, setCerr] = useState("");

  const persistRemember = (pw: string) => {
    localStorage.setItem("sv_remember", remember ? "1" : "0");
    if (remember) {
      localStorage.setItem("sv_client_hosp", hospitalId.trim());
      localStorage.setItem("sv_client_user", username.trim());
      localStorage.setItem("sv_client_pw", pw);
    } else {
      ["sv_client_hosp", "sv_client_user", "sv_client_pw"].forEach((k) => localStorage.removeItem(k));
    }
  };
  const finish = (r: LoginResp) => {
    // 발급 계정 최초 로그인 → 토큰만 세팅하고 비번 1회 강제 변경(2회 확인) 후 진입
    if (r.must_change) { setToken(r.token, remember); setMustChange(r); setNp1(""); setNp2(""); setCerr(""); return; }
    setToken(r.token, remember); persistRemember(password); onLogin(r);
  };
  // 최초 로그인 강제 변경 실행 — 현재 비번(로그인한 값) + 새 비번(2회 일치, 8자↑)
  const doChange = async () => {
    setCerr("");
    if (np1.length < 8) return setCerr("새 비밀번호는 8자 이상이어야 합니다");
    if (np1 !== np2) return setCerr("새 비밀번호 확인이 일치하지 않습니다");
    try {
      await api.changePassword(password, np1);
      persistRemember(np1);   // 기억 중이면 바뀐 비번으로 갱신
      const r = mustChange!; setMustChange(null); onLogin(r);
    } catch (err) { setCerr(err instanceof Error ? err.message : "변경 실패"); }
  };
  const cancelChange = () => { setToken(null); setMustChange(null); setError("비밀번호 변경을 완료해야 로그인됩니다"); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(""); setDup(false);
    try {
      const r = await api.clientLogin(hospitalId.trim(), username.trim(), password);
      if (r.duplicate) { setDup(true); return; }   // 이미 사용 중 → Yes/No 프롬프트
      finish(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "로그인 실패");
    }
  };

  // Yes — 기존 세션에 종료 카운트다운을 걸고 여기서 로그인(인계)
  const takeover = async () => {
    setDup(false); setError("");
    try {
      finish(await api.clientLoginForce(hospitalId.trim(), username.trim(), password));
    } catch (err) {
      setError(err instanceof Error ? err.message : "로그인 실패");
    }
  };

  return (
    <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
      <form onSubmit={submit} style={{ background: "var(--bg-panel)", padding: 32, borderRadius: 10,
                                       border: "1px solid var(--border)", width: 340, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 18, fontWeight: 800 }}>
          Saintview <span style={{ color: "var(--ai,#a78bfa)" }}>PACS AI</span>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-secondary)", marginTop: -6 }}>Client 뷰어 로그인</div>
        <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>병원 ID
          <input style={inp} placeholder="병원 코드 또는 이름(예: HOSP002, 광주씨티병원)" value={hospitalId} onChange={(e) => setHospitalId(e.target.value)} autoFocus />
        </label>
        <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>개별 ID
          <input style={inp} placeholder="아이디" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>Password
          <input style={inp} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--text-secondary)" }}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          자동 로그인 (이 PC에 유지)
        </label>
        {error && <div style={{ color: "var(--stat-emergency,#f87171)", fontSize: 12 }}>{error}</div>}
        <button className="primary" type="submit">PACS Viewer 로그인</button>
        {onBack && (
          <button type="button" onClick={onBack}
                  style={{ background: "none", border: "none", color: "var(--text-secondary)", fontSize: 12, cursor: "pointer" }}>
            ← 홈으로
          </button>
        )}
      </form>
      {dup && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "grid", placeItems: "center", zIndex: 1000 }}>
          <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10,
                        padding: 24, width: 400, maxWidth: "90vw", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>이미 사용 중인 ID</div>
            <div style={{ fontSize: 13, lineHeight: 1.7, color: "var(--text-secondary)" }}>
              현재 접속하는 ID는 이미 사용중입니다.<br />
              로그인 된 곳을 종료하고 여기에서 로그인 하시겠습니까?
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setDup(false)} style={{ padding: "6px 18px" }}>No</button>
              <button type="button" className="primary" onClick={takeover} style={{ padding: "6px 18px" }}>Yes</button>
            </div>
          </div>
        </div>
      )}
      {mustChange && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "grid", placeItems: "center", zIndex: 1100 }}>
          <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10,
                        padding: 26, width: 380, maxWidth: "90vw", display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>비밀번호 변경 (최초 로그인)</div>
            <div style={{ fontSize: 12.5, lineHeight: 1.6, color: "var(--text-secondary)" }}>
              발급받은 초기 비밀번호는 최초 1회 반드시 변경해야 합니다. 새 비밀번호를 두 번 입력하세요(8자 이상).
            </div>
            <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>새 비밀번호
              <input style={inp} type="password" value={np1} autoFocus onChange={(e) => setNp1(e.target.value)} />
            </label>
            <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>새 비밀번호 확인
              <input style={inp} type="password" value={np2} onChange={(e) => setNp2(e.target.value)}
                     onKeyDown={(e) => { if (e.key === "Enter") void doChange(); }} />
            </label>
            {cerr && <div style={{ color: "var(--stat-emergency,#f87171)", fontSize: 12 }}>{cerr}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" onClick={cancelChange} style={{ padding: "6px 16px" }}>취소</button>
              <button type="button" className="primary" onClick={doChange} style={{ padding: "6px 16px" }}>변경 후 로그인</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
