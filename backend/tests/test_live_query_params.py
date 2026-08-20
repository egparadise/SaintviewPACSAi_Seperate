"""Live 워크리스트가 A 로 **무엇을 보내는가** — 파라미터 계약(2026-08-21).

배경 두 가지
────────────
① **무효였던 상한**: 조건 나열 검색은 받은 목록을 클라이언트가 다시 걸러야 해서(A 는 센터명 같은
   축을 검색 파라미터로 받지 않는다) 1000건만 받으면 그 안에 답이 없을 때 "없다"가 됐다.
   API 의 `Query(le=…)` 상한만 올렸더니 **서비스가 다시 `min(…, 1000)` 으로 잘라** 아무 효과가
   없었다. 상한은 API 가 정하고 서비스는 그대로 전달해야 한다.

② **안 보내던 축**: A 는 부위·검사명·응급·상태를 필드별로 받아 AND 로 묶는데, 여태
   q·pid·pname·modality·기간만 보냈다. 그래서 필터바에 부위를 넣어도 Live 에서는 조용히 무시됐다.

여기서는 HTTP 를 타지 않고 **A 로 나갈 쿼리를 만드는 지점**을 직접 확인한다
(모의 A 를 띄우는 대신 client 를 가로채 q 를 붙잡는다 — 빠르고 흔들리지 않는다).
"""
from __future__ import annotations

import pytest

from app.services import webpacs_live as live


class _SpyClient:
    """list_studies/study_count 로 넘어온 파라미터를 그대로 붙잡는다."""

    def __init__(self) -> None:
        self.seen: dict = {}

    def list_studies(self, q: dict) -> list:
        self.seen = dict(q)
        return []

    def study_count(self, q: dict) -> int:  # noqa: ARG002
        return 0


@pytest.fixture
def spy(monkeypatch):
    c = _SpyClient()
    monkeypatch.setattr(live, "live_client", lambda *a, **k: c)
    return c


def _call(spy, **params) -> dict:
    live.live_worklist(None, params, None)
    return spy.seen


def test_기본_건수는_1000_그대로(spy):
    assert _call(spy)["limit"] == "1000"


def test_상한을_서비스가_다시_자르지_않는다(spy):
    """이게 무효였던 지점이다 — API 에서 5000 을 통과시켜도 여기서 1000 이 됐다."""
    assert _call(spy, limit=5000)["limit"] == "5000", "서비스는 상한을 정하지 않고 그대로 전달한다"
    assert _call(spy, limit=0)["limit"] == "1000", "0/None 은 기본값으로"


def test_A_가_필드별로_받는_축을_보낸다(spy):
    q = _call(spy, body_part="CHEST", desc="Chest CT", modality="CT")
    assert q["study_body_part"] == "CHEST"
    assert q["study_description"] == "Chest CT"
    assert q["study_modality"] == "CT"


def test_응급은_A_멀티셀렉트_코드로(spy):
    assert _call(spy, emergency="true")["study_emergency"] == ["ER"]
    assert "study_emergency" not in _call(spy, emergency="")
    assert "study_emergency" not in _call(spy, emergency="false")


def test_판독중_확정만_상태로_승격한다(spy):
    """A 의 검색 가능 상태는 E/RE/RI/R/A/RR/RA/REF 여덟 개다."""
    assert _call(spy, status="reading")["study_status"] == ["RI", "R", "RR", "REF"]
    assert _call(spy, status="finalized")["study_status"] == ["A", "RA"]


def test_미판독은_보내지_않는다_AI_가_사라지기_때문(spy):
    """우리 'received' 에는 AI 가 섞일 수 있는데(A 클라이언트에 status_ai 표시가 실재) 검색으로는
    고를 수 없다. [E, RE] 로 좁혀 보내면 AI 검사가 미판독 목록에서 **사라진다** —
    판독 대상이 안 보이는 누락이라 클라이언트가 거른다."""
    assert "study_status" not in _call(spy, status="received")
    assert "study_status" not in _call(spy, status="")


def test_센터는_필드로_보낸다_free_text_가_안_훑는_유일한_축(spy):
    """A 의 워크리스트 free-text(study_search)가 OR 로 훑는 컬럼에는 hospital_name 은 있고
    **center_name 만 없다**(dependencies/Study.get_study_search). 그래서 센터는 필드로 보내야 한다."""
    assert _call(spy, center="써밋영상의원")["center_name"] == "써밋영상의원"
    assert "center_name" not in _call(spy, center="")


def test_기간_환자_자유어는_종전대로(spy):
    q = _call(spy, pid="P1", pname="김지숙", q="Brain",
              date_from="20260101", date_to="20260131")
    assert q["patient_id"] == "P1"
    assert q["patient_name"] == "김지숙"
    assert q["study_search"] == "Brain"
    assert q["study_datetime_start"] == "20260101"
    assert q["study_datetime_end"] == "20260131"


def test_빈_값은_보내지_않는다(spy):
    q = _call(spy, body_part="", desc="", modality="", pid="", pname="", q="")
    for k in ("study_body_part", "study_description", "study_modality",
              "patient_id", "patient_name", "study_search"):
        assert k not in q, f"{k} — 빈 값을 보내면 A 가 그 조건으로 좁힐 수 있다"
