"""AI 판독 초안 보류(마스터 스위치) — 기본 off·env 오버라이드·드레인 검증.

운영 기본값은 보류(off): RAG Structured Report 개편 전까지 자동/수동 생성 전면 차단.
conftest 는 SAINTVIEW_AI_DRAFT_ENABLED=1 로 기존 생성 테스트를 살리므로,
여기서는 monkeypatch 로 env 를 지워 실제 운영 기본 동작을 검증한다.
"""
from datetime import datetime, timezone

from app.models import AiJob
from app.services.settings_service import ai_draft_enabled, get_setting, set_setting
from app.services.study_service import queue_ai_job, register_study
from app.workers.ai_worker import process_once


def _mk_study(db, uid_suffix: str):
    return register_study(
        db,
        study_uid=f"1.2.840.99999.hold.{uid_suffix}",
        patient_key=f"HOLD{uid_suffix}",
        patient_name=f"Hold^Test{uid_suffix}",
        modality="CT",
        study_desc="AI hold test",
        study_date=datetime.now(timezone.utc).strftime("%Y%m%d"),
    )


def test_draft_disabled_by_default(db, monkeypatch):
    monkeypatch.delenv("SAINTVIEW_AI_DRAFT_ENABLED", raising=False)
    prev = get_setting(db, "ai.policy", default=None)
    set_setting(db, "ai.policy", {}, scope="global")   # draft_enabled 미설정 = 기본 보류
    try:
        assert ai_draft_enabled(db) is False
        study = _mk_study(db, "1")
        assert queue_ai_job(db, study) is None   # 자동/수동 공통 관문에서 차단
    finally:
        set_setting(db, "ai.policy", prev or {}, scope="global")


def test_analyze_endpoint_409_when_held(client, auth_headers, db, monkeypatch):
    monkeypatch.delenv("SAINTVIEW_AI_DRAFT_ENABLED", raising=False)
    prev = get_setting(db, "ai.policy", default=None)
    set_setting(db, "ai.policy", {"draft_enabled": False}, scope="global")
    try:
        study = _mk_study(db, "2")
        r = client.post(f"/api/studies/{study.id}/analyze", headers=auth_headers)
        assert r.status_code == 409
        assert "보류" in r.json()["detail"]
    finally:
        set_setting(db, "ai.policy", prev or {}, scope="global")


def test_worker_drains_queued_jobs_when_held(db, monkeypatch):
    monkeypatch.delenv("SAINTVIEW_AI_DRAFT_ENABLED", raising=False)
    prev = get_setting(db, "ai.policy", default=None)
    set_setting(db, "ai.policy", {"draft_enabled": False}, scope="global")
    try:
        study = _mk_study(db, "3")
        # 보류 이전에 쌓였던 잡 시나리오 — 직접 큐 삽입 후 워커가 skipped 로 드레인하는지
        job = AiJob(study_id=study.id, kind="draft", status="queued")
        db.add(job)
        db.commit()
        assert process_once() == 0
        db.refresh(job)
        assert job.status == "skipped"
        assert "보류" in (job.error or "")
    finally:
        set_setting(db, "ai.policy", prev or {}, scope="global")


def test_setting_enables_draft(db, monkeypatch):
    monkeypatch.delenv("SAINTVIEW_AI_DRAFT_ENABLED", raising=False)
    prev = get_setting(db, "ai.policy", default=None)
    set_setting(db, "ai.policy", {"draft_enabled": True}, scope="global")
    try:
        assert ai_draft_enabled(db) is True
        study = _mk_study(db, "4")
        job = queue_ai_job(db, study)
        assert job is not None and job.status == "queued"
        # 남긴 잡은 정리(다른 테스트의 process_once 가 실생성하지 않도록)
        job.status = "skipped"
        db.commit()
    finally:
        set_setting(db, "ai.policy", prev or {}, scope="global")


def test_env_override_wins_over_setting(db, monkeypatch):
    prev = get_setting(db, "ai.policy", default=None)
    set_setting(db, "ai.policy", {"draft_enabled": True}, scope="global")
    try:
        monkeypatch.setenv("SAINTVIEW_AI_DRAFT_ENABLED", "0")
        assert ai_draft_enabled(db) is False   # env=0 이 설정 on 보다 우선
        monkeypatch.setenv("SAINTVIEW_AI_DRAFT_ENABLED", "1")
        assert ai_draft_enabled(db) is True
    finally:
        set_setting(db, "ai.policy", prev or {}, scope="global")
