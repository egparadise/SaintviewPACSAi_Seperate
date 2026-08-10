// 공유 표면 마크업 — 여러 명이 **한 화면 위에** 동시에 그린다.
//
// 어디에 쓰나: 공유 화면(WebRTC 픽셀) 위, 그리고 공유 화이트보드 위. 뷰어 영상(pane)은
// 이미 Viewer2D 의 주석 계통이 담당하므로 여기 오지 않는다 — 그쪽은 계측값·이미지 좌표
// 같은 판독 의미가 붙지만, 여기 마크는 "여기 보세요/이렇게" 라는 **소통**이다.
//
// ■ 좌표는 전부 **프레임 정규화(0~1)** 로 주고받는다
//   창 크기·모니터 해상도가 좌석마다 다르므로 픽셀을 보내면 서로 다른 곳을 가리킨다.
//   변환은 lib/collabSurface 의 frameBox/toFrame/fromFrame 한 곳에서만 한다
//   (그 규칙은 tests/collab_surface_rule.test.mjs 가 고정한다).
//
// ■ 색은 **작성자**가 정한다
//   colorOf(by) — 커서·비디오 타일 테두리·참가자 목록과 같은 함수다. 누가 무엇을 했는지
//   화면만 보고 알 수 있어야 한다는 것이 다학제의 요구였다.
import { useCallback, useEffect, useRef, useState } from "react";
import { colorOf, type SessionAnno } from "../lib/collabState";
import {
  fromFrame, laserAlpha, toFrame, type FrameBox, type MarkLife, type Surface,
} from "../lib/collabSurface";
import { t as tr } from "../lib/i18n";
import type { RemoteCursor } from "../lib/useCollab";

/** 마크 도구. pane(뷰어) 쪽 계측 도구와 이름이 겹치지만 의미는 '소통용 도형'이다. */
export type MarkTool = "pointer" | "pen" | "line" | "arrow" | "rect" | "ellipse" | "text";

/** 점 2개로 정의되는 도형인가 — 드래그로 그린다(pen 은 자취 전체를 담는다). */
const TWO_POINT: ReadonlySet<string> = new Set(["line", "arrow", "rect", "ellipse"]);
/** 자취를 이 간격(정규화) 이상 움직였을 때만 점을 추가 — 512점 상한(서버)을 아끼려는 것.
 *  너무 크면 각지고, 너무 작으면 짧은 획 하나로 상한을 다 쓴다. */
const PEN_MIN_STEP = 0.004;

export interface MarkupOverlayProps {
  surface: Surface;
  /** element 안에서 실제로 그릴 수 있는 사각형(px). 화이트보드는 element 전체,
   *  공유 화면은 레터박스를 뺀 영상 부분 — 부모가 frameBox() 로 구해서 준다. */
  box: FrameBox;
  /** 이 표면의 마크만. 부모가 useCollab.annosOf(surface) 로 걸러 준다. */
  marks: SessionAnno[];
  /** 이 표면을 보고 있는 사람들의 커서(pid === surface 로 걸러진 것) */
  cursors: RemoteCursor[];
  meId: number;
  tool: MarkTool;
  life: MarkLife;
  /** 권한이 없으면 보기만 — 커서는 계속 보낸다(가리키는 것은 조작이 아니다). */
  canDraw: boolean;
  onAdd: (a: Omit<SessionAnno, "id" | "by">) => void;
  onRemove: (id: string) => void;
  /** 프레임 정규화 좌표. 부모가 스로틀해서 보낸다. */
  onCursor: (x: number, y: number) => void;
}

interface Draft { kind: string; pts: number[][] }

