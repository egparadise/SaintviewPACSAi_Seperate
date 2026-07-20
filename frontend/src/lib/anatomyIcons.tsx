// 해부학 측정 툴 아이콘 4종 — 3D 스타일(그라디언트+드롭섀도) 인라인 SVG
// toolIcons.tsx(선 아이콘 세트)와 파일 분리 유지. 버튼이 여러 개 렌더되므로
// useId 로 gradient/filter id 충돌을 방지한다.
// [스타일 정합] toolIcons.tsx 3D 볼륨 레시피 v2와 파라미터 통일:
//  ① 광원 좌상단 고정(그라디언트 x1y1=0,0 → x2y2=1,1)
//  ② 스펙큘러 하이라이트: 흰색 opacity 0.5 작은 타원(본체 질량 상단·좌측)
//  ③ 캐스트 섀도: feDropShadow(dx 0, dy 1.2, blur 1.3, rgba(0,0,0,0.5))
//  뼈색 모티프·실루엣은 3D 전용 — flat(ty_icon_3d 꺼짐)은 다른 아이콘 세트와 동일하게
//  currentColor 단색 실루엣(그라디언트·섀도·스펙큘러 0)으로 렌더한다(계약 ⑥).
import { useId, type ReactNode } from "react";

const BONE_EDGE = "#8a7c58";  // 뼈 외곽선(입체감)

