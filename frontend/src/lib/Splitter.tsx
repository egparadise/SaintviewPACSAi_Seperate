// 스플리터 — 패널 경계 드래그로 크기 조절 (Worklist·Viewer2D 공용, 계정별 서버 저장)
//
// UX: 시각 두께는 얇게(4px) 유지하되 **집을 수 있는 영역은 넓게(11px)** 잡는다.
// 예전에는 4px·opacity 0.6 이라 경계가 잘 보이지도, 잡히지도 않아 "크기 조절이 안 된다"는
// 인상을 줬다. 호버 시 강조 + 그립 점 표시로 조절 가능함을 알리고, 포인터 이벤트를 써서
// 마우스·터치·펜을 모두 지원한다. 더블클릭하면 기본 크기로 되돌린다(onReset 제공 시).
import { useState } from "react";

export function Splitter({ dir, onDrag, onEnd, onReset }: {
  dir: "v" | "h";
  onDrag: (delta: number) => void;
  onEnd: () => void;
  /** 더블클릭 초기화 — 없으면 더블클릭 무시 */
  onReset?: () => void;
}) {
  const [active, setActive] = useState(false);
  const vertical = dir === "v";   // v = 좌우 분할(세로 막대), h = 상하 분할(가로 막대)

  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    // 포인터 캡처는 '있으면 좋은' 보조 장치 — 활성 포인터가 아니면 NotFoundError 를 던진다.
    // 여기서 예외가 나면 아래 리스너 등록이 통째로 건너뛰어져 드래그가 아예 죽으므로 반드시 격리.
    // (window 리스너만으로도 드래그는 완전히 동작한다)
    try { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); } catch { /* 무시 */ }
    setActive(true);
    let last = vertical ? e.clientX : e.clientY;
    const move = (ev: PointerEvent) => {
      const cur = vertical ? ev.clientX : ev.clientY;
      onDrag(cur - last);
      last = cur;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setActive(false);
      onEnd();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const HIT = 11;          // 실제로 집히는 두께
  const LINE = 4;          // 눈에 보이는 두께
  const pad = (HIT - LINE) / 2;
  const hot = active || undefined;

  return (
    <div
      onPointerDown={start}
      onDoubleClick={onReset}
      title={`드래그=크기 조절${onReset ? " · 더블클릭=기본값" : ""} (계정에 저장)`}
      style={{
        flexShrink: 0, zIndex: 5, position: "relative",
        display: "flex", alignItems: "center", justifyContent: "center",
        // 히트영역은 넓게 잡되, 음수 마진으로 레이아웃 점유는 기존 4px 그대로 유지
        ...(vertical
          ? { width: HIT, marginLeft: -pad, marginRight: -pad, cursor: "col-resize" }
          : { height: HIT, marginTop: -pad, marginBottom: -pad, cursor: "row-resize" }),
        touchAction: "none",   // 터치 드래그가 스크롤로 가로채이지 않게
      }}
      onPointerEnter={(e) => (e.currentTarget.dataset.hover = "1")}
      onPointerLeave={(e) => delete e.currentTarget.dataset.hover}
    >
      {/* 보이는 선 */}
      <div style={{
        background: hot ? "var(--accent)" : "var(--border)",
        opacity: hot ? 1 : 0.75,
        transition: "background .12s, opacity .12s",
        ...(vertical ? { width: LINE, height: "100%" } : { height: LINE, width: "100%" }),
      }} />
      {/* 그립 점 — 조절 가능한 경계임을 시각적으로 알림 */}
      <div style={{
        position: "absolute", display: "flex", gap: 3, pointerEvents: "none",
        ...(vertical ? { flexDirection: "column" } : {}),
      }}>
        {[0, 1, 2].map((i) => (
          <span key={i} style={{
            width: 3, height: 3, borderRadius: "50%",
            background: hot ? "#fff" : "var(--text-secondary)", opacity: hot ? 0.95 : 0.55,
          }} />
        ))}
      </div>
    </div>
  );
}

export const clampSz = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