export function MarkupOverlay({
  surface, box, marks, cursors, meId, tool, life, canDraw,
  onAdd, onRemove, onCursor,
}: MarkupOverlayProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [textAt, setTextAt] = useState<{ x: number; y: number } | null>(null);
  const [textVal, setTextVal] = useState("");
  // 레이저 페이드용 시계. **렌더 중에 Date.now() 를 부르지 않는다** — 순수하지 않은 값이
  // 렌더마다 달라져 React 가 결과를 재사용할 수 없다(react-hooks/purity). 레이저가 없으면
  // 타이머도 없다. 0 은 "아직 안 잼" = alpha 1(불투명)로 안전하게 떨어진다.
  const [now, setNow] = useState(0);
  const hasLaser = marks.some((m) => m.life === "laser");
  useEffect(() => {
    if (!hasLaser) return;
    const id = window.setInterval(() => setNow(Date.now()), 120);
    return () => window.clearInterval(id);
  }, [hasLaser]);

  const drawable = box.w > 0 && box.h > 0;
  const myColor = colorOf(meId);

  /** 포인터 이벤트 → 프레임 정규화. clamp 는 드래그 **중**에만(손이 여백으로 나가도
   *  획이 끊기면 안 된다). 시작할 때 여백이면 null 이라 아무 일도 안 일어난다. */
  const at = useCallback((e: { clientX: number; clientY: number }, clamp: boolean) => {
    const host = hostRef.current;
    if (!host) return null;
    const r = host.getBoundingClientRect();
    return toFrame(e.clientX - r.left, e.clientY - r.top, box, clamp);
  }, [box]);

  const px = useCallback(
    (p: number[]) => fromFrame(p[0] ?? 0, p[1] ?? 0, box), [box]);

  // ── 그리기 ────────────────────────────────────────────────────────────────
  const onDown = (e: React.PointerEvent) => {
    if (!canDraw || !drawable || tool === "pointer" || e.button !== 0) return;
    const p = at(e, false);
    if (!p) return;                       // 검은 여백 — 아무 데도 안 가리키는 마크 금지
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (tool === "text") { setTextAt({ x: p[0], y: p[1] }); setTextVal(""); return; }
    setDraft({ kind: tool, pts: [p] });
  };

  const onMove = (e: React.PointerEvent) => {
    const p = at(e, !!draft);
    if (p) onCursor(p[0], p[1]);
    if (!draft || !p) return;
    setDraft((d) => {
      if (!d) return d;
      if (TWO_POINT.has(d.kind)) return { ...d, pts: [d.pts[0], p] };
      const last = d.pts[d.pts.length - 1];
      if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < PEN_MIN_STEP) return d;
      return { ...d, pts: [...d.pts, p] };
    });
  };

  const onUp = () => {
    if (!draft) return;
    const d = draft;
    setDraft(null);
    // 점 하나짜리(=클릭만 하고 뗌)는 버린다. 다만 pen 의 짧은 점 찍기는 의미가 있으므로
    // 두 점 도형만 거른다 — 길이 0 인 화살표는 아무것도 가리키지 않는다.
    if (TWO_POINT.has(d.kind) && d.pts.length < 2) return;
    onAdd({ kind: d.kind, points: d.pts, surface, life });
  };

  const commitText = () => {
    const v = textVal.trim();
    const spot = textAt;
    setTextAt(null); setTextVal("");
    if (!v || !spot) return;
    onAdd({ kind: "text", points: [[spot.x, spot.y]], text: v, surface, life });
  };

  // ── 그리기(렌더) ──────────────────────────────────────────────────────────
  const shape = (m: SessionAnno | (Draft & { by?: number; life?: string; at?: number }),
                 key: string, mine: boolean) => {
    const by = "by" in m && m.by != null ? m.by : meId;
    const color = colorOf(by);
    const pts = ("points" in m ? m.points : m.pts) ?? [];
    if (!pts.length) return null;
    const alpha = laserAlpha(m as { life?: string; at?: number }, now);
    if (alpha <= 0) return null;
    const [x0, y0] = px(pts[0]);
    const [x1, y1] = px(pts[pts.length - 1]);
    // 지우개 대신: 내 마크를 클릭하면 지운다(도구를 하나 줄인다).
    // 남의 것은 못 지운다 — 서버도 거절하므로 UI 에서 미리 막는 편이 낫다.
    const hit: React.CSSProperties = {
      cursor: mine ? "pointer" : "default",
      pointerEvents: mine ? "stroke" : "none",
    };
    const id = "id" in m ? m.id : "";
    const common = {
      stroke: color, strokeWidth: 2.5, fill: "none", opacity: alpha,
      strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
      style: hit,
      onClick: mine && id ? () => onRemove(id) : undefined,
    };
    switch (m.kind) {
      case "pen":
        return <polyline key={key} {...common}
                         points={pts.map((p) => px(p).join(",")).join(" ")} />;
      case "line":
        return <line key={key} {...common} x1={x0} y1={y0} x2={x1} y2={y1} />;
      case "arrow":
        return (
          <g key={key} opacity={alpha}>
            <line {...common} opacity={1} x1={x0} y1={y0} x2={x1} y2={y1}
                  markerEnd={`url(#mk-${by})`} />
          </g>
        );
      case "rect":
        return <rect key={key} {...common} x={Math.min(x0, x1)} y={Math.min(y0, y1)}
                     width={Math.abs(x1 - x0)} height={Math.abs(y1 - y0)} />;
      case "ellipse":
        return <ellipse key={key} {...common} cx={(x0 + x1) / 2} cy={(y0 + y1) / 2}
                        rx={Math.abs(x1 - x0) / 2} ry={Math.abs(y1 - y0) / 2} />;
      case "text":
        return (
          <text key={key} x={x0} y={y0} fill={color} opacity={alpha}
                fontSize={14} fontWeight={600} paintOrder="stroke"
                stroke="#000" strokeWidth={3} strokeLinejoin="round"
                style={common.style} onClick={common.onClick}>
            {"text" in m ? m.text : ""}
          </text>
        );
      default:
        return null;
    }
  };

  // 화살촉은 색마다 하나씩 필요하다(SVG marker 는 stroke 색을 상속하지 않는다)
  const arrowOwners = [...new Set([meId, ...marks.map((m) => m.by)])];

  return (
    <div ref={hostRef}
         onPointerDown={onDown} onPointerMove={onMove}
         onPointerUp={onUp} onPointerCancel={onUp}
         onPointerLeave={() => { if (draft) onUp(); }}
         style={{ position: "absolute", inset: 0, zIndex: 20, touchAction: "none",
                  // pointer 도구일 때는 아래(비디오 등)로 이벤트를 흘린다.
                  // 다만 커서 공유를 위해 이동은 받아야 하므로 완전히 끄지는 않는다.
                  cursor: canDraw && tool !== "pointer" ? "crosshair" : "default" }}>
      <svg width="100%" height="100%" style={{ position: "absolute", inset: 0,
                                               pointerEvents: "none", display: "block" }}>
        <defs>
          {arrowOwners.map((id) => (
            <marker key={id} id={`mk-${id}`} viewBox="0 0 10 10" refX="9" refY="5"
                    markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill={colorOf(id)} />
            </marker>
          ))}
        </defs>
        <g style={{ pointerEvents: "auto" }}>
          {marks.map((m) => shape(m, m.id, m.by === meId))}
        </g>
        {draft && shape({ ...draft, by: meId, life }, "draft", false)}
      </svg>

      {/* 원격 커서 — 아이디를 뒤에 달고 그 사람 색으로. 참가자 자신과 구성원 모두가
          누가 어디를 보고 있는지 알아야 한다는 것이 이 기능의 출발점이었다. */}
      {cursors.map((c) => {
        const [cx, cy] = fromFrame(c.x, c.y, box);
        const color = colorOf(c.id);
        return (
          <div key={c.id} style={{ position: "absolute", left: cx, top: cy, zIndex: 22,
                                   pointerEvents: "none",
                                   transition: "left .06s linear, top .06s linear" }}>
            <svg width="14" height="18" viewBox="0 0 14 18" style={{ display: "block" }}>
              <path d="M1 1 L1 15 L4.5 11.5 L7 17 L9.5 16 L7 10.5 L12 10.5 Z"
                    fill={color} stroke="#000" strokeWidth="1" />
            </svg>
            <span style={{ background: color, color: "#000", fontSize: 10, padding: "0 4px",
                           borderRadius: 3, whiteSpace: "nowrap", fontWeight: 600 }}>
              {c.name}
            </span>
          </div>
        );
      })}

      {/* 텍스트 입력 — 클릭한 자리에 바로. prompt() 를 쓰면 그리는 흐름이 끊긴다 */}
      {textAt && (() => {
        const [tx, ty] = fromFrame(textAt.x, textAt.y, box);
        return (
          <input autoFocus value={textVal} onChange={(e) => setTextVal(e.target.value)}
                 onBlur={commitText}
                 onKeyDown={(e) => {
                   if (e.key === "Enter") { e.preventDefault(); commitText(); }
                   else if (e.key === "Escape") { setTextAt(null); setTextVal(""); }
                   e.stopPropagation();       // 뷰어 단축키가 가로채지 않게
                 }}
                 placeholder={tr("입력 후 Enter")}
                 style={{ position: "absolute", left: tx, top: ty - 10, zIndex: 23,
                          minWidth: 120, fontSize: 13, fontWeight: 600, color: myColor,
                          background: "rgba(0,0,0,.75)", border: `1px solid ${myColor}`,
                          borderRadius: 3, padding: "1px 4px" }} />
        );
      })()}

      {!drawable && (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center",
                      color: "var(--text-muted)", fontSize: 12, pointerEvents: "none" }}>
          {tr("화면을 기다리는 중…")}
        </div>
      )}
    </div>
  );
}
