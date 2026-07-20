"""38차 — ROI HU 통계(드래그 W/L·HU ROI 통계, Cornerstone 경로 대체)."""
from __future__ import annotations

import numpy as np

from app.dicom.roi import roi_statistics


def test_roi_rect_hu_conversion():
    arr = np.full((100, 100), 1224, dtype=np.int16)  # 픽셀값
    # slope=1, intercept=-1024 → HU = 200
    st = roi_statistics(arr, slope=1.0, intercept=-1024.0, kind="rect",
                        points_px=[[10, 10], [90, 90]], pixel_spacing=[0.5, 0.5])
    assert st["mean"] == 200.0 and st["min"] == 200.0 and st["max"] == 200.0
    assert st["std"] == 0.0 and st["unit"] == "HU"
    # 면적 = 픽셀 수 × 0.5 × 0.5
    assert st["area_mm2"] == round(st["count"] * 0.25, 2)


def test_roi_ellipse_smaller_than_rect():
    arr = np.ones((100, 100), dtype=np.int16)
    rect = roi_statistics(arr, slope=1, intercept=0, kind="rect",
                          points_px=[[20, 20], [80, 80]])
    ell = roi_statistics(arr, slope=1, intercept=0, kind="ellipse",
                         points_px=[[20, 20], [80, 80]])
    assert ell["count"] < rect["count"]          # 타원이 사각형보다 적은 픽셀
    assert ell["mean"] == 1.0 and rect["mean"] == 1.0


def test_roi_mean_within_subregion():
    arr = np.zeros((100, 100), dtype=np.int16)
    arr[40:60, 40:60] = 500  # 가운데 블록만 500
    full = roi_statistics(arr, slope=1, intercept=0, kind="rect",
                          points_px=[[40, 40], [59, 59]])
    assert full["mean"] == 500.0 and full["max"] == 500.0


def test_roi_too_small_returns_error():
    arr = np.ones((50, 50), dtype=np.int16)
    st = roi_statistics(arr, slope=1, intercept=0, kind="rect", points_px=[[10, 10], [10, 10]])
    assert "error" in st


def test_roi_rejects_non_2d():
    arr = np.ones((10, 10, 3), dtype=np.uint8)  # 컬러
    st = roi_statistics(arr, slope=1, intercept=0, kind="rect", points_px=[[1, 1], [8, 8]])
    assert "error" in st
