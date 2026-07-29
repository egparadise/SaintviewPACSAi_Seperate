"""과거검사·Compare 에 **다른 환자가 섞이지 않는다**.

실제로 난 사고(sv70): 환자 '전해인 / 7139' 의 Chest PA 를 판독하는데, History 의 과거검사에
'유경란 / 10171393' 의 RT Knee MRI 가 섞여 나왔고 그것을 열어 **Chest PA 옆에 다른 환자
영상이 떴다.** 판독 사고로 직결되는 종류다.

원인은 상류(A)의 부분일치다 — 차트번호가 짧은 숫자라 **긴 번호가 짧은 번호를 포함**한다
('10171393' ⊃ '7139'). A 쪽에는 patient_id 를 LIKE 로 거는 지점이 실제로 있다
(router/Patient.py:22, Dicomweb.py:1820 fuzzymatching).

계약: **상류가 무엇을 주든 우리가 정확일치로 거른다.** 같은 환자 목록에 다른 환자가 들어가는
것은 어떤 이유로도 허용되지 않는다.
"""
from __future__ import annotations

from app.services import webpacs_live as live

# 사고 그대로의 표본 — 짧은 번호가 긴 번호의 부분 문자열이다
ME = {"patient_id": "7139", "patient_idx": 501}
OTHER = {"patient_id": "10171393", "patient_idx": 902}


def test_substring_chart_number_is_not_the_same_patient():
    """'10171393' 은 '7139' 를 포함하지만 **다른 환자**다 — 이 한 줄이 사고를 막는다."""
    assert live.same_patient(OTHER, "7139") is False
    assert live.same_patient(OTHER, "7139", 501) is False


def test_exact_match_passes():
    assert live.same_patient(ME, "7139") is True
    assert live.same_patient(ME, "7139", 501) is True


def test_patient_idx_mismatch_wins_even_if_chart_number_matches():
    """차트번호가 같아도 A 내부 PK 가 다르면 다른 환자다(번호 재사용·재발급)."""
    twin = {"patient_id": "7139", "patient_idx": 777}
    assert live.same_patient(twin, "7139") is True         # PK 를 모르면 번호만 본다
    assert live.same_patient(twin, "7139", 501) is False   # PK 를 알면 그것이 이긴다


def test_missing_idx_on_row_does_not_reject():
    """A 가 patient_idx 를 안 준 행은 번호 일치만으로 통과한다(정보가 없다고 버리지 않는다)."""
    row = {"patient_id": "7139"}
    assert live.same_patient(row, "7139", 501) is True


def test_whitespace_and_type_are_normalized():
    assert live.same_patient({"patient_id": " 7139 "}, "7139") is True
    assert live.same_patient({"patient_id": 7139}, "7139") is True
    assert live.same_patient({"patient_id": ""}, "7139") is False
    assert live.same_patient({}, "7139") is False


def test_related_filters_out_the_other_patient(monkeypatch):
    """live_related 이 A 의 부분일치 응답에서 다른 환자를 걸러낸다(사고 재현)."""
    live.invalidate_related()

    detail = {"patient_id": "7139", "patient_idx": 501}
    a_rows = [
        {"study_idx": 11, "patient_id": "7139", "patient_idx": 501,
         "study_instance_uid": "1.2.mine", "study_datetime": "2026-04-25 10:00:00",
         "study_modality": "DR", "study_description": "Chest PA", "study_status": "R"},
        # A 가 부분일치로 끼워 넣은 **다른 환자**
        {"study_idx": 22, "patient_id": "10171393", "patient_idx": 902,
         "study_instance_uid": "1.2.other", "study_datetime": "2026-07-27 10:00:00",
         "study_modality": "MR", "study_description": "RT Knee MRI", "study_status": "R"},
    ]

    class FakeClient:
        base_url = "https://a.example"

        def study_detail(self, idx):
            return detail

        def list_studies(self, params):
            return a_rows

    monkeypatch.setattr(live, "live_client", lambda db, user=None: FakeClient())

    out = live.live_related(None, live.to_vid(99), None, row=detail)
    uids = {x["study_uid"] for x in out}
    assert "1.2.other" not in uids, "다른 환자의 검사가 과거검사 목록에 들어왔다"
    assert uids == {"1.2.mine"}
    live.invalidate_related()
