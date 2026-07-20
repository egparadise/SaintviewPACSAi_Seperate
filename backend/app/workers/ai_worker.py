"""AI 작업 큐 워커 — ai_jobs 폴링 방식(단일 프로세스 MVP).

FastAPI lifespan에서 백그라운드 태스크로 구동되며,
독립 실행도 가능: python -m app.workers.ai_worker
"""
from __future__ import annotations

import asyncio
import logging

from sqlalchemy import select

from app.db import SessionLocal
from app.models import AiJob, AppSetting
from app.services.ai_service import run_draft_job

logger = logging.getLogger("saintview.ai_worker")

POLL_INTERVAL_SEC = 2.0
ORTHANC_SYNC_EVERY = 5  # 워커 폴링 N회마다 Orthanc 동기화 (≈10초)
_SYNC_SEQ_KEY = "orthanc.last_change_seq"


def sync_orthanc_once() -> int:
    """Orthanc 변경 피드 1회 동기화. last seq는 app_setting에 영속화.

    Orthanc 미가동이면 0 반환(다음 주기 재시도) — 검사 도착 자동 감지의 본체.
    """
    from app.dicom.orthanc import OrthancClient, sync_new_studies

    client = OrthancClient()
    try:
        if not client.alive():
            return 0
        with SessionLocal() as db:
            row = db.execute(
                select(AppSetting).where(
                    AppSetting.scope == "global", AppSetting.key == _SYNC_SEQ_KEY
                )
            ).scalar_one_or_none()
            since = int((row.value or {}).get("seq", 0)) if row else 0
            registered, last = sync_new_studies(db, client, since=since)
            if row is None:
                db.add(AppSetting(scope="global", scope_id="", key=_SYNC_SEQ_KEY, value={"seq": last}))
            else:
                row.value = {"seq": last}
            db.commit()
            if registered:
                logger.info("Orthanc 동기화: 신규 검사 %d건 (seq→%s)", registered, last)
            return registered
    finally:
        client.close()


def process_once() -> int:
    """대기 작업 1배치 처리. 반환: 처리 건수."""
    processed = 0
    with SessionLocal() as db:
        jobs = list(
            db.execute(
                select(AiJob).where(AiJob.status == "queued").order_by(AiJob.id).limit(20)
            ).scalars()
        )
        # AI 판독 보류 스위치 — 보류 중이면 생성하지 않고 대기 잡을 드레인(skipped)한다
        # (보류 이전에 쌓인 잡·경합으로 새어 들어온 잡이 활성화 시점에 한꺼번에 실행되는 것 방지)
        from app.services.settings_service import ai_draft_enabled

        if jobs and not ai_draft_enabled(db):
            for job in jobs:
                job.status = "skipped"
                job.error = "AI 판독 보류 중(ai.policy.draft_enabled=off) — 생성하지 않음"
            db.commit()
            logger.info("AI 판독 보류 — 대기 작업 %d건 skipped", len(jobs))
            return 0
        for job in jobs:
            try:
                run_draft_job(db, job)
                processed += 1
                logger.info("AI 초안 생성 완료 study_id=%s job=%s", job.study_id, job.id)
            except Exception:
                logger.exception("AI 작업 실패 job=%s", job.id)
    return processed


def scheduled_backup_once() -> None:
    """스케줄 백업 점검 — 정책 예정 시각 도달 시 1회 실행(저장공간/백업 2단계)."""
    from app.services.backup_service import maybe_run_scheduled_backup

    with SessionLocal() as db:
        try:
            job = maybe_run_scheduled_backup(db)
            if job is not None:
                logger.info("스케줄 백업 실행 job=%s status=%s (%d검사/%d인스턴스)",
                            job.id, job.status, job.study_count, job.instance_count)
        except Exception:
            logger.exception("스케줄 백업 점검 오류")


async def worker_loop(stop_event: asyncio.Event) -> None:
    logger.info("AI 워커 시작 (폴링 %.1fs, Orthanc 동기화 %d주기)", POLL_INTERVAL_SEC, ORTHANC_SYNC_EVERY)
    tick = 0
    while not stop_event.is_set():
        try:
            await asyncio.to_thread(process_once)
            if tick % ORTHANC_SYNC_EVERY == 0:
                await asyncio.to_thread(sync_orthanc_once)
                await asyncio.to_thread(scheduled_backup_once)
        except Exception:
            logger.exception("워커 루프 오류")
        tick += 1
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=POLL_INTERVAL_SEC)
        except asyncio.TimeoutError:
            pass
    logger.info("AI 워커 종료")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(worker_loop(asyncio.Event()))
