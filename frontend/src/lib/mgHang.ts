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
  // 배경과 '다르다'고 볼 밝기 차이(0~255). 프레임 네 모서리에서 잰 배경 밝기 기준이라
  // MONOCHROME1(공기가 흰색)처럼 반전된 영상도 그대로 처리된다.
  thr: number;
  detect: "auto" | "ratio";   // auto=픽셀에서 조직 경계 탐지, ratio=고정 비율(아래)
  // ⚠ 탐지 불가(타 출처 canvas 오염 등)일 때 고정 비율로 **추정 크롭**을 할지.
  //    기본 off — 근거 없이 맘모를 자르는 것은 조직을 숨길 수 있어 원본 유지가 안전하다.
  blind_ratio: boolean;
  ratio: number;      // detect=ratio 또는 blind_ratio 일 때 안쪽에서 잘라낼 폭 %(0~60)
}

/** MG 모드가 지원하는 Image layout — 사용자 요구(1:2 · 2:2 · 2:3) */
/** 이 modality 문자열이 MG 인가. A 가 다중값("MG\CR")을 줄 수 있어 분해해서 본다. */
export const isMg = (m?: string | null): boolean =>
  // 구분자를 열거하지 않고 **영숫자가 아닌 것 전부**로 쪼갠다.
  // DICOM 다중값 구분자는 역슬래시인데, 문자 클래스에 역슬래시를 쓰면 이스케이프가
  // 도구를 거칠 때마다 하나씩 줄어 조용히 빠진다(실제로 그렇게 한 번 틀렸다).
  // 이 형태는 역슬래시·슬래시·쉼표·공백을 모두 덮고, 'MGX' 는 한 토큰으로 남아 걸리지 않는다.
  String(m ?? "").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean).includes("MG");

/**
 * 이 페인이 MG 인가 — **시리즈 modality 가 있으면 그것만 믿고, 비어 있을 때만** 검사
 * modality 로 보강한다.
 *
 * ⚠ 왜 보강이 필요한가: Live 경로에서 시리즈 modality 의 출처는 DICOMweb v2 메타데이터의
 *   (0008,0060) **하나뿐**이고, 그 조회가 실패하거나 태그가 없으면 조용히 "" 가 된다.
 *   그러면 2D-MG 체크박스가 사라지고 보정 엔진도 통째로 안 돈다 —
 *   **MG 검사인데 4-view 는 걸리고 2D-MG 만 없는** 상태(사용자 보고: 첫 로그인 후 첫 맘모).
 *
 * ⚠ 왜 '비어 있을 때만' 인가: MG 검사 안의 US·CT 시리즈까지 MG 로 보면 안 된다.
 *   시리즈가 자기 modality 를 말했다면 그것이 최종이다.
 */
export const mgPaneIs = (seriesModality?: string | null,
                         examModality?: string | null): boolean => {
  const sm = String(seriesModality ?? "").trim();
  return sm ? isMg(sm) : isMg(examModality);
};

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
    thr: num(o.thr, DEFAULT_MG_CFG.thr, 1, 80),
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
const PROBE_MAX = 256;      // 샘플링 해상도(긴 변) — 경계상자 정밀도엔 이 정도면 충분
const MIN_FRAC = 0.005;     // 한 줄이 '조직'이려면 배경과 다른 픽셀이 0.5% 이상(최소 2칸)
const PAD = 0.006;          // 조직 경계 여유(가장자리 잘림 방지) — 프레임 대비 비율

const _key = (sop: string, thrPct: number) => `${sop}|${Math.round(thrPct)}`;

export function mgBoxOf(sop: string, thrPct: number): MgProbe | undefined {
  return BOXES.get(_key(sop, thrPct));
}

/** 네 모서리 8×8 패치의 중앙값 = 배경(공기) 밝기.
 *  절대 밝기가 아니라 **배경과의 차이**로 판정하므로 MONOCHROME1(공기가 흰색) 영상도
 *  그대로 처리된다. 예전에는 프레임 최소~최대 사이 비율을 썼는데, 반전 영상에서는
 *  공기가 '가장 밝은 값'이라 조직/배경이 통째로 뒤바뀌었다. */
