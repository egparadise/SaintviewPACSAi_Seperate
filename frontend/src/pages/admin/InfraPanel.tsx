// 인프라 패널(레인 O) — ① OHIF 뷰어 관리 ② saintview-* 컨테이너 ③ 병원별 Orthanc 프로비저닝 ④ DDNS
// 백엔드 계약: /api/infra/* (api/infra.py). fetch 는 api.ts 공용 panelFetch 사용(통합 단계 승격 — 동작 무변경).
import { useCallback, useEffect, useState } from "react";
import { showToast } from "../../lib/toast";
import { panelFetch } from "../../api";

// ── 공용 헬퍼 위임 — 오류 문구는 기존 형식(`상태 · 상세` / `상태 상태문구`) 유지(= panelFetch 기본값) ──
const ifetch = <T,>(path: string, init?: RequestInit) => panelFetch<T>(path, init);

// ── 공통 소형 UI (관리 콘솔 다크 테마·표 스타일 유지 — ServerMaintenance 와 동일 관례) ──
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
function errMsg(e: unknown): string {
  const m = (e as Error).message ?? String(e);
  if (m.includes("404")) return "⚠ 준비 중 — 백엔드 라우터 등록 대기(통합 단계)";
  return "⚠ " + m;
}
/** 상태등 ● — running=초록 / exited=빨강 / 그 외·미상=회색 */
function Dot({ state }: { state: string }) {
  const color = state === "running" ? "var(--success,#4ade80)" : state === "exited" ? "var(--danger,#f87171)" : "var(--text-secondary,#9ca3af)";
  return <span title={state || "unknown"} style={{ color, fontSize: 14, lineHeight: 1 }}>●</span>;
}

// ── 백엔드 계약 타입 ──
type ContainerRow = { name: string; image: string; state: string; status: string; ports: string };
type ContainersRes = { docker_ok: boolean; items: ContainerRow[]; detail?: string };
type OhifConfigRes = {
  ohif_url: string; config_path: string; proxy_pass: string;
  datasource: { friendlyName?: string; wadoRoot?: string; qidoRoot?: string; wadoUriRoot?: string; imageRendering?: string; defaultDataSourceName?: string };
  container: ContainerRow | null;
};
type HospitalEntry = { container: string; url: string; dicom_port: number; web_port: number; volume: string; aet: string };
type HospitalRow = { hid: number; code: string; name: string; provisioned: boolean; entry: HospitalEntry | null; state: string; status: string };
type HospitalsRes = { docker_ok: boolean; items: HospitalRow[]; db_note: string };
type DdnsConfig = { provider: string; domain: string; token: string; token_set?: boolean; url_template: string; interval_min: number; enabled: boolean };
type DdnsStatus = { last_ip?: string; last_at?: string; ok?: boolean; detail?: string };

