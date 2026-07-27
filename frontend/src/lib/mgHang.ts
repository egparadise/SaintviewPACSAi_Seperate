// 2D-MG — 유방촬영(MG) 좌우 사이 빈 공간(공기) 제거 모드.
//
// 왜: MG 표준 행잉은 좌/우 유방을 back-to-back(흉벽이 가운데에서 맞닿고 유두가 바깥)으로 건다.
// MG 프레임은 세로로 길어(예: 1914×2294) 가로로 넓은 페인에 objectFit:contain 으로 넣으면
// 좌우에 레터박스가 크게 생기고, 프레임 안에도 유두 반대쪽 공기가 넓게 남는다. 그래서 2×2로
// 걸면 화면 한가운데가 통째로 검게 비고 정작 조직은 작게 보인다. 이 모듈은 프레임에서
// **조직 경계상자**를 찾아 그 부분만 타일에 꽉 차게 앉히되, **흉벽 쪽을 타일의 안쪽(가운데)
// 가장자리에 붙여** 좌·우 영상이 가운데에서 맞닿게 한다(체크 해제 시 원본 그대로).
// 흉벽 판정: 조직이 프레임 가장자리에 닿는 쪽이 흉벽, 반대쪽이 유두(공기가 넓게 남는 쪽).
// 그 흉벽 쪽을 '같은 방향의 타일 가장자리'에 붙이면 back-to-back 배치가 된다
// (R 유방=화면 왼쪽 타일, 흉벽이 프레임 오른쪽 → 타일 오른쪽=가운데에 정렬).
//
// 설계 요점
//  - 뷰어 3종(I-View/T-View/SaintView)이 같은 계산을 쓰도록 순수 함수로 분리.
//  - 뷰어의 페인 변환은 `translate(tx,ty) scale(zoom·flip) rotate(rot)` 하나뿐이므로,
//    MG 보정을 **페인 상태 위에 합성**해서 pEff 를 만든다(§mgApply). 그러면 주석·측정·
//    스카우트선 등 기존 좌표 수학(모두 pane.zoom/tx/ty 기반)이 그대로 맞는다.
//  - 조직 경계상자는 화면에 이미 뜬 <img> 에서 캔버스로 축소 샘플링해 구한다(추가 네트워크 0).
//    타 출처(외부 DICOMweb)라 canvas 가 오염되면 설정의 고정 비율로 폴백한다.

import { useCallback, useEffect, useRef, useState } from "react";

/** 조직 경계상자 — 프레임 크기 대비 0~1 정규화. wall = 흉벽이 붙은 쪽(원본 픽셀 기준) */
export interface MgBox { x0: number; y0: number; x1: number; y1: number; wall: "L" | "R" }

/** MG 모드 설정 — viewer.prefs.mg_hang (설정 > 뷰어 공통 > 2D 행잉 > MG) */
export interface MgCfg {
  on: boolean;        // 기본 사용(뷰어 진입 시 2D-MG 체크 상태)
  layout: string;     // MG 기본 Image layout ("1x2" | "2x2" | "2x3")
  margin: number;     // 조직 주위 여백 %(0~10) — 잘림 방지
  thr: number;        // 배경(공기) 판정 임계 %(1~40) — 프레임 최소~최대 밝기 사이 비율
  detect: "auto" | "ratio";   // auto=픽셀에서 조직 경계 탐지, ratio=고정 비율(아래)
  // ⚠ 탐지 불가(타 출처 canvas 오염 등)일 때 고정 비율로 **추정 크롭**을 할지.
  //    기본 off — 근거 없이 맘모를 자르는 것은 조직을 숨길 수 있어 원본 유지가 안전하다.
  blind_ratio: boolean;
  ratio: number;      // detect=ratio 또는 blind_ratio 일 때 안쪽에서 잘라낼 폭 %(0~60)
}

/** MG 모드가 지원하는 Image layout — 사용자 요구(1:2 · 2:2 · 2:3) */
export const MG_LAYOUTS = ["1x2", "2x2", "2x3"] as const;

export const DEFAULT_MG_CFG: MgCfg = {
  on: true, layout: "2x2", margin: 2, thr: 12, detect: "auto", blind_ratio: false, ratio: 38,
};

/** viewer.prefs 값 → MgCfg (결측·이상값 방어) */
export function readMgCfg(v: unknown): MgCfg {
  const o = (v ?? {}) as Partial<MgCfg>;
  const num = (x: unknown, d: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, typeof x === "number" && isFinite(x) ? x : d));
  return {
    on: typeof o.on === "boolean" ? o.on : DEFAULT_MG_CFG.on,
    layout: (MG_LAYOUTS as readonly string[]).includes(o.layout ?? "")
      ? (o.layout as string) : DEFAULT_MG_CFG.layout,
    margin: num(o.margin, DEFAULT_MG_CFG.margin, 0, 10),
    thr: num(o.thr, DEFAULT_MG_CFG.thr, 1, 40),
    detect: o.detect === "ratio" ? "ratio" : "auto",
    blind_ratio: typeof o.blind_ratio === "boolean" ? o.blind_ratio : DEFAULT_MG_CFG.blind_ratio,
    ratio: num(o.ratio, DEFAULT_MG_CFG.ratio, 0, 60),
  };
}

