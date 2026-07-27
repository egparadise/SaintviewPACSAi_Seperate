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

// DICOMWEB_ROOT·영상 형식 유틸은 lib/imageFormat.ts 로 이관(2D 뷰어가 cornerstone 을
// 끌어오지 않게 하기 위함). ⚠ 여기서 re-export 하면 번들러가 두 모듈을 한 청크로 묶어
// 분리 효과가 사라진다 — 소비자는 반드시 lib/imageFormat 에서 직접 import 할 것.
import { DICOMWEB_ROOT } from "./imageFormat";

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
