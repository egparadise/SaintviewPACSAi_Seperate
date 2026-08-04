// 협진 화면 미러링 코덱 — 뷰어 상태 ↔ 스냅샷(JSON)
//
// 왜 픽셀이 아니라 상태를 보내는가:
//   · 진단 화질이 보존된다. 받는 쪽 브라우저가 PACS 에서 **원본**을 받아 자기 모니터 해상도로
//     그리므로, 비디오 코덱을 한 번 통과한 그림을 보고 판독하는 일이 없다.
//   · 대역폭이 초당 수 KB 다(아래 스냅샷은 보통 1~4KB). 화면 스트리밍은 Mbps 단위다.
//   · 받는 쪽이 자기 창 크기·모니터 배치에 맞춰 그린다 — 해상도가 다른 좌석끼리도 자연스럽다.
//
// 대신 두 가지를 지켜야 한다:
//   ① 받는 쪽이 그 검사의 영상을 **볼 수 있어야** 한다 → 임시 열람권(CollabGrant).
//   ② 시리즈는 uid 로만 보낸다. SeriesNode 를 통째로 실으면 인스턴스 수백 개가 매 프레임 나간다.
//      받는 쪽이 자기 트리에서 uid 로 찾아 붙인다(resolveSeries).

/** 페인 1개의 미러 대상 — Viewer2D 의 PaneState 중 **화면에 보이는 것**만 추린 것.
 *  키를 1~3자로 줄인 이유는 초당 10회 보내기 때문이다(JSON 키가 페이로드의 절반을 차지한다). */
export interface CollabPane {
  u: string;            // studyUid — 페인마다 다른 검사(비교) 가능
  s: string;            // series_uid ("" = 빈 페인)
  i: number;            // 슬라이스 index
  z: number;            // zoom
  x: number; y: number; // tx, ty
  r: number;            // rot
  fh: boolean; fv: boolean; iv: boolean;   // flipH, flipV, invert
  wl: string;           // "c,w"
  fx: string;           // 필터
  sh: { kind: "rect" | "ellipse" | "poly"; pts: number[][] } | null;   // 셔터
  il?: { r: number; c: number };                                       // 타일 분할
}

export interface CollabSnapshot {
  v: 1;
  study: number;                        // 지금 보고 있는 검사 id (Master 기준)
  layout: string;                       // "2x2" 등
  panes: Record<string, CollabPane>;
  active: string;                       // 활성 페인 id
  sel: string | null;                   // 선택 시리즈 uid
  max: string | null;                   // 최대화된 페인
  col?: number[]; row?: number[];       // 분할 비율
}

/** 원격 커서 — 상태와 분리한다(빈도가 3~5배 높고, 관전자도 보낼 수 있다) */
export interface CollabCursor {
  pid: string;          // 페인 id
  x: number; y: number; // 페인 내 정규화 좌표(0~1) — 창 크기가 달라도 같은 지점을 가리킨다
}

/** 세션 주석 — 다학제에서 **여러 명이 동시에** 그리는 것.
 *
 *  DB 주석(Anno)과 다른 타입인 이유:
 *   · id 가 문자열("s3")이다 — 서버 메모리 시퀀스라 DB 정수 id 와 섞이면 안 된다
 *   · by(작성자 account id)가 필수다 — 색이 여기서 나온다
 *   · 세션이 닫히면 사라진다. Master 가 [채택] 한 것만 정식 Anno 가 된다
 *  좌표는 DB 주석과 같은 **이미지 정규화(0~1)** 라, 각자 줌·팬이 달라도 같은 해부학적
 *  위치에 찍힌다(그래서 '자유 보기' 중에도 남의 주석이 제자리에 보인다). */
export interface SessionAnno {
  id: string;
  by: number;
  kind: string;
  points: number[][];
  series_uid?: string;
  sop_uid?: string;
  text?: string;
  value?: number | null;
  unit?: string;
}

/** 수신 이벤트를 목록에 반영하는 **순수 함수** — 서버가 진실이고 여기는 그대로 따른다.
 *  같은 id 가 다시 오면 교체한다(add 가 재전송돼도 중복되지 않는다). */
export function mergeAnno(list: SessionAnno[], row: SessionAnno): SessionAnno[] {
  const i = list.findIndex((a) => a.id === row.id);
  if (i < 0) return [...list, row];
  const next = list.slice();
  next[i] = row;
  return next;
}

export function removeAnno(list: SessionAnno[], id: string): SessionAnno[] {
  return list.filter((a) => a.id !== id);
}

/** 뷰어에서 이 인터페이스만 만족시키면 미러링이 된다(Viewer2D 내부 타입에 의존하지 않는다) */
export interface MirrorSource {
  studyId: number;
  layout: string;
  panes: Record<string, {
    studyUid: string;
    series: { series_uid: string } | null;
    index: number; zoom: number; tx: number; ty: number; rot: number;
    flipH: boolean; flipV: boolean; invert: boolean;
    wl: string; fx: string;
    shutter: { kind: "rect" | "ellipse" | "poly"; pts: number[][] } | null;
    il?: { r: number; c: number };
  }>;
  activePane: string;
  selSeries: string | null;
  maximized: string | null;
  colFr: number[];
  rowFr: number[];
}

const r3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;

