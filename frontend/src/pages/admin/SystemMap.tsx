// 시스템 구조도 — 라이브 대시보드 (관리자 콘솔 첫 화면)
// 사용자 그림 그대로: 큰 라운드 사각(부모 컨테이너 = Admin System) 안에
// 병원별 라운드 사각(자식 컨테이너)들이 격자로 배치되는 구조를 HTML/CSS 로 표현.
// 데이터: 전부 기존 API — server.network·portalStatus·netDb·netEcho·maintStorage·
//         /api/infra/hospitals·hospitalUsage·clients (백엔드 무변경).
// 동작: 마운트 시 병렬 로드 → 60초 자동 갱신(C-ECHO 제외) → [🔍 전체 점검]=순차 C-ECHO.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api, type HospitalRow, type HospitalUsage, type InfraHospitalRow, type MaintStorage,
  type PortalStatus,
} from "../../api";

// ── 상태등 3값 (ok/bad/unknown) ──
type Tri = "ok" | "bad" | "unknown";
const triColor = (t: Tri) =>
  t === "ok" ? "var(--success,#4ade80)" : t === "bad" ? "var(--danger,#f87171)" : "var(--text-secondary,#9ca3af)";

/** 상태등 ● + 라벨 (title=툴팁 상세) */
function Lamp({ state, label, tip }: { state: Tri; label: string; tip?: string }) {
  return (
    <span title={tip ?? label} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, whiteSpace: "nowrap" }}>
      <span style={{ color: triColor(state), fontSize: 13, lineHeight: 1 }}>●</span>
      <span style={{ color: "var(--text-secondary)" }}>{label}</span>
    </span>
  );
}

/** 용량 게이지 바 — pct 0~100 (null=바 없이 텍스트만) */
function Gauge({ label, text, pct, warn }: { label: string; text: string; pct: number | null; warn?: boolean }) {
  return (
    <div title={`${label}: ${text}`} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5 }}>
      <span style={{ width: 92, color: "var(--text-secondary)", flexShrink: 0 }}>{label}</span>
      {pct != null && (
        <div style={{ flex: 1, height: 8, background: "var(--bg-canvas)", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden", minWidth: 60 }}>
          <div style={{ width: `${Math.min(100, Math.max(0, pct))}%`, height: "100%",
                        background: warn ? "var(--danger,#f87171)" : "var(--accent,#7dd3fc)", transition: "width .4s" }} />
        </div>
      )}
      <span style={{ color: "var(--text-primary)", whiteSpace: "nowrap" }}>{text}</span>
    </div>
  );
}

const fmtMb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

// ── C-ECHO 결과 캐시 (세션 내 유지 — 화면 이탈/재진입에도 이전 결과 표시) ──
type EchoRes = { ok: boolean; detail: string; at: number };
type EchoCache = { parent?: EchoRes; hosp: Record<number, EchoRes> };
const ECHO_KEY = "sv_sysmap_echo";
function loadEchoCache(): EchoCache {
  try {
    const c = JSON.parse(sessionStorage.getItem(ECHO_KEY) ?? "") as EchoCache;
    return { parent: c.parent, hosp: c.hosp ?? {} };
  } catch { return { hosp: {} }; }
}

