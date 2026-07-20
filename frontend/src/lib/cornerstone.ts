// Cornerstone3D 공용 초기화 + DICOMweb(wadors) 메타데이터 등록
import { init as csInit } from "@cornerstonejs/core";
import {
  PanTool,
  StackScrollTool,
  WindowLevelTool,
  ZoomTool,
  LengthTool,
  AngleTool,
  RectangleROITool,
  EllipticalROITool,
  ArrowAnnotateTool,
  MagnifyTool,
  addTool,
  init as toolsInit,
} from "@cornerstonejs/tools";
import { init as dicomImageLoaderInit, wadors } from "@cornerstonejs/dicom-image-loader";

export const DICOMWEB_ROOT =
  import.meta.env.VITE_DICOMWEB_ROOT ?? "http://localhost:3000/dicom-web";

let initialized = false;
export async function ensureCornerstone() {
  if (initialized) return;
  // useNorm16Texture: 16비트 픽셀 정밀 텍스처 — 계조 뭉개짐 방지 (Viewer3D ensureInit 과 동일)
  // 설치된 @cornerstonejs 타입 정의엔 없으나 런타임 옵션은 유효 — 인자 캐스팅으로 타입만 통과
  await csInit({ rendering: { useNorm16Texture: true } } as unknown as Parameters<typeof csInit>[0]);
  // vite dev에서 디코드 워커 무음 정지 이슈 → 메인스레드 디코드(소량 스택엔 충분)
  dicomImageLoaderInit({ maxWebWorkers: 0 });
  toolsInit();
  for (const T of [
    WindowLevelTool, PanTool, ZoomTool, StackScrollTool, MagnifyTool,
    LengthTool, AngleTool, RectangleROITool, EllipticalROITool, ArrowAnnotateTool,
  ]) {
    try { addTool(T); } catch { /* 중복 등록 무시 (HMR) */ }
  }
  initialized = true;
}

type DwJson = Record<string, { Value?: unknown[] }>;

/** 시리즈 메타데이터를 wadors 매니저에 등록하고 정렬된 imageId 목록 반환 */
export async function registerSeriesImageIds(studyUid: string, seriesUid: string): Promise<string[]> {
  const res = await fetch(`${DICOMWEB_ROOT}/studies/${studyUid}/series/${seriesUid}/metadata`);
  if (!res.ok) throw new Error("시리즈 메타데이터 조회 실패");
  const instances: DwJson[] = await res.json();
  const withIds = instances
    .map((meta) => {
      const sop = String(meta["00080018"]?.Value?.[0] ?? "");
      const num = Number(meta["00200013"]?.Value?.[0] ?? 0);
      const imageId =
        `wadors:${DICOMWEB_ROOT}/studies/${studyUid}/series/${seriesUid}/instances/${sop}/frames/1`;
      return { imageId, num, meta, sop };
    })
    .filter((x) => x.sop)
    .sort((a, b) => a.num - b.num);
  for (const { imageId, meta } of withIds) {
    wadors.metaDataManager.add(imageId, meta as never);
  }
  return withIds.map((x) => x.imageId);
}

/** 검사에서 3D 볼륨용 시리즈 imageIds — 진단 시리즈 우선(보정/로컬라이저/스카우트 후순위), 그다음 슬라이스 수.
    기존엔 인스턴스 최다 기준이라 128×128 보정(Cal) 시리즈가 뽑혀 3D 해상도가 낮아 보였다. */
const NON_DIAG_RE = /cal|calib|localizer|3.?plane|scout|screen ?save|dose|report|survey/i;
export async function buildVolumeImageIds(studyUid: string): Promise<string[]> {
  const seriesRes = await fetch(`${DICOMWEB_ROOT}/studies/${studyUid}/series`);
  if (!seriesRes.ok) throw new Error("시리즈 조회 실패");
  const seriesList: DwJson[] = await seriesRes.json();
  const candidates = seriesList
    .map((s) => ({
      uid: String(s["0020000E"]?.Value?.[0] ?? ""),
      modality: String(s["00080060"]?.Value?.[0] ?? ""),
      count: Number(s["00201209"]?.Value?.[0] ?? 0),
      desc: String((s["0008103E"]?.Value?.[0] as string) ?? ""),
    }))
    .filter((s) => s.uid && !["SR", "KO", "PR", "SEG"].includes(s.modality));
  if (candidates.length === 0) throw new Error("영상 시리즈가 없습니다");
  candidates.sort((a, b) =>
    (Number(NON_DIAG_RE.test(a.desc)) - Number(NON_DIAG_RE.test(b.desc))) || (b.count - a.count));
  return registerSeriesImageIds(studyUid, candidates[0].uid);
}


// ── 병원별 클라이언트 영상 전송 형식(관리자 설정) — rendered 호출에 accept/quality 파라미터 부여 ──
// default=서버 기본(JPEG) / png=무손실 표시 / jpeg=품질 지정(저대역 원격 최적화)
let IMG_FMT: { format: string; quality: number; wado_ts?: string } = { format: "default", quality: 90, wado_ts: "" };
export function setImageFormat(f: { format?: string; quality?: number; wado_ts?: string }): void {
  IMG_FMT = { format: f.format ?? "default", quality: f.quality ?? 90, wado_ts: f.wado_ts ?? "" };
}
/** 원본 픽셀 전송(3D·정밀) 전송구문 — ""=원본 그대로 */
export function getWadoTs(): string { return IMG_FMT.wado_ts ?? ""; }
/** rendered URL 뒤에 붙일 형식 파라미터 — hasQuery: 이미 ?window= 등이 있는지 */
export function renderedParams(hasQuery: boolean): string {
  const sep = hasQuery ? "&" : "?";
  if (IMG_FMT.format === "png") return sep + "accept=image/png";
  if (IMG_FMT.format === "jpeg") return sep + "accept=image/jpeg&quality=" + IMG_FMT.quality;
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
