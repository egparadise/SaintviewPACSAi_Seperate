// 뷰어 영상 영역 화면 캡처 — 서버 렌더 이미지만이 아니라 화면에 보이는 모든 내용
// (그린 주석·측정·툴·문자 오버레이·셔터 등)을 포함해 PNG 로 저장한다.
// html2canvas 로 DOM→canvas 렌더(동적 import — 캡처 눌렀을 때만 로드).

/** el 을 PNG data URL 로. 저장(다운로드)과 화면 안에서 다시 쓰는 용도가 같은 렌더를 쓴다.
 *
 *  scale 을 낮출 수 있게 열어 둔 이유: 협진 화이트보드 배경으로 쓸 때는 devicePixelRatio
 *  배율이 필요 없다(그 위에 그리는 것이 목적이라 1배면 충분하고, 2~3배 dataURL 은 수 MB 가
 *  되어 화면 전환이 눈에 띄게 늦어진다). */
export async function capturePaneToDataUrl(el: HTMLElement, scale?: number): Promise<string> {
  const html2canvas = (await import("html2canvas")).default;
  const canvas = await html2canvas(el, {
    backgroundColor: "#000",              // 영상 배경(검정)
    useCORS: true,                        // 동일 출처 프록시 이미지 허용
    logging: false,
    scale: scale ?? (window.devicePixelRatio || 1),
    ignoreElements: (node) =>
      // 캡처 산출물에 부적절한 오버레이 제외(컨텍스트 메뉴·토스트·시네 미니컨트롤 호버 UI 등)
      node instanceof HTMLElement &&
      (node.hasAttribute("data-sv-ctxmenu") || node.hasAttribute("data-sv-nocapture")),
  });
  return canvas.toDataURL("image/png");
}

/** el(뷰포트 영상 영역) 전체를 PNG 로 캡처해 다운로드. 실패 시 예외를 던진다(호출부 폴백). */
export async function capturePaneToPng(el: HTMLElement, filename?: string): Promise<void> {
  const a = document.createElement("a");
  a.href = await capturePaneToDataUrl(el);
  a.download = filename || `saintview_capture_${Date.now()}.png`;
  a.click();
}
