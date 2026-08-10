/* 협진 미디어 권한·장치 패널(2026-08-10 사용자 확정) — 협진 창 하단 + 설정>협진 **같은
 * 컴포넌트**(두 곳이 갈리면 안내가 어긋난다). 하는 일:
 *   · 마이크/카메라 권한 상태 표시(허용됨/차단됨/요청 필요) + 허용 요청 버튼
 *   · 마이크 입력 레벨 테스트 — "켜져는 있는데 소리가 안 가는" 경우를 눈으로 확인
 *   · 카메라/화면 공유 동작 확인(트랙 즉시 정지 — 점유하지 않는다)
 *   · 장치 선택(이 PC 저장) — webrtcMesh 가 다음 켤 때부터 사용
 * 차단(denied)은 웹 코드로 풀 수 없다 — 주소창 사이트 설정 안내가 유일한 해법이라 안내를 표시한다. */
import { useCallback, useEffect, useRef, useState } from "react";
import { t as tr, useLang } from "../lib/i18n";
import {
  CAM_DEV_KEY, MIC_DEV_KEY, type MediaDeviceLists, type PermState,
  listMediaDevices, probeDevice, probeMicLevel, probeScreen, queryPerm,
} from "../lib/mediaPerms";

function PermChip({ state }: { state: PermState }) {
  const [bg, fg, label] =
    state === "granted" ? ["rgba(34,197,94,0.15)", "var(--stat-final, #22c55e)", tr("허용됨")]
    : state === "denied" ? ["rgba(248,113,113,0.15)", "var(--stat-emergency, #f87171)", tr("차단됨")]
    : state === "prompt" ? ["rgba(250,204,21,0.15)", "#eab308", tr("요청 필요")]
    : ["var(--bg-elevated)", "var(--text-secondary)", tr("알 수 없음")];
  return (
    <span style={{ fontSize: 10.5, fontWeight: 700, padding: "1px 8px", borderRadius: 8,
                   background: bg, color: fg }}>{label}</span>
  );
}