export default function SystemMap({ onSelectHospital }: { onSelectHospital?: (hid: number) => void }) {
  // 정적 설정 + 빠른 상태
  const [net, setNet] = useState<{ ip: string; port: string; dicom_port: string; name: string; ae_title: string } | null>(null);
  const [portal, setPortal] = useState<PortalStatus | null | "error">(null); // null=미로드, "error"=조회 실패
  const [apiOk, setApiOk] = useState<Tri>("unknown");
  const [dbSt, setDbSt] = useState<{ ok: boolean; detail?: string; target?: string } | null>(null);
  const [storage, setStorage] = useState<MaintStorage | null>(null);
  const [hosps, setHosps] = useState<HospitalRow[]>([]);
  const [infra, setInfra] = useState<Record<number, InfraHospitalRow>>({});
  const [dockerOk, setDockerOk] = useState<boolean | null>(null);
  const [usage, setUsage] = useState<Record<number, HospitalUsage>>({});
  const [cli, setCli] = useState<Record<number, { online: number; total: number }>>({});
  // C-ECHO ([전체 점검] 시에만 수행 — 이전 결과 캐시 표시)
  const [echo, setEcho] = useState<EchoCache>(loadEchoCache);
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState("");
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);

  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const setEchoCached = (updater: (prev: EchoCache) => EchoCache) => {
    setEcho((prev) => {
      const next = updater(prev);
      try { sessionStorage.setItem(ECHO_KEY, JSON.stringify(next)); } catch { /* 저장 실패 무시 */ }
      return next;
    });
  };

  /** 정적 정보 + 빠른 상태(포털/API/DB/컨테이너/용량) 병렬 로드 — 실패는 우아 강등 */
  const loadAll = useCallback(async () => {
    const jobs: Promise<void>[] = [
      api.getSetting("server.network").then((r) => {
        const w = (r.value as { web?: { ip?: string; port?: number | string; dicom_port?: number | string; name?: string; ae_title?: string } }).web ?? {};
        if (alive.current) setNet({
          ip: String(w.ip ?? ""), port: String(w.port ?? ""), dicom_port: String(w.dicom_port ?? ""),
          name: String(w.name ?? ""), ae_title: String(w.ae_title ?? ""),
        });
      }).catch(() => { if (alive.current) setNet({ ip: "", port: "", dicom_port: "", name: "", ae_title: "" }); }),
      api.portalStatus().then((r) => { if (alive.current) setPortal(r); })
        .catch(() => { if (alive.current) setPortal("error"); }),
      // API 상태등 — 자기 자신(health): 공개 /api/status 성공=초록
      api.status().then(() => { if (alive.current) setApiOk("ok"); })
        .catch(() => { if (alive.current) setApiOk("bad"); }),
      api.netDb().then((r) => { if (alive.current) setDbSt(r); })
        .catch((e) => { if (alive.current) setDbSt({ ok: false, detail: (e as Error).message }); }),
      api.maintStorage().then((r) => { if (alive.current) setStorage(r); }).catch(() => {}),
      api.infraHospitals().then((r) => {
        if (!alive.current) return;
        setDockerOk(r.docker_ok);
        setInfra(Object.fromEntries(r.items.map((it) => [it.hid, it])));
      }).catch(() => { if (alive.current) setDockerOk(null); }),
    ];
    // 병원 목록 → 병원별 사용량·Client 온라인 병렬
    jobs.push(
      api.hospitals().then(async (r) => {
        if (!alive.current) return;
        setHosps(r.items);
        await Promise.all(r.items.flatMap((h) => [
          api.hospitalUsage(h.id).then((u) => { if (alive.current) setUsage((p) => ({ ...p, [h.id]: u })); }).catch(() => {}),
          api.clients(h.id).then((c) => {
            if (alive.current) setCli((p) => ({ ...p, [h.id]: { online: c.items.filter((x) => x.online).length, total: c.items.length } }));
          }).catch(() => {}),
        ]));
      }).catch(() => {}),
    );
    await Promise.all(jobs);
    if (alive.current) setLoadedAt(new Date());
  }, []);

  /** 서버 강제 제어(부모 스택·백엔드·병원 컨테이너) — 확인 후 실행, 완료 시 상태 재로드 */
  const ctl = async (e: React.MouseEvent, label: string,
                     fn: () => Promise<{ ok: boolean; detail?: string }>, warn?: string) => {
    e.stopPropagation();   // 병원 박스 클릭(탭 이동)과 분리
    if (!window.confirm(`${label} — 진행할까요?${warn ? `\n\n⚠ ${warn}` : ""}`)) return;
    setProgress(`⏳ ${label} 중…`);
    try {
      const r = await fn();
      setProgress(r.ok ? `✅ ${label} 요청됨` : `⚠ ${r.detail ?? label + " 실패"}`);
    } catch (err) { setProgress("⚠ " + (err as Error).message); }
    setTimeout(loadAll, 2500);
  };
  const ctlBtnStyle: React.CSSProperties = { padding: "1px 7px", fontSize: 11 };

  // 마운트 로드 + 60초 자동 갱신(echo 제외) — unmount 시 정리
  useEffect(() => {
    loadAll();
    const t = setInterval(loadAll, 60_000);
    return () => clearInterval(t);
  }, [loadAll]);

  /** [🔍 전체 점검] — 부모 공유 Orthanc → 각 병원 컨테이너 순차 C-ECHO (중복 클릭 가드) */
  const fullCheck = async () => {
    if (checking) return;
    setChecking(true);
    try {
      // ① 부모 공유 Orthanc — 127.0.0.1:dicom_port (설정 미비 시 포트 체계 기본값 4242)
      const dport = Number(net?.dicom_port) || 4242;
      const aet = net?.ae_title || "SAINTVIEW_AI";
      setProgress(`공유 Orthanc C-ECHO (127.0.0.1:${dport})…`);
      try {
        const r = await api.netEcho("127.0.0.1", dport, aet);
        setEchoCached((p) => ({ ...p, parent: { ok: r.ok, detail: r.detail, at: Date.now() } }));
      } catch (e) {
        setEchoCached((p) => ({ ...p, parent: { ok: false, detail: (e as Error).message, at: Date.now() } }));
      }
      // ② 병원 목록·컨테이너 레지스트리 최신화 — 마운트 직후 클릭(초기 로드 전)·포트 변경 대비.
      //    실패 시 현재 상태 폴백(우아 강등). 포트는 항상 레지스트리 entry.dicom_port 가 우선.
      const hs = await api.hospitals().then((r) => r.items).catch(() => hosps);
      const reg = await api.infraHospitals()
        .then((r) => Object.fromEntries(r.items.map((it) => [it.hid, it])) as Record<number, InfraHospitalRow>)
        .catch(() => infra);
      if (!alive.current) return;
      setHosps(hs); setInfra(reg);
      // ③ 각 병원 컨테이너 — 프로비저닝된 것만 순차 C-ECHO (4300+n 은 entry.dicom_port 로 확보)
      const targets = hs.filter((h) => { const inf = reg[h.id]; return !!inf?.provisioned && !!inf.entry; });
      for (let i = 0; i < targets.length; i++) {
        if (!alive.current) return;
        const h = targets[i];
        const entry = reg[h.id]!.entry!;
        setProgress(`병원 Echo ${i + 1}/${targets.length} — #${h.id} ${h.name || h.code} (:${entry.dicom_port})…`);
        try {
          const r = await api.netEcho("127.0.0.1", entry.dicom_port, entry.aet);
          setEchoCached((p) => ({ ...p, hosp: { ...p.hosp, [h.id]: { ok: r.ok, detail: r.detail, at: Date.now() } } }));
        } catch (e) {
          setEchoCached((p) => ({ ...p, hosp: { ...p.hosp, [h.id]: { ok: false, detail: (e as Error).message, at: Date.now() } } }));
        }
      }
    } finally {
      if (alive.current) { setChecking(false); setProgress(""); }
    }
  };

  // ── 부모 상태등 계산 ──
  const portalTri: Tri = portal === null ? "unknown" : portal === "error" ? "bad"
    : portal.error ? "bad" : portal.running ? "ok" : "unknown";
  const portalTip = portal && portal !== "error"
    ? `Web 진입점 ${portal.host}:${portal.port} — ${portal.error ? `오류: ${portal.error}` : portal.running ? "실행 중" : "중지"}`
    : portal === "error" ? "포털 리스너 상태 조회 실패" : "조회 중…";
  const dbTri: Tri = dbSt == null ? "unknown" : dbSt.ok ? "ok" : "bad";
  const echoTri = (r?: EchoRes): Tri => (r == null ? "unknown" : r.ok ? "ok" : "bad");
  const echoTip = (name: string, r?: EchoRes) =>
    r == null ? `${name} — 미점검 ([🔍 전체 점검]으로 확인)`
      : `${name} — ${r.ok ? "C-ECHO 성공" : "C-ECHO 실패"} · ${r.detail} (${new Date(r.at).toLocaleTimeString()})`;

  // ── 용량 게이지 값 ──
  const st = storage;
  const diskTotal = st?.image.disk_total_gb ?? 0;
  const diskFree = st?.image.disk_free_gb ?? 0;
  const diskUsedPct = diskTotal > 0 ? ((diskTotal - diskFree) / diskTotal) * 100 : null;
  const dbPct = st && diskTotal > 0 ? (st.db.size_mb / (diskTotal * 1024)) * 100 : null;

  // ── 스타일 (다크 테마 CSS 변수 — 굵은 라운드 보더) ──
  const parentBox: React.CSSProperties = {
    border: "3px solid var(--accent,#7dd3fc)", borderRadius: 20, padding: 16,
    background: "var(--bg-panel)", display: "flex", flexDirection: "column", gap: 12,
  };
  const childBase: React.CSSProperties = {
    borderRadius: 14, padding: "10px 12px", width: 262, display: "flex", flexDirection: "column", gap: 6,
    background: "var(--bg-canvas)", cursor: onSelectHospital ? "pointer" : undefined,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* 툴바 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>🗺️ 시스템 구조도 — 라이브</div>
        <div style={{ flex: 1 }} />
        {progress && <span style={{ fontSize: 12, color: "var(--accent,#7dd3fc)" }}>⏳ {progress}</span>}
        <button className="primary" disabled={checking} onClick={fullCheck}
                title="부모 공유 Orthanc → 각 병원 컨테이너 순서로 C-ECHO 를 수행합니다">
          {checking ? "점검 중…" : "🔍 전체 점검"}
        </button>
        <button onClick={loadAll} disabled={checking}>새로고침</button>
        <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
          {loadedAt ? `갱신 ${loadedAt.toLocaleTimeString()} · 60초 자동` : "불러오는 중…"}
        </span>
      </div>

      {/* ══ 부모 컨테이너 — Admin System ══ */}
      <div style={parentBox}>
        {/* 헤더: 설정값 + 상태등 + 부모 서버 강제 제어 */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 700, fontSize: 13.5 }}>🌐 Admin System — 부모 컨테이너</div>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            {net ? <>
              {net.name || "이름 미설정"} · 진입점 <code>{net.ip || "?"}:{net.port || "9000"}</code>
              &nbsp;· AE <code>{net.ae_title || "SAINTVIEW_AI"}</code> · DICOM Port <code>{net.dicom_port || "4242"}</code>
            </> : "설정 불러오는 중…"}
          </span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 5 }}>
            <button style={ctlBtnStyle} title="메인 docker 스택(DB·Orthanc·OHIF) 전체 시작"
                    onClick={(e) => ctl(e, "부모 스택 전체 시작", () => api.infraMainAction("start"))}>▶ 전체 시작</button>
            <button style={ctlBtnStyle} title="메인 docker 스택 전체 재시작"
                    onClick={(e) => ctl(e, "부모 스택 전체 재시작", () => api.infraMainAction("restart"))}>⟳ 재시작</button>
            <button style={ctlBtnStyle} title="메인 docker 스택 전체 중지 — DB 중지 시 프로그램 전체가 동작하지 않습니다"
                    onClick={(e) => ctl(e, "부모 스택 전체 중지", () => api.infraMainAction("stop"),
                                        "DB·Orthanc·OHIF 가 모두 내려갑니다 — 프로그램이 동작하지 않게 됩니다")}>■ 전체 중지</button>
            <button style={ctlBtnStyle} title="백엔드 API 프로세스 재시작 (약 5초 순단 후 자동 재접속)"
                    onClick={(e) => ctl(e, "백엔드 재시작", () => api.serverControl("restart"),
                                        "재시작 동안 몇 초간 접속이 끊깁니다")}>⟳ 백엔드</button>
          </span>
        </div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <Lamp state={portalTri} tip={portalTip}
                label={`Web 진입점${portal && portal !== "error" ? ` ${portal.host}:${portal.port}` : ""}`} />
          <Lamp state={apiOk} label="API" tip={apiOk === "ok" ? "API 서버 응답 정상 (health)" : apiOk === "bad" ? "API 응답 실패" : "확인 중…"} />
          <Lamp state={dbTri} label="DB"
                tip={dbSt ? (dbSt.ok ? `DB 연결 정상${dbSt.target ? ` — ${dbSt.target}` : ""}` : `DB 오류 — ${dbSt.detail ?? ""}`) : "확인 중…"} />
          <Lamp state={echoTri(echo.parent)} label="공유 Orthanc DICOM"
                tip={echoTip(`공유 Orthanc (127.0.0.1:${net?.dicom_port || "4242"})`, echo.parent)} />
          {dockerOk === false && <span style={{ fontSize: 11.5, color: "var(--danger,#f87171)" }}>⚠ docker 미가용 — 컨테이너 상태는 레지스트리 기준</span>}
        </div>

        {/* 용량 게이지 — DB·Image + Backup 한 줄 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 5, maxWidth: 560 }}>
          {st ? <>
            <Gauge label="DB 공간" pct={dbPct} text={fmtMb(st.db.size_mb)} />
            <Gauge label="Image Storage" pct={diskUsedPct} warn={diskUsedPct != null && diskUsedPct > 90}
                   text={`${fmtMb(st.image.size_mb)} · 디스크 여유 ${diskFree.toFixed(1)}/${diskTotal.toFixed(1)} GB`} />
            <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
              Backup: {fmtMb(st.backup.size_mb)}{st.backup.quota_gb ? ` / 상한 ${st.backup.quota_gb} GB` : ""} · {st.backup.path || "경로 미설정"}
            </div>
          </> : <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>⚠ 저장 공간 정보 미수신</div>}
        </div>

        {/* ══ 자식 컨테이너 격자 — 병원별 ══ */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 4 }}>
          {hosps.map((h) => {
            const inf = infra[h.id];
            const provisioned = !!inf?.provisioned && !!inf.entry;
            const contTri: Tri = !provisioned ? "unknown" : inf!.state === "running" ? "ok" : inf!.state === "exited" ? "bad" : "unknown";
            const u = usage[h.id];
            const c = cli[h.id];
            const er = echo.hosp[h.id];
            return (
              <div key={h.id}
                   style={{ ...childBase, border: provisioned ? "2px solid var(--border)" : "2px dashed var(--border)" }}
                   title={onSelectHospital ? "클릭 — 이 병원 관리 탭으로 이동" : undefined}
                   onClick={() => onSelectHospital?.(h.id)}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ color: triColor(contTri), fontSize: 13 }}>●</span>
                  <span style={{ fontWeight: 700, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    🏥 {h.name || h.code} <span style={{ color: "var(--text-secondary)", fontWeight: 400 }}>#{h.id}</span>
                  </span>
                  {/* 자식 서버 강제 On/Off — 프로비저닝된 병원 컨테이너만 (클릭 시 탭 이동 방지) */}
                  {provisioned && (
                    <span style={{ marginLeft: "auto", display: "flex", gap: 3 }}>
                      <button style={ctlBtnStyle} title={`${inf!.entry!.container} 시작`}
                              onClick={(e) => ctl(e, `${h.name || h.code} 컨테이너 시작`, () => api.infraHospitalAction(h.id, "start"))}>▶</button>
                      <button style={ctlBtnStyle} title={`${inf!.entry!.container} 재시작`}
                              onClick={(e) => ctl(e, `${h.name || h.code} 컨테이너 재시작`, () => api.infraHospitalAction(h.id, "restart"))}>⟳</button>
                      <button style={ctlBtnStyle} title={`${inf!.entry!.container} 중지`}
                              onClick={(e) => ctl(e, `${h.name || h.code} 컨테이너 중지`, () => api.infraHospitalAction(h.id, "stop"),
                                                  "이 병원의 DICOM 수신·조회가 중단됩니다")}>■</button>
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.6 }}>
                  {provisioned ? <>
                    컨테이너 <code>{inf!.entry!.container}</code> · <span title={inf!.status}>{inf!.state || "unknown"}</span><br />
                    AET <code>{inf!.entry!.aet}</code> · 포트 Web {inf!.entry!.web_port} / DICOM {inf!.entry!.dicom_port}
                  </> : <>
                    미프로비저닝 — <b>공유 Orthanc 사용</b><br />
                    AET <code>{h.scp_aet || h.ae_title || "—"}</code>{h.scp_port ? ` · 수신 Port ${h.scp_port}` : ""}
                  </>}
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <Lamp state={contTri} label="컨테이너"
                        tip={provisioned ? `${inf!.entry!.container} — ${inf!.status || inf!.state}` : "미프로비저닝 — 공유 Orthanc 폴백"} />
                  <Lamp state={provisioned ? echoTri(er) : "unknown"} label="Echo"
                        tip={provisioned ? echoTip(`${inf!.entry!.aet} (:${inf!.entry!.dicom_port})`, er) : "공유 Orthanc 사용 — 병원별 Echo 대상 없음"} />
                  <Lamp state={c ? (c.online > 0 ? "ok" : "unknown") : "unknown"}
                        label={`Client ${c ? `${c.online}/${c.total}` : "—"}`}
                        tip={c ? `온라인 Client ${c.online}대 / 전체 ${c.total}대` : "Client 정보 미수신"} />
                </div>
                {/* 미니 게이지 — 검사/판독 수 + storage */}
                {u ? (
                  <Gauge label={`검사 ${u.db.studies} · 판독 ${u.db.reports}`} pct={null}
                         text={`💾 ${fmtMb(u.storage.disk_mb)}${u.storage.orthanc_ok ? "" : " ⚠"}`} />
                ) : (
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>사용량 정보 없음</div>
                )}
              </div>
            );
          })}
          {hosps.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--text-secondary)", padding: 8 }}>등록된 병원이 없습니다 — [＋ 병원 등록·관리]에서 추가하세요.</div>
          )}
        </div>
      </div>

      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
        상태등: ●초록=정상 · ●빨강=오류 · ●회색=중지/미점검. C-ECHO 는 [🔍 전체 점검] 시에만 수행되며 이전 결과가 캐시 표시됩니다.
        병원 박스 클릭 = 해당 병원 관리 탭 이동.
      </div>
    </div>
  );
}
