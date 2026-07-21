// 뷰어 영상 영역 화면 캡처 — 서버 렌더 이미지만이 아니라 화면에 보이는 모든 내용
// (그린 주석·측정·툴·문자 오버레이·셔터 등)을 포함해 PNG 로 저장한다.
// html2canvas 로 DOM→canvas 렌더(동적 import — 캡처 눌렀을 때만 로드).

/** el(뷰포트 영상 영역) 전체를 PNG 로 캡처해 다운로드. 실패 시 예외를 던진다(호출부 폴백). */
export async function capturePaneToPng(el: HTMLElement, filename?: string): Promise<void> {
  const html2canvas = (await import("html2canvas")).default;
  const canvas = await html2canvas(el, {
    backgroundColor: "#000",              // 영상 배경(검정)
    useCORS: true,                        // 동일 출처 프록시 이미지 허용
    logging: false,
    scale: window.devicePixelRatio || 1,  // 고해상도 캡처
    ignoreElements: (node) =>
      // 캡처 산출물에 부적절한 오버레이 제외(컨텍스트 메뉴·토스트·시네 미니컨트롤 호버 UI 등)
      node instanceof HTMLElement &&
      (node.hasAttribute("data-sv-ctxmenu") || node.hasAttribute("data-sv-nocapture")),
  });
  const url = canvas.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || `saintview_capture_${Date.now()}.png`;
  a.click();
}
