"""S0 스모크: 합성 DICOM → Orthanc 업로드 → QIDO 확인 → DB 동기화 → AI 초안.

Orthanc(docker compose) 미가동 시 SKIP으로 종료(회귀 기준선 — CLAUDE.md §6).
실행: py -3.11 harness/smoke_dicom_pipeline.py
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

# AI 판독 초안은 운영 기본 보류(off) — 스모크는 생성 파이프라인 자체를 검증하므로 env 로 강제 활성
os.environ.setdefault("SAINTVIEW_AI_DRAFT_ENABLED", "1")

from make_sample_dicom import make_ct_instance  # noqa: E402


def main() -> int:
    from pydicom.uid import generate_uid

    from app.db import SessionLocal, init_db
    from app.dicom.orthanc import OrthancClient, sync_new_studies
    from app.models import Study
    from app.workers.ai_worker import process_once

    client = OrthancClient()
    if not client.alive():
        print("SKIP: Orthanc 미가동 (deploy/docker-compose.yml 먼저 기동)")
        return 0

    init_db()

    # 1) 합성 DICOM 3장 업로드 (STOW 대체: Orthanc REST)
    study_uid = generate_uid()
    series_uid = generate_uid()
    pid = f"SMK{int(time.time()) % 100000}"
    for i in range(1, 4):
        ds = make_ct_instance(
            patient_id=pid, study_uid=study_uid, series_uid=series_uid, instance_number=i
        )
        import io

        buf = io.BytesIO()
        ds.save_as(buf, write_like_original=False)
        client.upload_dicom(buf.getvalue())
    print(f"[1/4] 업로드 완료 StudyUID={study_uid}")

    # 2) QIDO로 검색 확인
    found = None
    for _ in range(30):  # StableStudy 대기
        studies = client.qido_studies(StudyInstanceUID=study_uid)
        if studies:
            found = studies
            break
        time.sleep(1)
    assert found, "QIDO에서 검사 미발견"
    print("[2/4] QIDO-RS 검색 OK")

    # 3) 변경 피드 동기화 → studies 테이블 (StableStudy까지 폴링)
    #    ⚠ since=0 고정이면 피드 첫 100건만 반복 스캔 — seq 커서를 따라가야 한다(운영 워커와 동일)
    synced = False
    last_seq = 0
    with SessionLocal() as db:
        for _ in range(40):
            _, new_seq = sync_new_studies(db, client, since=last_seq)
            if db.query(Study).filter_by(study_uid=study_uid).first():
                synced = True
                break
            if new_seq == last_seq:  # 피드 끝 — StableStudy 대기
                time.sleep(2)
            last_seq = new_seq
    assert synced, "DB 동기화 실패 (StableStudy 미도달?)"
    print("[3/4] DB 동기화 OK")

    # 4) AI 워커 → 초안 생성 확인
    for _ in range(5):
        process_once()
        with SessionLocal() as db:
            s = db.query(Study).filter_by(study_uid=study_uid).first()
            if s and s.status == "draft_ready":
                print(f"[4/4] AI 초안 생성 OK (study_id={s.id})")
                print("SMOKE PASS")
                return 0
        time.sleep(1)
    print("FAIL: AI 초안 미생성")
    return 1


if __name__ == "__main__":
    sys.exit(main())
