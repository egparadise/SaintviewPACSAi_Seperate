// 협진 차단 알림 — "서버가 막고 있다"를 사용자와 **관리자 둘 다** 쓸 수 있게 알린다.
//
// 왜 토스트가 아니라 창인가: 조치가 nginx 설정이라 몇 줄짜리 텍스트다. 토스트로는 담기지도
// 않고 사라져 버린다. 그리고 이 화면을 보는 사람(판독의)과 조치할 사람(서버 관리자)이
// 대개 다르므로 **그대로 복사해서 전달할 수 있어야** 한다.
//
// 서버 탓과 사용자 탓을 색과 라벨로 확실히 가른다 — 이걸 섞어 놓으면 판독의가 자기
// 사이트 설정만 계속 만지다 포기한다(실제로 겪은 일).
import { useState } from "react";
import type { BlockItem } from "../lib/collabPreflight";
import { t as tr } from "../lib/i18n";
import { showToast } from "../lib/toast";

export function CollabBlockDialog({ items, onClose }: {
  items: BlockItem[];
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (!items.length) return null;
  const server = items.filter((i) => i.serverSide);

  /** 관리자에게 통째로 넘길 텍스트 — 증상·원인·조치·설정이 한 덩어리여야 쓸모가 있다. */
  const asText = () => items.map((i) =>
    [`■ ${i.title}`, i.why, `→ ${i.action}`, i.snippet ?? ""].filter(Boolean).join("\n"),
  ).join("\n\n");

  const copy = () => {
    void navigator.clipboard?.writeText(asText())
      .then(() => { setCopied(true); showToast(tr("복사했습니다 — 서버 관리자에게 전달하세요")); })
      .catch(() => showToast(tr("복사할 수 없습니다 — 직접 선택해 복사하세요"), "error"));
  };

  return (
    <div onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
         style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 900,
                  display: "grid", placeItems: "center" }}>
      <div style={{ width: "min(680px, 92vw)", maxHeight: "86vh", overflow: "auto",
                    background: "var(--bg-panel)", border: "1px solid var(--border)",
                    borderRadius: 8, boxShadow: "0 10px 40px rgba(0,0,0,.5)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px",
                      borderBottom: "1px solid var(--border)" }}>
          <span style={{ fontSize: 14, fontWeight: 700 }}>
            {server.length ? tr("서버에서 막고 있습니다") : tr("시작할 수 없습니다")}
          </span>
          <div style={{ flex: 1 }} />
          {server.length > 0 && (
            <button onClick={copy} style={{ fontSize: 11, padding: "2px 10px" }}>
              {copied ? `✓ ${tr("복사됨")}` : tr("조치 내용 복사")}
            </button>
          )}
          <button onClick={onClose} style={{ fontSize: 11, padding: "2px 10px" }}>{tr("닫기")}</button>
        </div>

        {server.length > 0 && (
          <div style={{ margin: "10px 14px 0", padding: "6px 10px", fontSize: 11.5, lineHeight: 1.6,
                        background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.4)",
                        borderRadius: 6, color: "var(--text-primary)" }}>
            {tr("아래는 sv70 서버에서 조치해야 합니다 — 이 PC 의 브라우저 설정으로는 해결되지 않습니다.")}
          </div>
        )}

        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
          {items.map((it, i) => (
            <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 6,
                                  borderLeft: `4px solid ${it.serverSide
                                    ? "var(--stat-emergency, #f87171)" : "#eab308"}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px",
                            borderBottom: it.why || it.action ? "1px solid var(--border)" : "none" }}>
                <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 7px", borderRadius: 8,
                               background: it.serverSide ? "rgba(248,113,113,0.15)" : "rgba(234,179,8,0.15)",
                               color: it.serverSide ? "var(--stat-emergency, #f87171)" : "#eab308" }}>
                  {it.serverSide ? tr("서버 조치 필요") : tr("이 PC 에서 해결")}
                </span>
                {!it.blocking && (
                  <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>{tr("경고")}</span>
                )}
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{tr(it.title)}</span>
                {it.subject && (
                  <span style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>
                    · {tr(it.subject)}
                  </span>
                )}
              </div>
              {it.why && (
                <div style={{ padding: "7px 10px", fontSize: 11.5, lineHeight: 1.65,
                              color: "var(--text-secondary)" }}>{tr(it.why)}</div>
              )}
              {it.action && (
                <div style={{ padding: "0 10px 8px", fontSize: 11.5, lineHeight: 1.65,
                              color: "var(--text-primary)" }}>→ {tr(it.action)}</div>
              )}
              {/* 설정·명령은 **번역하지 않는다** — nginx 문법은 계약 값과 같은 성질이다 */}
              {it.snippet && (
                <pre style={{ margin: "0 10px 10px", padding: "8px 10px", fontSize: 11,
                              lineHeight: 1.55, overflowX: "auto", whiteSpace: "pre",
                              background: "var(--bg-elevated)", border: "1px solid var(--border)",
                              borderRadius: 4, color: "var(--text-primary)" }}>{it.snippet}</pre>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
