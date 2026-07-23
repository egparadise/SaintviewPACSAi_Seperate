"""Saintview PACS AI — FastAPI 엔트리포인트. (Viewer Suite 독립 배포판)"""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import (
    activity,
    admin,
    auth,
    backup,
    examctl,
    hospital_admin,
    hospital_storage,
    htj2k_stream,
    hospitals,
    localpacs,
    maintenance,
    mobile,
    management,
    orders,
    phrases,
    reports,
    settings as settings_api,
    share,
    signup,
    stt,
    webpacs,
    webpacs_live,
    worklist,
)

# insights 라우터(시스템 로그·통계·DB 구조 — 파일명 계약: app/api/insights.py).
# 병렬 레인(B2)이 생성하므로 아직 없으면 건너뛰고, 병합 후 자동 등록된다.
try:
    from app.api import insights as insights_api
except ImportError:
    insights_api = None
# 병렬 레인 라우터 3종 — 파일명 계약: app/api/hl7.py(레인 H)·infra.py(레인 O)·security.py(레인 S).
# 아직 없는 레인 파일은 건너뛰고, 병합 후 자동 등록된다.
try:
    from app.api import hl7 as hl7_api
except ImportError:
    hl7_api = None
try:
    from app.api import infra as infra_api
except ImportError:
    infra_api = None
try:
    from app.api import security as security_api
except ImportError:
    security_api = None
from app.config import get_settings
from app.db import SessionLocal, init_db
from app.services.auth_service import ensure_default_admin
from app.workers.ai_worker import worker_loop

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("saintview")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    settings.validate_for_prod()  # prod 보안 게이트 (§8)
    init_db()
    with SessionLocal() as db:
        ensure_default_admin(db)
    stop_event = asyncio.Event()
    worker_task = asyncio.create_task(worker_loop(stop_event))
    # MPPS SCP 리스너(장비 수행단계 수신 → 오더 상태) — 포트 충돌 등은 비치명적
    mpps = None
    if settings.mpps_enabled:
        try:
            from app.dicom.mpps_scp import start_mpps_server

            mpps = start_mpps_server(settings.mpps_port, settings.mpps_aet)
        except Exception:  # noqa: BLE001 — 리스너 실패가 앱 기동을 막지 않도록
            logger.exception("MPPS SCP 기동 실패 (포트 %d) — 비활성으로 계속", settings.mpps_port)
    logger.info("Saintview PACS AI 시작 (AI mode=%s)", settings.ai_mode)
    yield
    stop_event.set()
    await worker_task
    if mpps is not None:
        _, server = mpps
        server.shutdown()


app = FastAPI(title="Saintview PACS AI", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        # Viewer Suite 기본 오리진(5180, HTTPS 전용) + 메인 포털 3종(병행 운용 대비)
        "https://localhost:5180",
        "https://localhost:5173", "https://localhost:5174", "https://localhost:5175",
        # 외부 서버/도메인 연동 — 콤마 구분 추가 오리진 (예: https://viewer.hospital-a.com)
        *[o.strip() for o in os.getenv("SAINTVIEW_CORS_ORIGINS", "").split(",") if o.strip()],
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(worklist.router)
app.include_router(reports.router)
app.include_router(admin.router)
app.include_router(management.router)
app.include_router(signup.router)
app.include_router(hospitals.router)
app.include_router(hospital_admin.router)
app.include_router(backup.router)
app.include_router(hospital_storage.router)  # 병원별 Storage(백업 정책·수동 백업·이력·보존)
app.include_router(hospital_storage.fmt_router)  # 병원별 뷰어 영상 전송 형식(JPEG 품질/PNG)
app.include_router(htj2k_stream.router)  # HTJ2K 스트리밍 프록시(자체 OpenJPH 인코딩)
app.include_router(mobile.router)  # 휴대폰 사진 촬영(QR) — 검사 새 시리즈 등록  # 병원·계정 설정 백업/복원(/api/hospitals/{hid}/backup·restore)
app.include_router(settings_api.router)
app.include_router(orders.router)
app.include_router(phrases.router)
app.include_router(stt.router)
app.include_router(share.router)
app.include_router(maintenance.router)
app.include_router(localpacs.router)  # Local Server 모드(/api/local — 레인 B)
app.include_router(examctl.router)  # Exam Control — 관리자용 검사 QC(/api/examctl)
app.include_router(activity.router)  # 활동 하트비트 — 판독 상태(read_state) 신호
app.include_router(webpacs.router)  # WebPACS 브리지 — 인계 웹서비스(webpacs_api) 검사 가져오기
app.include_router(webpacs_live.router)  # WebPACS Live — A 직결(복사 없음, vid≥90M 라우팅)
if insights_api is not None:
    app.include_router(insights_api.router)
if hl7_api is not None:
    app.include_router(hl7_api.router)
if infra_api is not None:
    app.include_router(infra_api.router)
if security_api is not None:
    app.include_router(security_api.router)


@app.get("/api/health")
def health():
    return {"status": "ok", "ai_mode": get_settings().ai_mode}


@app.get("/api/status")
def status():
    """공개 서버 상태 — 홈(초기) 페이지 연동용. 민감정보 없이 가동 여부만."""
    s = get_settings()
    orthanc_alive = False
    try:
        from app.dicom.orthanc import OrthancClient

        client = OrthancClient()
        try:
            orthanc_alive = client.alive()
        finally:
            client.close()
    except Exception:  # noqa: BLE001 — 상태 표시용, 실패는 down으로
        orthanc_alive = False
    return {
        "api": True,
        "orthanc": orthanc_alive,
        "orthanc_url": s.orthanc_url,
        "ai_mode": s.ai_mode,
        "mpps": s.mpps_enabled,
        "version": app.version,
    }
