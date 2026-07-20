// 스플리터 — 패널 경계 드래그로 크기 조절 (Worklist·Viewer2D 공용, 계정별 서버 저장)

export function Splitter({ dir, onDrag, onEnd }: {
  dir: "v" | "h"; onDrag: (delta: number) => void; onEnd: () => void;
}) {
  const start = (e: React.MouseEvent) => {
    e.preventDefault();
    let last = dir === "v" ? e.clientX : e.clientY;
    const move = (ev: MouseEvent) => {
      const cur = dir === "v" ? ev.clientX : ev.clientY;
      onDrag(cur - last);
      last = cur;
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      onEnd();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  return (
    <div onMouseDown={start} title="드래그=크기 조절 (계정에 저장)"
         style={{
           flexShrink: 0, zIndex: 5, background: "var(--border)", opacity: 0.6,
           ...(dir === "v" ? { width: 4, cursor: "col-resize" } : { height: 4, cursor: "row-resize" }),
         }} />
  );
}

export const clampSz = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
