// 뷰어 Tools 아이콘 세트 — UBPACS p.18~21 아이콘 표 대응(인라인 SVG)
// [3D 볼륨 레시피 v2] 라인아트가 아닌 '면 기반 볼륨 오브젝트'로 렌더한다.
//  ① 주 형태 FILLED + 좌상단 광원 그라디언트(밝은 톤 → 어두운 톤, x1y1=0,0 → x2y2=1,1)
//  ② 스펙큘러 하이라이트: 흰색 저투명(0.5) 작은 타원(아이콘별 좌표, 상단·좌측 배치)
//  ③ 캐스트 섀도: feDropShadow(dx 0, dy 1.2, blur 1.3, rgba(0,0,0,0.5))
//  ④ 깊이: +0.7px 오프셋 압출(어두운 엣지색 사본, 하단·우측) + -0.45px 밝은 림 사본(상단·좌측)
//  ⑤ 그룹 컬러: Common=스틸블루 #b9cdea→#3f5a86 · Anno=앰버 #ffd98a→#9a6b1f
//  ⑥ flat(ty_icon_3d 꺼짐): 3D 레이어 전부 생략, currentColor 단색 실루엣(필요시 flat 오버라이드)
//  ⑦ 실루엣(형태 의미)은 기존 아이콘과 동일 — 입체화만. 13~28px 가독 유지(미세 디테일 금지)
//  ⑧ gradient/filter id = useId() + 콜론 제거 sanitize → 인스턴스 충돌 방지
import { useId, type ReactNode } from "react";

// ── 그룹 컬러 팔레트(⑤) ──────────────────────────────────────────────
type GrpKey = "common" | "anno";
const GRP: Record<GrpKey, { hi: string; lo: string; rim: string; edge: string }> = {
  // hi=그라디언트 상단(좌상), lo=하단(우하), rim=밝은 림(활성 파란 배경 식별용), edge=압출/디테일 어두운색
  common: { hi: "#b9cdea", lo: "#3f5a86", rim: "#e2ecfa", edge: "#223650" },
  anno: { hi: "#ffd98a", lo: "#9a6b1f", rim: "#ffedc2", edge: "#503608" },
};

// 스트로크 기반 파트 공용 프리셋(페인트는 개별 지정)
const LN = { fill: "none", strokeLinecap: "round", strokeLinejoin: "round" } as const;

interface IconDef {
  /** 그룹 컬러 키(⑤) */
  g: GrpKey;
  /** 볼륨 본체 — p 를 fill(면)/stroke(두꺼운 스트로크 파트) 페인트로 사용. 그라디언트 url 또는 currentColor */
  body: (p: string) => ReactNode;
  /** 내부 디테일(렌즈·눈금·X 등) — 3D 전용, 어두운 엣지색 수신 */
  detail?: (edge: string) => ReactNode;
  /** 스펙큘러 하이라이트 [cx, cy, rx, ry, rotate?] — 3D 전용(②) */
  spec?: readonly [number, number, number, number, number?];
  /** flat 전용 실루엣 오버라이드(가독 목적, 없으면 body(currentColor)) */
  flat?: (c: string) => ReactNode;
}

