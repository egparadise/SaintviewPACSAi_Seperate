"""판독 저장 자격 게이트 + 판독의 등록 자동 채움 — 2026-08-07 사용자 확정 계약.

요구: "A 서버의 로그인 계정이 영상의학과 전문의로 분류되어 있는 사람만 판독 저장" +
     "전문의가 자기 ID/PW 로 로그인하면 판독의 등록(이름·면허번호)이 자동으로 채워진다".

A 데이터상 신호: pacs_doctor 등록(doctor_idx) + 전문의 번호(doctor_major).
게이트는 순수 함수 report_permission_error 하나 — 뷰어·테스트가 같은 진리표를 쓴다.
"""
from __future__ import annotations

import pytest

from app.services.account_mirror import apply_doctor_profile, ensure_mirror
from app.services.webpacs_live import live_save_report, report_permission_error
from app.services import webpacs_session


def test_permission_truth_table():
    """★ 자격 진리표 — 서비스 계정 폴백·미등록 의사·전문의 미분류 전부 차단."""
    ok = {"token": "t", "doctor_idx": 7, "doctor_id": "12345", "doctor_major": "888"}
    assert report_permission_error(ok) is None

    assert report_permission_error(None) is not None, "A 세션 없음(서비스 계정 폴백) — 차단"
    assert report_permission_error({}) is not None
    assert report_permission_error({"token": "t"}) is not None, "의사 미등록(doctor_idx 없음) — 차단"
    assert report_permission_error({"token": "t", "doctor_idx": 7}) is not None, \
        "전문의 번호(doctor_major) 미분류 — 차단(요구의 핵심)"
    assert report_permission_error({"token": "t", "doctor_idx": 7, "doctor_major": "   "}) \
        is not None, "공백 전문의 번호는 미분류다"


def test_save_report_gate_fires_before_any_remote_call():
    """★ fail-closed — 자격이 없으면 A 호출·선점 **전에** 끊는다.

    db=None 을 넘겨도 게이트가 먼저 서면 예외 형식(WebPacsConflict)으로 끝난다 —
    게이트가 뒤로 밀리면 live_client(db=None) 쪽에서 다른 예외가 튀어 이 테스트가 잡는다."""
    from app.services.webpacs_bridge import WebPacsConflict

    with pytest.raises(WebPacsConflict) as e:
        live_save_report(None, 100000001, {}, user={"sid": "없는sid"})  # type: ignore[arg-type]
    assert "판독 저장 권한" in str(e.value)


def test_save_report_gate_reads_session_doctor_fields():
    """세션에 전문의 자격이 있으면 게이트를 **통과**한다(다음 단계 live_client 로 진행).

    db=None 이므로 게이트 통과 직후 live_client 에서 실패한다 — WebPacsConflict("판독 저장
    권한")가 아니라는 것이 '게이트는 통과했다'의 증거다."""
    sid = "gate-ok-sid"
    webpacs_session.put(sid, {"base_url": "http://a", "token": "t",
                              "doctor_idx": 7, "doctor_id": "12345", "doctor_major": "888"})
    try:
        with pytest.raises(Exception) as e:
            live_save_report(None, 100000001, {}, user={"sid": sid})  # type: ignore[arg-type]
        assert "판독 저장 권한" not in str(e.value), "자격이 있는데 게이트가 막았다"
    finally:
        webpacs_session.clear(sid)


def test_login_autofills_mirror_profile(db):
    """★ A 의사 로그인 → 미러 계정의 판독의 등록(이름·면허번호) 자동 채움."""
    acc = ensure_mirror(db, user_id="a_rad1", name="박성철", role="doctor", a_user_idx=77)
    changed = apply_doctor_profile(acc, name="박성철", license_no="12345")
    db.commit()
    assert changed is True
    assert acc.display_name == "박성철"
    assert acc.license_no == "12345", "확정 서명의 면허번호가 자동으로 채워져야 한다"


def test_autofill_never_touches_local_account(db):
    """손으로 만든 로컬 계정(a_user_idx 없음)은 **절대** 덮지 않는다 — ensure_mirror 와 같은 보호."""
    from app.models import Account

    local = Account(username="local_doc", password_hash="hash", role="doctor",
                    enabled=True, display_name="원래이름", license_no="99999", a_user_idx=None)
    db.add(local)
    db.commit()
    changed = apply_doctor_profile(local, name="A쪽이름", license_no="11111")
    assert changed is False
    assert local.display_name == "원래이름"
    assert local.license_no == "99999"
