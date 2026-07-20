// 판독 상태(read_state)·환자 병합(Merge) 아이콘 — 워크리스트/Exam Control 공용.
// read_state 는 서버가 계산해 StudyRow 에 내려준다(우선순위 fixed>read>reading>open>unread).
import type { StudyRow } from "../api";

// typing 펄스 애니메이션 — 모듈 로드 시 1회 주입
const STYLE_ID = "sv-readstate-style";
if (typeof document !== "undefined" && !document.getElementById(STYLE_ID)) {
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = `@keyframes svReadPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }`;
  document.head.appendChild(st);
}

/** 병합된 환자 표시 아이콘 (git-merge 형태: 두 갈래가 하나로 합류) */
export function MergeIcon({ size = 13, title = "병합(Merge)된 환자 — Exam Control에서 Unmerge 가능" }:
  { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16"
         style={{ verticalAlign: "-2px", marginRight: 3, flex: "none" }} aria-label={title}>
      <title>{title}</title>
      <circle cx="3.5" cy="3.5" r="2" fill="none" stroke="var(--accent, #7dd3fc)" strokeWidth="1.5" />
      <circle cx="3.5" cy="12.5" r="2" fill="none" stroke="var(--accent, #7dd3fc)" strokeWidth="1.5" />
      <circle cx="12.5" cy="8" r="2.1" fill="var(--accent, #7dd3fc)" />
      <path d="M3.5 5.5 L3.5 10.5 M5.5 3.7 C9 4.5 9.5 7 10.5 7.7 M5.5 12.3 C9 11.5 9.5 9 10.5 8.3"
            fill="none" stroke="var(--accent, #7dd3fc)" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// 주 상태 정의 — glyph/색/설명
const MAIN: Record<string, { glyph: string; color: string; label: string }> = {
  fixed:   { glyph: "🔒", color: "#e879f9", label: "확정(Fixed) — 판독 변경 금지(잠금)" },
  read:    { glyph: "✔",  color: "#4ade80", label: "판독 완료 (Read)" },
  reading: { glyph: "✍",  color: "#fbbf24", label: "판독 중 (Reading)" },
  open:    { glyph: "👁", color: "#60a5fa", label: "뷰어에 열림 (Open)" },
  unread:  { glyph: "○",  color: "#6b7280", label: "판독 대기 (Unread)" },
};

/** 워크리스트 '판독' 컬럼 아이콘 — 주 상태 1개 + 보조 인디케이터(판독문DB·입력중·영상변경·열림) */
export function ReadStateIcon({ row }: { row: StudyRow }) {
  const state = row.read_state ?? "unread";
  const m = MAIN[state] ?? MAIN.unread;
  const subs: { glyph: string; color: string; label: string; pulse?: boolean }[] = [];
  if (row.report_typing) subs.push({ glyph: "…", color: "#fbbf24", label: "판독문 입력 중 (DB에 저장되는 중)", pulse: true });
  if (row.has_report_text) subs.push({ glyph: "▤", color: "#94a3b8", label: "판독문이 DB에 저장되어 있음" });
  if (row.image_changed) subs.push({ glyph: "Δ", color: "#fb923c", label: "영상 변경됨 — 주석/키이미지/표시상태(W·L·방향·필터·셔터)/QC로 최초 상태와 다름" });
  if (row.viewer_open && state !== "open") subs.push({ glyph: "👁", color: "#60a5fa", label: "뷰어에 열려 있음" });
  const tip = [m.label, ...subs.map((s) => s.label)].join(" · ");
  return (
    <span title={tip} style={{ display: "inline-flex", alignItems: "center", gap: 2, whiteSpace: "nowrap", cursor: "default" }}>
      <span style={{
        color: m.color, fontSize: state === "fixed" || state === "open" ? 11 : 12, fontWeight: 700, lineHeight: 1,
        animation: row.report_typing && state === "reading" ? "svReadPulse 1.2s ease-in-out infinite" : undefined,
      }}>{m.glyph}</span>
      {subs.map((s, i) => (
        <span key={i} style={{
          color: s.color, fontSize: 9, fontWeight: 700, lineHeight: 1,
          animation: s.pulse ? "svReadPulse 1.2s ease-in-out infinite" : undefined,
        }}>{s.glyph}</span>
      ))}
    </span>
  );
}