const ICONS: Record<string, IconDef> = {
  // ── Common (스틸블루) ──────────────────────────────────────────────
  // Select(포인터) — 클래식 커서 화살표 볼륨. 선택 모드. zoom/pan 과 동일 그룹·레시피(크기 일치)
  select: {
    g: "common",
    body: (p) => (
      <path fill={p} d="M5.5 3 L5.5 17.6 L9 14.3 L11.5 20.2 L13.6 19.3 L11.1 13.4 L16.2 13 Z" />
    ),
    spec: [7.8, 7.2, 1.6, 0.8, -52],
  },
  zoom: {
    g: "common",
    body: (p) => (
      <g>
        <circle cx="10" cy="10" r="6.4" fill={p} />
        <line x1="15" y1="15" x2="20.2" y2="20.2" {...LN} stroke={p} strokeWidth="3.2" />
      </g>
    ),
    detail: (c) => (
      <g {...LN} stroke={c} strokeWidth="1.7">
        <line x1="7.2" y1="10" x2="12.8" y2="10" />
        <line x1="10" y1="7.2" x2="10" y2="12.8" />
      </g>
    ),
    spec: [7.9, 7.4, 2.2, 1.2, -30],
  },
  pan: {
    g: "common",
    body: (p) => (
      <path
        fill={p}
        d="M12 2 L15.1 5.4 H13.7 V10.3 H18.6 V8.9 L22 12 L18.6 15.1 V13.7 H13.7 V18.6 H15.1 L12 22 L8.9 18.6 H10.3 V13.7 H5.4 V15.1 L2 12 L5.4 8.9 V10.3 H10.3 V5.4 H8.9 Z"
      />
    ),
    spec: [9.6, 6.4, 1.9, 1.0, -35],
  },
  fit: {
    g: "common",
    body: (p) => (
      <g>
        <rect x="8.3" y="8.3" width="7.4" height="7.4" rx="0.8" fill={p} />
        <g {...LN} stroke={p} strokeWidth="2.4">
          <polyline points="3.2,7.5 3.2,3.2 7.5,3.2" />
          <polyline points="16.5,3.2 20.8,3.2 20.8,7.5" />
          <polyline points="20.8,16.5 20.8,20.8 16.5,20.8" />
          <polyline points="7.5,20.8 3.2,20.8 3.2,16.5" />
        </g>
      </g>
    ),
    spec: [10.4, 10.1, 1.9, 1.0, -35],
  },
  inv: {
    g: "common",
    body: (p) => <circle cx="12" cy="12" r="8.6" fill={p} />,
    detail: (c) => <path d="M12 3.4 a8.6 8.6 0 0 1 0 17.2 Z" fill={c} opacity="0.85" />,
    spec: [8.4, 8.0, 2.3, 1.3, -30],
    flat: (c) => (
      <g>
        <circle cx="12" cy="12" r="8.6" fill="none" stroke={c} strokeWidth="1.8" />
        <path d="M12 3.4 a8.6 8.6 0 0 1 0 17.2 Z" fill={c} />
      </g>
    ),
  },
  rotL: {
    g: "common",
    body: (p) => (
      <g>
        <path d="M5.8 7.4 a7.4 7.4 0 1 1 -1.3 5.4" {...LN} stroke={p} strokeWidth="3" />
        <path d="M4.1 1.9 L9.8 5.7 L3.0 8.3 Z" fill={p} />
      </g>
    ),
    spec: [10.4, 4.4, 2.4, 1.0, -10],
  },
  rotR: {
    g: "common",
    body: (p) => (
      <g>
        <path d="M18.2 7.4 a7.4 7.4 0 1 0 1.3 5.4" {...LN} stroke={p} strokeWidth="3" />
        <path d="M19.9 1.9 L14.2 5.7 L21.0 8.3 Z" fill={p} />
      </g>
    ),
    spec: [10.2, 4.6, 2.4, 1.0, 10],
  },
  flipH: {
    g: "common",
    body: (p) => (
      <g>
        <path d="M9.6 7.2 L3.4 12 L9.6 16.8 Z" fill={p} />
        <path d="M14.4 7.2 L20.6 12 L14.4 16.8 Z" fill={p} />
        <line x1="12" y1="3" x2="12" y2="21" {...LN} stroke={p} strokeWidth="1.6" strokeDasharray="2.4 2.2" />
      </g>
    ),
    spec: [6.6, 10.4, 1.5, 0.9, -50],
  },
  flipV: {
    g: "common",
    body: (p) => (
      <g>
        <path d="M7.2 9.6 L12 3.4 L16.8 9.6 Z" fill={p} />
        <path d="M7.2 14.4 L12 20.6 L16.8 14.4 Z" fill={p} />
        <line x1="3" y1="12" x2="21" y2="12" {...LN} stroke={p} strokeWidth="1.6" strokeDasharray="2.4 2.2" />
      </g>
    ),
    spec: [10.6, 6.0, 1.7, 0.9, -20],
  },
  cine: {
    g: "common",
    body: (p) => (
      <path
        fill={p}
        d="M7.2 4.4 a1.2 1.2 0 0 1 1.8 -1 L20.6 10.9 a1.3 1.3 0 0 1 0 2.2 L9 20.6 a1.2 1.2 0 0 1 -1.8 -1 Z"
      />
    ),
    spec: [9.9, 7.6, 1.3, 2.4, 18],
  },
  cap: {
    g: "common",
    body: (p) => (
      <path
        fillRule="evenodd"
        fill={p}
        d="M8.2 6.8 L9.7 4.2 a1 1 0 0 1 0.9 -0.5 h2.8 a1 1 0 0 1 0.9 0.5 L15.8 6.8 H19 a2.2 2.2 0 0 1 2.2 2.2 v8.8 A2.2 2.2 0 0 1 19 20 H5 a2.2 2.2 0 0 1 -2.2 -2.2 V9 A2.2 2.2 0 0 1 5 6.8 Z M12 10.1 a3.6 3.6 0 1 0 0 7.2 a3.6 3.6 0 0 0 0 -7.2 Z"
      />
    ),
    detail: (c) => <circle cx="12" cy="13.7" r="2.1" fill={c} opacity="0.9" />,
    spec: [6.6, 9.2, 2.0, 1.0, -25],
  },
  reset: {
    g: "common",
    body: (p) => (
      <g>
        <path d="M5.2 12.6 a7.2 7.2 0 1 0 1.9 -4.8" {...LN} stroke={p} strokeWidth="3" />
        <path d="M5.9 1.9 L7.0 8.3 L12.4 5.4 Z" fill={p} />
        <circle cx="12.2" cy="12.4" r="1.9" fill={p} />
      </g>
    ),
    spec: [9.4, 4.6, 2.2, 1.0, -14],
  },
  wl: {
    g: "common",
    body: (p) => <circle cx="12" cy="12" r="8.6" fill={p} />,
    detail: (c) => (
      <path d="M12 3.4 a8.6 8.6 0 0 0 0 17.2 c-2.7 -2.7 -2.7 -14.5 0 -17.2 Z" fill={c} opacity="0.85" />
    ),
    spec: [14.8, 6.9, 2.0, 1.1, 20],
    flat: (c) => (
      <g>
        <circle cx="12" cy="12" r="8.6" fill="none" stroke={c} strokeWidth="1.8" />
        <path d="M12 3.4 a8.6 8.6 0 0 0 0 17.2 c-2.7 -2.7 -2.7 -14.5 0 -17.2 Z" fill={c} />
      </g>
    ),
  },
  all: {
    g: "common",
    body: (p) => (
      <g fill={p}>
        <rect x="3" y="3" width="8.2" height="8.2" rx="1.2" />
        <rect x="12.8" y="3" width="8.2" height="8.2" rx="1.2" />
        <rect x="3" y="12.8" width="8.2" height="8.2" rx="1.2" />
        <rect x="12.8" y="12.8" width="8.2" height="8.2" rx="1.2" />
      </g>
    ),
    spec: [5.4, 5.0, 1.7, 0.9, -30],
  },
  ohif: {
    g: "common",
    body: (p) => (
      <g>
        <rect x="2.8" y="3.6" width="18.4" height="13" rx="1.8" fill={p} />
        <g {...LN} stroke={p} strokeWidth="2.2">
          <line x1="9.2" y1="20.6" x2="14.8" y2="20.6" />
          <line x1="12" y1="16.6" x2="12" y2="20.6" />
        </g>
      </g>
    ),
    detail: (c) => (
      <g {...LN} stroke={c} strokeWidth="1.7">
        <polyline points="13,6.8 17,6.8 17,10.8" />
        <line x1="17" y1="6.8" x2="11" y2="12.8" />
      </g>
    ),
    spec: [6.8, 6.0, 2.6, 1.2, -22],
    flat: (c) => (
      <g>
        <path
          fillRule="evenodd"
          fill={c}
          d="M4.6 3.6 h14.8 a1.8 1.8 0 0 1 1.8 1.8 v9.4 a1.8 1.8 0 0 1 -1.8 1.8 H4.6 a1.8 1.8 0 0 1 -1.8 -1.8 V5.4 a1.8 1.8 0 0 1 1.8 -1.8 Z M4.8 5.6 v9 h14.4 v-9 Z"
        />
        <g {...LN} stroke={c} strokeWidth="2.2">
          <line x1="9.2" y1="20.6" x2="14.8" y2="20.6" />
          <line x1="12" y1="16.6" x2="12" y2="20.6" />
        </g>
        <g {...LN} stroke={c} strokeWidth="1.7">
          <polyline points="13,6.8 17,6.8 17,10.8" />
          <line x1="17" y1="6.8" x2="11" y2="12.8" />
        </g>
      </g>
    ),
  },
  mpr: {
    g: "common",
    body: (p) => <path d="M12 2.6 L20 7 V16 L12 20.4 L4 16 V7 Z" fill={p} />,
    detail: (c) => (
      <g>
        <path d="M4 7 L12 11.4 V20.4 L4 16 Z" fill={c} opacity="0.45" />
        <path d="M20 7 L12 11.4 V20.4 L20 16 Z" fill={c} opacity="0.7" />
        <path d="M4 7 L12 11.4 L20 7 M12 11.4 V20.4" {...LN} stroke={c} strokeWidth="1" opacity="0.8" />
      </g>
    ),
    spec: [10.2, 5.2, 2.6, 1.1, -18],
    flat: (c) => (
      <g {...LN} stroke={c} strokeWidth="1.8">
        <path d="M12 2.6 L20 7 V16 L12 20.4 L4 16 V7 Z" />
        <path d="M4 7 L12 11.4 L20 7 M12 11.4 V20.4" />
      </g>
    ),
  },
  // ── Annotation (앰버) ─────────────────────────────────────────────
  length: {
    g: "anno",
    body: (p) => <path d="M2.8 17.6 L17.6 2.8 L21.2 6.4 L6.4 21.2 Z" fill={p} />,
    detail: (c) => (
      <g {...LN} stroke={c} strokeWidth="1.5">
        <line x1="7.0" y1="13.4" x2="9.2" y2="15.6" />
        <line x1="10.6" y1="9.8" x2="12.8" y2="12.0" />
        <line x1="14.2" y1="6.2" x2="16.4" y2="8.4" />
      </g>
    ),
    spec: [9.4, 13.6, 3.4, 0.9, -45],
  },
  angle: {
    g: "anno",
    body: (p) => <path d="M3.6 20.4 L21 20.4 L16 4.4 Z" fill={p} />,
    detail: (c) => <path d="M9.6 20.4 a6 6 0 0 0 -2.3 -4.7" {...LN} stroke={c} strokeWidth="1.6" />,
    spec: [10.4, 14.2, 3.0, 0.9, -52],
  },
  rect: {
    g: "anno",
    body: (p) => <rect x="4" y="6" width="16" height="12" rx="1.2" fill={p} />,
    spec: [8.0, 8.6, 2.8, 1.2, -18],
  },
  ellipse: {
    g: "anno",
    body: (p) => <ellipse cx="12" cy="12" rx="8.8" ry="5.8" fill={p} />,
    spec: [8.4, 9.4, 2.8, 1.3, -22],
  },
  arrow: {
    g: "anno",
    body: (p) => (
      <path
        fill={p}
        d="M19.6 4.4 L18.4 9.8 L17.2 8.6 L5.3 20.5 L3.5 18.7 L15.4 6.8 L14.2 5.6 Z"
      />
    ),
    spec: [8.6, 15.0, 2.8, 0.8, -45],
  },
  text: {
    g: "anno",
    body: (p) => <path d="M4.8 4.6 H19.2 V8.4 H14 V19.4 H10 V8.4 H4.8 Z" fill={p} />,
    spec: [8.6, 6.2, 3.0, 0.9, -8],
  },
  ref: {
    g: "anno",
    body: (p) => (
      <g>
        <path
          fillRule="evenodd"
          fill={p}
          d="M12 4.8 a7.2 7.2 0 1 0 0 14.4 a7.2 7.2 0 0 0 0 -14.4 Z M12 7.6 a4.4 4.4 0 1 1 0 8.8 a4.4 4.4 0 0 1 0 -8.8 Z"
        />
        <g {...LN} stroke={p} strokeWidth="2.2">
          <line x1="12" y1="1.6" x2="12" y2="4.4" />
          <line x1="12" y1="19.6" x2="12" y2="22.4" />
          <line x1="1.6" y1="12" x2="4.4" y2="12" />
          <line x1="19.6" y1="12" x2="22.4" y2="12" />
        </g>
        <circle cx="12" cy="12" r="1.6" fill={p} />
      </g>
    ),
    spec: [8.6, 7.2, 1.8, 0.9, -35],
  },
  ctr: {
    g: "anno",
    body: (p) => (
      <g>
        <path d="M12 20 s-7 -4.5 -7 -9.5 A4 4 0 0 1 12 8 a4 4 0 0 1 7 2.5 C19 15.5 12 20 12 20 Z" fill={p} />
        <g {...LN} stroke={p} strokeWidth="2">
          <line x1="2.6" y1="12" x2="5.2" y2="12" />
          <line x1="18.8" y1="12" x2="21.4" y2="12" />
        </g>
      </g>
    ),
    spec: [8.8, 10.2, 1.9, 1.1, -25],
  },
  save: {
    g: "anno",
    body: (p) => (
      <path
        fill={p}
        d="M4.6 4.4 a1.4 1.4 0 0 1 1.4 -1.4 h10.6 L20.8 7.2 V19.6 a1.4 1.4 0 0 1 -1.4 1.4 H6 a1.4 1.4 0 0 1 -1.4 -1.4 Z"
      />
    ),
    detail: (c) => (
      <g>
        <rect x="8.2" y="3.4" width="6.8" height="4.6" rx="0.5" fill={c} opacity="0.75" />
        <rect x="7.4" y="13" width="9.2" height="7.2" rx="0.6" fill="#fff" opacity="0.4" />
      </g>
    ),
    spec: [7.2, 6.2, 2.0, 1.0, -25],
  },
  gsps: {
    g: "anno",
    body: (p) => (
      <g>
        <path d="M12 3 L20.6 7.8 L12 12.6 L3.4 7.8 Z" fill={p} />
        <g {...LN} stroke={p} strokeWidth="2.2">
          <path d="M3.8 12.6 L12 17.2 L20.2 12.6" />
          <path d="M3.8 16.6 L12 21.2 L20.2 16.6" />
        </g>
      </g>
    ),
    spec: [8.6, 6.2, 2.4, 1.0, -28],
  },
  del: {
    g: "anno",
    body: (p) => (
      <path
        fill={p}
        d="M8.6 4.8 H19.6 a1.6 1.6 0 0 1 1.6 1.6 V17.6 a1.6 1.6 0 0 1 -1.6 1.6 H8.6 a1.6 1.6 0 0 1 -1.3 -0.65 L2.6 12.6 a1 1 0 0 1 0 -1.2 L7.3 5.45 A1.6 1.6 0 0 1 8.6 4.8 Z"
      />
    ),
    detail: (c) => (
      <g {...LN} stroke={c} strokeWidth="1.8">
        <line x1="11.6" y1="9.4" x2="16.8" y2="14.6" />
        <line x1="16.8" y1="9.4" x2="11.6" y2="14.6" />
      </g>
    ),
    spec: [9.4, 7.2, 2.6, 1.0, -18],
  },
  clr: {
    g: "anno",
    body: (p) => (
      <g>
        <path d="M6 8.4 H18 L17 19.6 a1.5 1.5 0 0 1 -1.5 1.4 H8.5 A1.5 1.5 0 0 1 7 19.6 Z" fill={p} />
        <rect x="3.6" y="5.2" width="16.8" height="2.6" rx="1.3" fill={p} />
        <path d="M9.6 5.2 V4.2 a1 1 0 0 1 1 -1 h2.8 a1 1 0 0 1 1 1 v1" {...LN} stroke={p} strokeWidth="1.8" />
      </g>
    ),
    detail: (c) => (
      <g {...LN} stroke={c} strokeWidth="1.6">
        <line x1="10" y1="11" x2="10.3" y2="17.6" />
        <line x1="14" y1="11" x2="13.7" y2="17.6" />
      </g>
    ),
    spec: [8.8, 12.0, 1.1, 2.4, 8],
  },
};

