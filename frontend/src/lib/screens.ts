// 모니터 배치 헬퍼 — Window Management API(Chrome)로 창 위치/크기 features 계산
// (뷰어/워크리스트/판독 창 공용 — Setting>모니터에서 선택한 인덱스 사용)

// getScreenDetails(모니터 감지) 사용 가능 여부 진단.
// 가능하면 null, 불가하면 그 사유를 한국어 안내로 반환.
// 핵심: 이 API 는 "보안 컨텍스트"(HTTPS 또는 localhost)에서만 window 에 노출된다.
// → 원격(Tailscale IP 등) http 접속에서는 Chrome 이어도 API 자체가 숨겨져(undefined)
//   기존 "Chrome/Edge 권장" 문구가 오해를 준다. 실제 사유(비보안 컨텍스트)를 알려준다.
export function screenApiIssue(): string | null {
  if (typeof window === "undefined") return null;
  if ("getScreenDetails" in window) return null;   // 사용 가능
  if (!window.isSecureContext) {
    const origin = window.location.origin;
    return (
      `모니터 감지가 브라우저에 의해 차단됨 — 현재 접속(${origin})이 보안 컨텍스트가 아닙니다. ` +
      `Window Management API 는 HTTPS 또는 localhost 에서만 열립니다. ` +
      `원격 PC 에서 쓰려면 HTTPS 로 접속하세요(권장: Tailscale Serve → https://<host>.ts.net). ` +
      `서버 PC 의 http://localhost 에서는 정상 동작합니다.`
    );
  }
  return "이 브라우저는 Window Management API(모니터 감지)를 지원하지 않습니다 — 최신 Chrome/Edge 를 사용하세요.";
}

type ScreenRect = { availLeft: number; availTop: number; availWidth: number; availHeight: number };

async function getScreens(): Promise<ScreenRect[] | null> {
  if (!("getScreenDetails" in window)) return null;
  try {
    const det = await (window as unknown as {
      getScreenDetails: () => Promise<{ screens: ScreenRect[] }>;
    }).getScreenDetails();
    return det.screens;
  } catch { return null; }
}

export async function screenFeatures(
  indices: number[] | null | undefined,
  fallback = "width=1500,height=920",
): Promise<string> {
  const sel = (indices ?? []).filter((i) => i >= 0);
  const screens = sel.length ? await getScreens() : null;
  if (!sel.length || !screens) return fallback;
  const scr = sel.map((i) => screens[i]).filter(Boolean);
  if (!scr.length) return fallback;
  const left = Math.min(...scr.map((s) => s.availLeft));
  const top = Math.min(...scr.map((s) => s.availTop));
  const right = Math.max(...scr.map((s) => s.availLeft + s.availWidth));
  const bottom = Math.max(...scr.map((s) => s.availTop + s.availHeight));
  return `left=${left},top=${top},width=${right - left},height=${bottom - top}`;
}

/** 선택 모니터별 개별 창 배치 — 모니터 번호(인덱스) 오름차순.
 *  다중 모니터에 뷰어를 "각각" 띄우기 위한 것. 단일 스팬 창은 브라우저가 한 모니터로
 *  클램프하고, 비연속 선택(예: 1·3·4, 2 건너뜀) 시 사이 모니터까지 덮으므로 창을 나눈다.
 *  반환: 각 모니터의 {index, features}. 감지 불가·미선택이면 [{index:-1, features:fallback}]. */
export async function screenFeaturesList(
  indices: number[] | null | undefined,
  fallback = "width=1500,height=920",
): Promise<{ index: number; features: string }[]> {
  const sel = [...new Set((indices ?? []).filter((i) => i >= 0))].sort((a, b) => a - b);
  const screens = sel.length ? await getScreens() : null;
  if (!sel.length || !screens) return [{ index: -1, features: fallback }];
  const out = sel
    .map((i) => ({ i, s: screens[i] }))
    .filter((x): x is { i: number; s: ScreenRect } => !!x.s)
    .map((x) => ({
      index: x.i,
      features: `left=${x.s.availLeft},top=${x.s.availTop},width=${x.s.availWidth},height=${x.s.availHeight}`,
    }));
  return out.length ? out : [{ index: -1, features: fallback }];
}
