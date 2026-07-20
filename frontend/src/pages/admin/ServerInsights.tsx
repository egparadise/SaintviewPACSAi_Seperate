// 서버 인사이트 패널(레인 F) — ⑥DB 구조 ⑦가입 환경 설정 ⑧관리자 계정 ⑨시스템 로그 ⑩사용량 통계 ⑪AI 등록
// 백엔드 계약(/api/insights/*, settings 키)은 레인 B가 병렬 구현 — 미구현 응답은 '⚠ 준비 중' 우아 처리.
import { useEffect, useRef, useState } from "react";
import { showToast } from "../../lib/toast";
import {
  api, downloadLogsCsv, downloadStatsXlsx, sttStatus, sttTranscribe,
  type AiProvider, type DbSchemaResp, type LogItem,
  type SignupFieldDef, type SignupFieldsCfg, type SttStatus, type StatsResp, type StatsRow,
} from "../../api";
import { UsersPanel } from "./ServerAdmin";
import { pendMsg } from "./ServerMaintenance";
import { MicIcon } from "../../components/MicIcon";

// ── 공통 소형 UI (기존 관리 콘솔 다크 테마·표 스타일 유지) ──
const card: React.CSSProperties = { background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8, padding: 14 };
const inp: React.CSSProperties = {
  background: "var(--bg-canvas)", color: "var(--text-primary)",
  border: "1px solid var(--border)", borderRadius: 4, padding: "5px 8px", fontSize: 12.5, minWidth: 0,
};
function Msg({ text }: { text: string }) {
  if (!text) return null;
  return <div style={{ fontSize: 12, color: text.startsWith("⚠") ? "var(--danger,#f87171)" : "var(--accent,#7dd3fc)" }}>{text}</div>;
}

