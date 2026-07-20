// 병원별 관리 탭(레인 F) — 등록 병원 선택 시 하위 관리 7종
// ① 계정(등급) ② 권한 매트릭스 ③ Modality(SCP) ④ 병원 설정(SCU) ⑤ 사용량 ⑥ 연결 대시보드 ⑦ DB·영상 관리
// 백엔드 계약(usage/perm-matrix/modalities/scu/admin-action)은 레인 B가 병렬 구현 — 계약 기준 코딩.
import { useEffect, useRef, useState, useCallback } from "react";
import { showToast } from "../../lib/toast";
import {
  api, type ClientRow, type HospitalRow, type HospitalScu, type HospitalUsage,
  type ModalityNode, type PermMatrixResp, type StudyAdminActionKind, type StudyRow,
} from "../../api";
import { LogsPanel, StatsPanel } from "./ServerInsights";
import { DataWipePanel, RestorePanel } from "./ServerMaintenance";
import { ExamControl } from "./ExamControl";

// ── 공통 상수/소형 UI (기존 AdminConsole 다크 테마·표 스타일 유지) ──
const card: React.CSSProperties = { background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8, padding: 14 };
const inp: React.CSSProperties = {
  background: "var(--bg-canvas)", color: "var(--text-primary)",
  border: "1px solid var(--border)", borderRadius: 4, padding: "5px 8px", fontSize: 12.5, minWidth: 0,
};

// 상태등 색 — 초록/빨강/회색 (요구 색상 고정)
const DOT_OK = "#22c55e";
const DOT_FAIL = "#ef4444";
const DOT_UNKNOWN = "#6b7280";
type DotState = "ok" | "fail" | "unknown";
function Dot({ state, title }: { state: DotState; title?: string }) {
  const bg = state === "ok" ? DOT_OK : state === "fail" ? DOT_FAIL : DOT_UNKNOWN;
  return (
    <span title={title} style={{ display: "inline-block", width: 9, height: 9, borderRadius: "50%", background: bg, verticalAlign: "middle" }} />
  );
}

function Msg({ text }: { text: string }) {
  if (!text) return null;
  return <div style={{ fontSize: 12, color: text.startsWith("⚠") ? "var(--danger,#f87171)" : "var(--accent,#7dd3fc)" }}>{text}</div>;
}

/** 403(권한) 오류를 사용자 안내로 변환 — 그 외는 원문 표시 */
function errMsg(e: unknown): string {
  const m = (e as Error).message ?? String(e);
  if (m.includes("403") || m.includes("권한")) {
    return "⚠ 권한이 없습니다 — [② 권한 매트릭스]에서 이 등급의 권한을 확인하세요";
  }
  return "⚠ " + m;
}

const fmtTime = (s: string | null | undefined) => (s ? s.replace("T", " ").slice(0, 19) : "—");
const nowStr = () => new Date().toLocaleTimeString();

// 역할(등급) — 기존 키 유지, 라벨 병기
const CLIENT_ROLES: { key: string; label: string }[] = [
  { key: "doctor", label: "의사(Doctor)" },
  { key: "radiologist", label: "영상의학과 의사(Radiologist)" },
  { key: "technologist", label: "방사선사(Radiographer)" },
  { key: "staff", label: "기타 의료인(Medician)" },
];
const roleLabel = (key?: string) => CLIENT_ROLES.find((r) => r.key === key)?.label ?? (key || "—");

// ════════════════════════════ ① 계정(발급 계정·등급) ════════════════════════════
export function AccountsTab({ hid }: { hid: number }) {
  const [items, setItems] = useState<ClientRow[]>([]);
  const [name, setName] = useState("");
  const [loc, setLoc] = useState("");
  const [role, setRole] = useState("staff");
  const [pw, setPw] = useState("1111");            // 발급 시 초기 비번(기본 1111)
  const [reveal, setReveal] = useState<Set<number>>(new Set());  // 비번 표시 중인 행
  const [msg, setMsg] = useState("");
  const load = () => api.clients(hid).then((r) => setItems(r.items)).catch((e) => setMsg(errMsg(e)));
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [hid]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async () => {
    try { await api.createClient(hid, { name: name.trim(), location: loc.trim(), role, password: pw.trim() || "1111" }); setName(""); setLoc(""); setPw("1111"); setMsg(`발급됨 — 로그인 ID는 좌석 코드, 초기 비번 "${pw.trim() || "1111"}"`); load(); }
    catch (e) { setMsg(errMsg(e)); }
  };
  const patch = async (c: ClientRow, body: { enabled?: boolean; role?: string }) => {
    try { await api.updateClient(hid, c.id, { name: c.name, location: c.location, enabled: c.enabled, role: c.role, ...body }); load(); }
    catch (e) { setMsg(errMsg(e)); }
  };
  const toggleReveal = (id: number) => setReveal((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const editPw = async (c: ClientRow) => {
    const np = prompt(`'${c.name}' 새 비밀번호 (admin 지정)`, c.password || "");
    if (np == null || !np.trim()) return;
    try { await api.setClientPassword(hid, c.id, np.trim()); setMsg(`'${c.name}' 비번 변경됨`); load(); } catch (e) { setMsg(errMsg(e)); }
  };
  const resetPw = async (c: ClientRow) => {
    if (!confirm(`'${c.name}' 비밀번호를 초기값 "1111" 로 리셋할까요? (다음 로그인 시 강제 변경)`)) return;
    try { await api.resetClientPassword(hid, c.id); setMsg(`'${c.name}' → 1111 리셋됨`); load(); } catch (e) { setMsg(errMsg(e)); }
  };
  const resetAll = async () => {
    if (!confirm(`이 병원의 모든 발급 계정 비밀번호를 "1111" 로 일괄 리셋할까요? (전부 다음 로그인 시 강제 변경)`)) return;
    try { const r = await api.resetAllClientPasswords(hid); setMsg(`${r.count}개 계정 → 1111 일괄 리셋됨`); load(); } catch (e) { setMsg(errMsg(e)); }
  };

  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700 }}>👤 계정 관리 (발급 계정·등급)</div>
        <div style={{ flex: 1 }} />
        <input style={inp} placeholder="계정(좌석) 이름" value={name} onChange={(e) => setName(e.target.value)} />
        <input style={inp} placeholder="위치" value={loc} onChange={(e) => setLoc(e.target.value)} />
        <select style={inp} value={role} onChange={(e) => setRole(e.target.value)}>
          {CLIENT_ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        <input style={{ ...inp, width: 110 }} placeholder="초기 비번(1111)" value={pw} onChange={(e) => setPw(e.target.value)} title="발급 시 초기 비밀번호 — 최초 로그인 시 1회 변경 강제" />
        <button onClick={add} disabled={!name.trim()}>＋ 발급</button>
        <button onClick={resetAll} style={{ color: "var(--stat-emergency,#f87171)" }} title="이 병원 모든 발급 계정 비번을 1111 로 일괄 리셋">↺ 모든 비번 리셋</button>
      </div>
      {/* 표가 카드 폭을 넘으면 가로 스크롤 — 내용이 상자 밖으로 튀어나오지 않게 */}
      <div style={{ overflowX: "auto" }}>
      <table className="grid-table" style={{ fontSize: 12.5 }}>
        <thead><tr><th>이름</th><th>코드(로그인 ID)</th><th>등급</th><th>비밀번호</th><th>위치</th><th>접속</th><th>마지막</th><th>사용</th><th></th></tr></thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id} style={{ opacity: c.enabled ? 1 : 0.5 }}>
              <td>{c.name}</td><td>{c.code}</td>
              <td>
                <select style={{ ...inp, padding: "3px 6px" }} value={c.role ?? "staff"} onChange={(e) => patch(c, { role: e.target.value })}>
                  {CLIENT_ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                </select>
              </td>
              <td>
                {c.has_login ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>
                    <code style={{ fontSize: 12 }}>{reveal.has(c.id) ? (c.password || "—") : "••••"}</code>
                    <span onClick={() => toggleReveal(c.id)} style={{ cursor: "pointer" }} title="비번 표시/숨김">👁</span>
                    <span onClick={() => editPw(c)} style={{ cursor: "pointer" }} title="비번 수정(지정)">✏️</span>
                    <span onClick={() => resetPw(c)} style={{ cursor: "pointer" }} title="1111 로 리셋">↺</span>
                    {c.must_change && <span title="최초 로그인 시 변경 필요" style={{ color: "var(--stat-emergency,#f87171)", fontSize: 10 }}>변경필요</span>}
                  </span>
                ) : <span style={{ color: "var(--text-secondary)" }}>—</span>}
              </td>
              <td>{c.location || "—"}</td>
              <td>
                <Dot state={c.online ? "ok" : "unknown"} title={c.online ? "하트비트 수신 중(온라인)" : "오프라인/대기"} />{" "}
                <span style={{ color: c.online ? DOT_OK : "var(--text-secondary)" }}>{c.online ? "접속중" : "대기"}</span>
              </td>
              <td>{fmtTime(c.last_seen)}</td>
              <td><input type="checkbox" checked={c.enabled} onChange={(e) => patch(c, { enabled: e.target.checked })} /></td>
              <td><button onClick={async () => { if (confirm(`계정 '${c.name}' 삭제?`)) { try { await api.deleteClient(hid, c.id); load(); } catch (e) { setMsg(errMsg(e)); } } }}>삭제</button></td>
            </tr>
          ))}
          {items.length === 0 && <tr><td colSpan={9} style={{ color: "var(--text-secondary)" }}>발급된 계정이 없습니다.</td></tr>}
        </tbody>
      </table>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
        등급은 [② 권한 매트릭스]의 병원별 권한과 연동됩니다. 기타 의료인(Medician)은 기본 조회 전용입니다.
        접속 상태등은 Client 하트비트 기반(15초 자동 갱신)입니다.
      </div>
      <Msg text={msg} />
    </div>
  );
}

