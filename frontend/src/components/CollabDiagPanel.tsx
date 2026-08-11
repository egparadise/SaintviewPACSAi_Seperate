// Setting > 협진 > 연결 문제 보기 — 로그 · 문제점 · 해결 방법을 한 화면에서.
//
// 왜 필요한가: 서버가 협진을 막고 있어도 **우리 시스템 안에는 흔적이 없었다**. nginx 가
// WebSocket 업그레이드를 거부하면 요청이 백엔드에 도달조차 못 하므로 백엔드 로그에는
// 아무것도 없다 — "로그를 봐도 아무 일도 없었던 것처럼" 보인다. 그래서 현장에서는
// 판독의가 "연결이 안 돼요" 라고만 말하고 관리자는 확인할 방법이 없었다.
//
// 세 층을 한 화면에 쌓는다:
//   ① 지금 이 창   — 브라우저에서 관측되는 것(HTTPS·정책·WS·TURN)
//   ② 서버 자가 점검 — 백엔드가 스스로 아는 것. 🔴 accepted==0 인데 이 응답이 왔다 =
//                     REST 는 되는데 WS 만 막힌 것 = nginx 확정
//   ③ 기록된 문제   — 언제부터 누가 무엇에 막혔나(AuditLog)
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CollabDiagRow, type CollabHealth } from "../api";
import { collab } from "../lib/collab";
import {
  checkSocket, preflightMedia, type BlockItem, type MediaKind,
} from "../lib/collabPreflight";
import { t as tr } from "../lib/i18n";
import { showToast } from "../lib/toast";

const KINDS: MediaKind[] = ["microphone", "camera", "display-capture"];

function Chip({ ok, label }: { ok: boolean | null; label: string }) {
  const [bg, fg] = ok === true ? ["rgba(34,197,94,0.15)", "var(--stat-final, #22c55e)"]
    : ok === false ? ["rgba(248,113,113,0.15)", "var(--stat-emergency, #f87171)"]
    : ["var(--bg-elevated)", "var(--text-secondary)"];
  return (
    <span style={{ fontSize: 10.5, fontWeight: 700, padding: "1px 8px", borderRadius: 8,
                   background: bg, color: fg, whiteSpace: "nowrap" }}>{label}</span>
  );
}