// ════════════════════════════ ⑥ DB 구조 (read-only introspection + DB 도구 열기) ════════════════════════════
export function DbSchemaPanel() {
  const [schema, setSchema] = useState<DbSchemaResp | null>(null);
  const [selTable, setSelTable] = useState<string | null>(null);
  const [toolPath, setToolPath] = useState("");
  const [toolHint, setToolHint] = useState("");   // 기본값 제안 출처(자동 탐지된 도구명)
  const [pickerOpen, setPickerOpen] = useState(false);
  const [msg, setMsg] = useState("");
  const load = () => {
    api.insightsDbSchema().then((r) => { setSchema(r); setMsg(""); }).catch((e) => setMsg(pendMsg(e)));
    // 항상 초기 기본 정보 표시 — 저장된 경로가 있으면 그 값, 없으면 서버에 설치된 DB 도구 자동 탐지 제안
    api.getSetting("server.dbtool").then((r) => {
      const saved = String((r.value as { path?: string }).path ?? "");
      if (saved) { setToolPath(saved); return; }
      api.insightsDbToolDetect().then((d) => {
        if (d.items.length) {
          setToolPath(d.items[0].path);
          setToolHint(`자동 탐지 기본값: ${d.items[0].label} — [경로 저장]을 눌러 확정하세요`);
        }
      }).catch(() => {});
    }).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const saveTool = async () => {
    try { await api.putSetting("server.dbtool", { path: toolPath }, "global"); showToast("저장 되었습니다."); setMsg("DB 도구 경로 저장됨"); }
    catch (e) { setMsg(pendMsg(e)); }
  };
  const openTool = async () => {
    try { const r = await api.insightsDbToolOpen(); setMsg(r.ok ? `DB 도구 실행됨 (서버측)${r.detail ? ` — ${r.detail}` : ""}` : `⚠ ${r.detail ?? "실행 실패"}`); }
    catch (e) { setMsg(pendMsg(e)); }
  };

  const sel = schema?.tables.find((t) => t.name === selTable) ?? null;
  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ fontWeight: 700 }}>🗄️ DB 구조 (읽기 전용)</div>
        <div style={{ flex: 1 }} />
        <button onClick={load}>새로고침</button>
      </div>

      {!schema ? <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{msg || "확인 중…"}</div> : (
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          {/* 테이블 트리 */}
          <div style={{ width: 220, flexShrink: 0, border: "1px solid var(--border)", borderRadius: 4, maxHeight: 380, overflow: "auto" }}>
            {schema.tables.map((t) => (
              <div key={t.name} onClick={() => setSelTable(t.name)}
                   style={{ padding: "5px 10px", cursor: "pointer", fontSize: 12.5, display: "flex", justifyContent: "space-between",
                            background: selTable === t.name ? "var(--accent-subtle)" : undefined }}>
                <span>▦ {t.name}</span>
                <span style={{ color: "var(--text-secondary)", fontSize: 11.5 }}>{t.rows.toLocaleString()}행</span>
              </div>
            ))}
            {schema.tables.length === 0 && <div style={{ padding: 10, fontSize: 12, color: "var(--text-secondary)" }}>테이블이 없습니다.</div>}
          </div>
          {/* 컬럼 상세 */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {sel ? (
              <>
                <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>{sel.name} — {sel.rows.toLocaleString()}행 · 컬럼 {sel.columns.length}개</div>
                {/* 표가 카드 폭을 넘으면 가로 스크롤 — 내용이 상자 밖으로 튀어나오지 않게 */}
                <div style={{ overflowX: "auto" }}>
                <table className="grid-table" style={{ fontSize: 12 }}>
                  <thead><tr><th>컬럼</th><th>타입</th></tr></thead>
                  <tbody>{sel.columns.map((c) => <tr key={c.name}><td>{c.name}</td><td><code style={{ fontSize: 11.5 }}>{c.type}</code></td></tr>)}</tbody>
                </table>
                </div>
              </>
            ) : <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>좌측에서 테이블을 선택하면 컬럼·행수를 표시합니다.</div>}
          </div>
        </div>
      )}

      {/* DB 도구 열기 — server.dbtool(path). 초기값=저장 경로 또는 자동 탐지 기본값, [찾기]=서버 파일 탐색 */}
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "var(--text-secondary)", flexShrink: 0 }}>DB 도구 경로(서버측)</span>
        <input style={{ ...inp, flex: 1, minWidth: 220 }} value={toolPath} onChange={(e) => { setToolPath(e.target.value); setToolHint(""); }}
               placeholder="예: C:\\Program Files\\DB Browser for SQLite\\DB Browser for SQLite.exe" />
        <button onClick={() => setPickerOpen(true)} title="서버 컴퓨터의 파일 탐색기로 실행 파일(.exe)을 선택합니다">찾기…</button>
        <button onClick={saveTool}>경로 저장</button>
        <button className="primary" onClick={openTool}>DB 도구 열기</button>
      </div>
      {toolHint && <div style={{ fontSize: 11, color: "var(--accent)" }}>{toolHint}</div>}
      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
        구조 조회는 읽기 전용(introspection)입니다. [DB 도구 열기]는 서버 컴퓨터에서 설정된 외부 프로그램을 실행합니다(원격 브라우저에는 표시되지 않음).
      </div>
      <Msg text={msg} />
      {pickerOpen && (
        <ExePickerModal
          initial={toolPath}
          onPick={(p) => { setToolPath(p); setToolHint(""); setPickerOpen(false); setMsg("경로 선택됨 — [경로 저장]을 눌러 확정하세요"); }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

/** 서버측 실행 파일(.exe) 선택 모달 — /api/share/fs(files=exe) 기반 파일 탐색기.
 *  폴더 클릭=진입, 파일 클릭=선택(입력 반영). 저장은 [경로 저장] 버튼으로 확정. */
function ExePickerModal({ initial, onPick, onClose }: {
  initial: string; onPick: (path: string) => void; onClose: () => void;
}) {
  const [path, setPath] = useState("");
  const [parent, setParent] = useState<string | null>(null);
  const [dirs, setDirs] = useState<{ name: string; path: string }[]>([]);
  const [files, setFiles] = useState<{ name: string; path: string }[]>([]);
  const [picked, setPicked] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const nav = (p: string) => {
    setLoading(true); setErr("");
    api.shareFs(p, "exe").then((r) => {
      setPath(r.path); setParent(r.parent); setDirs(r.dirs); setFiles(r.files ?? []); setLoading(false);
      if (!r.exists) setErr("경로가 존재하지 않습니다");
    }).catch((e) => { setErr(e instanceof Error ? e.message : "탐색 실패"); setLoading(false); });
  };
  useEffect(() => {
    // 초기 경로: 입력값의 폴더 → 없으면 드라이브 목록
    const dir = initial.includes("\\") ? initial.slice(0, initial.lastIndexOf("\\")) : "";
    nav(dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "grid", placeItems: "center", zIndex: 400 }}>
      <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8,
                    width: "min(520px, 92vw)", height: "min(480px, 82vh)", display: "flex",
                    flexDirection: "column", padding: 12, gap: 8 }}>
        <b style={{ fontSize: 13 }}>🗄️ DB 도구 실행 파일 선택 (서버 컴퓨터)</b>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button onClick={() => nav(parent ?? "")} disabled={!path}
                  title={parent ? "상위 폴더로" : "드라이브 목록으로"} style={{ padding: "2px 8px", fontSize: 12 }}>⬆ 상위</button>
          <code title={path} style={{ flex: 1, fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {path || "(드라이브를 선택하세요)"}
          </code>
        </div>
        {err && <div style={{ fontSize: 11.5, color: "var(--stat-emergency,#f87171)" }}>{err}</div>}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 4 }}>
          {loading ? (
            <div style={{ padding: 10, fontSize: 12, color: "var(--text-secondary)" }}>불러오는 중…</div>
          ) : (
            <>
              {dirs.map((d) => (
                <div key={d.path} onClick={() => nav(d.path)} title={d.path}
                     style={{ padding: "4px 10px", fontSize: 12.5, cursor: "pointer", display: "flex", gap: 6 }}>
                  📁 <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</span>
                </div>
              ))}
              {files.map((f) => (
                <div key={f.path} onClick={() => setPicked(f.path)} title={f.path}
                     style={{ padding: "4px 10px", fontSize: 12.5, cursor: "pointer", display: "flex", gap: 6,
                              background: picked === f.path ? "var(--accent-subtle)" : undefined }}>
                  ⚙ <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                </div>
              ))}
              {dirs.length === 0 && files.length === 0 && (
                <div style={{ padding: 10, fontSize: 12, color: "var(--text-secondary)" }}>하위 폴더·실행 파일 없음</div>
              )}
            </>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", alignItems: "center" }}>
          <span style={{ marginRight: "auto", fontSize: 10.5, color: "var(--text-secondary)" }}>
            .exe 클릭으로 선택 — [이 파일 선택] 후 [경로 저장]으로 확정
          </span>
          <button onClick={onClose} style={{ fontSize: 12 }}>취소</button>
          <button className="primary" disabled={!picked} onClick={() => onPick(picked)} style={{ fontSize: 12 }}>이 파일 선택</button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════ ⑦ 가입 환경 설정 (병원/Client/Modality 입력 항목) ════════════════════════════
type SignupKind = "hospital" | "client" | "modality";
const SIGNUP_KINDS: { kind: SignupKind; title: string }[] = [
  { kind: "hospital", title: "병원 (가입 화면)" },
  { kind: "client", title: "Client (계정 발급)" },
  { kind: "modality", title: "Modality (장비 등록)" },
];
// 기본 필드 정의 — 잠금(locked) 필드는 표시 해제 불가
export const DEFAULT_SIGNUP_FIELDS: Record<SignupKind, SignupFieldDef[]> = {
  hospital: [
    { key: "name", label: "병원 이름", enabled: true, required: true },
    { key: "address", label: "주소", enabled: true, required: false },
    { key: "departments", label: "진료과", enabled: true, required: false },
    { key: "phone", label: "연락처", enabled: true, required: false },
    { key: "fax", label: "Fax", enabled: true, required: false },
    { key: "homepage", label: "홈페이지", enabled: true, required: false },
    { key: "license_clients", label: "License(Client 수)", enabled: true, required: false },
    { key: "modality_limit", label: "Modality 수", enabled: true, required: false },
  ],
  client: [
    { key: "name", label: "계정(좌석) 이름", enabled: true, required: true },
    { key: "location", label: "위치", enabled: true, required: false },
    { key: "role", label: "등급", enabled: true, required: false },
  ],
  modality: [
    { key: "name", label: "장비 이름", enabled: true, required: true },
    { key: "ae_title", label: "AE Title", enabled: true, required: true },
    { key: "host", label: "IP/호스트", enabled: true, required: false },
    { key: "port", label: "Port", enabled: true, required: false },
    { key: "modality_type", label: "종류(CT/MR…)", enabled: true, required: false },
    { key: "manufacturer", label: "제조사", enabled: true, required: false },
  ],
};
const LOCKED_FIELD_KEYS = new Set(["name", "ae_title"]); // 기본 필드 잠금

function SignupFieldsSection({ kind, title }: { kind: SignupKind; title: string }) {
  const [fields, setFields] = useState<SignupFieldDef[]>(DEFAULT_SIGNUP_FIELDS[kind]);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    api.getSetting(`signup.fields.${kind}`)
      .then((r) => {
        const v = r.value as unknown as SignupFieldsCfg;
        if (v && Array.isArray(v.fields) && v.fields.length > 0) setFields(v.fields);
      })
      .catch(() => {}); // 미설정=기본값 그대로
  }, [kind]);

  const edit = (i: number, patch: Partial<SignupFieldDef>) => {
    setFields((p) => p.map((f, j) => (j === i ? { ...f, ...patch } : f)));
    setDirty(true);
  };
  const save = async () => {
    try {
      await api.putSetting(`signup.fields.${kind}`, { fields } as unknown as Record<string, unknown>, "global");
      setDirty(false); showToast("저장 되었습니다."); setMsg("저장됨");
    } catch (e) { setMsg(pendMsg(e)); }
  };
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 12.5 }}>{title}</div>
        <div style={{ flex: 1 }} />
        <button className="primary" onClick={save} disabled={!dirty}>저장</button>
      </div>
      <table className="grid-table" style={{ fontSize: 12.5 }}>
        <thead><tr><th>입력 항목</th><th style={{ textAlign: "center" }}>표시</th><th style={{ textAlign: "center" }}>필수</th></tr></thead>
        <tbody>
          {fields.map((f, i) => {
            const locked = LOCKED_FIELD_KEYS.has(f.key);
            return (
              <tr key={f.key}>
                <td>{f.label} {locked && <span title="기본 필드 — 표시 해제 불가" style={{ fontSize: 11 }}>🔒</span>}</td>
                <td style={{ textAlign: "center" }}>
                  <input type="checkbox" checked={f.enabled} disabled={locked}
                         onChange={(e) => edit(i, { enabled: e.target.checked, ...(e.target.checked ? {} : { required: false }) })} />
                </td>
                <td style={{ textAlign: "center" }}>
                  <input type="checkbox" checked={f.required} disabled={locked || !f.enabled}
                         onChange={(e) => edit(i, { required: e.target.checked })} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Msg text={msg} />
    </div>
  );
}

export function SignupFieldsPanel() {
  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontWeight: 700 }}>📝 가입 환경 설정 — 입력 항목 (병원 / Client / Modality)</div>
      <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
        각 등록 화면에 표시할 입력 항목과 필수 여부를 설정합니다. 🔒 기본 필드는 표시 해제할 수 없습니다.
        미설정 시 화면은 기존 기본 폼을 그대로 사용합니다.
      </div>
      {SIGNUP_KINDS.map((s) => <SignupFieldsSection key={s.kind} kind={s.kind} title={s.title} />)}
    </div>
  );
}

// ════════════════════════════ ⑧ 관리자 계정 (빠른 등록 + 기존 사용자 관리) ════════════════════════════
export function AdminAccountsPanel() {
  const [f, setF] = useState({ username: "", password: "", display_name: "", email: "" });
  const [msg, setMsg] = useState("");
  const [refresh, setRefresh] = useState(0); // UsersPanel 재마운트용
  const create = async () => {
    if (!f.username.trim()) { setMsg("⚠ 아이디를 입력하세요"); return; }
    if (f.password.length < 8) { setMsg("⚠ 비밀번호는 8자 이상이어야 합니다"); return; }
    try {
      await api.createAccount({
        username: f.username.trim(), password: f.password, role: "admin", hospital_id: null,
        display_name: f.display_name, email: f.email, enabled: true,
      });
      setMsg(`관리자 계정 '${f.username.trim()}' 등록됨`);
      setF({ username: "", password: "", display_name: "", email: "" });
      setRefresh((n) => n + 1);
    } catch (e) { setMsg(pendMsg(e)); }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontWeight: 700 }}>🛡️ 관리자 계정 등록 (전역 admin)</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input style={{ ...inp, width: 130 }} placeholder="아이디*" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />
          <input style={{ ...inp, width: 150 }} type="password" placeholder="비밀번호* (8자+)" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
          <input style={{ ...inp, width: 120 }} placeholder="표시 이름" value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} />
          <input style={{ ...inp, width: 170 }} placeholder="이메일" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          <button className="primary" onClick={create}>＋ 관리자 등록</button>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
          역할 admin · 소속 전역(공용)으로 즉시 생성합니다. 병원 소속 관리자·역할 변경 등 세부 편집은 아래 [계정/역할 관리]에서.
        </div>
        <Msg text={msg} />
      </div>
      <UsersPanel key={refresh} />
    </div>
  );
}

