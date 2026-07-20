"""GSPS(Grayscale Softcopy Presentation State) 생성 — 주석·W/L 표준 저장.

뷰어의 주석(정규화 0~1 좌표)과 현재 W/L을 GSPS 객체로 만들어 동일 Study에 귀속하면
타 PACS 뷰어에서도 같은 표시 상태를 재현할 수 있다(상호운용성).
좌표 단위는 DISPLAY(표시영역 비율 0~1) — 뷰어 정규화 좌표와 1:1.
"""
from __future__ import annotations

import io
from datetime import datetime, timezone

from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

GSPS_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.11.1"
LAYER = "SAINTVIEW"


def _ref_image(sop_uid: str, sop_class: str = "") -> Dataset:
    d = Dataset()
    d.ReferencedSOPClassUID = sop_class or "1.2.840.10008.5.1.4.1.1.1"  # CR 폴백
    d.ReferencedSOPInstanceUID = sop_uid
    return d


def _graphic(points: list[list[float]], gtype: str, *, closed: bool = False) -> Dataset:
    pts = list(points)
    if closed and pts and pts[0] != pts[-1]:
        pts.append(pts[0])
    g = Dataset()
    g.GraphicAnnotationUnits = "DISPLAY"
    g.GraphicDimensions = 2
    g.NumberOfGraphicPoints = len(pts)
    g.GraphicData = [float(v) for p in pts for v in p]
    g.GraphicType = gtype
    g.GraphicFilled = "N"
    return g


def _text(anchor: list[float], text: str) -> Dataset:
    t = Dataset()
    t.AnchorPointAnnotationUnits = "DISPLAY"
    t.UnformattedTextValue = text[:1024]
    t.AnchorPoint = [float(anchor[0]), float(anchor[1])]
    t.AnchorPointVisibility = "Y"
    return t


def _rect_points(p1: list[float], p2: list[float]) -> list[list[float]]:
    (x1, y1), (x2, y2) = p1, p2
    return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]


# 해부학 측정 4종(콥각/다리길이/골반/척추외곡) — text 에 이미 값 포함(복합 한국어 라벨)
_ANATOMY_KINDS = ("cobb", "leg", "pelvis", "spineCurve")


def annotation_to_graphics(anno: dict) -> tuple[list[Dataset], list[Dataset]]:
    """주석 1건 → (GraphicObject 목록, TextObject 목록)."""
    kind = anno.get("kind", "line")
    pts = anno.get("points") or []
    graphics: list[Dataset] = []
    texts: list[Dataset] = []
    label = anno.get("text", "")
    # 해부학 kind 는 text 가 이미 완성 라벨(값 포함) — value 재부착 시 중복 표기 방지
    if anno.get("value") is not None and not (kind in _ANATOMY_KINDS and label):
        label = f"{label} {anno['value']}{anno.get('unit', '')}".strip()
    if anno.get("source") == "ai":
        label = f"[AI] {label}".strip()

    if kind in ("length", "line", "arrow", "ctr") and len(pts) >= 2:
        graphics.append(_graphic(pts[:2], "POLYLINE"))
    elif kind == "angle" and len(pts) >= 3:
        graphics.append(_graphic(pts[:3], "POLYLINE"))
    elif kind == "rect" and len(pts) >= 2:
        graphics.append(_graphic(_rect_points(pts[0], pts[1]), "POLYLINE", closed=True))
    elif kind == "ellipse" and len(pts) >= 2:
        # GSPS ELLIPSE: 장축 양끝 2점 + 단축 양끝 2점
        (x1, y1), (x2, y2) = pts[0], pts[1]
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        graphics.append(_graphic([[x1, cy], [x2, cy], [cx, y1], [cx, y2]], "ELLIPSE"))
    elif kind in ("cobb", "leg") and len(pts) >= 4:
        # 콥각/다리길이 — 두 직선(p0-p1, p2-p3)을 각각 POLYLINE 으로
        graphics.append(_graphic(pts[0:2], "POLYLINE"))
        graphics.append(_graphic(pts[2:4], "POLYLINE"))
    elif kind == "pelvis" and len(pts) >= 2:
        # 골반 틀어짐 — 좌우 장골능 연결선
        graphics.append(_graphic(pts[:2], "POLYLINE"))
    elif kind == "spineCurve" and len(pts) >= 2:
        # 척추 외곡 — 경유 폴리라인 전체
        graphics.append(_graphic(pts, "POLYLINE"))
    elif kind == "text" and len(pts) >= 1:
        pass  # 텍스트만
    else:
        return [], []

    if label and pts:
        texts.append(_text(pts[0], label))
    return graphics, texts


