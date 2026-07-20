// 관리자 콘솔 — 로그인 후 메인 페이지(좌측 트리 메뉴 + 우측 내용)
// 개념 계약: 'Admin System — 부모 컨테이너' = 모든 병원(자식 컨테이너)을 담는 시스템 전체의 관리,
//            '병원 — 자식 컨테이너' = 각 병원 스코프의 운영 관리 탭 12종
// 구조도: Admin System(상태·설정·인프라·보안·계정 관리 등) · 병원 → 병원별 관리 탭
//   (①계정·등급 ②권한 매트릭스 ③Modality(SCP) ④병원 설정(SCU) ⑤사용량 ⑥연결 대시보드 ⑦DB·영상 관리
//    ⑧로그 ⑨통계 ⑩데이터 ⑪연동(HL7·원격판독·MWL·가상환자) ⑫컨테이너(Orthanc))
import { useEffect, useState } from "react";
import { showToast } from "../lib/toast";
import {
  api, setToken, type HospitalNetResult, type HospitalRow, type ServerStatusAll,
} from "../api";
import {
  HospitalsPanel, OverviewPanel, ServerPanel, StoragePanel,
} from "./admin/ServerAdmin";
import {
  AccountsTab, BackupTab, ConnDashboardTab, ExamControlTab, HospitalDataTab, HospitalLogsTab,
  HospitalModalityTab, HospitalStatsTab, PermMatrixTab, ScuTab, StudyAdminTab, UsageTab, HospitalStorageTab,
} from "./admin/HospitalAdmin";
import { HospitalWorklistSettings } from "./admin/HospitalWorklistSettings";
import {
  BackupMirrorPanel, DataWipePanel, MaintStoragePanel, RestorePanel, ServerConfigPanel,
} from "./admin/ServerMaintenance";
import {
  AdminAccountsPanel, AiProvidersPanel, DbSchemaPanel, LogsPanel, SignupFieldsPanel, StatsPanel, SttServerPanel,
} from "./admin/ServerInsights";
// 병렬 레인 패널 (통합 배선) — H: HL7/원격판독/MWL/가상환자 · O: 인프라 · S: 보안
import { Hl7Panel } from "./admin/Hl7Panel";
import InfraPanel, { HospitalContainersSection } from "./admin/InfraPanel";
import { SecurityPanel } from "./admin/SecurityPanel";
import SystemMap from "./admin/SystemMap";

const card: React.CSSProperties = { background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8, padding: 14 };