// ════════════════════════════ ② 권한 매트릭스 ════════════════════════════
// 기본 매트릭스(요구 정정 2026-06-04): radiologist/doctor=+판독·판독출력·영상출력,
// technologist=+영상 수신/추가/등록/이동/매칭/언매칭/복제/영상출력, staff=조회 전용
const DEFAULT_MATRIX: Record<string, string[]> = {
  radiologist: ["worklist.view", "report.read", "report.write", "report.finalize", "report.confirm2", "report.print", "image.print"],
  doctor: ["worklist.view", "report.read", "report.write", "report.finalize", "report.print", "image.print"],
  technologist: ["worklist.view", "report.read", "study.import", "image.add", "image.register", "study.move", "study.match", "study.unmatch", "study.copy", "image.print"],
  staff: ["worklist.view", "report.read"],
};
// 표시 순서(조회→판독→출력→영상 관리→매칭) — 서버 permissions 목록을 이 순서로 정렬
const PERM_ORDER = [
  "worklist.view", "report.read", "report.write", "report.finalize", "report.confirm2",
  "report.print", "image.print", "study.import", "image.add", "image.register",
  "study.delete", "study.move", "study.copy", "study.match", "study.unmatch",
];
// 서버 관리용 권한(병원 등급 매트릭스와 무관)은 그리드에서 제외
const NON_CLINICAL = new Set(["users.manage", "hospitals.manage", "modalities.manage", "server.manage", "settings.global", "audit.view"]);
// 서버 미응답 시 폴백 라벨(계약의 신규 키 포함)
const PERM_LABELS: Record<string, string> = {
  "worklist.view": "워크리스트 조회", "report.read": "판독 조회", "report.write": "판독 작성·변경",
  "report.finalize": "판독 확정", "report.confirm2": "판독 2차 승인", "report.print": "판독 출력",
  "image.print": "영상 출력", "study.import": "검사 수신·등록", "image.add": "영상 추가",
  "image.register": "영상 등록", "study.delete": "영상 삭제", "study.move": "영상 이동",
  "study.copy": "영상 복제", "study.match": "오더 매칭", "study.unmatch": "언매칭",
};
const STAFF_VIEW_ONLY = new Set(["worklist.view", "report.read"]);

