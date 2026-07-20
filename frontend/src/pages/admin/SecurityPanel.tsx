// 보안 강화 패널(레인 S) — ①Defender(바이러스) ②랜섬 방지(무결성 감시·백업 보호) ③접근 보안(잠금·allowlist)
// 백엔드 /api/security/* (api/security.py). fetch 는 api.ts 공용 panelFetch 사용(통합 단계 승격 — 동작 무변경).
// 전부 방어적(탐지·설정·경고) 기능 — 자동 차단 없음.
import { useEffect, useState } from "react";
import { showToast } from "../../lib/toast";
import { panelFetch } from "../../api";

// ── 공용 헬퍼 위임 — 오류 문구는 기존 형식(상세만, 없으면 상태코드) 유지 ──
const req = <T,>(path: string, init?: RequestInit) =>
  panelFetch<T>(path, init, (s, _st, d) => d ?? `${s}`);

// ── 응답 타입 (백엔드 security_service 계약) ──
type Defender = {
  available: boolean; reason?: string;
  RealTimeProtectionEnabled?: boolean; AntivirusEnabled?: boolean; AMServiceEnabled?: boolean;
  AntivirusSignatureVersion?: string; AntivirusSignatureLastUpdated?: string;
  QuickScanEndTime?: string; FullScanEndTime?: string;
};
type IntegrityAlert = { at: string; message: string };
type PathSnap = { exists: boolean; files: number; bytes: number; suspicious: number };
type Snapshot = { taken_at: string; paths: Record<string, PathSnap> };
type Lockouts = { locked: { key: string; remaining_sec: number }[]; counting: Record<string, number> };
type Policy = {
  threshold: number; lock_min: number; admin_allowlist: string[];
  protect_backups: boolean; watch_paths: string[]; mass_change_pct: number;
};
type Summary = {
  defender: Defender;
  integrity: { status: string; last_scan: string; alerts: IntegrityAlert[]; latest: Snapshot | null };
  lockouts: Lockouts;
  login_failures: { hours: number; failed_total: number; lockout_events: number; top_targets: { username: string; count: number }[] };
  policy: Policy;
};

