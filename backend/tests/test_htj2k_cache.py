"""HTJ2K 프레임 캐시 상한 — 무한정 자라던 것을 막는다.

이 캐시는 본 프레임을 전부 영구 보관했다. 판독을 계속하면 디스크가 찰 때까지 자라고,
다 차면 인코딩 쓰기가 실패해 뷰어가 프레임을 못 받는다. 영상 서버에서는 곧 정지다.
그래서 '상한을 넘으면 오래된 것부터 지운다'를 계약으로 고정한다.
"""
from __future__ import annotations

import os

import pytest

from app.api import htj2k_stream as h


@pytest.fixture()
def cache(tmp_path, monkeypatch):
    """캐시 디렉터리를 임시 경로로 돌리고 상각 카운터를 초기화."""
    monkeypatch.setattr(h, "CACHE", tmp_path)
    monkeypatch.setattr(h, "_prune_counter", 0)
    return tmp_path


def _put(d, name: str, size: int, mtime: float) -> None:
    p = d / name
    p.write_bytes(b"\0" * size)
    os.utime(p, (mtime, mtime))


def test_prunes_oldest_first_when_over_limit(cache, monkeypatch):
    monkeypatch.setattr(h, "CACHE_MAX_MB", 1)          # 상한 1MB
    for i in range(4):                                  # 4 × 400KB = 1.6MB
        _put(cache, f"sop{i}_1.j2c", 400 * 1024, 1_000_000 + i)

    h._prune_cache(force=True)

    left = sorted(p.name for p in cache.glob("*.j2c"))
    # 1MB 이하가 될 때까지 오래된 것부터 — 가장 오래된 sop0 이 먼저 나간다
    assert "sop0_1.j2c" not in left
    assert "sop3_1.j2c" in left                         # 가장 최근 것은 남는다
    total = sum(p.stat().st_size for p in cache.glob("*.j2c"))
    assert total <= 1024 * 1024


def test_under_limit_keeps_everything(cache, monkeypatch):
    monkeypatch.setattr(h, "CACHE_MAX_MB", 10)
    for i in range(3):
        _put(cache, f"sop{i}_1.j2c", 400 * 1024, 1_000_000 + i)

    h._prune_cache(force=True)

    assert len(list(cache.glob("*.j2c"))) == 3          # 멀쩡한 캐시를 지우면 안 된다


def test_amortized_scan_skips_most_calls(cache, monkeypatch):
    """디렉터리 스캔은 비싸다 — force 없이는 N회마다 한 번만 돈다."""
    monkeypatch.setattr(h, "CACHE_MAX_MB", 1)
    for i in range(4):
        _put(cache, f"sop{i}_1.j2c", 400 * 1024, 1_000_000 + i)

    for _ in range(h._PRUNE_EVERY - 1):                 # 아직 임계 전
        h._prune_cache()
    assert len(list(cache.glob("*.j2c"))) == 4          # 아무것도 안 지웠다

    h._prune_cache()                                    # N번째 — 여기서 돈다
    assert len(list(cache.glob("*.j2c"))) < 4


def test_ignores_non_cache_files(cache, monkeypatch):
    """.j2c 가 아닌 것은 세지도, 지우지도 않는다(다른 용도 파일 보호)."""
    monkeypatch.setattr(h, "CACHE_MAX_MB", 1)
    _put(cache, "keep.txt", 2 * 1024 * 1024, 1_000_000)  # 상한보다 크지만 대상 아님
    _put(cache, "sop0_1.j2c", 400 * 1024, 1_000_001)

    h._prune_cache(force=True)

    assert (cache / "keep.txt").exists()
    assert (cache / "sop0_1.j2c").exists()              # j2c 합계는 상한 이하 → 유지
