"""WebPACS(SaintViewPACS/webpacs_api) 브리지 — 인계 웹서비스의 검사를 우리 뷰어로.

인계 PACS(FastAPI webpacs_api: MySQL `cloud_pacs` + MinIO(AES-CBC 암호화) + Redis)의
검사를 이 Viewer Suite 로 가져와 자체 뷰어(T-View/In-View/SaintView)로 표시한다.

연동 방식(설계 결정 — docs/INTEGRATION_WEBPACS.md):
  원격 REST(`/api/study/...`)로 검사를 탐색하고, DICOMweb v2 의
  `GET /api/dicomweb/v2/studies/{s}/series/{se}/instances/{sop}` 로 **서버가 이미
  AES 복호화 + HTJ2K→원본 전송구문 정규화한 표준 DICOM 파일**을 받아
  우리 Orthanc 에 주입(POST /instances) → register_study 로 워크리스트 등록.
  - MinIO 직결/CRYPTION_KEY 불필요(인계 자료에 키 누락 — 서버측 복호화 경로만 사용).
  - 우리 뷰어의 픽셀 경로(/rendered?window=)는 Orthanc 의존이라 미러 주입이 정답.
    (인계 v2 에는 rendered 엔드포인트가 없음 — 원본 프레임+클라 WASM 디코드 방식)

인증: 원격 `POST /api/user/auth/login` {user_id, user_passwd, user_overwrite} → JWT.
      모든 원격 호출에 Authorization: Bearer. 만료 시 1회 재로그인 후 재시도.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

logger = logging.getLogger("saintview.webpacs")

SETTING_KEY = "webpacs.bridge"

# 설정 화이트리스트 — GUI(PUT /api/webpacs/config)로 저장 가능한 키만
CONFIG_KEYS = (
    "enabled",         # 브리지 사용
    "base_url",        # 원격 API 베이스 (예: https://api.inviz.co.kr 또는 http://localhost:8014)
    "user_id",         # 원격 PACS 계정 (user_type 에 'P' 포함 필요)
    "password",
    "verify_ssl",
    "hospital_id",     # 가져온 검사를 귀속할 병원 id (0/None=요청자 병원)
    "auto_sync",       # 원격 신규 검사 자동 가져오기 (워커 주기)
    "auto_sync_limit", # 자동 동기화 시 원격 최신 N건만 검사
)

DEFAULT_CONFIG: dict[str, Any] = {
    "enabled": False,
    "base_url": "",
    "user_id": "",
    "password": "",
    "verify_ssl": True,
    "hospital_id": 0,
    "auto_sync": False,
    "auto_sync_limit": 20,
}


class WebPacsError(RuntimeError):
    """원격 WebPACS 호출 실패(로그인 실패·비정상 응답 포함)."""


def get_bridge_config(db: Session) -> dict[str, Any]:
    """전역 설정(webpacs.bridge) + env 오버라이드 병합.

    env(SAINTVIEW_WEBPACS_*)는 하네스/E2E 에서 GUI 설정 없이 구동하기 위한 통로 —
    설정값보다 우선한다(테스트 관례: env > setting).
    """
    from app.services.settings_service import get_setting

    cfg = dict(DEFAULT_CONFIG)
    stored = get_setting(db, SETTING_KEY, default={}) or {}
    for k in CONFIG_KEYS:
        if k in stored:
            cfg[k] = stored[k]
    env_map = {
        "base_url": os.getenv("SAINTVIEW_WEBPACS_BASE_URL"),
        "user_id": os.getenv("SAINTVIEW_WEBPACS_USER"),
        "password": os.getenv("SAINTVIEW_WEBPACS_PASSWORD"),
    }
    for k, v in env_map.items():
        if v:
            cfg[k] = v
    if os.getenv("SAINTVIEW_WEBPACS_ENABLED") in ("0", "1"):
        cfg["enabled"] = os.getenv("SAINTVIEW_WEBPACS_ENABLED") == "1"
    if os.getenv("SAINTVIEW_WEBPACS_VERIFY_SSL") in ("0", "1"):
        cfg["verify_ssl"] = os.getenv("SAINTVIEW_WEBPACS_VERIFY_SSL") == "1"
    return cfg


class WebPacsClient:
    """webpacs_api REST + DICOMweb v2 클라이언트 (Bearer 자동 갱신)."""

    def __init__(self, base_url: str, user_id: str, password: str, *,
                 verify_ssl: bool = True, timeout: float = 60.0,
                 transport: httpx.BaseTransport | None = None):
        if not base_url:
            raise WebPacsError("WebPACS base_url 이 설정되지 않았습니다")
        self.base_url = base_url.rstrip("/")
        self.user_id = user_id
        self.password = password
        self._token: str | None = None
        kw: dict[str, Any] = {"base_url": self.base_url, "timeout": timeout}
        if transport is not None:
            kw["transport"] = transport   # 테스트(ASGITransport) 주입
        else:
            kw["verify"] = verify_ssl
        self._client = httpx.Client(**kw)

    # ── 인증 ──────────────────────────────────────────────
    def login(self) -> dict:
        r = self._client.post("/api/user/auth/login", json={
            "user_id": self.user_id, "user_passwd": self.password, "user_overwrite": True,
        })
        if r.status_code != 200:
            raise WebPacsError(f"WebPACS 로그인 실패 HTTP {r.status_code}: {r.text[:200]}")
        body = r.json()
        # 원격 응답 봉투: {status: 200|202, token, refresh_token, user_data, message}
        if not body.get("token"):
            raise WebPacsError(f"WebPACS 로그인 거부: {body.get('message', '')} (status={body.get('status')})")
        self._token = body["token"]
        return body

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        h = {"Authorization": f"Bearer {self._token}"} if self._token else {}
        if extra:
            h.update(extra)
        return h

    def _request(self, method: str, path: str, *, params: dict | None = None,
                 headers: dict[str, str] | None = None) -> httpx.Response:
        """Bearer 부착 요청 — 401(토큰 만료/무효)이면 1회 재로그인 후 재시도."""
        if self._token is None:
            self.login()
        r = self._client.request(method, path, params=params, headers=self._headers(headers))
        if r.status_code == 401:
            self.login()
            r = self._client.request(method, path, params=params, headers=self._headers(headers))
        return r

    def _json(self, path: str, params: dict | None = None) -> dict:
        r = self._request("GET", path, params=params)
        if r.status_code != 200:
            raise WebPacsError(f"WebPACS GET {path} 실패 HTTP {r.status_code}: {r.text[:200]}")
        return r.json()

    # ── 검사 탐색 (원격 REST — 내부 PK study_idx 기반) ──────
    def list_studies(self, params: dict | None = None) -> list[dict]:
        body = self._json("/api/study/", params=params or {})
        return body.get("study_data") or []

    def study_count(self, params: dict | None = None) -> int:
        body = self._json("/api/study/count", params=params or {})
        return int(body.get("study_count") or 0)

    def study_detail(self, study_idx: int) -> dict:
        body = self._json(f"/api/study/{study_idx}")
        return body.get("study_data") or {}

    def series_viewer(self, study_idx: int) -> list[dict]:
        """시리즈 + SOP 열거 — 각 항목에 series_instance_uid·images[].sop_instance_uid."""
        body = self._json(f"/api/study/{study_idx}/series/viewer")
        return body.get("series_data") or []

    # ── DICOM 취득 (DICOMweb v2 — 서버측 복호화·원본 TS 정규화) ──
    def instance_dicom(self, study_uid: str, series_uid: str, sop_uid: str) -> bytes:
        r = self._request(
            "GET",
            f"/api/dicomweb/v2/studies/{study_uid}/series/{series_uid}/instances/{sop_uid}",
            headers={"Accept": "application/dicom"},
        )
        if r.status_code != 200:
            raise WebPacsError(f"인스턴스 다운로드 실패 {sop_uid}: HTTP {r.status_code}")
        return r.content

    def close(self) -> None:
        self._client.close()


def client_from_config(cfg: dict[str, Any],
                       transport: httpx.BaseTransport | None = None) -> WebPacsClient:
    return WebPacsClient(
        cfg.get("base_url", ""), cfg.get("user_id", ""), cfg.get("password", ""),
        verify_ssl=bool(cfg.get("verify_ssl", True)), transport=transport,
    )


# ── 가져오기(Import) — 원격 검사 → 우리 Orthanc → 워크리스트 등록 ──────────
# 진행 상태는 메모리 레지스트리(단일 프로세스 MVP — 워커/요청 스레드 공유)
IMPORT_JOBS: dict[int, dict[str, Any]] = {}
_JOBS_LOCK = threading.Lock()


def _job_update(remote_idx: int, **fields) -> None:
    with _JOBS_LOCK:
        job = IMPORT_JOBS.setdefault(remote_idx, {})
        job.update(fields)


def get_import_job(remote_idx: int) -> dict[str, Any] | None:
    with _JOBS_LOCK:
        job = IMPORT_JOBS.get(remote_idx)
        return dict(job) if job else None


def find_local_study_id(db: Session, study_uid: str) -> int | None:
    from app.models import Study

    if not study_uid:
        return None
    row = db.execute(select(Study.id).where(Study.study_uid == study_uid)).first()
    return int(row[0]) if row else None


def import_study(db: Session, cfg: dict[str, Any], remote_idx: int, *,
                 hospital_id: int | None = None,
                 transport: httpx.BaseTransport | None = None) -> dict[str, Any]:
    """원격 검사 1건을 내려받아 Orthanc 주입 + 워크리스트 등록(동기).

    반환: {status: exists|done|error, study_id, study_uid, total, done, failed}
    이미 로컬에 있는 study_uid 면 재다운로드 없이 exists 반환(멱등).
    """
    from app.dicom.orthanc import OrthancClient
    from app.services.study_service import register_study

    client = client_from_config(cfg, transport=transport)
    try:
        detail = client.study_detail(remote_idx)
        study_uid = str(detail.get("study_instance_uid") or "")
        existing = find_local_study_id(db, study_uid)
        if existing:
            _job_update(remote_idx, status="exists", study_id=existing, study_uid=study_uid)
            return {"status": "exists", "study_id": existing, "study_uid": study_uid,
                    "total": 0, "done": 0, "failed": 0}

        series = client.series_viewer(remote_idx)
        targets: list[tuple[str, str, str]] = []
        for s in series:
            se_uid = str(s.get("series_instance_uid") or "")
            st_uid = str(s.get("study_instance_uid") or study_uid)
            for img in s.get("images") or []:
                sop = str(img.get("sop_instance_uid") or "")
                if st_uid and se_uid and sop:
                    targets.append((st_uid, se_uid, sop))
        if not targets:
            raise WebPacsError("가져올 인스턴스가 없습니다 (series/viewer 응답 비어 있음)")

        _job_update(remote_idx, status="running", total=len(targets), done=0, failed=0,
                    study_uid=study_uid, error=None, started_at=time.time())

        orthanc = OrthancClient()
        if not orthanc.alive():
            raise WebPacsError("우리 Orthanc 저장소에 연결할 수 없습니다")
        parent_studies: set[str] = set()
        done = failed = 0
        try:
            for st_uid, se_uid, sop in targets:
                try:
                    data = client.instance_dicom(st_uid, se_uid, sop)
                    r = orthanc.upload_dicom(data)
                    if r.get("ParentStudy"):
                        parent_studies.add(r["ParentStudy"])
                    done += 1
                except Exception as e:  # noqa: BLE001 — 인스턴스 단위 실패 격리
                    failed += 1
                    logger.warning("WebPACS 인스턴스 실패 sop=%s: %s", sop, e)
                _job_update(remote_idx, done=done, failed=failed)
            if not parent_studies:
                raise WebPacsError(f"모든 인스턴스 업로드 실패 ({failed}/{len(targets)})")

            # Orthanc 메타데이터 기준으로 등록 — import-dicom 과 동일한 검증된 경로
            study_id: int | None = None
            for sid in parent_studies:
                meta = orthanc.study_metadata(sid)
                tags = meta.get("MainDicomTags", {})
                ptags = meta.get("PatientMainDicomTags", {})
                register_study(
                    db,
                    study_uid=tags.get("StudyInstanceUID", ""),
                    patient_key=ptags.get("PatientID", "UNKNOWN"),
                    patient_name=ptags.get("PatientName", ""),
                    birth_date=ptags.get("PatientBirthDate", ""),
                    sex=ptags.get("PatientSex", ""),
                    accession_no=tags.get("AccessionNumber", ""),
                    study_date=tags.get("StudyDate", ""),
                    study_time=tags.get("StudyTime", ""),
                    modality=tags.get("ModalitiesInStudy", "").split("\\")[0]
                    if tags.get("ModalitiesInStudy") else "",
                    study_desc=tags.get("StudyDescription", ""),
                    institution=tags.get("InstitutionName", "")
                    or str(detail.get("hospital_name") or ""),
                    referring_physician=str(tags.get("ReferringPhysicianName", "")),
                    department=tags.get("InstitutionalDepartmentName", ""),
                    source_aet="WEBPACS",
                    orthanc_id=sid,
                )
                sid_local = find_local_study_id(db, tags.get("StudyInstanceUID", ""))
                if sid_local:
                    study_id = sid_local
        finally:
            orthanc.close()

        # 병원 귀속 — Import 경로와 동일(장비 AET 매핑이 없으므로 명시 귀속)
        eff_hid = hospital_id or int(cfg.get("hospital_id") or 0) or None
        if study_id and eff_hid:
            from app.models import Study

            st = db.get(Study, study_id)
            if st is not None and st.hospital_id is None:
                st.hospital_id = eff_hid
                db.commit()

        _job_update(remote_idx, status="done", study_id=study_id, done=done, failed=failed)
        return {"status": "done", "study_id": study_id, "study_uid": study_uid,
                "total": len(targets), "done": done, "failed": failed}
    except Exception as e:
        _job_update(remote_idx, status="error", error=str(e)[:300])
        raise
    finally:
        client.close()


# ── 자동 동기화 (워커 주기 — 원격 최신 N건 중 미보유 검사 가져오기) ─────────
_AUTO_SYNC_RUNNING = threading.Event()


def webpacs_sync_once() -> int:
    """원격 최신 검사 자동 가져오기 1회 (설정 enabled+auto_sync 일 때만). 반환: 신규 건수.

    다운로드가 길어져 다음 주기와 겹치지 않게 실행 중이면 스킵.
    """
    if _AUTO_SYNC_RUNNING.is_set():
        return 0
    from app.db import SessionLocal

    _AUTO_SYNC_RUNNING.set()
    try:
        with SessionLocal() as db:
            cfg = get_bridge_config(db)
            if not (cfg.get("enabled") and cfg.get("auto_sync")):
                return 0
            limit = int(cfg.get("auto_sync_limit") or 20)
            client = client_from_config(cfg)
            try:
                rows = client.list_studies({"limit": str(limit), "offset": "0"})
            finally:
                client.close()
            imported = 0
            for row in rows:
                uid = str(row.get("study_instance_uid") or "")
                idx = row.get("study_idx")
                if not uid or idx is None or find_local_study_id(db, uid):
                    continue
                try:
                    result = import_study(db, cfg, int(idx))
                    if result["status"] == "done":
                        imported += 1
                except Exception:
                    logger.exception("WebPACS 자동 동기화 실패 study_idx=%s", idx)
            if imported:
                logger.info("WebPACS 자동 동기화: 신규 검사 %d건", imported)
            return imported
    except Exception:
        logger.exception("WebPACS 자동 동기화 오류")
        return 0
    finally:
        _AUTO_SYNC_RUNNING.clear()
