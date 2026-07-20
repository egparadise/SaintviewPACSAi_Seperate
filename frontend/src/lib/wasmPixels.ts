// WASM 디코딩 파이프라인 (베타) — 2D 뷰어의 이미지 '소스'를 서버 렌더링 JPEG 에서
// WADO-RS 원본 프레임(bulkdata) + 브라우저 WASM 디코딩(openjph/charls/openjpeg)으로 교체.
// 기존 <img> 요소·CSS 변환·주석 수학은 그대로 — blob URL 만 갈아끼운다.
// 핵심 이득: W/L 조정이 서버 왕복 없이 로컬 LUT 재계산(픽셀 원본은 1회만 수신·캐시).
import { authHeader, framesBase, getWadoTs } from "./cornerstone";
// ⚠ cornerstone 코어/로더는 무겁다(수 MB) — WASM 모드가 실제로 켜졌을 때만 동적 로드(번들 분리)
type CsImage = {
  columns: number; rows: number; color?: boolean; invert?: boolean;
  slope?: number; intercept?: number;
  windowCenter?: number | number[]; windowWidth?: number | number[];
  getPixelData: () => Int16Array | Uint16Array | Uint8Array | Float32Array;
};
let csLoadImage: ((id: string) => Promise<CsImage>) | null = null;

let wasmOn = false;                     // 설정>뷰어 공통 'WASM 디코딩(베타)' — 모듈 플래그
let initialized = false;
const urlCache = new Map<string, string>();      // `${sop}|${wl}` → blob URL (렌더 완료)
const pixelPending = new Set<string>();          // 진행 중 sop (중복 로드 방지)
const listeners = new Set<() => void>();         // 프레임 준비 알림(뷰어 재렌더 트리거)
const LRU: string[] = [];                        // blob URL 정리용 키 순서
const LRU_MAX = 1200;   // 대형 CT/MR 시리즈 전체가 캐시에 머물도록(시리즈 워머와 연동)

export function setWasmPipeline(on: boolean): void { wasmOn = on; }
export function isWasmPipeline(): boolean { return wasmOn; }
export function onWasmFrame(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

async function ensureCs(): Promise<void> {
  if (initialized) return;
  initialized = true;
  const core = await import("@cornerstonejs/core");
  const loader = await import("@cornerstonejs/dicom-image-loader");
  await core.init({ rendering: { useNorm16Texture: true } } as unknown as Parameters<typeof core.init>[0]);
  loader.init({
    beforeSend: (_xhr: XMLHttpRequest, imageId: string) => {
      // HTJ2K 프록시(백엔드) — JWT 필요. 그 외 Orthanc 직결은 전송구문 Accept 지정
      if (imageId.includes("/api/htj2k/")) return authHeader();
      const ts = getWadoTs();
      if (ts && imageId.includes("/frames/")) {
        return { Accept: `multipart/related; type="application/octet-stream"; transfer-syntax=${ts}` };
      }
    },
  } as Parameters<typeof loader.init>[0]);
  csLoadImage = (id: string) => core.imageLoader.loadAndCacheImage(id) as unknown as Promise<CsImage>;
}

/** 픽셀 → 8bit RGBA 캔버스 (Modality LUT + VOI 윈도우 + MONOCHROME1 반전) → blob URL */
function renderToBlobUrl(image: CsImage, wl: string, key: string): void {
  const w = image.columns, h = image.rows;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const out = ctx.createImageData(w, h);
  const px = image.getPixelData() as Int16Array | Uint16Array | Uint8Array | Float32Array;
  if (image.color) {
    // 컬러(RGB/RGBA) — W/L 없이 그대로
    const rgba = out.data;
    const stride = px.length / (w * h) >= 4 ? 4 : 3;
    for (let i = 0, j = 0; j < w * h; j++, i += stride) {
      const o = j * 4;
      rgba[o] = px[i]; rgba[o + 1] = px[i + 1]; rgba[o + 2] = px[i + 2]; rgba[o + 3] = 255;
    }
  } else {
    const slope = image.slope ?? 1, intercept = image.intercept ?? 0;
    let wc = image.windowCenter as number | number[] | undefined;
    let ww = image.windowWidth as number | number[] | undefined;
    if (Array.isArray(wc)) wc = wc[0];
    if (Array.isArray(ww)) ww = ww[0];
    if (wl) {
      const [c0, w0] = wl.split(",").map(Number);
      if (Number.isFinite(c0) && Number.isFinite(w0) && w0 > 0) { wc = c0; ww = w0; }
    }
    if (!Number.isFinite(wc as number) || !Number.isFinite(ww as number) || !(ww as number)) {
      // 태그 없으면 데이터 범위
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < px.length; i++) { const v = px[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      wc = ((mn + mx) / 2) * slope + intercept; ww = Math.max(1, (mx - mn) * slope);
    }
    const lo = (wc as number) - (ww as number) / 2;
    const scale = 255 / (ww as number);
    const inv = image.invert === true;    // MONOCHROME1
    const rgba = out.data;
    for (let i = 0; i < w * h; i++) {
      let v = (px[i] * slope + intercept - lo) * scale;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      if (inv) v = 255 - v;
      const o = i * 4;
      rgba[o] = rgba[o + 1] = rgba[o + 2] = v; rgba[o + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  canvas.toBlob((b) => {
    if (!b) return;
    const url = URL.createObjectURL(b);
    const old = urlCache.get(key);
    if (old) URL.revokeObjectURL(old);
    urlCache.set(key, url);
    LRU.push(key);
    while (LRU.length > LRU_MAX) {
      const k = LRU.shift()!;
      if (k !== key && urlCache.has(k)) { URL.revokeObjectURL(urlCache.get(k)!); urlCache.delete(k); }
    }
    listeners.forEach((cb) => cb());
  }, "image/png");
}

/** 동기 조회 — 준비된 blob URL 반환, 미준비면 비동기 로드 시작 후 null (호출부는 서버 URL 폴백) */
export function wasmFrameUrl(studyUid: string, seriesUid: string, sopUid: string, wl: string): string | null {
  if (!wasmOn) return null;
  const key = `${sopUid}|${wl}`;
  const hit = urlCache.get(key);
  if (hit) return hit;
  if (pixelPending.has(key)) return null;
  pixelPending.add(key);
  void (async () => {
    try {
      await ensureCs();
      const imageId = `wadors:${framesBase()}/studies/${studyUid}/series/${seriesUid}/instances/${sopUid}/frames/1`;
      // 픽셀 원본은 cornerstone 캐시가 보관 — W/L 변경 시 재수신 없이 LUT 만 재계산
      const image = await csLoadImage!(imageId);
      renderToBlobUrl(image, wl, key);
    } catch { /* 디코딩 실패 — 서버 렌더링 폴백 유지 */ }
    finally { pixelPending.delete(key); }
  })();
  return null;
}
