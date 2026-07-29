// WebPACS 브리지 — 인계 웹서비스(SaintViewPACS/webpacs_api)의 검사를 검색해
// 우리 Orthanc 로 가져오고(서버측 풀) 우리 뷰어로 여는 모달.
// 관리자에게는 접속 설정(원격 주소·계정·자동 동기화) 편집 섹션을 함께 노출한다.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { WebPacsConfig, WebPacsStudy } from "../api";
import { showToast } from "../lib/toast";

type ImportState = { status: string; done?: number; total?: number; error?: string | null };

export function WebPacsBrowser({ isAdmin, onOpenStudy, onImported, onClose }: {
  isAdmin: boolean;
  /** 가져오기 완료된 검사를 우리 뷰어로 열기 (내부 study id) */
  onOpenStudy: (studyId: number) => void;
  /** 워크리스트 새로고침 트리거 (가져오기 완료 시) */
  onImported: () => void;
  onClose: () => void;
}) {
  const [cfg, setCfg] = useState<WebPacsConfig | null>(null);
  const [cfgOpen, setCfgOpen] = useState(false);
  const [pw, setPw] = useState("");            // 새 비밀번호 입력(빈값=유지)
  const [testMsg, setTestMsg] = useState("");
  const [rows, setRows] = useState<WebPacsStudy[]>([]);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [imports, setImports] = useState<Record<number, ImportState>>({});
  const pollRef = useRef<Record<number, number>>({});
  // 검색 조건
  const [q, setQ] = useState("");
  const [pid, setPid] = useState("");
  const [pname, setPname] = useState("");
  const [modality, setModality] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  useEffect(() => {
    if (!isAdmin) return;
    api.webpacsConfig().then((r) => {
      setCfg(r.value);
      if (!r.value.enabled || !r.value.base_url) setCfgOpen(true);
    }).catch(() => {});
  }, [isAdmin]);

  useEffect(() => () => {   // 언마운트 시 폴링 정리
    for (const t of Object.values(pollRef.current)) window.clearInterval(t);
  }, []);

  const search = useCallback(async (offset = 0) => {
    setBusy(true);
    setErr("");
    try {
      const r = await api.webpacsStudies({
        q, patient_id: pid, patient_name: pname, modality,
        date_from: dateFrom, date_to: dateTo, limit: 50, offset,
      });
      setRows(r.items);
      setTotal(r.total);
    } catch (e) {
      setRows([]);
      setTotal(0);
      setErr(e instanceof Error ? e.message : "원격 조회 실패");
    } finally { setBusy(false); }
  }, [q, pid, pname, modality, dateFrom, dateTo]);

  useEffect(() => { void search(); }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const saveCfg = async () => {
    if (!cfg) return;
    try {
      const r = await api.webpacsSaveConfig({
        enabled: cfg.enabled, base_url: cfg.base_url, user_id: cfg.user_id,
        verify_ssl: cfg.verify_ssl, hospital_id: cfg.hospital_id,
        auto_sync: cfg.auto_sync, auto_sync_limit: cfg.auto_sync_limit,
        ...(pw ? { password: pw } : {}),
      });
      setCfg(r.value);
      setPw("");
      showToast("WebPACS 접속 설정 저장");
    } catch (e) { alert(e instanceof Error ? e.message : "저장 실패"); }
  };

  const testConn = async () => {
    setTestMsg("테스트 중…");
    try {
      const r = await api.webpacsTest();
      setTestMsg(r.ok ? `✅ 연결 성공 — 원격 검사 ${r.study_count ?? "?"}건` : `❌ ${r.detail}`);
    } catch (e) { setTestMsg(`❌ ${e instanceof Error ? e.message : "실패"}`); }
  };

  const startImport = async (row: WebPacsStudy, openAfter: boolean) => {
    const idx = row.study_idx;
    try {
      const r = await api.webpacsImport(idx);
      if (r.status === "exists" && r.study_id) {
        setRows((prev) => prev.map((x) => x.study_idx === idx
          ? { ...x, imported_study_id: r.study_id! } : x));
        if (openAfter) onOpenStudy(r.study_id);
        return;
      }
      setImports((prev) => ({ ...prev, [idx]: { status: "running", done: 0 } }));
      // 폴링 — done/exists 에서 종료, 완료 시 워크리스트 갱신(+옵션: 뷰어 오픈)
      window.clearInterval(pollRef.current[idx]);
      pollRef.current[idx] = window.setInterval(async () => {
        try {
          const st = await api.webpacsImportStatus(idx);
          setImports((prev) => ({ ...prev, [idx]: st }));
          if (st.status === "done" || st.status === "exists") {
            window.clearInterval(pollRef.current[idx]);
            if (st.study_id) {
              setRows((prev) => prev.map((x) => x.study_idx === idx
                ? { ...x, imported_study_id: st.study_id ?? null } : x));
              onImported();
              showToast(`WebPACS 가져오기 완료 — ${row.patient_name || row.patient_id}`);
              if (openAfter) onOpenStudy(st.study_id);
            }
          } else if (st.status === "error") {
            window.clearInterval(pollRef.current[idx]);
            alert(`가져오기 실패: ${st.error ?? "알 수 없는 오류"}`);
          }
        } catch { /* 다음 주기 재시도 */ }
      }, 800);
    } catch (e) { alert(e instanceof Error ? e.message : "가져오기 시작 실패"); }
  };

  const inp = { padding: "3px 6px", fontSize: 12, width: 110 } as const;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 400, background: "rgba(0,0,0,0.55)",
                  display: "flex", alignItems: "flex-start", justifyContent: "center" }}
         onClick={onClose}>
      <div style={{ marginTop: 48, width: "min(1060px, 96vw)", maxHeight: "86vh", overflow: "auto",
                    background: "var(--bg-elevated)", border: "1px solid var(--border)",
                    borderRadius: 8, padding: 14 }}
           onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <b style={{ fontSize: 14 }}>WebPACS — 인계 PACS 검사 가져오기</b>
          <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
            원격(webpacs_api) 검사를 우리 저장소로 가져와 자체 뷰어로 표시합니다
          </span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            {isAdmin && (
              <button onClick={() => setCfgOpen((v) => !v)} style={{ fontSize: 11 }}>
                ⚙ 접속 설정 {cfgOpen ? "▴" : "▾"}
              </button>
            )}
            <button onClick={onClose} style={{ fontSize: 11 }}>닫기 ✕</button>
          </span>
        </div>

        {/* ⚠ 이 접속설정은 **자체 <form> 으로 격리**한다. form 밖에 type=password 가 떠 있으면
            크롬이 문서 전체를 '주인 없는(unowned) 합성 로그인 폼'으로 묶어, 같은 문서의 이름 없는
            텍스트 필드(워크리스트 SEARCH 등)에 저장된 자격증명을 자동완성으로 채워 넣는다.
            로그인 폼이 아니므로 autoComplete="off" + new-password 로 저장 후보에서도 뺀다. */}
        {isAdmin && cfgOpen && cfg && (
          <form autoComplete="off" onSubmit={(e) => e.preventDefault()}
                style={{ margin: "10px 0", padding: 10, border: "1px solid var(--border)",
                         borderRadius: 6, display: "flex", flexWrap: "wrap", gap: 8,
                         alignItems: "center", fontSize: 12 }}>
            <label><input type="checkbox" checked={cfg.enabled}
                          onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} /> 브리지 사용</label>
            <label>원격 주소 <input style={{ ...inp, width: 240 }} placeholder="https://api.inviz.co.kr"
                                 value={cfg.base_url} name="wp-base-url" autoComplete="off"
                                 onChange={(e) => setCfg({ ...cfg, base_url: e.target.value })} /></label>
            <label>계정 ID <input style={inp} value={cfg.user_id} name="wp-user-id" autoComplete="off"
                                onChange={(e) => setCfg({ ...cfg, user_id: e.target.value })} /></label>
            <label>비밀번호 <input style={inp} type="password" name="wp-password" autoComplete="new-password"
                                placeholder={cfg.has_password ? "(저장됨 — 변경 시 입력)" : ""}
                                value={pw} onChange={(e) => setPw(e.target.value)} /></label>
            <label title="자체서명 HTTPS 원격이면 해제">
              <input type="checkbox" checked={cfg.verify_ssl}
                     onChange={(e) => setCfg({ ...cfg, verify_ssl: e.target.checked })} /> SSL 검증</label>
            <label title="워커가 주기적으로 원격 최신 검사를 자동으로 가져옵니다(≈60초)">
              <input type="checkbox" checked={cfg.auto_sync}
                     onChange={(e) => setCfg({ ...cfg, auto_sync: e.target.checked })} /> 자동 동기화</label>
            <label>최신 <input style={{ ...inp, width: 48 }} type="number" min={1} max={200}
                             value={cfg.auto_sync_limit}
                             onChange={(e) => setCfg({ ...cfg, auto_sync_limit: Number(e.target.value) || 20 })} /> 건</label>
            {/* form 안의 button 은 기본이 submit 이라 페이지가 리로드된다 — 반드시 type="button" */}
            <button type="button" onClick={saveCfg} style={{ fontSize: 11, fontWeight: 700 }}>저장</button>
            <button type="button" onClick={testConn} style={{ fontSize: 11 }}>연결 테스트</button>
            {testMsg && <span style={{ fontSize: 11 }}>{testMsg}</span>}
            <div style={{ flexBasis: "100%", color: "var(--text-secondary)", fontSize: 11 }}>
              원격 계정은 인계 PACS 의 PACS 사용자(user_type P)여야 하며, 영상은 원격 서버가
              복호화한 DICOM(DICOMweb v2)으로 수신합니다 — MinIO 암호화 키 불필요.
            </div>
          </form>
        )}

        {/* 검색 바 */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "10px 0", fontSize: 12,
                      alignItems: "center" }}>
          {/* 검색 칸에도 name/autoComplete 를 준다 — 이름 없는 텍스트 필드는 크롬 자동완성이
              username 후보로 오인해 저장된 자격증명을 채워 넣는다(SEARCH 칸 오염 사고) */}
          <input style={{ ...inp, width: 150 }} placeholder="통합 검색" value={q}
                 name="wp-q" autoComplete="off" spellCheck={false}
                 onChange={(e) => setQ(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" && void search()} />
          <input style={inp} placeholder="환자 ID" value={pid}
                 name="wp-pid" autoComplete="off" spellCheck={false}
                 onChange={(e) => setPid(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" && void search()} />
          <input style={inp} placeholder="환자 이름" value={pname}
                 name="wp-pname" autoComplete="off" spellCheck={false}
                 onChange={(e) => setPname(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" && void search()} />
          <select style={{ padding: "3px 4px", fontSize: 12 }} value={modality}
                  onChange={(e) => setModality(e.target.value)}>
            <option value="">전체 모달리티</option>
            {["CR", "DR", "DX", "CT", "MR", "US", "MG", "XA", "NM", "PT", "OT"].map((m) =>
              <option key={m} value={m}>{m}</option>)}
          </select>
          <input style={{ ...inp, width: 120 }} type="date" value={dateFrom}
                 onChange={(e) => setDateFrom(e.target.value)} title="검사일 시작" />
          ~
          <input style={{ ...inp, width: 120 }} type="date" value={dateTo}
                 onChange={(e) => setDateTo(e.target.value)} title="검사일 끝" />
          <button onClick={() => void search()} disabled={busy}
                  style={{ fontSize: 12, fontWeight: 700, padding: "3px 14px" }}>
            {busy ? "조회 중…" : "검색"}
          </button>
          <span style={{ color: "var(--text-secondary)" }}>원격 {total}건</span>
        </div>

        {err && <div style={{ color: "var(--stat-emergency)", fontSize: 12, margin: "6px 0" }}>{err}</div>}

        <table className="grid-table" style={{ width: "100%", fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ width: 46 }}>#</th><th>환자 ID</th><th>환자 이름</th>
              <th style={{ width: 34 }}>성별</th><th>검사일시</th>
              <th style={{ width: 56 }}>모달리티</th><th>검사명</th>
              <th style={{ width: 60 }}>영상수</th><th>병원</th>
              <th style={{ width: 190 }}>가져오기 / 열기</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const im = imports[r.study_idx];
              const running = im?.status === "running";
              return (
                <tr key={r.study_idx}>
                  <td>{r.study_idx}</td>
                  <td>{r.patient_id}</td>
                  <td>{r.patient_name}</td>
                  <td>{r.patient_sex}</td>
                  <td>{r.study_datetime}</td>
                  <td>{r.modality}</td>
                  <td title={r.study_uid}>{r.study_desc}</td>
                  <td>{r.series_count}S/{r.image_count}I</td>
                  <td>{r.hospital_name}</td>
                  <td>
                    {r.imported_study_id ? (
                      <button onClick={() => onOpenStudy(r.imported_study_id!)}
                              style={{ fontSize: 11, fontWeight: 700, background: "var(--accent)", color: "#fff" }}>
                        우리 뷰어로 열기
                      </button>
                    ) : running ? (
                      <span style={{ color: "var(--text-secondary)" }}>
                        가져오는 중… {im?.done ?? 0}/{im?.total ?? "?"}
                      </span>
                    ) : (
                      <span style={{ display: "flex", gap: 4 }}>
                        <button onClick={() => void startImport(r, false)} style={{ fontSize: 11 }}>가져오기</button>
                        <button onClick={() => void startImport(r, true)}
                                style={{ fontSize: 11, fontWeight: 700 }}>가져와서 열기</button>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && !busy && (
              <tr><td colSpan={10} style={{ color: "var(--text-secondary)", padding: 14 }}>
                {err ? "원격 조회 실패 — 접속 설정을 확인하세요" : "검색 결과 없음"}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
