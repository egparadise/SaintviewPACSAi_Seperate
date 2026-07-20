// TY-2 이식 툴 아이콘 — 측정(poly/circle/centerline/수동CTR)·주석(box/spine/marking)·
// 픽셀(lens/profile/table2d)·셔터 3종. lib/toolIconsExtra 의 EXTRA 맵은 그대로 두고
// 여기서 신규 id 를 정의한 뒤 ToolIconTy 가 신규 id 우선 → 없으면 ToolIconEx 로 위임한다.
// [3D 볼륨 레시피 v2 — lib/toolIcons.tsx 와 동일 계약]
//  ① 주 형태 FILLED + 좌상단 광원 그라디언트(밝은 톤 → 어두운 톤, x1y1=0,0 → x2y2=1,1)
//  ② 스펙큘러 하이라이트: 흰색 저투명(0.5) 작은 타원(아이콘별 좌표, 상단·좌측 배치)
//  ③ 캐스트 섀도: feDropShadow(dx 0, dy 1.2, blur 1.3, rgba(0,0,0,0.5))
//  ④ 깊이: +0.7px 오프셋 압출(어두운 엣지색 사본, 하단·우측) + -0.45px 밝은 림 사본(상단·좌측)
//  ⑤ 그룹 컬러: Anno=앰버 #ffd98a→#9a6b1f · Pixel=틸 #8fe3d9→#1f6f66 · Shutter=슬레이트 #c3ccd9→#4a5568
//  ⑥ flat(ty_icon_3d 꺼짐): 3D 레이어 전부 생략, currentColor 단색 실루엣(필요시 flat 오버라이드)
//  ⑦ 실루엣(형태 의미)은 기존 아이콘과 동일 — 입체화만. 13~28px 가독 유지(미세 디테일 금지)
//  ⑧ gradient/filter id = useId() + 콜론 제거 sanitize → 인스턴스 충돌 방지
import { useId, type ReactNode } from "react";
import { ToolIconEx } from "../lib/toolIconsExtra";

// ── 그룹 컬러 팔레트(⑤) — hi/lo=그라디언트 상하, rim=밝은 림, edge=압출/디테일 어두운색 ──
type GrpKey = "anno" | "pixel" | "shutter";
const GRP: Record<GrpKey, { hi: string; lo: string; rim: string; edge: string }> = {
  anno: { hi: "#ffd98a", lo: "#9a6b1f", rim: "#ffedc2", edge: "#503608" },
  pixel: { hi: "#8fe3d9", lo: "#1f6f66", rim: "#c9f5ee", edge: "#123f39" },
  shutter: { hi: "#c3ccd9", lo: "#4a5568", rim: "#e3e9f2", edge: "#2a3140" },
};

// 스트로크 기반 파트 공용 프리셋(페인트는 개별 지정)
const LN = { fill: "none", strokeLinecap: "round", strokeLinejoin: "round" } as const;

interface IconDef {
  /** 그룹 컬러 키(⑤) */
  g: GrpKey;
  /** 볼륨 본체 — p 를 fill(면)/stroke(두꺼운 스트로크 파트) 페인트로 사용. 그라디언트 url 또는 currentColor */
  body: (p: string) => ReactNode;
  /** 내부 디테일(눈금·격자·중심점 등) — 3D 전용, 어두운 엣지색 수신 */
  detail?: (edge: string) => ReactNode;
  /** 스펙큘러 하이라이트 [cx, cy, rx, ry, rotate?] — 3D 전용(②) */
  spec?: readonly [number, number, number, number, number?];
  /** flat 전용 실루엣 오버라이드(가독 목적, 없으면 body(currentColor)) */
  flat?: (c: string) => ReactNode;
}

