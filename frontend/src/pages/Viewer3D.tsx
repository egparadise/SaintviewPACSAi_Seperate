// Saintview 3D 뷰어 — Cornerstone3D(WebGL) 기반 MPR 3면 + MIP 볼륨 렌더링 (강화판)
// - 시리즈 선택: 볼륨 적합 시리즈 목록에서 선택(자동 선택 실패 대비 — 예: MR 보정 시리즈 회피)
// - Crosshairs: 세 MPR 십자선 연동 — 한 평면의 라인을 끌면 다른 평면들의 중심이 그 위치로 이동
// - MIP: 방향(AX/SAG/COR) 전환 + slab 두께 조절
// 디자인 명세 §4 [VP] 오버레이·활성 테두리 규칙 준수. OHIF 보완용 내장 뷰어.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Enums,
  RenderingEngine,
  cache,
  eventTarget,
  init as csInit,
  setVolumesForViewports,
  volumeLoader,
  type Types,
} from "@cornerstonejs/core";
import vtkPlane from "@kitware/vtk.js/Common/DataModel/Plane";
import {
  CrosshairsTool,
  EllipticalROITool,
  Enums as ToolsEnums,
  PanTool,
  PlanarFreehandROITool,
  RectangleROITool,
  SplineROITool,
  StackScrollTool,
  ToolGroupManager,
  TrackballRotateTool,
  WindowLevelTool,
  ZoomTool,
  addTool,
  annotation as csAnnotation,
  init as toolsInit,
} from "@cornerstonejs/tools";
import { init as dicomImageLoaderInit, wadors } from "@cornerstonejs/dicom-image-loader";
import { authHeader, framesBase, getWadoTs } from "../lib/cornerstone";

const DICOMWEB_ROOT = import.meta.env.VITE_DICOMWEB_ROOT ?? "http://localhost:3000/dicom-web";

const RENDERING_ENGINE_ID = "sv-engine";
const TG_MPR = "sv-tools-mpr";
const TG_MIP = "sv-tools-mip";

const MPR_VIEWPORTS = [
  { id: "vp-axial", label: "Axial (MPR)", orientation: Enums.OrientationAxis.AXIAL },
  { id: "vp-sagittal", label: "Sagittal (MPR)", orientation: Enums.OrientationAxis.SAGITTAL },
  { id: "vp-coronal", label: "Coronal (MPR)", orientation: Enums.OrientationAxis.CORONAL },
] as const;
const MIP_VPS = [
  { id: "vp-mip-axial", label: "MIP Axial", orientation: Enums.OrientationAxis.AXIAL },
  { id: "vp-mip-sagittal", label: "MIP Sagittal", orientation: Enums.OrientationAxis.SAGITTAL },
  { id: "vp-mip-coronal", label: "MIP Coronal", orientation: Enums.OrientationAxis.CORONAL },
] as const;

// Crosshairs 참조선 색 — 평면별 구분(축=노랑, 새지털=시안, 코로날=초록)
const REF_COLORS: Record<string, string> = {
  "vp-axial": "#eab308", "vp-sagittal": "#38bdf8", "vp-coronal": "#4ade80",
};

let initialized = false;
async function ensureInit() {
  if (initialized) return;
  // useNorm16Texture: CT/MR 16비트 픽셀을 저정밀 텍스처로 양자화하지 않도록 — 계조 뭉개짐(banding) 방지
  // 설치된 @cornerstonejs 타입 정의엔 없으나 런타임 옵션은 유효 — 인자 캐스팅으로 타입만 통과
  await csInit({ rendering: { useNorm16Texture: true } } as unknown as Parameters<typeof csInit>[0]);
  dicomImageLoaderInit({
    // 병원 설정(wado_ts)이 있으면 프레임 요청 Accept 에 해당 전송구문 지정 — Orthanc 가 트랜스코딩해 전달
    beforeSend: (_xhr: XMLHttpRequest, imageId: string) => {
      if (imageId.includes("/api/htj2k/")) return authHeader();   // 백엔드 HTJ2K 프록시 — JWT
      const ts = getWadoTs();
      if (ts && imageId.includes("/frames/")) {
        return { Accept: `multipart/related; type="application/octet-stream"; transfer-syntax=${ts}` };
      }
    },
  } as Parameters<typeof dicomImageLoaderInit>[0]);
  toolsInit();
  addTool(WindowLevelTool);
  addTool(PanTool);
  addTool(ZoomTool);
  addTool(StackScrollTool);
  addTool(CrosshairsTool);
  addTool(RectangleROITool);
  addTool(EllipticalROITool);
  addTool(PlanarFreehandROITool);
  addTool(SplineROITool);
  addTool(TrackballRotateTool);
  initialized = true;
}

interface SeriesCand { uid: string; modality: string; count: number; desc: string }

/* 비진단 시리즈(보정/로컬라이저/스카우트/선량보고 등) — 슬라이스가 많아도 3D 볼륨 기본 선택에서 후순위 */
const NON_DIAG_RE = /cal|calib|localizer|3.?plane|scout|screen ?save|dose|report|survey/i;

/** 볼륨 적합 시리즈 후보 목록 (비영상 제외) — 진단 시리즈 우선, 그다음 매트릭스×슬라이스 크기순.
    기존엔 슬라이스 수만으로 정렬해 128×128 보정(Cal) 시리즈가 기본 선택돼 3D 가 뿌옇게 보였다. */
async function listSeries(studyUid: string): Promise<SeriesCand[]> {
  const res = await fetch(`${DICOMWEB_ROOT}/studies/${studyUid}/series`);
  if (!res.ok) throw new Error("시리즈 조회 실패");
  const seriesList: Record<string, { Value?: unknown[] }>[] = await res.json();
  const cands = seriesList
    .map((s) => ({
      uid: String(s["0020000E"]?.Value?.[0] ?? ""),
      modality: String(s["00080060"]?.Value?.[0] ?? ""),
      count: Number(s["00201209"]?.Value?.[0] ?? 0),
      desc: String((s["0008103E"]?.Value?.[0] as string) ?? ""),
    }))
    .filter((s) => s.uid && !["SR", "KO", "PR", "SEG"].includes(s.modality));
  // 각 후보의 매트릭스(Rows×Cols)를 QIDO 인스턴스 1건으로 조회 — 해상도 가중치(실패 시 0=순서 영향 없음).
  // 검사 단위 일괄 QIDO 는 Rows/Columns 가 Orthanc 인덱스 밖이라 전 인스턴스 파일 접근을 유발(실측 더 느림) — 시리즈별 limit=1 병렬 유지.
  const area = await Promise.all(cands.map(async (s) => {
    try {
      const r = await fetch(
        `${DICOMWEB_ROOT}/studies/${studyUid}/series/${s.uid}/instances?limit=1&includefield=00280010&includefield=00280011`);
      if (!r.ok) return 0;
      const [inst] = await r.json() as Record<string, { Value?: unknown[] }>[];
      return Number(inst?.["00280010"]?.Value?.[0] ?? 0) * Number(inst?.["00280011"]?.Value?.[0] ?? 0);
    } catch { return 0; }
  }));
  return cands
    .map((s, i) => ({ ...s, _score: (NON_DIAG_RE.test(s.desc) ? 0 : 1e12) + (area[i] || 1) * Math.max(1, s.count) }))
    .sort((a, b) => b._score - a._score)
    .map(({ _score, ...s }) => s);
}

/** 지정 시리즈의 wadors imageId 목록 구성 + 메타데이터 등록 */
async function buildImageIds(studyUid: string, seriesUid: string): Promise<string[]> {
  const metaRes = await fetch(
    `${DICOMWEB_ROOT}/studies/${studyUid}/series/${seriesUid}/metadata`,
  );
  if (!metaRes.ok) throw new Error("시리즈 메타데이터 조회 실패");
  const instances: Record<string, { Value?: unknown[] }>[] = await metaRes.json();

  const withIds = instances
    .map((meta) => {
      const sop = String(meta["00080018"]?.Value?.[0] ?? "");
      const num = Number(meta["00200013"]?.Value?.[0] ?? 0);
      const imageId =
        `wadors:${framesBase()}/studies/${studyUid}/series/${seriesUid}` +
        `/instances/${sop}/frames/1`;
      return { imageId, num, sop, meta };
    })
    .filter((x) => x.sop)
    .sort((a, b) => a.num - b.num);

  for (const { imageId, meta } of withIds) {
    wadors.metaDataManager.add(imageId, meta as never);
  }
  return withIds.map((x) => x.imageId);
}

