// 서버 유지보수 패널(레인 F) — ①서버 설정(임베드) ②저장 공간 ③백업·미러링 ④복원 ⑤데이터 관리(wipe)
// 백엔드 계약(/api/maintenance/*)은 레인 B가 병렬 구현 — 미구현 응답은 '⚠ 준비 중' 우아 처리.
import { useEffect, useState } from "react";
import { showToast } from "../../lib/toast";
import {
  api, type HospitalRow, type MaintBackupItem, type MaintBackupPolicy, type MaintRepeat,
  type MaintRestoreResult, type MaintStorage, type PortalStatus, type ServerNetwork,
} from "../../api";

// ── 공통 소형 UI (기존 관리 콘솔 다크 테마·표 스타일 유지) ──
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
      <span style={{ width: 130, color: "var(--text-secondary)", flexShrink: 0 }}>{label}</span>
      {children}
    </label>
  );
}
/** 백엔드(레인 B) 미구현/오류를 사용자 안내로 변환 */
export function pendMsg(e: unknown): string {
  const m = (e as Error).message ?? String(e);
  if (m.includes("404") || m.includes("Not Found")) return "⚠ 준비 중 — 백엔드 API 구현 대기 (레인 B)";
  return "⚠ " + m;
}
const fmtMb = (mb?: number) => (mb == null ? "—" : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toLocaleString()} MB`);

// ════════════════════════════ ① 서버 설정 (기존 서버 네트워크 임베드 — 중복 구현 금지) ════════════════════════════
export function ServerConfigPanel() {
  const [web, setWeb] = useState<{ ip: string; port: string; name: string; ae_title: string } | null>(null);
  const [msg, setMsg] = useState("");
  const [portal, setPortal] = useState<PortalStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.getSetting("server.network")
    .then((r) => {
      const w = (r.value as ServerNetwork).web ?? {};
      setWeb({ ip: String(w.ip ?? ""), port: String(w.port ?? ""), name: String(w.name ?? ""), ae_title: String(w.ae_title ?? "") });
    })
    .catch(() => setWeb({ ip: "", port: "", name: "", ae_title: "" }));
  const loadStatus = () => api.portalStatus().then(setPortal).catch(() => setPortal(null));

  useEffect(() => {
    load();
    loadStatus();
    const t = setInterval(loadStatus, 30000);  // 30초 폴링
    return () => clearInterval(t);              // unmount 정리
  }, []);

  // 기존 설정(local_share_dir·landing_url·autostart 등) 보존 병합 — SettingsModal>서버 네트워크와 같은 키
  const persistNetwork = async () => {
    if (!web) return;
    const cur = (await api.getSetting("server.network").catch(() => ({ value: {} }))).value as Record<string, unknown>;
    const curWeb = (cur.web ?? {}) as Record<string, unknown>;
    await api.putSetting("server.network", { ...cur, web: { ...curWeb, ...web } }, "global");
  };

  const save = async () => {
    if (!web) return;
    try { await persistNetwork(); showToast("저장 되었습니다."); setMsg("저장됨 (전역 server.network — 뷰어 설정>서버 네트워크와 동일 키)"); }
    catch (e) { setMsg(pendMsg(e)); }
  };
  const saveApply = async () => {
    if (!web) return;
    setBusy(true);
    try {
      await persistNetwork();
      showToast("저장 되었습니다.");
      const r = await api.portalApply(web.ip, Number(web.port) || 0);
      setPortal(r);
      setMsg(r.running
        ? `수신 중 — ${r.host}:${r.port} 로 접속하면 로그인 포털로 연결됩니다${r.warning ? ` (${r.warning})` : ""}`
        : `⚠ ${r.error || "리스너 기동 실패"}`);
    } catch (e) { setMsg(pendMsg(e)); loadStatus(); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    setBusy(true);
    try { const r = await api.portalStop(); setPortal(r); setMsg("리스너 중지됨"); }
    catch (e) { setMsg(pendMsg(e)); }
    finally { setBusy(false); }
  };
  const openPortal = () => {
    if (!web) return;
    const host = (!web.ip.trim() || web.ip.trim() === "0.0.0.0") ? "127.0.0.1" : web.ip.trim();
    window.open(`http://${host}:${web.port || "8000"}`, "_blank");
  };

  // 상태등 — 초록=수신중 · 빨강=바인드 실패 · 회색=중지/미확인
  const dot = !portal
    ? { c: "var(--text-secondary)", t: "상태 확인 중…" }
    : portal.running
      ? { c: "#22c55e", t: `수신 중 — ${portal.host}:${portal.port}` }
      : portal.error
        ? { c: "var(--danger,#f87171)", t: `바인드 실패 — ${portal.error}` }
        : { c: "var(--text-secondary)", t: "중지됨" };

  if (!web) return <div style={card}>불러오는 중…</div>;
  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 8, maxWidth: 560 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700 }}>🖥️ 서버 설정 — IP / Port / AE Title / Name</div>
        <div style={{ flex: 1 }} />
        <span title={dot.t} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--text-secondary)" }}>
          <span style={{ width: 9, height: 9, borderRadius: "50%", background: dot.c, flexShrink: 0 }} />
          {dot.t}
        </span>
        <button onClick={loadStatus}>새로고침</button>
      </div>
      <Row label="서버 IP"><input style={{ ...inp, flex: 1 }} value={web.ip} onChange={(e) => setWeb({ ...web, ip: e.target.value })} placeholder="예: 192.168.0.10 (빈값=0.0.0.0)" /></Row>
      <Row label="서버 Port"><input style={{ ...inp, width: 110 }} value={web.port} onChange={(e) => setWeb({ ...web, port: e.target.value })} placeholder="예: 9000" /></Row>
      <Row label="AE Title"><input style={{ ...inp, flex: 1 }} value={web.ae_title} onChange={(e) => setWeb({ ...web, ae_title: e.target.value })} /></Row>
      <Row label="서버 Name"><input style={{ ...inp, flex: 1 }} value={web.name} onChange={(e) => setWeb({ ...web, name: e.target.value })} /></Row>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="primary" disabled={busy} onClick={saveApply}>저장·적용</button>
        <button disabled={busy} onClick={save}>저장</button>
        <button disabled={busy || !portal?.running} onClick={stop}>중지</button>
        <button onClick={openPortal} title="지정 주소를 새 탭으로 엽니다">열기 ↗</button>
        <button disabled={busy} onClick={load}>다시 불러오기</button>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
        이 IP:Port 로 접속하면 로그인 포털로 연결됩니다(리다이렉트). [저장·적용]을 눌러야 그 주소에 리스너가 떠 실제 응답합니다
        — 저장만 하면 리스너가 없어 연결이 거부됩니다. DICOM 통신 포트/뷰어 포털과는 별개입니다.
        AE Title·Name 은 서버 식별 메타로 유지되며, 공유 루트·Ping/DICOM Echo/DB 연결 테스트는 뷰어의 [설정 &gt; 서버 네트워크]에서 계속 제공합니다.
      </div>
      <Msg text={msg} />
    </div>
  );
}

