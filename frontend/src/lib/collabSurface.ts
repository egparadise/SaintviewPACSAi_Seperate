// 협진 공유 표면(surface) 규칙 — 좌표 변환 · 화면 전환 판정 · 레이저 수명
//
// 왜 별도 모듈인가: 여기 있는 것은 전부 **눈으로 확인할 수 없는 규칙**이다.
// "마크가 대충 그 근처에 찍힌다"와 "모두에게 정확히 같은 자리에 찍힌다"는 화면만 봐서는
// 구별되지 않는다(자기 창에서는 항상 맞아 보인다). 그래서 순수 함수로 떼어 내 node 테스트로
// 고정한다 — lib/scoutLines·hangingProtocol·collabState 와 같은 계열이다.
//
// ⚠ window·document 를 쓰지 않는다. 쓰는 순간 node 테스트가 죽고, 그 규칙은
//   "브라우저에서만 확인 가능" = 실질적으로 검증 없이 흘러가는 것이 된다.

import type { CollabSnapshot, SessionAnno } from "./collabState";

/** 마크를 얹을 수 있는 표면 3종.
 *
 *  좌표계가 서로 **완전히 다르다** — 섞이면 엉뚱한 곳에 그려지므로 반드시 분리해서 다룬다:
 *   · pane   이미지 정규화(0~1). 각자 줌·팬이 달라도 같은 해부학적 위치. 마크가 안정적이다.
 *   · screen 공유 화면의 **비디오 프레임** 정규화(0~1). 발표자가 스크롤하면 픽셀이 바뀌므로
 *            마크가 어긋날 수 있다 — 그래서 이 표면은 레이저(자동 소멸)가 기본이다.
 *   · wb     화이트보드 자체 정규화(0~1). 좌표가 우리 것이라 절대 어긋나지 않는다. */
export type Surface = "pane" | "screen" | "wb";

/** 마크 수명. 서버로도 나가는 값이라 **문자열**이다(백엔드 _ANNO_FIELDS 의 문자열 분기 재사용).
 *  laser = 잠깐 가리키는 것, pin = 남겨 두는 것. */
export type MarkLife = "laser" | "pin";

/** 레이저가 사라지기까지. 3초 — "여기 보세요"를 말로 이어받기에 충분하고,
 *  발표자가 화면을 스크롤해 어긋나기에는 짧은 시간. */
export const LASER_TTL = 3000;

/** surface 가 없는 주석은 **pane** 으로 본다.
 *  구버전 클라이언트가 붙어 있어도 기존 동작(뷰포트 주석)이 그대로 유지되어야 한다. */
export function surfaceOf(a: { surface?: string } | null | undefined): Surface {
  const s = a?.surface;
  return s === "screen" || s === "wb" ? s : "pane";
}

/** 표면별로 갈라내기 — Viewer2D 의 뷰포트 필터가 **가장 먼저** 이걸 통과시켜야 한다.
 *  화이트보드·화면 마크는 sop_uid 가 없어서, 이 분리가 없으면 DICOM 영상 위로 쏟아진다. */
export function onSurface<T extends { surface?: string }>(list: T[], s: Surface): T[] {
  return list.filter((a) => surfaceOf(a) === s);
}

// ── 비디오 프레임 좌표 ────────────────────────────────────────────────────────

/** element 안에서 **실제 영상이 차지하는** 사각형(px). */
export interface FrameBox { x: number; y: number; w: number; h: number }

/** object-fit:contain 레터박스 계산.
 *
 *  🔴 이 함수가 이 기능의 급소다. `<video>` 의 element 크기와 프레임 크기는 다르고,
 *  contain 은 남는 쪽에 검은 여백을 만든다. `e.clientX / rect.width` 로 계산하면
 *  창 크기가 다른 사람끼리 **다른 지점을 가리킨다** — 인수 패키지(SaintViewPACS 3.3.7)가
 *  `clientX / window.innerWidth` 로 계산해 실제로 틀렸던 바로 그 지점이다.
 *
 *  영상 크기를 아직 모르면(메타데이터 로드 전 videoWidth=0) element 전체를 돌려준다 —
 *  호출부는 그동안 그리기를 막는다(대충 찍힌 마크가 남는 것보다 못 그리는 편이 낫다). */
