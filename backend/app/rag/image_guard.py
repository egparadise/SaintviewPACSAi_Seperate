"""vision 전송 이미지 가드 (설계 §8.1) — 번인(burn-in) PHI 마스킹.

2단 방어:
1. 스트립 마스킹(항상): 장비 번인 텍스트는 관례적으로 상·하단 가장자리 → 검정 마스킹.
2. OCR 마스킹(가용 시): pytesseract가 설치돼 있으면 영상 전체에서 텍스트 박스를
   검출해 추가 마스킹 — 중앙부 번인까지 커버. 미설치/실패 시 1단만 적용(무중단 폴백).
"""
from __future__ import annotations

import io
import logging
import os

logger = logging.getLogger(__name__)

TOP_RATIO = 0.10
BOTTOM_RATIO = 0.10
# 환경변수로 정밀도 조정 — 기관별 번인 폰트/언어에 맞춤
_OCR_MIN_CONF = float(os.getenv("SAINTVIEW_OCR_MIN_CONF", "35"))  # 신뢰도 임계(0~100)
_OCR_LANG = os.getenv("SAINTVIEW_OCR_LANG", "eng")  # 번인은 대개 ASCII; 한글 번인이면 "kor+eng"
_OCR_PAD = 4             # 검출 박스 여유(px)
# PSM 11(sparse text) — 영상 위 흩어진 번인 텍스트 검출에 기본 PSM 3보다 유리
_OCR_CONFIG = os.getenv("SAINTVIEW_OCR_CONFIG", "--psm 11")


def _ocr_text_boxes(img) -> list[tuple[int, int, int, int]]:
    """pytesseract로 텍스트 박스 검출 — 미설치/실패 시 빈 목록(무중단 폴백)."""
    try:
        import pytesseract
    except ImportError:
        return []

    def _run(lang):
        return pytesseract.image_to_data(
            img, lang=lang, config=_OCR_CONFIG, output_type=pytesseract.Output.DICT
        )

    try:
        data = _run(_OCR_LANG)
    except Exception:  # 언어팩 부재 등 → 기본 언어로 재시도
        try:
            data = _run(None)
        except Exception:  # tesseract 바이너리 부재 등
            logger.info("OCR 불가 — 스트립 마스킹만 적용")
            return []
    boxes = []
    for i in range(len(data.get("text", []))):
        txt = (data["text"][i] or "").strip()
        try:
            conf = float(data["conf"][i])
        except (TypeError, ValueError):
            conf = -1
        # 영숫자 1자(예: 'L'/'R' 측면 표식) 이상 + 신뢰도 임계 — 짧은 번인도 포착
        if len(txt) >= 1 and any(c.isalnum() for c in txt) and conf >= _OCR_MIN_CONF:
            boxes.append((data["left"][i], data["top"][i], data["width"][i], data["height"][i]))
    return boxes


def mask_burn_in(
    png_bytes: bytes, *, top_ratio: float = TOP_RATIO, bottom_ratio: float = BOTTOM_RATIO
) -> bytes:
    """PNG 상·하단 스트립 + (가용 시) OCR 검출 텍스트 박스를 검정 마스킹해 반환."""
    from PIL import Image, ImageDraw

    img = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    w, h = img.size
    draw = ImageDraw.Draw(img)

    # 1단: 스트립
    top_px = int(h * top_ratio)
    bottom_px = int(h * bottom_ratio)
    if top_px > 0:
        draw.rectangle([0, 0, w, top_px], fill=(0, 0, 0))
    if bottom_px > 0:
        draw.rectangle([0, h - bottom_px, w, h], fill=(0, 0, 0))

    # 2단: OCR — 모든 검출 텍스트를 마스킹(영상 내 텍스트는 판독 정보가 아니라 번인)
    for (x, y, bw, bh) in _ocr_text_boxes(img):
        draw.rectangle(
            [max(0, x - _OCR_PAD), max(0, y - _OCR_PAD),
             min(w, x + bw + _OCR_PAD), min(h, y + bh + _OCR_PAD)],
            fill=(0, 0, 0),
        )

    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()
