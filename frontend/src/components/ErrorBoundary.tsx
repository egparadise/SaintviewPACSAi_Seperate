// 화면 백지화 방지 + 원인 보존.
//
// 왜 필요한가: React 는 렌더/이펙트에서 예외가 나가면 **트리 전체를 언마운트**한다.
// ErrorBoundary 가 없으면 root 가 비워져 화면이 통째로 검게 되고, 사용자는 새로고침으로
// 넘어간다 — 그 순간 콘솔도 함께 날아가 원인이 영영 안 남는다.
// (실제 신고: "T-View 워크리스트가 자꾸 죽는데 새로고침하면 된다")
//
// 그래서 이 컴포넌트는 두 가지를 한다:
//  ① 터진 자리만 격리해 나머지 화면을 살린다(워크리스트가 죽어도 앱은 남는다)
//  ② 무엇이 왜 터졌는지 **localStorage 에 남긴다** — 새로고침해도 증거가 살아남는다.
//     설정 > 정보 에서 확인·복사할 수 있다.
import { Component, type ErrorInfo, type ReactNode } from "react";

const LOG_KEY = "sv_crash_log";
const LOG_MAX = 20;

export interface CrashEntry {
  at: string;          // ISO 시각
  where: string;       // 경계 이름(어느 화면인지)
  message: string;
  stack: string;
  componentStack: string;
  url: string;
  build: string;
}

export function readCrashLog(): CrashEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(LOG_KEY) || "[]");
    return Array.isArray(v) ? (v as CrashEntry[]) : [];
  } catch {
    return [];
  }
}

export function clearCrashLog(): void {
  try { localStorage.removeItem(LOG_KEY); } catch { /* 저장소 접근 불가 — 무시 */ }
}

export function recordCrash(e: Partial<CrashEntry> & { message: string }): void {
  try {
    const list = readCrashLog();
    list.unshift({
      at: new Date().toISOString(),
      where: e.where || "unknown",
      message: String(e.message).slice(0, 500),
      stack: String(e.stack || "").slice(0, 2000),
      componentStack: String(e.componentStack || "").slice(0, 2000),
      url: location.href.slice(0, 300),
      build: (globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ || "",
    });
    localStorage.setItem(LOG_KEY, JSON.stringify(list.slice(0, LOG_MAX)));
  } catch { /* 용량 초과 등 — 기록 실패가 앱을 막지는 않는다 */ }
}

/** 경계 밖(비동기·이벤트 핸들러)에서 던진 것도 남긴다 — ErrorBoundary 는 그것들을 못 잡는다.
 *  main.tsx 에서 1회 호출. */
export function installGlobalCrashLog(): void {
  window.addEventListener("error", (ev) => {
    recordCrash({ where: "window.error", message: ev.message || "(no message)",
                  stack: ev.error?.stack || `${ev.filename}:${ev.lineno}:${ev.colno}` });
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const r = ev.reason as { message?: string; stack?: string } | undefined;
    recordCrash({ where: "unhandledrejection",
                  message: r?.message || String(ev.reason).slice(0, 200), stack: r?.stack || "" });
  });
}

interface Props { where: string; children: ReactNode; compact?: boolean }
interface State { err: Error | null; info: string }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null, info: "" };

  static getDerivedStateFromError(err: Error): Partial<State> {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    this.setState({ info: info.componentStack || "" });
    recordCrash({ where: this.props.where, message: err.message,
                  stack: err.stack, componentStack: info.componentStack || "" });
    // 콘솔에도 남긴다(개발자 도구가 열려 있으면 즉시 보이도록)
    console.error(`[Saintview] ${this.props.where} 렌더 실패:`, err, info.componentStack);
  }

  render() {
    const { err, info } = this.state;
    if (!err) return this.props.children;
    const detail = `${this.props.where}\n${err.message}\n\n${err.stack || ""}\n${info}`;
    return (
      <div style={{ padding: 16, color: "var(--text-primary)", background: "var(--bg-canvas)",
                    height: "100%", overflow: "auto", fontSize: 13, lineHeight: 1.7 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: "#f87171", marginBottom: 6 }}>
          이 화면을 표시하는 중 오류가 발생했습니다
        </div>
        <div style={{ color: "var(--text-secondary)", marginBottom: 10 }}>
          나머지 기능은 계속 쓸 수 있습니다. 아래 내용을 개발자에게 전달해 주세요 —
          <b> 새로고침해도 기록은 남습니다</b>(설정 &gt; 정보에서 다시 볼 수 있습니다).
        </div>
        <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 11.5,
                      background: "var(--bg-panel)", border: "1px solid var(--border)",
                      borderRadius: 6, padding: 10, maxHeight: 300, overflow: "auto" }}>
          {detail}
        </pre>
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button className="primary" onClick={() => this.setState({ err: null, info: "" })}>
            다시 시도
          </button>
          <button onClick={() => location.reload()}>새로고침</button>
          <button onClick={() => void navigator.clipboard?.writeText(detail)}>오류 내용 복사</button>
        </div>
      </div>
    );
  }
}