/** "2x2" → {r:2,c:2} */
export function toRC(s: string, def = { r: 2, c: 2 }): { r: number; c: number } {
  const [r, c] = String(s).split("x").map(Number);
  return r > 0 && c > 0 ? { r, c } : def;
}

// ── 조직 경계상자 탐지 ────────────────────────────────────────────────────
// ⚠ 결과는 반드시 **3상태**여야 한다. 예전엔 "상자 or null" 2상태여서,
//   *공기 여백이 없어 보정이 필요 없는* 프레임(null)과 *픽셀을 못 읽은* 프레임(null)이
//   구분되지 않아 전자에도 고정 38% 컷이 먹었다 — 멀쩡한 조직이 잘려 나갔다.
//     box  : 잘라낼 여백을 찾음
//     none : 프레임이 이미 조직으로 꽉 참 → **보정하지 않는다**
//     blind: canvas 오염 등으로 픽셀을 못 읽음 → 설정의 고정 비율로 폴백
export type MgProbe =
  | { kind: "box"; box: MgBox }
  | { kind: "none" }
  | { kind: "blind" };

// 캐시 키에 임계값을 포함한다 — 설정에서 배경 임계값을 바꾸면 다시 탐지해야 한다
const BOXES = new Map<string, MgProbe>();
const PROBE_MAX = 192;      // 샘플링 해상도(긴 변) — 경계상자 정밀도엔 이 정도면 충분
const RUN = 3;              // 유효 시작/끝으로 인정할 연속 칸 수 — 번인 문자·점 노이즈 무시
const FILL = 0.04;          // 한 줄이 '조직'이려면 임계 초과 픽셀이 4% 이상

const _key = (sop: string, thrPct: number) => `${sop}|${Math.round(thrPct)}`;

export function mgBoxOf(sop: string, thrPct: number): MgProbe | undefined {
  return BOXES.get(_key(sop, thrPct));
}

/** 화면에 뜬 <img> 에서 조직 경계상자 산출(동기, SOP+임계 캐시). */
export function mgProbe(sop: string, img: HTMLImageElement, thrPct: number): MgProbe {
  if (!sop) return { kind: "blind" };
  const ck = _key(sop, thrPct);
  const hit = BOXES.get(ck);
  if (hit !== undefined) return hit;
  let out: MgProbe = { kind: "blind" };
  try {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    if (iw > 1 && ih > 1) {
      const sc = Math.min(1, PROBE_MAX / Math.max(iw, ih));
      const w = Math.max(8, Math.round(iw * sc)), h = Math.max(8, Math.round(ih * sc));
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(img, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h).data;   // 타 출처면 여기서 SecurityError
        const lum = new Float32Array(w * h);
        let lo = 255, hi = 0;
        for (let i = 0, k = 0; k < w * h; k++, i += 4) {
          const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
          lum[k] = v;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (hi - lo > 12) {          // 완전 균일 프레임은 대상 아님
          const thr = lo + (hi - lo) * (Math.max(1, Math.min(40, thrPct)) / 100);
          const colN = new Int32Array(w), rowN = new Int32Array(h);
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              if (lum[y * w + x] > thr) { colN[x]++; rowN[y]++; }
            }
          }
          const span = (n: Int32Array, len: number, other: number): [number, number] => {
            const on = (i: number) => n[i] >= Math.max(1, other * FILL);
            let a = -1, b = -1;
            for (let i = 0; i <= len - RUN; i++) {
              let ok = true;
              for (let k = 0; k < RUN; k++) if (!on(i + k)) { ok = false; break; }
              if (ok) { a = i; break; }
            }
            for (let i = len - 1; i >= RUN - 1; i--) {
              let ok = true;
              for (let k = 0; k < RUN; k++) if (!on(i - k)) { ok = false; break; }
              if (ok) { b = i; break; }
            }
            return [a, b];
          };
          const [cx0, cx1] = span(colN, w, h);
          const [ry0, ry1] = span(rowN, h, w);
          if (cx0 >= 0 && cx1 > cx0 && ry0 >= 0 && ry1 > ry0) {
            const x0 = cx0 / w, x1 = (cx1 + 1) / w, y0 = ry0 / h, y1 = (ry1 + 1) / h;
            // 잘라낼 공기가 거의 없으면(가로 97% 이상 차지) **보정하지 않는다**(none).
            // 고정 비율 폴백으로 흘려보내면 안 된다 — 꽉 찬 프레임을 38% 잘라먹는다.
            out = x1 - x0 < 0.97
              // 흉벽 = 조직이 프레임 가장자리에 붙은 쪽(유두 쪽엔 공기가 넓게 남는다)
              ? { kind: "box", box: { x0, y0, x1, y1, wall: x0 <= 1 - x1 ? "L" : "R" } }
              : { kind: "none" };
          }
        }
      }
    }
  } catch {
    out = { kind: "blind" };    // canvas 오염(타 출처 DICOMweb) 등 — 고정 비율 폴백으로
  }
  if (BOXES.size > 2000) BOXES.clear();
  BOXES.set(ck, out);
  return out;
}

