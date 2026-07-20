// 휴대폰 촬영 페이지 (?capture=TOKEN) — 로그인 없이 토큰으로 동작. 촬영→업로드→검사 새 시리즈.
import { useEffect, useRef, useState } from "react";

export function MobileCapture({ token }: { token: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [shots, setShots] = useState<Blob[]>([]);
  const [meta, setMeta] = useState<{ patient: string; study_desc: string; modality: string } | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch(`/api/mobile-capture/${token}`).then(async (r) => {
      if (!r.ok) throw new Error(((await r.json()) as { detail?: string }).detail ?? "세션 오류");
      setMeta(await r.json());
    }).catch((e) => setMsg(e instanceof Error ? e.message : "세션 오류"));
  }, [token]);

  useEffect(() => {   // 카메라 시작/앞뒤 전환
    let alive = true;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false })
      .then((st) => {
        if (!alive) { st.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = st;
        if (videoRef.current) videoRef.current.srcObject = st;
      })
      .catch(() => setMsg("카메라 접근 실패 — 브라우저 권한을 허용하세요 (HTTPS 필요)"));
    return () => { alive = false; streamRef.current?.getTracks().forEach((t) => t.stop()); };
  }, [facing]);

  const shoot = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
    c.toBlob((b) => { if (b) setShots((p) => [...p, b]); }, "image/jpeg", 0.92);
  };
  const upload = async () => {
    if (!shots.length) return;
    setBusy(true); setMsg("");
    try {
      const fd = new FormData();
      shots.forEach((b, i) => fd.append("files", b, `photo_${i + 1}.jpg`));
      const r = await fetch(`/api/mobile-capture/${token}/upload`, { method: "POST", body: fd });
      if (!r.ok) throw new Error(((await r.json()) as { detail?: string }).detail ?? "업로드 실패");
      const j = await r.json() as { uploaded: number };
      setDone(true); setMsg(`업로드 완료 — ${j.uploaded}장이 새 시리즈로 등록됐습니다. 뷰어에서 확인하세요.`);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    } catch (e) { setMsg(e instanceof Error ? e.message : "업로드 실패"); }
    finally { setBusy(false); }
  };

  const B: React.CSSProperties = { padding: "12px 0", fontSize: 16, borderRadius: 10, flex: 1 };
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "#000", color: "#fff" }}>
      <div style={{ padding: "10px 14px", fontSize: 13, background: "#111827" }}>
        📱 Saintview 촬영 — {meta ? `${meta.patient} · ${meta.modality} ${meta.study_desc}` : "세션 확인 중…"}
      </div>
      {!done && <video ref={videoRef} autoPlay playsInline muted
                       style={{ flex: 1, minHeight: 0, objectFit: "contain", background: "#000" }} />}
      {done && <div style={{ flex: 1, display: "grid", placeItems: "center", fontSize: 15, padding: 20, textAlign: "center" }}>✅ {msg}</div>}
      {!done && (
        <>
          {shots.length > 0 && (
            <div style={{ display: "flex", gap: 6, padding: 6, overflowX: "auto", background: "#0b0f19" }}>
              {shots.map((b, i) => (
                <div key={i} style={{ position: "relative", flexShrink: 0 }}>
                  <img src={URL.createObjectURL(b)} alt="" style={{ height: 64, borderRadius: 6 }} />
                  <button onClick={() => setShots((p) => p.filter((_, k) => k !== i))}
                          style={{ position: "absolute", top: -4, right: -4, borderRadius: "50%", width: 20, height: 20, padding: 0, fontSize: 10 }}>✕</button>
                </div>
              ))}
            </div>
          )}
          {msg && <div style={{ padding: "6px 12px", fontSize: 12, color: "#f87171" }}>{msg}</div>}
          <div style={{ display: "flex", gap: 10, padding: 12, background: "#111827" }}>
            <button style={{ ...B, flex: 0.6 }} title="앞/뒤 카메라 전환"
                    onClick={() => setFacing((f) => (f === "environment" ? "user" : "environment"))}>🔄 카메라</button>
            <button className="primary" style={B} onClick={shoot}>📸 촬영 ({shots.length})</button>
            <button style={{ ...B, background: "#16a34a", color: "#fff", border: "none" }}
                    disabled={busy || !shots.length} onClick={upload}>{busy ? "업로드 중…" : "⬆ 업로드"}</button>
          </div>
        </>
      )}
    </div>
  );
}