def build_gsps_dataset(
    *,
    study,
    patient,
    images: list[dict],          # [{sop_uid, series_uid, rows, cols, sop_class?}]
    annotations: list[dict],     # 07 A.4 주석 dict (points 0~1)
    wc: float | None = None,
    ww: float | None = None,
    label: str = "SAINTVIEW",
    creator: str = "",
) -> Dataset:
    now = datetime.now(timezone.utc)

    fm = FileMetaDataset()
    fm.MediaStorageSOPClassUID = GSPS_SOP_CLASS
    fm.MediaStorageSOPInstanceUID = generate_uid()
    fm.TransferSyntaxUID = ExplicitVRLittleEndian

    ds = Dataset()
    ds.file_meta = fm
    ds.SpecificCharacterSet = "ISO_IR 192"
    ds.SOPClassUID = GSPS_SOP_CLASS
    ds.SOPInstanceUID = fm.MediaStorageSOPInstanceUID
    ds.Modality = "PR"
    ds.Manufacturer = "Saintview PACS AI"

    ds.PatientID = patient.patient_key if patient else ""
    ds.PatientName = patient.name_masked if patient else ""
    ds.PatientBirthDate = patient.birth_date if patient else ""
    ds.PatientSex = patient.sex if patient else ""
    ds.StudyInstanceUID = study.study_uid
    ds.AccessionNumber = study.accession_no or ""
    ds.StudyDate = study.study_date or ""
    ds.StudyTime = study.study_time or ""
    ds.StudyID = ""
    ds.ReferringPhysicianName = ""
    ds.SeriesInstanceUID = generate_uid()
    ds.SeriesNumber = 901
    ds.InstanceNumber = 1
    ds.SeriesDescription = "Saintview Presentation State"

    ds.ContentLabel = (label[:16] or "SAINTVIEW").upper()
    ds.ContentDescription = f"Saintview annotations by {creator}"[:64]
    ds.PresentationCreationDate = now.strftime("%Y%m%d")
    ds.PresentationCreationTime = now.strftime("%H%M%S")
    ds.ContentCreatorName = creator or "Saintview"

    # 참조 시리즈/이미지
    by_series: dict[str, list[dict]] = {}
    for im in images:
        by_series.setdefault(im.get("series_uid", ""), []).append(im)
    ref_series = []
    for suid, ims in by_series.items():
        s = Dataset()
        s.SeriesInstanceUID = suid
        s.ReferencedImageSequence = [_ref_image(im["sop_uid"], im.get("sop_class", "")) for im in ims]
        ref_series.append(s)
    ds.ReferencedSeriesSequence = ref_series

    # 표시 영역 (필수 모듈) — 전체 이미지 SCALE TO FIT
    areas = []
    for im in images:
        a = Dataset()
        a.ReferencedImageSequence = [_ref_image(im["sop_uid"], im.get("sop_class", ""))]
        a.DisplayedAreaTopLeftHandCorner = [1, 1]
        a.DisplayedAreaBottomRightHandCorner = [int(im.get("cols") or 1), int(im.get("rows") or 1)]
        a.PresentationSizeMode = "SCALE TO FIT"
        areas.append(a)
    ds.DisplayedAreaSelectionSequence = areas

    # W/L (Softcopy VOI LUT)
    if wc is not None and ww is not None:
        v = Dataset()
        v.WindowCenter = float(wc)
        v.WindowWidth = float(ww)
        ds.SoftcopyVOILUTSequence = [v]

    # 주석 레이어
    layer = Dataset()
    layer.GraphicLayer = LAYER
    layer.GraphicLayerOrder = 1
    layer.GraphicLayerDescription = "Saintview annotations"
    ds.GraphicLayerSequence = [layer]

    anno_items = []
    sop_class_of = {im["sop_uid"]: im.get("sop_class", "") for im in images}
    for anno in annotations:
        graphics, texts = annotation_to_graphics(anno)
        if not graphics and not texts:
            continue
        item = Dataset()
        item.GraphicLayer = LAYER
        sop = anno.get("sop_uid", "")
        item.ReferencedImageSequence = [_ref_image(sop, sop_class_of.get(sop, ""))]
        if graphics:
            item.GraphicObjectSequence = graphics
        if texts:
            item.TextObjectSequence = texts
        anno_items.append(item)
    if anno_items:
        ds.GraphicAnnotationSequence = anno_items
    return ds


def gsps_bytes(ds: Dataset) -> bytes:
    buf = io.BytesIO()
    ds.save_as(buf, write_like_original=False)
    return buf.getvalue()


# ──────────────────────────── 불러오기(타사 PR 표시) ────────────────────────────
def _image_dims(ds) -> dict[str, tuple[int, int]]:
    """sop_uid → (cols, rows) — PIXEL 좌표 정규화용(DisplayedAreaSelectionSequence)."""
    dims: dict[str, tuple[int, int]] = {}
    for a in getattr(ds, "DisplayedAreaSelectionSequence", []) or []:
        br = list(getattr(a, "DisplayedAreaBottomRightHandCorner", []) or [])
        if len(br) != 2:
            continue
        cols, rows = int(br[0]), int(br[1])
        for ref in getattr(a, "ReferencedImageSequence", []) or []:
            sop = str(getattr(ref, "ReferencedSOPInstanceUID", "") or "")
            if sop and cols > 0 and rows > 0:
                dims[sop] = (cols, rows)
    return dims