/** 탐지 실패/비활성 시 쓰는 고정 비율 상자 — 안쪽(유두 쪽)에서 ratio% 를 잘라낸다 */
export function mgRatioBox(wall: "L" | "R", ratio: number): MgBox {
  const cut = Math.max(0, Math.min(60, ratio)) / 100;
  return wall === "L"
    ? { x0: 0, y0: 0, x1: 1 - cut, y1: 1, wall }
    : { x0: cut, y0: 0, x1: 1, y1: 1, wall };
}

/** 타일 열 위치로 흉벽 방향 추정 — 픽셀 탐지도 검사명도 없을 때의 마지막 폴백.
 *  back-to-back 행잉: 왼쪽 절반 타일(R 유방)은 흉벽이 오른쪽, 오른쪽 절반(L 유방)은 왼쪽. */
export function mgWallByCol(tileIndex: number, cols: number): "L" | "R" {
  if (cols <= 1) return "R";
  return (tileIndex % cols) < cols / 2 ? "R" : "L";
}

// ── 변환 계산 ─────────────────────────────────────────────────────────────

export interface MgFit { mz: number; mtx: number; mty: number }

/** 이 타일 하나만 놓고 봤을 때의 후보 배율. 실제 적용 배율은 호출부가 대상 전체의
 *  **최소값**을 취해 동일하게 맞춘다(좌우 유방 크기 비교 보존). */
export function mgZoomOf(
  tile: { w: number; h: number },
  img: { w: number; h: number },
  box: MgBox | null | undefined,
  cfg: Pick<MgCfg, "margin">,
): number | null {
  if (!box) return null;
  const W = tile.w, H = tile.h, iw = img.w, ih = img.h;
  if (!(W > 0 && H > 0 && iw > 0 && ih > 0)) return null;
  const m = Math.max(0, Math.min(10, cfg.margin)) / 100;
  const bw = Math.min(1, box.x1 + m) - Math.max(0, box.x0 - m);
  const bh = Math.min(1, box.y1 + m) - Math.max(0, box.y0 - m);
  if (bw <= 0.02 || bh <= 0.02) return null;
  const s0 = Math.min(W / iw, H / ih);
  const z = Math.min(W / (bw * iw * s0), H / (bh * ih * s0));
  return isFinite(z) && z > 0 ? z : null;
}

/** 조직 상자를 타일에 맞춰 앉히는 보정값(사용자 조작이 없는 상태 기준).
 *  tile/img 는 px, box 는 0~1 정규화. flip 은 표시 좌우/상하 반전 상태.
 *
 *  ⚠ forceZoom: 맞붙임 대상 페인·타일은 **반드시 같은 배율**이어야 한다.
 *  좌우 유방의 크기·밀도 비교가 판독의 핵심이라, 페인마다 배율이 다르면 없는 비대칭이
 *  보인다. 호출부가 후보 배율(mgZoomOf)의 **최소값**을 구해 여기로 넘긴다. */
