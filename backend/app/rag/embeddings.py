"""임베딩 추상화 계층 (D-2).

- local: 결정적 해시 기반 임베딩 — 개발/테스트용(외부 의존성 0, 같은 텍스트 → 같은 벡터,
  토큰 단위 가산이라 어휘가 겹치면 코사인 유사도가 높아져 검색 동작 검증 가능).
- voyage: 운영용(VOYAGE_API_KEY 필요). 한국어 성능 비교 후 모델 확정.
"""
from __future__ import annotations

import hashlib
import math
import os
import re

import numpy as np

from app.config import get_settings

_TOKEN = re.compile(r"[A-Za-z가-힣0-9]+")


def _local_embed(text: str, dim: int) -> list[float]:
    vec = np.zeros(dim, dtype=np.float64)
    for tok in _TOKEN.findall(text.lower()):
        h = hashlib.sha1(tok.encode("utf-8")).digest()
        idx = int.from_bytes(h[:4], "little") % dim
        sign = 1.0 if h[4] % 2 == 0 else -1.0
        vec[idx] += sign
    norm = float(np.linalg.norm(vec))
    if norm > 0:
        vec /= norm
    return vec.tolist()


def embed(text: str) -> list[float]:
    settings = get_settings()
    if settings.embedding_backend == "voyage":
        return _voyage_embed(text, settings.embedding_dim)
    return _local_embed(text, settings.embedding_dim)


def _voyage_embed(text: str, dim: int) -> list[float]:
    import httpx

    api_key = os.getenv("VOYAGE_API_KEY", "")
    if not api_key:
        raise RuntimeError("VOYAGE_API_KEY 미설정 — embedding_backend=voyage 사용 불가")
    resp = httpx.post(
        "https://api.voyageai.com/v1/embeddings",
        headers={"Authorization": f"Bearer {api_key}"},
        json={"model": "voyage-3", "input": [text], "output_dimension": dim},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["data"][0]["embedding"]


def cosine(a: list[float], b: list[float]) -> float:
    va, vb = np.asarray(a), np.asarray(b)
    denom = float(np.linalg.norm(va) * np.linalg.norm(vb))
    if denom == 0 or math.isnan(denom):
        return 0.0
    return float(np.dot(va, vb) / denom)
