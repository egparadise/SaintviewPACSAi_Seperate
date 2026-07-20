// HL7/EMR·장비 연동 패널(레인 H) — 병원별 4섹션:
// ① HL7 설정 + inbox/outbox 표·재처리 ② 원격판독 설정 + 최근 수신 ③ MWL 설정 + 상태 ④ 가상환자 생성
// 백엔드는 /api/hl7/* (app/api/hl7.py). fetch 는 api.ts 공용 panelFetch 사용(통합 단계 승격 — 동작 무변경).
import { useCallback, useEffect, useState } from "react";
import { showToast } from "../../lib/toast";
import { panelFetch } from "../../api";
import { OrderEntryRis, OrderList, type RisExam, type RisPatient } from "../../components/OrderEntryRis";

// ── 공용 헬퍼 위임 — 오류 문구는 기존 형식(`상태코드 상세`) 유지 ──
const hl7Fetch = <T = unknown,>(path: string, init?: RequestInit) =>
  panelFetch<T>(path, init, (s, st, d) => `${s} ${d || st}`);
const GET = <T,>(p: string) => hl7Fetch<T>(p);
const POST = <T,>(p: string, body?: unknown) =>
  hl7Fetch<T>(p, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const PUT = <T,>(p: string, body: unknown) =>
  hl7Fetch<T>(p, { method: "PUT", body: JSON.stringify(body) });

// ── 타입 ──
type Hl7Msg = {
  id: number; hospital_id: number | null; direction: string; msg_type: string;
  patient_id: string; accession: string; status: string; error: string;
  parsed_json: Record<string, unknown>; retry_count: number | null;
  created_at: string | null; processed_at: string | null;
};
type ConfigResp = { key: string; hospital_id: number; value: Record<string, unknown> };
type MwlStatus = { hospital_id: number; running: boolean; port?: number; aet?: string };
type TestgenOrder = { order_id: number; accession_no: string; body_part: string; projection: string };

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
      <span style={{ width: 140, color: "var(--text-secondary)", flexShrink: 0 }}>{label}</span>
      {children}
    </label>
  );
}
function errMsg(e: unknown): string {
  return "⚠ " + ((e as Error).message ?? String(e));
}
function StatusBadge({ s }: { s: string }) {
  const color = s === "done" || s === "sent" ? "var(--success,#4ade80)"
    : s === "error" ? "var(--danger,#f87171)" : "var(--warning,#facc15)";
  return <span style={{ color, fontWeight: 600 }}>{s}</span>;
}
const fmtTs = (t: string | null) => (t ? t.replace("T", " ").slice(0, 19) : "—");

