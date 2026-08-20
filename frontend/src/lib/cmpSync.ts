/* 다중 모니터 Compare — **창 사이** 스크롤·시네·Combine·Crosslink 동기(2026-08-20 사용자 확정).
 *
 * 사용자 요구 원문:
 *  "다중모니터에서 Compare 로 비교영상을 옆 모니터에 열어서 Combine 실행 시, 두 모니터의 비교
 *   master·slave 모두 마우스로 스크롤이 동시에 진행하고, 자동 플레이 기능(삼각형 sec 조정 플레이
 *   버튼)과 Crosslink·AutoSync 기능이 서로 다른 모니터끼리도 Link 되고 Sync 되어 영상이 함께
 *   마우스 스크롤과 자동으로 넘길 수 있게 해줘."
 *
 * ── 설계 ────────────────────────────────────────────────────────────────
 * ① **시네를 따로 보내지 않는다.** 자동 플레이는 결국 step() 을 주기적으로 부르는 것이므로,
 *    스크롤 한 종류만 방송하면 마우스 휠도 시네도 같은 경로로 따라온다. 창마다 타이머를 따로
 *    돌리면 서로 어긋나(drift) 몇 장 지나 위치가 벌어진다 — 마스터의 tick 을 따르는 쪽이 정확하다.
 *
 * ② **좌표 정합이 되면 좌표로, 안 되면 델타로.** 창 안에서 쓰는 규칙(spatialSync.nearestSlice)을
 *    창 사이에도 그대로 쓴다. 그래서 마스터의 현재 슬라이스 **기하 정보**를 함께 싣는다.
 *    (InstanceNode 전체는 무겁고 주석까지 딸려 오므로 geomOf 가 읽는 필드만 추린다.)
 *    슬라이스 수가 다르거나 FoR 가 달라 정합이 성립하지 않으면 델타(± 몇 칸)로 움직인다.
 *
 * ③ **에코 금지.** BroadcastChannel 은 보낸 창에는 오지 않지만, 받은 창이 그걸 처리하다 다시
 *    방송하면 두 창이 서로를 밀며 무한히 스크롤한다. from(window.name)으로 한 번,
 *    수신 처리 중 방송 억제 플래그로 또 한 번 막는다(호출부 책임 — 이 모듈은 from 만 거른다).
 *
 * ④ **늦게 뜨는 창을 위한 인사(hello).** 슬레이브 창은 마스터가 Crosslink 를 켠 **뒤에** 로드가
 *    끝난다. 그 사이 방송을 놓치면 슬레이브만 동기가 꺼진 채 남는다. 그래서 슬레이브가 준비되면
 *    hello 를 보내고, 마스터가 지금 상태(xlink)를 되돌려 준다.
 *
 * react·DOM 무의존(BroadcastChannel 제외) — node 테스트가 직접 부른다.
 */

/** nearestSlice 가 읽는 최소 기하 — InstanceNode 에서 이 필드만 추려 방송한다. */
export interface CmpGeom {
  position?: number[];
  orientation?: number[];
  pixel_spacing?: number[];
  rows?: number;
  cols?: number;
  frame_of_reference_uid?: string;
}

export interface CmpXlinkFlags {
  crosslink?: boolean;
  auto_sync?: boolean;
  sync_other?: boolean;
}

export type CmpMsg =
  | { type: "cmp"; kind: "scroll"; from: string; delta: number; geom: CmpGeom | null; studyUid?: string }
  | { type: "cmp"; kind: "combine"; from: string; on: boolean }
  | { type: "cmp"; kind: "xlink"; from: string; xlink: CmpXlinkFlags }
  | { type: "cmp"; kind: "hello"; from: string };

/** 채널은 **처음 쓸 때** 연다.
 *  모듈 최상위에서 열면 이 모듈을 import 하기만 해도 채널이 살아나, node 테스트에서
 *  열린 핸들이 이벤트 루프를 붙잡아 프로세스가 끝나지 않는다(실제로 겪었다).
 *  브라우저에서는 첫 방송/구독 시점에 열리므로 동작 차이가 없다. */
let _ch: BroadcastChannel | null | undefined;
function chan(): BroadcastChannel | null {
  if (_ch === undefined) {
    _ch = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("sv_cmp") : null;
  }
  return _ch;
}

/** 이 창의 이름 — 다중 모니터 배치에서 window.open(name) 으로 붙는다. 없으면 빈 문자열. */
export function selfName(): string {
  return typeof window !== "undefined" ? (window.name || "") : "";
}

function post(m: CmpMsg): void {
  try { chan()?.postMessage(m); } catch { /* 채널 없음/직렬화 실패는 무시 — 동기는 부가 기능 */ }
}

/** nearestSlice 가 쓰는 필드만 추린다. 값이 부실하면 null(수신 측이 델타로 폴백). */
export function geomOfInstance(inst: unknown): CmpGeom | null {
  const i = inst as CmpGeom | null | undefined;
  if (!i || i.position?.length !== 3 || i.orientation?.length !== 6) return null;
  return {
    position: i.position,
    orientation: i.orientation,
    pixel_spacing: i.pixel_spacing,
    rows: i.rows,
    cols: i.cols,
    frame_of_reference_uid: i.frame_of_reference_uid,
  };
}

/** 스크롤 한 칸(또는 시네 한 tick) — 마우스 휠·화살표·CINE 이 모두 이걸 쓴다. */
export function postCmpScroll(delta: number, geom: CmpGeom | null, studyUid?: string): void {
  post({ type: "cmp", kind: "scroll", from: selfName(), delta, geom, studyUid });
}

/** Combine 토글 — on=true 결합, false 해제. 두 창이 같은 상태가 되게. */
export function postCmpCombine(on: boolean): void {
  post({ type: "cmp", kind: "combine", from: selfName(), on });
}

/** Crosslink/AutoSync/SyncOther 상태 전파 — 마스터가 켜면 슬레이브도 켠다. */
export function postCmpXlink(xlink: CmpXlinkFlags): void {
  post({ type: "cmp", kind: "xlink", from: selfName(), xlink });
}

/** 슬레이브가 준비됐음을 알린다 — 마스터가 현재 xlink 를 되돌려 준다(늦게 뜬 창 구제). */
export function postCmpHello(): void {
  post({ type: "cmp", kind: "hello", from: selfName() });
}

/** 구독 — **자기 창이 보낸 것은 걸러서** 넘긴다. 반환값은 해지 함수. */
export function onCmpSync(handler: (m: CmpMsg) => void): () => void {
  const channel = chan();
  if (!channel) return () => {};
  const fn = (e: MessageEvent) => {
    const m = e.data as CmpMsg;
    if (m?.type !== "cmp") return;
    if (m.from && m.from === selfName()) return;   // ③ 에코 금지
    handler(m);
  };
  channel.addEventListener("message", fn);
  return () => channel.removeEventListener("message", fn);
}