// ════════════════════════════ ⑨ 시스템 로그 (event/network/dicom · 기간 · 검색 · CSV) ════════════════════════════
const LOG_TYPES: { key: string; label: string }[] = [
  { key: "event", label: "이벤트" },
  { key: "network", label: "네트워크" },
  { key: "dicom", label: "DICOM" },
];
/** 로그 상세(객체) → 표시 문자열 — 백엔드 detail 은 dict(JSON) (객체를 JSX 에 직접 넣으면 React 오류) */
function fmtLogDetail(detail: Record<string, unknown> | null | undefined): string {
  if (!detail || typeof detail !== "object") return String(detail ?? "");
  const s = Object.entries(detail)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
  return s.length > 300 ? s.slice(0, 300) + "…" : s;
}
export function LogsPanel({ hid }: { hid?: number }) {
  const [type, setType] = useState("event");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<LogItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const params = (): Record<string, string> => ({
    type,
    ...(dateFrom ? { date_from: dateFrom } : {}),
    ...(dateTo ? { date_to: dateTo } : {}),
    ...(q.trim() ? { q: q.trim() } : {}),
    ...(hid ? { hid: String(hid) } : {}),
    limit: "300",
  });
  const load = async () => {
    setBusy(true);
    try { const r = await api.insightsLogs(params()); setItems(r.items); setMsg(""); }
    catch (e) { setItems([]); setMsg(pendMsg(e)); }
    finally { setBusy(false); }
  };
  useEffect(() => { load(); }, [type, hid]); // eslint-disable-line react-hooks/exhaustive-deps

  const csv = async () => {
    // CSV 는 화면 표시 한도(300)와 달리 백엔드 최대치(2000)로 받는다 — "전체는 CSV" 안내와 일치
    try { await downloadLogsCsv({ ...params(), limit: "2000" }); }
    catch (e) { setMsg(pendMsg(e)); }
  };

  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700 }}>📜 시스템 로그{hid ? " (이 병원)" : ""}</div>
        {/* type 탭 */}
        <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
          {LOG_TYPES.map((t) => (
            <div key={t.key} onClick={() => setType(t.key)}
                 style={{ padding: "4px 12px", fontSize: 12, cursor: "pointer",
                          background: type === t.key ? "var(--accent-subtle)" : undefined,
                          color: type === t.key ? "var(--text-primary)" : "var(--text-secondary)" }}>
              {t.label}
            </div>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <input style={{ ...inp, width: 130 }} type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} title="시작일" />
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>~</span>
        <input style={{ ...inp, width: 130 }} type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} title="종료일" />
        <input style={{ ...inp, width: 150 }} placeholder="검색어" value={q} onChange={(e) => setQ(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && load()} />
        <button onClick={load} disabled={busy}>{busy ? "조회 중…" : "조회"}</button>
        <button onClick={csv} title="현재 필터 조건 그대로 CSV 다운로드">CSV 다운로드</button>
      </div>
      <div style={{ maxHeight: 420, overflow: "auto", border: "1px solid var(--border)", borderRadius: 4 }}>
        <table className="grid-table" style={{ fontSize: 12 }}>
          <thead><tr><th>시각</th><th>종류</th><th>사용자</th>{!hid && <th>병원</th>}<th>동작</th><th>상세</th></tr></thead>
          <tbody>
            {items.map((l, i) => (
              <tr key={i}>
                <td style={{ whiteSpace: "nowrap" }}>{l.ts?.replace("T", " ").slice(0, 19)}</td>
                <td>{l.type}</td><td>{l.actor || "—"}</td>
                {!hid && <td>{l.hospital_id ?? "—"}</td>}
                <td>{l.action}</td>
                <td style={{ color: "var(--text-secondary)" }}>{fmtLogDetail(l.detail)}</td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={hid ? 5 : 6} style={{ color: "var(--text-secondary)" }}>{busy ? "조회 중…" : "로그가 없습니다."}</td></tr>}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
        이벤트(로그인·설정·파괴 작업 감사) / 네트워크(접속·Echo) / DICOM(수신·전송) — 최대 300건 표시, 전체는 [CSV 다운로드].
      </div>
      <Msg text={msg} />
    </div>
  );
}

// ════════════════════════════ ⑩ 사용량 통계 (병원/장비/진료과/판독 · 기간 · 간이 막대) ════════════════════════════
const STAT_GROUPS: { key: string; label: string }[] = [
  { key: "hospital", label: "병원별" },
  { key: "modality", label: "장비(Modality)별" },
  { key: "department", label: "진료과별" },
  { key: "report_status", label: "판독·미판독" },
];

// ── 순수 SVG 차트 (외부 라이브러리 없음 — 다크 테마 var(--accent) 계열 + 구분 색) ──
const CHART_COLORS = [
  "#7dd3fc", "#a78bfa", "#34d399", "#fbbf24", "#fb7185", "#60a5fa",
  "#f472b6", "#4ade80", "#fb923c", "#22d3ee", "#c084fc", "#facc15", "#94a3b8",
];
/** 축 상한을 보기 좋은 값(1·2·2.5·5×10^k)으로 올림 */
function niceCeil(v: number): number {
  if (v <= 4) return Math.max(1, Math.ceil(v));
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= v) return m * mag;
  return 10 * mag;
}
/** 행이 많으면(병원별 등) 검사 수 상위 12 + 나머지는 '기타'로 묶어 차트 과밀 방지 */
function chartRows(rows: StatsRow[]): StatsRow[] {
  if (rows.length <= 13) return rows;
  const sorted = [...rows].sort((a, b) => b.studies - a.studies);
  const rest = sorted.slice(12);
  const etc = rest.reduce(
    (acc, r) => ({ ...acc, studies: acc.studies + r.studies, reports: acc.reports + r.reports,
                   unreported: acc.unreported + r.unreported }),
    { key: "__etc", label: `기타 (${rest.length})`, studies: 0, reports: 0, unreported: 0 } as StatsRow,
  );
  return [...sorted.slice(0, 12), etc];
}

/** ① 그룹별 검사 수 세로 막대 차트 — 값 라벨 · Y축 눈금 · 격자 */
function StatsBarChart({ rows }: { rows: StatsRow[] }) {
  const W = 680, H = 240, padL = 48, padR = 12, padT = 18, padB = 34;
  const iw = W - padL - padR, ih = H - padT - padB;
  const max = niceCeil(Math.max(1, ...rows.map((r) => r.studies)));
  const slot = iw / Math.max(1, rows.length);
  const barW = Math.max(8, Math.min(46, slot * 0.62));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}
         role="img" aria-label="그룹별 검사 수 막대 차트">
      {ticks.map((t, i) => {
        const y = padT + ih - (t / max) * ih;
        return (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y} y2={y} stroke="var(--border)"
                  strokeWidth={1} strokeDasharray={i === 0 ? undefined : "3 3"} />
            <text x={padL - 6} y={y + 3.5} textAnchor="end" fontSize={10}
                  fill="var(--text-secondary)">{t.toLocaleString()}</text>
          </g>
        );
      })}
      {rows.map((r, i) => {
        const x = padL + slot * i + (slot - barW) / 2;
        const h = (r.studies / max) * ih;
        const y = padT + ih - h;
        const label = r.label || r.key || "—";
        const short = label.length > 7 ? label.slice(0, 6) + "…" : label;
        return (
          <g key={r.key || i}>
            <rect x={x} y={y} width={barW} height={Math.max(h, r.studies > 0 ? 1 : 0)} rx={3}
                  fill={CHART_COLORS[i % CHART_COLORS.length]} opacity={0.9}>
              <title>{`${label}: 검사 ${r.studies.toLocaleString()}건 (판독 ${r.reports.toLocaleString()} · 미판독 ${r.unreported.toLocaleString()})`}</title>
            </rect>
            <text x={x + barW / 2} y={y - 4} textAnchor="middle" fontSize={10}
                  fill="var(--text-primary)">{r.studies.toLocaleString()}</text>
            <text x={x + barW / 2} y={padT + ih + 14} textAnchor="middle" fontSize={10}
                  fill="var(--text-secondary)">
              <title>{label}</title>{short}
            </text>
          </g>
        );
      })}
      <line x1={padL} x2={W - padR} y1={padT + ih} y2={padT + ih} stroke="var(--border)" />
    </svg>
  );
}

