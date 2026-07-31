"""판독 초안 버전 배정 — **같은 검사가 두 번 처리돼도 잡이 죽지 않는다.**

`reports` 는 (study_id, version) 유니크다. 초안 생성은 '최신 버전을 읽고 +1 해서 쓰기' 라,
그 사이에 다른 경로가 같은 검사에 초안을 넣으면 IntegrityError 가 난다.

같은 검사가 두 번 큐잉되는 일은 실제로 있다:
  · Orthanc 재폴링(since=0) — 코드 주석이 '중복 큐잉 가드' 를 언급할 만큼 흔하다
  · 수동 재분석
  · 워커가 대기 큐를 한 배치로 드레인할 때

그때 예외로 잡이 죽으면 **그 검사는 영영 초안이 안 생긴다.** 되읽어서 다시 시도해야 한다.
(이 결함은 테스트 순서를 무작위로 돌릴 때 8회에 1번꼴로 드러났다.)
"""
from __future__ import annotations

import pytest

from app.services import report_service
from app.services.report_service import save_draft_from_ai
from app.services.study_service import register_study

SR = {"exam": {"modality": "CR", "body_part": "CHEST"},
      "findings": [{"region": "CHEST", "text": "정상", "severity": "normal"}],
      "conclusion": ["특이 소견 없음"]}


def _study(db, uid: str):
    return register_study(db, study_uid=uid, patient_key="PV1", patient_name="테스트",
                          study_date="20260731", modality="CR", body_part="CHEST")


def test_second_draft_gets_next_version(db):
    """정상 경로 — 두 번째 초안은 v2 다."""
    st = _study(db, "1.2.race.1")
    r1 = save_draft_from_ai(db, st, SR, model="mock", sources={})
    r2 = save_draft_from_ai(db, st, SR, model="mock", sources={})
    assert (r1.version, r2.version) == (1, 2)


def test_version_collision_is_retried_not_raised(db, monkeypatch):
    """★ 회귀 방어 — 버전을 읽은 **뒤** 남이 같은 번호를 선점해도 예외로 끝나지 않는다.

    되돌리면(재시도 없이 commit 한 번) IntegrityError 가 그대로 올라와 이 테스트가 깨진다.
    """
    st = _study(db, "1.2.race.2")
    save_draft_from_ai(db, st, SR, model="mock", sources={})   # v1 선점

    # latest_report 가 '아직 아무것도 없다' 고 거짓 보고하게 만든다(경합 재현).
    real = report_service.latest_report
    calls = {"n": 0}

    def stale(session, study_id):
        calls["n"] += 1
        return None if calls["n"] == 1 else real(session, study_id)

    monkeypatch.setattr(report_service, "latest_report", stale)

    r = save_draft_from_ai(db, st, SR, model="mock", sources={})
    assert r.version == 2, f"재시도가 안 걸렸다 — version={r.version}"
    assert calls["n"] >= 2, "되읽지 않았다(한 번만 보고 포기)"


def test_persistent_collision_finally_raises(db, monkeypatch):
    """무한 재시도는 하지 않는다 — 계속 충돌하면 결국 올린다(조용히 삼키면 안 된다)."""
    st = _study(db, "1.2.race.3")
    save_draft_from_ai(db, st, SR, model="mock", sources={})   # v1
    monkeypatch.setattr(report_service, "latest_report", lambda s, i: None)   # 늘 v1 을 노린다

    from sqlalchemy.exc import IntegrityError
    with pytest.raises(IntegrityError):
        save_draft_from_ai(db, st, SR, model="mock", sources={})


def test_locked_study_still_refuses_before_any_retry(db):
    """확정 잠금은 재시도 구조와 무관하게 **먼저** 막는다(SPEC §C)."""
    from app.services.report_service import WorkflowError

    st = _study(db, "1.2.race.4")
    st.report_locked = True
    db.commit()
    with pytest.raises(WorkflowError):
        save_draft_from_ai(db, st, SR, model="mock", sources={})