export function PermMatrixTab({ hid }: { hid: number }) {
  const [data, setData] = useState<PermMatrixResp | null>(null);
  const [matrix, setMatrix] = useState<Record<string, string[]>>({});
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState("");
  const load = () => api.permMatrix(hid)
    .then((r) => { setData(r); setMatrix(r.matrix); setDirty(false); setMsg(""); })
    .catch((e) => {
      // 백엔드(레인 B) 준비 전 — 계약 기본값으로 표시(저장 시 서버 필요)
      setData({
        roles: CLIENT_ROLES,
        permissions: PERM_ORDER.map((k) => ({ key: k, label: PERM_LABELS[k] ?? k })),
        matrix: DEFAULT_MATRIX,
      });
      setMatrix(DEFAULT_MATRIX);
      setDirty(false);
      setMsg(errMsg(e) + " (기본값 표시 중)");
    });
  useEffect(() => { load(); }, [hid]); // eslint-disable-line react-hooks/exhaustive-deps

  const perms = (data?.permissions ?? [])
    .filter((p) => !NON_CLINICAL.has(p.key))
    .sort((a, b) => {
      const ia = PERM_ORDER.indexOf(a.key); const ib = PERM_ORDER.indexOf(b.key);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  const roles = (data?.roles ?? []).filter((r) => r.key !== "admin");

  const has = (role: string, perm: string) => (matrix[role] ?? []).includes(perm);
  const toggle = (role: string, perm: string) => {
    const cur = new Set(matrix[role] ?? []);
    if (cur.has(perm)) cur.delete(perm);
    else {
      cur.add(perm);
      if (role === "staff" && !STAFF_VIEW_ONLY.has(perm)) {
        setMsg("⚠ 주의: 기타 의료인(Medician)은 검색·조회 전용이 원칙입니다 — 조회 외 권한 부여는 정책 예외입니다");
      }
    }
    setMatrix({ ...matrix, [role]: [...cur] });
    setDirty(true);
  };
  const save = async () => {
    try { const r = await api.putPermMatrix(hid, matrix); setData(r); setMatrix(r.matrix); setDirty(false); showToast("저장 되었습니다."); setMsg("저장됨 — 등급별 유효 권한에 즉시 반영"); }
    catch (e) { setMsg(errMsg(e)); }
  };
  const restore = () => { setMatrix(DEFAULT_MATRIX); setDirty(true); setMsg("기본값 적용됨 — [저장]을 눌러 반영하세요"); };

  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700 }}>🛡️ 등급별 권한 매트릭스 (병원별)</div>
        <div style={{ flex: 1 }} />
        <button onClick={restore}>기본값 복원</button>
        <button className="primary" onClick={save} disabled={!dirty}>저장</button>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="grid-table" style={{ fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ whiteSpace: "nowrap" }}>등급 ＼ 권한</th>
              {perms.map((p) => (
                <th key={p.key} title={p.key} style={{ whiteSpace: "nowrap" }}>{p.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.key}>
                <td style={{ whiteSpace: "nowrap", fontWeight: r.key === "staff" ? 400 : 600 }}>
                  {r.label}
                  {r.key === "staff" && <span title="조회 전용 원칙 — 조회 외 권한은 경고 후 부여 가능" style={{ marginLeft: 4 }}>🔒</span>}
                </td>
                {perms.map((p) => (
                  <td key={p.key} style={{ textAlign: "center" }}>
                    <input type="checkbox" checked={has(r.key, p.key)} onChange={() => toggle(r.key, p.key)}
                           title={`${r.label} — ${p.label}`} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
        행=등급(4종) · 열=권한. 🔒 기타 의료인(Medician)은 검색·조회 전용이 기본이며, 다른 권한을 체크하면 경고가 표시됩니다(편집은 가능).
        저장 시 이 병원 소속 계정의 유효 권한(/api/perm/me)에 반영됩니다.
      </div>
      <Msg text={msg} />
    </div>
  );
}

// ════════════════════════════ ③ Modality(SCP) 등록 ════════════════════════════
interface TestState { state: DotState; detail: string; at: string }

export function HospitalModalityTab({ hid }: { hid: number }) {
  const [items, setItems] = useState<ModalityNode[]>([]);
  const [tests, setTests] = useState<Record<number, TestState>>({});
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState("");
  const load = () => api.hospitalModalities(hid)
    .then((r) => { setItems(r.items); setTests({}); setDirty(false); })
    .catch((e) => setMsg(errMsg(e)));
  useEffect(() => { load(); }, [hid]); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (i: number, patch: Partial<ModalityNode>) => {
    setItems((prev) => prev.map((m, j) => (j === i ? { ...m, ...patch } : m)));
    setDirty(true);
  };
  const add = () => { setItems((p) => [...p, { name: "", ae_title: "", ip: "", port: 104, kind: "scp" }]); setDirty(true); };
  const del = (i: number) => {
    if (!confirm(`Modality '${items[i].name || items[i].ae_title || i + 1}' 삭제?`)) return;
    setItems((p) => p.filter((_, j) => j !== i));
    setTests({});
    setDirty(true);
  };
  const save = async () => {
    try { const r = await api.putHospitalModalities(hid, items); setItems(r.items); setDirty(false); showToast("저장 되었습니다."); setMsg("저장됨"); }
    catch (e) { setMsg(errMsg(e)); }
  };
  const test = async (i: number, mode: "ping" | "echo") => {
    const m = items[i];
    setTests((p) => ({ ...p, [i]: { state: "unknown", detail: `${mode.toUpperCase()} 확인 중…`, at: nowStr() } }));
    try {
      const r = await api.testHospitalModality(hid, { ip: m.ip, port: m.port, ae_title: m.ae_title || undefined, mode });
      setTests((p) => ({ ...p, [i]: { state: r.ok ? "ok" : "fail", detail: r.detail ?? (r.ok ? `${mode.toUpperCase()} 성공` : `${mode.toUpperCase()} 실패`), at: nowStr() } }));
    } catch (e) {
      setTests((p) => ({ ...p, [i]: { state: "fail", detail: (e as Error).message, at: nowStr() } }));
    }
  };

  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700 }}>📡 Modality 등록 (SCP — AE/IP/Port)</div>
        <div style={{ flex: 1 }} />
        <button onClick={add}>＋ 추가</button>
        <button className="primary" onClick={save} disabled={!dirty}>저장</button>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="grid-table" style={{ fontSize: 12.5 }}>
          <thead><tr><th>이름</th><th>AE Title</th><th>IP</th><th>Port</th><th>구분</th><th>연결 확인</th><th>상태</th><th></th></tr></thead>
          <tbody>
            {items.map((m, i) => {
              const t = tests[i];
              return (
                <tr key={i}>
                  <td><input style={{ ...inp, width: 110 }} value={m.name} onChange={(e) => edit(i, { name: e.target.value })} /></td>
                  <td><input style={{ ...inp, width: 110 }} value={m.ae_title} onChange={(e) => edit(i, { ae_title: e.target.value })} /></td>
                  <td><input style={{ ...inp, width: 120 }} value={m.ip} onChange={(e) => edit(i, { ip: e.target.value })} /></td>
                  <td><input style={{ ...inp, width: 70 }} type="number" value={m.port} onChange={(e) => edit(i, { port: Number(e.target.value) })} /></td>
                  <td>
                    <select style={{ ...inp, padding: "3px 6px" }} value={m.kind} onChange={(e) => edit(i, { kind: e.target.value as "scp" | "scu" })}>
                      <option value="scp">SCP</option>
                      <option value="scu">SCU</option>
                    </select>
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button onClick={() => test(i, "echo")} disabled={!m.ip}>Echo</button>{" "}
                    <button onClick={() => test(i, "ping")} disabled={!m.ip}>Ping</button>
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <Dot state={t?.state ?? "unknown"} title={t ? `${t.detail} (${t.at})` : "미확인"} />{" "}
                    <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{t ? `${t.at}` : "미확인"}</span>
                  </td>
                  <td><button onClick={() => del(i)}>삭제</button></td>
                </tr>
              );
            })}
            {items.length === 0 && <tr><td colSpan={8} style={{ color: "var(--text-secondary)" }}>등록된 Modality가 없습니다. [＋ 추가] 후 저장하세요.</td></tr>}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
        상태등: <Dot state="ok" /> 성공 · <Dot state="fail" /> 실패 · <Dot state="unknown" /> 미확인 (마우스 오버=상세·마지막 확인 시각).
        편집한 뒤 반드시 [저장]을 눌러 병원 설정(modality.nodes)에 반영하세요.
      </div>
      <Msg text={msg} />
    </div>
  );
}

// ════════════════════════════ ④ 병원 설정 (SCU/식별 전용) ════════════════════════════
export function ScuTab({ hid }: { hid: number }) {
  const [scu, setScu] = useState<HospitalScu | null>(null);
  const [msg, setMsg] = useState("");
  const load = () => api.hospitalScu(hid).then((r) => { setScu(r); setMsg(""); }).catch((e) => setMsg(errMsg(e)));
  useEffect(() => { load(); }, [hid]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!scu) return;
    try { const r = await api.putHospitalScu(hid, { ...scu, port: Number(scu.port) }); setScu(r); showToast("저장 되었습니다."); setMsg("저장됨 (병원명·AE는 병원 정보에도 반영)"); }
    catch (e) { setMsg(errMsg(e)); }
  };
  const row = (label: string, node: React.ReactNode) => (
    <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}>
      <span style={{ width: 120, color: "var(--text-secondary)", flexShrink: 0 }}>{label}</span>{node}</label>
  );
  if (!scu) return <div style={card}>{msg ? <Msg text={msg} /> : "불러오는 중…"}</div>;
  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 8, maxWidth: 520 }}>
      <div style={{ fontWeight: 700 }}>🏥 병원 설정 — SCU / 식별 정보</div>
      {row("병원명", <input style={{ ...inp, flex: 1 }} value={scu.name} onChange={(e) => setScu({ ...scu, name: e.target.value })} />)}
      {row("SCU AE Title", <input style={{ ...inp, flex: 1 }} value={scu.ae_title} onChange={(e) => setScu({ ...scu, ae_title: e.target.value })} />)}
      {row("IP", <input style={{ ...inp, flex: 1 }} value={scu.ip} onChange={(e) => setScu({ ...scu, ip: e.target.value })} placeholder="예: 10.0.0.12" />)}
      {row("Port", <input style={{ ...inp, width: 100 }} type="number" value={scu.port} onChange={(e) => setScu({ ...scu, port: Number(e.target.value) })} />)}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button className="primary" onClick={save}>저장</button>
        <button onClick={load}>다시 불러오기</button>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
        이 탭은 병원 SCU/식별 정보 전용입니다(병원 주소·수신 포트 등 나머지는 [병원 정보] 탭).
        병원명·AE Title은 병원 레코드에, IP/Port는 병원 설정(hospital.scu)에 저장됩니다.
      </div>
      <Msg text={msg} />
    </div>
  );
}