/** ② 판독 vs 미판독 비율 도넛 — 중앙 판독률 + 범례 */
function StatsDonut({ reports, unreported }: { reports: number; unreported: number }) {
  const total = reports + unreported;
  const R = 52, SW = 18, C = 2 * Math.PI * R;
  const frac = total > 0 ? reports / total : 0;
  const done = "var(--accent, #7dd3fc)", pend = "#fbbf24";
  return (
    <svg viewBox="0 0 250 150" style={{ width: "100%", height: "auto", display: "block" }}
         role="img" aria-label="판독 대 미판독 비율 도넛 차트">
      <g transform="translate(75, 75)">
        <circle r={R} fill="none" stroke={total > 0 ? pend : "var(--border)"} strokeWidth={SW} opacity={0.85}>
          <title>{`미판독 ${unreported.toLocaleString()}건`}</title>
        </circle>
        {frac > 0 && (
          <circle r={R} fill="none" stroke={done} strokeWidth={SW} transform="rotate(-90)"
                  strokeDasharray={`${C * frac} ${C}`} opacity={0.95}>
            <title>{`판독 ${reports.toLocaleString()}건`}</title>
          </circle>
        )}
        <text textAnchor="middle" y={-2} fontSize={20} fontWeight={700}
              fill="var(--text-primary)">{total > 0 ? `${Math.round(frac * 100)}%` : "—"}</text>
        <text textAnchor="middle" y={16} fontSize={10}
              fill="var(--text-secondary)">{total > 0 ? "판독률" : "데이터 없음"}</text>
      </g>
      <g transform="translate(155, 55)" fontSize={11.5}>
        <rect width={10} height={10} rx={2} fill={done} />
        <text x={16} y={9} fill="var(--text-primary)">판독 {reports.toLocaleString()}건</text>
        <rect y={20} width={10} height={10} rx={2} fill={pend} />
        <text x={16} y={29} fill="var(--text-primary)">미판독 {unreported.toLocaleString()}건</text>
        <text y={48} fill="var(--text-secondary)">합계 {total.toLocaleString()}건</text>
      </g>
    </svg>
  );
}