// ════════════════════════════ ① OHIF 뷰어 관리 ════════════════════════════
export function OhifSection() {
  const [cfg, setCfg] = useState<OhifConfigRes | null>(null);
  const [msg, setMsg] = useState("");
  const [showGuide, setShowGuide] = useState(false);
  const load = useCallback(() => {
    ifetch<OhifConfigRes>("/api/infra/ohif/config").then((r) => { setCfg(r); setMsg(""); }).catch((e) => setMsg(errMsg(e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (action: "start" | "stop" | "restart") => {
    try {
      await ifetch(`/api/infra/containers/saintview-ohif/action`, { method: "POST", body: JSON.stringify({ action }) });
      setMsg(`OHIF ${action} 완료`);
      setTimeout(load, 800);
    } catch (e) { setMsg(errMsg(e)); }
  };

  const c = cfg?.container ?? null;
  const ds = cfg?.datasource ?? {};
  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Dot state={c?.state ?? ""} />
        <div style={{ fontWeight: 700 }}>OHIF 뷰어 (saintview-ohif)</div>
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{c ? `${c.image} · ${c.status}` : "컨테이너 상태 미확인"}</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => act("start")}>시작</button>
        <button onClick={() => act("stop")}>중지</button>
        <button className="primary" onClick={() => act("restart")}>재시작</button>
        <button onClick={load}>새로고침</button>
      </div>
      {/* 표가 카드 폭을 넘으면 가로 스크롤 — 내용이 상자 밖으로 튀어나오지 않게 */}
      <div style={{ overflowX: "auto" }}>
      <table className="grid-table" style={{ fontSize: 12.5 }}>
        <tbody>
          <tr><td style={{ width: 160 }}>뷰어 주소</td><td>{cfg ? <a href={cfg.ohif_url} target="_blank" rel="noreferrer">{cfg.ohif_url}</a> : "—"}</td></tr>
          <tr><td>데이터소스</td><td>{ds.friendlyName || "—"} · QIDO/WADO Root: <code>{ds.wadoRoot || "—"}</code> · 렌더링: {ds.imageRendering || "—"}</td></tr>
          <tr><td>프록시(같은 오리진)</td><td><code>/dicom-web → {cfg?.proxy_pass || "—"}</code></td></tr>
          <tr><td>설정 파일</td><td style={{ color: "var(--text-secondary)" }}>{cfg?.config_path || "—"} (호스트 파일 수정 → 재시작으로 반영)</td></tr>
        </tbody>
      </table>
      </div>
      <button style={{ alignSelf: "flex-start" }} onClick={() => setShowGuide(!showGuide)}>
        {showGuide ? "▲ 가이드 접기" : "▼ 어떻게 동작하나 (운영 가이드)"}
      </button>
      {showGuide && (
        <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
          {`OHIF는 오픈소스 웹 DICOM 뷰어(정적 SPA + nginx)로, 데이터를 저장하지 않고 전부 Orthanc(DICOMweb)에서 조회합니다.

데이터 흐름:  브라우저 → OHIF(3000, nginx) → [같은 오리진 프록시 /dicom-web] → Orthanc(8042)
  · 검사 목록 = QIDO-RS(/dicom-web/studies) · 영상 픽셀 = WADO-RS(frames) · 썸네일 = /rendered(PNG 강제)
  · 프록시로 같은 오리진을 만들어 브라우저 CORS 문제를 원천 차단합니다.

설정 위치(이미지 재빌드 불필요 — 파일 교체 + 재시작):
  · deploy/ohif/app-config.js — 뷰어 동작 옵션·데이터소스 정의
  · deploy/ohif/nginx-default.conf — /dicom-web 프록시 대상(Orthanc 주소)
  · deploy/docker-compose.yml — 이미지 버전·포트(3000:80)

주의: 운영 배포 시 Orthanc 인증을 켜면 프록시에 인증 헤더 주입이 함께 필요합니다.
상세: docs/OHIF_운영분석.md`}
        </div>
      )}
      <Msg text={msg} />
    </div>
  );
}

// ════════════════════════════ ② 컨테이너 현황 (saintview-*) ════════════════════════════
export function ContainersSection() {
  const [res, setRes] = useState<ContainersRes | null>(null);
  const [msg, setMsg] = useState("");
  const load = useCallback(() => {
    ifetch<ContainersRes>("/api/infra/containers").then((r) => { setRes(r); setMsg(r.docker_ok ? "" : "⚠ docker 미가용 — " + (r.detail ?? "")); }).catch((e) => setMsg(errMsg(e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (name: string, action: "start" | "stop" | "restart") => {
    try {
      await ifetch(`/api/infra/containers/${encodeURIComponent(name)}/action`, { method: "POST", body: JSON.stringify({ action }) });
      setMsg(`${name} ${action} 완료`);
      setTimeout(load, 800);
    } catch (e) { setMsg(errMsg(e)); }
  };

  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ fontWeight: 700 }}>컨테이너 현황 — saintview-*</div>
        <div style={{ flex: 1 }} />
        <button onClick={load}>새로고침</button>
      </div>
      <div style={{ overflowX: "auto" }}>
      <table className="grid-table" style={{ fontSize: 12.5 }}>
        <thead><tr><th style={{ width: 24 }}></th><th>이름</th><th>이미지</th><th>상태</th><th>포트</th><th style={{ width: 190 }}>제어</th></tr></thead>
        <tbody>
          {(res?.items ?? []).map((c) => (
            <tr key={c.name}>
              <td><Dot state={c.state} /></td>
              <td>{c.name}</td>
              <td style={{ color: "var(--text-secondary)" }}>{c.image}</td>
              <td>{c.status}</td>
              <td style={{ color: "var(--text-secondary)" }}>{c.ports}</td>
              <td>
                <div style={{ display: "flex", gap: 4 }}>
                  <button onClick={() => act(c.name, "start")}>시작</button>
                  <button onClick={() => act(c.name, "stop")}>중지</button>
                  <button onClick={() => act(c.name, "restart")}>재시작</button>
                </div>
              </td>
            </tr>
          ))}
          {res && res.items.length === 0 && (
            <tr><td colSpan={6} style={{ color: "var(--text-secondary)" }}>saintview-* 컨테이너가 없습니다</td></tr>
          )}
        </tbody>
      </table>
      </div>
      <Msg text={msg} />
    </div>
  );
}

// ════════════════════════════ ③ 병원별 Orthanc 컨테이너 ════════════════════════════
/** hid 를 주면 해당 병원 행만 표시(병원별 관리 탭용) — 생략 시 전체(서버 인프라 화면, 기존 동작) */
export function HospitalContainersSection({ hid }: { hid?: number } = {}) {
  const [res, setRes] = useState<HospitalsRes | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const load = useCallback(() => {
    ifetch<HospitalsRes>("/api/infra/hospitals").then((r) => { setRes(r); setMsg(r.docker_ok ? "" : "⚠ docker 미가용 — 상태 표시는 레지스트리 기준"); }).catch((e) => setMsg(errMsg(e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  const provision = async (hid: number) => {
    if (!window.confirm(`병원 #${hid} 전용 Orthanc 컨테이너를 생성(기동)합니다.\n포트는 자동 할당되며 감사 로그가 남습니다.`)) return;
    setBusy(hid);
    try {
      await ifetch(`/api/infra/hospitals/${hid}/provision`, { method: "POST" });
      setMsg(`병원 #${hid} 프로비저닝 완료`);
      load();
    } catch (e) { setMsg(errMsg(e)); } finally { setBusy(null); }
  };
  const act = async (hid: number, action: "start" | "stop" | "remove") => {
    if (action === "remove" && !window.confirm(`병원 #${hid} 컨테이너를 제거합니다.\n영상 데이터 볼륨은 보존됩니다(재프로비저닝 시 재사용).`)) return;
    setBusy(hid);
    try {
      await ifetch(`/api/infra/hospitals/${hid}/action`, { method: "POST", body: JSON.stringify({ action }) });
      setMsg(`병원 #${hid} ${action} 완료`);
      setTimeout(load, 800);
    } catch (e) { setMsg(errMsg(e)); } finally { setBusy(null); }
  };

  // 병원별 탭에서는 해당 병원 행만 — hid 미지정(서버 화면)이면 전체 표시(기존 동작)
  const items = (res?.items ?? []).filter((h) => hid == null || h.hid === hid);
  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ fontWeight: 700 }}>병원별 Orthanc 컨테이너 (영상 저장 물리 분리)</div>
        <div style={{ flex: 1 }} />
        <button onClick={load}>새로고침</button>
      </div>
      {res?.db_note && <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>{res.db_note}</div>}
      <div style={{ overflowX: "auto" }}>
      <table className="grid-table" style={{ fontSize: 12.5 }}>
        <thead><tr><th style={{ width: 24 }}></th><th>병원</th><th>컨테이너</th><th>포트(Web/DICOM)</th><th>볼륨</th><th style={{ width: 230 }}>제어</th></tr></thead>
        <tbody>
          {items.map((h) => (
            <tr key={h.hid}>
              <td>{h.provisioned ? <Dot state={h.state} /> : <span style={{ color: "var(--text-secondary)" }}>—</span>}</td>
              <td>#{h.hid} {h.name || h.code}</td>
              <td>{h.entry?.container ?? <span style={{ color: "var(--text-secondary)" }}>공유 컨테이너 사용(폴백)</span>}</td>
              <td>{h.entry ? `${h.entry.web_port} / ${h.entry.dicom_port} · AET ${h.entry.aet}` : "—"}</td>
              <td style={{ color: "var(--text-secondary)", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }} title={h.entry?.volume ?? ""}>{h.entry?.volume ?? "—"}</td>
              <td>
                <div style={{ display: "flex", gap: 4 }}>
                  {!h.provisioned ? (
                    <button className="primary" disabled={busy === h.hid} onClick={() => provision(h.hid)}>{busy === h.hid ? "생성 중…" : "프로비저닝"}</button>
                  ) : (
                    <>
                      <button disabled={busy === h.hid} onClick={() => act(h.hid, "start")}>시작</button>
                      <button disabled={busy === h.hid} onClick={() => act(h.hid, "stop")}>중지</button>
                      <button disabled={busy === h.hid} onClick={() => act(h.hid, "remove")}>제거</button>
                    </>
                  )}
                </div>
              </td>
            </tr>
          ))}
          {res && items.length === 0 && (
            <tr><td colSpan={6} style={{ color: "var(--text-secondary)" }}>{hid == null ? "등록된 병원이 없습니다" : "이 병원 항목이 없습니다"}</td></tr>
          )}
        </tbody>
      </table>
      </div>
      <Msg text={msg} />
    </div>
  );
}

// ════════════════════════════ ④ DDNS ════════════════════════════
export function DdnsSection() {
  const [cfg, setCfg] = useState<DdnsConfig | null>(null);
  const [status, setStatus] = useState<DdnsStatus>({});
  const [msg, setMsg] = useState("");
  const load = useCallback(() => {
    ifetch<{ config: DdnsConfig; status: DdnsStatus }>("/api/infra/ddns")
      .then((r) => { setCfg(r.config); setStatus(r.status); setMsg(""); })
      .catch((e) => setMsg(errMsg(e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!cfg) return;
    try {
      const r = await ifetch<{ config: DdnsConfig }>("/api/infra/ddns", { method: "PUT", body: JSON.stringify(cfg) });
      setCfg(r.config);
      showToast("저장 되었습니다."); setMsg("저장됨" + (cfg.enabled ? " — 주기 갱신 활성" : ""));
    } catch (e) { setMsg(errMsg(e)); }
  };
  const updateNow = async () => {
    try {
      const r = await ifetch<{ ok: boolean; status: DdnsStatus }>("/api/infra/ddns/update", { method: "POST" });
      setStatus(r.status);
      setMsg(r.ok ? "갱신 성공" : "⚠ 갱신 실패 — " + (r.status.detail ?? ""));
    } catch (e) { setMsg(errMsg(e)); }
  };

  if (!cfg) return <div style={card}>{msg || "불러오는 중…"}</div>;
  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 8, maxWidth: 640 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Dot state={status.ok === true ? "running" : status.ok === false ? "exited" : ""} />
        <div style={{ fontWeight: 700 }}>DDNS — 동적 도메인 갱신</div>
        <div style={{ flex: 1 }} />
        <button onClick={load}>새로고침</button>
      </div>
      <Row label="공급자">
        <select style={inp} value={cfg.provider} onChange={(e) => setCfg({ ...cfg, provider: e.target.value })}>
          <option value="duckdns">DuckDNS</option>
          <option value="dynu">Dynu</option>
          <option value="custom">Custom (URL 템플릿)</option>
        </select>
      </Row>
      <Row label="도메인"><input style={{ ...inp, flex: 1 }} value={cfg.domain} onChange={(e) => setCfg({ ...cfg, domain: e.target.value })} placeholder="예: myhospital.duckdns.org" /></Row>
      <Row label="토큰">
        <input style={{ ...inp, flex: 1 }} type="password" value={cfg.token} onChange={(e) => setCfg({ ...cfg, token: e.target.value })}
          placeholder={cfg.token_set ? "설정됨(변경 시에만 입력)" : "공급자 발급 토큰"} />
      </Row>
      {cfg.provider === "custom" && (
        <Row label="URL 템플릿">
          <input style={{ ...inp, flex: 1 }} value={cfg.url_template} onChange={(e) => setCfg({ ...cfg, url_template: e.target.value })}
            placeholder="https://example.com/update?host={domain}&key={token}&ip={ip}" />
        </Row>
      )}
      <Row label="갱신 주기(분)"><input style={{ ...inp, width: 90 }} type="number" min={1} value={cfg.interval_min} onChange={(e) => setCfg({ ...cfg, interval_min: Number(e.target.value) || 30 })} /></Row>
      <Row label="자동 갱신">
        <input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>켜면 주기적으로 공인 IP를 조회해 갱신합니다</span>
      </Row>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="primary" onClick={save}>저장</button>
        <button onClick={updateNow}>지금 갱신</button>
      </div>
      <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
        마지막 갱신: {status.last_at ? new Date(status.last_at).toLocaleString() : "—"} · IP: {status.last_ip || "—"} · 결과: {status.ok == null ? "—" : status.ok ? "성공" : "실패"}
        {status.detail ? ` (${status.detail})` : ""}
      </div>
      <Msg text={msg} />
    </div>
  );
}

// ════════════════════════════ 통합 패널 (AdminConsole 배선은 통합 단계 몫) ════════════════════════════
export default function InfraPanel() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <OhifSection />
      <ContainersSection />
      <HospitalContainersSection />
      <DdnsSection />
    </div>
  );
}