function cornerBg(d: Uint8ClampedArray, w: number, h: number): number {
  const n = Math.min(8, w, h);
  const vals: number[] = [];
  for (const [ox, oy] of [[0, 0], [w - n, 0], [0, h - n], [w - n, h - n]]) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) vals.push(d[((oy + y) * w + (ox + x)) * 4]);
    }
  }
  vals.sort((a, b) => a - b);
  return vals[vals.length >> 1] ?? 0;
}

/** 조직이 가장 두꺼운 줄에서 좌·우(위·아래)로 연속 확장한 범위.
 *  가장자리에서부터 훑지 않는 것이 핵심 — 공기 영역에 떠 있는 번인 마커(R/L 표식 등)는
 *  사이의 빈 줄에서 확장이 끊겨 저절로 제외된다. */
function grow(n: Int32Array, len: number, minCount: number): [number, number] | null {
  let peak = 0;
  for (let i = 1; i < len; i++) if (n[i] > n[peak]) peak = i;
  if (n[peak] < minCount) return null;               // 조직 없음
  let a = peak, b = peak;
  while (a > 0 && n[a - 1] >= minCount) a--;
  while (b < len - 1 && n[b + 1] >= minCount) b++;
  return [a, b];
}

/** 로드된 이미지 한 장을 분석 — 엘리먼트 경로(mgProbe)와 URL 경로(mgProbeUrl)가 공유한다. */
function analyze(img: HTMLImageElement, thr: number): MgProbe {
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
        const bg = cornerBg(d, w, h);
        const t = Math.max(1, Math.min(80, thr));
        const colN = new Int32Array(w), rowN = new Int32Array(h);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (Math.abs(d[((y * w) + x) * 4] - bg) > t) { colN[x]++; rowN[y]++; }
          }
        }
        const cs = grow(colN, w, Math.max(2, Math.round(h * MIN_FRAC)));
        const rs = grow(rowN, h, Math.max(2, Math.round(w * MIN_FRAC)));
        if (cs && rs) {
          const x0 = Math.max(0, cs[0] / w - PAD), x1 = Math.min(1, (cs[1] + 1) / w + PAD);
          const y0 = Math.max(0, rs[0] / h - PAD), y1 = Math.min(1, (rs[1] + 1) / h + PAD);
          // 잘라낼 공기가 거의 없으면(가로 97% 이상 차지) **보정하지 않는다**(none).
          // 고정 비율 폴백으로 흘려보내면 안 된다 — 꽉 찬 프레임을 38% 잘라먹는다.
          out = x1 - x0 < 0.97 && x1 > x0 && y1 > y0
            // 흉벽 = 조직이 프레임 가장자리에 붙은 쪽(유두 쪽엔 공기가 넓게 남는다)
            ? { kind: "box", box: { x0, y0, x1, y1, wall: x0 <= 1 - x1 ? "L" : "R" } }
            : { kind: "none" };
        } else {
          out = { kind: "none" };      // 조직을 못 찾음 — 추정해서 자르지 않는다
        }
      }
    }
  } catch {
    out = { kind: "blind" };    // canvas 오염(타 출처 DICOMweb) 등
  }
  return out;
}

function _remember(ck: string, out: MgProbe): MgProbe {
  if (BOXES.size > 2000) BOXES.clear();
  BOXES.set(ck, out);
  return out;
}

/** 이 이미지를 지금 분석할 수 있는가 — 디코드가 끝나야 캔버스에 그릴 수 있다. */
export const mgReadable = (img: HTMLImageElement | null | undefined): boolean =>
  !!img && img.complete && img.naturalWidth > 1 && img.naturalHeight > 1;

/** 화면에 이미 뜬 <img> 에서 조직 경계상자 산출(동기, 추가 네트워크 0. SOP+임계 캐시).
 *
 * ⚠ **아직 디코드되지 않은 이미지는 캐시하지 않는다.** 예전에는 그 경우에도 analyze 가
 *   blind 를 돌려주고 그것이 BOXES 에 **영구 저장**돼, 한 번 이르게 물어본 SOP 는 그 세션
 *   내내 2D-MG 보정을 받지 못했다. "간헐적으로 적용이 안 된다"의 정체가 이것이다
 *   (브라우저 캐시에 있어 빨리 뜬 프레임일수록 더 잘 걸렸다).
 *   실패는 캐시하지 않는다 — URL 경로(mgProbeUrl)가 이미 같은 규칙을 쓴다. */
