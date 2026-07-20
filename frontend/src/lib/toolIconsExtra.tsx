// TY 팔레트 확장 아이콘 — In Viewer 이식 기능(rot180/필터 3종/확대경/Refresh/Combine/Print/Calibrate)
// + 워크플로 6종(cursor3d/pcine/key2d/media/dict/cmp).
// [3D 볼륨 레시피 v2] lib/toolIcons.tsx 와 동일 규칙(IconDef/GRP/레이어 순서)을 복제한다.
//  ① 주 형태 FILLED + 좌상단 광원 그라디언트(hi→lo, x1y1=0,0 → x2y2=1,1)
//  ② 스펙큘러 하이라이트: 흰색 0.5 작은 타원(본체 질량 상단·좌측)
//  ③ 캐스트 섀도: feDropShadow(dx 0, dy 1.2, blur 1.3, rgba(0,0,0,0.5))
//  ④ 깊이: +0.7px 압출(edge 사본, 하단·우측) + -0.45px 밝은 림 사본(상단·좌측)
//  ⑤ 그룹 컬러: Common=스틸블루 · Pixel=틸 · Workflow=바이올렛 · ETC=그린그레이
//  ⑥ flat(ty_icon_3d 꺼짐): 3D 레이어 전부 생략, currentColor 단색 실루엣(필요시 flat 오버라이드)
//  ⑦ 실루엣(형태 의미)은 기존 아이콘과 동일 — 입체화만. 13~28px 가독 유지(미세 디테일 금지)
//  ⑧ gradient/filter id = useId() + 콜론 제거 sanitize → 인스턴스 충돌 방지
// ToolIconEx 는 확장 id 우선 → 없으면 기존 ToolIcon 으로 위임한다(시그니처 불변).
import { useId, type ReactNode } from "react";
import { ToolIcon } from "./toolIcons";

// ── 그룹 컬러 팔레트(⑤) ──────────────────────────────────────────────
type GrpKey = "common" | "pixel" | "workflow" | "etc";
const GRP: Record<GrpKey, { hi: string; lo: string; rim: string; edge: string }> = {
  // hi=그라디언트 상단(좌상), lo=하단(우하), rim=밝은 림(활성 파란 배경 식별용), edge=압출/디테일 어두운색
  common: { hi: "#b9cdea", lo: "#3f5a86", rim: "#e2ecfa", edge: "#223650" },
  pixel: { hi: "#8fe3d9", lo: "#1f6f66", rim: "#c9f3ed", edge: "#123f39" },
  workflow: { hi: "#d3b8f5", lo: "#6d3fa8", rim: "#eadcfb", edge: "#3c2260" },
  etc: { hi: "#b9d4bb", lo: "#4c6b4e", rim: "#d9ead9", edge: "#2b3f2d" },
};

// 스트로크 기반 파트 공용 프리셋(페인트는 개별 지정)
const LN = { fill: "none", strokeLinecap: "round", strokeLinejoin: "round" } as const;

interface IconDef {
  /** 그룹 컬러 키(⑤) */
  g: GrpKey;
  /** 볼륨 본체 — p 를 fill(면)/stroke(두꺼운 스트로크 파트) 페인트로 사용. 그라디언트 url 또는 currentColor */
  body: (p: string) => ReactNode;
  /** 내부 디테일(렌즈·눈금·페이스 등) — 3D 전용, 어두운 엣지색 수신 */
  detail?: (edge: string) => ReactNode;
  /** 스펙큘러 하이라이트 [cx, cy, rx, ry, rotate?] — 3D 전용(②) */
  spec?: readonly [number, number, number, number, number?];
  /** flat 전용 실루엣 오버라이드(가독 목적, 없으면 body(currentColor)) */
  flat?: (c: string) => ReactNode;
}