// ════════════════════════════ ⑤ 사용량 (DB·Storage) ════════════════════════════
const GAUGE_BASE_MB = 102400; // 게이지 기준 100GB — 시각 표시용(실사용량은 숫자로 병기)
export function UsageTab({ hid }: { hid: number }) {
  const [u, setU] = useState<HospitalUsage | null>(null);
  const [at, setAt] = useState("");
  const [msg, setMsg] = useState("");
  const load = () => api.hospitalUsage(hid)
    .then((r) => { setU(r); setAt(nowStr()); setMsg(""); })
    .catch((e) => setMsg(errMsg(e)));
  useEffect(() => { load(); }, [hid]); // eslint-disable-line react-hooks/exhaustive-deps

  const pct = u ? Math.min(100, (u.storage.disk_mb / GAUGE_BASE_MB) * 100) : 0;
  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ fontWeight: 700 }}>📊 병원별 사용량 (DB · Storage)</div>
        <div style={{ flex: 1 }} />
        {at && <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>{at} 기준</span>}
        <button onClick={load}>새로고침</button>
      </div>
      {!u ? <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{msg || "확인 중…"}</div> : (
        <>
          {!u.storage.orthanc_ok && (
            <div style={{ fontSize: 12, color: "var(--danger,#f87171)", border: "1px solid var(--danger,#f87171)", borderRadius: 4, padding: "6px 10px" }}>
              ⚠ DICOM 저장소(Orthanc) 연결 안 됨 — Storage 수치가 부정확할 수 있습니다
            </div>
          )}
          <div style={{ fontWeight: 600, fontSize: 12.5 }}>Database</div>
          <table className="grid-table" style={{ fontSize: 12.5, maxWidth: 480 }}><tbody>
            <tr><td>검사(studies)</td><td>{u.db.studies}</td></tr>
            <tr><td>판독(reports)</td><td>{u.db.reports}</td></tr>
            <tr><td>주석(annotations)</td><td>{u.db.annotations}</td></tr>
            <tr><td>합계 행</td><td>{u.db.studies + u.db.reports + u.db.annotations}</td></tr>
          </tbody></table>
          <div style={{ fontWeight: 600, fontSize: 12.5, marginTop: 4 }}>Storage</div>
          <div style={{ maxWidth: 480 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
              <span>디스크 사용 {u.storage.disk_mb.toLocaleString()} MB</span>
              <span style={{ color: "var(--text-secondary)" }}>인스턴스 {u.storage.instances.toLocaleString()}개</span>
            </div>
            <div title={`${u.storage.disk_mb.toLocaleString()} MB (게이지 기준 ${GAUGE_BASE_MB / 1024}GB)`}
                 style={{ height: 10, borderRadius: 5, background: "var(--bg-canvas)", border: "1px solid var(--border)", overflow: "hidden" }}>
              <div style={{ width: `${pct}%`, height: "100%", background: pct > 90 ? DOT_FAIL : DOT_OK, transition: "width .3s" }} />
            </div>
            <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 4 }}>
              게이지는 {GAUGE_BASE_MB / 1024}GB 기준 시각화입니다(초과 시 100%로 표시).
            </div>
          </div>
        </>
      )}
      <Msg text={msg} />
    </div>
  );
}

