"""Compare 기준 — 환자 기준 / 판독의사 기준.

지켜야 하는 계약:
  · 기본은 **환자 기준**. 같은 환자의 과거 검사만 나온다.
  · 판독의사 기준의 모집단은 **내가 판독한 검사**뿐이다. 남이 판독한 것이 섞이면 안 된다
    (그 의사가 본 적 없는 남의 환자를 열어 주는 것이 되므로 등급이 완전히 다르다).
  · Modality·Bodypart 체크는 '지금 검사와 같은 것만' 으로 좁힌다. 둘 다 안 켜면 모집단 전체.
  · 기간은 **지금 검사의 검사일** 기준이다(오늘이 아니다).
"""
from __future__ import annotations

import pytest

from app.services import compare_basis as cb

ME = "admin"          # conftest 의 auth_headers 가 쓰는 계정
OTHER = "dr_other"


@pytest.fixture()
def world(db):
    """환자 2명 · 검사 여러 건 · 판독 귀속을 섞어 둔 표본."""
    from app.models import Patient, Report, Study

    made = {"studies": [], "patients": [], "reports": []}

    def patient(key, name):
        p = Patient(patient_key=key, name_masked=name, sex="M")
        db.add(p); db.commit(); db.refresh(p)
        made["patients"].append(p)
        return p

    def study(p, uid, date, mod, part, hid=1):
        s = Study(patient_id=p.id, study_uid=uid, study_date=date, modality=mod,
                  body_part=part, study_desc=f"{mod} {part}", status="received",
                  hospital_id=hid)
        db.add(s); db.commit(); db.refresh(s)
        made["studies"].append(s)
        return s

    def read_by(s, who):
        r = Report(study_id=s.id, version=1, status="finalized",
                   created_by=who, reviewed_by=who)
        db.add(r); db.commit(); db.refresh(r)
        made["reports"].append(r)
        return r

    pa = patient("CB-A", "환자가")
    pb = patient("CB-B", "환자나")

    w = {
        "pa": pa, "pb": pb,
        # 현재 판독 중인 검사 — 환자가, Chest CT, 2026-07-28
        "cur":      study(pa, "cb.cur", "20260728", "CT", "CHEST"),
        # 같은 환자의 과거들
        "a_ct_1y":  study(pa, "cb.a1", "20260101", "CT", "CHEST"),
        "a_xr_1y":  study(pa, "cb.a2", "20260102", "CR", "CHEST"),
        "a_ct_abd": study(pa, "cb.a3", "20260103", "CT", "ABDOMEN"),
        "a_old":    study(pa, "cb.a4", "20180101", "CT", "CHEST"),   # 8년 전
        # 다른 환자 — 내가 판독한 것 / 남이 판독한 것
        "b_mine":   study(pb, "cb.b1", "20260201", "CT", "CHEST"),
        "b_others": study(pb, "cb.b2", "20260202", "CT", "CHEST"),
        "b_mri":    study(pb, "cb.b3", "20260203", "MR", "CHEST"),
    }
    read_by(w["b_mine"], ME)
    read_by(w["b_mri"], ME)
    read_by(w["a_ct_1y"], ME)
    read_by(w["b_others"], OTHER)

    yield w

    for r in made["reports"]:
        db.delete(r)
    db.commit()
    for s in made["studies"]:
        db.delete(s)
    db.commit()
    for p in made["patients"]:
        db.delete(p)
    db.commit()


def _ids(rows):
    return {r["id"] for r in rows}


def test_patient_basis_is_same_patient_only(db, world):
    """기본(환자 기준) — 다른 환자가 절대 섞이지 않는다."""
    rows = cb.candidates(db, world["cur"].id, {"sub": ME, "hid": 1})
    assert _ids(rows) == {world["a_ct_1y"].id, world["a_xr_1y"].id,
                          world["a_ct_abd"].id, world["a_old"].id}


def test_patient_basis_narrowed_by_modality_and_part(db, world):
    """Modality·Bodypart 둘 다 체크 → 지금 검사(CT/CHEST)와 같은 것만."""
    rows = cb.candidates(db, world["cur"].id, {"sub": ME, "hid": 1},
                         by_modality=True, by_body_part=True)
    assert _ids(rows) == {world["a_ct_1y"].id, world["a_old"].id}

    # Bodypart 만 → CHEST 면 모달리티 무관(CT·CR 둘 다)
    rows = cb.candidates(db, world["cur"].id, {"sub": ME, "hid": 1}, by_body_part=True)
    assert _ids(rows) == {world["a_ct_1y"].id, world["a_xr_1y"].id, world["a_old"].id}


def test_reader_basis_only_my_readings(db, world):
    """판독의사 기준 — **내가 판독한 것만**. 남이 판독한 것은 절대 안 나온다."""
    rows = cb.candidates(db, world["cur"].id, {"sub": ME, "hid": 1}, basis="reader")
    got = _ids(rows)
    assert world["b_others"].id not in got, "남이 판독한 검사가 섞였다"
    assert got == {world["a_ct_1y"].id, world["b_mine"].id, world["b_mri"].id}