// ════════════════════════════ ② 저장 공간 (DB · Image Storage · Backup) ════════════════════════════
export function MaintStoragePanel() {
  const [st, setSt] = useState<MaintStorage | null>(null);
  const [policy, setPolicy] = useState<MaintBackupPolicy | null>(null);
  const [msg, setMsg] = useState("");
  const [pMsg, setPMsg] = useState("");
  const load = () => {
    api.maintStorage().then((r) => { setSt(r); setMsg(""); }).catch((e) => setMsg(pendMsg(e)));
    api.maintBackupPolicy().then(setPolicy).catch((e) => setPMsg(pendMsg(e)));
  };
  useEffect(() => { load(); }, []);

  const savePolicy = async () => {
    if (!policy) return;
    try { const p = await api.putMaintBackupPolicy(policy); setPolicy(p); showToast("저장 되었습니다."); setPMsg("저장됨"); load(); }
    catch (e) { setPMsg(pendMsg(e)); }
  };

  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ fontWeight: 700 }}>💾 저장 공간 — DB · Image Storage · Backup</div>
        <div style={{ flex: 1 }} />
        <button onClick={load}>새로고침</button>
      </div>
      {!st ? <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{msg || "확인 중…"}</div> : (
        /* 표가 카드 폭을 넘으면 가로 스크롤 — 내용이 상자 밖으로 튀어나오지 않게 */
        <div style={{ overflowX: "auto" }}>
        <table className="grid-table" style={{ fontSize: 12.5 }}>
          <thead><tr><th>구분</th><th>사용량</th><th>상세</th></tr></thead>
          <tbody>
            <tr>
              <td>DB 저장 공간</td>
              <td>{fmtMb(st.db.size_mb)}</td>
              <td style={{ color: "var(--text-secondary)" }}>{st.db.detail || "—"}</td>
            </tr>
            <tr>
              <td>Image Storage</td>
              <td>{fmtMb(st.image.size_mb)}</td>
              <td style={{ color: "var(--text-secondary)" }}>
                인스턴스 {st.image.instances.toLocaleString()}개 · 디스크 여유 {st.image.disk_free_gb.toFixed(1)} / 전체 {st.image.disk_total_gb.toFixed(1)} GB
              </td>
            </tr>
            <tr>
              <td>Backup 공간</td>
              <td>{fmtMb(st.backup.size_mb)}</td>
              <td style={{ color: "var(--text-secondary)" }}>
                경로 <code>{st.backup.path || "—"}</code> · 상한 {st.backup.quota_gb ? `${st.backup.quota_gb} GB` : "무제한"}
              </td>
            </tr>
          </tbody>
        </table>
        </div>
      )}
      <Msg text={msg} />

      {/* 백업 경로·용량 상한 편집 — 백업 정책의 path/quota_gb */}
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 12.5 }}>백업 공간 설정</div>
        {policy ? (
          <>
            <Row label="백업 경로"><input style={{ ...inp, flex: 1 }} value={policy.path} onChange={(e) => setPolicy({ ...policy, path: e.target.value })} placeholder="예: D:\\pacs-backup" /></Row>
            <Row label="용량 상한(GB)">
              <input style={{ ...inp, width: 100 }} type="number" min={0} value={policy.quota_gb ?? 0} onChange={(e) => setPolicy({ ...policy, quota_gb: Number(e.target.value) })} />
              <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>0=무제한 — 초과 시 백업이 경고와 함께 중단됩니다</span>
            </Row>
            <div><button className="primary" onClick={savePolicy}>저장</button></div>
          </>
        ) : <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{pMsg || "정책 확인 중…"}</div>}
        <Msg text={pMsg} />
      </div>
      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
        스케줄·반복·미러링·DB백업 등 나머지 백업 설정은 [백업·미러링] 탭에서 관리합니다.
      </div>
    </div>
  );
}

