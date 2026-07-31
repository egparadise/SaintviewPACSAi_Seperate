// 거부(reject) 사유 해석 — 오류 리포트가 **쓸모 있게** 남도록.
//
// 순수 함수라 lib 에 둔다(ErrorBoundary 는 .tsx 라 Node 테스트가 직접 못 읽는다).
// tests/crash_report_rule.test.mjs 가 이 모듈을 그대로 부른다.

/**
 * 거부(reject) 사유에서 **쓸모 있는 것**을 뽑아낸다.
 *
 * ⚠ 실제로 있었던 일: 뷰어에서 영상 요청이 실패하면 로그에 `[object XMLHttpRequest]` 만
 *   20줄 남았다. `String(reason)` 이 XHR 을 문자열로 뭉개면서 **status·URL 을 통째로 버린
 *   것**이다. 정작 필요한 것(어느 주소가 몇 번으로 실패했나)이 그 객체 안에 다 있었다.
 *   영상 로더(@cornerstonejs/dicom-image-loader)는 Error 가 아니라 XHR 을 그대로 reject 한다.
 */
export function describeReason(reason: unknown): { message: string; stack: string } {
  if (reason instanceof Error) return { message: reason.message, stack: reason.stack || "" };
  const r = reason as Record<string, unknown> | null | undefined;
  // XMLHttpRequest — status / statusText / responseURL 이 원인 그 자체다
  if (r && typeof r === "object" && "readyState" in r && "status" in r) {
    const st = Number(r.status ?? 0);
    const url = String(r.responseURL ?? "");
    const txt = String(r.statusText ?? "");
    // status 0 = 네트워크 끊김·CORS·중단(브라우저가 상태를 안 준다)
    const what = st ? `HTTP ${st}${txt ? ` ${txt}` : ""}` : "네트워크 실패(status 0 — 중단·차단·연결 끊김)";
    return { message: `XHR ${what} — ${url || "(주소 불명)"}`, stack: "" };
  }
  // fetch Response
  if (r && typeof r === "object" && "ok" in r && "status" in r && "url" in r) {
    return { message: `HTTP ${r.status} — ${String(r.url)}`, stack: "" };
  }
  if (r && typeof r === "object") {
    const m = r.message ?? r.error ?? r.detail;
    if (m) return { message: String(m), stack: String(r.stack ?? "") };
    try {
      return { message: JSON.stringify(r).slice(0, 300), stack: "" };
    } catch {
      return { message: Object.prototype.toString.call(r), stack: "" };
    }
  }
  return { message: String(reason), stack: "" };
}