export function ToolIcon({ id, size = 17, flat = false }: { id: string; size?: number; flat?: boolean }) {
  // SVG 인스턴스가 여러 개 렌더되므로 gradient/filter id 충돌 방지 — 인스턴스별 고유 id(⑧)
  const rawId = useId();
  const def = ICONS[id];
  if (!def) return null;
  // 플랫(평면) 렌더 — 설정>뷰어(TY) ty_icon_3d=false: 3D 레이어 없이 currentColor 단색 실루엣(⑥)
  if (flat) {
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden style={{ display: "block", overflow: "visible" }}>
        {def.flat ? def.flat("currentColor") : def.body("currentColor")}
      </svg>
    );
  }
  const uid = rawId.replace(/[^a-zA-Z0-9_-]/g, "");
  const gradId = `t3d-g-${uid}`;
  const shadowId = `t3d-s-${uid}`;
  const grp = GRP[def.g];
  const spec = def.spec;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden style={{ display: "block", overflow: "visible" }}>
      <defs>
        {/* ① 광원 좌상단 고정 볼륨 그라디언트(그룹 컬러) */}
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={grp.hi} />
          <stop offset="1" stopColor={grp.lo} />
        </linearGradient>
        {/* ③ 캐스트 섀도 */}
        <filter id={shadowId} x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="1.2" stdDeviation="1.3" floodColor="#000" floodOpacity="0.5" />
        </filter>
      </defs>
      <g filter={`url(#${shadowId})`}>
        {/* ④ 압출 — 어두운 사본을 하단·우측으로 오프셋(깊이) */}
        <g transform="translate(0.7 0.7)" opacity={0.9}>{def.body(grp.edge)}</g>
        {/* ⑤ 밝은 림 — 상단·좌측으로 오프셋(활성 파란 배경에서도 식별) */}
        <g transform="translate(-0.45 -0.45)" opacity={0.85}>{def.body(grp.rim)}</g>
        {/* ① 본체 — 면 기반 볼륨(그라디언트 셰이딩) */}
        {def.body(`url(#${gradId})`)}
        {/* 내부 디테일(렌즈/눈금/X 등) — 어두운 엣지색 */}
        {def.detail?.(grp.edge)}
        {/* ② 스펙큘러 하이라이트 */}
        {spec && (
          <ellipse
            cx={spec[0]}
            cy={spec[1]}
            rx={spec[2]}
            ry={spec[3]}
            fill="#fff"
            opacity={0.5}
            transform={spec[4] ? `rotate(${spec[4]} ${spec[0]} ${spec[1]})` : undefined}
          />
        )}
      </g>
    </svg>
  );
}

/** 아이콘 + 라벨 세로 스택 — 팔레트 버튼 내부 공용 */
export function ToolBtnInner({ id, label }: { id: string; label: string }) {
  return (
    <span style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, lineHeight: 1 }}>
      <ToolIcon id={id} />
      <span style={{ fontSize: 10 }}>{label}</span>
    </span>
  );
}
