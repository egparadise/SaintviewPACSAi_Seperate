"""Saintview PACS AI — FastAPI 엔트리포인트. (Viewer Suite 독립 배포판)"""
from __future__ import annotations

import asyncio
import contextlib
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
from app.config import MULTI_WORKER_MESSAGE, detect_worker_plan, get_settings
from app.db import SessionLocal, init_db
from app.services import worker_guard
from app.services.auth_service import ensure_default_admin
from app.workers.ai_worker import worker_loop

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("saintview")

# 런타임 백스톱이 형제 워커를 세기까지의 유예(초). 2번째 워커가 마커를 쓴 뒤여야 참이 되므로
# 기동 직후에 세면 항상 1이 나온다 — uvicorn/gunicorn 이 워커를 모두 띄우고도 남는 시간을 준다.
_WORKER_GUARD_DELAY = float(os.getenv("SAINTVIEW_WORKER_GUARD_DELAY", "12"))


def _warn_worker_plan() -> None:
    """기동 선언(argv+env)에 근거한 다중 워커 경고 — dev 에서는 여기까지만 한다.

    prod 는 Settings.validate_for_prod() 가 이미 예외를 던졌다(certain 인 경우) —
    즉 이 줄에 도달했다는 것은 dev 이거나 certain=False 라는 뜻이다.
    --log-level warning 으로 뜨는 현행 기동 방식에서도 보이도록 error 레벨을 쓴다.
    """
    plan = detect_worker_plan()
    if plan["workers"] >= 2:
        logger.error("[다중 워커 감지] %s workers=%d (근거=%s, 확실=%s). %s",
                     plan["server"], plan["workers"], plan["source"],
                     plan["certain"], MULTI_WORKER_MESSAGE)
    elif not plan["certain"]:
        logger.warning(
            "워커 수를 확정할 수 없다(%s, 근거=%s) — 설정 파일이 workers 를 정하고 있을 수 있다. "
            "이 백엔드는 단일 워커가 배포 계약이니 workers=1 인지 직접 확인하라.",
            plan["server"], plan["source"])


def _warn_pixel_cookie_placement() -> None:
    """교차 호스트 배치 경고 — 픽셀 쿠키(sv_pix)가 붙지 않는 조합을 기동 시 알린다.

    조용한 실패를 막기 위한 장치다: SameSite=Lax 쿠키는 API 를 다른 사이트에 둔 배치에서
    <img> 요청에 실리지 않는다. 그러면 판독 화면에 오류 없이 '빈 화면'이 뜨는데,
    판독에서 빈 화면은 오진 위험이다. SAINTVIEW_CORS_ORIGINS 가 설정돼 있다는 것은
    다른 출처에서 이 API 를 부르겠다는 선언이므로, 그때 SameSite 를 점검하라고 알린다.
    """
    if not os.getenv("SAINTVIEW_CORS_ORIGINS", "").strip():
        return
    if os.getenv("SAINTVIEW_PIXEL_COOKIE_SAMESITE", "lax").strip().lower() == "none":
        return
    logger.warning(
        "SAINTVIEW_CORS_ORIGINS 가 설정돼 있는데 픽셀 쿠키가 SameSite=Lax 다. "
        "프론트와 API 가 다른 사이트에 있으면 Live 영상(<img>)이 401 로 뜬다 — "
        "그 배치라면 SAINTVIEW_PIXEL_COOKIE_SAMESITE=none 으로 두라(HTTPS 필수).")


async def _worker_guard_backstop(delay: float) -> None:
    """미탐(gunicorn 설정 파일 / 프로그램적 uvicorn.run) 백스톱 — 경고만 한다."""
    try:
        await asyncio.sleep(delay)
        worker_guard.check_once()
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 — 백스톱이 서버를 흔들면 본말전도다
        logger.debug("worker_guard 백스톱 실패(무시)", exc_info=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    # prod 보안 게이트 (§8). ⚠ 여기는 **워커 자식 프로세스**다 — 다중 워커일 때 예외만 던지면
    # 마스터가 워커를 계속 다시 띄워 무한 재기동 루프가 된다. 그래서 게이트가 예외 전에
    # 마스터에게 SIGTERM 을 보낸다(config.terminate_worker_master, 실측 근거는 docs §3-1).
    settings.validate_for_prod()
    _warn_worker_plan()
    _warn_pixel_cookie_placement()
    worker_guard.write_marker()
    guard_task = asyncio.create_task(_worker_guard_backstop(_WORKER_GUARD_DELAY))
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
    guard_task.cancel()
    # 취소를 실제로 회수한다 — 그냥 cancel() 만 하고 두면 종료 시
    # "Task was destroyed but it is pending" 이 로그에 남는다.
    with contextlib.suppress(asyncio.CancelledError):
        await guard_task
    worker_guard.remove_marker()
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
from app.api import export_dicom  # noqa: E402 — 검사 DICOM 반출(폴더/USB·ZIP·CD용 ISO)
app.include_router(export_dicom.router)
if insights_api is not None:
    app.include_router(insights_api.router)
if hl7_api is not None:
    app.include_router(hl7_api.router)
if infra_api is not None:
    app.include_router(infra_api.router)
if security_api is not None:
    app.include_router(security_api.router)


@app.get("/api/health")
async def health():
    """생존 확인 — **async 여야 한다.**

    sync 로 두면 FastAPI 가 anyio 스레드풀에서 돌린다. 그런데 이 백엔드는 단일 워커이고
    픽셀 경로(rendered/thumb)가 원격 A 를 최대 60초씩 기다리므로, A 가 느려지면 스레드풀이
    차서 **이 사소한 응답까지 줄에서 굶는다**. 실제로 그 일이 났다: 정적 페이지는 200 인데
    /api/health 와 로그인만 무응답이라 "서버는 떠 있는데 로그인이 안 되는" 상태로 보였다.
    이벤트 루프에서 바로 답하면 감시·로드밸런서가 적어도 **거짓말은 하지 않는다**.
    (근본 해결은 A 호출을 세마포어로 묶어 스레드풀을 다 먹지 못하게 하는 것 — webpacs_live.)
    """
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
    # 단일 워커 배포 계약 위반 노출(감지된 경우에만 True) — 운영자가 화면에서 볼 수 있게.
    guard = worker_guard.snapshot()
    return {
        "api": True,
        "orthanc": orthanc_alive,
        "orthanc_url": s.orthanc_url,
        "ai_mode": s.ai_mode,
        "mpps": s.mpps_enabled,
        "version": app.version,
        "multi_worker": guard["multi_worker"],
        "worker_count": guard["worker_count"],
    }
