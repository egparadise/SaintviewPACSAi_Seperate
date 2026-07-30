"""HTJ2K 시리즈 프리인코딩 — **한 장의 픽셀이 시리즈 전체 캐시를 덮으면 안 된다.**

판독 사고로 직결되는 종류다. 스크롤을 내려도 계속 같은 영상이 보이거나, 3번 슬라이스
자리에 12번 슬라이스가 뜬다. 방사선사·판독의가 화면을 믿을 수 없게 된다.

원인은 임시 파일 이름이었다. `encode_frames_batch` 가 인스턴스 구분자로 `sop[:32]` 를 썼는데,
**같은 시리즈의 SOP UID 는 앞부분이 똑같다.** 실제 장비 UID 로 재현된다:

    1.2.840.113619.2.55.3.604688119.868.1700000000.1
    1.2.840.113619.2.55.3.604688119.868.1700000000.2
    → 앞 32자가 둘 다 '1.2.840.113619.2.55.3.604688119.' — 완전히 같다

같은 이름의 .raw 를 덮어쓰므로 **마지막 인스턴스의 픽셀만 남고**, Node 결과 dict 는 out 경로로
키가 잡히니 그 하나의 결과가 시리즈 전 인스턴스의 캐시 파일로 복사된다.

계약: 인스턴스마다 임시 파일 이름이 **반드시** 달라야 한다. 자르지 않는다.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services import htj2k_service as svc

# 실제 장비에서 나오는 모양 — 시리즈 안에서 마지막 숫자만 다르다
SOP_A = "1.2.840.113619.2.55.3.604688119.868.1700000000.1"
SOP_B = "1.2.840.113619.2.55.3.604688119.868.1700000000.2"


class FakeDS:
    """_frame_jobs 가 실제로 읽는 속성만 가진 최소 데이터셋."""

    def __init__(self, fill: int):
        self.Rows = 2
        self.Columns = 2
        self.BitsAllocated = 8
        self.SamplesPerPixel = 1
        self.PixelRepresentation = 0
        self.NumberOfFrames = 1
        # 인스턴스마다 **다른** 픽셀 — 섞이면 바로 드러난다
        self.PixelData = bytes([fill]) * 4


def test_same_series_uids_do_not_share_a_temp_name():
    """앞 32자가 같은 두 UID 가 서로 다른 임시 파일을 써야 한다."""
    assert SOP_A[:32] == SOP_B[:32], "표본 전제가 깨졌다 — 두 UID 의 앞 32자는 같아야 한다"
    tags = {svc.batch_tag(SOP_A, 0), svc.batch_tag(SOP_B, 1)}
    assert len(tags) == 2, f"인스턴스 구분자가 충돌한다: {tags}"


def test_batch_writes_each_instance_its_own_pixels(tmp_path, monkeypatch):
    """시리즈 배치가 인스턴스별 픽셀을 **각자의** 캐시 파일에 넣는다(재현 테스트).

    되돌리면(sop[:32]) 두 캐시 파일이 같은 바이트가 되어 이 단정이 깨진다.
    """
    calls: list[list[dict]] = []

    def fake_run_node(jobs):
        """Node 대신 — raw 를 그대로 out 에 복사한다(인코딩 내용은 이 테스트의 관심이 아니다)."""
        calls.append(jobs)
        res = {}
        for j in jobs:
            Path(j["out"]).write_bytes(Path(j["raw"]).read_bytes())
            res[j["out"]] = {"out": j["out"], "ok": True}
        return res

    monkeypatch.setattr(svc, "_run_node", fake_run_node)

    cache = tmp_path / "cache"
    cache.mkdir()
    done = svc.encode_frames_batch([(SOP_A, FakeDS(0x11)), (SOP_B, FakeDS(0x22))], cache)

    assert done == 2, "두 인스턴스가 모두 캐시에 들어가야 한다"
    a = (cache / f"{SOP_A}_1.j2c").read_bytes()
    b = (cache / f"{SOP_B}_1.j2c").read_bytes()
    assert a == b"\x11" * 4, f"A 의 픽셀이 아니다: {a!r}"
    assert b == b"\x22" * 4, f"B 의 픽셀이 아니다(A 가 덮었다): {b!r}"
    assert a != b, "두 인스턴스의 캐시가 같은 바이트다 — 시리즈 전체가 한 장으로 덮였다"

    # Node 에 넘어간 job 의 out 경로도 유일해야 한다(중복이면 결과 dict 가 하나로 뭉친다)
    outs = [j["out"] for j in calls[0]]
    assert len(outs) == len(set(outs)), f"job out 경로가 중복이다: {outs}"


def test_multiframe_frames_stay_separate(tmp_path, monkeypatch):
    """다중프레임 한 인스턴스 안에서도 프레임끼리 섞이지 않는다."""

    def fake_run_node(jobs):
        for j in jobs:
            Path(j["out"]).write_bytes(Path(j["raw"]).read_bytes())
        return {j["out"]: {"out": j["out"], "ok": True} for j in jobs}

    monkeypatch.setattr(svc, "_run_node", fake_run_node)

    ds = FakeDS(0)
    ds.NumberOfFrames = 3
    ds.PixelData = b"\xaa" * 4 + b"\xbb" * 4 + b"\xcc" * 4

    cache = tmp_path / "c2"
    cache.mkdir()
    assert svc.encode_frames_batch([(SOP_A, ds)], cache) == 3
    assert (cache / f"{SOP_A}_1.j2c").read_bytes() == b"\xaa" * 4
    assert (cache / f"{SOP_A}_2.j2c").read_bytes() == b"\xbb" * 4
    assert (cache / f"{SOP_A}_3.j2c").read_bytes() == b"\xcc" * 4


def test_existing_cache_entry_is_not_truncated(tmp_path, monkeypatch):
    """이미 있는 캐시 파일은 그대로 둔다 — 스크롤 중 0바이트로 잘리면 검은 타일이 뜬다."""

    def fake_run_node(jobs):
        for j in jobs:
            Path(j["out"]).write_bytes(b"NEW")
        return {j["out"]: {"out": j["out"], "ok": True} for j in jobs}

    monkeypatch.setattr(svc, "_run_node", fake_run_node)

    cache = tmp_path / "c3"
    cache.mkdir()
    (cache / f"{SOP_A}_1.j2c").write_bytes(b"ALREADY-THERE")

    svc.encode_frames_batch([(SOP_A, FakeDS(0x11))], cache)

    assert (cache / f"{SOP_A}_1.j2c").read_bytes() == b"ALREADY-THERE"


def test_windows_unsafe_uid_characters_do_not_break_paths(tmp_path, monkeypatch):
    """UID 는 숫자와 점뿐이지만, 이름 생성이 경로 구분자를 만들지 않는지 고정한다."""
    tag = svc.batch_tag("1.2.3", 7)
    assert "/" not in tag and "\\" not in tag and ".." not in tag