// ── 공통 소형 UI (관리 콘솔 다크 테마·표 스타일 유지) ──
const card: React.CSSProperties = { background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8, padding: 14 };
const inp: React.CSSProperties = {
  background: "var(--bg-canvas)", color: "var(--text-primary)",
  border: "1px solid var(--border)", borderRadius: 4, padding: "5px 8px", fontSize: 12.5, minWidth: 0,
};
function Msg({ text }: { text: string }) {
  if (!text) return null;
  return <div style={{ fontSize: 12, whiteSpace: "pre-wrap", color: text.startsWith("⚠") ? "var(--danger,#f87171)" : "var(--accent,#7dd3fc)" }}>{text}</div>;
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}>
      <span style={{ width: 150, color: "var(--text-secondary)", flexShrink: 0 }}>{label}</span>
      {children}
    </label>
  );
}
/** 상태등 ● — ok=녹색 / warn=황색 / bad=적색 / unknown=회색 */
function Dot({ state }: { state: "ok" | "warn" | "bad" | "unknown" }) {
  const color = state === "ok" ? "#4ade80" : state === "warn" ? "#fbbf24" : state === "bad" ? "#f87171" : "#6b7280";
  return <span style={{ color, fontSize: 14, marginRight: 4 }}>●</span>;
}
const fmtBytes = (b: number) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${b.toLocaleString()} B`);
const fmtTs = (s: string) => (s ? s.replace("T", " ").slice(0, 19) : "—");

export function SecurityPanel() {
  const [sum, setSum] = useState<Summary | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [allowText, setAllowText] = useState("");
  const [watchText, setWatchText] = useState("");
  const [msg, setMsg] = useState("");
  const [pMsg, setPMsg] = useState("");
  const [scanAlerts, setScanAlerts] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    req<Summary>("/api/security/summary")
      .then((s) => {
        setSum(s); setPolicy(s.policy);
        setAllowText(s.policy.admin_allowlist.join("\n"));
        setWatchText(s.policy.watch_paths.join("\n"));
        setMsg("");
      })
      .catch((e: Error) => setMsg("⚠ " + e.message));
  useEffect(() => { load(); }, []);

  const savePolicy = async () => {
    if (!policy) return;
    try {
      const value = {
        ...policy,
        admin_allowlist: allowText.split("\n").map((s) => s.trim()).filter(Boolean),
        watch_paths: watchText.split("\n").map((s) => s.trim()).filter(Boolean),
      };
      const r = await req<{ ok: boolean; value: Policy; warning: string }>(
        "/api/security/policy", { method: "PUT", body: JSON.stringify({ value }) });
      setPolicy(r.value);
      showToast("저장 되었습니다."); setPMsg(r.warning ? r.warning : "저장됨 (security.policy — 전역)");
      load();
    } catch (e) { setPMsg("⚠ " + (e as Error).message); }
  };

  const quickScan = async () => {
    setBusy(true);
    try {
      const r = await req<{ started: boolean; message?: string; reason?: string }>(
        "/api/security/defender/scan", { method: "POST" });
      setMsg(r.started ? r.message ?? "스캔 시작" : "⚠ " + (r.reason ?? "시작 실패"));
    } catch (e) { setMsg("⚠ " + (e as Error).message); }
    finally { setBusy(false); }
  };

  const integrityScan = async () => {
    setBusy(true);
    try {
      const r = await req<{ status: string; alerts: string[] }>(
        "/api/security/integrity/scan", { method: "POST" });
      setScanAlerts(r.alerts);
      setMsg(r.status === "ok" ? "무결성 검사 완료 — 이상 없음" : `⚠ 무결성 경고 ${r.alerts.length}건 (자동 차단 없음 — 확인 필요)`);
      load();
    } catch (e) { setMsg("⚠ " + (e as Error).message); }
    finally { setBusy(false); }
  };

  const unlock = async (key: string) => {
    try {
      await req("/api/security/lockouts/reset", { method: "POST", body: JSON.stringify({ key }) });
      load();
    } catch (e) { setMsg("⚠ " + (e as Error).message); }
  };

  if (!sum) return <div style={card}><Msg text={msg || "보안 현황 확인 중…"} /></div>;

  const d = sum.defender;
  const defState: "ok" | "warn" | "bad" | "unknown" =
    !d.available ? "unknown" : d.RealTimeProtectionEnabled ? "ok" : "bad";
  const integState: "ok" | "warn" | "unknown" =
    sum.integrity.status === "ok" ? "ok" : sum.integrity.status === "warn" ? "warn" : "unknown";
  const lockState: "ok" | "warn" = sum.lockouts.locked.length ? "warn" : "ok";
  const allowState: "ok" | "unknown" = sum.policy.admin_allowlist.length ? "ok" : "unknown";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* ── 보안 대시보드 (상태등) ── */}
      <div style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 700 }}>🛡️ 보안 대시보드 — 랜섬·바이러스·접근 (탐지·경고 전용)</div>
          <div style={{ flex: 1 }} />
          <button onClick={quickScan} disabled={busy}>빠른 스캔</button>
          <button onClick={integrityScan} disabled={busy}>무결성 검사</button>
          <button onClick={load}>새로고침</button>
        </div>
        {/* 표가 카드 폭을 넘으면 가로 스크롤 — 내용이 상자 밖으로 튀어나오지 않게 */}
        <div style={{ overflowX: "auto" }}>
        <table className="grid-table" style={{ fontSize: 12.5 }}>
          <thead><tr><th>항목</th><th>상태</th><th>상세</th></tr></thead>
          <tbody>
            <tr>
              <td>바이러스 (Defender)</td>
              <td><Dot state={defState} />{!d.available ? "미가용" : d.RealTimeProtectionEnabled ? "실시간 보호 ON" : "실시간 보호 OFF"}</td>
              <td style={{ color: "var(--text-secondary)" }}>
                {d.available
                  ? `서명 v${d.AntivirusSignatureVersion ?? "?"} (${fmtTs(d.AntivirusSignatureLastUpdated ?? "")}) · 빠른 스캔 ${fmtTs(d.QuickScanEndTime ?? "")}`
                  : `우아 강등 — ${d.reason ?? "PowerShell/Defender 없음"}`}
              </td>
            </tr>
            <tr>
              <td>무결성 감시 (랜섬 방지)</td>
              <td><Dot state={integState} />{sum.integrity.status === "ok" ? "정상" : sum.integrity.status === "warn" ? "경고" : "미검사"}</td>
              <td style={{ color: "var(--text-secondary)" }}>
                마지막 검사 {fmtTs(sum.integrity.last_scan)}
                {sum.integrity.latest && (
                  <> · {Object.entries(sum.integrity.latest.paths).map(([p, s]) =>
                    `${p.split(/[\\/]/).pop()}: ${s.exists ? `${s.files.toLocaleString()}파일/${fmtBytes(s.bytes)}` : "없음"}`).join(" · ")}</>
                )}
              </td>
            </tr>
            <tr>
              <td>로그인 잠금</td>
              <td><Dot state={lockState} />{sum.lockouts.locked.length ? `활성 잠금 ${sum.lockouts.locked.length}건` : "없음"}</td>
              <td style={{ color: "var(--text-secondary)" }}>
                24h 실패 {sum.login_failures.failed_total}건 · 잠금 발동 {sum.login_failures.lockout_events}건
                {sum.login_failures.top_targets.length > 0 &&
                  ` · 상위: ${sum.login_failures.top_targets.map((t) => `${t.username}(${t.count})`).join(", ")}`}
              </td>
            </tr>
            <tr>
              <td>관리자 IP allowlist</td>
              <td><Dot state={allowState} />{sum.policy.admin_allowlist.length ? `${sum.policy.admin_allowlist.length}개 항목` : "제한 없음"}</td>
              <td style={{ color: "var(--text-secondary)" }}>{sum.policy.admin_allowlist.join(", ") || "빈 목록 = 모든 IP 허용"}</td>
            </tr>
          </tbody>
        </table>
        </div>
        <Msg text={msg} />
        {scanAlerts && scanAlerts.length > 0 && (
          <div style={{ fontSize: 12, color: "var(--danger,#f87171)", whiteSpace: "pre-wrap" }}>
            {scanAlerts.map((a, i) => <div key={i}>⚠ {a}</div>)}
          </div>
        )}
      </div>

      {/* ── 활성 잠금 목록 ── */}
      {sum.lockouts.locked.length > 0 && (
        <div style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontWeight: 700 }}>🔒 활성 로그인 잠금</div>
          <div style={{ overflowX: "auto" }}>
          <table className="grid-table" style={{ fontSize: 12.5 }}>
            <thead><tr><th>대상 (계정/IP)</th><th>잔여 시간</th><th /></tr></thead>
            <tbody>
              {sum.lockouts.locked.map((l) => (
                <tr key={l.key}>
                  <td>{l.key}</td>
                  <td>{Math.ceil(l.remaining_sec / 60)}분</td>
                  <td><button onClick={() => unlock(l.key)}>해제</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* ── 무결성 경고 이력 ── */}
      {sum.integrity.alerts.length > 0 && (
        <div style={{ ...card, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontWeight: 700 }}>⚠ 무결성 경고 이력 (최근)</div>
          {sum.integrity.alerts.slice().reverse().map((a, i) => (
            <div key={i} style={{ fontSize: 12 }}>
              <span style={{ color: "var(--text-secondary)" }}>{fmtTs(a.at)}</span>{" — "}
              <span style={{ color: "var(--danger,#f87171)" }}>{a.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── 정책 설정 ── */}
      {policy && (
        <div style={{ ...card, display: "flex", flexDirection: "column", gap: 8, maxWidth: 640 }}>
          <div style={{ fontWeight: 700 }}>⚙️ 보안 정책 (security.policy — 전역)</div>
          <Row label="로그인 실패 임계(회)">
            <input style={{ ...inp, width: 90 }} type="number" min={1} max={100} value={policy.threshold}
              onChange={(e) => setPolicy({ ...policy, threshold: Number(e.target.value) || 5 })} />
            <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>계정·IP 별 연속 실패 시 잠금 (기본 5)</span>
          </Row>
          <Row label="잠금 시간(분)">
            <input style={{ ...inp, width: 90 }} type="number" min={1} max={1440} value={policy.lock_min}
              onChange={(e) => setPolicy({ ...policy, lock_min: Number(e.target.value) || 15 })} />
            <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>기본 15분 · 성공 로그인 시 카운터 리셋</span>
          </Row>
          <Row label="급격한 변화율 임계(%)">
            <input style={{ ...inp, width: 90 }} type="number" min={5} max={95} value={policy.mass_change_pct}
              onChange={(e) => setPolicy({ ...policy, mass_change_pct: Number(e.target.value) || 30 })} />
            <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>파일 수가 이 비율 이상 변하면 경고</span>
          </Row>
          <Row label="백업 보호">
            <input type="checkbox" checked={policy.protect_backups}
              onChange={(e) => setPolicy({ ...policy, protect_backups: e.target.checked })} />
            <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>백업 산출물 읽기 전용 + SHA-256 매니페스트 기록·변조 감지</span>
          </Row>
          <Row label="관리자 IP allowlist">
            <textarea style={{ ...inp, flex: 1, minHeight: 54, fontFamily: "inherit" }} value={allowText}
              onChange={(e) => setAllowText(e.target.value)}
              placeholder={"한 줄에 하나 — IP 또는 CIDR (예: 192.168.0.10 / 10.0.0.0/8)\n빈 목록 = 제한 없음"} />
          </Row>
          <Row label="추가 감시 경로">
            <textarea style={{ ...inp, flex: 1, minHeight: 44, fontFamily: "inherit" }} value={watchText}
              onChange={(e) => setWatchText(e.target.value)}
              placeholder={"한 줄에 하나 — 스토리지·백업 폴더는 기본 포함"} />
          </Row>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="primary" onClick={savePolicy}>정책 저장</button>
            <button onClick={load}>다시 불러오기</button>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
            allowlist에 현재 접속 IP가 없으면 저장은 되지만 경고가 표시됩니다(자기 잠금 주의).
            모든 기능은 탐지·설정·경고 전용이며 자동 차단을 수행하지 않습니다.
          </div>
          <Msg text={pMsg} />
        </div>
      )}
    </div>
  );
}