export function CollabDiagPanel() {
  const [items, setItems] = useState<BlockItem[]>([]);
  const [health, setHealth] = useState<CollabHealth | null>(null);
  const [healthErr, setHealthErr] = useState("");
  const [log, setLog] = useState<CollabDiagRow[]>([]);
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [busy, setBusy] = useState(false);
  const [ranAt, setRanAt] = useState("");

  // ⚠ 관측(await)을 **먼저** 다 하고 setState 는 마지막에 모아서 한다.
  //   effect 본문에서 동기적으로 setState 하면 연쇄 렌더가 된다(react-hooks/set-state-in-effect).
  //   MediaPermPanel.refresh 와 같은 형태다.
  const run = useCallback(async (want: "mine" | "all") => {
    // ① 이 창에서 관측 — 세 기능을 **다** 본다. 하나만 막혀 있는 경우가 실제로 있다
    //    (Permissions-Policy 는 기능별로 지정된다: display-capture 만 금지 등).
    // ② 서버 자가 점검 — 이 호출조차 실패하면 REST 도 안 되는 것이다(WS 이전 문제).
    // ③ 기록된 문제 — 전체 조회는 서버가 관리자에게만 허용하고, 아니면 내 것으로 되돌린다.
    // 셋을 한꺼번에 기다린 뒤 **끝에서 한 번에** 반영한다 — effect 본문에서 동기 setState 를
    // 하면 연쇄 렌더가 된다(react-hooks/set-state-in-effect). MediaPermPanel.refresh 와 같은 형태.
    const [found, h, diag] = await Promise.all([
      Promise.all(KINDS.map((k) => preflightMedia(k))).then((r) => r.flat()),
      api.collabHealth().then((v) => ({ v, err: "" }))
        .catch((e: unknown) => ({ v: null as CollabHealth | null,
                                  err: e instanceof Error ? e.message : String(e) })),
      api.collabDiagList(want === "mine")
        .catch(() => ({ items: [] as CollabDiagRow[], scope: "mine" as const })),
    ]);
    const all = [...found, ...checkSocket({
      status: collab.status, everOpened: collab.everOpened,
      lastCloseCode: collab.lastCloseCode,
    })];
    // 같은 원인이 세 기능에서 세 번 나온다 — 사람이 읽을 목록에 중복은 소음이다
    const seen = new Set<string>();

    setItems(all.filter((i) => (seen.has(i.code) ? false : (seen.add(i.code), true))));
    setHealth(h.v); setHealthErr(h.err);
    setLog(diag.items); setScope(diag.scope);
    setRanAt(new Date().toLocaleTimeString());
    setBusy(false);
  }, []);

  // 열자마자 1회. 사용자는 "왜 안 되지" 를 보러 들어오는 것이지 버튼을 누르러 오지 않는다.
  // ⚠ StrictMode 는 마운트 effect 를 두 번 돌린다 — 가드가 없으면 패널을 열 때마다
  //   점검이 두 번 나간다(서버 왕복 3개 × 2). 한 번만 시작한다.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run("mine");
  }, [run]);

  const server = items.filter((i) => i.serverSide);
  // 🔴 이 판정이 이 화면의 존재 이유다. REST(=health)는 성공했는데 WS 수락이 0 이면,
  //    백엔드는 멀쩡하고 **앞단만** WebSocket 을 막고 있다는 뜻이다.
  const proxyBlocksWs = !!health && health.ws_never_accepted;

  const copyAll = () => {
    const lines = [
      `[협진 연결 진단] ${new Date().toISOString()}`,
      `origin=${window.location.origin} secure=${window.isSecureContext}`,
      health
        ? `server: proxy_proto=${health.proxy_proto || "(없음)"} ws.accepted=${health.ws.accepted}`
          + ` rej(auth/account/limit)=${health.ws.rej_auth}/${health.ws.rej_account}/${health.ws.rej_limit}`
          + ` sockets=${health.sockets}`
        : `server: 자가 점검 실패 — ${healthErr}`,
      proxyBlocksWs ? "→ REST 는 되는데 WS 수락 0건 — 앞단(nginx)이 업그레이드를 막고 있다" : "",
      "",
      ...items.map((i) => [`■ ${i.title}`, i.why, `→ ${i.action}`, i.snippet ?? ""]
        .filter(Boolean).join("\n")),
      "",
      "[기록된 문제]",
      ...log.slice(0, 20).map((r) => `${r.at ?? "?"} ${r.server_side ? "[서버]" : "[PC]"} ${r.code} ${r.title}`),
    ].filter((s) => s !== undefined).join("\n");
    void navigator.clipboard?.writeText(lines)
      .then(() => showToast(tr("복사했습니다 — 서버 관리자에게 전달하세요")))
      .catch(() => showToast(tr("복사할 수 없습니다 — 직접 선택해 복사하세요"), "error"));
  };

  return (
    <div style={{ fontSize: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <button onClick={() => { setBusy(true); void run(scope); }} disabled={busy} className="primary"
                style={{ fontSize: 11, padding: "3px 10px" }}>
          {busy ? tr("점검 중…") : tr("지금 점검")}
        </button>
        <button onClick={copyAll} style={{ fontSize: 11, padding: "3px 10px" }}>
          {tr("조치 내용 복사")}
        </button>
        {ranAt && <span style={{ fontSize: 10.5, color: "var(--text-disabled)" }}>{ranAt}</span>}
      </div>

      {/* ── 요약 ── */}
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 10 }}>
        <Chip ok={window.isSecureContext !== false} label={`HTTPS ${window.isSecureContext !== false ? "OK" : "✕"}`} />
        <Chip ok={collab.status === "open"} label={`WebSocket ${collab.status}`} />
        <Chip ok={health ? !proxyBlocksWs : null}
              label={health ? `${tr("서버 수락")} ${health.ws.accepted}` : tr("서버 점검 실패")} />
        <Chip ok={server.length === 0} label={server.length
          ? `${tr("서버 조치 필요")} ${server.length}` : tr("서버 문제 없음")} />
      </div>

      {/* 🔴 가장 중요한 단정 — 이 한 줄이 nginx 를 지목한다 */}
      {proxyBlocksWs && (
        <div style={{ padding: "7px 10px", marginBottom: 10, fontSize: 11.5, lineHeight: 1.6,
                      background: "rgba(248,113,113,0.14)", borderRadius: 6,
                      border: "1px solid rgba(248,113,113,0.4)" }}>
          <b style={{ color: "var(--stat-emergency, #f87171)" }}>
            {tr("앞단(nginx)이 WebSocket 만 막고 있습니다")}
          </b>
          <div style={{ marginTop: 3, color: "var(--text-secondary)" }}>
            {tr("이 점검은 서버 응답을 받았습니다(REST 정상). 그런데 서버가 협진 소켓을 한 번도 수락하지 못했습니다 — 업그레이드 요청이 백엔드에 도달하지 않는다는 뜻입니다.")}
          </div>
        </div>
      )}
      {healthErr && (
        <div style={{ padding: "7px 10px", marginBottom: 10, fontSize: 11.5,
                      background: "rgba(248,113,113,0.12)", borderRadius: 6 }}>
          {tr("서버 자가 점검에 실패했습니다 — REST 도 되지 않습니다(서버·네트워크 확인).")}
          <div style={{ marginTop: 2, color: "var(--text-disabled)", fontSize: 10.5 }}>{healthErr}</div>
        </div>
      )}

      {/* ── 문제점 + 해결 방법 ── */}
      {items.length === 0 && !proxyBlocksWs ? (
        <div style={{ padding: "8px 10px", borderRadius: 6, background: "rgba(34,197,94,0.12)",
                      color: "var(--stat-final, #22c55e)", marginBottom: 10 }}>
          ✓ {tr("서버가 막고 있는 것은 없습니다.")}
        </div>
      ) : items.map((it, i) => (
        <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 6, marginBottom: 8,
                              borderLeft: `4px solid ${it.serverSide
                                ? "var(--stat-emergency, #f87171)" : "#eab308"}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 9px" }}>
            <Chip ok={!it.serverSide} label={it.serverSide ? tr("서버 조치 필요") : tr("이 PC 에서 해결")} />
            <b style={{ fontSize: 12 }}>{tr(it.title)}</b>
          </div>
          {it.why && <div style={{ padding: "0 9px 5px", fontSize: 11.5, lineHeight: 1.6,
                                   color: "var(--text-secondary)" }}>{tr(it.why)}</div>}
          {it.action && <div style={{ padding: "0 9px 6px", fontSize: 11.5, lineHeight: 1.6 }}>
            → {tr(it.action)}</div>}
          {/* nginx 설정·명령은 번역하지 않는다(계약 값과 같은 성질) */}
          {it.snippet && (
            <pre style={{ margin: "0 9px 9px", padding: "7px 9px", fontSize: 10.5, lineHeight: 1.5,
                          overflowX: "auto", background: "var(--bg-elevated)",
                          border: "1px solid var(--border)", borderRadius: 4 }}>{it.snippet}</pre>
          )}
        </div>
      ))}

      {/* ── 서버 상태 상세 ── */}
      {health && (
        <details style={{ marginBottom: 10 }}>
          <summary style={{ cursor: "pointer", fontSize: 11.5, color: "var(--text-secondary)" }}>
            {tr("서버 상태 상세")}
          </summary>
          <div style={{ padding: "6px 2px", fontSize: 11, lineHeight: 1.8,
                        color: "var(--text-secondary)" }}>
            <div>X-Forwarded-Proto: <b>{health.proxy_proto || tr("(헤더 없음)")}</b>
              {health.proxy_proto && health.proxy_proto !== "https" && (
                <span style={{ color: "var(--stat-emergency, #f87171)" }}>
                  {" "}— {tr("프록시 구간이 http 입니다")}
                </span>
              )}</div>
            <div>WS: {tr("수락")} {health.ws.accepted} · {tr("종료")} {health.ws.closed}
              {" "}· {tr("오류")} {health.ws.errors}</div>
            <div>{tr("거절")}: auth {health.ws.rej_auth} · account {health.ws.rej_account}
              {" "}· limit {health.ws.rej_limit}</div>
            <div>{tr("현재 접속")}: {health.sockets} {tr("창")} / {health.accounts} {tr("명")}</div>
            {health.recent_rejects.length > 0 && (
              <div style={{ marginTop: 4 }}>
                {tr("최근 거절")}:
                {health.recent_rejects.slice(-5).map((r, i) => (
                  <div key={i} style={{ fontFamily: "monospace", fontSize: 10 }}>
                    {r.at} {r.reason} {r.ip}
                  </div>
                ))}
              </div>
            )}
          </div>
        </details>
      )}

      {/* ── 기록된 문제(로그) ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <b style={{ fontSize: 12 }}>{tr("기록된 연결 문제")}</b>
        <span style={{ fontSize: 10.5, color: "var(--text-disabled)" }}>
          {scope === "all" ? tr("전체 사용자") : tr("내 것만")}
        </span>
        <div style={{ flex: 1 }} />
        {/* 전체 조회는 서버가 관리자에게만 허용한다 — 아니면 조용히 내 것으로 돌아온다 */}
        <button onClick={() => { setBusy(true); void run(scope === "mine" ? "all" : "mine"); }}
                style={{ fontSize: 10.5, padding: "1px 7px" }}>
          {scope === "mine" ? tr("전체 보기 (관리자)") : tr("내 것만 보기")}
        </button>
      </div>
      {log.length === 0 ? (
        <div style={{ fontSize: 11.5, color: "var(--text-disabled)", padding: "4px 0" }}>
          {tr("기록된 문제가 없습니다.")}
        </div>
      ) : (
        <div style={{ border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
          {log.map((r) => (
            <div key={r.id} style={{ display: "flex", gap: 6, alignItems: "baseline",
                                     padding: "4px 8px", fontSize: 11,
                                     borderTop: "1px solid var(--border)" }}>
              <span style={{ color: "var(--text-disabled)", whiteSpace: "nowrap",
                             fontFamily: "monospace", fontSize: 10 }}>
                {r.at ? r.at.replace("T", " ").slice(0, 19) : "?"}
              </span>
              <Chip ok={!r.server_side} label={r.server_side ? tr("서버") : tr("PC")} />
              <span style={{ flex: 1 }}>{tr(r.title) || r.code}</span>
              {scope === "all" && r.who && (
                <span style={{ color: "var(--text-disabled)" }}>{r.who}</span>
              )}
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: 10.5, color: "var(--text-disabled)", marginTop: 6, lineHeight: 1.6 }}>
        {tr("이 기록은 화면이 '서버가 막고 있다'고 판정한 순간 서버에 남습니다. 같은 원인은 5분에 한 번만 기록합니다.")}
      </div>
    </div>
  );
}
