/* STT 언어 칩(2026-08-11 사용자 확정) — 모든 마이크 아이콘 **옆**에 "한"/"EN" 같은 현재
 * 인식 언어를 표시하고, 클릭(또는 Alt+L)하면 설정>판독>음성 판독에서 고른 언어들 사이에서
 * 순환한다. 표시는 이 컴포넌트 한 벌 — 상태·순환 규칙은 lib/sttLang 한 곳이다. */
import { useEffect, useState } from "react";
import { t as tr, useLang } from "../lib/i18n";
import { cycleSttLang, initSttHotkey, onSttLang, sttLabel, sttLang } from "../lib/sttLang";

export function SttLangChip({ compact }: { compact?: boolean }) {
  useLang();
  const [code, setCode] = useState(sttLang());
  useEffect(() => {
    initSttHotkey();                                   // 창당 1회 — Alt+L 순환
    return onSttLang(() => setCode(sttLang()));
  }, []);
  return (
    <button onClick={() => setCode(cycleSttLang())}
            title={tr("음성 인식 언어 — 클릭 또는 Alt+L 로 전환 (설정>판독>음성 판독에서 언어 선택)")}
            // IME 한/영 전환키 모양(정사각 글리프 버튼) — 누르면 다음 언어 글자로 바뀐다
            style={{ fontSize: compact ? 11 : 13, fontWeight: 800, lineHeight: 1,
                     width: compact ? 20 : 24, height: compact ? 20 : 24,
                     display: "inline-flex", alignItems: "center", justifyContent: "center",
                     borderRadius: 4, border: "1px solid var(--border)",
                     color: "var(--text-primary)", background: "var(--bg-elevated)",
                     cursor: "pointer", flexShrink: 0, padding: 0 }}>
      {sttLabel(code)}
    </button>
  );
}