export function StatsPanel({ hid }: { hid?: number }) {
  const [group, setGroup] = useState(hid ? "modality" : "hospital");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [data, setData] = useState<StatsResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const load = async () => {
    setBusy(true);
    try {
      const r = await api.insightsStats({
        group,
        ...(dateFrom ? { date_from: dateFrom } : {}),
        ...(dateTo ? { date_to: dateTo } : {}),
        ...(hid ? { hid: String(hid) } : {}),
      });
      setData(r); setMsg("");
    } catch (e) { setData(null); setMsg(pendMsg(e)); }
    finally { setBusy(false); }
  };
  useEffect(() => { load(); }, [group, hid]); // eslint-disable-line react-hooks/exhaustive-deps

  const xlsx = async () => {
    // 현재 필터 조건 그대로 서버(openpyxl)가 생성한 .xlsx 다운로드 — downloadLogsCsv 패턴
    try {
      await downloadStatsXlsx({
        group,
        ...(dateFrom ? { date_from: dateFrom } : {}),
        ...(dateTo ? { date_to: dateTo } : {}),
        ...(hid ? { hid: String(hid) } : {}),
      });
    } catch (e) { setMsg(pendMsg(e)); }
  };

  const rows = data?.rows ?? [];
  const maxStudies = Math.max(1, ...rows.map((r) => r.studies));
  const cRows = chartRows(rows); // 상위 12 + 기타 (rows 과밀 시)
  const sumReports = rows.reduce((a, r) => a + r.reports, 0);
  const sumUnreported = rows.reduce((a, r) => a + r.unreported, 0);
  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700 }}>📊 사용량 통계{hid ? " (이 병원)" : ""}</div>
        <select style={inp} value={group} onChange={(e) => setGroup(e.target.value)}>
          {STAT_GROUPS.filter((g) => !(hid && g.key === "hospital")).map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
        </select>
        <div style={{ flex: 1 }} />
        <input style={{ ...inp, width: 130 }} type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} title="시작일" />
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>~</span>
        <input style={{ ...inp, width: 130 }} type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} title="종료일" />
        <button onClick={load} disabled={busy}>{busy ? "조회 중…" : "조회"}</button>
        <button onClick={xlsx} title="현재 필터 조건 그대로 Excel(.xlsx) 다운로드">Excel 내보내기</button>
      </div>

      {/* 그래프 — 막대(그룹별 검사 수) + 도넛(판독 vs 미판독) · 표는 아래 유지 */}
      {rows.length > 0 && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "stretch" }}>
          <div style={{ flex: "1 1 340px", minWidth: 300, border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px" }}>
            <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginBottom: 4 }}>
              그룹별 검사 수{cRows.length !== rows.length ? " — 상위 12 + 기타" : ""}
            </div>
            <StatsBarChart rows={cRows} />
          </div>
          <div style={{ flex: "0 1 260px", minWidth: 220, border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px" }}>
            <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginBottom: 4 }}>판독 vs 미판독</div>
            <StatsDonut reports={sumReports} unreported={sumUnreported} />
          </div>
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
      <table className="grid-table" style={{ fontSize: 12.5 }}>
        <thead><tr><th>구분</th><th>검사</th><th>판독</th><th>미판독</th><th style={{ width: "38%" }}>검사 수(비율)</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.label || r.key}</td>
              <td>{r.studies.toLocaleString()}</td>
              <td>{r.reports.toLocaleString()}</td>
              <td style={{ color: r.unreported > 0 ? "#fbbf24" : undefined }}>{r.unreported.toLocaleString()}</td>
              <td>
                <div title={`${r.studies.toLocaleString()}건`}
                     style={{ height: 10, borderRadius: 5, background: "var(--bg-canvas)", border: "1px solid var(--border)", overflow: "hidden" }}>
                  <div style={{ width: `${(r.studies / maxStudies) * 100}%`, height: "100%", background: "var(--accent,#7dd3fc)", transition: "width .3s" }} />
                </div>
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} style={{ color: "var(--text-secondary)" }}>{busy ? "조회 중…" : "데이터가 없습니다."}</td></tr>}
        </tbody>
      </table>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
        기간 미지정=전체. 막대는 목록 내 최대 검사 수 기준 상대 비율입니다.
      </div>
      <Msg text={msg} />
    </div>
  );
}