def test_reader_basis_narrowing(db, world):
    """Chest CT 를 보는 중: 둘 다 체크 → 내가 판독한 Chest CT / Bodypart 만 → Chest 전부."""
    both = cb.candidates(db, world["cur"].id, {"sub": ME, "hid": 1}, basis="reader",
                         by_modality=True, by_body_part=True)
    assert _ids(both) == {world["a_ct_1y"].id, world["b_mine"].id}

    part_only = cb.candidates(db, world["cur"].id, {"sub": ME, "hid": 1}, basis="reader",
                              by_body_part=True)
    # Chest MRI 도 들어온다(모달리티를 안 좁혔으므로)
    assert world["b_mri"].id in _ids(part_only)


def test_period_window_excludes_older_than_range(db, world):
    """8년 전 검사는 1년/3년/5년 창에서 빠지고 '전체' 에서만 나온다."""
    for period in ("1y", "3y", "5y"):
        rows = cb.candidates(db, world["cur"].id, {"sub": ME, "hid": 1}, period=period)
        assert world["a_old"].id not in _ids(rows), period
    rows = cb.candidates(db, world["cur"].id, {"sub": ME, "hid": 1}, period="all")
    assert world["a_old"].id in _ids(rows)


def test_period_is_anchored_on_the_study_not_today(db):
    """기간 기준점은 **지금 검사의 검사일**이지 오늘이 아니다.

    ⚠ 이 테스트는 '현재 검사'가 **오늘과 멀리 떨어져 있어야** 의미가 있다. 예전 판을
    되짚어 판독하는 상황이 정확히 그런 경우이고, 기준점을 오늘로 잡으면 그 환자의
    과거 검사가 통째로 창 밖으로 밀려 하나도 안 나온다.
    (처음 쓴 판은 현재 검사일이 마침 오늘이라, 기준점을 오늘로 바꿔도 결과가 같아
    **아무것도 지키지 못했다** — 되돌려 실패하는지 확인해 잡아냈다.)
    """
    from app.models import Patient, Study

    p = Patient(patient_key="CB-OLD", name_masked="옛환자", sex="F")
    db.add(p); db.commit(); db.refresh(p)
    mk = lambda uid, d: Study(patient_id=p.id, study_uid=uid, study_date=d,   # noqa: E731
                              modality="CT", body_part="CHEST", study_desc="CT",
                              status="received", hospital_id=1)
    cur = mk("cb.old.cur", "20200601")     # 현재 검사 — 6년 전
    prior = mk("cb.old.p1", "20200101")    # 그보다 5개월 전 → 검사일 기준 '1년 이내'
    db.add_all([cur, prior]); db.commit(); db.refresh(cur); db.refresh(prior)
    try:
        rows = cb.candidates(db, cur.id, {"sub": ME, "hid": 1}, period="1y")
        # 검사일(20200601) 기준 1년 이내라 나와야 한다.
        # 오늘(2026) 기준이면 하한이 2025 라 20200101 은 통째로 빠진다 → 이 단정이 깨진다.
        assert _ids(rows) == {prior.id}, rows
    finally:
        db.delete(prior); db.delete(cur); db.commit()
        db.delete(p); db.commit()


def test_period_prev_returns_single_latest(db, world):
    """'바로 직전' 은 가장 최근 1건만."""
    rows = cb.candidates(db, world["cur"].id, {"sub": ME, "hid": 1}, period="prev")
    assert len(rows) == 1
    assert rows[0]["id"] == world["a_ct_abd"].id   # 20260103 이 가장 최근


def test_other_hospital_never_leaks(db, world):
    """다른 병원 사용자에게는 아무것도 안 나온다."""
    assert cb.candidates(db, world["cur"].id, {"sub": ME, "hid": 99}) == []


def test_api_contract(client, auth_headers, world):
    """HTTP 계약 — 기본이 환자 기준이고, 응답이 고른 조건을 그대로 되돌려준다."""
    sid = world["cur"].id
    r = client.get(f"/api/studies/{sid}/compare-candidates", headers=auth_headers)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["basis"] == "patient" and d["period"] == "all"
    assert d["by_modality"] is False and d["by_body_part"] is False
    assert {x["id"] for x in d["items"]} == {world["a_ct_1y"].id, world["a_xr_1y"].id,
                                            world["a_ct_abd"].id, world["a_old"].id}

    r = client.get(f"/api/studies/{sid}/compare-candidates"
                   "?basis=reader&modality=1&body_part=1&period=3y", headers=auth_headers)
    d = r.json()
    assert d["basis"] == "reader" and d["by_modality"] is True
    assert world["b_others"].id not in {x["id"] for x in d["items"]}

    # 인증 없이는 안 된다
    assert client.get(f"/api/studies/{sid}/compare-candidates").status_code == 401
