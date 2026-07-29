// 다운로드 모드 — **뷰어 쪽 조회 계층**. wasmPixels.ts 와 완전히 동형이다:
// 동기 조회 → 준비됐으면 blob URL, 아니면 null(호출부는 서버 URL 폴백) + 백그라운드 로드.
// 그래서 뷰어의 나머지(CSS 변환·주석 수학·MG 보정·Combine)는 한 줄도 손대지 않는다.
//
// ⚠ 이 모듈은 **네트워크를 타지 않는다**. 받는 일은 dlScheduler(워크리스트 창 1곳)의 몫이고
//   여기는 이미 받아 둔 것을 꺼내 쓰기만 한다. 그래서 '다운로드 모드인데 아직 안 받은 검사'를
//   열어도 서버 URL 로 정상 동작한다(가속기이지 필수 경로가 아니다).
import { fixedFormatTag } from "./imageFormat";
import { dlKey, opfsGet, dlSupportReason } from "./opfsStore";
import { onDlInvalidate, postDlInvalidate } from "./sync";

let dlOn = false;                                  // 설정>환경 '영상 취득 모드' = download (lib/dlPrefs.ts)
const urlCache = new Map<string, string>();        // key → blob URL(디코드 완료본)
const pending = new Set<string>();                 // 진행 중(중복 조회 방지)
// 저장본 없음 — 매 렌더마다 OPFS 를 두드리지 않게 기억한다.
// ⚠ 영구히 기억하면 안 된다: 스케줄러는 **다른 창**에서 돌기 때문에, 아직 안 받은 검사를 먼저
//   열어 미스로 굳으면 그 뒤에 다 받아도 이 창은 영영 서버 URL 만 쓴다. 값은 만료 시각이다.
const missed = new Map<string, number>();
const MISS_TTL = 15_000;
// 썸네일 미스는 더 오래 기억한다 — 스케줄러가 저장하는 썸네일은 **시리즈 첫 인스턴스뿐**이라
// 나머지 sop 는 사실상 영구 미스다. 15초마다 전 프레임에 대해 IDB 를 다시 두드릴 이유가 없다.
const MISS_TTL_TH = 120_000;
const listeners = new Set<() => void>();
const LRU: string[] = [];
const LRU_MAX = 1200;   // wasmPixels 와 같은 상한 — 대형 CT/MR 시리즈 전체가 캐시에 머물도록
// 무효화 세대 — 진행 중이던 로드가 **비워진 캐시에 옛 blob URL 을 되살리는 것**을 막는다.
let epoch = 0;

export function setDlMode(on: boolean): void {
  if (dlOn === on) return;
  dlOn = on;
  if (!on) dlResetCache();
}
export function isDlMode(): boolean { return dlOn && !dlSupportReason(); }

