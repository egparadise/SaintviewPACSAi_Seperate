// 포트 기반 포털 분리 — 5173 Landing / 5174 서버(관리자) / 5175 Client 뷰어
// ⚠ 5174/5175 는 별개 오리진이라 localStorage 세션이 공유되지 않는다.
//    각 포털에서 최초 1회 로그인하는 것이 의도된 설계다(포털 간 SSO 없음).
// 포트 미매칭(빈 포트·기타 포트)은 'all' 폴백 — 프로덕션 단일 서빙에서 기존 전체 기능 유지.

// env 오버라이드 방어 파싱 — 빈 문자열은 Number("")===0 이라 프로덕션(포트 없음=0)과
// 충돌해 'all' 폴백이 깨진다. 양의 정수가 아니면 기본값 사용.
function parsePort(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : def;
}

export const PORT_LANDING = 5173;
export const PORT_ADMIN = parsePort(import.meta.env.VITE_PORT_ADMIN, 5174);
export const PORT_CLIENT = parsePort(import.meta.env.VITE_PORT_CLIENT, 5175);

export type PortalRole = "landing" | "admin" | "client" | "all";
export type PortalTarget = "landing" | "admin" | "client";

/** 현재 오리진의 포트로 포털 역할 판정 */
export function portalRole(): PortalRole {
  const port = Number(window.location.port || 0);
  if (port === PORT_LANDING) return "landing";
  if (port === PORT_ADMIN) return "admin";
  if (port === PORT_CLIENT) return "client";
  return "all"; // 폴백 — 단일 오리진 전체 기능(회귀 0)
}

/** 대상 포털의 URL — 호스트는 현재 hostname 유지, 포트만 교체 */
export function portalUrl(target: PortalTarget): string {
  const port = target === "admin" ? PORT_ADMIN : target === "client" ? PORT_CLIENT : PORT_LANDING;
  return `${window.location.protocol}//${window.location.hostname}:${port}/`;
}