const TY2: Record<string, IconDef> = {
  // ── 측정 (Anno 앰버) ─────────────────────────────────────────────
  // Polyline — 꺾은선 경로(두꺼운 스트로크) + 정점 볼륨 점
  poly: {
    g: "anno",
    body: (p) => (
      <g>
        <polyline points="3,19 8,8 13,14 20,4" {...LN} stroke={p} strokeWidth="2.6" />
        <g fill={p}>
          <circle cx="3" cy="19" r="2.1" />
          <circle cx="8" cy="8" r="2.1" />
          <circle cx="13" cy="14" r="2.1" />
          <circle cx="20" cy="4" r="2.1" />
        </g>
      </g>
    ),
    spec: [6.2, 11.6, 1.7, 0.7, -65],
  },
  // Circle 계측 — 볼륨 디스크 + 중심점·반지름선(디테일)
  circle: {
    g: "anno",
    body: (p) => <circle cx="12" cy="12" r="8.6" fill={p} />,
    detail: (c) => (
      <g>
        <circle cx="12" cy="12" r="1.6" fill={c} />
        <line x1="12" y1="12" x2="18.2" y2="6.9" {...LN} stroke={c} strokeWidth="1.7" />
      </g>
    ),
    spec: [8.4, 8.0, 2.3, 1.3, -30],
    flat: (c) => (
      <g>
        <circle cx="12" cy="12" r="8" fill="none" stroke={c} strokeWidth="1.8" />
        <circle cx="12" cy="12" r="1.4" fill={c} />
        <line x1="12" y1="12" x2="18" y2="7" {...LN} stroke={c} strokeWidth="1.8" />
      </g>
    ),
  },
  // Center Line — 두 기준 바 + 중앙선(점선은 의미선이므로 body 스트로크 파트)
  centerline: {
    g: "anno",
    body: (p) => (
      <g {...LN} stroke={p}>
        <line x1="4" y1="5" x2="20" y2="8" strokeWidth="2.6" />
        <line x1="4" y1="19" x2="20" y2="16" strokeWidth="2.6" />
        <line x1="4" y1="12" x2="20" y2="12" strokeWidth="2" strokeDasharray="2.6 2.2" />
      </g>
    ),
    spec: [7.6, 5.6, 2.4, 0.8, 10],
  },
  // 수동 CTR — 볼륨 심장 + 흉곽 폭 측정선(화살촉 면)
  mctr: {
    g: "anno",
    body: (p) => (
      <g>
        <path
          fill={p}
          d="M12 15.8 s-4.9 -3.1 -4.9 -6.4 A2.8 2.8 0 0 1 12 7.4 a2.8 2.8 0 0 1 4.9 2 C16.9 12.7 12 15.8 12 15.8 Z"
        />
        <line x1="5.2" y1="19.6" x2="18.8" y2="19.6" {...LN} stroke={p} strokeWidth="2.2" />
        <path d="M6.4 17.2 L2.9 19.6 L6.4 22 Z" fill={p} />
        <path d="M17.6 17.2 L21.1 19.6 L17.6 22 Z" fill={p} />
      </g>
    ),
    spec: [9.6, 9.4, 1.7, 1.0, -25],
  },
  // ── 주석 (Anno 앰버) ─────────────────────────────────────────────
  // Box 메모 — 볼륨 사각 + 제목 바 + 본문 줄(디테일)
  box: {
    g: "anno",
    body: (p) => (
      <g>
        <rect x="4" y="7" width="16" height="12" rx="1.2" fill={p} />
        <line x1="4.4" y1="3.6" x2="13" y2="3.6" {...LN} stroke={p} strokeWidth="2.4" />
      </g>
    ),
    detail: (c) => (
      <g {...LN} stroke={c} strokeWidth="1.5">
        <line x1="6.6" y1="10.8" x2="17.4" y2="10.8" />
        <line x1="6.6" y1="14.2" x2="14.6" y2="14.2" />
      </g>
    ),
    spec: [8.0, 9.2, 2.8, 1.1, -14],
  },
  // Spine Label — 척추 연번 볼륨 점 + 라벨 틱
  spine: {
    g: "anno",
    body: (p) => (
      <g>
        <g fill={p}>
          <circle cx="9" cy="5" r="2.2" />
          <circle cx="10.5" cy="12" r="2.2" />
          <circle cx="9" cy="19" r="2.2" />
        </g>
        <g {...LN} stroke={p} strokeWidth="2.4">
          <line x1="13.4" y1="5" x2="18.4" y2="5" />
          <line x1="14.9" y1="12" x2="19.9" y2="12" />
          <line x1="13.4" y1="19" x2="18.4" y2="19" />
        </g>
      </g>
    ),
    spec: [8.3, 4.3, 1.1, 0.7, -30],
  },
  // Marking — 깃대(스트로크) + 볼륨 깃발(면)
  marking: {
    g: "anno",
    body: (p) => (
      <g>
        <line x1="6" y1="3" x2="6" y2="21" {...LN} stroke={p} strokeWidth="2.4" />
        <path d="M6 3.6 H18.5 L15.6 7.6 L18.5 11.6 H6 Z" fill={p} />
      </g>
    ),
    spec: [9.6, 5.4, 2.2, 0.9, -12],
  },
  // ── 픽셀 (Pixel 틸) ──────────────────────────────────────────────
  // Lens — 조준 십자(두꺼운 틱) + 볼륨 값점
  lens: {
    g: "pixel",
    body: (p) => (
      <g>
        <g {...LN} stroke={p} strokeWidth="2.6">
          <line x1="12" y1="2.8" x2="12" y2="8.2" />
          <line x1="12" y1="15.8" x2="12" y2="21.2" />
          <line x1="2.8" y1="12" x2="8.2" y2="12" />
          <line x1="15.8" y1="12" x2="21.2" y2="12" />
        </g>
        <circle cx="12" cy="12" r="2.8" fill={p} />
      </g>
    ),
    detail: (c) => <circle cx="12" cy="12" r="1.1" fill={c} opacity="0.9" />,
    spec: [11.0, 10.9, 1.2, 0.7, -30],
  },
  // Profile — 축(스트로크) + 파형 아래 면 채움(상단 윤곽 = 기존 파형 실루엣)
  profile: {
    g: "pixel",
    body: (p) => (
      <g>
        <polyline points="4,3.5 4,20 21,20" {...LN} stroke={p} strokeWidth="2.4" />
        <path fill={p} d="M5.5 16 c2.5 0 2.5 -8 5 -8 s2.5 5.5 5 5.5 s2.2 -3 4.5 -3 V19.2 H5.5 Z" />
      </g>
    ),
    spec: [10.2, 12.6, 1.6, 0.8, -40],
  },
  // 2D Table — 볼륨 패널 + 격자(디테일). flat 은 격자 의미 유지 위해 오버라이드
  table2d: {
    g: "pixel",
    body: (p) => <rect x="3.5" y="4.5" width="17" height="15" rx="1.4" fill={p} />,
    detail: (c) => (
      <g {...LN} stroke={c} strokeWidth="1.5">
        <line x1="3.5" y1="9.5" x2="20.5" y2="9.5" />
        <line x1="3.5" y1="14.5" x2="20.5" y2="14.5" />
        <line x1="9.2" y1="4.5" x2="9.2" y2="19.5" />
        <line x1="14.8" y1="4.5" x2="14.8" y2="19.5" />
      </g>
    ),
    spec: [7.2, 6.8, 2.4, 1.1, -20],
    flat: (c) => (
      <g {...LN} stroke={c} strokeWidth="1.8">
        <rect x="3.5" y="4.5" width="17" height="15" rx="1" />
        <line x1="3.5" y1="9.5" x2="20.5" y2="9.5" />
        <line x1="3.5" y1="14.5" x2="20.5" y2="14.5" />
        <line x1="9.2" y1="4.5" x2="9.2" y2="19.5" />
        <line x1="14.8" y1="4.5" x2="14.8" y2="19.5" />
      </g>
    ),
  },
  // ── Scroll — 스택 이미지 넘김: 상/하 화살촉 + 중앙 스크롤 바 (Pixel 틸) ──
  scroll: {
    g: "pixel",
    body: (p) => (
      <g>
        <path d="M12 2.6 L16.4 7.6 H7.6 Z" fill={p} />
        <path d="M12 21.4 L7.6 16.4 H16.4 Z" fill={p} />
        <rect x="9.4" y="9.4" width="5.2" height="5.2" rx="1.2" fill={p} />
      </g>
    ),
    spec: [10.6, 5.4, 1.5, 0.8, -20],
  },
  // ── Cobb's Angle — 기울어진 두 종판선 + 사이 각 호 (Anno 앰버) ──
  cobb: {
    g: "anno",
    body: (p) => (
      <g {...LN} stroke={p}>
        <line x1="4" y1="6.6" x2="20" y2="3.4" strokeWidth="2.6" />
        <line x1="4" y1="17.4" x2="20" y2="20.6" strokeWidth="2.6" />
        <path d="M7.4 9.4 A6.4 6.4 0 0 0 7.4 14.6" strokeWidth="2" fill="none" />
      </g>
    ),
    spec: [8.2, 5.2, 2.2, 0.8, -8],
  },
  // ── LegLength — 골반 바 + 좌우 다리 길이선(끝 틱) (Anno 앰버) ──
  leg: {
    g: "anno",
    body: (p) => (
      <g {...LN} stroke={p}>
        <line x1="5" y1="4.4" x2="19" y2="4.4" strokeWidth="2.6" />
        <line x1="8" y1="7.2" x2="7" y2="20" strokeWidth="2.6" />
        <line x1="16" y1="7.2" x2="17" y2="18" strokeWidth="2.6" />
        <line x1="4.6" y1="20" x2="9.4" y2="20" strokeWidth="2" />
        <line x1="14.6" y1="18" x2="19.4" y2="18" strokeWidth="2" />
      </g>
    ),
    spec: [9.0, 4.0, 2.4, 0.8, 0],
  },
  // ── Report — 판독 문서: 페이지 + 본문 줄 (Shutter 슬레이트) ──
  report: {
    g: "shutter",
    body: (p) => (
      <path fill={p}
            d="M6 2.6 h8.4 L19 7.2 V20 a1.4 1.4 0 0 1 -1.4 1.4 H6 A1.4 1.4 0 0 1 4.6 20 V4 A1.4 1.4 0 0 1 6 2.6 Z" />
    ),
    detail: (c) => (
      <g {...LN} stroke={c} strokeWidth="1.5">
        <path d="M14.2 2.9 V7.4 H18.7" fill="none" />
        <line x1="7.4" y1="11" x2="16.2" y2="11" />
        <line x1="7.4" y1="14.2" x2="16.2" y2="14.2" />
        <line x1="7.4" y1="17.4" x2="13" y2="17.4" />
      </g>
    ),
    spec: [8.4, 6.0, 2.0, 1.0, -18],
    flat: (c) => (
      <g {...LN} stroke={c} strokeWidth="1.7">
        <path d="M6 3.4 h8.2 L18.4 7.6 V20.6 H6 V3.4 Z" fill="none" />
        <path d="M14.2 3.6 V7.8 H18.2" fill="none" />
        <line x1="8" y1="11.4" x2="16.4" y2="11.4" />
        <line x1="8" y1="14.6" x2="16.4" y2="14.6" />
        <line x1="8" y1="17.8" x2="13.4" y2="17.8" />
      </g>
    ),
  },
  // ── 셔터 (Shutter 슬레이트) — 바깥 가림 프레임(evenodd 구멍) + 노출 영역 ──
  shutRect: {
    g: "shutter",
    body: (p) => (
      <path
        fillRule="evenodd"
        fill={p}
        d="M4.4 3 h15.2 a1.4 1.4 0 0 1 1.4 1.4 v15.2 a1.4 1.4 0 0 1 -1.4 1.4 H4.4 a1.4 1.4 0 0 1 -1.4 -1.4 V4.4 a1.4 1.4 0 0 1 1.4 -1.4 Z M8 8 v8 h8 V8 Z"
      />
    ),
    detail: (c) => (
      <g {...LN} stroke={c} strokeWidth="1.3" opacity="0.7">
        <line x1="3.8" y1="6.4" x2="6.4" y2="3.8" />
        <line x1="17.6" y1="20.2" x2="20.2" y2="17.6" />
      </g>
    ),
    spec: [6.8, 5.2, 2.0, 0.9, -18],
  },
  shutEl: {
    g: "shutter",
    body: (p) => (
      <path
        fillRule="evenodd"
        fill={p}
        d="M4.4 3 h15.2 a1.4 1.4 0 0 1 1.4 1.4 v15.2 a1.4 1.4 0 0 1 -1.4 1.4 H4.4 a1.4 1.4 0 0 1 -1.4 -1.4 V4.4 a1.4 1.4 0 0 1 1.4 -1.4 Z M12 8 a5 4 0 1 0 0 8 a5 4 0 1 0 0 -8 Z"
      />
    ),
    detail: (c) => (
      <g {...LN} stroke={c} strokeWidth="1.3" opacity="0.7">
        <line x1="3.8" y1="6.4" x2="6.4" y2="3.8" />
        <line x1="17.6" y1="20.2" x2="20.2" y2="17.6" />
      </g>
    ),
    spec: [6.8, 5.2, 2.0, 0.9, -18],
  },
  shutPoly: {
    g: "shutter",
    body: (p) => (
      <path
        fillRule="evenodd"
        fill={p}
        d="M4.4 3 h15.2 a1.4 1.4 0 0 1 1.4 1.4 v15.2 a1.4 1.4 0 0 1 -1.4 1.4 H4.4 a1.4 1.4 0 0 1 -1.4 -1.4 V4.4 a1.4 1.4 0 0 1 1.4 -1.4 Z M12 7 L7.5 10.5 L9 16 H15 L16.5 10.5 Z"
      />
    ),
    detail: (c) => (
      <g {...LN} stroke={c} strokeWidth="1.3" opacity="0.7">
        <line x1="3.8" y1="6.4" x2="6.4" y2="3.8" />
        <line x1="17.6" y1="20.2" x2="20.2" y2="17.6" />
      </g>
    ),
    spec: [6.8, 5.2, 2.0, 0.9, -18],
  },
};

/** TY-2 신규 아이콘 우선 렌더 — 없으면 ToolIconEx(→ToolIcon) 위임. 3D/flat 규칙은 toolIcons.tsx 동일 */
export function ToolIconTy({ id, size = 17, flat = false }: { id: string; size?: number; flat?: boolean }) {
  // SVG 인스턴스가 여러 개 렌더되므로 gradient/filter id 충돌 방지 — 인스턴스별 고유 id(⑧)
  const rawId = useId();
  const def = TY2[id];
  if (!def) return <ToolIconEx id={id} size={size} flat={flat} />;
  // 플랫(평면) 렌더 — 설정>뷰어(TY) ty_icon_3d=false: 3D 레이어 없이 currentColor 단색 실루엣(⑥)
  if (flat) {
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden style={{ display: "block", overflow: "visible" }}>
        {def.flat ? def.flat("currentColor") : def.body("currentColor")}
      </svg>
    );
  }
  const uid = rawId.replace(/[^a-zA-Z0-9_-]/g, "");
  const gradId = `t3dy-g-${uid}`;
  const shadowId = `t3dy-s-${uid}`;
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
        {/* 내부 디테일(격자/중심점/해칭 등) — 어두운 엣지색 */}
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
