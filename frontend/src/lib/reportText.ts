/* 판독문을 Reading·Conclusion 두 칸으로 가르는 규칙 — 한 곳에서(2026-08-22 사용자 확정).
 *
 * 사용자 요구:
 *   "판독창 History 의 ⇆ 버튼을 누르면 과거 검사의 **Reading 과 Conclusion 모두**가
 *    우측 Reading·Conclusion 항목에 복사되어 입력되게."
 *
 * ── 점검 결과(그전 상태) ────────────────────────────────────────────────
 * · `⇆` 는 **클릭 핸들러가 없는 장식**이었다 — 눌러도 아무 일도 일어나지 않았다.
 * · 옆의 '복사' 버튼은 `narrative_text`(합쳐진 한 덩어리)를 **마지막으로 포커스했던 칸 하나**에만
 *   붙였다. 그래서 판독 소견이 결론 칸에 들어가기도 했다(어디에 들어갈지 예측할 수 없었다).
 *
 * ── 규칙 ────────────────────────────────────────────────────────────────
 * 판독문의 구조는 SR JSON 이다: `findings`(소견) → **Reading**, `impression`(인상) → **Conclusion**.
 * 화면이 처음 판독문을 펼칠 때(initText)와 **같은 규칙**을 쓴다 — 두 벌이면 '복사한 것'과
 * '열어 본 것'이 달라 보인다.
 *
 * SR 이 비어 있고 narrative_text 만 있는 옛 판독문은 **결론 칸으로** 보낸다. 그 텍스트가 소견인지
 * 결론인지 알 수 없는데, 소견 칸에 넣으면 '내가 쓴 소견'처럼 보여 더 위험하다.
 *
 * react·api 무의존 — node 테스트가 직접 부른다.
 */

export interface SrLike {
  comparison?: { summary?: string } | null;
  findings?: { organ?: string; observation?: string; severity?: string }[] | null;
  impression?: { statement?: string }[] | null;
}

export interface ReportLike {
  sr_json?: SrLike | null;
  narrative_text?: string | null;
}

export interface ReportParts { reading: string; conclusion: string }

/** 판독문 → 두 칸. 값이 없으면 빈 문자열(호출부가 '넣을 것이 없다'를 판단한다). */
export function splitReport(r: ReportLike | null | undefined): ReportParts {
  const sr = r?.sr_json ?? null;
  const lines: string[] = [];
  if (sr?.comparison?.summary) lines.push(`[비교] ${sr.comparison.summary}`);
  for (const f of sr?.findings ?? []) {
    const organ = f?.organ ? `${f.organ}: ` : "";
    const obs = String(f?.observation ?? "");
    if (!obs) continue;
    lines.push(`${organ}${obs}${f?.severity === "critical" ? " [CRITICAL]" : ""}`);
  }
  const conclusion = (sr?.impression ?? [])
    .map((i) => String(i?.statement ?? "").trim()).filter(Boolean).join("\n");
  const reading = lines.join("\n");

  // SR 이 비어 있는 옛 판독문 — 통째로 결론 칸에 둔다(소견인지 결론인지 알 수 없다).
  if (!reading && !conclusion) {
    const raw = String(r?.narrative_text ?? "").trim();
    return { reading: "", conclusion: raw };
  }
  return { reading, conclusion };
}

/** 붙이기 — 기존 내용이 있으면 줄을 바꿔 잇는다(덮어쓰지 않는다). */
export function appendLine(prev: string, add: string): string {
  const a = String(add ?? "").trim();
  if (!a) return prev;
  const p = String(prev ?? "");
  return p ? `${p}\n${a}` : a;
}

/** 넣을 것이 하나라도 있는가 — 없으면 버튼을 비활성으로 두고 헛클릭을 막는다. */
export function hasAnyText(p: ReportParts | null | undefined): boolean {
  return !!(p && (p.reading.trim() || p.conclusion.trim()));
}