export function mgFit(
  tile: { w: number; h: number },
  img: { w: number; h: number },
  box: MgBox | null | undefined,
  cfg: Pick<MgCfg, "margin">,
  flipH = false, flipV = false,
  forceZoom?: number,
): MgFit | null {
  if (!box) return null;
  const W = tile.w, H = tile.h, iw = img.w, ih = img.h;
  if (!(W > 0 && H > 0 && iw > 0 && ih > 0)) return null;
  const m = Math.max(0, Math.min(10, cfg.margin)) / 100;
  const x0 = Math.max(0, box.x0 - m), x1 = Math.min(1, box.x1 + m);
  const y0 = Math.max(0, box.y0 - m), y1 = Math.min(1, box.y1 + m);
  const bw = x1 - x0, bh = y1 - y0;
  if (bw <= 0.02 || bh <= 0.02) return null;

  // objectFit:contain 기준 배율 → zoom=1 일 때 화면에 그려지는 이미지 크기
  const s0 = Math.min(W / iw, H / ih);
  const dw = iw * s0, dh = ih * s0;
  const mz = forceZoom !== undefined && forceZoom > 0
    ? forceZoom
    : Math.min(W / (bw * dw), H / (bh * dh));
  if (!isFinite(mz) || mz <= 0) return null;

  const sx = flipH ? -1 : 1, sy = flipV ? -1 : 1;
  const ex0 = sx * mz * (x0 - 0.5) * dw, ex1 = sx * mz * (x1 - 0.5) * dw;
  const left = Math.min(ex0, ex1), right = Math.max(ex0, ex1);
  // 흉벽이 화면에서 어느 쪽인지 — 좌우 반전되면 뒤집힌다.
  // 그 방향의 타일 가장자리에 붙인다(= 좌우 타일이 가운데에서 맞닿음)
  const wallDisp = flipH ? (box.wall === "L" ? "R" : "L") : box.wall;
  const mtx = wallDisp === "L" ? -(W / 2) - left : (W / 2) - right;

  const ey0 = sy * mz * (y0 - 0.5) * dh, ey1 = sy * mz * (y1 - 0.5) * dh;
  const mty = -(Math.min(ey0, ey1) + Math.max(ey0, ey1)) / 2;
  return { mz, mtx, mty };
}

/** 페인 상태에 MG 보정을 합성한 pEff — 뷰어의 transform·주석 좌표 수학이 그대로 쓴다.
 *  사용자 pan/zoom 은 MG 배치 '위에' 얹히므로 보정 후에도 이동·확대가 자연스럽다.
 *  회전 중(rot≠0)에는 축 정렬 계산이 성립하지 않아 보정을 건너뛴다. */
export interface PaneLike { zoom: number; tx: number; ty: number; rot: number }
export function mgApply<T extends PaneLike>(p: T, fit: MgFit | null): T {
  if (!fit || p.rot % 360 !== 0) return p;
  return { ...p, zoom: p.zoom * fit.mz, tx: p.tx + p.zoom * fit.mtx, ty: p.ty + p.zoom * fit.mty };
}

/** 타일 DOM 에 새겨둘 보정값 — 마우스 드래그(주석·측정)는 tileEl 만 들고 다니므로,
 *  screenToImg 계열이 여기서 보정을 되읽어 좌표를 맞춘다(호출부 수정 없이 전 경로 정합). */
export function mgStamp(fit: MgFit | null): string | undefined {
  return fit ? `${fit.mz},${fit.mtx},${fit.mty}` : undefined;
}

/** tileEl 의 data-sv-mg 를 반영한 pEff — 없으면 p 그대로 */
export function mgFromEl<T extends PaneLike>(el: Element | null, p: T): T {
  const s = (el as HTMLElement | null)?.dataset?.svMg;
  if (!s) return p;
  const [mz, mtx, mty] = s.split(",").map(Number);
  if (!isFinite(mz) || !isFinite(mtx) || !isFinite(mty)) return p;
  return mgApply(p, { mz, mtx, mty });
}

// ── 타일 실측 ─────────────────────────────────────────────────────────────
/** 키별 엘리먼트 크기 관찰 — 타일 px 크기가 있어야 조직 상자를 화면 좌표로 앉힐 수 있다.
 *  `ref={sizeRef(key)}` 로 붙이면 되고, ref 콜백은 키마다 동일 함수라 렌더마다 재관찰하지 않는다. */
export function useTileSizes() {
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>({});
  const roRef = useRef<ResizeObserver | null>(null);
  const keyOf = useRef(new WeakMap<Element, string>());
  const cbs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const cur = useRef(new Map<string, Element>());

  const put = useCallback((k: string, w: number, h: number) => {
    setSizes((prev) => {
      const o = prev[k];
      if (o && Math.abs(o.w - w) < 0.5 && Math.abs(o.h - h) < 0.5) return prev;
      return { ...prev, [k]: { w, h } };
    });
  }, []);

  const ro = () => {
    if (!roRef.current && typeof ResizeObserver !== "undefined") {
      roRef.current = new ResizeObserver((ents) => {
        for (const e of ents) {
          const k = keyOf.current.get(e.target);
          if (k) put(k, e.contentRect.width, e.contentRect.height);
        }
      });
    }
    return roRef.current;
  };
  useEffect(() => () => { roRef.current?.disconnect(); roRef.current = null; }, []);

  const sizeRef = useCallback((k: string) => {
    let cb = cbs.current.get(k);
    if (!cb) {
      cb = (el: HTMLElement | null) => {
        const obs = ro();
        const old = cur.current.get(k);
        if (old && old !== el) { obs?.unobserve(old); keyOf.current.delete(old); }
        if (el) {
          cur.current.set(k, el);
          keyOf.current.set(el, k);
          obs?.observe(el);
        } else cur.current.delete(k);
      };
      cbs.current.set(k, cb);
    }
    return cb;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { sizes, sizeRef };
}