// ════════════════════════════ ⑪ AI 등록 항목 (오픈소스 + 상업 API — RAG 자리만들기) ════════════════════════════
const EMPTY_PROVIDER: AiProvider = { name: "", kind: "oss", endpoint: "", model: "", api_key_ref: "", enabled: true, note: "" };
export function AiProvidersPanel() {
  const [items, setItems] = useState<AiProvider[]>([]);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    api.getSetting("ai.providers")
      .then((r) => {
        const v = r.value as { items?: AiProvider[] };
        if (Array.isArray(v.items)) setItems(v.items);
      })
      .catch(() => {}); // 미설정=빈 목록
  }, []);

  const edit = (i: number, patch: Partial<AiProvider>) => {
    setItems((p) => p.map((x, j) => (j === i ? { ...x, ...patch } : x)));
    setDirty(true);
  };
  const add = () => { setItems((p) => [...p, { ...EMPTY_PROVIDER }]); setDirty(true); };
  const del = (i: number) => {
    if (!confirm(`AI 항목 '${items[i].name || i + 1}' 삭제?`)) return;
    setItems((p) => p.filter((_, j) => j !== i));
    setDirty(true);
  };
  const save = async () => {
    try {
      await api.putSetting("ai.providers", { items } as unknown as Record<string, unknown>, "global");
      setDirty(false); showToast("저장 되었습니다."); setMsg("저장됨");
    } catch (e) { setMsg(pendMsg(e)); }
  };

  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700 }}>🤖 AI 등록 항목 (오픈소스 · 상업 API)</div>
        <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10,
                       background: "var(--accent-subtle)", color: "var(--ai,#a78bfa)", border: "1px solid var(--border)" }}>
          RAG 분석 연동 — 개발 예정
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={add}>＋ 추가</button>
        <button className="primary" onClick={save} disabled={!dirty}>저장</button>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="grid-table" style={{ fontSize: 12.5 }}>
          <thead><tr><th>이름</th><th>종류</th><th>Endpoint</th><th>모델</th><th>키 참조</th><th>사용</th><th>비고</th><th></th></tr></thead>
          <tbody>
            {items.map((p, i) => (
              <tr key={i}>
                <td><input style={{ ...inp, width: 110 }} value={p.name} onChange={(e) => edit(i, { name: e.target.value })} /></td>
                <td>
                  <select style={{ ...inp, padding: "3px 6px" }} value={p.kind} onChange={(e) => edit(i, { kind: e.target.value as "oss" | "api" })}>
                    <option value="oss">오픈소스</option>
                    <option value="api">상업 API</option>
                  </select>
                </td>
                <td><input style={{ ...inp, width: 170 }} value={p.endpoint} onChange={(e) => edit(i, { endpoint: e.target.value })} placeholder="http://…" /></td>
                <td><input style={{ ...inp, width: 120 }} value={p.model} onChange={(e) => edit(i, { model: e.target.value })} /></td>
                <td><input style={{ ...inp, width: 110 }} value={p.api_key_ref} onChange={(e) => edit(i, { api_key_ref: e.target.value })}
                           placeholder="키 이름(참조)" title="API 키 원문이 아니라 서버 보안 저장소의 참조 이름을 입력" /></td>
                <td style={{ textAlign: "center" }}><input type="checkbox" checked={p.enabled} onChange={(e) => edit(i, { enabled: e.target.checked })} /></td>
                <td><input style={{ ...inp, width: 120 }} value={p.note} onChange={(e) => edit(i, { note: e.target.value })} /></td>
                <td><button onClick={() => del(i)}>삭제</button></td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={8} style={{ color: "var(--text-secondary)" }}>등록된 AI 항목이 없습니다 — [＋ 추가] 후 저장하세요.</td></tr>}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
        ⚠ API 키 원문은 저장하지 않습니다 — [키 참조]에는 서버 보안 저장소의 키 이름만 입력하세요.
        등록 항목은 RAG 판독초안 분석 연동(개발 예정) 시 선택지로 사용됩니다.
      </div>
      <Msg text={msg} />
    </div>
  );
}

