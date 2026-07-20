// 뷰어 뷰포트 우클릭 컨텍스트 메뉴 — TY(Viewer2D)·In(ViewerInfi) 공용 렌더러.
// 초기 분석(docs/ANALYSIS_INFINITT_UserGuide.md §7): 우클릭 = 컨텍스트 메뉴.
// 항목 데이터(CtxItem)만 각 뷰어가 자기 기존 기능에 배선해 전달한다.
import { useEffect, useRef, useState } from "react";

export type CtxItem =
  | { kind?: "item"; label: string; icon?: string; checked?: boolean; disabled?: boolean;
      onClick?: () => void; children?: CtxItem[] }
  | { kind: "sep" };

const MENU_W = 210;

function MenuList({ items, onClose, depth = 0 }: { items: CtxItem[]; onClose: () => void; depth?: number }) {
  const [openSub, setOpenSub] = useState(-1);
  return (
    <div style={{
      minWidth: MENU_W, background: "var(--bg-panel, #1b2028)", border: "1px solid var(--border, #333)",
      borderRadius: 6, padding: "4px 0", boxShadow: "0 6px 22px rgba(0,0,0,0.55)", fontSize: 12.5,
    }}>
      {items.map((it, i) => {
        if (it.kind === "sep") {
          return <div key={i} style={{ height: 1, background: "var(--border, #333)", margin: "4px 6px" }} />;
        }
        const hasSub = !!it.children?.length;
        return (
          <div key={i} style={{ position: "relative" }}
               onMouseEnter={() => setOpenSub(hasSub ? i : -1)}>
            <div onClick={() => {
                   if (it.disabled || hasSub) return;
                   it.onClick?.(); onClose();
                 }}
                 style={{
                   display: "flex", alignItems: "center", gap: 7, padding: "4px 12px 4px 10px",
                   cursor: it.disabled || hasSub ? "default" : "pointer",
                   color: it.disabled ? "var(--text-secondary, #777)" : "var(--text-primary, #ddd)",
                   opacity: it.disabled ? 0.6 : 1, whiteSpace: "nowrap", userSelect: "none",
                 }}
                 onMouseOver={(e) => { if (!it.disabled) (e.currentTarget.style.background = "rgba(125,211,252,0.12)"); }}
                 onMouseOut={(e) => { e.currentTarget.style.background = "transparent"; }}>
              <span style={{ width: 13, textAlign: "center", flex: "none", color: "var(--accent, #7dd3fc)", fontSize: 11 }}>
                {it.checked ? "✔" : (it.icon ?? "")}
              </span>
              <span style={{ flex: 1 }}>{it.label}</span>
              {hasSub && <span style={{ color: "var(--text-secondary, #777)" }}>▸</span>}
            </div>
            {hasSub && openSub === i && (
              <div style={{ position: "absolute", left: "100%", top: -4, zIndex: 1, paddingLeft: 2 }}>
                <MenuList items={it.children!} onClose={onClose} depth={depth + 1} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 화면 경계 클램프 + 바깥 클릭/Escape 닫기. 항목 클릭 시 onClose 자동 호출 */
export function ViewerContextMenu({ x, y, items, onClose }:
  { x: number; y: number; items: CtxItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    // 렌더 후 실측으로 화면 밖이면 안쪽으로 이동
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - r.width - 6)),
      y: Math.max(4, Math.min(y, window.innerHeight - r.height - 6)),
    });
  }, [x, y]);

  useEffect(() => {
    // mousedown 대신 pointerdown(capture) — 뷰어의 우클릭 차단(pointerdown preventDefault)으로
    // compat mousedown 이 생성되지 않는 경우에도 바깥 클릭 닫기가 항상 동작해야 한다.
    const down = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("pointerdown", down, true); window.removeEventListener("keydown", key, true); };
  }, [onClose]);

  return (
    <div ref={ref} data-sv-ctxmenu="" style={{ position: "fixed", left: pos.x, top: pos.y, zIndex: 500 }}
         onContextMenu={(e) => e.preventDefault()}>
      <MenuList items={items} onClose={onClose} />
    </div>
  );
}
