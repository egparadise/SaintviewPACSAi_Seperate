// 우측 상단 토스트 — 저장 등 액션 완료를 즉시 피드백(자동 소멸, 스택 지원). DOM 명령형(어디서든 호출).
let host: HTMLDivElement | null = null;

function ensureHost(): HTMLDivElement {
  if (host && document.body.contains(host)) return host;
  host = document.createElement("div");
  host.style.cssText =
    "position:fixed;top:16px;right:16px;z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none;";
  document.body.appendChild(host);
  return host;
}

export function showToast(msg: string, kind: "ok" | "error" = "ok"): void {
  const el = document.createElement("div");
  el.textContent = (kind === "ok" ? "✓ " : "⚠ ") + msg;
  el.style.cssText =
    "padding:10px 18px;border-radius:8px;font-size:13px;font-weight:600;color:#fff;" +
    "box-shadow:0 6px 20px rgba(0,0,0,0.45);pointer-events:none;opacity:0;transform:translateY(-6px);" +
    "transition:opacity .18s ease, transform .18s ease;" +
    (kind === "ok" ? "background:#16a34a;" : "background:#dc2626;");
  ensureHost().appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = "1"; el.style.transform = "translateY(0)"; });
  window.setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(-6px)";
    window.setTimeout(() => el.remove(), 220);
  }, 2500);
}