/** 프레임 준비 알림 — 뷰어는 이걸 구독해 재렌더한다(onWasmFrame 과 나란히). */
export function onDlFrame(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** blob URL 전량 폐기 — 모드 끄기·로그아웃 시 호출(끊긴 URL 을 계속 쓰지 않게).
 *  ⚠ pending 도 함께 버린다(= epoch 증가). 안 그러면 리셋 시점에 진행 중이던 로드가
 *  비워진 캐시에 blob URL 을 되살려 놓는다. */
export function dlResetCache(): void {
  epoch++;
  for (const u of urlCache.values()) { try { URL.revokeObjectURL(u); } catch { /* 무시 */ } }
  urlCache.clear(); LRU.length = 0; missed.clear(); pending.clear();
}

/** 저장본이 폐기됐다 — 이 창의 캐시를 버리고 **재렌더까지 알린다**.
 *  broadcast=true 면 다른 창(뷰어 창들)에도 같은 신호를 보낸다.
 *
 *  ★ 이 경로가 없어서 실제로 사고가 났다: 워크리스트 창이 OPFS 파일을 지워도 뷰어 창의
 *    urlCache 는 `const hit = urlCache.get(key); if (hit) return hit;` 로 무조건 먼저
 *    반환하므로, A 에서 픽셀이 교체된 검사도 **낡은 영상이 계속 떴다**. */
export function dlInvalidateCache(broadcast = true): void {
  dlResetCache();
  listeners.forEach((cb) => cb());
  if (broadcast) postDlInvalidate();
}

// 다른 창의 무효화 신호 구독 — 모듈 로드 시 1회(구독 해제 지점이 없다 = 창 수명 전체).
onDlInvalidate(() => dlInvalidateCache(false));   // 에코 금지(false)

function publish(key: string, url: string): void {
  const old = urlCache.get(key);
  if (old) { try { URL.revokeObjectURL(old); } catch { /* 무시 */ } }
  urlCache.set(key, url);
  LRU.push(key);
  while (LRU.length > LRU_MAX) {
    const k = LRU.shift()!;
    if (k !== key && urlCache.has(k)) {
      try { URL.revokeObjectURL(urlCache.get(k)!); } catch { /* 무시 */ }
      urlCache.delete(k);
    }
  }
  listeners.forEach((cb) => cb());
}

/** 아직 유효한 '없음' 기억인가 — 만료됐으면 지우고 다시 찾아보게 한다. */
function missIsFresh(key: string): boolean {
  const t = missed.get(key);
  if (t === undefined) return false;
  if (Date.now() < t) return true;
  missed.delete(key);
  return false;
}

/** OPFS → blob URL. ★ **디코드가 끝난 뒤에** 캐시에 넣고 알린다.
 *  src 만 갈아끼우면 디코드 스톨로 한 프레임 깜빡인다 — '무음 전환'이 깨진다.
 *  (같은 decode-먼저 패턴이 framePrefetch.ts:26-30 에 이미 있다)
 *
 *  ⚠ 중복 방지 가드(pending)는 **디코드 끝까지** 덮어야 한다. 예전에는 img.src 대입 직후
 *  async 함수가 끝나 finally 가 돌았고, 그 사이에 들어온 렌더가 가드를 통과해 같은 키를
 *  처음부터 다시 로드했다(IDB 트랜잭션 + getFile + createObjectURL + 새 디코드). 시네·드래그
 *  중에는 같은 프레임에 대한 중복 로드가 초당 수십 건 쌓여 '빨라진다'를 갉아먹었다.
 *  wasmPixels.ts:110-127 은 처음부터 작업 전체를 async 안에 두고 finally 에서 지운다 — 그 규약대로 맞춘다. */
function load(key: string, missTtl: number): void {
  if (pending.has(key)) return;
  pending.add(key);
  const gen = epoch;
  void (async () => {
    try {
      const blob = await opfsGet(key);
      if (gen !== epoch) return;
      if (!blob) { missed.set(key, Date.now() + missTtl); return; }
      const url = URL.createObjectURL(blob);
      await new Promise<void>((res) => {
        const img = new Image();
        img.decoding = "async";
        const fin = () => {
          // 로드/디코드 중에 무효화가 지나갔으면 되살리지 않는다
          if (gen !== epoch) { try { URL.revokeObjectURL(url); } catch { /* 무시 */ } }
          else publish(key, url);
          res();
        };
        img.onload = () => {
          const d = (img as HTMLImageElement & { decode?: () => Promise<void> }).decode;
          if (d) d.call(img).then(fin, fin); else fin();
        };
        img.onerror = () => {
          try { URL.revokeObjectURL(url); } catch { /* 무시 */ }
          if (gen === epoch) missed.set(key, Date.now() + missTtl);
          res();
        };
        img.src = url;
      });
    } catch { if (gen === epoch) missed.set(key, Date.now() + missTtl); }
    finally { pending.delete(key); }
  })();
}

/** 본 영상 — 동기 조회. 히트면 blob URL, 미스면 null(호출부가 서버 rendered URL 로 폴백).
 *
 *  ★ `wl` 이 **비어 있을 때만** 히트를 허용한다. 저장본은 검사 기본 W/L 로 구운 이미지라,
 *    사용자가 W/L 을 바꿨는데 저장본이 나오면 화면 오버레이가 표시하는 W/L 과 실제 보이는
 *    영상이 다르다(판독 오해). 기존 미리보기 언더레이 주석이 두 뷰어에서 같은 함정을 이미
 *    경고하고 있다(Viewer2D.tsx:3187 / ViewerInfi.tsx:2775).
 *
 *  ⚠ 호출부는 **Live 검사일 때만** 부른다(isLiveStudyUid) — 스케줄러의 liveMode 게이트와 대칭.
 *    미러 배치에서는 로컬 Orthanc 검사도 SOP UID 가 같아서, 게이트가 없으면 LOCAL 모드 화면에
 *    A 가 렌더한 저장본이 뜬다. */
export function opfsFrameUrl(sopUid: string, wl: string): string | null {
  if (!isDlMode() || !sopUid || wl) return null;
  const key = dlKey("full", sopUid, fixedFormatTag());
  const hit = urlCache.get(key);
  if (hit) return hit;
  if (missIsFresh(key)) return null;
  load(key, MISS_TTL);
  return null;
}

/** 썸네일 — 무음 전환의 **언더레이 입력**(previewUrlOf 가 유일한 소비자). */
export function opfsThumbUrl(sopUid: string): string | null {
  if (!isDlMode() || !sopUid) return null;
  const key = dlKey("th", sopUid);
  const hit = urlCache.get(key);
  if (hit) return hit;
  if (missIsFresh(key)) return null;
  load(key, MISS_TTL_TH);
  return null;
}