// ════════════════════════════ ⑥ 연결 대시보드 (Client + Modality) ════════════════════════════
export function ConnDashboardTab({ hid }: { hid: number }) {
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [mods, setMods] = useState<ModalityNode[]>([]);
  const [tests, setTests] = useState<Record<number, TestState>>({});
  const [testing, setTesting] = useState(false);
  const [at, setAt] = useState("");
  const [msg, setMsg] = useState("");
  const testingRef = useRef(false);

  const load = () => {
    api.clients(hid).then((r) => { setClients(r.items); setAt(nowStr()); }).catch((e) => setMsg(errMsg(e)));
    api.hospitalModalities(hid).then((r) => setMods(r.items)).catch(() => {});
  };
  // 30초 자동 폴링
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [hid]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { testingRef.current = false; }, [hid]);

  const testAll = async () => {
    if (testingRef.current) return;
    testingRef.current = true;
    setTesting(true);
    // 모달리티 순차 C-ECHO (동시 다발 대신 순차 — 장비 부하 방지)
    for (let i = 0; i < mods.length; i++) {
      if (!testingRef.current) break;
      const m = mods[i];
      if (!m.ip) { setTests((p) => ({ ...p, [i]: { state: "unknown", detail: "IP 미설정", at: nowStr() } })); continue; }
      setTests((p) => ({ ...p, [i]: { state: "unknown", detail: "ECHO 확인 중…", at: nowStr() } }));
      try {
        const r = await api.testHospitalModality(hid, { ip: m.ip, port: m.port, ae_title: m.ae_title || undefined, mode: "echo" });
        setTests((p) => ({ ...p, [i]: { state: r.ok ? "ok" : "fail", detail: r.detail ?? (r.ok ? "C-ECHO 성공" : "C-ECHO 실패"), at: nowStr() } }));
      } catch (e) {
        setTests((p) => ({ ...p, [i]: { state: "fail", detail: (e as Error).message, at: nowStr() } }));
      }
    }
    testingRef.current = false;
    setTesting(false);
  };

  const onlineCnt = clients.filter((c) => c.online).length;
  const okCnt = mods.filter((_, i) => tests[i]?.state === "ok").length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 700 }}>🔌 연결 대시보드</div>
          <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
            Client {onlineCnt}/{clients.length} 접속 · Modality {okCnt}/{mods.length} 확인 {at && `· ${at}`}
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={load}>새로고침</button>
          <button className="primary" onClick={testAll} disabled={testing || mods.length === 0}>
            {testing ? "테스트 중…" : "전체 테스트 (순차 Echo)"}
          </button>
        </div>

        <div style={{ fontWeight: 600, fontSize: 12.5 }}>Client (하트비트)</div>
        <div style={{ overflowX: "auto" }}>
        <table className="grid-table" style={{ fontSize: 12.5 }}>
          <thead><tr><th>상태</th><th>이름</th><th>등급</th><th>위치</th><th>마지막 하트비트</th></tr></thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id} style={{ opacity: c.enabled ? 1 : 0.5 }}>
                <td>
                  <Dot state={c.online ? "ok" : "fail"} title={c.online ? "온라인(하트비트 수신)" : `오프라인 — 마지막 ${fmtTime(c.last_seen)}`} />{" "}
                  {c.online ? "온라인" : "오프라인"}
                </td>
                <td>{c.name}</td><td>{roleLabel(c.role)}</td><td>{c.location || "—"}</td><td>{fmtTime(c.last_seen)}</td>
              </tr>
            ))}
            {clients.length === 0 && <tr><td colSpan={5} style={{ color: "var(--text-secondary)" }}>발급된 Client가 없습니다.</td></tr>}
          </tbody>
        </table>
        </div>

        <div style={{ fontWeight: 600, fontSize: 12.5, marginTop: 4 }}>Modality (마지막 Echo)</div>
        <div style={{ overflowX: "auto" }}>
        <table className="grid-table" style={{ fontSize: 12.5 }}>
          <thead><tr><th>상태</th><th>이름</th><th>AE Title</th><th>IP:Port</th><th>마지막 확인</th><th>결과</th></tr></thead>
          <tbody>
            {mods.map((m, i) => {
              const t = tests[i];
              return (
                <tr key={i}>
                  <td><Dot state={t?.state ?? "unknown"} title={t ? `${t.detail} (${t.at})` : "미확인 — [전체 테스트]로 확인"} /></td>
                  <td>{m.name || "—"}</td><td>{m.ae_title || "—"}</td><td>{m.ip}:{m.port}</td>
                  <td>{t?.at ?? "—"}</td>
                  <td style={{ color: t?.state === "fail" ? "var(--danger,#f87171)" : undefined }}>{t?.detail ?? "미확인"}</td>
                </tr>
              );
            })}
            {mods.length === 0 && <tr><td colSpan={6} style={{ color: "var(--text-secondary)" }}>등록된 Modality가 없습니다 — [③ Modality(SCP)]에서 등록하세요.</td></tr>}
          </tbody>
        </table>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
          Client 접속 상태는 30초 자동 갱신됩니다. Modality 상태등은 [전체 테스트](순차 C-ECHO) 결과 기준입니다.
        </div>
        <Msg text={msg} />
      </div>
    </div>
  );
}

// ════════════════════════════ ⑦ DB·영상 관리 (검사 관리 작업) ════════════════════════════
export function StudyAdminTab({ hid, hospitals }: { hid: number; hospitals: HospitalRow[] }) {
  const [items, setItems] = useState<StudyRow[]>([]);
  const [selId, setSelId] = useState<number | null>(null);
  const [targetHid, setTargetHid] = useState("");
  const [orderId, setOrderId] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const load = () => api.hospitalWorklist(hid)
    .then((r) => { setItems(r.items); setSelId((prev) => (r.items.some((s) => s.id === prev) ? prev : null)); })
    .catch((e) => setMsg(errMsg(e)));
  useEffect(() => { load(); }, [hid]); // eslint-disable-line react-hooks/exhaustive-deps

  const sel = items.find((s) => s.id === selId) ?? null;
  const others = hospitals.filter((h) => h.id !== hid);

  const run = async (action: StudyAdminActionKind) => {
    if (!sel) { setMsg("⚠ 먼저 목록에서 검사를 선택하세요"); return; }
    const label: Record<StudyAdminActionKind, string> = { delete: "삭제", move: "이동", match: "오더 매칭", unmatch: "언매칭", copy: "복제" };
    const body: { action: StudyAdminActionKind; target_hid?: number; order_id?: number | string } = { action };
    if (action === "move") {
      if (!targetHid) { setMsg("⚠ 대상 병원을 선택하세요"); return; }
      body.target_hid = Number(targetHid);
    }
    if (action === "copy" && targetHid) body.target_hid = Number(targetHid); // 미선택=같은 병원에 사본
    if (action === "match") {
      if (!orderId.trim()) { setMsg("⚠ 오더 ID를 입력하세요"); return; }
      const raw = orderId.trim();
      body.order_id = /^\d+$/.test(raw) ? Number(raw) : raw;
    }
    // 파괴적 작업(삭제·이동)은 2단계 확인
    const desc = `${sel.patient_name || sel.patient_key} · ${sel.modality} · ${sel.study_date} (${sel.study_desc || "—"})`;
    if (action === "delete" || action === "move") {
      const tgt = action === "move" ? ` → '${others.find((h) => h.id === Number(targetHid))?.name ?? targetHid}'` : "";
      if (!confirm(`[1/2] 검사 ${label[action]}${tgt}\n${desc}\n\n계속할까요?`)) return;
      if (!confirm(`[2/2] 최종 확인 — 이 작업은 ${action === "delete" ? "되돌릴 수 없습니다(영구 삭제)" : "검사 소속 병원을 변경합니다"}.\n정말 ${label[action]}할까요?`)) return;
    } else if (!confirm(`검사 ${label[action]}\n${desc}\n\n계속할까요?`)) return;
    setBusy(true);
    try {
      const r = await api.studyAdminAction(sel.id, body);
      setMsg(r.ok ? `${label[action]} 완료${r.detail ? ` — ${r.detail}` : ""}` : `⚠ ${r.detail ?? `${label[action]} 실패`}`);
      load();
    } catch (e) { setMsg(errMsg(e)); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ fontWeight: 700 }}>🗄️ DB·영상 관리 (검사 삭제·이동·매칭·복제)</div>
        <div style={{ flex: 1 }} />
        <button onClick={load}>새로고침</button>
      </div>
      <div style={{ maxHeight: 340, overflow: "auto", border: "1px solid var(--border)", borderRadius: 4 }}>
        <table className="grid-table" style={{ fontSize: 12 }}>
          <thead><tr><th></th><th>환자</th><th>ID</th><th>검사일</th><th>Mod</th><th>설명</th><th>시리즈/장수</th><th>판독</th></tr></thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id} onClick={() => setSelId(s.id)}
                  style={{ cursor: "pointer", background: selId === s.id ? "var(--accent-subtle)" : undefined }}>
                <td><input type="radio" name="sv-study-sel" checked={selId === s.id} onChange={() => setSelId(s.id)} /></td>
                <td>{s.patient_name || "—"}</td><td>{s.patient_key}</td><td>{s.study_date}</td>
                <td>{s.modality}</td><td>{s.study_desc || "—"}</td>
                <td>{s.series_count}/{s.instance_count}</td><td>{s.report_status ?? "—"}</td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={8} style={{ color: "var(--text-secondary)" }}>이 병원에 검사가 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          선택: {sel ? `${sel.patient_name || sel.patient_key} (${sel.modality} ${sel.study_date})` : "없음"}
        </span>
        <div style={{ flex: 1 }} />
        <button disabled={!sel || busy} onClick={() => run("delete")} style={{ color: "var(--danger,#f87171)" }}>삭제…</button>
        <select style={inp} value={targetHid} onChange={(e) => setTargetHid(e.target.value)}>
          <option value="">— 대상 병원 —</option>
          {others.map((h) => <option key={h.id} value={h.id}>{h.name || h.code}</option>)}
        </select>
        <button disabled={!sel || busy || !targetHid} onClick={() => run("move")}>이동…</button>
        <button disabled={!sel || busy} onClick={() => run("copy")}
                title="대상 병원 미선택 시 같은 병원에 사본 등록">복제</button>
        <input style={{ ...inp, width: 110 }} placeholder="오더 ID" value={orderId} onChange={(e) => setOrderId(e.target.value)} />
        <button disabled={!sel || busy || !orderId.trim()} onClick={() => run("match")}>매칭</button>
        <button disabled={!sel || busy} onClick={() => run("unmatch")}>언매칭</button>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
        삭제·이동은 2단계 확인을 거칩니다. 작업은 서버에서 유효 권한을 강제하며(403), 권한이 없으면 안내가 표시됩니다.
        이동은 [대상 병원] 선택 필수, 복제는 미선택 시 같은 병원에 사본, 매칭은 [오더 ID] 입력이 필요합니다.
        복제는 DB 사본이며 영상은 원본과 같은 저장소 검사를 공유합니다(원본 삭제 시 영상도 삭제될 수 있음).
      </div>
      <Msg text={msg} />
    </div>
  );
}

