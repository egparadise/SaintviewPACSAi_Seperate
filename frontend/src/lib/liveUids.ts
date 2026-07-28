// WebPACS Live(A 직결) — 라이브 검사 StudyUID 레지스트리.
// 뷰어의 rendered URL 은 study_uid 로 조립되므로, 가상 id(vid)로 로드된 검사의 UID 를
// 여기 등록해 두면 페인 단위(비교·Combine 혼합 포함)로 라이브/로컬 루트를 정확히 가른다.
// (cornerstone.ts 가 아닌 독립 모듈 — api.ts 가 cornerstone 번들을 끌지 않게)

// 인증: 이 URL 들에는 자격증명이 **들어 있지 않다**. 서버가 로그인 때 심어 둔 HttpOnly 쿠키
// (sv_pix, Path=/api/webpacs/live)를 브라우저가 자동으로 싣는다(backend deps.pixel_user).
// 그래서 URL 이 안정적이고 ETag/304·캐시·preview=1 이 전부 그대로 산다.
// ⚠ crossOrigin="anonymous" 로 읽는 캔버스 경로(pixelTools.samplePixels·mgHang.mgProbeUrl)는
//   자격증명 모드가 'same-origin' 이라 같은 출처에서는 쿠키가 실린다. API 를 다른 호스트에
//   둔 배치에서는 실리지 않으므로 그 배치에서는 이 캔버스 기능만 동작하지 않는다.
export const LIVE_DICOMWEB_ROOT = "/api/webpacs/live/dicom-web";

const uids = new Set<string>();

export function registerLiveStudyUid(uid: string | undefined | null): void {
  if (uid) uids.add(uid);
}

export function isLiveStudyUid(uid: string | undefined | null): boolean {
  return !!uid && uids.has(uid);
}

/** rendered 루트 — 라이브 검사 UID 면 라이브 프록시, 아니면 기본(Orthanc DICOMweb) */
export function renderedRootFor(studyUid: string | undefined | null, fallback: string): string {
  return isLiveStudyUid(studyUid) ? LIVE_DICOMWEB_ROOT : fallback;
}

/** ⚡ 저해상 미리보기 URL — Live 검사에서만. 원격 A 가 배치로 미리 만들어 둔
 *  512×512 JPEG(≈40KB)이라 원본(수 MB PNG)이 도착하기 전에 화면을 즉시 채운다.
 *  뷰어는 이 이미지를 원본 <img> **뒤에** 깔아 두기만 하면 된다 —
 *  원본이 로드되면 위에 그려지므로 별도 전환 처리가 필요 없다.
 *  Live 가 아니면 null(로컬 Orthanc 는 같은 망이라 2단계가 오히려 요청만 늘린다). */
export function previewUrlOf(renderedUrl: string, studyUid: string | undefined | null): string | null {
  // ⚠ studyUid 만 보면 안 된다 — Combine 페인은 다른 검사의 URL 을 쓰고, WASM 파이프라인은
  //   blob: URL 을 준다. 그런 URL 에 ?preview=1 을 붙이면 엉뚱한 요청이 한 번 더 나간다.
  //   실제로 라이브 프록시로 나가는 URL 인지까지 확인한다.
  if (!isLiveStudyUid(studyUid)) return null;
  if (!renderedUrl.startsWith(LIVE_DICOMWEB_ROOT)) return null;
  const base = renderedUrl.split("?")[0];       // W/L·형식 파라미터는 미리보기에 무의미
  return `${base}?preview=1`;
}
