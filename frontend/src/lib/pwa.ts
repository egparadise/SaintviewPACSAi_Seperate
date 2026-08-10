/* PWA 설치 + 전체 화면(2026-08-10 사용자 확정).
 *
 * · Download(하단 상태바): 크롬 메뉴의 "페이지를 앱으로 설치"와 같은 일 — 바탕화면 아이콘이
 *   생기고 브라우저 탭·주소창 없는 독립 창으로 실행된다(public/manifest.webmanifest 기반).
 *   beforeinstallprompt 는 브라우저가 설치 가능하다고 판단했을 때 **한 번** 주는 이벤트라
 *   여기서 잡아 두었다가 버튼이 눌리면 쓴다. 못 잡았으면(이미 설치·미지원) 안내로 폴백.
 * · 전체 화면(헤더): Fullscreen API — 판독 몰입용(F11 등가), Esc/재클릭 복귀.
 */

type BipEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferred: BipEvent | null = null;
let installedFlag = false;
const subs = new Set<() => void>();

/** 앱 부팅 시 1회(main.tsx) — beforeinstallprompt 는 기본 미니 인포바를 막고 보관한다. */
export function initPwa(): void {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BipEvent;
    subs.forEach((f) => f());
  });
  window.addEventListener("appinstalled", () => {
    installedFlag = true;
    deferred = null;
    subs.forEach((f) => f());
  });
}

export function canInstallApp(): boolean { return deferred !== null; }

/** standalone 표시 모드 = 이미 앱 창으로 실행 중 */
export function isInstalledApp(): boolean {
  return installedFlag || window.matchMedia?.("(display-mode: standalone)")?.matches === true;
}

export async function installApp(): Promise<"accepted" | "dismissed" | "installed" | "unavailable"> {
  if (isInstalledApp()) return "installed";
  if (!deferred) return "unavailable";
  const ev = deferred;
  deferred = null;                       // prompt() 는 이벤트당 1회 — 거절하면 브라우저가 나중에 다시 준다
  try {
    await ev.prompt();
    const c = await ev.userChoice;
    return c.outcome === "accepted" ? "accepted" : "dismissed";
  } catch { return "unavailable"; }
}

export function onPwaChange(f: () => void): () => void {
  subs.add(f);
  return () => { subs.delete(f); };
}

/** 전체 화면 토글 — true=진입, false=해제. 권한 거부 등 실패 시 현 상태 반환. */
export async function toggleFullscreen(): Promise<boolean> {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return false;
    }
    await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    return true;
  } catch { return !!document.fullscreenElement; }
}