// ════════════════════════════ ⑧ 로그 · ⑨ 통계 · ⑩ 데이터 (병원별 — 서버 섹션과 동일 패널, hid 고정) ════════════════════════════
export function HospitalLogsTab({ hid }: { hid: number }) {
  return <LogsPanel hid={hid} />;
}
export function HospitalStatsTab({ hid }: { hid: number }) {
  return <StatsPanel hid={hid} />;
}
/** 병원별 데이터 관리 — 해당 병원만 지우기 + 백업 시점 복원 (동일 안전장치: 'WIPE' 확인 + 2단계 + dry 미리보기) */
export function HospitalDataTab({ hid, hospitals }: { hid: number; hospitals: HospitalRow[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <DataWipePanel hospitals={hospitals} fixedHid={hid} />
      <RestorePanel hospitals={hospitals} fixedHid={hid} />
    </div>
  );
}

// ════════════════════════════ ⑬ Exam Control (검사 QC — 병원 스코프 고정, 레인 F) ════════════════════════════
export function ExamControlTab({ hid }: { hid: number }) {
  return (
    <div style={{ height: "calc(100vh - 120px)", minHeight: 420, display: "flex", flexDirection: "column" }}>
      <ExamControl hid={hid} />
    </div>
  );
}

// ════════════════════════════ ⑭ 백업 (설정 내보내기·복원) ════════════════════════════
const BACKUP_CATS: { key: string; label: string; note?: string }[] = [
  { key: "hospital", label: "병원 정보", note: "이름·주소·연락처·라이선스" },
  { key: "network", label: "네트워크", note: "DICOM 노드·SCP설정·MWL·DDNS·원격판독" },
  { key: "modalities", label: "등록 장비 (SCP/SCU)", note: "AET·IP·Port·수신허용" },
  { key: "accounts", label: "계정·좌석", note: "⚠ 자격증명(해시·복원비번) 포함" },
  { key: "account_settings", label: "계정별 뷰어 설정", note: "툴·레이아웃·글자크기·행잉·워크리스트" },
  { key: "hospital_settings", label: "병원 설정", note: "권한 매트릭스·상용구·AI·모드 프로파일" },
];

export function BackupTab({ hid, hospitalName }: { hid: number; hospitalName: string }) {
  const [sel, setSel] = useState<Set<string>>(new Set(BACKUP_CATS.map((c) => c.key)));  // 기본 전체 선택
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const toggle = (k: string) => setSel((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const allOn = sel.size === BACKUP_CATS.length;

  const doExport = async () => {
    const items = BACKUP_CATS.filter((c) => sel.has(c.key)).map((c) => c.key);
    if (!items.length) return setMsg("백업할 항목을 하나 이상 선택하세요");
    setBusy(true); setMsg("");
    try {
      const b = await api.backupHospital(hid, items);
      const d = new Date(); const p = (n: number) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      const base = (hospitalName || b.meta.hospital || "backup").replace(/[\\/:*?"<>|\s]/g, "_");
      const fname = `${base}_${stamp}.json`;
      const url = URL.createObjectURL(new Blob([JSON.stringify(b, null, 2)], { type: "application/json" }));
      const a = document.createElement("a"); a.href = url; a.download = fname; a.click();
      URL.revokeObjectURL(url);
      setMsg(`백업 파일 다운로드: ${fname} (${items.length}개 항목)`);
    } catch (e) { setMsg(errMsg(e)); } finally { setBusy(false); }
  };

  const doImport = async (file: File) => {
    setBusy(true); setMsg("");
    try {
      const backup = JSON.parse(await file.text());
      const avail: string[] = Object.keys((backup && backup.data) || {});
      const items = BACKUP_CATS.filter((c) => sel.has(c.key) && avail.includes(c.key)).map((c) => c.key);
      if (!avail.length) { setMsg("백업 형식이 아닙니다(data 없음)"); return; }
      if (!items.length) { setMsg(`선택 항목이 이 백업에 없습니다. 백업 포함 항목: ${avail.join(", ")}`); return; }
      if (!confirm(`선택 항목(${items.join(", ")})을 '${hospitalName}' 로 복원(부활)합니다. 기존 값을 덮어씁니다. 계속할까요?`)) return;
      const r = await api.restoreHospital(hid, backup, items);
      setMsg(`복원 완료 — ${r.restored.join(", ")} (원본: ${backup?.meta?.hospital || "?"} / ${backup?.meta?.generated_at || "?"})`);
    } catch (e) { setMsg(errMsg(e)); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };

  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontWeight: 700 }}>💾 백업 (설정 내보내기 · 복원)</div>
      <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
        병원별·계정별 모든 설정을 항목 선택으로 JSON 백업하고, 업로드해 복원(부활)합니다.
        파일명은 <code>병원이름_날짜_시간.json</code>.
      </div>

      <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, fontWeight: 600 }}>
        <input type="checkbox" checked={allOn}
               onChange={() => setSel(allOn ? new Set() : new Set(BACKUP_CATS.map((c) => c.key)))} />
        전체 선택
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 8 }}>
        {BACKUP_CATS.map((c) => (
          <label key={c.key} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12.5,
                                      border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px",
                                      background: sel.has(c.key) ? "var(--accent-subtle, rgba(124,58,237,.08))" : "transparent" }}>
            <input type="checkbox" checked={sel.has(c.key)} onChange={() => toggle(c.key)} style={{ marginTop: 2 }} />
            <span>
              <div style={{ fontWeight: 600 }}>{c.label}</div>
              {c.note && <div style={{ color: "var(--text-secondary)", fontSize: 11, marginTop: 2 }}>{c.note}</div>}
            </span>
          </label>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button className="primary" onClick={doExport} disabled={busy}>⬇ 백업 (JSON 다운로드)</button>
        <button onClick={() => fileRef.current?.click()} disabled={busy}>⬆ 복원 (JSON 업로드)</button>
        <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: "none" }}
               onChange={(e) => { const f = e.target.files?.[0]; if (f) void doImport(f); }} />
      </div>
      <div style={{ fontSize: 11, color: "var(--stat-emergency,#f87171)" }}>
        ⚠ '계정·좌석' 항목은 로그인 자격증명(비번 해시·복원 평문)을 포함합니다. 백업 파일은 안전한 곳에 보관하세요.
      </div>
      <Msg text={msg} />
    </div>
  );
}


