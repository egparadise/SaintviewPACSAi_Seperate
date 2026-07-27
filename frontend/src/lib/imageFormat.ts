// 영상 전송 형식·DICOMweb 루트 — **cornerstone 의존이 전혀 없는 경량 모듈**.
//
// ⚡ 왜 분리했나: 2D 뷰어(Viewer2D·ViewerInfi)는 cornerstone 을 한 줄도 실행하지 않는데,
// 여기 있는 상수·함수 3개(DICOMWEB_ROOT·renderedParams·setImageFormat)를 쓰려고
// lib/cornerstone.ts 를 정적 import 하는 바람에 @cornerstonejs/core+tools(빌드 3.0MB,
// dev 7MB)가 2D 뷰어 청크에 딸려 들어와 **뷰어 창 열기의 최대 병목**이었다.
// 이 모듈에는 브라우저 표준 API 외 의존이 없어야 한다(cornerstone import 금지).

export const DICOMWEB_ROOT =
  import.meta.env.VITE_DICOMWEB_ROOT ?? "http://localhost:3000/dicom-web";

// ── 병원별 클라이언트 영상 전송 형식(관리자 설정) — rendered 호출에 accept/quality 파라미터 부여 ──
// default=서버 기본(JPEG) / png=무손실 표시 / jpeg=품질 지정(저대역 원격 최적화)
let IMG_FMT: { format: string; quality: number; wado_ts?: string } = { format: "default", quality: 90, wado_ts: "" };

export function setImageFormat(f: { format?: string; quality?: number; wado_ts?: string }): void {
  IMG_FMT = { format: f.format ?? "default", quality: f.quality ?? 90, wado_ts: f.wado_ts ?? "" };
}

/** 원본 픽셀 전송(3D·정밀) 전송구문 — ""=원본 그대로 */
export function getWadoTs(): string { return IMG_FMT.wado_ts ?? ""; }

/** rendered URL 뒤에 붙일 형식 파라미터 — hasQuery: 이미 ?window= 등이 있는지 */
/** ⚡ 대역 자동 판정 — 저대역/느린 회선에서 대형 매트릭스(DR/CR/DX)를 PNG 로 보내면
 *  1장이 2~4MB 라 첫 표시가 1초를 넘긴다(실측: 20Mbps 에서 PNG 1.70s vs JPEG q90 0.68s).
 *  Network Information API 로 회선을 보고, 느리면 자동으로 JPEG q90 을 쓴다.
 *  ⚠ 관리자가 형식을 명시(png/jpeg)했으면 그 설정이 항상 우선한다(진단 품질 정책 존중).
 *  자동 전환은 기본값('default')일 때만 개입한다. */
function autoJpegForSlowLink(): boolean {
  try {
    const c = (navigator as Navigator & {
      connection?: { effectiveType?: string; downlink?: number; saveData?: boolean };
    }).connection;
    if (!c) return false;                       // 지원 안 하면 개입하지 않음
    if (c.saveData) return true;                // 데이터 절약 모드
    if (c.effectiveType && ["slow-2g", "2g", "3g"].includes(c.effectiveType)) return true;
    // downlink(Mbps 추정) — 25Mbps 미만이면 DR PNG 가 1초를 넘긴다
    return typeof c.downlink === "number" && c.downlink > 0 && c.downlink < 25;
  } catch { return false; }
}

export function renderedParams(hasQuery: boolean): string {
  const sep = hasQuery ? "&" : "?";
  if (IMG_FMT.format === "png") return sep + "accept=image/png";
  if (IMG_FMT.format === "jpeg") return sep + "accept=image/jpeg&quality=" + IMG_FMT.quality;
  // format === "default" — 회선이 느리면 JPEG q90 자동 적용(관리자 미지정 시에만)
  if (autoJpegForSlowLink()) return sep + "accept=image/jpeg&quality=90";
  return "";
}

// HTJ2K 전송구문 — Orthanc 미지원이라 백엔드 스트리밍 프록시(/api/htj2k)로 프레임을 받는다
const HTJ2K_UIDS = ["1.2.840.10008.1.2.4.201", "1.2.840.10008.1.2.4.202", "1.2.840.10008.1.2.4.203"];
export function isHtj2kTs(): boolean { return HTJ2K_UIDS.includes(IMG_FMT.wado_ts ?? ""); }

/** 프레임 요청 베이스 — HTJ2K 설정 시 백엔드 프록시, 그 외 Orthanc DICOMweb */
export function framesBase(): string { return isHtj2kTs() ? "/api/htj2k" : DICOMWEB_ROOT; }

export function authHeader(): Record<string, string> {
  const t = localStorage.getItem("sv_token") ?? sessionStorage.getItem("sv_token");
  return t ? { Authorization: "Bearer " + t } : {};
}
