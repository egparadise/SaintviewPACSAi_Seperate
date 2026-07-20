"""ROI HU 통계 — 픽셀 데이터 기반(드래그 W/L·HU ROI 통계용, Cornerstone 경로 대체).

자체 SVG 측정 레이어는 기하(길이·각도·면적)를 처리하지만 픽셀 값(HU)은 다루지 못한다.
서버에서 DICOM 픽셀을 받아 RescaleSlope/Intercept로 HU 변환 후 ROI 내부 통계를 낸다.
"""
from __future__ import annotations


def roi_statistics(
    pixel_array,
    *,
    slope: float,
    intercept: float,
    kind: str,
    points_px: list[list[float]],
    pixel_spacing: list[float] | None = None,
    has_rescale: bool = True,
) -> dict:
    """ROI 내부 픽셀의 HU 통계.

    pixel_array: 2D numpy 배열(그레이스케일). points_px: 픽셀 좌표.
    kind: rect | ellipse | circle (그 외는 bbox로 처리).
    """
    import numpy as np

    arr = np.asarray(pixel_array, dtype=float)
    if arr.ndim != 2:
        return {"error": "그레이스케일 2D 영상만 지원합니다(컬러/다중프레임 제외)"}
    rows, cols = arr.shape
    hu = arr * slope + intercept

    xs = [p[0] for p in points_px]
    ys = [p[1] for p in points_px]
    x0, x1 = max(0, min(xs)), min(cols - 1, max(xs))
    y0, y1 = max(0, min(ys)), min(rows - 1, max(ys))
    if x1 <= x0 or y1 <= y0:
        return {"error": "ROI 영역이 너무 작습니다"}

    yy, xx = np.ogrid[:rows, :cols]
    if kind in ("ellipse", "circle"):
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        rx, ry = max((x1 - x0) / 2, 1e-6), max((y1 - y0) / 2, 1e-6)
        mask = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2 <= 1.0
    else:  # rect (및 폴백)
        mask = (xx >= x0) & (xx <= x1) & (yy >= y0) & (yy <= y1)

    vals = hu[mask]
    if vals.size == 0:
        return {"error": "ROI 내부 픽셀이 없습니다"}

    area_mm2 = None
    if pixel_spacing and len(pixel_spacing) == 2:
        try:
            area_mm2 = float(mask.sum()) * float(pixel_spacing[0]) * float(pixel_spacing[1])
        except (TypeError, ValueError):
            area_mm2 = None

    return {
        "count": int(vals.size),
        "mean": round(float(vals.mean()), 2),
        "min": round(float(vals.min()), 2),
        "max": round(float(vals.max()), 2),
        "std": round(float(vals.std()), 2),
        "unit": "HU" if has_rescale else "px값",
        "area_mm2": round(area_mm2, 2) if area_mm2 is not None else None,
    }