export function frameBox(elW: number, elH: number, vidW: number, vidH: number): FrameBox {
  if (!(elW > 0) || !(elH > 0)) return { x: 0, y: 0, w: 0, h: 0 };
  if (!(vidW > 0) || !(vidH > 0)) return { x: 0, y: 0, w: elW, h: elH };
  const scale = Math.min(elW / vidW, elH / vidH);
  const w = vidW * scale;
  const h = vidH * scale;
  return { x: (elW - w) / 2, y: (elH - h) / 2, w, h };
}

/** element 좌표(px) → 프레임 정규화(0~1).
 *
 *  @param clamp 드래그 **중**에는 true. 손이 잠깐 여백으로 나갔다고 획이 끊기면 안 된다.
 *               획을 **시작**할 때는 false — 검은 여백에서 시작한 마크는 아무 데도 안 가리킨다.
 *  @returns 범위 밖이고 clamp 가 아니면 null */
export function toFrame(elX: number, elY: number, box: FrameBox,
                        clamp = false): [number, number] | null {
  if (!(box.w > 0) || !(box.h > 0)) return null;
  const fx = (elX - box.x) / box.w;
  const fy = (elY - box.y) / box.h;
  if (clamp) return [c01(fx), c01(fy)];
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  return [fx, fy];
}

/** 프레임 정규화(0~1) → element 좌표(px). toFrame 의 역함수. */
export function fromFrame(fx: number, fy: number, box: FrameBox): [number, number] {
  return [box.x + fx * box.w, box.y + fy * box.h];
}

const c01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ── 화면 '전환' 판정 ─────────────────────────────────────────────────────────

/** 지금 무엇을 보고 있는가 — **전환**을 식별하는 키.
 *
 *  팬·줌·W-L·슬라이스 스크롤은 '움직임'이고, 검사·시리즈·레이아웃·최대화 변경은 '전환'이다.
 *  둘을 구분해야 하는 이유: 전환이 일어나면 자유 보기로 빠진 사람까지 **끌어와야** 한다.
 *  안 그러면 "다 같이 보고 있다"고 믿으면서 서로 다른 검사를 논의하게 된다 — 오진 경로다.
 *  반대로 움직임까지 끌어오면 남의 화면을 강제로 뺏는 것이라 아무도 작업을 못 한다.
 *
 *  ⚠ 여기에 z·x·y·r·wl·i(슬라이스) 를 넣으면 안 된다 — 넣는 순간 팬 한 번에 전원이 끌려온다. */
export function navKey(snap: CollabSnapshot | null | undefined): string {
  if (!snap) return "";
  const panes = Object.keys(snap.panes ?? {}).sort()
    .map((pid) => `${pid}=${snap.panes[pid]?.u ?? ""}/${snap.panes[pid]?.s ?? ""}`)
    .join(",");
  return [snap.study, snap.layout, snap.max ?? "", panes].join("|");
}

// ── 레이저 수명 ──────────────────────────────────────────────────────────────

/** 만료된 레이저만 걷어낸다. pin·일반 마크는 건드리지 않는다.
 *
 *  ⚠ `at` 은 **받는 쪽이** 도착 시각으로 찍는다(보내는 쪽 시계가 아니다).
 *  좌석마다 시계가 몇 분씩 어긋나는 것은 흔한 일이고, 보낸 시각을 그대로 믿으면
 *  레이저가 즉시 사라지거나 영원히 안 사라진다. 그래서 at 은 전송하지 않는다. */
export function pruneLaser<T extends { life?: string; at?: number }>(
  list: T[], now: number, ttl = LASER_TTL,
): T[] {
  return list.filter((a) => !(a.life === "laser" && a.at != null && now - a.at >= ttl));
}

/** 레이저의 남은 수명 0~1 (1=방금, 0=소멸). 페이드 아웃 알파로 쓴다. */
export function laserAlpha(a: { life?: string; at?: number }, now: number,
                           ttl = LASER_TTL): number {
  if (a.life !== "laser" || a.at == null) return 1;
  return c01(1 - (now - a.at) / ttl);
}

/** 그 표면의 마크 전체 제거 — 발표자가 화면 공유를 껐다 켜면 이전 마크는 무의미하다
 *  (다른 화면을 가리키게 된다). 남겨 두는 쪽이 위험하므로 자동으로 지운다. */
export function clearSurface(list: SessionAnno[], s: Surface): SessionAnno[] {
  return list.filter((a) => surfaceOf(a) !== s);
}