// ════════════════════════════ ③ 백업 · 미러링 (정책 확장 + 즉시 실행) ════════════════════════════
const REPEAT_OPTS: { key: MaintRepeat; label: string }[] = [
  { key: "daily", label: "매일 (daily)" },
  { key: "weekly", label: "매주 (weekly)" },
  { key: "monthly", label: "매월 (monthly)" },
  { key: "quarterly", label: "분기 (quarterly)" },
  { key: "yearly", label: "매년 (yearly)" },
];
const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"];

export function BackupMirrorPanel() {
  const [policy, setPolicy] = useState<MaintBackupPolicy | null>(null);
  const [comps, setComps] = useState<{ key: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const load = () => api.maintBackupPolicy().then((p) => { setPolicy(p); setMsg(""); }).catch((e) => setMsg(pendMsg(e)));
  useEffect(() => {
    load();
    api.backupCompressions().then((r) => setComps(r.items)).catch(() => {});
  }, []);

  const save = async () => {
    if (!policy) return;
    try { const p = await api.putMaintBackupPolicy(policy); setPolicy(p); showToast("저장 되었습니다."); setMsg("백업 정책 저장됨"); }
    catch (e) { setMsg(pendMsg(e)); }
  };
  const run = async (kind: "dicom" | "db" | "both") => {
    setBusy(true);
    try {
      const r = await api.maintBackupRun(kind);
      const jobs = (r.items ?? []).map((i) => `#${i.id} ${i.kind}(${i.status})`).join(", ");
      setMsg(r.ok ? `백업 시작됨 (${kind})${jobs ? ` — ${jobs}` : ""}${r.detail ? ` — ${r.detail}` : ""}` : `⚠ ${r.detail ?? "백업 실패"}`);
    }
    catch (e) { setMsg(pendMsg(e)); }
    finally { setBusy(false); }
  };
  const mirror = async () => {
    if (!confirm("시스템 미러링을 지금 실행할까요?\n(미러 경로로 데이터를 동기화합니다)")) return;
    setBusy(true);
    try {
      const r = await api.maintMirrorRun();
      const stat = r.copied != null ? ` — 복사 ${r.copied}건 · 건너뜀 ${r.skipped ?? 0}건${(r.errors?.length ?? 0) > 0 ? ` · 오류 ${r.errors!.length}건` : ""}` : "";
      setMsg(r.ok ? `미러링 완료${stat}${r.detail ? ` — ${r.detail}` : ""}` : `⚠ ${r.detail ?? "미러링 실패"}`);
    }
    catch (e) { setMsg(pendMsg(e)); }
    finally { setBusy(false); }
  };

  if (!policy) return <div style={card}><div style={{ fontWeight: 700, marginBottom: 8 }}>🗓️ 백업 · 미러링</div><div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{msg || "확인 중…"}</div><Msg text={msg} /></div>;
  const rep = policy.repeat;
  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 8, maxWidth: 640 }}>
      <div style={{ fontWeight: 700 }}>🗓️ 백업 · 미러링 (스케줄·반복·용량·DB)</div>

      <Row label="자동 백업">
        <input type="checkbox" checked={policy.enabled} onChange={(e) => setPolicy({ ...policy, enabled: e.target.checked })} />
        <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>예정 시각·반복 주기에 따라 스케줄 백업</span>
      </Row>
      <Row label="시각 (시:분:초)">
        <input style={{ ...inp, width: 120 }} type="time" step={1}
               value={policy.at || "02:00:00"}
               onChange={(e) => setPolicy({ ...policy, at: e.target.value.length === 5 ? e.target.value + ":00" : e.target.value })} />
      </Row>
      <Row label="반복">
        <select style={{ ...inp, width: 160 }} value={rep} onChange={(e) => setPolicy({ ...policy, repeat: e.target.value as MaintRepeat })}>
          {REPEAT_OPTS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        {rep === "weekly" && (
          <select style={{ ...inp, width: 90 }} value={policy.weekday ?? 0} onChange={(e) => setPolicy({ ...policy, weekday: Number(e.target.value) })}>
            {WEEKDAYS.map((w, i) => <option key={i} value={i}>{w}요일</option>)}
          </select>
        )}
        {(rep === "monthly" || rep === "quarterly" || rep === "yearly") && (
          <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            <input style={{ ...inp, width: 60 }} type="number" min={1} max={31} value={policy.day ?? 1} onChange={(e) => setPolicy({ ...policy, day: Number(e.target.value) })} />
            <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>일</span>
          </span>
        )}
      </Row>
      <Row label="보존 기간(일)">
        <input style={{ ...inp, width: 90 }} type="number" min={0} value={policy.retention_days} onChange={(e) => setPolicy({ ...policy, retention_days: Number(e.target.value) })} />
        <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>0=무제한</span>
      </Row>
      <Row label="압축 포맷">
        {comps.length > 0 ? (
          <select style={{ ...inp, flex: 1 }} value={policy.format} onChange={(e) => setPolicy({ ...policy, format: e.target.value })}>
            {comps.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            {!comps.some((c) => c.key === policy.format) && policy.format && <option value={policy.format}>{policy.format}</option>}
          </select>
        ) : (
          <input style={{ ...inp, flex: 1 }} value={policy.format} onChange={(e) => setPolicy({ ...policy, format: e.target.value })} placeholder="예: jpeg2000-lossless" />
        )}
      </Row>
      <Row label="백업 경로"><input style={{ ...inp, flex: 1 }} value={policy.path} onChange={(e) => setPolicy({ ...policy, path: e.target.value })} placeholder="예: D:\\pacs-backup" /></Row>
      <Row label="용량 상한(GB)">
        <input style={{ ...inp, width: 90 }} type="number" min={0} value={policy.quota_gb ?? 0} onChange={(e) => setPolicy({ ...policy, quota_gb: Number(e.target.value) })} />
        <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>0=무제한</span>
      </Row>
      <Row label="미러 경로"><input style={{ ...inp, flex: 1 }} value={policy.mirror_path ?? ""} onChange={(e) => setPolicy({ ...policy, mirror_path: e.target.value })} placeholder="시스템 미러링 대상 (예: \\\\nas\\pacs-mirror)" /></Row>
      <Row label="DB 백업 포함">
        <input type="checkbox" checked={policy.db_backup} onChange={(e) => setPolicy({ ...policy, db_backup: e.target.checked })} />
        <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>스케줄 백업 시 DB 덤프도 함께 생성</span>
      </Row>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", borderTop: "1px solid var(--border)", paddingTop: 10 }}>
        <button className="primary" onClick={save}>정책 저장</button>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>지금 백업:</span>
        <button disabled={busy} onClick={() => run("dicom")}>DICOM</button>
        <button disabled={busy} onClick={() => run("db")}>DB</button>
        <button disabled={busy} onClick={() => run("both")}>둘 다</button>
        <button disabled={busy || !(policy.mirror_path ?? "").trim()} onClick={mirror}
                title={(policy.mirror_path ?? "").trim() ? "미러 경로로 즉시 동기화" : "먼저 미러 경로를 설정·저장하세요"}>미러 실행</button>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
        DICOM 압축은 기존 포맷 정책을 유지합니다(코덱 미지원 시 원본 폴백). 백업 이력·복원은 [복원] 탭에서 확인합니다.
      </div>
      <Msg text={msg} />
    </div>
  );
}