/* ── ⑮ 병원별 Storage — 서버 Storage 페이지의 병원 스코프 버전 ──
   현황(그 병원 검사·시리즈·인스턴스·백업 디스크) · 백업 정책(병원별 저장) · 수동 백업(그 병원만) ·
   백업 이력 · 보존 정책(미리보기 → confirm 삭제). */
export function HospitalStorageTab({ hid }: { hid: number }) {
  const [sum, setSum] = useState<Awaited<ReturnType<typeof api.hospStorageSummary>> | null>(null);
  const [pol, setPol] = useState({ enabled: false, schedule_time: "02:00", retention_days: 0,
                                   compression: "none", target_dir: "" });
  const [comps, setComps] = useState<{ key: string; label: string }[]>([]);
  const [jobs, setJobs] = useState<Awaited<ReturnType<typeof api.hospStorageJobs>>["items"]>([]);
  const [runComp, setRunComp] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [msg, setMsg] = useState("");
  const [fmt, setFmt] = useState({ format: "default", quality: 90, wado_ts: "" });   // 클라이언트 영상 전송 형식
  const [tsOpts, setTsOpts] = useState<{ uid: string; label: string; supported: boolean }[]>([]);

  const reload = useCallback(() => {
    api.hospStorageSummary(hid).then(setSum).catch(() => {});
    api.hospStorageJobs(hid).then((r) => setJobs(r.items)).catch(() => {});
  }, [hid]);
  useEffect(() => {
    reload();
    api.hospStoragePolicy(hid).then((p) => setPol(p)).catch(() => {});
    api.hospStorageCompressions(hid).then((r) => setComps(r.items)).catch(() => {});
    api.hospImageFormat(hid).then((f) => setFmt({ format: f.format, quality: f.quality, wado_ts: f.wado_ts ?? "" })).catch(() => {});
    api.hospImageFormatTsSupport(hid).then((r) => setTsOpts(r.options)).catch(() => {});
  }, [hid, reload]);

  const F: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 6, padding: 12, marginBottom: 14 };
  const L: React.CSSProperties = { width: 110, color: "var(--text-secondary)", fontSize: 12.5, flexShrink: 0 };
  const SRow = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
      <span style={L}>{label}</span>{children}
    </div>
  );
  const gb = (b: number | null) => (b == null ? "-" : (b / 1e9).toFixed(2) + " GB");

  return (
    <div style={{ maxWidth: 860 }}>
      <fieldset style={F}>
        <legend style={{ fontSize: 12.5, padding: "0 6px" }}>저장공간 현황
          <button style={{ marginLeft: 8, fontSize: 11 }} onClick={reload}>새로고침</button>
        </legend>
        {sum ? (
          <>
            <SRow label="이 병원 검사">검사 {sum.studies} · 시리즈 {sum.series} · 인스턴스 {sum.instances}</SRow>
            <SRow label="백업 대상 디스크">
              {(sum.disk.path || "-") + (sum.disk.free_gb != null ? " — 여유 " + sum.disk.free_gb + " GB / 전체 " + sum.disk.total_gb + " GB" : "")}
            </SRow>
            <SRow label="보존 정책">
              {sum.retention_days > 0
                ? sum.retention_days + "일 — 초과 " + sum.retention_over + "건(수동 삭제 대상)"
                : "미적용 (보존 기간 0)"}
            </SRow>
          </>
        ) : <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>로딩…</div>}
      </fieldset>

      <fieldset style={F}>
        <legend style={{ fontSize: 12.5, padding: "0 6px" }}>클라이언트 영상 전송 형식 (뷰어 화질)</legend>
        <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginBottom: 8 }}>
          이 병원의 뷰어가 영상을 불러올 때의 표시 형식입니다(원본 DICOM 은 영향 없음). 원격·저대역 환경은 품질을 낮춰 전송 속도를 높이고(50≈품질90 대비 40% 용량), 진단실은 100으로 최고 화질을 쓸 수 있습니다.
        </div>
        <SRow label="형식">
          <select value={fmt.format} onChange={(e) => setFmt((p2) => ({ ...p2, format: e.target.value }))}>
            <option value="default">기본 (JPEG 품질 90)</option>
            <option value="jpeg">JPEG 품질 지정 (50~100)</option>
          </select>
        </SRow>
        {fmt.format === "jpeg" && (
          <SRow label="JPEG 품질">
            <input type="range" min={50} max={100} step={5} value={fmt.quality}
                   onChange={(e) => setFmt((p2) => ({ ...p2, quality: Number(e.target.value) }))} />
            <b style={{ width: 40 }}>{fmt.quality}</b>
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>50=고압축(빠름) ~ 100=최고화질</span>
          </SRow>
        )}
        <SRow label="원본 픽셀 전송구문">
          <select value={fmt.wado_ts} style={{ minWidth: 260 }}
                  onChange={(e) => setFmt((p2) => ({ ...p2, wado_ts: e.target.value }))}>
            {tsOpts.map((o) => (
              <option key={o.uid} value={o.uid} disabled={!o.supported}>
                {o.label}{o.supported ? "" : " — 서버 Orthanc 미지원"}
              </option>
            ))}
          </select>
        </SRow>
        <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 8 }}>
          3D·볼륨 뷰어가 원본 픽셀(16bit)을 받을 때의 압축 전송구문입니다. HTJ2K 는 디코딩이 10배+ 빠르고
          16bit 를 유지해 판독용에 최적 — 서버 Orthanc 가 지원하면 자동 활성화됩니다(미지원 항목은 비활성 표시).
        </div>
        <button className="primary" style={{ fontSize: 12 }}
                onClick={async () => {
                  try { await api.hospImageFormatPut(hid, fmt); showToast("저장 되었습니다."); setMsg("전송 형식 저장됨 — 뷰어 재접속/새로고침 시 적용"); }
                  catch (e) { setMsg(e instanceof Error ? e.message : "저장 실패"); }
                }}>형식 저장</button>
      </fieldset>

      <fieldset style={F}>
        <legend style={{ fontSize: 12.5, padding: "0 6px" }}>백업 정책 (병원별 — 스케줄·보존·압축)</legend>
        <SRow label="자동 백업">
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
            <input type="checkbox" checked={pol.enabled}
                   onChange={(e) => setPol((p) => ({ ...p, enabled: e.target.checked }))} />
            매일 예정 시각에 스케줄 백업
          </label>
        </SRow>
        <SRow label="예정 시각">
          <input type="time" value={pol.schedule_time}
                 onChange={(e) => setPol((p) => ({ ...p, schedule_time: e.target.value }))} />
        </SRow>
        <SRow label="보존 기간">
          <input type="number" min={0} value={pol.retention_days} style={{ width: 90 }}
                 onChange={(e) => setPol((p) => ({ ...p, retention_days: Number(e.target.value) || 0 }))} />
          <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>일 (0=무제한, 초과분은 수동 삭제 대상)</span>
        </SRow>
        <SRow label="압축 포맷">
          <select value={pol.compression} onChange={(e) => setPol((p) => ({ ...p, compression: e.target.value }))}>
            {comps.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </SRow>
        <SRow label="백업 경로">
          <input value={pol.target_dir} placeholder="비우면 backend/backup" style={{ flex: 1 }}
                 onChange={(e) => setPol((p) => ({ ...p, target_dir: e.target.value }))} />
        </SRow>
        <button className="primary" style={{ fontSize: 12 }}
                onClick={async () => {
                  try { await api.hospStoragePolicyPut(hid, pol); showToast("저장 되었습니다."); setMsg("정책 저장됨"); reload(); }
                  catch (e) { setMsg(e instanceof Error ? e.message : "저장 실패"); }
                }}>정책 저장</button>
      </fieldset>

      <fieldset style={F}>
        <legend style={{ fontSize: 12.5, padding: "0 6px" }}>수동 백업 실행 (이 병원 검사만)</legend>
        <SRow label="압축">
          <select value={runComp} onChange={(e) => setRunComp(e.target.value)}>
            <option value="">(정책값)</option>
            {comps.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </SRow>
        <SRow label="검사일 범위">
          <input placeholder="YYYYMMDD" value={from} style={{ width: 110 }} onChange={(e) => setFrom(e.target.value)} />
          <span>~</span>
          <input placeholder="YYYYMMDD" value={to} style={{ width: 110 }} onChange={(e) => setTo(e.target.value)} />
          <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>비우면 전체</span>
        </SRow>
        <button className="primary" style={{ fontSize: 12 }}
                onClick={async () => {
                  try {
                    await api.hospStorageBackup(hid, { compression: runComp, date_from: from, date_to: to });
                    setMsg("백업 시작됨 — 이력에서 진행 상태 확인");
                    window.setTimeout(reload, 1500);
                  } catch (e) { setMsg(e instanceof Error ? e.message : "백업 실패"); }
                }}>백업 시작</button>
      </fieldset>

      <fieldset style={F}>
        <legend style={{ fontSize: 12.5, padding: "0 6px" }}>백업 이력
          <button style={{ marginLeft: 8, fontSize: 11 }} onClick={reload}>새로고침</button>
        </legend>
        <table style={{ width: "100%", fontSize: 11.5, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ color: "var(--text-secondary)", textAlign: "left" }}>
              <th style={{ padding: 4 }}>#</th><th>상태</th><th>압축</th><th>검사</th><th>인스턴스</th><th>용량</th><th>완료</th>
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 && <tr><td colSpan={7} style={{ padding: 8, color: "var(--text-secondary)" }}>백업 이력이 없습니다.</td></tr>}
            {jobs.map((j) => (
              <tr key={j.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: 4 }}>{j.id}</td>
                <td style={{ color: j.status === "done" ? "#4ade80" : j.status === "error" ? "var(--stat-emergency)" : undefined }}>
                  {j.status}{j.error ? " (" + j.error.slice(0, 40) + ")" : ""}</td>
                <td>{j.compression}</td>
                <td>{j.study_count ?? "-"}</td>
                <td>{j.instance_count ?? "-"}</td>
                <td>{gb(j.total_bytes)}</td>
                <td>{j.finished_at ? j.finished_at.slice(0, 16).replace("T", " ") : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </fieldset>

      <fieldset style={F}>
        <legend style={{ fontSize: 12.5, padding: "0 6px" }}>보존 정책 — 기간 초과 검사 삭제 (파괴적 · 이 병원만)</legend>
        <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginBottom: 8 }}>
          보존 기간({pol.retention_days}일)을 초과한 이 병원 검사를 Orthanc·DB에서 영구 삭제합니다. 미리보기 후 확인 절차를 거치며, 자동 삭제는 하지 않습니다.
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={{ fontSize: 12 }}
                  onClick={async () => {
                    try {
                      const r = await api.hospStoragePurgePreview(hid, pol.retention_days);
                      setMsg("초과 " + r.count + "건 — " + r.items.slice(0, 5).map((x) => x.study_date + " " + x.modality).join(", ") + (r.count > 5 ? " …" : ""));
                    } catch (e) { setMsg(e instanceof Error ? e.message : "미리보기 실패"); }
                  }}>미리보기</button>
          <button style={{ fontSize: 12, color: "var(--stat-emergency)" }}
                  onClick={async () => {
                    if (!window.confirm("보존 " + pol.retention_days + "일 초과 검사를 영구 삭제할까요? (되돌릴 수 없음 — 백업 먼저 권장)")) return;
                    try {
                      const r = await api.hospStoragePurge(hid, pol.retention_days);
                      setMsg("삭제 완료 — DB " + r.deleted + "건 · Orthanc " + r.orthanc_removed + "건");
                      reload();
                    } catch (e) { setMsg(e instanceof Error ? e.message : "삭제 실패"); }
                  }}>초과분 삭제…</button>
        </div>
      </fieldset>
      {msg && <div style={{ fontSize: 12, color: "var(--ai)", marginTop: 4 }}>{msg}</div>}
    </div>
  );
}
