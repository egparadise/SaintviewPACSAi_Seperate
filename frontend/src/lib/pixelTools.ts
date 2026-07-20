// 캔버스 픽셀 샘플링 — In Viewer(ViewerInfi) samplePixels/rawOf 이식 (TY 공용, Lens/Profile/2D Table)
// WADO-RS rendered PNG(8bit) 를 crossOrigin canvas 로 읽는다. W/L(c,w)을 알면 근사 원값으로 역변환:
//   raw ≈ (v/255)·w + (c − w/2)  — 표기는 '≈' (근사값, 원본 픽셀 아님)

const _pixCache = new Map<string, ImageData>();

/** rendered 이미지를 cols×rows 캔버스로 읽어 ImageData 반환 (CORS taint 시 null) */
export async function samplePixels(url: string, cols: number, rows: number): Promise<ImageData | null> {
  const hit = _pixCache.get(url);
  if (hit) return hit;
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const cv = document.createElement("canvas");
        cv.width = cols; cv.height = rows;
        const ctx = cv.getContext("2d")!;
        ctx.drawImage(img, 0, 0, cols, rows);
        const data = ctx.getImageData(0, 0, cols, rows);
        if (_pixCache.size > 40) _pixCache.clear();   // 캐시 상한
        _pixCache.set(url, data);
        resolve(data);
      } catch { resolve(null); }   // CORS taint 등
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** 8bit 표시값 → W/L 역변환 근사 원값(HU 근사). wl="" 이면 표시값 그대로 */
export function rawOf(v: number, wl: string): number {
  if (!wl) return v;
  const [c, w] = wl.split(",").map(Number);
  if (Number.isNaN(c) || Number.isNaN(w)) return v;
  return (v / 255) * w + (c - w / 2);
}

/** 픽셀 (x,y) 의 근사 원값 — 범위 클램프 포함 */
export function rawAt(data: ImageData, x: number, y: number, wl: string): number {
  const cx = Math.max(0, Math.min(data.width - 1, Math.round(x)));
  const cy = Math.max(0, Math.min(data.height - 1, Math.round(y)));
  return rawOf(data.data[(cy * data.width + cx) * 4], wl);
}