export function mgProbe(sop: string, img: HTMLImageElement, thr: number): MgProbe {
  if (!sop) return { kind: "blind" };
  const ck = _key(sop, thr);
  const hit = BOXES.get(ck);
  if (hit !== undefined) return hit;
  if (!mgReadable(img)) return { kind: "blind" };   // 다음 기회에 다시 — 기억하지 않는다
  return _remember(ck, analyze(img, thr));
}

// URL 경로의 동시 요청 합류 — 같은 프레임을 여러 페인이 동시에 물으면 한 번만 로드한다
const _urlInflight = new Map<string, Promise<MgProbe>>();

/** URL 로 조직 경계상자 산출(비동기). 화면 엘리먼트를 직접 못 잡는 통합 지점용.
 *  브라우저 캐시에 이미 있는 프레임이면 네트워크 왕복 없이 끝난다. */
export function mgProbeUrl(url: string, thr: number): Promise<MgProbe> {
  const ck = _key(url, thr);
  const hit = BOXES.get(ck);
  if (hit !== undefined) return Promise.resolve(hit);
  const cur = _urlInflight.get(ck);
  if (cur) return cur;
  const pr = new Promise<MgProbe>((resolve) => {
    const im = new Image();
    im.crossOrigin = "anonymous";        // 동일 출처 프록시 — 캔버스 오염 없음
    im.onload = () => resolve(_remember(ck, analyze(im, thr)));
    // 로드 실패는 **캐시하지 않는다** — 일시 오류가 영구 고착되지 않게
    im.onerror = () => resolve({ kind: "blind" });
    im.src = url;
  }).finally(() => { _urlInflight.delete(ck); });
  _urlInflight.set(ck, pr);
  return pr;
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

/** 이 칸의 조직을 어느 변에 붙일지 — 붙일 짝이 없으면 null(= 손대지 않는다).
 *
 *  맞붙임은 **마주 볼 상대가 있을 때만** 의미가 있다. 짝이 없는데 밀어붙이면
 *  영상을 화면 바깥쪽으로 밀어내는 꼴이 된다. 두 경우를 막는다:
 *   · 홀수 그리드의 정가운데 열(3열의 가운데 등) — 마주 볼 상대가 없다
 *   · 붙일 방향이 그리드의 바깥 변인 경우(맨 왼쪽 칸을 왼쪽으로) */
export function mgInnerSide(lat: "R" | "L" | "", ci: number, cols: number): "left" | "right" | null {
  if (cols < 2) return null;
  let side: "left" | "right" | null = null;
  if (lat === "R") side = "right";          // 우유방은 화면 왼쪽 열 → 오른쪽(가운데)으로
  else if (lat === "L") side = "left";
  else if (ci < (cols - 1) / 2) side = "right";
  else if (ci > (cols - 1) / 2) side = "left";
  if (!side) return null;                   // 홀수 그리드 정가운데 — 짝 없음
  if (side === "right" && ci === cols - 1) return null;
  if (side === "left" && ci === 0) return null;
  return side;
}

/** 이미 적용된 변환과 사실상 같은지 — 불필요한 setState(리렌더 루프) 방지 */
export const mgSameXf = (
  a: { zoom: number; tx: number; ty: number },
  b: { zoom: number; tx: number; ty: number },
) => Math.abs(a.zoom - b.zoom) < 1e-4 && Math.abs(a.tx - b.tx) < 0.5 && Math.abs(a.ty - b.ty) < 0.5;

// ── 변환 계산 ─────────────────────────────────────────────────────────────

export interface MgFit { mz: number; mtx: number; mty: number }

/** 배율 상한 — 탐지가 지나치게 작은 상자를 내놓아도 화면이 폭주하지 않게 */
export const MG_MAX_ZOOM = 4;

/** 탐지 오차 여유(headroom). 조직 상자를 타일에 **딱** 채우면 여유가 0 이라,
 *  경계 탐지가 조금이라도 덜 잡은 만큼 그대로 잘려 나간다.
 *  ⚠ 실제로 났다: MLO 는 겨드랑이·대흉근이 밝기 임계에 덜 걸려 상자가 유방 일부만 덮었고,
 *    그 상자를 타일에 꽉 맞추는 순간 유방 아래쪽이 화면 밖으로 밀려 **잘린 채로 그럴듯하게**
 *    보였다. MG 에서 조직이 잘려 보이는 것은 병변을 놓치는 것과 같다.
 *  판독에서는 '조금 작게 보이는 것' 이 '잘려 보이는 것' 보다 언제나 안전하다. */
export const MG_HEADROOM = 0.94;

/** 상자 기준 **세로** 확대 상한. 탐지가 세로로 덜 잡았을 때 피해를 가둔다.
 *  가로(공기 여백 제거)는 이 기능의 목적이라 상한을 따로 두지 않고 MG_MAX_ZOOM 만 쓴다. */
export const MG_MAX_V_ZOOM = 1.35;

/** 상자를 타일에 앉힐 때의 배율 — 헤드룸과 세로 상한을 **한 곳에서만** 계산한다.
 *  mgZoomOf(후보 산출)와 mgFit(실제 적용)이 서로 다른 값을 쓰면 칸마다 배율이 갈린다. */
function boxZoom(W: number, H: number, dw: number, dh: number, bw: number, bh: number): number {
  const zW = W / (bw * dw);
  const zH = Math.min(H / (bh * dh), MG_MAX_V_ZOOM);
  return Math.min(zW, zH, MG_MAX_ZOOM) * MG_HEADROOM;
}

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
  const z = boxZoom(W, H, iw * s0, ih * s0, bw, bh);
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
  /** 어느 변에 붙일지를 **레이아웃이 지정**한다(왼쪽 칸→right, 오른쪽 칸→left).
   *  주지 않으면 box.wall(픽셀에서 추측한 흉벽 방향)로 정한다 — 폴백일 뿐이다. */
  side?: "left" | "right",
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
    : boxZoom(W, H, dw, dh, bw, bh);
  if (!isFinite(mz) || mz <= 0) return null;

  const sx = flipH ? -1 : 1, sy = flipV ? -1 : 1;
  const ex0 = sx * mz * (x0 - 0.5) * dw, ex1 = sx * mz * (x1 - 0.5) * dw;
  const left = Math.min(ex0, ex1), right = Math.max(ex0, ex1);
  // ⚠ 붙일 변은 **레이아웃이 정한다**(왼쪽 칸의 안쪽=오른쪽, 오른쪽 칸의 안쪽=왼쪽).
  //   예전엔 픽셀에서 추측한 흉벽 방향(box.wall)으로 정했는데, 그 추측이 칸 위치와 어긋나면
  //   한쪽 열만 안쪽으로 붙고 다른 열은 엉뚱하게 놓인다(실제로 R열만 안 붙는 증상).
  //   조직 경계상자는 '조직이 어디까지인가'만 말해 주면 되고, 방향은 배치가 안다.
  const toRight = side
    ? side === "right"
    : (flipH ? (box.wall === "L" ? "R" : "L") : box.wall) === "R";
  const mtx = toRight ? (W / 2) - right : -(W / 2) - left;

  const ey0 = sy * mz * (y0 - 0.5) * dh, ey1 = sy * mz * (y1 - 0.5) * dh;
  const mty = -(Math.min(ey0, ey1) + Math.max(ey0, ey1)) / 2;
  return { mz, mtx, mty };
}

/** 조직의 안쪽 경계를 페인의 안쪽 변에 붙이는 tx (페인 상태에 직접 써 넣는 통합용).
 *  화면 x = paneW/2 + (px − cols/2)·s·dir + tx  — 뷰어의 translate→scale 합성과 동일. */
export function mgTxFor(g: {
  paneW: number; paneH: number; cols: number; rows: number;
  bbox: { x0: number; x1: number }; side: "left" | "right"; flipH: boolean; zoom: number;
}): number {
  const s0 = Math.min(g.paneW / g.cols, g.paneH / g.rows);
  const s = s0 * g.zoom;
  const wantRight = g.side === "right";
  // 좌우 반전 상태면 화면상 '안쪽'이 되는 bbox 모서리가 뒤집힌다
  const xIn = ((g.flipH ? !wantRight : wantRight) ? g.bbox.x1 : g.bbox.x0) * g.cols;
  const dir = g.flipH ? -1 : 1;
  return (wantRight ? g.paneW : 0) - g.paneW / 2 - (xIn - g.cols / 2) * s * dir;
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