// ════════════════════════════ ① HL7 설정 + inbox/outbox ════════════════════════════
export function Hl7ConfigSection({ hid }: { hid: number }) {
  const [cfg, setCfg] = useState<{ enabled: boolean; port: string; facility: string; oruHost: string; oruPort: string; retryMax: string } | null>(null);
  const [listeners, setListeners] = useState<{ port: number; running: boolean }[]>([]);
  const [inbox, setInbox] = useState<Hl7Msg[]>([]);
  const [outbox, setOutbox] = useState<Hl7Msg[]>([]);
  const [msg, setMsg] = useState("");

  const load = useCallback(() => {
    GET<ConfigResp>(`/api/hl7/hospitals/${hid}/config/hl7.config`)
      .then((r) => {
        const v = r.value;
        const oru = (v.oru as Record<string, unknown>) ?? {};
        setCfg({
          enabled: Boolean(v.enabled), port: String(v.port ?? ""), facility: String(v.facility ?? ""),
          oruHost: String(oru.host ?? ""), oruPort: String(oru.port ?? ""), retryMax: String(v.oru_retry_max ?? "3"),
        });
      })
      .catch((e) => { setCfg({ enabled: false, port: "", facility: "", oruHost: "", oruPort: "", retryMax: "3" }); setMsg(errMsg(e)); });
    GET<{ items: { port: number; running: boolean }[] }>("/api/hl7/listener/status")
      .then((r) => setListeners(r.items)).catch(() => setListeners([]));
    GET<{ items: Hl7Msg[] }>(`/api/hl7/hospitals/${hid}/inbox?limit=30`)
      .then((r) => setInbox(r.items)).catch(() => setInbox([]));
    GET<{ items: Hl7Msg[] }>(`/api/hl7/hospitals/${hid}/outbox?limit=30`)
      .then((r) => setOutbox(r.items)).catch(() => setOutbox([]));
  }, [hid]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!cfg) return;
    try {
      await PUT(`/api/hl7/hospitals/${hid}/config/hl7.config`, {
        value: {
          enabled: cfg.enabled, port: Number(cfg.port) || 0, facility: cfg.facility,
          oru: { host: cfg.oruHost, port: Number(cfg.oruPort) || 0 },
          oru_retry_max: Number(cfg.retryMax) || 3,
        },
      });
      showToast("저장 되었습니다."); setMsg("저장됨 (병원 스코프 hl7.config)");
    } catch (e) { setMsg(errMsg(e)); }
  };
  const listenerRunning = cfg ? listeners.some((l) => l.port === Number(cfg.port)) : false;
  const toggleListener = async () => {
    if (!cfg) return;
    try {
      await POST(listenerRunning ? "/api/hl7/listener/stop" : "/api/hl7/listener/start", { port: Number(cfg.port) || 0 });
      setMsg(listenerRunning ? "MLLP 리스너 중지됨" : "MLLP 리스너 시작됨");
      load();
    } catch (e) { setMsg(errMsg(e)); }
  };
  const reprocess = async (mid: number) => {
    try { await POST(`/api/hl7/hospitals/${hid}/inbox/${mid}/reprocess`); setMsg(`#${mid} 재처리 완료`); load(); }
    catch (e) { setMsg(errMsg(e)); }
  };
  const sendOut = async (mid: number) => {
    try {
      const r = await POST<Hl7Msg>(`/api/hl7/hospitals/${hid}/outbox/${mid}/send`);
      setMsg(r.status === "sent" ? `#${mid} 전송 성공` : `⚠ #${mid} 전송 실패: ${r.error}`);
      load();
    } catch (e) { setMsg(errMsg(e)); }
  };
  const syncOru = async () => {
    try { const r = await POST<{ enqueued: number }>("/api/hl7/outbox/sync"); setMsg(`확정 판독 ORU 적재: ${r.enqueued}건`); load(); }
    catch (e) { setMsg(errMsg(e)); }
  };

  if (!cfg) return <div style={card}>불러오는 중…</div>;
  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ fontWeight: 700 }}>🔌 HL7 연동 — MLLP 수신(ADT/ORM) · ORU 발신</div>
        <div style={{ flex: 1 }} />
        <button onClick={load}>새로고침</button>
      </div>
      <Row label="활성(enabled)">
        <input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
        <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>기본 off — 켠 뒤 리스너를 시작하세요</span>
      </Row>
      <Row label="수신 포트(MLLP)"><input style={{ ...inp, width: 110 }} value={cfg.port} onChange={(e) => setCfg({ ...cfg, port: e.target.value })} placeholder="2575" /></Row>
      <Row label="수신기관 매핑(MSH-5/6)"><input style={{ ...inp, flex: 1 }} value={cfg.facility} onChange={(e) => setCfg({ ...cfg, facility: e.target.value })} placeholder="포트 공유 시 병원 구분값 (예: SAINTVIEW)" /></Row>
      <Row label="ORU 대상 host:port">
        <input style={{ ...inp, flex: 1 }} value={cfg.oruHost} onChange={(e) => setCfg({ ...cfg, oruHost: e.target.value })} placeholder="EMR 수신 서버 IP" />
        <input style={{ ...inp, width: 90 }} value={cfg.oruPort} onChange={(e) => setCfg({ ...cfg, oruPort: e.target.value })} placeholder="port" />
      </Row>
      <Row label="전송 재시도 최대"><input style={{ ...inp, width: 70 }} value={cfg.retryMax} onChange={(e) => setCfg({ ...cfg, retryMax: e.target.value })} /></Row>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button className="primary" onClick={save}>저장</button>
        <button onClick={toggleListener} disabled={!cfg.port}>
          {listenerRunning ? "리스너 중지" : "리스너 시작"} (포트 {cfg.port || "—"})
        </button>
        <span style={{ fontSize: 12, color: listenerRunning ? "var(--success,#4ade80)" : "var(--text-secondary)" }}>
          {listenerRunning ? "● 수신 중" : "○ 중지됨"}
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={syncOru} title="확정 판독 중 ORU 미적재분을 outbox에 적재">확정판독 ORU 적재</button>
      </div>
      <Msg text={msg} />

      <div style={{ fontWeight: 600, fontSize: 12.5, marginTop: 4 }}>📥 수신함(inbox) — ADT=환자 캐시 · ORM=오더 생성</div>
      <div style={{ overflowX: "auto" }}>
        <table className="grid-table" style={{ fontSize: 12 }}>
          <thead><tr><th>#</th><th>타입</th><th>환자ID</th><th>Accession</th><th>상태</th><th>수신시각</th><th>오류/조치</th></tr></thead>
          <tbody>
            {inbox.length === 0 && <tr><td colSpan={7} style={{ color: "var(--text-secondary)" }}>수신 메시지 없음</td></tr>}
            {inbox.map((m) => (
              <tr key={m.id}>
                <td>{m.id}</td><td>{m.msg_type}</td><td>{m.patient_id || "—"}</td><td>{m.accession || "—"}</td>
                <td><StatusBadge s={m.status} /></td><td>{fmtTs(m.created_at)}</td>
                <td>
                  {m.error && <span style={{ color: "var(--danger,#f87171)" }}>{m.error.slice(0, 60)} </span>}
                  {m.status === "error" && <button onClick={() => reprocess(m.id)}>재처리</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ fontWeight: 600, fontSize: 12.5 }}>📤 발신함(outbox) — 판독 확정 ORU^R01</div>
      <div style={{ overflowX: "auto" }}>
        <table className="grid-table" style={{ fontSize: 12 }}>
          <thead><tr><th>#</th><th>타입</th><th>환자ID</th><th>Accession</th><th>상태</th><th>재시도</th><th>조치</th></tr></thead>
          <tbody>
            {outbox.length === 0 && <tr><td colSpan={7} style={{ color: "var(--text-secondary)" }}>발신 메시지 없음</td></tr>}
            {outbox.map((m) => (
              <tr key={m.id}>
                <td>{m.id}</td><td>{m.msg_type}</td><td>{m.patient_id || "—"}</td><td>{m.accession || "—"}</td>
                <td><StatusBadge s={m.status} /></td><td>{m.retry_count ?? 0}</td>
                <td>{m.status !== "sent" && <button onClick={() => sendOut(m.id)}>전송</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ════════════════════════════ ② 원격판독 설정 + 최근 수신 ════════════════════════════
export function RemoteReadingSection({ hid }: { hid: number }) {
  const [cfg, setCfg] = useState<{ enabled: boolean; apiKey: string } | null>(null);
  const [recent, setRecent] = useState<Hl7Msg[]>([]);
  const [msg, setMsg] = useState("");
  const [showKey, setShowKey] = useState(false);

  const load = useCallback(() => {
    GET<ConfigResp>(`/api/hl7/hospitals/${hid}/config/remote.reading`)
      .then((r) => setCfg({ enabled: Boolean(r.value.enabled), apiKey: String(r.value.api_key ?? "") }))
      .catch((e) => { setCfg({ enabled: false, apiKey: "" }); setMsg(errMsg(e)); });
    GET<{ items: Hl7Msg[] }>(`/api/hl7/hospitals/${hid}/inbox?msg_type=RMT&limit=20`)
      .then((r) => setRecent(r.items)).catch(() => setRecent([]));
  }, [hid]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!cfg) return;
    try {
      await PUT(`/api/hl7/hospitals/${hid}/config/remote.reading`, { value: { enabled: cfg.enabled, api_key: cfg.apiKey } });
      showToast("저장 되었습니다."); setMsg("저장됨 — 외부 원격판독사는 POST /api/hl7/remote-report 에 이 키로 판독문을 입력합니다");
    } catch (e) { setMsg(errMsg(e)); }
  };
  const genKey = () => {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    setCfg((c) => c && { ...c, apiKey: Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("") });
  };

  if (!cfg) return <div style={card}>불러오는 중…</div>;
  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontWeight: 700 }}>🩺 원격판독 판독문 입력 창구 — 병원별 API 키</div>
      <Row label="활성(enabled)"><input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} /></Row>
      <Row label="API 키">
        <input style={{ ...inp, flex: 1 }} type={showKey ? "text" : "password"} value={cfg.apiKey}
               onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })} placeholder="원격판독사에 전달할 비밀 키" />
        <button onClick={() => setShowKey(!showKey)}>{showKey ? "숨김" : "표시"}</button>
        <button onClick={genKey}>키 생성</button>
      </Row>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="primary" onClick={save}>저장</button>
        <button onClick={load}>새로고침</button>
      </div>
      <Msg text={msg} />
      <div style={{ fontWeight: 600, fontSize: 12.5 }}>최근 수신 판독문</div>
      <div style={{ overflowX: "auto" }}>
        <table className="grid-table" style={{ fontSize: 12 }}>
          <thead><tr><th>#</th><th>Accession</th><th>판독의</th><th>수신시각</th></tr></thead>
          <tbody>
            {recent.length === 0 && <tr><td colSpan={4} style={{ color: "var(--text-secondary)" }}>수신 내역 없음</td></tr>}
            {recent.map((m) => (
              <tr key={m.id}>
                <td>{m.id}</td><td>{m.accession || "—"}</td>
                <td>{String(m.parsed_json?.reporter ?? "—")}</td><td>{fmtTs(m.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ════════════════════════════ ③ MWL 설정 + 상태 ════════════════════════════
export function MwlSection({ hid }: { hid: number }) {
  const [cfg, setCfg] = useState<{ enabled: boolean; port: string; aet: string; registeredOnly: boolean } | null>(null);
  const [status, setStatus] = useState<MwlStatus | null>(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(() => {
    GET<ConfigResp>(`/api/hl7/hospitals/${hid}/config/mwl.config`)
      .then((r) => setCfg({
        enabled: Boolean(r.value.enabled), port: String(r.value.port ?? ""),
        aet: String(r.value.aet ?? "SAINTVIEW"), registeredOnly: Boolean(r.value.registered_only),
      }))
      .catch((e) => { setCfg({ enabled: false, port: "", aet: "SAINTVIEW", registeredOnly: false }); setMsg(errMsg(e)); });
    GET<MwlStatus>(`/api/hl7/hospitals/${hid}/mwl/status`).then(setStatus).catch(() => setStatus(null));
  }, [hid]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!cfg) return;
    try {
      await PUT(`/api/hl7/hospitals/${hid}/config/mwl.config`, {
        value: { enabled: cfg.enabled, port: Number(cfg.port) || 0, aet: cfg.aet, registered_only: cfg.registeredOnly },
      });
      showToast("저장 되었습니다."); setMsg("저장됨 (병원 스코프 mwl.config)");
    } catch (e) { setMsg(errMsg(e)); }
  };
  const toggle = async () => {
    try {
      await POST(`/api/hl7/hospitals/${hid}/mwl/${status?.running ? "stop" : "start"}`);
      setMsg(status?.running ? "MWL SCP 중지됨" : "MWL SCP 시작됨");
      load();
    } catch (e) { setMsg(errMsg(e)); }
  };

  if (!cfg) return <div style={card}>불러오는 중…</div>;
  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10, maxWidth: 640 }}>
      <div style={{ fontWeight: 700 }}>📡 MWL(Modality Worklist) SCP — 장비에 환자·검사 정보 주기</div>
      <Row label="활성(enabled)"><input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} /></Row>
      <Row label="포트"><input style={{ ...inp, width: 110 }} value={cfg.port} onChange={(e) => setCfg({ ...cfg, port: e.target.value })} placeholder="10450" /></Row>
      <Row label="AE Title"><input style={{ ...inp, width: 170 }} value={cfg.aet} onChange={(e) => setCfg({ ...cfg, aet: e.target.value })} /></Row>
      <Row label="등록 장비만 허용">
        <input type="checkbox" checked={cfg.registeredOnly} onChange={(e) => setCfg({ ...cfg, registeredOnly: e.target.checked })} />
        <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>병원 등록 Modality(modality.nodes)의 AET에서 온 C-FIND만 응답</span>
      </Row>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button className="primary" onClick={save}>저장</button>
        <button onClick={toggle}>{status?.running ? "SCP 중지" : "SCP 시작"}</button>
        <span style={{ fontSize: 12, color: status?.running ? "var(--success,#4ade80)" : "var(--text-secondary)" }}>
          {status?.running ? `● 가동 중 — AET=${status.aet} Port=${status.port}` : "○ 중지됨"}
        </span>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
        미완료(scheduled) 오더를 장비 C-FIND 질의(Modality·AET·예정일)로 응답합니다. HL7 ORM 오더와 가상환자 오더가 조회 대상입니다.
      </div>
      <Msg text={msg} />
    </div>
  );
}

// ════════════════════════════ ④ 가상 환자 생성기 (오더 입력형 — RIS 스타일) ════════════════════════════


export function TestgenSection({ hid }: { hid: number }) {
  const [cfg, setCfg] = useState<{ pidPrefix: string; pidDigits: string; accPrefix: string; modalities: string; bodyParts: string; ageMin: string; ageMax: string } | null>(null);
  const [msg, setMsg] = useState("");
  const [rk, setRk] = useState(0);   // 오더 목록 강제 새로고침 키 (저장 직후 증가)

  const load = useCallback(() => {
    GET<ConfigResp>(`/api/hl7/hospitals/${hid}/config/testgen.config`)
      .then((r) => {
        const v = r.value;
        setCfg({
          pidPrefix: String(v.pid_prefix ?? "TP"), pidDigits: String(v.pid_digits ?? "6"),
          accPrefix: String(v.acc_prefix ?? "TA"),
          modalities: (Array.isArray(v.modalities) ? v.modalities as string[] : []).join(","),
          bodyParts: (Array.isArray(v.body_parts) ? v.body_parts as string[] : []).join(","),
          ageMin: String(v.age_min ?? "20"), ageMax: String(v.age_max ?? "80"),
        });
      })
      .catch((e) => { setCfg({ pidPrefix: "TP", pidDigits: "6", accPrefix: "TA", modalities: "CR,CT,MR,US", bodyParts: "CHEST,ABDOMEN", ageMin: "20", ageMax: "80" }); setMsg(errMsg(e)); });
  }, [hid]);
  useEffect(() => { load(); }, [load]);

  const csv = (s: string) => s.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
  const saveCfg = async () => {
    if (!cfg) return;
    try {
      await PUT(`/api/hl7/hospitals/${hid}/config/testgen.config`, {
        value: {
          pid_prefix: cfg.pidPrefix, pid_digits: Number(cfg.pidDigits) || 6, acc_prefix: cfg.accPrefix,
          modalities: csv(cfg.modalities), body_parts: csv(cfg.bodyParts),
          age_min: Number(cfg.ageMin) || 20, age_max: Number(cfg.ageMax) || 80,
        },
      });
      showToast("저장 되었습니다."); setMsg("생성 규칙 저장됨 (testgen.config)");
    } catch (e) { setMsg(errMsg(e)); }
  };

  // Generate 링크 — testgen.config 프리픽스/자릿수 규칙으로 문자열 생성(순수 함수)
  const genDigits = (n: number) =>
    String(Math.floor(Math.random() * Math.pow(10, n))).padStart(n, "0");
  const genPid = () => (cfg ? cfg.pidPrefix + genDigits(Number(cfg.pidDigits) || 6) : "");
  const genAcc = () => (cfg ? cfg.accPrefix + genDigits(8) : "");

  // 오더 저장 — POST /api/hl7/testgen (명시 모드, 확장 필드 포함). 성공 메시지 반환 + 목록 새로고침.
  const onSave = async (p: RisPatient, exams: RisExam[]): Promise<string> => {
    const r = await POST<{ orders: TestgenOrder[]; patient_key: string }>("/api/hl7/testgen", {
      hospital_id: hid,
      patient: {
        patient_id: p.patient_id, accession: p.accession, sex: p.sex,
        last_name: p.last_name, first_name: p.first_name,
        physician: p.physician, department: p.department, modality: p.modality,
        birth_date: p.birth_date, scheduled_date: p.scheduled_date,
        scheduled_time: p.scheduled_time, station_aet: p.station_aet, dicom_study_id: p.dicom_study_id,
      },
      exams: exams.map((e) => ({ region: e.region, body_part: e.body_part, projection: e.projection })),
    });
    setRk((k) => k + 1);  // 우측 오더 목록 즉시 갱신
    return `✅ 환자 ${r.patient_key} — 오더 ${r.orders.length}건 저장 (MWL 조회 가능): ${r.orders.map((o) => o.accession_no).join(", ")}`;
  };

  if (!cfg) return <div style={card}>불러오는 중…</div>;
  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontWeight: 700 }}>🧪 가상 환자 생성기 — 오더 입력(RIS) · 생성 오더는 MWL 조회 대상</div>

      {/* 좌: 오더 입력 5컬럼 · 우: 등록된 오더/장비 가져간 오더 목록(수정·삭제·실시간) */}
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: "2 1 620px", minWidth: 0, overflowX: "auto" }}>
          <OrderEntryRis onSave={onSave} genPid={genPid} genAcc={genAcc} />
        </div>
        <div style={{ flex: "1 1 360px", minWidth: 0 }}>
          <OrderList hospitalId={hid} refreshKey={rk} />
        </div>
      </div>
      <Msg text={msg} />

      {/* 생성 규칙 (프리픽스/자릿수) — 접이식 유지, 위 Generate 링크가 이 규칙 사용 */}
      <details style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
        <summary style={{ fontSize: 12.5, cursor: "pointer", color: "var(--text-secondary)" }}>⚙ 생성 규칙 저장 (프리픽스/자릿수)</summary>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
          <Row label="환자ID 프리픽스"><input style={{ ...inp, width: 90 }} value={cfg.pidPrefix} onChange={(e) => setCfg({ ...cfg, pidPrefix: e.target.value })} /></Row>
          <Row label="ID 자릿수"><input style={{ ...inp, width: 60 }} value={cfg.pidDigits} onChange={(e) => setCfg({ ...cfg, pidDigits: e.target.value })} /></Row>
          <Row label="Accession 프리픽스"><input style={{ ...inp, width: 90 }} value={cfg.accPrefix} onChange={(e) => setCfg({ ...cfg, accPrefix: e.target.value })} /></Row>
          <Row label="나이 범위">
            <input style={{ ...inp, width: 55 }} value={cfg.ageMin} onChange={(e) => setCfg({ ...cfg, ageMin: e.target.value })} />
            <span>~</span>
            <input style={{ ...inp, width: 55 }} value={cfg.ageMax} onChange={(e) => setCfg({ ...cfg, ageMax: e.target.value })} />
          </Row>
          <Row label="Modality(콤마)"><input style={{ ...inp, flex: 1 }} value={cfg.modalities} onChange={(e) => setCfg({ ...cfg, modalities: e.target.value })} placeholder="CR,CT,MR,US" /></Row>
          <Row label="Body Part(콤마)"><input style={{ ...inp, flex: 1 }} value={cfg.bodyParts} onChange={(e) => setCfg({ ...cfg, bodyParts: e.target.value })} placeholder="CHEST,ABDOMEN" /></Row>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button onClick={saveCfg}>생성 규칙 저장</button>
          <button onClick={load}>다시 불러오기</button>
        </div>
      </details>
    </div>
  );
}

// ════════════════════════════ 통합 패널 ════════════════════════════
/** 병원별 EMR/장비 연동 패널 — 관리 콘솔·병원 관리 화면에서 <Hl7Panel hid={...} /> 로 배선 */
export function Hl7Panel({ hid }: { hid: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Hl7ConfigSection hid={hid} />
      <RemoteReadingSection hid={hid} />
      <MwlSection hid={hid} />
      <TestgenSection hid={hid} />
    </div>
  );
}

export default Hl7Panel;