// ════════════════════════════ AI 음성 판독(STT) — 서버 엔진 설정 + 설치 상태 + 마이크 테스트 ════════════════════════════
/** Server AI 등록 하단 — OpenAI Whisper(로컬/API)·브라우저 엔진 선택. 전역 ai.policy 로 저장 → 모든 병원·Client 공통 구동. */
export function SttServerPanel() {
  const [engine, setEngine] = useState("browser");
  const [model, setModel] = useState("");
  const [policy, setPolicy] = useState<Record<string, unknown>>({});   // 기존 ai.policy 보존(auto_generate/vision)
  const [stat, setStat] = useState<SttStatus | null>(null);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState("");
  const [testText, setTestText] = useState("");
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const recRef = useRef<MediaRecorder | null>(null);

  const loadStatus = () => sttStatus().then(setStat).catch(() => {});
  useEffect(() => {
    api.getSetting("ai.policy").then((r) => {
      const v = (r.value ?? {}) as Record<string, unknown>;
      setPolicy(v);
      setEngine((v.stt_engine as string) ?? "browser");
      setModel((v.stt_model as string) ?? "");
    }).catch(() => {});
    loadStatus();
  }, []);

  const save = async () => {
    try {
      // 기존 ai.policy 필드 보존 + STT 필드만 갱신 → 전역 저장(stt.py 가 읽는 스코프)
      await api.putSetting("ai.policy", { ...policy, stt_engine: engine, stt_model: model }, "global");
      setPolicy((p) => ({ ...p, stt_engine: engine, stt_model: model }));
      setDirty(false); showToast("저장 되었습니다."); setMsg("저장됨 — 모든 병원·Client 에 즉시 적용");
      loadStatus();
    } catch (e) { setMsg(pendMsg(e)); }
  };

  // 마이크 테스트 — 서버 설정 엔진으로 실제 전사(browser 엔진은 서버 미경유라 테스트 제외 안내)
  const testMic = () => {
    if (recording) { recRef.current?.stop(); setRecording(false); return; }
    if (engine === "browser") { setMsg("브라우저 엔진은 각 Client 내장 Web Speech 사용 — 서버 전사 테스트 대상이 아닙니다"); return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setBusy(true);
        try {
          const r = await sttTranscribe(new Blob(chunks, { type: "audio/webm" }));
          setTestText(r.text || "(빈 결과)"); setMsg(`전사 완료 (엔진: ${r.engine})`);
        } catch (e) { setMsg(e instanceof Error ? e.message : "전사 실패"); }
        finally { setBusy(false); }
      };
      recRef.current = rec; rec.start(); setRecording(true);
    }).catch(() => setMsg("마이크 권한이 필요합니다"));
  };
  useEffect(() => () => recRef.current?.stop(), []);

  const badge = (ok: boolean, label: string) => (
    <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, border: "1px solid var(--border)",
                   color: ok ? "var(--stat-final)" : "var(--text-secondary)",
                   background: ok ? "var(--accent-subtle)" : "transparent" }}>
      {ok ? "●" : "○"} {label}
    </span>
  );

  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700 }}>🎙 AI 음성 판독 (STT) — 서버 엔진</div>
        <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>OpenAI Whisper(로컬/API)·브라우저 — 전역 설정, 모든 병원·Client 공통</span>
        <div style={{ flex: 1 }} />
        <button className="primary" onClick={save} disabled={!dirty}>저장</button>
      </div>

      {stat && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <b style={{ fontSize: 12, color: stat.ready ? "var(--stat-final)" : "var(--stat-emergency)" }}>
            {stat.ready ? "구동 가능" : "구동 불가(설치/키 확인)"}
          </b>
          {badge(stat.available.faster_whisper, "faster-whisper")}
          {badge(stat.available.openai_whisper, "openai-whisper")}
          {badge(stat.available.openai_api_key, "OPENAI_API_KEY")}
          <button onClick={loadStatus} style={{ padding: "1px 8px", fontSize: 11 }}>새로고침</button>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 8, alignItems: "center", maxWidth: 560 }}>
        <span style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>엔진</span>
        <select style={{ ...inp, padding: "5px 8px" }} value={engine}
                onChange={(e) => { setEngine(e.target.value); setDirty(true); }}>
          <option value="browser">브라우저 내장 (Web Speech — Client 로컬, 서버 미전송)</option>
          <option value="whisper_local">Whisper 로컬 (오픈소스 · 온프레미스 · PHI 안전)</option>
          <option value="openai_api">OpenAI API (whisper-1 · 음성 외부 전송)</option>
        </select>
        <span style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>모델</span>
        <input style={inp} value={model} onChange={(e) => { setModel(e.target.value); setDirty(true); }}
               placeholder={engine === "openai_api" ? "whisper-1" : "base / small / medium / large-v3"} />
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={testMic} disabled={busy}
                style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 12px",
                         border: `1px solid ${recording ? "var(--stat-emergency)" : "var(--border)"}`, borderRadius: 6,
                         background: recording ? "var(--stat-emergency)" : "var(--bg-canvas)",
                         color: recording ? "#fff" : "var(--text-primary)", cursor: "pointer" }}>
          <MicIcon on={recording} /> {busy ? "전사 중…" : recording ? "● 녹음 중 (클릭 종료)" : "마이크 테스트"}
        </button>
        {testText && <span style={{ fontSize: 12, color: "var(--text-primary)" }}>전사 결과: “{testText}”</span>}
      </div>

      <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.6 }}>
        · <b>Whisper 로컬 설치</b>: 서버에서 <code>pip install faster-whisper</code>(권장) 또는 <code>pip install openai-whisper</code>(+ffmpeg) 후 [새로고침].<br />
        · <b>OpenAI API</b>: 서버 환경변수 <code>OPENAI_API_KEY</code> 설정(코드/DB 저장 금지 — 절대 규칙 4). <span style={{ color: "var(--stat-emergency)" }}>음성이 외부로 전송됩니다.</span><br />
        · Client 판독창의 마이크 버튼은 이 서버 설정을 그대로 사용합니다(연동).
      </div>
      <Msg text={msg} />
    </div>
  );
}
