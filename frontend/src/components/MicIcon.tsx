// 마이크 아이콘 — 음성 판독(STT) 버튼용. 녹음 중이면 붉은 펄스.
const STYLE_ID = "sv-mic-style";
if (typeof document !== "undefined" && !document.getElementById(STYLE_ID)) {
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = "@keyframes svMicPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }";
  document.head.appendChild(st);
}

export function MicIcon({ on = false, size = 15 }: { on?: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         style={{ flex: "none", animation: on ? "svMicPulse 1s ease-in-out infinite" : undefined }}
         stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="12" rx="3" fill={on ? "currentColor" : "none"} />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="8" y1="22" x2="16" y2="22" />
    </svg>
  );
}
