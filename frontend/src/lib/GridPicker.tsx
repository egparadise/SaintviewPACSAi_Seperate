// 그리드 픽커 (UBPACS 레이아웃 선택) — 호버로 N×M 지정. Worklist Thumbnail·Viewer2D 공용
import { useState } from "react";

export function GridPicker({ label, value, onPick, max = 4 }: {
  label: string;
  value: { r: number; c: number };
  onPick: (v: { r: number; c: number }) => void;
  max?: number;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState({ r: 1, c: 1 });
  return (
    <span style={{ position: "relative" }}>
      <button title={`${label} Layout — 그리드에서 선택`} onClick={() => setOpen((o) => !o)}
              style={{ padding: "2px 9px", fontSize: 11.5 }}>
        {label} {value.r}×{value.c}
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, zIndex: 350, padding: 6,
          background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 5,
          boxShadow: "0 5px 16px rgba(0,0,0,0.5)",
        }} onMouseLeave={() => setOpen(false)}>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${max}, 16px)`, gap: 2 }}>
            {Array.from({ length: max * max }, (_, i) => {
              const r = Math.floor(i / max) + 1, c = (i % max) + 1;
              const lit = r <= hover.r && c <= hover.c;
              return (
                <div key={i}
                     onMouseEnter={() => setHover({ r, c })}
                     onClick={() => { onPick({ r, c }); setOpen(false); }}
                     style={{
                       width: 16, height: 14, borderRadius: 2, cursor: "pointer",
                       background: lit ? "var(--accent)" : "var(--bg-canvas)",
                       border: "1px solid var(--border)",
                     }} />
              );
            })}
          </div>
          <div style={{ fontSize: 10.5, textAlign: "center", marginTop: 3, color: "var(--text-secondary)" }}>
            {hover.r} × {hover.c}
          </div>
        </div>
      )}
    </span>
  );
}
