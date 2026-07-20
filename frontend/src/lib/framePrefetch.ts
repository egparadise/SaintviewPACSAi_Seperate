// 프레임 프리페치 — 스크롤·시네·되감기가 캐시 히트로 즉시 표시되게 인접/전체 슬라이스를 선제 로드.
// UI/UX 불변: 화면 요소·URL 체계는 그대로 두고, 브라우저 이미지 캐시를 미리 예열만 한다.
// (<img src> 교체 시 이미 디코드된 비트맵이 있으므로 왕복 없이 그려진다)
const cache = new Map<string, HTMLImageElement>();   // url → 로드 완료 이미지(디코드 참조 유지)
const inflight = new Map<string, HTMLImageElement>();
const lru: string[] = [];
// 개수 상한 — HTMLImageElement 참조는 압축 원본 바이트를 고정한다(디코드 비트맵은 브라우저가
// 압박 시 폐기 가능). 512² CT PNG ≈ 150-250KB/장 기준 최대 ~90-150MB. 대형 매트릭스(DX/MG)는
// 뷰어 쪽에서 시리즈 워밍을 제외한다(±인접 프리페치만).
const LRU_MAX = 600;

function load(url: string, onDone?: () => void): void {
  if (cache.has(url) || inflight.has(url)) { onDone?.(); return; }
  const img = new Image();
  img.decoding = "async";
  const done = () => {
    inflight.delete(url);
    cache.set(url, img);
    lru.push(url);
    while (lru.length > LRU_MAX) {
      const k = lru.shift();
      if (k && k !== url) cache.delete(k);
    }
    onDone?.();
  };
  img.onload = () => {
    // decode() — src 교체 순간의 메인스레드 디코드 스톨까지 제거
    const d = (img as HTMLImageElement & { decode?: () => Promise<void> }).decode;
    if (d) d.call(img).then(done, done); else done();
  };
  img.onerror = () => { inflight.delete(url); onDone?.(); };
  inflight.set(url, img);
  img.src = url;
}

/** 단건 프리페치 — blob(로컬 WASM)·중복은 무시 */
export function prefetchUrl(url: string | null | undefined): void {
  if (!url || url.startsWith("blob:")) return;
  load(url);
}

/** 인접 슬라이스 프리페치 — 진행 방향 앞쪽 가중(앞 ahead장·뒤 behind장) */
export function prefetchAround(
  urlAt: (idx: number) => string | null,
  center: number, len: number, dir: number,
  ahead = 8, behind = 3,
): void {
  if (len <= 1) return;
  const wrap = (i: number) => ((i % len) + len) % len;
  const d = dir >= 0 ? 1 : -1;
  for (let k = 1; k <= ahead; k++) prefetchUrl(urlAt(wrap(center + d * k)));
  for (let k = 1; k <= behind; k++) prefetchUrl(urlAt(wrap(center - d * k)));
}

/* ── 시리즈 워머 — 활성 시리즈 전체를 현재 위치→바깥 순서로 백그라운드 예열(동시 2) ──
 * 새 워밍 시작 시 이전 워밍은 토큰으로 중단(시리즈 전환·검사 전환 시 낭비 방지). */
let warmToken = 0;

export function warmSeries(
  urlAt: (idx: number) => string | null,
  len: number, startIdx: number,
  { delayMs = 1200, concurrency = 2 }: { delayMs?: number; concurrency?: number } = {},
): void {
  const token = ++warmToken;
  if (len <= 1) return;
  // 현재 위치에서 바깥으로 퍼지는 순서(가까운 슬라이스 우선)
  const order: number[] = [startIdx];
  for (let d = 1; d < len; d++) {
    if (startIdx + d < len) order.push(startIdx + d);
    if (startIdx - d >= 0) order.push(startIdx - d);
  }
  let i = 0;
  const pump = () => {
    if (token !== warmToken) return;   // 새 워밍으로 대체됨 — 중단
    while (i < order.length) {
      const url = urlAt(order[i++]);
      if (!url || url.startsWith("blob:")) continue;
      if (cache.has(url) || inflight.has(url)) continue;
      load(url, pump);
      return;   // 한 슬롯 소비 — 완료 콜백이 다음을 끌어감
    }
  };
  window.setTimeout(() => {
    if (token !== warmToken) return;
    for (let c = 0; c < concurrency; c++) pump();
  }, delayMs);
}

/** 진행 중 워밍 중단 (뷰어 닫기 등) */
export function cancelWarm(): void { warmToken++; }
