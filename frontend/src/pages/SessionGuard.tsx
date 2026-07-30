// 동시 로그인 인계 감시 — /auth/session-status 를 주기 poll(하트비트 겸용).
// 다른 곳에서 인계(force) 로그인이 발생하면 revoked 신호를 받아 카운트다운 배너 후 자동 로그아웃.
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { pollWithGuard } from "../lib/netLimit";

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
      } catch (e) {
        // 여기서 삼키면 pollWithGuard 가 '성공' 으로 보고 간격을 안 늘린다.
        // 서버가 아플 때 같은 속도로 계속 때리는 것이 바로 문제였다 → 위로 올린다.
        throw e;
      }
    };
    // ⚠ setInterval 로 3초마다 그냥 쏘면 **직전 요청이 안 끝나도 또 나간다.**
    //   이 컴포넌트는 **창마다** 산다 — 다중 모니터로 워크리스트+뷰어 4+판독창을 열면
    //   창 수만큼 곱해진다. 백엔드는 이 핸들러도 sync 라 요청당 스레드 하나를 쥐고
    //   db.commit() 까지 한다. 느려지면 쌓이고, 쌓이면 더 느려지는 되먹임이 된다
    //   (실제 증상: 영상도 못 열고 로그인도 안 되다가 한참 뒤 복구).
    //   → 겹치지 않게 하고, 실패가 이어지면 간격을 늘린다.
    const h = pollWithGuard(poll, 3000);
    return () => { alive = false; h.stop(); };
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