export function MediaPermPanel({ compact = false }: { compact?: boolean }) {
  useLang();
  const [openC, setOpenC] = useState(!compact);   // compact(협진 창 하단)는 접힌 채 시작
  const [mic, setMic] = useState<PermState>("unknown");
  const [cam, setCam] = useState<PermState>("unknown");
  const [devs, setDevs] = useState<MediaDeviceLists>({ mics: [], cams: [] });
  const [micSel, setMicSel] = useState(() => localStorage.getItem(MIC_DEV_KEY) ?? "");
  const [camSel, setCamSel] = useState(() => localStorage.getItem(CAM_DEV_KEY) ?? "");
  const [msg, setMsg] = useState("");
  const [level, setLevel] = useState(0);
  const [busy, setBusy] = useState("");
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const refresh = useCallback(async () => {
    const [m, c, d] = await Promise.all([queryPerm("microphone"), queryPerm("camera"), listMediaDevices()]);
    if (!alive.current) return;
    setMic(m); setCam(c); setDevs(d);
  }, []);
  useEffect(() => { if (openC) void refresh(); }, [openC, refresh]);

  const run = async (label: string, work: () => Promise<{ ok: boolean; msg: string }>) => {
    if (busy) return;
    setBusy(label); setMsg("");
    const r = await work();
    if (!alive.current) return;
    setBusy("");
    // 오류 문구는 mediaPerms 가 한국어 원문으로 주고 여기서 tr()(동적) — 사전에 등재돼 있어 번역된다
    setMsg(r.ok ? `${label} — ${tr("정상입니다")}` : `${label} — ${tr(r.msg)}`);
    void refresh();   // 허용 직후 라벨·상태가 채워진다
  };

  const testMic = () => run(tr("마이크"), async () => {
    const r = await probeMicLevel((v) => { if (alive.current) setLevel(v); });
    if (!r.ok) return r;
    if (r.max === 0) return { ok: false, msg: tr("입력이 감지되지 않습니다 — OS 음소거·입력 볼륨·장치 선택을 확인하세요.") };
    return { ok: true, msg: "" };
  });

  const saveDev = (key: string, v: string, set: (s: string) => void) => {
    set(v);
    try { if (v) localStorage.setItem(key, v); else localStorage.removeItem(key); } catch { /* 무시 */ }
    setMsg(tr("저장했습니다 — 다음에 켤 때부터 이 장치를 사용합니다."));
  };

  const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" };
  return (
    <div style={{ borderTop: compact ? "1px solid var(--border)" : undefined,
                  padding: compact ? "4px 6px" : 0, fontSize: 12 }}>
      {compact && (
        <button onClick={() => setOpenC((o) => !o)}
                style={{ width: "100%", textAlign: "left", fontSize: 11.5, padding: "3px 6px",
                         background: "transparent", border: "none", color: "var(--text-secondary)", cursor: "pointer" }}
                title={tr("마이크·카메라·화면 공유가 동작하지 않을 때 여기서 확인하세요")}>
          {openC ? "▾" : "▸"} 🎙 {tr("미디어 권한·장치")}
        </button>
      )}
      {openC && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: compact ? "2px 4px" : 0 }}>
          <div style={row}>
            <span style={{ minWidth: 74 }}>{tr("마이크")}</span><PermChip state={mic} />
            <button disabled={!!busy} onClick={() => void testMic()} style={{ fontSize: 11 }}>
              {busy === tr("마이크") ? tr("확인 중…") : tr("허용·테스트")}
            </button>
            {devs.mics.length > 0 && (
              <select value={micSel} onChange={(e) => saveDev(MIC_DEV_KEY, e.target.value, setMicSel)}
                      style={{ fontSize: 11, maxWidth: 180 }}>
                <option value="">{tr("기본 장치")}</option>
                {devs.mics.map((d, i) => (
                  <option key={d.deviceId || i} value={d.deviceId}>{d.label || `${tr("마이크")} ${i + 1}`}</option>
                ))}
              </select>
            )}
          </div>
          {/* 입력 레벨 바 — 말하면 차오른다. 0 이면 권한이 아니라 입력(음소거·볼륨) 문제다 */}
          <div style={{ height: 6, borderRadius: 3, background: "var(--bg-elevated)", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${level}%`, background: level > 5 ? "var(--stat-final, #22c55e)" : "var(--border)",
                          transition: "width 60ms linear" }} />
          </div>
          <div style={row}>
            <span style={{ minWidth: 74 }}>{tr("카메라")}</span><PermChip state={cam} />
            <button disabled={!!busy} onClick={() => void run(tr("카메라"), () => probeDevice("cam"))} style={{ fontSize: 11 }}>
              {busy === tr("카메라") ? tr("확인 중…") : tr("허용·테스트")}
            </button>
            {devs.cams.length > 0 && (
              <select value={camSel} onChange={(e) => saveDev(CAM_DEV_KEY, e.target.value, setCamSel)}
                      style={{ fontSize: 11, maxWidth: 180 }}>
                <option value="">{tr("기본 장치")}</option>
                {devs.cams.map((d, i) => (
                  <option key={d.deviceId || i} value={d.deviceId}>{d.label || `${tr("카메라")} ${i + 1}`}</option>
                ))}
              </select>
            )}
          </div>
          <div style={row}>
            <span style={{ minWidth: 74 }}>{tr("화면 공유")}</span>
            <button disabled={!!busy} onClick={() => void run(tr("화면 공유"), probeScreen)} style={{ fontSize: 11 }}>
              {busy === tr("화면 공유") ? tr("확인 중…") : tr("동작 확인")}
            </button>
            <span style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>
              {tr("공유할 화면을 고르는 창이 뜨면 정상입니다")}
            </span>
          </div>
          {(mic === "denied" || cam === "denied") && (
            <div style={{ fontSize: 11, lineHeight: 1.6, color: "var(--stat-emergency)" }}>
              {tr("차단은 웹에서 풀 수 없습니다 — 주소창의 자물쇠(사이트 설정)에서 마이크/카메라를 '허용'으로 바꾸고 새로고침하세요. Windows 라면 설정 > 개인 정보 > 마이크/카메라 허용도 확인하세요.")}
            </div>
          )}
          {msg && (
            <div style={{ fontSize: 11, color: msg.includes(tr("정상입니다")) || msg.includes(tr("저장했습니다 — 다음에 켤 때부터 이 장치를 사용합니다."))
                                              ? "var(--stat-final)" : "var(--stat-emergency)" }}>
              {msg}
            </div>
          )}
          <div style={{ fontSize: 10.5, color: "var(--text-secondary)", lineHeight: 1.6 }}>
            {tr("테스트는 장치를 잠깐 열었다 바로 놓습니다(통화를 점유하지 않음). 상대 화면이 계속 '연결 중'이면 양쪽 모두 여기서 권한을 확인한 뒤 다시 걸어 보세요.")}
          </div>
        </div>
      )}
    </div>
  );
}