def _norm(pts: list[list[float]], units: str, sop: str, dims: dict) -> list[list[float]]:
    """좌표를 0~1 정규화 — DISPLAY는 그대로, PIXEL은 이미지 크기로 나눔."""
    if units != "PIXEL":
        return pts
    cd = dims.get(sop)
    if not cd:
        return pts  # 크기 미상 — 원좌표 유지(폴백)
    cols, rows = cd
    return [[p[0] / cols, p[1] / rows] for p in pts]


def _graphic_to_anno(gtype: str, pts: list[list[float]]) -> dict | None:
    """GSPS GraphicType → 뷰어 주석 kind 매핑(표시용)."""
    gtype = (gtype or "").upper()
    if gtype == "ELLIPSE" and len(pts) >= 4:
        # 장축 양끝(0,1) → bbox 2점
        (x1, _), (x2, _) = pts[0], pts[1]
        ys = [p[1] for p in pts]
        return {"kind": "ellipse", "points": [[min(x1, x2), min(ys)], [max(x1, x2), max(ys)]]}
    if gtype in ("CIRCLE",) and len(pts) >= 2:
        (cx, cy), (px, py) = pts[0], pts[1]
        r = ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5
        return {"kind": "ellipse", "points": [[cx - r, cy - r], [cx + r, cy + r]]}
    if gtype in ("POLYLINE", "INTERPOLATED"):
        if len(pts) == 2:
            return {"kind": "length", "points": pts[:2]}
        if len(pts) == 3:
            return {"kind": "angle", "points": pts[:3]}
        if len(pts) in (4, 5):
            # 닫힌 사각형(축 정렬) 추정 → rect, 아니면 폴리라인을 length로
            xs = [p[0] for p in pts[:4]]; ys = [p[1] for p in pts[:4]]
            return {"kind": "rect", "points": [[min(xs), min(ys)], [max(xs), max(ys)]]}
        return {"kind": "length", "points": pts[:2]} if len(pts) >= 2 else None
    if gtype == "POINT" and pts:
        return {"kind": "text", "points": pts[:1]}
    return None


def parse_gsps_dataset(ds) -> dict:
    """GSPS Dataset → {label, creator, wc, ww, annotations[]} (불러오기·타사 PR 표시).

    좌표는 뷰어 표준인 0~1 정규화로 환산(DISPLAY 그대로 / PIXEL은 이미지 크기로).
    """
    dims = _image_dims(ds)
    wc = ww = None
    voi = getattr(ds, "SoftcopyVOILUTSequence", None)
    if voi:
        v = voi[0]

        def _f(x):
            return float(x[0]) if isinstance(x, (list,)) or hasattr(x, "__len__") and not isinstance(x, str) else float(x)
        try:
            wc = _f(v.WindowCenter)
            ww = _f(v.WindowWidth)
        except (AttributeError, ValueError, TypeError):
            wc = ww = None

    annos: list[dict] = []
    for item in getattr(ds, "GraphicAnnotationSequence", []) or []:
        sop = ""
        ref = getattr(item, "ReferencedImageSequence", None)
        if ref:
            sop = str(getattr(ref[0], "ReferencedSOPInstanceUID", "") or "")
        for g in getattr(item, "GraphicObjectSequence", []) or []:
            try:
                n = int(g.NumberOfGraphicPoints)
                data = [float(x) for x in g.GraphicData]
                pts = [[data[i * 2], data[i * 2 + 1]] for i in range(n)]
            except (AttributeError, ValueError, IndexError):
                continue
            units = str(getattr(g, "GraphicAnnotationUnits", "DISPLAY") or "DISPLAY").upper()
            pts = _norm(pts, units, sop, dims)
            anno = _graphic_to_anno(str(getattr(g, "GraphicType", "")), pts)
            if anno:
                anno.update({"sop_uid": sop, "source": "external"})
                annos.append(anno)
        for t in getattr(item, "TextObjectSequence", []) or []:
            anchor = list(getattr(t, "AnchorPoint", []) or [])
            txt = str(getattr(t, "UnformattedTextValue", "") or "")
            if len(anchor) == 2:
                units = str(getattr(t, "AnchorPointAnnotationUnits", "DISPLAY") or "DISPLAY").upper()
                p = _norm([[float(anchor[0]), float(anchor[1])]], units, sop, dims)
                annos.append({"kind": "text", "points": p, "text": txt,
                              "sop_uid": sop, "source": "external"})
    return {
        "label": str(getattr(ds, "ContentLabel", "") or ""),
        "creator": str(getattr(ds, "ContentCreatorName", "") or ""),
        "wc": wc, "ww": ww, "annotations": annos,
    }


def read_gsps_bytes(data: bytes) -> dict:
    """GSPS 바이트 → 파싱 결과. GSPS가 아니면 빈 주석."""
    from pydicom import dcmread

    ds = dcmread(io.BytesIO(data), force=True)
    if str(getattr(ds, "SOPClassUID", "")) != GSPS_SOP_CLASS:
        return {"label": "", "creator": "", "wc": None, "ww": None, "annotations": []}
    return parse_gsps_dataset(ds)
