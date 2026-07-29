// Tools 패널 접기/펴기 — **3뷰어(I-View·T-View·SaintView) 공용**.
//
// 요구: "모든 뷰어에서 Tools 기능을 왼쪽으로 감추거나 나타낼 수 있게."
// 판독 중에는 화면이 넓을수록 좋다. 툴이 늘 필요한 것은 아니라서 접어 두었다가 필요할 때만 편다.
//
// ■ 두 가지를 여기서 정한다
//   ① 접힘 상태의 **보존** — 창을 닫았다 열거나 다른 모니터의 뷰어를 새로 띄워도 그대로다.
//      (매번 다시 접게 만들면 기능이 없느니만 못하다.)
//   ② 접었을 때 남기는 **가는 띠(rail)** 의 방향 — 어느 쪽에 도킹돼 있느냐에 따라 화살표가 다르다.
//      띠를 아예 없애면 다시 펼 방법이 사라진다. 그래서 폭 RAIL_PX 만큼은 반드시 남긴다.
//
// 뷰어별로 따로 기억한다(I-View 를 접었다고 T-View 까지 접히면 안 된다).

export type ToolPanelViewer = "infi" | "ty" | "saint";
export type DockSide = "left" | "right" | "top" | "bottom";

/** 접혔을 때 남는 띠의 두께(px). 0 이면 다시 펼 수가 없다 — 반드시 양수. */
export const RAIL_PX = 18;

const KEY_PREFIX = "sv.toolpanel.";

export function toolPanelKey(viewer: ToolPanelViewer): string {
  return `${KEY_PREFIX}${viewer}`;
}

/** 저장된 접힘 상태. 저장된 적이 없으면 **펼침**(기본은 지금까지의 동작 그대로). */
export function readToolPanelOpen(viewer: ToolPanelViewer, fallback = true): boolean {
  try {
    const v = localStorage.getItem(toolPanelKey(viewer));
    if (v === "0") return false;
    if (v === "1") return true;
  } catch {
    /* 시크릿 모드 등 localStorage 차단 — 저장 못 해도 화면은 떠야 한다 */
  }
  return fallback;
}

export function writeToolPanelOpen(viewer: ToolPanelViewer, open: boolean): void {
  try {
    localStorage.setItem(toolPanelKey(viewer), open ? "1" : "0");
  } catch {
    /* 저장 실패는 무시 — 이번 세션에서만 유지된다 */
  }
}

export interface RailSpec {
  /** 접기 버튼에 쓸 화살표(패널이 사라지는 방향). */
  hideArrow: string;
  /** 펴기 띠에 쓸 화살표(패널이 나올 방향). */
  showArrow: string;
  /** 띠가 가로로 눕는가(위/아래 도킹). 폭·높이 중 무엇을 RAIL_PX 로 줄지 결정한다. */
  horizontal: boolean;
  /** 접기 툴팁 */
  hideTitle: string;
  /** 펴기 툴팁 */
  showTitle: string;
}

/** 도킹 위치별 접기/펴기 방향. 왼쪽 도킹이면 왼쪽으로 감춘다(요구 그대로). */
export function railSpec(side: DockSide): RailSpec {
  switch (side) {
    case "right":
      return { hideArrow: "▸", showArrow: "◂", horizontal: false,
               hideTitle: "Tools 감추기 — 오른쪽으로", showTitle: "Tools 보이기" };
    case "top":
      return { hideArrow: "▴", showArrow: "▾", horizontal: true,
               hideTitle: "Tools 감추기 — 위로", showTitle: "Tools 보이기" };
    case "bottom":
      return { hideArrow: "▾", showArrow: "▴", horizontal: true,
               hideTitle: "Tools 감추기 — 아래로", showTitle: "Tools 보이기" };
    default:
      return { hideArrow: "◂", showArrow: "▸", horizontal: false,
               hideTitle: "Tools 감추기 — 왼쪽으로", showTitle: "Tools 보이기" };
  }
}

/** 펴기 띠의 인라인 스타일. 세로 띠는 폭만, 가로 띠는 높이만 RAIL_PX 로 고정한다. */
export function railStyle(side: DockSide): Record<string, string | number> {
  const { horizontal } = railSpec(side);
  return horizontal
    ? { height: RAIL_PX, width: "100%", borderRadius: 0, padding: 0, flexShrink: 0 }
    : { width: RAIL_PX, height: "100%", borderRadius: 0, padding: 0, flexShrink: 0 };
}
