// 협진 영상 팝아웃 — 화면 공유·참가자 화면을 **별도 창**으로 띄운다.
//
// 왜 필요한가: 협진 패널의 비디오 타일은 판독 화면 옆에 붙는 4:3 축소판이다. 누군가
// 화면을 공유하면 그 안에서는 글자를 읽을 수 없다. 다중 모니터가 기본인 판독 환경에서는
// "공유 화면은 옆 모니터에 크게" 가 실제 사용 방식이다.
//
// ■ MediaStream 을 어떻게 다른 창으로 넘기나
//   postMessage 로는 못 넘긴다(MediaStream 은 구조화 복제·transferable 대상이 아니다).
//   대신 **같은 출처의 window.open 자식은 부모와 같은 JS 힙을 공유**하므로, 부모가
//   자식의 document 에 <video> 를 만들고 srcObject 에 **객체 참조를 그대로** 대입하면 된다.
//   (자식이 opener 를 통해 가져와도 되지만, 부모가 직접 심는 편이 생명주기 관리가 쉽다)
//
// ■ 창을 여는 것은 반드시 사용자 제스처 안에서
//   팝업 차단기는 클릭 핸들러 밖의 window.open 을 막는다. 그래서 이 함수는 버튼 onClick
//   에서 **동기적으로** 불려야 한다(비동기 await 뒤에 부르면 차단된다).
//   다중 모니터 배치(screenFeatures)는 await 가 필요하므로, features 는 **미리 구해 둔 것**을
//   넘긴다(호출부가 캐시한다 — Compare 창이 쓰는 cmpSlotsRef 와 같은 방식).

/** 열려 있는 팝아웃 — key 당 창 1개. 같은 대상을 다시 누르면 새로 열지 않고 앞으로 가져온다. */
const OPEN = new Map<string, { win: Window; video: HTMLVideoElement }>();

function writeShell(win: Window, title: string): HTMLVideoElement {
  const d = win.document;
  d.open();
  d.write(
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<title>${title.replace(/[<&]/g, "")}</title>` +
    "<style>" +
    "html,body{margin:0;height:100%;background:#000;overflow:hidden}" +
    // object-fit:contain — 공유 화면은 잘리면 안 된다(글자·병변이 화면 밖으로 나간다).
    // 판독 안전 규율과 같은 이유: 잘려 보이는 것보다 여백이 낫다.
    "video{width:100%;height:100%;object-fit:contain;display:block;background:#000}" +
    "#t{position:fixed;left:0;right:0;bottom:0;font:12px system-ui;color:#ddd;" +
    "background:rgba(0,0,0,.55);padding:3px 8px}" +
    "</style></head><body>" +
    '<video id="v" autoplay playsinline muted></video>' +
    `<div id="t"></div></body></html>`,
  );
  d.close();
  const el = d.getElementById("v") as HTMLVideoElement;
  const cap = d.getElementById("t");
  if (cap) cap.textContent = title;
  return el;
}

/** 영상 팝아웃 열기(또는 이미 열려 있으면 포커스). 반환: 성공 여부.
 *  @param key   대상 식별자 — 보통 `참가자 id`. 같은 key 는 창 하나를 재사용한다.
 *  @param features window.open features — 다중 모니터 배치용(호출부가 미리 계산해 캐시). */
export function popoutStream(key: string, stream: MediaStream | null, title: string,
                             features = "width=960,height=600"): boolean {
  if (!stream) return false;
  const found = OPEN.get(key);
  if (found && !found.win.closed) {
    // 이미 열려 있다 — 스트림만 최신으로 갈아 끼우고 앞으로 가져온다.
    // (화면 공유를 껐다 켜면 트랙이 새로 생기므로 참조가 바뀐다)
    if (found.video.srcObject !== stream) found.video.srcObject = stream;
    try { found.win.focus(); } catch { /* 무시 */ }
    return true;
  }
  let win: Window | null;
  try {
    // 이름을 주면 같은 대상이 항상 같은 창을 재사용한다(맵이 비어도 브라우저가 기억).
    win = window.open("", `sv_collab_view_${key}`, features);
  } catch { return false; }
  if (!win) return false;      // 팝업 차단 — 호출부가 안내한다
  const video = writeShell(win, title);
  video.srcObject = stream;
  void video.play().catch(() => { /* 자동재생 차단 — 사용자가 클릭하면 붙는다 */ });
  OPEN.set(key, { win, video });
  // 창이 닫히면 레지스트리에서 지운다(닫힌 창 참조를 붙들고 있지 않게)
  win.addEventListener("pagehide", () => OPEN.delete(key));
  return true;
}

/** 그 대상의 팝아웃이 열려 있나 — 버튼 라벨을 '열기/앞으로' 로 가르는 데 쓴다. */
export function isPopoutOpen(key: string): boolean {
  const f = OPEN.get(key);
  if (!f) return false;
  if (f.win.closed) { OPEN.delete(key); return false; }
  return true;
}

/** 스트림 교체 반영 — 열려 있는 창에만. 없으면 아무 일도 하지 않는다. */
export function syncPopout(key: string, stream: MediaStream | null): void {
  const f = OPEN.get(key);
  if (!f) return;
  if (f.win.closed) { OPEN.delete(key); return; }
  if (stream && f.video.srcObject !== stream) f.video.srcObject = stream;
  else if (!stream) closePopout(key);      // 상대가 화면 공유를 끊었다 — 검은 창을 남기지 않는다
}

export function closePopout(key: string): void {
  const f = OPEN.get(key);
  OPEN.delete(key);
  if (f && !f.win.closed) { try { f.win.close(); } catch { /* 무시 */ } }
}

/** 세션 종료·창 이탈 — 열린 팝아웃 전부 정리. 남겨 두면 환자 화면이 떠 있는 창이 방치된다. */
export function closeAllPopouts(): void {
  for (const key of [...OPEN.keys()]) closePopout(key);
}

if (typeof window !== "undefined") {
  // 부모 창이 닫히면 자식도 함께 닫는다(고아 창 방지 — PHI 가 떠 있는 창이다)
  window.addEventListener("pagehide", closeAllPopouts);
}