export function Viewer3D({ studyUid, onClose, embedded, seriesUid }: {
  studyUid: string;
  onClose: () => void;
  embedded?: boolean;  // Viewer2D 내장 MPR/MIP — 새 창 없이 현재 뷰포트 영역에 표시
  seriesUid?: string;  // 외부(좌측 썸네일 클릭)에서 지정한 볼륨 시리즈 — 변경 시 볼륨 재구성
}) {
  const containerRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const gridRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<RenderingEngine | null>(null);

  // ── 우클릭 확장(Linkclump 류) 링크박스 차단 + 우드래그 Zoom 자체 구동 (2D 뷰어 358fbbd 동형) ──
  // Cornerstone3D tools 는 compat mouse 이벤트(mousedown/mousemove)로 구동되므로, pointerdown
  // preventDefault 로 compat 생성을 막으면 확장은 무력화되지만 ZoomTool(Secondary=우버튼)도 죽는다.
  // → 우클릭에 한해 이벤트를 전면 차단하고 Zoom 을 viewport.setZoom 으로 직접 재구현한다.
  //   (좌·중클릭·휠은 그대로 Cornerstone 이 처리. 우클릭 chord — 좌드래그 중 우버튼 추가 — 는
  //    pointerdown 자체가 생성되지 않아 원천 차단 불가한 스펙 한계로 수용)
  useEffect(() => {
    let zdrag: { vpId: string; y: number } | null = null;
    const cap = (e: PointerEvent) => {
      if (e.button !== 2) return;
      const t = e.target as Node | null;
      const entry = Object.entries(containerRefs.current).find(([, el]) => el && t && el.contains(t));
      if (!entry) return;   // 3D 뷰포트 밖 우클릭은 관여 안 함
      e.preventDefault(); e.stopImmediatePropagation();
      setActiveVp(entry[0]);   // compat mousedown 미발화 보완 — 활성 뷰포트 외곽선 유지
      zdrag = { vpId: entry[0], y: e.clientY };
    };
    const move = (e: PointerEvent) => {
      if (!zdrag) return;
      const dy = e.clientY - zdrag.y;
      zdrag.y = e.clientY;
      if (!dy) return;
      const vp = engineRef.current?.getViewport(zdrag.vpId) as unknown as
        { getZoom: () => number; setZoom: (z: number) => void; render: () => void } | undefined;
      if (!vp?.getZoom) return;
      // ZoomTool 동등 — 아래로 드래그=확대, 감도 5/뷰포트높이(px당). (Viewer2D 자체 zoom 드래그와는 방향 반대지만
      // 3D 뷰어의 기존 ZoomTool 체감을 보존하는 쪽을 따른다)
      const h = Math.max(100, containerRefs.current[zdrag.vpId]?.clientHeight ?? 500);
      vp.setZoom(Math.max(0.05, Math.min(30, vp.getZoom() * (1 + dy * (5 / h)))));
      vp.render();
    };
    const up = (e: PointerEvent) => { if (e.button === 2) zdrag = null; };
    window.addEventListener("pointerdown", cap, true);   // capture 단계(확장 무력화)
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointerdown", cap, true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);
  const [status, setStatus] = useState("초기화 중…");
  const [error, setError] = useState("");
  const [slabMm, setSlabMm] = useState(30);
  const [blend, setBlend] = useState<"mip" | "minip" | "avip" | "off">("mip");   // 강도 투영 모드
  const [mipSetOpen, setMipSetOpen] = useState(false);                            // MIP Settings 패널
  const [vrOn, setVrOn] = useState(false);                                        // 3D 볼륨 렌더링 페인(슬랩 조정 시 자동)
  const volumeIdRef = useRef("");
  const [activeVp, setActiveVp] = useState("vp-axial");
  const [seriesList, setSeriesList] = useState<SeriesCand[]>([]);
  const [selSeries, setSelSeries] = useState("");
  // 기능 믹스 — 각 도구를 독립 토글로 동시 사용. 무수정자 좌클릭 우선순위: Crosshair > ROI > W/L,
  // 우선순위에 밀린 도구는 자동으로 수정자 바인딩: ROI=Shift+좌, W/L=Ctrl+좌, 채우기=Alt+클릭.
  const [modes, setModes] = useState({ crosshair: true, wl: false, roi: false, fill: false });
  const modesRef = useRef(modes);
  modesRef.current = modes;
  const [fillColor, setFillColor] = useState("#22d3ee");   // 채우기(분할) 색 — 컬러 피커
  const [fillOn, setFillOn] = useState(false);             // 분할 결과 존재 여부
  const segIdRef = useRef("");                             // 라벨맵(파생) 볼륨 ID
  const segVpsRef = useRef<Set<string>>(new Set());        // 세그 볼륨이 추가된 뷰포트
  const [vrCam, setVrCam] = useState("");                       // VR 좌하단 좌표(회전각·카메라 위치)
  const [cropOn, setCropOn] = useState(false);                  // ROI 크롭 적용 여부
  const cropRef = useRef<{ mins: number[]; maxs: number[] } | null>(null);
  const [roiShape, setRoiShape] = useState<"rect" | "oval" | "free">("rect");   // ROI 모양(콤보)
  const [roiEffect, setRoiEffect] = useState<"focus" | "remove">("focus");      // Focus=영역만 / 제거=영역 빼고
  const voxBackupRef = useRef<{ vals: Float32Array; idx: Uint32Array } | null>(null);   // 제거 모드 복셀 백업(복원용)
  const [mipMax, setMipMax] = useState<string | null>(null);   // MIP 1×3 중 더블클릭 확대(1×1) 대상
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const applySlab = useCallback((mm: number, mode?: "mip" | "minip" | "avip" | "off") => {
    const engine = engineRef.current;
    if (!engine) return;
    const m = mode ?? "mip";
    const BM = Enums.BlendModes;
    const want = m === "mip" ? BM.MAXIMUM_INTENSITY_BLEND
               : m === "minip" ? BM.MINIMUM_INTENSITY_BLEND
               : m === "avip" ? BM.AVERAGE_INTENSITY_BLEND
               : BM.COMPOSITE;
    let applied = 0;
    for (const mv of MIP_VPS) {
      const vp = engine.getViewport(mv.id) as Types.IVolumeViewport | undefined;
      if (!vp) continue;
      try {
        // 강도 투영 모드 — MIP(최대)/MinIP(최소)/AvIP(평균)/끄기(일반 컴포지트 렌더링)
        vp.setBlendMode(want);
        if (m === "off") {
          (vp as unknown as { resetSlabThickness?: () => void }).resetSlabThickness?.();
        } else {
          vp.setSlabThickness(mm);
        }
        vp.render();
        // readback 검증 — 실제 적용된 블렌드 모드 확인(미적용이면 카운트 제외)
        const got = (vp as unknown as { getBlendMode?: () => number }).getBlendMode?.();
        if (got === undefined || got === want) applied++;
      } catch { /* 뷰포트 미준비 */ }
    }
    if (applied > 0) {
      setStatus(m === "off" ? "MIP 끄기 — 일반 렌더링 ×" + applied
        : (m === "mip" ? "MIP" : m === "minip" ? "MinIP" : "AvIP") + " " + mm + "mm 적용 ×" + applied + " (Axial/Sagittal/Coronal)");
    }
  }, []);

  const ROI_TOOLS = [RectangleROITool.toolName, EllipticalROITool.toolName,
                     PlanarFreehandROITool.toolName, SplineROITool.toolName];
  const roiToolOf = (shape: "rect" | "oval" | "free") =>
    shape === "rect" ? RectangleROITool.toolName
    : shape === "oval" ? EllipticalROITool.toolName
    : SplineROITool.toolName;   // Free — 클릭할 때마다 포인트, 시작점과 만나면 영역 확정

  // 도구 믹스 적용 — ON 인 도구 전부 활성(바인딩 분배), OFF 는 비활성
  const applyMix = useCallback((mm?: { crosshair: boolean; wl: boolean; roi: boolean; fill: boolean },
                                shape?: "rect" | "oval" | "free") => {
    const g = ToolGroupManager.getToolGroup(TG_MPR);
    if (!g) return;
    const md = mm ?? modesRef.current;
    try {
      // 초기화 후 ON 도구만 바인딩 부여
      g.setToolDisabled(CrosshairsTool.toolName);
      for (const t of ROI_TOOLS) g.setToolPassive(t);
      g.setToolPassive(WindowLevelTool.toolName);
      const prim = md.crosshair ? "crosshair" : md.roi ? "roi" : md.wl ? "wl" : null;
      if (md.crosshair) {
        g.setToolActive(CrosshairsTool.toolName, {
          bindings: [{ mouseButton: ToolsEnums.MouseBindings.Primary }],
        });
      }
      if (md.roi) {
        g.setToolActive(roiToolOf(shape ?? roiShape), {
          bindings: [prim === "roi"
            ? { mouseButton: ToolsEnums.MouseBindings.Primary }
            : { mouseButton: ToolsEnums.MouseBindings.Primary, modifierKey: ToolsEnums.KeyboardBindings.Shift }],
        });
      }
      if (md.wl) {
        g.setToolActive(WindowLevelTool.toolName, {
          bindings: [prim === "wl"
            ? { mouseButton: ToolsEnums.MouseBindings.Primary }
            : { mouseButton: ToolsEnums.MouseBindings.Primary, modifierKey: ToolsEnums.KeyboardBindings.Ctrl }],
        });
      }
      engineRef.current?.render();
    } catch { /* 그룹 미준비 */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roiShape]);
  const toggleMode = (k: "crosshair" | "wl" | "roi" | "fill") => {
    const next = { ...modesRef.current, [k]: !modesRef.current[k] };
    if (k === "roi" && !next.roi) clearRoiAllRef.current?.();   // ROI Off — 주석·효과 정리
    if (k === "fill" && !next.fill) clearFillRef.current?.();   // 채우기 Off — 분할 삭제
    setModes(next);
    applyMix(next);
  };
  const clearRoiAllRef = useRef<(() => void) | null>(null);
  const clearFillRef = useRef<(() => void) | null>(null);


  // 좌측 썸네일 클릭 → 볼륨 시리즈 전환(목록에 있는 시리즈만) — 3D 를 원하는 시리즈로 재구성
  useEffect(() => {
    if (!seriesUid) return;
    setSelSeries((cur) => (seriesUid !== cur && seriesList.some((x) => x.uid === seriesUid) ? seriesUid : cur));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesUid, seriesList]);

  // 시리즈 목록 로드 → 기본(최다 슬라이스, 10장 이상 우선) 선택
  useEffect(() => {
    setError("");
    setSeriesList([]);
    setSelSeries("");
    listSeries(studyUid).then((list) => {
      setSeriesList(list);
      const good = list.find((s) => s.count >= 10) ?? list[0];
      if (!good) { setError("영상 시리즈가 없습니다"); setStatus(""); return; }
      setSelSeries(good.uid);
    }).catch((e) => { setError(e instanceof Error ? e.message : String(e)); setStatus(""); });
  }, [studyUid]);

  // 볼륨 구성 (시리즈 변경 시 재구성)
  useEffect(() => {
    if (!selSeries) return;
    let disposed = false;

    (async () => {
      try {
        setError("");
        await ensureInit();
        setStatus("시리즈 메타데이터 로딩…");
        const imageIds = await buildImageIds(studyUid, selSeries);
        if (disposed) return;
        if (imageIds.length < 3) {
          throw new Error(`볼륨 구성에 슬라이스가 부족합니다 (${imageIds.length}장) — 다른 시리즈를 선택하세요`);
        }
        setStatus(`볼륨 로딩… (${imageIds.length} 슬라이스)`);

        const engine = new RenderingEngine(RENDERING_ENGINE_ID);
        engineRef.current = engine;
        engine.setViewports(
          [...MPR_VIEWPORTS.map((v) => ({
            viewportId: v.id,
            type: Enums.ViewportType.ORTHOGRAPHIC,
            element: containerRefs.current[v.id]!,
            defaultOptions: { orientation: v.orientation, background: [0.04, 0.04, 0.055] as Types.Point3 },
          })),
          ...MIP_VPS.map((mv) => ({
            viewportId: mv.id,
            type: Enums.ViewportType.ORTHOGRAPHIC,
            element: containerRefs.current[mv.id]!,
            defaultOptions: { orientation: mv.orientation, background: [0.04, 0.04, 0.055] as Types.Point3 },
          }))],
        );

        // ── MPR 그룹: Crosshairs(좌) + Zoom(우) + Pan(중) + 휠 스크롤 ──
        for (const id of [TG_MPR, TG_MIP]) {
          if (ToolGroupManager.getToolGroup(id)) ToolGroupManager.destroyToolGroup(id);
        }
        const mpr = ToolGroupManager.createToolGroup(TG_MPR)!;
        mpr.addTool(WindowLevelTool.toolName);
        mpr.addTool(ZoomTool.toolName);
        mpr.addTool(PanTool.toolName);
        mpr.addTool(StackScrollTool.toolName);
        mpr.addTool(RectangleROITool.toolName);
        mpr.addTool(EllipticalROITool.toolName);
        mpr.addTool(SplineROITool.toolName);
        mpr.addTool(CrosshairsTool.toolName, {
          getReferenceLineColor: (id: string) => REF_COLORS[id] ?? "#94a3b8",
          getReferenceLineControllable: () => true,
          getReferenceLineDraggableRotatable: () => true,
          getReferenceLineSlabThicknessControlsOn: () => true,   // 참조선 점선 핸들 — 드래그로 슬랩 폭 조정
        });
        mpr.setToolActive(ZoomTool.toolName, {
          bindings: [{ mouseButton: ToolsEnums.MouseBindings.Secondary }],
        });
        mpr.setToolActive(PanTool.toolName, {
          bindings: [{ mouseButton: ToolsEnums.MouseBindings.Auxiliary }],
        });
        mpr.setToolActive(StackScrollTool.toolName, {
          bindings: [{ mouseButton: ToolsEnums.MouseBindings.Wheel }],
        });
        for (const v of MPR_VIEWPORTS) mpr.addViewport(v.id, RENDERING_ENGINE_ID);

        // ── MIP 그룹: W/L(좌) + Zoom(우) + Pan(중) + 휠 스크롤 ──
        const mip = ToolGroupManager.createToolGroup(TG_MIP)!;
        mip.addTool(WindowLevelTool.toolName);
        mip.addTool(ZoomTool.toolName);
        mip.addTool(PanTool.toolName);
        mip.addTool(StackScrollTool.toolName);
        mip.setToolActive(WindowLevelTool.toolName, {
          bindings: [{ mouseButton: ToolsEnums.MouseBindings.Primary }],
        });
        mip.setToolActive(ZoomTool.toolName, {
          bindings: [{ mouseButton: ToolsEnums.MouseBindings.Secondary }],
        });
        mip.setToolActive(PanTool.toolName, {
          bindings: [{ mouseButton: ToolsEnums.MouseBindings.Auxiliary }],
        });
        mip.setToolActive(StackScrollTool.toolName, {
          bindings: [{ mouseButton: ToolsEnums.MouseBindings.Wheel }],
        });
        for (const mv of MIP_VPS) mip.addViewport(mv.id, RENDERING_ENGINE_ID);

        // 시리즈별 고유 볼륨 ID — 시리즈 전환 시 캐시 충돌 방지
        const volumeId = `cornerstoneStreamingImageVolume:sv-${selSeries.slice(-24)}`;
        volumeIdRef.current = volumeId;
        const volume = await volumeLoader.createAndCacheVolume(volumeId, { imageIds });
        // 점진 스트리밍 — 전량 로드를 기다리지 않고 뷰포트를 먼저 부착(슬라이스가 도착하는 대로 표시).
        // ⚠ cs3d v5 의 load(callback) 은 void 반환 — 완료 감지는 콜백 카운터로만 한다.
        const total = imageIds.length;
        let done = 0;
        try {
          (volume as { load: (cb?: (evt: unknown) => void) => unknown }).load?.(() => {
            done += 1;
            if (disposed) return;
            if (done >= total) {
              setStatus("");
              engineRef.current?.render();   // 전량 도착 후 최종 렌더(잔여 슬라이스 반영)
            } else if (done % 10 === 0) {
              setStatus(`볼륨 로딩… ${Math.round((done / total) * 100)}% (${done}/${total})`);
            }
          });
        } catch { /* 스트리밍 시작 실패 — 아래 뷰포트 부착은 진행(코어가 재시도) */ }
        // 안전망 — 일부 슬라이스 수신 실패로 100% 에 못 미치면 진행률 라벨이 남지 않게 정리
        window.setTimeout(() => {
          if (!disposed) setStatus((s) => (s.startsWith("볼륨 로딩") ? "" : s));
        }, 120_000);
        await setVolumesForViewports(
          engine,
          [{ volumeId }],
          [...MPR_VIEWPORTS.map((v) => v.id), ...MIP_VPS.map((mv) => mv.id)],
        );
        applySlab(slabMm, blend);
        window.setTimeout(() => applySlab(slabMm, blend), 300);   // MIP 블렌드 재적용(뷰포트 준비 타이밍)
        window.setTimeout(() => applySlab(slabMm, blend), 900);
        applyMix();   // 도구 믹스 — ON 인 도구 전부 활성(기본 Crosshair)
        engine.render();
        requestAnimationFrame(() => {
          engine.resize(true, true);
          engine.render();
        });
        // 초기 레이아웃 타이밍에 캔버스가 기본 300×150 백킹으로 남는 경우 재-resize (최대 5회)
        {
          let tries = 0;
          const fix = () => {
            const c = gridRef.current?.querySelector("canvas");
            if (c && (c.width === 300 && c.height === 150) && tries++ < 5) {
              engineRef.current?.resize(true, true);
              engineRef.current?.render();
              window.setTimeout(fix, 300);
            }
          };
          window.setTimeout(fix, 300);
        }
        if (gridRef.current && !resizeObserverRef.current) {
          const ro = new ResizeObserver(() => {
            engineRef.current?.resize(true, true);
            engineRef.current?.render();
          });
          ro.observe(gridRef.current);
          resizeObserverRef.current = ro;
        }
        // status 는 스트리밍 완료 시(loadPromise.then) 비운다 — 진행률 표시 유지
      } catch (e) {
        if (!disposed) {
          setError(e instanceof Error ? e.message : String(e));
          setStatus("");
        }
      }
    })();

    return () => {
      disposed = true;
      try {
        for (const id of [TG_MPR, TG_MIP]) {
          if (ToolGroupManager.getToolGroup(id)) ToolGroupManager.destroyToolGroup(id);
        }
        engineRef.current?.destroy();
      } catch {
        /* 정리 중 오류 무시 */
      }
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studyUid, selSeries]);

  useEffect(() => () => { resizeObserverRef.current?.disconnect(); }, []);

  // Shift(=ROI 그리기) 홀드 중엔 크로스헤어를 Enabled(표시만)로 강등 — 라인이 끌리지 않고 ROI 만 동작.
  // (Passive 는 기존 주석 드래그가 가능해 라인이 함께 움직이는 원인 — Enabled 는 렌더만 하고 조작 차단)
  useEffect(() => {
    const setCross = (interactive: boolean) => {
      const g = ToolGroupManager.getToolGroup(TG_MPR);
      if (!g || !modesRef.current.crosshair) return;
      try {
        if (interactive) {
          g.setToolActive(CrosshairsTool.toolName, {
            bindings: [{ mouseButton: ToolsEnums.MouseBindings.Primary }],
          });
        } else {
          g.setToolEnabled(CrosshairsTool.toolName);
        }
        engineRef.current?.render();
      } catch { /* 그룹 미준비 */ }
    };
    const down = (e: KeyboardEvent) => {
      if (e.key === "Shift" && modesRef.current.roi && modesRef.current.crosshair) setCross(false);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Shift" && modesRef.current.crosshair) setCross(true);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  // 두께(슬랩) 핸들 색 구분 — 회전 핸들(원형)은 참조선 색 유지, 두께 핸들(작은 정사각형)은 주황 고정.
  // CrosshairsTool 이 두 핸들을 같은 색으로 그리므로(설정 미지원) SVG 후처리로 재채색:
  // 두께 핸들만 rect(정사각·소형) 이라 폭=높이≤16px 휴리스틱으로 안전 선별(ROI 핸들은 원형이라 무영향).
  useEffect(() => {
    const SLAB_COLOR = "#f97316";
    const recolor = () => {
      const grid = gridRef.current;
      if (!grid) return;
      grid.querySelectorAll("svg rect").forEach((el) => {
        const w = parseFloat(el.getAttribute("width") ?? "0");
        const h = parseFloat(el.getAttribute("height") ?? "0");
        if (w > 0 && Math.abs(w - h) < 0.5 && w <= 16 && el.getAttribute("stroke") !== SLAB_COLOR) {
          el.setAttribute("stroke", SLAB_COLOR);
          el.setAttribute("fill", SLAB_COLOR);
          el.setAttribute("fill-opacity", "0.9");
        }
      });
    };
    const evName = (ToolsEnums.Events as unknown as { ANNOTATION_RENDERED?: string }).ANNOTATION_RENDERED;
    if (evName) eventTarget.addEventListener(evName, recolor);
    const iv = window.setInterval(recolor, 400);   // 렌더 이벤트 미발화 대비 보조 폴링
    return () => {
      if (evName) eventTarget.removeEventListener(evName, recolor);
      window.clearInterval(iv);
    };
  }, []);

  // Esc — MIP 1×1 확대 해제(1×3 복귀)
  useEffect(() => {
    if (!mipMax) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMipMax(null);
        window.setTimeout(() => { engineRef.current?.resize(true, true); engineRef.current?.render(); }, 50);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mipMax]);

  // ROI 크롭 — 사각 ROI 의 월드 경계를 VR 볼륨 클리핑 평면으로 적용(그 영역만 3D 렌더링)
  const applyCrop = useCallback(() => {
    const engine = engineRef.current;
    const c = cropRef.current;
    if (!engine || !c) return;
    try {
      const vp = engine.getViewport("vp-vr") as Types.IVolumeViewport | undefined;
      const actorEntry = vp?.getDefaultActor();
      if (!vp || !actorEntry) return;
      const mapper = (actorEntry.actor as unknown as { getMapper: () => {
        removeAllClippingPlanes: () => void; addClippingPlane: (p: unknown) => void } }).getMapper();
      mapper.removeAllClippingPlanes();
      for (let i = 0; i < 3; i++) {
        if (c.maxs[i] - c.mins[i] < 0.5) continue;   // 평면 축(두께 0) — 클리핑 생략
        const nMin = [0, 0, 0]; nMin[i] = 1;
        const oMin = [...c.mins];
        mapper.addClippingPlane(vtkPlane.newInstance({ normal: nMin as [number, number, number], origin: oMin as [number, number, number] }));
        const nMax = [0, 0, 0]; nMax[i] = -1;
        const oMax = [...c.maxs];
        mapper.addClippingPlane(vtkPlane.newInstance({ normal: nMax as [number, number, number], origin: oMax as [number, number, number] }));
      }
      vp.render();
      setCropOn(true);
    } catch { /* VR 미준비 — vrOn 효과에서 재시도 */ }
  }, []);
  // ── 채우기(영역 성장) 분할 — 클릭 지점과 같은 농도(±6%) 연결 영역을 라벨맵에 기록 ──
  const fillColorRef = useRef("#22d3ee");
  fillColorRef.current = fillColor;
  const hexRgb = (hex: string): [number, number, number] => {
    const n = parseInt(hex.replace("#", ""), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  };
  const segTf = useCallback((volumeActor: unknown) => {
    // 세그 볼륨 전달함수 — 0=투명, 1=선택 색(반투명). MPR·3D 공통
    const [r, g, b] = hexRgb(fillColorRef.current);
    const prop = (volumeActor as { getProperty: () => {
      getRGBTransferFunction: (i: number) => { removeAllPoints: () => void; addRGBPoint: (x: number, r: number, g: number, b: number) => void };
      getScalarOpacity: (i: number) => { removeAllPoints: () => void; addPoint: (x: number, y: number) => void };
      setInterpolationTypeToNearest?: () => void;
    } }).getProperty();
    const ctf = prop.getRGBTransferFunction(0);
    ctf.removeAllPoints();
    ctf.addRGBPoint(0, 0, 0, 0);
    ctf.addRGBPoint(1, r, g, b);
    const otf = prop.getScalarOpacity(0);
    otf.removeAllPoints();
    otf.addPoint(0, 0);
    otf.addPoint(0.5, 0);
    otf.addPoint(1, 0.6);
    prop.setInterpolationTypeToNearest?.();
  }, []);
  const ensureSegOn = useCallback(async (vpIds: string[]) => {
    const engine = engineRef.current;
    if (!engine || !segIdRef.current) return;
    for (const id of vpIds) {
      if (segVpsRef.current.has(id)) continue;
      try {
        const vp = engine.getViewport(id) as unknown as {
          addVolumes: (v: { volumeId: string; callback: (a: { volumeActor: unknown }) => void }[]) => Promise<void> };
        await vp.addVolumes([{ volumeId: segIdRef.current, callback: ({ volumeActor }) => segTf(volumeActor) }]);
        segVpsRef.current.add(id);
      } catch { /* 뷰포트 미준비 */ }
    }
    engine.render();
  }, [segTf]);
  const regionGrow = useCallback(async (world: number[]) => {
    const engine = engineRef.current;
    if (!engine || !volumeIdRef.current) return;
    try {
      const vol = cache.getVolume(volumeIdRef.current) as unknown as {
        imageData: { worldToIndex: (p: number[]) => number[]; getDimensions: () => number[];
                     getPointData: () => { getScalars: () => { getRange: () => number[] } } };
        getScalarData?: () => Float32Array | Int16Array | Uint16Array | Uint8Array;
        voxelManager?: { getCompleteScalarDataArray?: () => Float32Array | Int16Array | Uint16Array | Uint8Array };
      };
      const data = vol.getScalarData?.() ?? vol.voxelManager?.getCompleteScalarDataArray?.();
      if (!data) { setStatus("이 볼륨에선 채우기를 지원하지 못했습니다"); return; }
      const dim = vol.imageData.getDimensions();
      const seed = vol.imageData.worldToIndex(world).map((v) => Math.round(v));
      if (seed.some((v, i) => v < 0 || v >= dim[i])) return;
      if (!segIdRef.current) {   // 라벨맵(파생 볼륨) — 최초 1회 생성
        segIdRef.current = "sv-seg-" + volumeIdRef.current.slice(-24);
        await (volumeLoader as unknown as {
          createAndCacheDerivedLabelmapVolume: (ref: string, o: { volumeId: string }) => Promise<unknown> })
          .createAndCacheDerivedLabelmapVolume(volumeIdRef.current, { volumeId: segIdRef.current });
      }
      const seg = cache.getVolume(segIdRef.current) as unknown as {
        imageData?: { modified: () => void };
        getScalarData?: () => Uint8Array | Float32Array;
        voxelManager?: { getCompleteScalarDataArray?: () => Uint8Array | Float32Array };
      };
      const segData = seg.getScalarData?.() ?? seg.voxelManager?.getCompleteScalarDataArray?.();
      if (!segData) return;
      // BFS 영역 성장 — 6-연결, 허용오차 = 전체 범위의 6%, 최대 1,000만 복셀
      const range = vol.imageData.getPointData().getScalars().getRange();
      const tol = (range[1] - range[0]) * 0.06;
      const sx = dim[0], sxy = dim[0] * dim[1];
      const seedO = seed[2] * sxy + seed[1] * sx + seed[0];
      const seedVal = data[seedO];
      const q = new Uint32Array(2_000_000);
      let qh = 0, qt = 0, painted = 0;
      q[qt++] = seedO;
      segData[seedO] = 1;
      while (qh < qt && painted < 10_000_000) {
        const o = q[qh++]; painted++;
        const z = Math.floor(o / sxy), rem = o % sxy, y = Math.floor(rem / sx), x = rem % sx;
        const nbrs = [
          x > 0 ? o - 1 : -1, x < sx - 1 ? o + 1 : -1,
          y > 0 ? o - sx : -1, y < dim[1] - 1 ? o + sx : -1,
          z > 0 ? o - sxy : -1, z < dim[2] - 1 ? o + sxy : -1,
        ];
        for (const n of nbrs) {
          if (n < 0 || segData[n] === 1) continue;
          if (Math.abs(data[n] - seedVal) <= tol) {
            segData[n] = 1;
            if (qt < q.length) q[qt++] = n;
          }
        }
      }
      seg.imageData?.modified();
      setFillOn(true);
      setVrOn(true);   // 분할 결과를 컬러로 3D 렌더링
      // 분할 색을 Axial/Sagittal/Coronal(MPR)과 MIP 3면 모두에 표시 — 위치가 전 평면에서 보임
      await ensureSegOn([...MPR_VIEWPORTS.map((v) => v.id), ...MIP_VPS.map((mv) => mv.id)]);
      window.setTimeout(() => { void ensureSegOn(["vp-vr"]); }, 400);   // VR 준비 후 세그 추가
      engine.render();
      setStatus("채우기 완료 — " + painted.toLocaleString() + " 복셀 분할(색 표시 + 3D 컬러 렌더링)");
    } catch (e) { setStatus(e instanceof Error ? e.message : "채우기 실패"); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ensureSegOn]);
  const clearFill = useCallback(() => {
    try {
      const seg = cache.getVolume(segIdRef.current) as unknown as {
        imageData?: { modified: () => void };
        getScalarData?: () => Uint8Array | Float32Array;
        voxelManager?: { getCompleteScalarDataArray?: () => Uint8Array | Float32Array };
      } | undefined;
      const d = seg?.getScalarData?.() ?? seg?.voxelManager?.getCompleteScalarDataArray?.();
      d?.fill(0);
      seg?.imageData?.modified();
      engineRef.current?.render();
    } catch { /* 무시 */ }
    setFillOn(false);
  }, []);
  clearFillRef.current = clearFill;
  // 색 변경 — 이미 추가된 세그 액터의 전달함수 갱신
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !segIdRef.current) return;
    for (const id of segVpsRef.current) {
      try {
        const vp = engine.getViewport(id) as unknown as { getActors: () => { uid: string; actor: unknown }[] };
        const entry = vp.getActors().find((a) => a.uid === segIdRef.current);
        if (entry) segTf(entry.actor);
      } catch { /* 무시 */ }
    }
    engine.render();
  }, [fillColor, segTf]);

  // 좌측 썸네일 드롭 — 특정 MPR 페인만 다른 시리즈 볼륨으로 교체(개별 소스 지정)
  const loadVolumeToViewport = useCallback(async (uid: string, vpId: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    try {
      setStatus("페인 볼륨 로딩…");
      const ids = await buildImageIds(studyUid, uid);
      if (ids.length < 3) { setStatus("슬라이스가 부족해 볼륨을 만들 수 없습니다"); return; }
      const vid = `cornerstoneStreamingImageVolume:sv-${uid.slice(-24)}`;
      const vol = cache.getVolume(vid) ?? await volumeLoader.createAndCacheVolume(vid, { imageIds: ids });
      await (vol as { load?: () => Promise<unknown> | unknown }).load?.();
      await setVolumesForViewports(engine, [{ volumeId: vid }], [vpId]);
      engine.getViewport(vpId)?.render();
      setStatus(`${vpId.replace("vp-", "").toUpperCase()} 페인 볼륨 교체 완료`);
    } catch (e) { setStatus(e instanceof Error ? e.message : "페인 볼륨 교체 실패"); }
  }, [studyUid]);

  // 제거 모드 — ROI 박스 복셀을 최소값으로 마스킹(백업 후), MPR 에도 반영(공유 볼륨)
  const maskVoxels = useCallback((mins: number[], maxs: number[]) => {
    try {
      const vol = cache.getVolume(volumeIdRef.current) as unknown as {
        imageData?: { worldToIndex: (p: number[]) => number[]; getDimensions: () => number[];
                      getPointData: () => { getScalars: () => { getRange: () => number[] } }; modified: () => void };
        getScalarData?: () => Float32Array | Int16Array | Uint16Array | Uint8Array;
        voxelManager?: { getCompleteScalarDataArray?: () => Float32Array | Int16Array | Uint16Array | Uint8Array };
      } | undefined;
      const img = vol?.imageData;
      const data = vol?.getScalarData?.() ?? vol?.voxelManager?.getCompleteScalarDataArray?.();
      if (!img || !data) return false;
      const dim = img.getDimensions();
      const lo = img.worldToIndex(mins).map((v) => Math.floor(v));
      const hi = img.worldToIndex(maxs).map((v) => Math.ceil(v));
      const a = [0, 1, 2].map((i) => Math.max(0, Math.min(lo[i], hi[i])));
      const b = [0, 1, 2].map((i) => Math.min(dim[i] - 1, Math.max(lo[i], hi[i])));
      const count = (b[0] - a[0] + 1) * (b[1] - a[1] + 1) * (b[2] - a[2] + 1);
      if (count <= 0 || count > 40_000_000) return false;   // 과대 영역 방어
      const minVal = img.getPointData().getScalars().getRange()[0];
      const idx = new Uint32Array(count);
      const vals = new Float32Array(count);   // 백업 — 16비트 정수도 float32 로 무손실
      let k = 0;
      for (let z = a[2]; z <= b[2]; z++) {
        for (let y = a[1]; y <= b[1]; y++) {
          const base = z * dim[0] * dim[1] + y * dim[0];
          for (let x = a[0]; x <= b[0]; x++) {
            const o = base + x;
            idx[k] = o; vals[k] = data[o]; data[o] = minVal; k++;
          }
        }
      }
      voxBackupRef.current = { vals, idx };
      img.modified();
      engineRef.current?.render();
      return true;
    } catch { return false; }
  }, []);
  const restoreVoxels = useCallback(() => {
    const bk = voxBackupRef.current;
    if (!bk) return;
    try {
      const vol = cache.getVolume(volumeIdRef.current) as unknown as {
        imageData?: { modified: () => void };
        getScalarData?: () => Float32Array | Int16Array | Uint16Array | Uint8Array;
        voxelManager?: { getCompleteScalarDataArray?: () => Float32Array | Int16Array | Uint16Array | Uint8Array };
      } | undefined;
      const data = vol?.getScalarData?.() ?? vol?.voxelManager?.getCompleteScalarDataArray?.();
      if (!data) return;
      for (let k = 0; k < bk.idx.length; k++) data[bk.idx[k]] = bk.vals[k];
      vol?.imageData?.modified();
      engineRef.current?.render();
    } catch { /* 무시 */ } finally { voxBackupRef.current = null; }
  }, []);
  // ROI 전체 정리 — 주석(측정값 라벨) 삭제 + 크롭 해제 + 제거 복원 (ROI Off 시 다른 툴처럼 사라짐)
  const clearRoiAll = useCallback(() => {
    try {
      for (const an of csAnnotation.state.getAllAnnotations()) {
        if (ROI_TOOLS.includes(an.metadata?.toolName ?? "") && an.annotationUID) {
          csAnnotation.state.removeAnnotation(an.annotationUID);
        }
      }
    } catch { /* 무시 */ }
    restoreVoxels();
    clearCropRef.current?.();
    engineRef.current?.render();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreVoxels]);
  const clearCropRef = useRef<(() => void) | null>(null);
  clearRoiAllRef.current = clearRoiAll;

  const clearCrop = useCallback(() => {
    cropRef.current = null;
    setCropOn(false);
    try {
      const vp = engineRef.current?.getViewport("vp-vr") as Types.IVolumeViewport | undefined;
      const actorEntry = vp?.getDefaultActor();
      const mapper = (actorEntry?.actor as unknown as { getMapper: () => { removeAllClippingPlanes: () => void } } | undefined)?.getMapper();
      mapper?.removeAllClippingPlanes();
      vp?.render();
    } catch { /* 무시 */ }
  }, []);
  clearCropRef.current = clearCrop;
  useEffect(() => {
    const onDone = (evt: Event) => {
      const anno = (evt as CustomEvent).detail?.annotation as
        { metadata?: { toolName?: string };
          data?: { handles?: { points?: number[][] }; contour?: { polyline?: number[][] }; polyline?: number[][] } } | undefined;
      if (!ROI_TOOLS.includes(anno?.metadata?.toolName ?? "")) return;
      const pts = anno?.data?.handles?.points?.length ? anno.data.handles.points
        : (anno?.data?.contour?.polyline ?? anno?.data?.polyline);
      if (!pts || pts.length < 3) return;
      const mins = [0, 1, 2].map((i) => Math.min(...pts.map((p) => p[i])));
      const maxs = [0, 1, 2].map((i) => Math.max(...pts.map((p) => p[i])));
      cropRef.current = { mins, maxs };
      setVrOn(true);        // 영역 선택 → 3D 렌더링 페인 자동 표시
      if (roiEffectRef.current === "remove") {
        // 제거(Saturation) — ROI 복셀을 마스킹하고 나머지만 렌더링
        restoreVoxels();   // 이전 제거 영역 복원 후 새 영역 적용
        const ok = maskVoxels(mins, maxs);
        setStatus(ok ? "ROI 제거 렌더링 — 선택 영역을 제외한 볼륨 표시(ROI Off 로 복원)"
                     : "이 볼륨에선 제거 모드를 적용하지 못했습니다");
        if (ok) setCropOn(true);
      } else {
        setStatus("ROI Focus 렌더링 — 선택 영역만 볼륨 표시(ROI Off 로 복원)");
        window.setTimeout(applyCrop, 300);   // VR 이 이미 켜져 있으면 즉시, 새로 켜지면 vrOn 효과 후 재적용
      }
    };
    eventTarget.addEventListener(ToolsEnums.Events.ANNOTATION_COMPLETED, onDone);
    return () => eventTarget.removeEventListener(ToolsEnums.Events.ANNOTATION_COMPLETED, onDone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyCrop, maskVoxels, restoreVoxels]);
  const roiEffectRef = useRef(roiEffect);
  roiEffectRef.current = roiEffect;

  // ── 크로스헤어 두께/위치 → 3D VR 실시간 반영. 드래그 중 저해상도(샘플거리 4배) → 놓으면 원복 ──
  const vrBaseSampleRef = useRef(0);
  const vrMapper = useCallback(() => {
    try {
      const vp = engineRef.current?.getViewport("vp-vr") as Types.IVolumeViewport | undefined;
      const entry = vp?.getDefaultActor();
      return entry ? (entry.actor as unknown as { getMapper: () => {
        getSampleDistance: () => number; setSampleDistance: (d: number) => void;
        removeAllClippingPlanes: () => void; addClippingPlane: (pl: unknown) => void } }).getMapper() : null;
    } catch { return null; }
  }, []);
  const vrLowRes = useCallback((on: boolean) => {
    const m = vrMapper();
    if (!m) return;
    try {
      if (!vrBaseSampleRef.current) vrBaseSampleRef.current = m.getSampleDistance();
      m.setSampleDistance(vrBaseSampleRef.current * (on ? 4 : 1));   // 이동 중 해상도↓ → 부드러운 회전/갱신
    } catch { /* 무시 */ }
  }, [vrMapper]);
  const applyLiveSlab = useCallback(() => {
    // MPR 각 면의 슬랩(두께>2mm)·중심 위치를 VR 클리핑 평면으로 — 실시간 부분 볼륨 렌더링
    const engine = engineRef.current;
    if (!engine || cropRef.current) return;   // ROI 크롭 우선
    const m = vrMapper();
    if (!m) return;
    try {
      const planes: { normal: number[]; origin: number[] }[] = [];
      for (const v of MPR_VIEWPORTS) {
        const vp = engine.getViewport(v.id) as Types.IVolumeViewport | undefined;
        const t = vp?.getProperties?.()?.slabThickness;
        if (!vp || !t || t <= 2) continue;
        const cam = vp.getCamera();
        const n = cam.viewPlaneNormal ?? [0, 0, 1];
        const fp = cam.focalPoint ?? [0, 0, 0];
        planes.push({ normal: [...n], origin: fp.map((x, i) => x - n[i] * t / 2) });
        planes.push({ normal: n.map((x) => -x), origin: fp.map((x, i) => x + n[i] * t / 2) });
      }
      m.removeAllClippingPlanes();
      for (const pl of planes) {
        m.addClippingPlane(vtkPlane.newInstance({ normal: pl.normal as [number, number, number],
                                                  origin: pl.origin as [number, number, number] }));
      }
      engine.getViewport("vp-vr")?.render();
    } catch { /* VR 미준비 */ }
  }, [vrMapper]);
  useEffect(() => {
    const el = gridRef.current;
    if (!el || !vrOn) return;
    let dragging = false, raf = 0;
    const down = () => { dragging = true; vrLowRes(true); };
    const move = () => {
      if (!dragging || raf) return;
      raf = requestAnimationFrame(() => { raf = 0; applyLiveSlab(); });
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      vrLowRes(false);        // 멈추면 해상도 원복
      applyLiveSlab();
      engineRef.current?.getViewport("vp-vr")?.render();
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [vrOn, applyLiveSlab, vrLowRes]);

  // (변경) 슬랩 폭 조정만으로 3D 페인을 자동 추가하지 않음 — [🧊 3D 렌더링] 버튼으로만 표시

  // 3D 볼륨 렌더링(VR) 페인 — vrOn 시 동적 enable, 모달리티별 프리셋(CT=Bone, 그 외 MR 기본)
  useEffect(() => {
    const engine = engineRef.current;
    if (!vrOn || !engine || !volumeIdRef.current) return;
    const elVr = containerRefs.current["vp-vr"];
    if (!elVr) return;
    let dead = false;
    (async () => {
      try {
        engine.enableElement({
          viewportId: "vp-vr",
          type: Enums.ViewportType.VOLUME_3D,
          element: elVr,
          defaultOptions: { background: [0.04, 0.04, 0.055] as Types.Point3 },
        });
        await setVolumesForViewports(engine, [{ volumeId: volumeIdRef.current }], ["vp-vr"]);
        if (dead) return;
        const vp = engine.getViewport("vp-vr") as Types.IVolumeViewport;
        const mod = seriesList.find((x) => x.uid === selSeries)?.modality ?? "";
        try { (vp as unknown as { setProperties: (p: { preset: string }) => void })
          .setProperties({ preset: mod === "CT" ? "CT-Bone" : "MR-Default" }); } catch { /* 프리셋 미지원 */ }
        // ── VR 조작: 좌드래그 = 입체 회전(Trackball) · 우 = Zoom · 중 = Pan ──
        if (ToolGroupManager.getToolGroup("sv-tools-vr")) ToolGroupManager.destroyToolGroup("sv-tools-vr");
        const vr = ToolGroupManager.createToolGroup("sv-tools-vr")!;
        vr.addTool(TrackballRotateTool.toolName);
        vr.addTool(ZoomTool.toolName);
        vr.addTool(PanTool.toolName);
        vr.setToolActive(TrackballRotateTool.toolName, { bindings: [{ mouseButton: ToolsEnums.MouseBindings.Primary }] });
        vr.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: ToolsEnums.MouseBindings.Secondary }] });
        vr.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: ToolsEnums.MouseBindings.Auxiliary }] });
        vr.addViewport("vp-vr", RENDERING_ENGINE_ID);
        // 좌하단 좌표 — 회전각(방위/고도)·카메라 위치, 회전 중 실시간 갱신
        const onCam = () => {
          try {
            const cam = vp.getCamera();
            const n = cam.viewPlaneNormal ?? [0, 0, 1];
            const az = Math.round(Math.atan2(n[0], n[2]) * 180 / Math.PI);
            const el = Math.round(Math.asin(Math.max(-1, Math.min(1, n[1]))) * 180 / Math.PI);
            const pos = (cam.position ?? [0, 0, 0]).map((x) => Math.round(x));
            setVrCam(`회전 ${az}° / ${el}° · 카메라 (${pos[0]}, ${pos[1]}, ${pos[2]})`);
          } catch { /* 무시 */ }
        };
        elVr.addEventListener(Enums.Events.CAMERA_MODIFIED, onCam);
        onCam();
        if (cropRef.current) window.setTimeout(applyCrop, 200);   // ROI 크롭 재적용(볼륨 준비 후)
        vp.render();
        engine.resize(true, true);
        engine.render();
      } catch { /* VR 미지원 환경 — 페인만 비움 */ }
    })();
    return () => {
      dead = true;
      try {
        if (ToolGroupManager.getToolGroup("sv-tools-vr")) ToolGroupManager.destroyToolGroup("sv-tools-vr");
        engine.disableElement("vp-vr");
      } catch { /* 무시 */ }
      setVrCam("");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vrOn, selSeries]);

  const VIEWPORTS = [...MPR_VIEWPORTS.map((v) => ({ ...v, mip: false })),
                     ...(vrOn ? [{ id: "vp-vr", label: "3D (Volume Rendering)", mip: true }] : [])];

  return (
    <div style={{
      ...(embedded
        ? { position: "relative" as const, width: "100%", height: "100%", minHeight: 0 }
        : { position: "fixed" as const, inset: 0, zIndex: 200 }),
      background: "var(--bg-canvas)",
      display: "flex", flexDirection: "column",
    }}>
      {/* 헤더 */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10, padding: "6px 12px",
        background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", flexWrap: "wrap",
      }}>
        <img src="/saintview-viewer.svg" alt="" width={20} height={20} />
        <b>Saintview 3D</b>
        {/* 시리즈 선택 — 자동 선택이 부적합한 검사(보정/스카웃) 대비 */}
        <select value={selSeries} onChange={(e) => setSelSeries(e.target.value)}
                title="볼륨을 구성할 시리즈" style={{ fontSize: 12, maxWidth: 260 }}>
          {seriesList.map((s) => (
            <option key={s.uid} value={s.uid}>
              {s.modality} · {s.count}장 · {s.desc || "(무제)"}
            </option>
          ))}
        </select>
        {/* 도구 모드 — Crosshair(십자선 연동) / W/L */}
        <span style={{ display: "flex", gap: 2 }}>
          <button onClick={() => toggleMode("crosshair")}
                  title="십자선 토글 — 다른 기능과 동시 사용(Mix). ON 이면 무수정자 좌클릭 우선"
                  style={{ fontSize: 11.5, padding: "2px 10px",
                           background: modes.crosshair ? "var(--accent)" : undefined,
                           color: modes.crosshair ? "#fff" : undefined }}>✛ Crosshair</button>
          <button onClick={() => toggleMode("roi")}
                  title="ROI 토글 — Crosshair 와 동시 사용 시 Shift+드래그로 그리기. Off 시 측정값·효과 삭제"
                  style={{ fontSize: 11.5, padding: "2px 10px",
                           background: modes.roi ? "var(--accent)" : undefined,
                           color: modes.roi ? "#fff" : undefined }}>▭ ROI{cropOn ? " ●" : ""}</button>
          {modes.roi && (
            <>
              <select value={roiShape} title="ROI 모양"
                      style={{ fontSize: 11.5 }}
                      onChange={(e) => {
                        const v = e.target.value as "rect" | "oval" | "free";
                        setRoiShape(v); applyMix(undefined, v);
                      }}>
                <option value="oval">Oval ROI</option>
                <option value="rect">Rectangle ROI</option>
                <option value="free">Free ROI</option>
              </select>
              <select value={roiEffect} title="Focus=선택 영역만 렌더링 · 제거=선택 영역을 빼고 렌더링"
                      style={{ fontSize: 11.5 }}
                      onChange={(e) => setRoiEffect(e.target.value as "focus" | "remove")}>
                <option value="focus">Focus (영역만)</option>
                <option value="remove">제거 (영역 빼고)</option>
              </select>
            </>
          )}
          <button onClick={() => toggleMode("wl")}
                  title="W/L 토글 — 다른 기능과 동시 사용 시 Ctrl+드래그"
                  style={{ fontSize: 11.5, padding: "2px 10px",
                           background: modes.wl ? "var(--accent)" : undefined,
                           color: modes.wl ? "#fff" : undefined }}>◐ W/L</button>
          <button onClick={() => toggleMode("fill")}
                  title="채우기(영역 성장) — MPR 에서 클릭한 지점과 같은 농도의 연결 영역(예: 척수강 뇌척수액)을 색으로 채우고 3D 컬러 렌더링. 다시 누르면 Off(삭제)"
                  style={{ fontSize: 11.5, padding: "2px 10px",
                           background: modes.fill ? "var(--accent)" : undefined,
                           color: modes.fill ? "#fff" : undefined }}>🪄 채우기{fillOn ? " ●" : ""}</button>
          {modes.fill && (
            <input type="color" value={fillColor} title="분할 표시/3D 렌더링 색 선택"
                   onChange={(e) => setFillColor(e.target.value)}
                   style={{ width: 30, height: 24, padding: 0, border: "1px solid var(--border)",
                            borderRadius: 4, background: "transparent", cursor: "pointer" }} />
          )}
        </span>
        {status && <span style={{ color: "var(--stat-draft)", fontSize: 12 }}>{status}</span>}
        {error && <span style={{ color: "var(--stat-emergency)", fontSize: 12 }}>⚠ {error}</span>}
        <div style={{ flex: 1 }} />
        <button onClick={() => setVrOn((v) => !v)}
                title="3D 볼륨 렌더링 페인 추가/제거 — MPR 참조선의 점선 핸들로 슬랩 폭을 조정해도 자동 추가됩니다"
                style={{ fontSize: 11.5, padding: "2px 10px",
                         background: vrOn ? "var(--accent)" : undefined, color: vrOn ? "#fff" : undefined }}>🧊 3D 렌더링</button>
        <div style={{ position: "relative" }}>
          <button onClick={() => setMipSetOpen((o) => !o)}
                  title="MIP Settings — 강도 투영 모드(MIP/MinIP/AvIP/끄기)·슬랩 두께"
                  style={{ fontSize: 11.5, padding: "2px 10px",
                           background: mipSetOpen ? "var(--bg-elevated)" : undefined }}>
            ⚙ MIP 설정 <span style={{ color: "var(--ai)" }}>
              {blend === "off" ? "끄기" : blend.toUpperCase()}{blend !== "off" ? ` | ${slabMm}mm` : ""}</span>
          </button>
          {mipSetOpen && (
            <div style={{ position: "absolute", top: "110%", right: 0, zIndex: 400, width: 280,
                          background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8,
                          boxShadow: "0 10px 30px rgba(0,0,0,0.55)", padding: 12, fontSize: 12 }}>
              <b style={{ fontSize: 13 }}>MIP Settings</b>
              <div style={{ color: "var(--text-secondary)", fontSize: 11, marginBottom: 8 }}>강도 투영 설정</div>
              <div style={{ color: "var(--text-secondary)", fontSize: 10.5, letterSpacing: 1, margin: "6px 0 4px" }}>BLEND MODE</div>
              {([["mip", "MIP", "최대 강도 투영 - 혈관, 석회화 강조"],
                 ["minip", "MinIP", "최소 강도 투영 - 기도, 폐 강조"],
                 ["avip", "AvIP", "평균 강도 투영 - 노이즈 감소"],
                 ["off", "끄기", "일반 렌더링"]] as const).map(([k, label, desc]) => (
                <div key={k} onClick={() => { setBlend(k); applySlab(slabMm, k); }}
                     style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                              padding: "7px 10px", borderRadius: 6, cursor: "pointer", marginBottom: 2,
                              background: blend === k ? "var(--bg-elevated)" : "transparent" }}>
                  <span>
                    <div style={{ fontWeight: 700 }}>{label}</div>
                    <div style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>{desc}</div>
                  </span>
                  {blend === k && <span style={{ color: "var(--accent)", fontWeight: 800 }}>✓</span>}
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                            margin: "10px 0 2px" }}>
                <span style={{ color: "var(--text-secondary)", fontSize: 10.5, letterSpacing: 1 }}>SLAB THICKNESS</span>
                <b style={{ color: "var(--ai)" }}>{slabMm}MM</b>
              </div>
              <input type="range" min={1} max={100} step={1} value={slabMm} disabled={blend === "off"}
                     style={{ width: "100%" }}
                     onChange={(e) => { const v = Number(e.target.value); setSlabMm(v); applySlab(v, blend); }} />
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-secondary)" }}>
                <span>1mm</span><span>100mm</span>
              </div>
              <div style={{ display: "flex", gap: 4, margin: "8px 0" }}>
                {[5, 10, 20, 30, 50].map((v) => (
                  <button key={v} disabled={blend === "off"}
                          onClick={() => { setSlabMm(v); applySlab(v, blend); }}
                          style={{ flex: 1, fontSize: 11, padding: "3px 0",
                                   border: slabMm === v ? "1px solid var(--accent)" : undefined,
                                   color: slabMm === v ? "var(--accent)" : undefined }}>{v}mm</button>
                ))}
              </div>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11.5 }}>
                커스텀:
                <input type="number" min={1} max={200} value={slabMm} disabled={blend === "off"}
                       style={{ width: 64 }}
                       onChange={(e) => {
                         const v = Math.min(200, Math.max(1, Number(e.target.value) || 1));
                         setSlabMm(v); applySlab(v, blend);
                       }} /> mm
              </label>
              <div style={{ marginTop: 8, paddingTop: 6, borderTop: "1px solid var(--border)",
                            color: "var(--accent)", fontWeight: 700, fontSize: 11.5 }}>
                {blend === "off" ? "일반 렌더링" : `${blend === "mip" ? "MIP" : blend === "minip" ? "MinIP" : "AvIP"} | ${slabMm}mm`}
              </div>
            </div>
          )}
        </div>
        <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>
          좌={modes.crosshair ? "십자선" : modes.roi ? "ROI" : modes.wl ? "W/L" : "-"}
          {modes.roi && modes.crosshair ? " · Shift+좌=ROI" : ""}
          {modes.wl && (modes.crosshair || modes.roi) ? " · Ctrl+좌=W/L" : ""}
          {modes.fill ? " · Alt+클릭=채우기" : ""} · 우=Zoom · 휠=스크롤 · 중=Pan
        </span>
        <button onClick={onClose}>닫기</button>
      </div>

      {/* 2×2 뷰포트 그리드 */}
      <div ref={gridRef} style={{
        flex: 1, display: "grid", gridTemplateColumns: vrOn ? "1fr 1fr 1fr" : "1fr 1fr", gridTemplateRows: "1fr 1fr",
        gap: 2, padding: 2, minHeight: 0,
      }}>
        {VIEWPORTS.map((v) => (
          <div
            key={v.id}
            onMouseDown={(e) => {
              setActiveVp(v.id);
              // 채우기 모드 — 클릭 지점(캔버스 좌표→월드)에서 같은 농도 영역 성장
              if (modes.fill && !v.mip && e.button === 0 &&
                  (e.altKey || (!modes.crosshair && !modes.roi && !modes.wl))) {
                try {
                  const vp = engineRef.current?.getViewport(v.id) as Types.IVolumeViewport | undefined;
                  const canvas = (e.currentTarget as HTMLElement).querySelector("canvas");
                  if (vp && canvas) {
                    const r = canvas.getBoundingClientRect();
                    const world = vp.canvasToWorld([e.clientX - r.left, e.clientY - r.top]);
                    void regionGrow(world as unknown as number[]);
                  }
                } catch { /* 미준비 */ }
              }
            }}
            onDragOver={(e) => { if (!v.mip) e.preventDefault(); }}
            onDrop={(e) => {
              // 좌측 썸네일 드래그 → 이 MPR 페인만 해당 시리즈 볼륨으로 교체(AX/SAG/COR 소스 개별 지정)
              if (v.mip) return;
              e.preventDefault();
              const uid = e.dataTransfer.getData("application/x-sv-series");
              if (uid) void loadVolumeToViewport(uid, v.id);
            }}
            style={{
              position: "relative", minHeight: 0,
              outline: activeVp === v.id ? "1px solid var(--accent)" : "1px solid var(--border)",
            }}
          >
            <div style={{
              position: "absolute", top: 4, left: 6, zIndex: 1, fontSize: 11,
              color: v.mip ? "var(--ai)" : (REF_COLORS[v.id] ?? "var(--text-secondary)"),
              pointerEvents: "none", textShadow: "0 0 4px #000",
            }}>
              {v.label}
            </div>
            <div
              ref={(el) => { containerRefs.current[v.id] = el; }}
              style={{ width: "100%", height: "100%" }}
              onContextMenu={(e) => e.preventDefault()}
            />
            {/* 3D(VR) 좌하단 좌표 — 좌드래그 회전 시 실시간 회전각·카메라 위치 */}
            {v.id === "vp-vr" && vrCam && (
              <div style={{ position: "absolute", bottom: 4, left: 6, zIndex: 1, fontSize: 10.5,
                            color: "var(--text-secondary)", pointerEvents: "none", textShadow: "0 0 4px #000" }}>
                {vrCam}{cropOn ? " · ROI 크롭" : ""}
              </div>
            )}
          </div>
        ))}
        {/* MIP 1×3 — Axial/Sagittal/Coronal 모두 표시. 더블클릭=1×1 확대, Esc/재더블클릭=복귀 */}
        <div style={{ position: "relative", minHeight: 0, display: "grid", gap: 2,
                      gridTemplateColumns: mipMax ? "1fr" : "1fr 1fr 1fr",
                      outline: "1px solid var(--border)" }}>
          {MIP_VPS.map((mv) => (
            <div key={mv.id}
                 onDoubleClick={() => {
                   setMipMax((cur) => (cur === mv.id ? null : mv.id));
                   window.setTimeout(() => { engineRef.current?.resize(true, true); engineRef.current?.render(); }, 50);
                 }}
                 onMouseDown={(e) => {
                   // 채우기 ON — MIP 클릭 지점(슬랩 중심 평면의 월드 좌표)에서 같은 농도 영역 성장
                   if (modes.fill && e.button === 0) {
                     try {
                       const vp = engineRef.current?.getViewport(mv.id) as Types.IVolumeViewport | undefined;
                       const canvas = (e.currentTarget as HTMLElement).querySelector("canvas");
                       if (vp && canvas) {
                         const r = canvas.getBoundingClientRect();
                         const world = vp.canvasToWorld([e.clientX - r.left, e.clientY - r.top]);
                         void regionGrow(world as unknown as number[]);
                       }
                     } catch { /* 미준비 */ }
                   }
                 }}
                 style={{ position: "relative", minHeight: 0, minWidth: 0,
                          display: mipMax && mipMax !== mv.id ? "none" : "block",
                          outline: "1px solid var(--border)" }}
                 title="더블클릭 = 1×1 확대 / 다시 더블클릭·Esc = 1×3 복귀">
              <div style={{ position: "absolute", top: 4, left: 6, zIndex: 1, fontSize: 11,
                            color: "var(--ai)", pointerEvents: "none", textShadow: "0 0 4px #000" }}>
                {mv.label}{mipMax === mv.id ? " (확대)" : ""}
              </div>
              <div ref={(el) => { containerRefs.current[mv.id] = el; }}
                   style={{ width: "100%", height: "100%" }}
                   onContextMenu={(e) => e.preventDefault()} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
