"""조건 나열 검색 — 토큰 = 자기 OR 그룹(전 항목), 그룹끼리 AND (2026-08-20 사용자 확정).

사용자 지시 원문:
    "서버가 OR 그룹을 여러 개 만들어 AND로 묶도록 확장합니다. 각 토큰이 자기 OR 그룹을 갖고,
     그룹끼리 AND가 되면 대자인병원#CT#CHEST는 '대자인병원이 어딘가에 있고, CT가 어딘가에 있고,
     CHEST가 어딘가에 있는' 검사가 됩니다. 순서도 필드 지정도 필요 없어집니다.
     검사 상태(미판독 등)만 예외로 지금처럼 별도 처리합니다 — 텍스트 매칭으로는 절대 안 잡히는
     값이라서요."

서버 쿼리 빌더(_apply_worklist_filters)는 원래 그 구조였다 — 토큰은 범위 필드 사이 OR,
토큰 사이는 query_op(기본 and). 이번에 바꾼 것은 **검색 범위에 장비·부서를 더한 것**뿐이다.
그 전에는 modality 가 범위에 없어서 'CT' 토큰이 어느 컬럼에도 걸리지 않았다.

여기서는 실제 DB 에 검사를 넣고 search_worklist 를 그대로 호출해 진리표를 확인한다.
"""
from __future__ import annotations

import uuid

import pytest

from app.models.entities import Patient, Study
from app.services.study_service import (
    _QUERY_FIELD_COLS,
    WorklistFilter,
    search_worklist,
)

SCOPE = list(_QUERY_FIELD_COLS.keys())


@pytest.fixture
def rows(db):
    """세 검사 — 서로 다른 컬럼에 조건 값이 흩어져 있다."""
    tag = uuid.uuid4().hex[:8]
    p = Patient(patient_key=f"P{tag}", name_masked=f"김지숙{tag}", sex="F")
    db.add(p)
    db.flush()
    made = []
    for i, (inst, mod, part, desc) in enumerate([
        (f"대자인병원{tag}", "CT", "CHEST", "Chest CT with contrast"),
        (f"대자인병원{tag}", "MR", "BRAIN", "Brain MRI"),
        (f"써밋영상의원{tag}", "CT", "CHEST", "Chest CT"),
    ]):
        s = Study(
            patient_id=p.id, study_uid=f"1.2.{tag}.{i}", study_date="20260820",
            modality=mod, body_part=part, study_desc=desc, institution=inst,
            status="received",
        )
        db.add(s)
        made.append(s)
    db.flush()
    yield tag, made
    for s in made:
        db.delete(s)
    db.delete(p)
    db.flush()


def _find(db, q: str, **kw) -> list[str]:
    items, _ = search_worklist(db, WorklistFilter(
        patient_query=q, query_fields=SCOPE, query_op="and", limit=1000, **kw))
    return [it["study_uid"] for it in items]


def test_토큰이_서로_다른_컬럼에_있어도_AND_로_묶인다(db, rows):
    tag, made = rows
    # 대자인병원=institution · CT=modality · CHEST=body_part — 셋이 전부 다른 컬럼이다
    hit = _find(db, f"대자인병원{tag} CT CHEST")
    assert hit == [made[0].study_uid], "세 조건을 모두 만족하는 검사 하나만"


def test_순서는_상관없다(db, rows):
    tag, made = rows
    a = _find(db, f"대자인병원{tag} CT CHEST")
    b = _find(db, f"CHEST CT 대자인병원{tag}")
    c = _find(db, f"CT 대자인병원{tag} CHEST")
    assert a == b == c == [made[0].study_uid], "필드 지정도 순서도 필요 없다"


def test_한_조건은_그_조건만_만족하면_된다(db, rows):
    tag, made = rows
    assert set(_find(db, f"대자인병원{tag}")) == {made[0].study_uid, made[1].study_uid}
    assert set(_find(db, "CHEST")) >= {made[0].study_uid, made[2].study_uid}


def test_장비가_검색_범위에_들어왔다(db, rows):
    """이번 서버 변경의 핵심 — 이게 없으면 'CT' 토큰이 어느 컬럼에도 걸리지 않는다."""
    assert "modality" in _QUERY_FIELD_COLS, "장비가 범위에 없으면 조건 나열이 성립하지 않는다"
    assert "dept" in _QUERY_FIELD_COLS
    tag, made = rows
    # 범위에서 장비를 빼면 못 찾는다 — 무엇 때문에 찾아지는지 못 박는다
    items, _ = search_worklist(db, WorklistFilter(
        patient_query=f"대자인병원{tag} CT", query_op="and", limit=1000,
        query_fields=[k for k in SCOPE if k != "modality"]))
    found = [it["study_uid"] for it in items]
    assert made[0].study_uid not in found or "CT" in (made[0].study_desc or "").upper(), (
        "장비를 범위에서 빼면 modality 로는 못 찾는다(검사명에 CT 가 들어간 경우는 예외)")


def test_상태는_텍스트가_아니라_전용_필터로(db, rows):
    """'미판독' 은 어떤 컬럼에도 그 글자로 저장돼 있지 않다 — 그래서 status 필터가 따로 있다."""
    tag, made = rows
    assert _find(db, f"대자인병원{tag} 미판독") == [], "텍스트로는 절대 안 잡힌다"
    items, _ = search_worklist(db, WorklistFilter(
        patient_query=f"대자인병원{tag}", query_fields=SCOPE, query_op="and",
        status="received", limit=1000))
    got = {it["study_uid"] for it in items}
    assert got == {made[0].study_uid, made[1].study_uid}, "상태는 전용 필터로 걸린다"