// ════════════════════════════ ④ 복원 (백업 이력 → 미리보기(dry) → 2단계 복원) ════════════════════════════
export function RestorePanel({ hospitals, fixedHid }: { hospitals: HospitalRow[]; fixedHid?: number }) {
  const [items, setItems] = useState<MaintBackupItem[]>([]);
  const [selId, setSelId] = useState<number | string | null>(null);
  const [scope, setScope] = useState<"system" | "hospital">(fixedHid ? "hospital" : "system");
  const [hid, setHid] = useState<string>(fixedHid ? String(fixedHid) : "");
  const [dry, setDry] = useState<MaintRestoreResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const load = () => api.maintBackups().then((r) => { setItems(r.items); setMsg(""); }).catch((e) => setMsg(pendMsg(e)));
  useEffect(() => { load(); }, []);

  const sel = items.find((b) => b.id === selId) ?? null;
  const effHid = fixedHid ?? (hid ? Number(hid) : undefined);
  const scopeOk = scope === "system" || !!effHid;

  const preview = async () => {
    if (!sel || !scopeOk) return;
    setBusy(true); setDry(null);
    try {
      const r = await api.maintRestore({ backup_id: sel.id, scope, hid: scope === "hospital" ? effHid : undefined, dry: true });
      setDry(r);
      setMsg("");
    } catch (e) { setMsg(pendMsg(e)); }
    finally { setBusy(false); }
  };
  const restore = async () => {
    if (!sel || !scopeOk) return;
    const scopeDesc = scope === "system" ? "시스템 전체"
      : `병원 '${hospitals.find((h) => h.id === effHid)?.name ?? effHid}'`;
    if (!confirm(`[1/2] 복원 — 백업 #${sel.id} (${sel.ts}) → ${scopeDesc}\n\n현재 데이터가 백업 시점으로 되돌아갑니다. 계속할까요?`)) return;
    if (!confirm(`[2/2] 최종 확인 — 복원은 되돌릴 수 없습니다.\n먼저 [미리보기]로 복원 요약을 확인했는지 점검하세요.\n\n정말 복원할까요?`)) return;
    setBusy(true);
    try {
      const r = await api.maintRestore({ backup_id: sel.id, scope, hid: scope === "hospital" ? effHid : undefined });
      if (r.ok && r.executed === false && r.guidance) {
        // DB 복원 — 서버는 자동 실행하지 않고 덤프 파일 준비 + 수동 절차 안내(우아 강등)를 그대로 노출
        setMsg(`${r.summary ?? "DB 복원 파일 준비됨"}\n${r.guidance}`);
      } else {
        setMsg(r.ok ? `복원 완료${r.summary ? ` — ${r.summary}` : ""}${r.detail ? ` (${r.detail})` : ""}` : `⚠ ${r.detail ?? "복원 실패"}`);
      }
      setDry(null);
    } catch (e) { setMsg(pendMsg(e)); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ fontWeight: 700 }}>⏪ 시스템 복원 (백업 시점)</div>
        <div style={{ flex: 1 }} />
        <button onClick={load}>새로고침</button>
      </div>

      <div style={{ maxHeight: 260, overflow: "auto", border: "1px solid var(--border)", borderRadius: 4 }}>
        <table className="grid-table" style={{ fontSize: 12 }}>
          <thead><tr><th></th><th>#</th><th>종류</th><th>시각</th><th>크기</th><th>경로</th><th>상태</th></tr></thead>
          <tbody>
            {items.map((b) => (
              <tr key={String(b.id)} onClick={() => { setSelId(b.id); setDry(null); }}
                  style={{ cursor: "pointer", background: selId === b.id ? "var(--accent-subtle)" : undefined }}>
                <td><input type="radio" name="sv-backup-sel" checked={selId === b.id} onChange={() => { setSelId(b.id); setDry(null); }} /></td>
                <td>{b.id}</td><td>{b.kind}</td><td>{b.ts?.replace("T", " ").slice(0, 19)}</td>
                <td>{fmtMb(b.size_mb)}</td><td><code style={{ fontSize: 11 }}>{b.path}</code></td><td>{b.status}</td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={7} style={{ color: "var(--text-secondary)" }}>백업 이력이 없습니다 — [백업·미러링]에서 먼저 백업하세요.</td></tr>}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>범위:</span>
        {fixedHid ? (
          <span style={{ fontSize: 12.5 }}>이 병원 ({hospitals.find((h) => h.id === fixedHid)?.name ?? fixedHid})</span>
        ) : (
          <>
            <select style={inp} value={scope} onChange={(e) => { setScope(e.target.value as "system" | "hospital"); setDry(null); }}>
              <option value="system">시스템 전체</option>
              <option value="hospital">특정 병원만</option>
            </select>
            {scope === "hospital" && (
              <select style={inp} value={hid} onChange={(e) => { setHid(e.target.value); setDry(null); }}>
                <option value="">— 병원 선택 —</option>
                {hospitals.map((h) => <option key={h.id} value={h.id}>{h.name || h.code}</option>)}
              </select>
            )}
          </>
        )}
        <div style={{ flex: 1 }} />
        <button disabled={!sel || !scopeOk || busy} onClick={preview}>미리보기 (dry)</button>
        <button disabled={!sel || !scopeOk || busy || !dry} onClick={restore} style={{ color: "var(--danger,#f87171)" }}
                title={dry ? "미리보기 확인 후 복원" : "먼저 [미리보기]로 복원 요약을 확인하세요"}>복원…</button>
      </div>

      {dry && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 4, padding: "8px 10px", fontSize: 12.5 }}>
          <b>복원 미리보기</b> — 백업 #{sel?.id}
          <div style={{ marginTop: 4, whiteSpace: "pre-wrap", color: "var(--text-secondary)" }}>
            {dry.summary || dry.detail || "요약 없음"}
            {dry.guidance ? `\n${dry.guidance}` : ""}
          </div>
        </div>
      )}
      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
        복원은 [미리보기(dry)] → 요약 확인 → [복원](2단계 확인) 순서로만 실행됩니다. 모든 복원은 서버 감사 로그에 기록됩니다.
      </div>
      <Msg text={msg} />
    </div>
  );
}

