// 동시 로그인 인계 감시 — /auth/session-status 를 주기 poll(하트비트 겸용).
// 다른 곳에서 인계(force) 로그인이 발생하면 revoked 신호를 받아 카운트다운 배너 후 자동 로그아웃.
import { useEffect, useRef, useState } from "react";
import { api } from "../api";

export function SessionGuard({ onLogout }: { onLogout: () => void }) {
  const [kick, setKick] = useState<{ reason: string; left: number } | null>(null);
  const kicking = useRef(false);

  // 주기 poll(3초) — revoked 감지 시 카운트다운 시작. 그 전까진 last_seen 하트비트 역할도 겸함.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (kicking.current) return;
      try {
        const s = await api.sessionStatus();
        if (alive && s.revoked) {
          kicking.current = true;
          setKick({
            reason: s.reason || "다른 곳에서 로그인됩니다. 10초 뒤에 종료됩니다.",
            left: Math.max(1, s.seconds_left || 10),
          });
        }
      } catch { /* 네트워크 일시 오류는 무시 — 다음 주기 재시도 */ }
    };
    void poll();
    const iv = setInterval(() => void poll(), 3000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  // 카운트다운 → 0 이면 로그아웃
  useEffect(() => {
    if (!kick) return;
    if (kick.left <= 0) { onLogout(); return; }
    const t = setTimeout(() => setKick((k) => (k ? { ...k, left: k.left - 1 } : k)), 1000);
    return () => clearTimeout(t);
  }, [kick, onLogout]);

  if (!kick) return null;
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "grid", placeItems: "center", zIndex: 3000 }}>
      <div style={{ background: "var(--bg-panel)", border: "1px solid var(--stat-emergency,#f87171)", borderRadius: 12,
                    padding: 28, width: 420, maxWidth: "90vw", textAlign: "center", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: "var(--stat-emergency,#f87171)" }}>다른 곳에서 로그인됨</div>
        <div style={{ fontSize: 14, lineHeight: 1.7 }}>{kick.reason}</div>
        <div style={{ fontSize: 42, fontWeight: 800, lineHeight: 1 }}>{kick.left}</div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>초 뒤 자동으로 로그아웃됩니다.</div>
        <button className="primary" onClick={onLogout} style={{ padding: "8px 0" }}>지금 로그아웃</button>
      </div>
    </div>
  );
}
