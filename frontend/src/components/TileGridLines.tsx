// Image 분할(타일) 칸 경계선.
//
// 왜 별도 오버레이인가: 타일 격자는 뷰어의 pan/zoom **변환 안쪽**에 있다. 격자 자체에
// 배경색을 줘서 gap 을 선으로 쓰면 확대·이동할 때 선이 같이 밀려 나가 구획선 구실을 못한다.
// 선은 페인에 **고정된 구조물**이어야 하므로 변환 밖에 절대배치로 따로 그린다.
//
// 페인 외곽선은 이미 있으므로 안쪽 경계만 그린다(세로 c-1개 · 가로 r-1개).
import type { CSSProperties } from "react";

export function TileGridLines({ r, c, color = "rgba(255,255,255,0.30)", z = 2 }: {
  r: number; c: number; color?: string; z?: number;
}) {
  const rows = Math.max(1, Math.floor(r));
  const cols = Math.max(1, Math.floor(c));
  if (rows * cols <= 1) return null;   // 1×1 은 나눌 칸이 없다
  // ⚠ 단색 한 겹으로는 안 된다 — 어두운 배경에 맞춘 색은 밝은 조직 위에서 사라지고,
  //   밝은 색은 검은 배경에서 과하게 튄다. 옅은 흰 선 + 어두운 헤일로로 **양쪽에서** 보이게 한다.
  const base: CSSProperties = {
    position: "absolute", background: color, boxShadow: "0 0 0 0.5px rgba(0,0,0,0.75)",
  };
  return (
    <div aria-hidden style={{ position: "absolute", inset: 0, zIndex: z, pointerEvents: "none" }}>
      {Array.from({ length: cols - 1 }, (_, i) => (
        <div key={`v${i}`} style={{ ...base, top: 0, bottom: 0,
                                    left: `${((i + 1) * 100) / cols}%`, width: 1 }} />
      ))}
      {Array.from({ length: rows - 1 }, (_, i) => (
        <div key={`h${i}`} style={{ ...base, left: 0, right: 0,
                                    top: `${((i + 1) * 100) / rows}%`, height: 1 }} />
      ))}
    </div>
  );
}
