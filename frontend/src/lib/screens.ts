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

/** 다중 모니터 관리 배치(mm) 여부 — 창 단위 영속.
 *  openV2 가 URL 로 mm=1(승격)/mm=0(강등)을 명시하면 sessionStorage 에 기록하고, URL 에 mm 이 없는
 *  창 내 네비게이션(Exam 탭 ✕ 닫기 리로드·판독창 ◀▶가 이 창을 네비게이트·Compare 폴백 리로드)에서는
 *  sessionStorage 값을 따른다 — mm 창이 재로드로 일반 창 규칙(환자 혼합 방지 필터·선택 동기 전환)으로
 *  되돌아가 공유 Exam 레지스트리를 파괴하지 않게 한다. sessionStorage 는 창(탭)별·네비게이션 생존. */
export function mmManaged(): boolean {
  try {
    const q = new URLSearchParams(window.location.search).get("mm");
    if (q === "1") { sessionStorage.setItem("sv_mm", "1"); return true; }
    if (q === "0") { sessionStorage.removeItem("sv_mm"); return false; }
    return sessionStorage.getItem("sv_mm") === "1";
  } catch { return false; }
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

/** 비교(Compare) slave 검사를 "다음 모니터"에 배치 — 기준(master) 모니터를 제외하고 master 다음부터 순환
 *  (끝번이면 첫 Viewer 모니터로, 단 master 모니터는 건너뜀 → 기준 영상이 파괴되지 않음).
 *  slots 는 사전 감지값(screenFeaturesList 결과)을 넘겨 동기 실행 → window.open 이 사용자 클릭 활성화를
 *  유지(팝업 차단 회피). 단일/미감지면 false 반환(호출부가 한 창 인플레이스 분할 처리). masterName 은
 *  master 창의 window.name("sv_viewer" | "sv_viewer_slot{n}") — 그 모니터를 제외 대상으로 식별. */
export function placeCompareSlaves(
  slots: { index: number; features: string }[],
  masterName: string,
  slaveStudyIds: number[],
): boolean {
  if (!(slots.length > 1 && slots[0].index >= 0)) return false;
  // master 모니터 index — 창 이름에서 역산("sv_viewer"=최저번호 슬롯, "sv_viewer_slotN"=N)
  const mMon = masterName === "sv_viewer"
    ? slots[0].index
    : Number((masterName.match(/^sv_viewer_slot(\d+)$/) ?? [])[1]);
  const mi = Number.isFinite(mMon) ? slots.findIndex((s) => s.index === mMon) : -1;
  // master 다음부터 순환하는 나머지 모니터(= master 제외). mi 미확인 시 첫 슬롯을 master 로 간주.
  const order = mi >= 0 ? [...slots.slice(mi + 1), ...slots.slice(0, mi)] : slots.slice(1);
  if (!order.length) return false;
  // 비교검사가 여유 모니터보다 많으면 각자 다른 모니터에 못 놓는다 → 같은 창을 덮어써 검사가 소실되므로
  // 배치를 포기하고 false 반환(호출부가 한 창 인플레이스 분할로 모두 표시 — 무손실).
  if (slaveStudyIds.length > order.length) return false;
  let opened = false;
  for (let k = 0; k < slaveStudyIds.length; k++) {
    const slot = order[k % order.length];
    if (openSlaveWindow(slaveStudyIds[k], `S${k + 1}`, slot, slots[0].index)) opened = true;
  }
  return opened;
}

// slave 뷰어 창 열기+배치 공통 — cmprole(녹색 라벨) + mm=1(공유 Exam 레지스트리 유지 — In-View 가
// 환자 혼합 방지 필터로 레지스트리를 덮어쓰지 않게). 재사용 창은 open 좌표가 무시되므로 직접 이동.
// 창 이름은 Worklist openV2 규약과 동일(최저번호 모니터="sv_viewer") — 같은 모니터 중복 창 방지.
function openSlaveWindow(studyId: number, role: string, slot: { index: number; features: string },
                         firstIndex: number): boolean {
  const name = slot.index === firstIndex ? "sv_viewer" : `sv_viewer_slot${slot.index}`;
  const base = `${window.location.origin}${window.location.pathname}`;
  const url = `${base}?viewer=2d&study=${studyId}&cmprole=${encodeURIComponent(role)}&mm=1`;
  const w = window.open(url, name, slot.features);
  if (!w) return false;
  const m: Record<string, number> = {};
  for (const kv of slot.features.split(",")) { const [kk, vv] = kv.split("="); m[kk] = Number(vv); }
  if (![m.left, m.top, m.width, m.height].some((n) => n === undefined || Number.isNaN(n))) {
    try { w.moveTo(m.left, m.top); w.resizeTo(m.width, m.height); } catch { /* 권한/브라우저 제약 */ }
  }
  try { w.focus(); } catch { /* 무시 */ }
  return true;
}

/** 과거검사(History) 비교 '모니터 띄우기' — 기준 창의 "바로 인접" 모니터에 과거검사 창을 연다.
 *  인접 = 다음 모니터, 기준이 끝번이면 이전 모니터(순환하지 않음 — 예: 1,2,3 중 3번 기준→2번, 1번 기준→2번).
 *  단일/미감지·팝업 차단이면 false(호출부가 Layout 1:2 분할로 폴백). */
export function placePriorAdjacent(
  slots: { index: number; features: string }[],
  masterName: string,
  studyId: number,
): boolean {
  if (!(slots.length > 1 && slots[0].index >= 0)) return false;
  const mMon = masterName === "sv_viewer"
    ? slots[0].index
    : Number((masterName.match(/^sv_viewer_slot(\d+)$/) ?? [])[1]);
  const mi = Number.isFinite(mMon) ? slots.findIndex((s) => s.index === mMon) : -1;
  // 다음 슬롯, 끝번이면 이전 슬롯. master 미확인 시 두 번째 슬롯(첫 슬롯을 master 로 간주).
  const ti = mi < 0 ? 1 : (mi + 1 < slots.length ? mi + 1 : mi - 1);
  const slot = slots[ti];
  if (!slot || ti === mi) return false;
  return openSlaveWindow(studyId, "S1", slot, slots[0].index);
}
