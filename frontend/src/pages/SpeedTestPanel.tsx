// 영상 열기 속도 진단 — 실서버(원격 접속)에서 병목이 어느 구간인지 직접 지목한다.
//
// 왜 필요한가: 개발 PC(localhost)와 실제 배포 환경은 병목이 다르다. 원격에서는
//   브라우저 → (인터넷) → B 서버 → (인터넷) → A 서버   처럼 홉이 겹치고,
// 빌드 모드·TLS·회선·프리페치 상태에 따라 체감이 크게 갈린다.
// 이 패널은 **실제 뷰어가 하는 것과 같은 순서**로 각 구간을 재서 표로 보여준다.
import { useEffect, useRef, useState } from "react";
import { api, isLiveId, type StudyRow } from "../api";
import { t as tr, useLang } from "../lib/i18n";
import { DICOMWEB_ROOT, renderedParams } from "../lib/imageFormat";
import { renderedRootFor } from "../lib/liveUids";

type Step = { name: string; ms: number; detail: string; warn?: boolean };

const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);

export function SpeedTestPanel() {
  useLang();
  const [rows, setRows] = useState<StudyRow[]>([]);
  const [sel, setSel] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [verdict, setVerdict] = useState<string>("");
  const [env, setEnv] = useState<Record<string, string>>({});
  const abort = useRef(false);

  // 검사 목록 — 현재 모드(Live/일반)의 워크리스트에서 앞쪽 몇 건
  useEffect(() => {
    const live = localStorage.getItem("sv_server_mode") === "live";
    const p = live ? api.liveWorklist({ limit: 20 }) : api.worklist({ limit: "20" });
    p.then((r) => { setRows(r.items); if (r.items[0]) setSel(r.items[0].id); }).catch(() => {});
    // 환경 정보 — 빌드 모드·회선·프로토콜
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const c = (navigator as Navigator & { connection?: { effectiveType?: string; downlink?: number } }).connection;
    setEnv({
      "접속 주소": location.origin,
      "프로토콜": nav?.nextHopProtocol || "-",
      "빌드 모드": document.querySelector('script[src*="/@vite/client"]') ? "개발(dev) ⚠" : "프로덕션",
      "회선(추정)": c?.downlink ? `${c.downlink}Mbps / ${c.effectiveType ?? "-"}` : "브라우저 미제공",
      "데이터 소스": localStorage.getItem("sv_server_mode") === "live" ? "Live(원격 PACS 직결)" : "로컬 서버",
    });
  }, []);

  const run = async () => {
    if (!sel) return;
    setBusy(true); setSteps([]); setVerdict(""); abort.current = false;
    const out: Step[] = [];
    let srvGzip: boolean | null = null;      // 서버 압축 판정(null=판정 불가)
    const push = (s: Step) => { out.push(s); setSteps([...out]); };
    const t = () => performance.now();
    try {
      // ① 서버 왕복 기준선(RTT) — 가장 작은 응답으로 순수 왕복 측정
      let t0 = t();
      await fetch(`${location.origin}/api/health`, { cache: "no-store" }).catch(() => {});
      const rtt = t() - t0;
      push({ name: "① 서버 왕복(RTT)", ms: rtt, warn: rtt > 150,
             detail: rtt > 150 ? "회선 지연이 큼 — 이후 모든 단계에 가산됨" : "정상" });

      // ② 검사 메타 조회
      t0 = t();
      const d = await api.study(sel);
      push({ name: "② 검사 정보(study)", ms: t() - t0, detail: `${d.modality} ${d.patient_name}` });

      // ③ 시리즈 트리 — 인스턴스 수에 비례
      t0 = t();
      const tree = await api.seriesTree(sel);
      const nInst = tree.series.reduce((a, s) => a + s.instances.length, 0);
      const tTree = t() - t0;
      push({ name: "③ 시리즈 목록(series-tree)", ms: tTree, warn: tTree > 800,
             detail: `${tr("시리즈")} ${tree.series.length} · ${tr("인스턴스")} ${nInst}` });

      const s0 = tree.series.find((s) => s.instances.length) ?? tree.series[0];
      if (!s0?.instances.length) { setVerdict(tr("영상 시리즈가 없습니다.")); setBusy(false); return; }
      const mid = s0.instances[Math.floor(s0.instances.length / 2)];

      // ④ 첫 프레임(서버 렌더 + 전송) — 뷰어가 실제로 쓰는 URL 그대로
      const root = renderedRootFor(tree.study_uid, DICOMWEB_ROOT);
      const url = `${root}/studies/${tree.study_uid}/series/${s0.series_uid}/instances/${mid.sop_uid}/rendered`
                + renderedParams(false);
      t0 = t();
      // credentials: 픽셀 GET 은 HttpOnly 쿠키(sv_pix)로 인증한다 — 같은 출처면 기본값과
      // 동작이 같지만, 명시해 두면 API 를 다른 호스트에 둔 배치에서도 자격이 붙는다.
      const r1 = await fetch(url + (url.includes("?") ? "&" : "?") + `_t=${Date.now()}`,
                             { cache: "no-store", credentials: "include" });
      if (!r1.ok) {   // 401 을 '느린 영상'으로 위장하지 않는다 — 원인을 그대로 표시
        push({ name: "④ 첫 영상(콜드)", ms: t() - t0, warn: true,
               detail: r1.status === 401 ? "401 인증 실패 — 다시 로그인하세요" : `HTTP ${r1.status}` });
        setVerdict(r1.status === 401
          ? tr("영상 자격증명이 만료됐습니다. 로그아웃 후 다시 로그인하세요.")
          : `${tr("영상 요청이 실패했습니다")} (HTTP ${r1.status}).`);
        setBusy(false);
        return;
      }
      const blob = await r1.blob();
      const tFirst = t() - t0;
      const kb = blob.size / 1024;
      push({ name: "④ 첫 영상(콜드)", ms: tFirst, warn: tFirst > 1500,
             detail: `${kb.toFixed(0)}KB · ${blob.type}` });

      // ⑤ 두 번째 요청(캐시/웜) — 서버 캐시·디코드 캐시 효과
      t0 = t();
      await fetch(url + (url.includes("?") ? "&" : "?") + `_t=${Date.now()}`, { cache: "no-store" });
      const tWarm = t() - t0;
      push({ name: "⑤ 같은 영상 재요청(웜)", ms: tWarm,
             detail: tWarm < tFirst * 0.6 ? "서버 캐시 동작 중" : "캐시 효과 낮음" });

      // ⑥ 전송 속도 환산 — 이 회선에서 이 크기를 옮기는 데 걸리는 시간
      const mbps = kb * 8 / Math.max(tFirst - rtt, 1);   // KB→kb, ms → Mbps 근사
      push({ name: "⑥ 실효 전송속도(추정)", ms: 0, detail: `${mbps.toFixed(1)} Mbps` });

      // ⑦ 서버 전송 설정 — 실서버에서 gzip 이 꺼진 채 823KB 를 그대로 보내던 사례가 있었다.
      //    Resource Timing 의 transferSize(실제 전송) vs decodedBodySize(압축 해제 후)로 판별한다.
      const js = performance.getEntriesByType("resource")
        .filter((e) => /\/assets\/.*\.js$/.test(e.name)) as PerformanceResourceTiming[];
      const big = js.slice().sort((a, b) => b.decodedBodySize - a.decodedBodySize)[0];
      if (big && big.decodedBodySize > 0) {
        // transferSize 0 = 캐시 적중(전송 없음) → 압축 판정 불가
        const cached = big.transferSize === 0;
        const ratio = cached ? 0 : big.transferSize / big.decodedBodySize;
        const raw = big.decodedBodySize / 1024;
        srvGzip = cached ? null : ratio < 0.85;
        push({
          name: "⑦ 서버 압축(gzip)", ms: 0, warn: srvGzip === false,
          detail: cached ? tr("캐시 적중 — 판정 불가(강력 새로고침 후 재측정)")
            : srvGzip ? `${tr("적용됨")} — ${raw.toFixed(0)}KB → ${(big.transferSize / 1024).toFixed(0)}KB`
            : `❌ ${tr("꺼짐")} — ${raw.toFixed(0)}KB ${tr("무압축 전송")}`,
        });
      }

      // ── 판정 ──
      const isLive = isLiveId(sel);
      const v: string[] = [];
      if (env["빌드 모드"]?.includes("개발")) {
        v.push(tr("🔴 **개발(dev) 모드로 서빙 중** — 새 창마다 수 MB 모듈을 내려받습니다.") + " "
             + tr("서버에서 `start_viewer_suite.bat`(인자 없이)로 재기동해 프로덕션 빌드로 전환하세요."));
      }
      if (rtt > 150) v.push(`🟠 서버 왕복이 ${fmt(rtt)}로 큽니다 — 회선/거리 영향. 단계마다 이 시간이 더해집니다.`);
      if (tTree > 800) v.push(`🟠 시리즈 목록이 ${fmt(tTree)} — 인스턴스 ${nInst}건. 대용량 검사입니다.`);
      if (kb > 1500 && blob.type.includes("png")) {
        v.push(`🔴 첫 영상이 **${kb.toFixed(0)}KB PNG** 입니다. 설정 > 병원 설정 > 뷰어 영상 형식을 `
             + `**JPEG(품질 90)** 으로 바꾸면 통상 5~10배 작아집니다.`);
      }
      if (isLive && tFirst > 1000) {
        v.push(tr("🟠 Live(원격 직결) 모드입니다 — 첫 열람은 B가 A에서 원본을 받아 디코드합니다.") + " "
             + tr("두 번째부터는 캐시로 빨라집니다(⑤ 참고)."));
      }
      if (srvGzip === false) {
        v.push(tr("🔴 **서버 gzip 이 꺼져 있습니다** — 앱 번들이 무압축으로 전송됩니다(약 4배).") + " "
             + tr("영상 이전에 화면이 뜨는 것 자체가 늦어집니다. 서버에서 아래 한 줄이면 됩니다:") + "\n"
             + "  sudo sh deploy/patch_nginx.sh --apply " + location.origin + "\n"
             + "  (Windows nginx: powershell -File deploy\\apply_nginx.ps1 -NginxDir C:\\nginx)");
      }
      if (!v.length) v.push(`${tr("🟢 정상 — 첫 영상까지")} ${fmt(tFirst)}. ${tr("목표(DR 1s·CT 3s) 내입니다.")}`);
      setVerdict(v.join("\n\n"));
    } catch (e) {
      setVerdict(`${tr("측정 실패:")} ${e instanceof Error ? e.message : String(e)}`);
    } finally { setBusy(false); }
  };

  const total = steps.filter((s) => s.ms > 0 && !s.name.startsWith("⑤") && !s.name.startsWith("⑥"))
                     .reduce((a, s) => a + s.ms, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.7 }}>
        {tr("실제 뷰어가 영상을 여는 순서 그대로 각 구간을 측정합니다.")}
        <b> {tr("지금 접속한 이 서버·이 회선 기준")}</b>{tr("이라, 원격 배포 환경의 병목을 그대로 보여줍니다.")}
      </div>

      {/* 환경 */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 10 }}>
        <b style={{ fontSize: 12 }}>{tr("실행 환경")}</b>
        <table style={{ width: "100%", fontSize: 12, marginTop: 6 }}>
          <tbody>
            {Object.entries(env).map(([k, v]) => (
              <tr key={k}>
                <td style={{ width: 110, color: "var(--text-secondary)", padding: "2px 0" }}>{tr(k)}</td>
                <td style={{ color: v.includes("⚠") ? "var(--stat-emergency)" : undefined, fontWeight: v.includes("⚠") ? 700 : 400 }}>{tr(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 대상 선택 + 실행 */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{tr("측정할 검사")}</span>
        <select value={sel} onChange={(e) => setSel(Number(e.target.value))}
                style={{ flex: 1, minWidth: 260, padding: "4px 6px", fontSize: 12 }}>
          {rows.map((r) => (
            <option key={r.id} value={r.id}>
              {r.modality} · {r.patient_name || r.patient_key} · {r.study_date} · {r.study_desc}
            </option>
          ))}
          {!rows.length && <option value={0}>{tr("검사 없음")}</option>}
        </select>
        <button className="primary" disabled={busy || !sel} onClick={() => void run()}
                style={{ padding: "5px 18px", fontWeight: 700 }}>
          {busy ? tr("측정 중…") : tr("▶ 속도 측정")}
        </button>
      </div>

      {/* 결과 */}
      {steps.length > 0 && (
        <table className="grid-table" style={{ width: "100%", fontSize: 12 }}>
          <thead><tr><th style={{ textAlign: "left" }}>{tr("구간")}</th><th style={{ width: 90 }}>{tr("시간")}</th><th>{tr("비고")}</th></tr></thead>
          <tbody>
            {steps.map((s) => (
              <tr key={s.name}>
                <td>{tr(s.name)}</td>
                <td style={{ fontWeight: 700, color: s.warn ? "var(--stat-emergency)" : undefined }}>
                  {s.ms > 0 ? fmt(s.ms) : "—"}
                </td>
                <td style={{ color: "var(--text-secondary)" }}>{tr(s.detail)}</td>
              </tr>
            ))}
            <tr>
              <td><b>{tr("영상이 뜨기까지(①~④ 합)")}</b></td>
              <td><b style={{ color: total > 3000 ? "var(--stat-emergency)" : "#22c55e" }}>{fmt(total)}</b></td>
              <td style={{ color: "var(--text-secondary)" }}>{tr("브라우저 창 부팅 시간은 제외")}</td>
            </tr>
          </tbody>
        </table>
      )}

      {verdict && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 12, fontSize: 12.5,
                      lineHeight: 1.8, background: "var(--bg-canvas)", whiteSpace: "pre-wrap" }}>
          {verdict}
        </div>
      )}
    </div>
  );
}