export function AnatomyIcon({ id, size = 17, flat = false }: { id: string; size?: number; flat?: boolean }) {
  // useId 원본(":r5:" 형태)은 콜론 포함 — url(#...) FuncIRI 참조 안전을 위해 sanitize (toolIcons.tsx 와 동일 규칙)
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const boneId = `an3d-bone-${uid}`, accId = `an3d-acc-${uid}`, shId = `an3d-sh-${uid}`;
  // 플랫(ty_icon_3d=false) — currentColor 단색 실루엣, 드롭섀도 없음 (형태는 동일, 계약 ⑥)
  const bone = flat ? "currentColor" : `url(#${boneId})`, acc = flat ? "currentColor" : `url(#${accId})`;
  const edge = flat ? "none" : BONE_EDGE;

  let body: ReactNode = null;
  // ② 스펙큘러 하이라이트 [cx, cy, rx, ry, rotate?] — 본체 질량의 상단·좌측(3D 전용)
  let spec: readonly [number, number, number, number, number?] | null = null;
  switch (id) {
    case "cobb":
      // 척추측만 — 휜 척추(추체 5개) + 상·하 종판 기울기 측정선
      body = (
        <g>
          {([[12.6, 3.6, -10], [14.3, 7.2, -20], [13.3, 10.9, 6], [10.9, 14.3, 22], [10.0, 18.1, 8]] as const)
            .map(([x, y, r], i) => (
              <rect key={i} x={x - 2.5} y={y - 1.4} width={5} height={2.8} rx={1.2}
                    fill={bone} stroke={edge} strokeWidth={0.35}
                    transform={`rotate(${r} ${x} ${y})`} />
            ))}
          <line x1="8.5" y1="2.2" x2="18.7" y2="4.4" stroke={acc} strokeWidth="1.1" strokeLinecap="round" />
          <line x1="5.4" y1="19.9" x2="15.4" y2="17.3" stroke={acc} strokeWidth="1.1" strokeLinecap="round" />
        </g>
      );
      spec = [12.3, 3.2, 1.5, 0.7, -10]; // 최상단 추체 좌상
      break;
    case "leg": {
      // 다리 길이 — 좌우 대퇴골(골두·과두) + 하단 수평 기준 점선
      const femur = (cx: number, tilt: number) => (
        <g transform={`rotate(${tilt} ${cx} 12)`}>
          <rect x={cx - 1.05} y={6.2} width={2.1} height={10.8} rx={1}
                fill={bone} stroke={edge} strokeWidth={0.35} />
          <circle cx={cx - 1.35} cy={5.3} r={1.75} fill={bone} stroke={edge} strokeWidth={0.35} />
          <circle cx={cx + 1.1} cy={5.9} r={1.2} fill={bone} stroke={edge} strokeWidth={0.35} />
          <circle cx={cx - 1.15} cy={17.9} r={1.55} fill={bone} stroke={edge} strokeWidth={0.35} />
          <circle cx={cx + 1.15} cy={17.9} r={1.55} fill={bone} stroke={edge} strokeWidth={0.35} />
        </g>
      );
      body = (
        <g>
          {femur(7.6, -3)}
          {femur(16.4, 3)}
          <line x1="3.5" y1="21.5" x2="20.5" y2="21.5" stroke={acc} strokeWidth="1"
                strokeLinecap="round" strokeDasharray="2 1.4" />
        </g>
      );
      spec = [6.0, 5.0, 1.1, 0.6, -20]; // 좌측 대퇴 골두 좌상
      break;
    }
    case "pelvis":
      // 골반 틀어짐 — 좌우 장골 날개 + 중앙 천골
      body = (
        <g fill={bone} stroke={edge} strokeWidth={0.4}>
          <path d="M11.2 6.2 C8.6 4.4 4.6 5.2 3.4 8.6 C2.5 11.4 4.4 13.8 6.8 15.1
                   C8.4 16 9.3 17.5 9.7 19.2 L11.4 18.2 C11 16.4 10.5 14.8 10.8 13
                   C11 11.4 11.3 8.4 11.2 6.2 Z" />
          <path d="M12.8 6.2 C15.4 4.4 19.4 5.2 20.6 8.6 C21.5 11.4 19.6 13.8 17.2 15.1
                   C15.6 16 14.7 17.5 14.3 19.2 L12.6 18.2 C13 16.4 13.5 14.8 13.2 13
                   C13 11.4 12.7 8.4 12.8 6.2 Z" />
          <path d="M10.6 7.4 L13.4 7.4 L13 12.6 L12 14.4 L11 12.6 Z"
                fill={acc} stroke="none" opacity="0.92" />
        </g>
      );
      spec = [6.1, 7.4, 1.7, 0.9, -25]; // 좌측 장골 날개 상단
      break;
    case "spineCurve":
      // 척추 외곡 — 플럼라인(수직 점선+추) + 편위된 척추 커브 + 최대 편위 마커
      body = (
        <g fill="none">
          <line x1="8.2" y1="2.6" x2="8.2" y2="19.2" stroke={acc} strokeWidth="1"
                strokeDasharray="2.2 1.5" strokeLinecap="round" />
          <circle cx="8.2" cy="20.7" r="1.4" fill={acc} stroke="none" />
          <path d="M8.2 3 C14.8 5.4 16.4 9.6 13.2 13.2 C11.2 15.4 9.4 17.6 8.6 20.2"
                stroke={bone} strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="15.1" cy="8.8" r="1.1" fill={flat ? "currentColor" : "#f59e0b"} stroke="none" />
        </g>
      );
      spec = [11.0, 4.2, 1.4, 0.6, 20]; // 척추 커브 상단·좌측
      break;
    default:
      return null;
  }

  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden style={{ display: "block", overflow: "visible" }}>
      <defs>
        <linearGradient id={boneId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f8f4e6" />
          <stop offset="0.55" stopColor="#e2d7b8" />
          <stop offset="1" stopColor="#b3a37c" />
        </linearGradient>
        {/* ① 광원 좌상단 고정(toolIcons 와 동일 방향) */}
        <linearGradient id={accId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7dd3fc" />
          <stop offset="1" stopColor="#0369a1" />
        </linearGradient>
        {/* ③ 캐스트 섀도 — toolIcons 3D 레시피와 동일 파라미터 */}
        <filter id={shId} x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="1.2" stdDeviation="1.3" floodColor="#000" floodOpacity="0.5" />
        </filter>
      </defs>
      <g filter={flat ? undefined : `url(#${shId})`}>
        {body}
        {/* ② 스펙큘러 하이라이트 — 흰색 opacity 0.5 (3D 전용) */}
        {!flat && spec && (
          <ellipse cx={spec[0]} cy={spec[1]} rx={spec[2]} ry={spec[3]} fill="#fff" opacity={0.5}
                   transform={spec[4] != null ? `rotate(${spec[4]} ${spec[0]} ${spec[1]})` : undefined} />
        )}
      </g>
    </svg>
  );
}