// ── 서버 Database ──
function ServerDatabaseView() {
  const [st, setSt] = useState<ServerStatusAll | null>(null);
  useEffect(() => { api.serverStatusAll().then(setSt).catch(() => {}); }, []);
  const dbs = (st?.services ?? []).filter((s) => s.kind === "db" || s.kind === "appdb");
  return (
    <div style={card}>
      <div style={{ fontWeight: 700, marginBottom: 10 }}>🗄️ 서버 Database</div>
      <table className="grid-table" style={{ fontSize: 12.5 }}>
        <thead><tr><th>구성</th><th>주소</th><th>상태</th></tr></thead>
        <tbody>{dbs.map((s) => (
          <tr key={s.name}><td>{s.name}</td><td><code>{s.url}</code></td>
            {/* 연동 OK = 녹색 점등, 실패 = 빨간 점 */}
            <td><span style={{ color: s.ok ? "#4ade80" : "var(--danger,#f87171)",
                               textShadow: s.ok ? "0 0 6px rgba(74,222,128,0.7)" : undefined }}>● </span>
              <span style={{ color: s.ok ? undefined : "var(--danger,#f87171)" }}>{s.detail}</span></td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

// ── 병원 정보(편집) ──
function HospitalInfoView({ hid }: { hid: number }) {
  const [h, setH] = useState<HospitalRow | null>(null);
  const [msg, setMsg] = useState("");
  const [net, setNet] = useState<HospitalNetResult | null>(null);
  const load = () => api.hospitals().then((r) => setH(r.items.find((x) => x.id === hid) ?? null)).catch(() => {});
  useEffect(() => { load(); setNet(null); }, [hid]);
  const f = (k: keyof HospitalRow, v: unknown) => setH((p) => p ? { ...p, [k]: v } as HospitalRow : p);
  const save = async () => {
    if (!h) return;
    try { await api.updateHospital(hid, h); showToast("저장 되었습니다."); setMsg("저장됨"); } catch (e) { setMsg("⚠ " + (e as Error).message); }
  };
  const test = async () => {
    if (!h) return;
    try { await api.updateHospital(hid, h); showToast("저장 되었습니다."); setNet(await api.hospitalNetTest(hid)); }
    catch (e) { setMsg("⚠ " + (e as Error).message); }
  };
  const epLabel = (e: { tcp: boolean | null; echo: boolean | null; detail?: string }) =>
    e.tcp === null ? "미설정"
      : !e.tcp ? `🔴 TCP 실패 ${e.detail ? `(${e.detail})` : ""}`
        : e.echo === null ? "🟢 TCP 연결됨"
          : e.echo ? "🟢 C-ECHO 성공" : `🟠 TCP OK · C-ECHO 실패 ${e.detail ? `(${e.detail})` : ""}`;
  if (!h) return <div style={card}>불러오는 중…</div>;
  const row = (label: string, node: React.ReactNode) => (
    <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}>
      <span style={{ width: 120, color: "var(--text-secondary)" }}>{label}</span>{node}</label>
  );
  const inp: React.CSSProperties = { flex: 1, background: "var(--bg-canvas)", color: "var(--text-primary)", border: "1px solid var(--border)", borderRadius: 4, padding: "5px 8px", fontSize: 12.5 };
  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontWeight: 700 }}>🏥 병원 정보 — {h.code}</div>
      <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
        자식 컨테이너(이 병원) 스코프 — 운영 설정(정보·DICOM 네트워크 등)을 편집합니다.
        등록·라이선스·활성화는 부모(Admin System)의 [＋ 병원 등록·관리]에서.
      </div>
      {row("병원 이름", <input style={inp} value={h.name} onChange={(e) => f("name", e.target.value)} />)}
      {row("주소", <input style={inp} value={h.address} onChange={(e) => f("address", e.target.value)} />)}
      {row("진료과", <input style={inp} value={h.departments} onChange={(e) => f("departments", e.target.value)} />)}
      {row("연락처", <input style={inp} value={h.phone} onChange={(e) => f("phone", e.target.value)} />)}
      {row("Fax", <input style={inp} value={h.fax} onChange={(e) => f("fax", e.target.value)} />)}
      {row("홈페이지", <input style={inp} value={h.homepage} onChange={(e) => f("homepage", e.target.value)} />)}
      {row("License(Client 수)", <input style={{ ...inp, flex: "none", width: 90 }} type="number" min={0} value={h.license_clients} onChange={(e) => f("license_clients", Number(e.target.value))} />)}
      {row("Modality 수", <input style={{ ...inp, flex: "none", width: 90 }} type="number" min={0} value={h.modality_limit} onChange={(e) => f("modality_limit", Number(e.target.value))} />)}
      {row("데이터 격리", <input type="checkbox" checked={!!h.enforce_isolation} onChange={(e) => f("enforce_isolation", e.target.checked)} />)}

      {/* 병원별 DICOM 네트워크 — 포트는 병원마다 달라야 함 */}
      <div style={{ borderTop: "1px solid var(--border)", marginTop: 4, paddingTop: 10 }}>
        <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 8 }}>📡 DICOM 네트워크 (병원별 — 포트 상이)</div>
        {row("서버 호스트/IP", <input style={inp} value={h.server_host} onChange={(e) => f("server_host", e.target.value)} placeholder="예: 10.0.0.5 또는 pacs.hospital.kr" />)}
        <div style={{ fontSize: 11.5, color: "var(--text-secondary)", margin: "6px 0 4px" }}>① Modality 수신(SCP) — 장비가 C-STORE로 영상 전송</div>
        {row("수신 AE Title", <input style={inp} value={h.scp_aet} onChange={(e) => f("scp_aet", e.target.value)} />)}
        {row("수신 Port", <input style={{ ...inp, flex: "none", width: 110 }} type="number" value={h.scp_port} onChange={(e) => f("scp_port", Number(e.target.value))} />)}
        <div style={{ fontSize: 11.5, color: "var(--text-secondary)", margin: "6px 0 4px" }}>② Client Viewer 조회(Q/R) — 뷰어가 영상 조회/수신</div>
        {row("조회 AE Title", <input style={inp} value={h.qr_aet} onChange={(e) => f("qr_aet", e.target.value)} />)}
        {row("조회 Port", <input style={{ ...inp, flex: "none", width: 110 }} type="number" value={h.qr_port} onChange={(e) => f("qr_port", Number(e.target.value))} />)}
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
          <button onClick={test}>저장 + 연결 테스트</button>
          {net && (
            <span style={{ fontSize: 12 }}>
              수신: {epLabel(net.scp)} &nbsp;|&nbsp; 조회: {epLabel(net.qr)}
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 6 }}>
          포트는 병원마다 자동 배정(상이)됩니다. ⚠ 단일 Orthanc는 DICOM 포트가 하나라, 실제 병원별 포트 리스닝은
          병원별 Orthanc 인스턴스 또는 DICOM 라우터 배치가 필요합니다(여기서는 구성·연결 점검).
        </div>
      </div>

      <div style={{ borderTop: "1px solid var(--border)", marginTop: 4, paddingTop: 10 }}>
        <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>🩻 검사 배정</div>
        <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginBottom: 6 }}>
          수신 AET가 등록 장비와 매칭되지 않아 병원이 비어있는(미배정) 검사를 이 병원에 귀속합니다.
          (Client 뷰어는 로그인한 병원의 검사만 표시하므로, 미배정 검사는 배정해야 보입니다.)
        </div>
        <button onClick={async () => {
          try { const r = await api.claimStudies(hid); setMsg(`미배정 검사 ${r.assigned}건을 이 병원에 배정했습니다`); }
          catch (e) { setMsg("⚠ " + (e as Error).message); }
        }}>미배정 검사 이 병원에 배정</button>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button className="primary" onClick={save}>저장</button>
        <span style={{ fontSize: 12, color: "var(--accent,#7dd3fc)" }}>{msg}</span>
      </div>
    </div>
  );
}