// ════════════════════════════ ⑤ 데이터 관리 (지우고 복원 — 'WIPE' 확인) ════════════════════════════
export function DataWipePanel({ hospitals, fixedHid }: { hospitals: HospitalRow[]; fixedHid?: number }) {
  const [hid, setHid] = useState<string>(fixedHid ? String(fixedHid) : "");
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const scope: "hospital" | "system" = fixedHid || hid ? "hospital" : "system";
  const effHid = fixedHid ?? (hid ? Number(hid) : undefined);
  const targetDesc = scope === "system" ? "시스템 전체(모든 병원)"
    : `병원 '${hospitals.find((h) => h.id === effHid)?.name ?? effHid}'`;

  const wipe = async () => {
    if (confirmText !== "WIPE") { setMsg("⚠ 확인 문자열 'WIPE'를 정확히 입력하세요"); return; }
    if (!confirm(`[1/2] 데이터 지우기 — ${targetDesc}\n\n검사·판독·영상 데이터가 삭제됩니다. 계속할까요?`)) return;
    if (!confirm(`[2/2] 최종 확인 — 이 작업은 되돌릴 수 없습니다.\n복구하려면 [복원]에서 백업 시점으로 복원해야 합니다.\n\n정말 ${targetDesc} 데이터를 지울까요?`)) return;
    setBusy(true);
    try {
      const r = await api.maintWipe({ scope, hid: scope === "hospital" ? effHid : undefined, confirm: "WIPE" });
      const stat = r.deleted != null ? ` — 검사 ${r.deleted}건 삭제 (Orthanc ${r.orthanc_removed ?? 0}건)` : "";
      setMsg(r.ok ? `지우기 완료 — ${targetDesc}${stat}${r.detail ? ` (${r.detail})` : ""}` : `⚠ ${r.detail ?? "지우기 실패"}`);
      setConfirmText("");
    } catch (e) { setMsg(pendMsg(e)); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontWeight: 700 }}>🧹 데이터 관리 — 지우고 복원</div>
      <div style={{ fontSize: 12, color: "var(--danger,#f87171)", border: "1px solid var(--danger,#f87171)", borderRadius: 4, padding: "6px 10px" }}>
        ⚠ 파괴적 작업 — 대상 범위의 검사·판독·영상 데이터를 삭제합니다. 실행 전 반드시 백업하세요.
        모든 실행은 서버 감사 로그에 기록됩니다.
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>대상:</span>
        {fixedHid ? (
          <span style={{ fontSize: 12.5 }}>이 병원 ({hospitals.find((h) => h.id === fixedHid)?.name ?? fixedHid})</span>
        ) : (
          <select style={inp} value={hid} onChange={(e) => setHid(e.target.value)}>
            <option value="">— 시스템 전체 —</option>
            {hospitals.map((h) => <option key={h.id} value={h.id}>{h.name || h.code}</option>)}
          </select>
        )}
        <input style={{ ...inp, width: 130 }} placeholder="확인: WIPE 입력" value={confirmText}
               onChange={(e) => setConfirmText(e.target.value)} />
        <button disabled={busy || confirmText !== "WIPE"} onClick={wipe} style={{ color: "var(--danger,#f87171)" }}>
          데이터 지우기…
        </button>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
        'WIPE' 타이핑 확인 + 2단계 확인을 모두 거쳐야 실행됩니다. 지운 뒤에는 아래(또는 [복원] 탭)의 백업 시점 복원으로 되살릴 수 있습니다.
      </div>
      <Msg text={msg} />
    </div>
  );
}