const ICONS_EX: Record<string, IconDef> = {
  // ── Common (스틸블루) ──────────────────────────────────────────────
  // 180도 회전 — 반원 화살표 2개(위/아래)
  rot180: {
    g: "common",
    body: (p) => (
      <g>
        <path d="M5 11 a7 7 0 0 1 13.2 -3" {...LN} stroke={p} strokeWidth="3" />
        <path d="M19.2 2.3 L18.7 8.9 L12.7 7.0 Z" fill={p} />
        <path d="M19 13 a7 7 0 0 1 -13.2 3" {...LN} stroke={p} strokeWidth="3" />
        <path d="M4.8 21.7 L5.3 15.1 L11.3 17.0 Z" fill={p} />
      </g>
    ),
    spec: [8.2, 5.6, 2.2, 0.9, -14],
  },
  // Magnification — 렌즈(면) + 점선 초점
  mag: {
    g: "common",
    body: (p) => (
      <g>
        <circle cx="10.5" cy="10.5" r="6.6" fill={p} />
        <line x1="15.6" y1="15.6" x2="20.8" y2="20.8" {...LN} stroke={p} strokeWidth="3.2" />
      </g>
    ),
    detail: (c) => (
      <circle cx="10.5" cy="10.5" r="2.8" fill="none" stroke={c} strokeWidth="1.6" strokeDasharray="1.8 1.6" />
    ),
    spec: [8.3, 7.8, 2.2, 1.2, -30],
    flat: (c) => (
      <g {...LN} stroke={c}>
        <circle cx="10.5" cy="10.5" r="6.6" strokeWidth="1.8" />
        <line x1="15.6" y1="15.6" x2="20.8" y2="20.8" strokeWidth="2.6" />
        <circle cx="10.5" cy="10.5" r="2.8" strokeWidth="1.5" strokeDasharray="1.8 1.6" />
      </g>
    ),
  },
  // Refresh Exam — 순환 화살표 2개
  rfsh: {
    g: "common",
    body: (p) => (
      <g>
        <path d="M4.5 12 a7.5 7.5 0 0 1 13 -5.2" {...LN} stroke={p} strokeWidth="3" />
        <path d="M18.6 1.6 L17.8 8.0 L12.1 6.9 Z" fill={p} />
        <path d="M19.5 12 a7.5 7.5 0 0 1 -13 5.2" {...LN} stroke={p} strokeWidth="3" />
        <path d="M5.4 22.4 L6.2 16.0 L11.9 17.1 Z" fill={p} />
      </g>
    ),
    spec: [7.8, 5.4, 2.2, 0.9, -18],
  },
  // Combine Series — 두 층을 하나로(아래 화살표)
  comb: {
    g: "common",
    body: (p) => (
      <g>
        <rect x="4" y="2.8" width="16" height="4.6" rx="1" fill={p} />
        <rect x="4" y="9.2" width="16" height="4.6" rx="1" fill={p} />
        <path d="M12 21.6 L8.4 17.4 H10.6 V15 H13.4 V17.4 H15.6 Z" fill={p} />
      </g>
    ),
    spec: [6.9, 4.3, 2.3, 0.8, -8],
  },
  // ── Pixel (틸) ─────────────────────────────────────────────────────
  // Sharpen — 뾰족한 산봉우리(선명화), 우측면 셰이딩으로 입체화
  sharpen: {
    g: "pixel",
    body: (p) => <path d="M3 19 L9 5 L12.5 12 L15 8 L21 19 Z" fill={p} />,
    detail: (c) => (
      <g fill={c} opacity="0.45">
        <path d="M9 5 L12.5 12 V19 H9 Z" />
        <path d="M15 8 L21 19 H15 Z" />
      </g>
    ),
    spec: [7.0, 10.4, 2.0, 0.8, -66],
  },
  // Average(블러) — 부드러운 물결 2줄(두꺼운 스트로크 볼륨)
  average: {
    g: "pixel",
    body: (p) => (
      <g {...LN} stroke={p} strokeWidth="3">
        <path d="M3 8.8 c3 -4.4 6 -4.4 9 0 s6 4.4 9 0" />
        <path d="M3 15.8 c3 -4.4 6 -4.4 9 0 s6 4.4 9 0" />
      </g>
    ),
    spec: [6.2, 6.3, 1.9, 0.8, -24],
  },
  // Pseudo Color — 반이 채워진 원(컬러맵) + 세로 분할선
  pseudo: {
    g: "pixel",
    body: (p) => <circle cx="12" cy="12" r="8.6" fill={p} />,
    detail: (c) => (
      <g>
        <path d="M12 3.4 a8.6 8.6 0 0 1 0 17.2 Z" fill={c} opacity="0.6" />
        <line x1="12" y1="3.4" x2="12" y2="20.6" stroke={c} strokeWidth="1.4" strokeLinecap="round" />
      </g>
    ),
    spec: [8.4, 8.0, 2.3, 1.3, -30],
    flat: (c) => (
      <g>
        <circle cx="12" cy="12" r="8.6" fill="none" stroke={c} strokeWidth="1.8" />
        <path d="M12 3.4 a8.6 8.6 0 0 1 0 17.2 Z" fill={c} />
        <line x1="12" y1="3.4" x2="12" y2="20.6" stroke={c} strokeWidth="1.4" strokeLinecap="round" />
      </g>
    ),
  },
  // ── ETC (그린그레이) ───────────────────────────────────────────────
  // Print — 프린터(본체+상단 급지+하단 배지)
  print: {
    g: "etc",
    body: (p) => (
      <g>
        <path d="M7.2 8 V3.6 a0.9 0.9 0 0 1 0.9 -0.9 h7.8 a0.9 0.9 0 0 1 0.9 0.9 V8 Z" fill={p} />
        <rect x="3.4" y="7.6" width="17.2" height="8.2" rx="1.4" fill={p} />
        <rect x="7" y="13.2" width="10" height="7.6" rx="0.6" fill={p} />
      </g>
    ),
    detail: (c) => (
      <g>
        <rect x="8.2" y="14.4" width="7.6" height="5.2" rx="0.4" fill="#fff" opacity="0.4" />
        <circle cx="17.6" cy="10.4" r="0.9" fill={c} opacity="0.9" />
      </g>
    ),
    spec: [6.5, 9.6, 2.2, 1.0, -16],
    flat: (c) => (
      <g {...LN} stroke={c} strokeWidth="1.8">
        <path d="M7 7.6 V3.4 h10 v4.2" />
        <rect x="3.4" y="7.6" width="17.2" height="8.2" rx="1.4" />
        <rect x="7" y="13.2" width="10" height="7.6" />
      </g>
    ),
  },
  // Calibrate — 눈금 자
  calib: {
    g: "etc",
    body: (p) => <rect x="2.6" y="8.8" width="18.8" height="6.8" rx="1" fill={p} />,
    detail: (c) => (
      <g {...LN} stroke={c} strokeWidth="1.5">
        <line x1="6" y1="8.8" x2="6" y2="11.6" />
        <line x1="9.5" y1="8.8" x2="9.5" y2="12.8" />
        <line x1="13" y1="8.8" x2="13" y2="11.6" />
        <line x1="16.5" y1="8.8" x2="16.5" y2="12.8" />
        <line x1="20" y1="8.8" x2="20" y2="11.6" />
      </g>
    ),
    spec: [6.2, 10.2, 2.4, 0.8, -6],
    flat: (c) => (
      <g {...LN} stroke={c} strokeWidth="1.8">
        <rect x="2.6" y="8.8" width="18.8" height="6.8" rx="1" />
        <line x1="6" y1="8.8" x2="6" y2="11.6" />
        <line x1="9.5" y1="8.8" x2="9.5" y2="12.8" />
        <line x1="13" y1="8.8" x2="13" y2="11.6" />
        <line x1="16.5" y1="8.8" x2="16.5" y2="12.8" />
        <line x1="20" y1="8.8" x2="20" y2="11.6" />
      </g>
    ),
  },
  // ── Workflow (바이올렛) ────────────────────────────────────────────
  // 3D Cursor — 3D 십자 + 아이소메트릭 큐브
  cursor3d: {
    g: "workflow",
    body: (p) => (
      <g>
        <path d="M12 2 V7.4 M12 16.6 V22 M2 12 H7.4 M16.6 12 H22" {...LN} stroke={p} strokeWidth="2.6" />
        <path d="M12 7.6 L15.8 9.7 V14.3 L12 16.4 L8.2 14.3 V9.7 Z" fill={p} />
      </g>
    ),
    detail: (c) => (
      <g>
        <path d="M8.2 9.7 L12 11.8 V16.4 L8.2 14.3 Z" fill={c} opacity="0.45" />
        <path d="M15.8 9.7 L12 11.8 V16.4 L15.8 14.3 Z" fill={c} opacity="0.7" />
      </g>
    ),
    spec: [10.7, 8.8, 1.3, 0.7, -20],
  },
  // 페인별 시네 — 페인(프레임) + 재생 삼각(컴파운드 패스 구멍 → flat 에서도 유지)
  pcine: {
    g: "workflow",
    body: (p) => (
      <path
        fillRule="evenodd"
        fill={p}
        d="M4.2 4.4 h15.6 a1.6 1.6 0 0 1 1.6 1.6 v12 a1.6 1.6 0 0 1 -1.6 1.6 H4.2 a1.6 1.6 0 0 1 -1.6 -1.6 v-12 a1.6 1.6 0 0 1 1.6 -1.6 Z M9.8 8.2 v7.6 l6.6 -3.8 Z"
      />
    ),
    spec: [7.2, 6.6, 2.3, 1.0, -20],
  },
  // 입체 열쇠 — 링(도넛) + 샤프트 + 이빨(nonzero 컴파운드 패스)
  key2d: {
    g: "workflow",
    body: (p) => (
      <path
        fill={p}
        d="M6.4 7.4 a4.6 4.6 0 0 1 0 9.2 a4.6 4.6 0 0 1 0 -9.2 Z M6.4 10.3 a1.7 1.7 0 0 0 0 3.4 a1.7 1.7 0 0 0 0 -3.4 Z M10.4 10.6 H21.4 V13.4 H19.6 V16.4 H17.4 V13.4 H16 V15.6 H13.8 V13.4 H10.4 Z"
      />
    ),
    spec: [5.0, 9.7, 1.6, 0.9, -32],
  },
  // Media — 필름 스트립(퍼포레이션 + 프레임 창, evenodd 구멍)
  media: {
    g: "workflow",
    body: (p) => (
      <path
        fillRule="evenodd"
        fill={p}
        d="M4.2 4.8 h15.6 a1.4 1.4 0 0 1 1.4 1.4 v11.6 a1.4 1.4 0 0 1 -1.4 1.4 H4.2 a1.4 1.4 0 0 1 -1.4 -1.4 V6.2 a1.4 1.4 0 0 1 1.4 -1.4 Z M4.8 6.3 h2.4 v1.7 H4.8 Z M10.8 6.3 h2.4 v1.7 h-2.4 Z M16.8 6.3 h2.4 v1.7 h-2.4 Z M4.8 16 h2.4 v1.7 H4.8 Z M10.8 16 h2.4 v1.7 h-2.4 Z M16.8 16 h2.4 v1.7 h-2.4 Z M4.8 9.6 h6.6 v4.8 H4.8 Z M12.6 9.6 h6.6 v4.8 h-6.6 Z"
      />
    ),
    spec: [5.8, 5.5, 2.0, 0.6, -6],
  },
  // Dictation — 마이크(캡슐+크래들+스탠드)
  dict: {
    g: "workflow",
    body: (p) => (
      <g>
        <rect x="9" y="2.6" width="6" height="11" rx="3" fill={p} />
        <path d="M5.6 11.4 a6.4 6.4 0 0 0 12.8 0" {...LN} stroke={p} strokeWidth="2.4" />
        <line x1="12" y1="18" x2="12" y2="21" {...LN} stroke={p} strokeWidth="2.4" />
        <line x1="8.6" y1="21.2" x2="15.4" y2="21.2" {...LN} stroke={p} strokeWidth="2.4" />
      </g>
    ),
    detail: (c) => (
      <g {...LN} stroke={c} strokeWidth="1.3" opacity="0.85">
        <line x1="9.8" y1="5.8" x2="14.2" y2="5.8" />
        <line x1="9.8" y1="8.2" x2="14.2" y2="8.2" />
      </g>
    ),
    spec: [10.6, 4.6, 1.3, 0.8, -24],
  },
  // Compare — 양방향 화살(⇄) 비교
  cmp: {
    g: "workflow",
    body: (p) => (
      <g fill={p}>
        <path d="M14.6 4.2 L21 8.3 L14.6 12.4 V9.9 H4.4 V6.7 H14.6 Z" />
        <path d="M9.4 11.6 L3 15.7 L9.4 19.8 V17.3 H19.6 V14.1 H9.4 Z" />
      </g>
    ),
    spec: [8.2, 7.3, 2.5, 0.8, -6],
  },
  // 작업 히스토리(◀◯▶ Undo/Redo) — 반시계 순환 화살표 + 시계 디스크(시침·분침)
  hist: {
    g: "workflow",
    body: (p) => (
      <g>
        <path d="M4.8 12.8 a7.6 7.6 0 1 0 2.0 -5.0" {...LN} stroke={p} strokeWidth="3" />
        <path d="M5.5 2.3 L6.6 8.6 L12.0 5.7 Z" fill={p} />
        <circle cx="12.3" cy="12.7" r="4.7" fill={p} />
      </g>
    ),
    detail: (c) => (
      <g {...LN} stroke={c} strokeWidth="1.5">
        <line x1="12.3" y1="12.7" x2="12.3" y2="9.9" />
        <line x1="12.3" y1="12.7" x2="14.5" y2="14.0" />
      </g>
    ),
    spec: [10.4, 10.3, 1.6, 0.9, -30],
  },
  // Crosslink — 사슬 링크 2개 + 연결 바
  xlink: {
    g: "workflow",
    body: (p) => (
      <g {...LN} stroke={p}>
        <path d="M10.2 7.3 L12.6 4.9 a4.3 4.3 0 0 1 6.1 6.1 L16.3 13.4" strokeWidth="2.8" />
        <path d="M13.8 16.7 L11.4 19.1 a4.3 4.3 0 0 1 -6.1 -6.1 L7.7 10.6" strokeWidth="2.8" />
        <line x1="9.4" y1="14.6" x2="14.6" y2="9.4" strokeWidth="2.4" />
      </g>
    ),
    spec: [14.4, 6.4, 1.7, 0.8, -45],
  },
  // 딕테이션 재생 — 스피커(면) + 음파 2줄(두꺼운 스트로크)
  dictplay: {
    g: "workflow",
    body: (p) => (
      <g>
        <path fill={p} d="M3.2 9.2 h3.2 L11.6 4.8 V19.2 L6.4 14.8 H3.2 Z" />
        <g {...LN} stroke={p} strokeWidth="2.2">
          <path d="M14.6 8.6 a4.4 4.4 0 0 1 0 6.8" />
          <path d="M17.6 6.2 a8.2 8.2 0 0 1 0 11.6" />
        </g>
      </g>
    ),
    spec: [7.6, 7.6, 1.5, 0.9, -35],
  },
};

/** 확장 아이콘 우선 렌더 — 없으면 기존 ToolIcon 위임. 3D/flat 렌더 규칙은 toolIcons.tsx 와 동일 */
export function ToolIconEx({ id, size = 17, flat = false }: { id: string; size?: number; flat?: boolean }) {
  // SVG 인스턴스가 여러 개 렌더되므로 gradient/filter id 충돌 방지 — 인스턴스별 고유 id(⑧)
  const rawId = useId();
  const def = ICONS_EX[id];
  if (!def) return <ToolIcon id={id} size={size} flat={flat} />;
  // 플랫(평면) 렌더 — 설정>뷰어(TY) ty_icon_3d=false: 3D 레이어 없이 currentColor 단색 실루엣(⑥)
  if (flat) {
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden style={{ display: "block", overflow: "visible" }}>
        {def.flat ? def.flat("currentColor") : def.body("currentColor")}
      </svg>
    );
  }
  const uid = rawId.replace(/[^a-zA-Z0-9_-]/g, "");
  const gradId = `t3dx-g-${uid}`;
  const shadowId = `t3dx-s-${uid}`;
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
        {/* 내부 디테일(렌즈/눈금/페이스 등) — 어두운 엣지색 */}
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