export function encodeSnapshot(src: MirrorSource): CollabSnapshot {
  const panes: Record<string, CollabPane> = {};
  for (const [pid, p] of Object.entries(src.panes)) {
    panes[pid] = {
      u: p.studyUid || "", s: p.series?.series_uid ?? "", i: p.index | 0,
      // 소수 3자리로 자른다 — 줌·팬은 픽셀보다 훨씬 곱게 들어와서 그대로 보내면
      // 아무도 못 알아보는 차이 때문에 매 프레임 '변경됨' 판정이 난다(아래 sameSnapshot).
      z: r3(p.zoom), x: r3(p.tx), y: r3(p.ty), r: p.rot | 0,
      fh: !!p.flipH, fv: !!p.flipV, iv: !!p.invert,
      wl: p.wl || "", fx: p.fx || "", sh: p.shutter ?? null,
      ...(p.il && (p.il.r > 1 || p.il.c > 1) ? { il: p.il } : {}),
    };
  }
  return {
    v: 1, study: src.studyId, layout: src.layout, panes,
    active: src.activePane, sel: src.selSeries, max: src.maximized,
    col: src.colFr?.map(r3), row: src.rowFr?.map(r3),
  };
}

/** 두 스냅샷이 사실상 같은가 — 같으면 보내지 않는다(정지 화면에서 트래픽 0). */
export function sameSnapshot(a: CollabSnapshot | null, b: CollabSnapshot | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 수신 스냅샷을 뷰어 상태로 — 시리즈는 호출부가 준 resolver 로 자기 트리에서 찾는다.
 *  못 찾은 시리즈는 **기존 값을 유지**한다(빈 화면으로 깜빡이는 것보다 낫다 — 트리가
 *  아직 로드 중일 수 있고, 다음 스냅샷에서 자연히 맞춰진다). */
export function applyPane<T extends {
  studyUid: string; series: unknown; index: number; zoom: number; tx: number; ty: number;
  rot: number; flipH: boolean; flipV: boolean; invert: boolean; wl: string; fx: string;
  shutter: unknown; il?: { r: number; c: number };
}>(prev: T, snap: CollabPane, resolveSeries: (uid: string) => unknown): T {
  const resolved = snap.s ? resolveSeries(snap.s) : null;
  return {
    ...prev,
    studyUid: snap.u || prev.studyUid,
    series: snap.s ? (resolved ?? prev.series) : null,
    index: snap.i, zoom: snap.z, tx: snap.x, ty: snap.y, rot: snap.r,
    flipH: snap.fh, flipV: snap.fv, invert: snap.iv,
    wl: snap.wl, fx: snap.fx, shutter: snap.sh,
    ...(snap.il ? { il: snap.il } : {}),
  };
}

/** 송출 스로틀 — 초당 최대 N회. 드래그 중에도 마지막 상태가 반드시 나가도록 tail 을 보장한다.
 *  (leading + trailing: 첫 움직임은 즉시 보이고, 손을 뗀 최종 위치도 반드시 도착한다) */
// ⚠ window.setTimeout 이 아니라 **전역 setTimeout** 을 쓴다.
//   이 파일은 tests/collab_mirror_rule.test.mjs 가 node 에서 직접 부르는 순수 규칙 모듈이다
//   (lib/scoutLines·hangingProtocol 과 같은 계열). window 에 묶으면 그 테스트가 통째로 죽고,
//   "브라우저에서만 확인 가능" 이 되어 규칙이 검증 없이 흘러간다.
export function makeThrottle<T>(fn: (v: T) => void, ms = 100): {
  push: (v: T) => void; flush: () => void; cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { v: T } | null = null;
  let lastAt = 0;
  const run = (v: T) => { lastAt = Date.now(); fn(v); };
  return {
    push(v: T) {
      const now = Date.now();
      if (now - lastAt >= ms && timer === null) { run(v); return; }
      pending = { v };
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        if (pending) { const p = pending; pending = null; run(p.v); }
      }, Math.max(0, ms - (now - lastAt)));
    },
    flush() {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (pending) { const p = pending; pending = null; run(p.v); }
    },
    cancel() {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      pending = null;
    },
  };
}

/** 메신저 룸 키 — 백엔드 collab_service.dm_room / session_room 과 **같은 규칙**이어야 한다.
 *  (dm 은 항상 작은 id 가 앞. 그래야 A→B 와 B→A 가 같은 방이 된다)
 *
 *  ⚠ 이 두 함수 밖에서 `dm:${a}:${b}` 같은 문자열을 직접 만들지 말 것.
 *    예전에 CollabDock 과 CollabSessionPanel 이 각자 만들고 있었는데, 그러면 한쪽 규칙만
 *    바뀌었을 때 "보낸 사람에게만 보이는 대화방" 이 조용히 생긴다. 형식은 한 곳에만 둔다. */
export function dmRoom(a: number, b: number): string {
  return `dm:${Math.min(a, b)}:${Math.max(a, b)}`;
}
export function sessionRoom(code: string): string {
  return `sess:${code}`;
}

/** 참가자 색 — 원격 커서·비디오 테두리에 같은 색을 쓴다(누가 누구인지 한눈에).
 *  스크린샷의 참가자 타일 테두리 색과 같은 역할. */
const CURSOR_COLORS = ["#38bdf8", "#22c55e", "#fbbf24", "#f472b6", "#a78bfa", "#fb923c"];
export function colorOf(accountId: number): string {
  return CURSOR_COLORS[Math.abs(accountId) % CURSOR_COLORS.length];
}