// ════════════════════════════ 콘솔 본체 ════════════════════════════
type Node = string; // server-status|server-storage|server-db|hospitals|users|overview | h:{hid}:{sub}

export function AdminConsole({ userName, isSystemAdmin, onLogout }: {
  userName: string; isSystemAdmin: boolean; onLogout: () => void;
}) {
  const [hosps, setHosps] = useState<HospitalRow[]>([]);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  // 기본 선택 — 시스템 관리자는 콘솔 진입 시 시스템 구조도(라이브 대시보드)가 첫 화면
  const [sel, setSel] = useState<Node>(isSystemAdmin ? "sysmap" : "hospitals");
  const loadHosps = () => api.hospitals().then((r) => setHosps(r.items)).catch(() => {});
  useEffect(() => { loadHosps(); }, []);

  // 병원별 하위 관리 탭 — 병원 정보(기존) + 관리 7종(레인 F)
  const HOSP_SUB: { key: string; label: string }[] = [
    { key: "info", label: "병원 정보" },
    { key: "acct", label: "① 계정 (발급·등급)" },
    { key: "perm", label: "② 권한 매트릭스" },
    { key: "scp", label: "③ Modality (SCP)" },
    { key: "scu", label: "④ 병원 설정 (SCU)" },
    { key: "usage", label: "⑤ 사용량 (DB·Storage)" },
    { key: "conn", label: "⑥ 연결 대시보드" },
    { key: "dbimg", label: "⑦ DB·영상 관리" },
    { key: "logs", label: "⑧ 로그" },
    { key: "stats", label: "⑨ 통계" },
    { key: "data", label: "⑩ 데이터 (지우기·복원)" },
    { key: "link", label: "⑪ 연동 (HL7·원격판독·MWL·가상환자)" },
    { key: "cont", label: "⑫ 컨테이너 (Orthanc)" },
    { key: "examctl", label: "⑬ Exam Control (검사 QC)" },
    { key: "backup", label: "⑭ 백업 (설정 내보내기·복원)" },
  { key: "hstorage", label: "⑮ Storage (백업·보존)" },
  { key: "wlset", label: "⑯ 뷰어·워크리스트 설정" },
  ];

  const itemStyle = (active: boolean, indent = 0): React.CSSProperties => ({
    padding: "6px 10px", paddingLeft: 10 + indent * 14, borderRadius: 4, cursor: "pointer",
    fontSize: 12.5, marginBottom: 1, background: active ? "var(--accent-subtle)" : undefined,
    color: active ? "var(--text-primary)" : "var(--text-secondary)",
  });
  // 트리 섹션 헤더 — 개념 계약: '전체/시스템'=부모 컨테이너(Admin System), 병원별=자식 컨테이너 (tip=한 줄 설명 툴팁)
  const Head = ({ children, tip }: { children: React.ReactNode; tip?: string }) => (
    <div title={tip} style={{ fontSize: 11, fontWeight: 700, color: "var(--text-secondary)", margin: "10px 0 4px 6px", textTransform: "uppercase" }}>{children}</div>
  );
  // 부모(시스템 전체) 스코프 안내 한 줄 — 병원별 대응 탭이 있는 항목(로그/통계/데이터)에 표시
  const scopeNote = (extra?: string) => (
    <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginBottom: 10 }}>
      🌐 시스템(부모 컨테이너 — Admin System) 전체 범위입니다.{extra ? ` ${extra}` : ""}
    </div>
  );

  // 우측 내용
  let content: React.ReactNode = null;
  // 시스템 구조도 — 병원 박스 클릭 시 해당 병원 [병원 정보] 탭으로 이동(트리 확장 포함)
  if (sel === "sysmap") content = (
    <SystemMap onSelectHospital={(hid) => { setOpen((p) => ({ ...p, [hid]: true })); setSel(`h:${hid}:info`); }} />
  );
  else if (sel === "server-status") content = <ServerPanel />;
  else if (sel === "server-storage") content = <StoragePanel />;
  else if (sel === "server-db") content = <ServerDatabaseView />;
  // 역할 분리 — 부모(Admin System)=병원 등록·라이선스·활성화 / 자식(병원 탭)=운영 설정(네트워크·SCU 등)
  else if (sel === "hospitals") content = (
    <>
      <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginBottom: 10 }}>
        🌐 부모(Admin System) 스코프 — 병원 등록·라이선스·활성화를 담당합니다.
        각 병원의 운영 설정(DICOM 네트워크·SCU 등)은 병원 트리의 [병원 정보]·[④ 병원 설정] 탭에서.
      </div>
      <HospitalsPanel />
    </>
  );
  // 구 [사용자 관리] 경로 — 통합된 [계정 관리]와 기능 동일(같은 표)이므로 통합 화면으로 렌더(딥링크·구 상태 호환)
  else if (sel === "users") content = <AdminAccountsPanel />;
  else if (sel === "overview") content = <OverviewPanel />;
  // 서버 유지보수·인사이트 (14개 요구 — 레인 F)
  else if (sel === "srv-config") content = <ServerConfigPanel />;
  else if (sel === "srv-space") content = <MaintStoragePanel />;
  else if (sel === "srv-backup") content = <BackupMirrorPanel />;
  else if (sel === "srv-restore") content = <RestorePanel hospitals={hosps} />;
  else if (sel === "srv-wipe") content = (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {scopeNote("병원별 데이터 관리는 각 병원의 [⑩ 데이터] 탭에서 수행하세요.")}
      <DataWipePanel hospitals={hosps} />
      <RestorePanel hospitals={hosps} />
    </div>
  );
  else if (sel === "srv-dbschema") content = <DbSchemaPanel />;
  else if (sel === "srv-signup") content = <SignupFieldsPanel />;
  else if (sel === "srv-admins") content = <AdminAccountsPanel />;
  else if (sel === "srv-logs") content = <>{scopeNote("병원별 로그는 각 병원의 [⑧ 로그] 탭에서 확인하세요.")}<LogsPanel /></>;
  else if (sel === "srv-stats") content = <>{scopeNote("병원별 통계는 각 병원의 [⑨ 통계] 탭에서 확인하세요.")}<StatsPanel /></>;
  else if (sel === "srv-ai") content = <><AiProvidersPanel /><SttServerPanel /></>;
  // 병렬 레인 패널 — 인프라(O) · 보안(S)
  else if (sel === "srv-infra") content = <InfraPanel />;
  else if (sel === "srv-security") content = <SecurityPanel />;
  else if (sel.startsWith("h:")) {
    const [, hidStr, sub] = sel.split(":");
    const hid = Number(hidStr);
    if (sub === "info") content = <HospitalInfoView hid={hid} />;
    else if (sub === "acct") content = <AccountsTab hid={hid} />;
    else if (sub === "perm") content = <PermMatrixTab hid={hid} />;
    else if (sub === "scp") content = <HospitalModalityTab hid={hid} />;
    else if (sub === "scu") content = <ScuTab hid={hid} />;
    else if (sub === "usage") content = <UsageTab hid={hid} />;
    else if (sub === "conn") content = <ConnDashboardTab hid={hid} />;
    else if (sub === "dbimg") content = <StudyAdminTab hid={hid} hospitals={hosps} />;
    else if (sub === "logs") content = <HospitalLogsTab hid={hid} />;
    else if (sub === "stats") content = <HospitalStatsTab hid={hid} />;
    else if (sub === "data") content = <HospitalDataTab hid={hid} hospitals={hosps} />;
    else if (sub === "link") content = <Hl7Panel hid={hid} />;
    else if (sub === "cont") content = <HospitalContainersSection hid={hid} />;
    else if (sub === "examctl") content = <ExamControlTab hid={hid} />;
    else if (sub === "hstorage") content = <HospitalStorageTab hid={hid} />;
    // key={hid} — 병원 전환 시 리마운트로 상태·진행 중 요청을 완전 초기화(병원 간 설정 오염 방지)
    else if (sub === "wlset") content = <HospitalWorklistSettings key={hid} hid={hid} />;
    else if (sub === "backup") content = <BackupTab hid={hid} hospitalName={hosps.find((h) => h.id === hid)?.name || ""} />;
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 16px", height: 48,
                       background: "var(--bg-panel)", borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontWeight: 700 }}>Saintview <span style={{ color: "var(--ai,#a78bfa)" }}>PACS AI</span></span>
        <span style={{ color: "var(--text-secondary)", fontSize: 12.5 }}>· 관리자 콘솔</span>
        <div style={{ flex: 1 }} />
        <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>{userName}{isSystemAdmin ? " [시스템 관리자]" : " [병원 관리자]"}</span>
        <button onClick={() => { setToken(null); onLogout(); }}>로그아웃</button>
      </header>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* 좌측 트리 메뉴 */}
        <div style={{ width: 240, borderRight: "1px solid var(--border)", padding: 8, background: "var(--bg-canvas)", overflow: "auto", flexShrink: 0 }}>
          {isSystemAdmin && <>
            {/* 개념 계약 — 이 섹션은 모든 병원(자식 컨테이너)을 담는 부모 컨테이너(Admin System) 자체의 관리 */}
            <Head tip="Admin System(부모 컨테이너) — 모든 병원(자식 컨테이너)을 담는 시스템 전체의 관리">Admin System — 부모 컨테이너</Head>
            <div style={itemStyle(sel === "sysmap")} title="부모(Admin System)와 병원(자식 컨테이너) 전체 현황을 그림으로" onClick={() => setSel("sysmap")}>🗺️ 시스템 구조도</div>
            <div style={itemStyle(sel === "server-status")} onClick={() => setSel("server-status")}>🖥️ 서버 상태</div>
            <div style={itemStyle(sel === "srv-config")} onClick={() => setSel("srv-config")}>⚙️ 서버 설정 (IP·Port·AE·Name)</div>
            <div style={itemStyle(sel === "srv-space")} title="시스템(부모) 전체의 저장 공간" onClick={() => setSel("srv-space")}>📦 저장 공간 (DB·Image·Backup)</div>
            <div style={itemStyle(sel === "server-storage")} title="시스템(부모) 전체의 Storage" onClick={() => setSel("server-storage")}>💾 서버 Storage</div>
            <div style={itemStyle(sel === "server-db")} title="시스템(부모) 전체의 Database" onClick={() => setSel("server-db")}>🗄️ 서버 Database</div>
            <div style={itemStyle(sel === "srv-backup")} title="시스템(부모) 전체의 백업·미러링" onClick={() => setSel("srv-backup")}>🗓️ 백업 · 미러링</div>
            <div style={itemStyle(sel === "srv-restore")} title="시스템(부모) 전체의 복원" onClick={() => setSel("srv-restore")}>⏪ 복원 (백업 시점)</div>
            <div style={itemStyle(sel === "srv-wipe")} title="시스템(부모) 전체의 데이터 관리 — 병원별은 각 병원 [⑩ 데이터] 탭" onClick={() => setSel("srv-wipe")}>🧹 데이터 관리 (지우고 복원)</div>
            <div style={itemStyle(sel === "srv-dbschema")} onClick={() => setSel("srv-dbschema")}>🧬 DB 구조 · DB 도구</div>
            <div style={itemStyle(sel === "srv-signup")} onClick={() => setSel("srv-signup")}>📝 가입 환경 설정</div>
            {/* [사용자 관리]와 [관리자 계정] 중복 → 단일 [계정 관리] 메뉴로 통합 (admin 빠른 등록 + 전체 사용자 표) */}
            <div style={itemStyle(sel === "srv-admins")} title="관리자 빠른 등록 + 전체 계정/역할 관리 (구 [관리자 계정]·[사용자 관리] 통합)" onClick={() => setSel("srv-admins")}>👤 계정 관리 (관리자·사용자)</div>
            <div style={itemStyle(sel === "srv-logs")} title="시스템(부모) 전체의 로그 — 병원별은 각 병원 [⑧ 로그] 탭" onClick={() => setSel("srv-logs")}>📜 시스템 로그</div>
            <div style={itemStyle(sel === "srv-stats")} title="시스템(부모) 전체의 통계 — 병원별은 각 병원 [⑨ 통계] 탭" onClick={() => setSel("srv-stats")}>📈 사용량 통계</div>
            <div style={itemStyle(sel === "srv-ai")} onClick={() => setSel("srv-ai")}>🤖 AI 등록</div>
            <div style={itemStyle(sel === "srv-infra")} title="시스템(부모) 전체의 인프라" onClick={() => setSel("srv-infra")}>🐳 인프라 (컨테이너·OHIF·DDNS)</div>
            <div style={itemStyle(sel === "srv-security")} title="시스템(부모) 전체의 보안" onClick={() => setSel("srv-security")}>🔐 보안 (바이러스·랜섬·접근)</div>
            <div style={itemStyle(sel === "overview")} onClick={() => setSel("overview")}>📊 운영 현황(감독)</div>
          </>}

          <Head tip="병원(자식 컨테이너) — 각 병원 스코프의 운영 관리 탭">병원 — 자식 컨테이너</Head>
          <div style={itemStyle(sel === "hospitals")} onClick={() => { setSel("hospitals"); loadHosps(); }}>＋ 병원 등록·관리</div>
          {hosps.map((h) => (
            <div key={h.id}>
              <div style={itemStyle(false, 0)} onClick={() => setOpen((p) => ({ ...p, [h.id]: !p[h.id] }))}>
                {open[h.id] ? "▾" : "▸"} 🏥 {h.name || h.code}
              </div>
              {open[h.id] && HOSP_SUB.map((s) => (
                <div key={s.key} style={itemStyle(sel === `h:${h.id}:${s.key}`, 1)} onClick={() => setSel(`h:${h.id}:${s.key}`)}>
                  {s.label}
                </div>
              ))}
            </div>
          ))}
          {hosps.length === 0 && <div style={{ fontSize: 11.5, color: "var(--text-secondary)", padding: "4px 10px" }}>등록된 병원이 없습니다.</div>}
        </div>

        {/* 우측 내용 */}
        <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
          <div style={{ maxWidth: 900 }}>{content}</div>
        </div>
      </div>
    </div>
  );
}
