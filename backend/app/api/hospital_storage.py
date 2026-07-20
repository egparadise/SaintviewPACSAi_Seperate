"""병원별 Storage — 서버 Storage 페이지의 병원 스코프 버전.

현황(그 병원 검사·시리즈·인스턴스), 백업 정책(병원별 저장), 수동 백업(그 병원 검사만),
백업 이력(kind="hospital:{hid}"), 보존 정책 미리보기/삭제(그 병원 검사만).
게이트: 시스템 관리자 또는 그 병원의 관리자.
"""
from __future__ import annotations

import shutil

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import current_user
from app.db import get_db
from app.models import AuditLog, BackupJob, Study

router = APIRouter(prefix="/api/hospitals/{hid}/storage", tags=["hospital-storage"])

# ── 병원별 클라이언트 영상 전송 형식 — 뷰어가 rendered 호출 시 사용할 포맷/품질 ──
fmt_router = APIRouter(prefix="/api/hospitals/{hid}", tags=["hospital-imgfmt"])

IMGFMT_DEFAULT = {"format": "default", "quality": 90, "wado_ts": ""}
# wado_ts: 원본 픽셀 전송(3D·정밀 뷰어) 전송구문 — ""=원본 그대로. Orthanc 트랜스코딩 지원 여부는 프로브로 판정.
WADO_TS_OPTIONS = [
    {"uid": "", "label": "기본 (저장된 원본 그대로)"},
    {"uid": "1.2.840.10008.1.2.1", "label": "비압축 (Explicit VR LE)"},
    {"uid": "1.2.840.10008.1.2.4.90", "label": "JPEG2000 무손실"},
    {"uid": "1.2.840.10008.1.2.4.91", "label": "JPEG2000 (손실)"},
    {"uid": "1.2.840.10008.1.2.4.80", "label": "JPEG-LS 무손실"},
    {"uid": "1.2.840.10008.1.2.4.70", "label": "JPEG 무손실"},
    {"uid": "1.2.840.10008.1.2.4.201", "label": "HTJ2K 무손실 (고속 디코딩·16bit·서버 자체 인코딩)"},
    {"uid": "1.2.840.10008.1.2.4.202", "label": "HTJ2K RPCL (Progressive)"},
]
_TS_SUPPORT: dict[str, bool] = {}   # 프로브 캐시(서버 기동 단위)


class ImgFmtBody(BaseModel):
    format: str = "default"   # default | jpeg | png
    quality: int = 90         # jpeg 품질(50~100)
    wado_ts: str = ""         # 원본 픽셀 전송구문("" = 원본 그대로)


@fmt_router.get("/image-format")
def imgfmt_get(hid: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """뷰어 영상 전송 형식 조회 — 그 병원 소속 사용자(뷰어)와 시스템 관리자."""
    if not (user.get("role") == "admin" and not user.get("hid")) and user.get("hid") != hid:
        raise HTTPException(status_code=403, detail="다른 병원의 설정입니다")
    from app.services.settings_service import get_setting

    return {**IMGFMT_DEFAULT, **(get_setting(db, f"viewer.image_format.h{hid}", default={}) or {})}


@fmt_router.put("/image-format")
def imgfmt_put(hid: int, body: ImgFmtBody, db: Session = Depends(get_db),
               user: dict = Depends(current_user)):
    """뷰어 영상 전송 형식 설정 — 관리자 전용. jpeg 품질은 50~100 로 보정."""
    _require_admin(user, hid)
    if body.format not in ("default", "jpeg", "png"):
        raise HTTPException(status_code=400, detail="format 은 default/jpeg/png 중 하나여야 합니다")
    if body.wado_ts and body.wado_ts not in [o["uid"] for o in WADO_TS_OPTIONS]:
        raise HTTPException(status_code=400, detail="지원 목록에 없는 전송구문입니다")
    merged = {"format": body.format, "quality": max(50, min(100, body.quality)), "wado_ts": body.wado_ts}
    from app.services.settings_service import set_setting

    set_setting(db, f"viewer.image_format.h{hid}", merged, scope="global")
    db.add(AuditLog(account_id=user.get("uid"), action="hosp_image_format",
                    target_type="setting", target_id=f"viewer.image_format.h{hid}", detail=merged))
    db.commit()
    return merged


@fmt_router.get("/image-format/ts-support")
def imgfmt_ts_support(hid: int, user: dict = Depends(current_user)):
    """전송구문별 Orthanc 트랜스코딩 지원 여부 — 첫 인스턴스 프레임으로 실측 프로브(기동 단위 캐시)."""
    if not (user.get("role") == "admin" and not user.get("hid")) and user.get("hid") != hid:
        raise HTTPException(status_code=403, detail="다른 병원의 설정입니다")
    global _TS_SUPPORT
    if not _TS_SUPPORT:
        from app.dicom.orthanc import OrthancClient

        client = OrthancClient()
        try:
            if client.alive():
                r = client._client.get("/dicom-web/instances?limit=1")  # noqa: SLF001 — 내부 프로브
                items = r.json() if r.status_code == 200 else []
                if items:
                    d = items[0]
                    stu = d["0020000D"]["Value"][0]
                    ser = d["0020000E"]["Value"][0]
                    sop = d["00080018"]["Value"][0]
                    url = f"/dicom-web/studies/{stu}/series/{ser}/instances/{sop}/frames/1"
                    from app.services.htj2k_service import encoder_available
                    _htj2k_ok = encoder_available()
                    for o in WADO_TS_OPTIONS:
                        if not o["uid"]:
                            _TS_SUPPORT[""] = True
                            continue
                        if o["uid"].startswith("1.2.840.10008.1.2.4.20"):
                            # HTJ2K — Orthanc 미지원이어도 백엔드 스트리밍 프록시(자체 OpenJPH)로 제공
                            _TS_SUPPORT[o["uid"]] = _htj2k_ok
                            continue
                        try:
                            pr = client._client.get(url, headers={  # noqa: SLF001
                                "Accept": f'multipart/related; type="application/octet-stream"; transfer-syntax={o["uid"]}'})
                            _TS_SUPPORT[o["uid"]] = pr.status_code == 200
                        except Exception:  # noqa: BLE001
                            _TS_SUPPORT[o["uid"]] = False
        finally:
            client.close()
    return {"options": [{**o, "supported": _TS_SUPPORT.get(o["uid"], False)} for o in WADO_TS_OPTIONS]}


def _require_admin(user: dict, hid: int) -> None:
    if user.get("role") == "admin" and not user.get("hid"):
        return  # 시스템 관리자
    if user.get("role") == "admin" and user.get("hid") == hid:
        return  # 병원 관리자(자기 병원)
    raise HTTPException(status_code=403, detail="Storage 관리는 관리자만 가능합니다")


def _policy_key(hid: int) -> str:
    return f"backup.policy.h{hid}"


def _get_policy(db: Session, hid: int) -> dict:
    from app.services.backup_service import DEFAULT_POLICY
    from app.services.settings_service import get_setting

    return {**DEFAULT_POLICY, **(get_setting(db, _policy_key(hid), default={}) or {})}


@router.get("/summary")
def summary(hid: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """병원 저장공간 현황 — 그 병원의 검사/시리즈/인스턴스 수 + 백업 디스크 + 보존 후보."""
    _require_admin(user, hid)
    row = db.execute(
        select(func.count(Study.id), func.coalesce(func.sum(Study.series_count), 0),
               func.coalesce(func.sum(Study.instance_count), 0))
        .where(Study.hospital_id == hid)
    ).first()
    studies, series, instances = (row or (0, 0, 0))
    policy = _get_policy(db, hid)
    # 백업 대상 디스크 여유 — 병원 정책 경로(없으면 서버 기본 backup 경로)
    from app.services.backup_service import resolve_target

    disk = {"path": "", "free_gb": None, "total_gb": None}
    try:
        root = resolve_target(policy.get("target_dir", ""))
        root.mkdir(parents=True, exist_ok=True)
        du = shutil.disk_usage(root)
        disk = {"path": str(root), "free_gb": round(du.free / 1e9, 1), "total_gb": round(du.total / 1e9, 1)}
    except Exception:  # noqa: BLE001 — 디스크 조회 실패는 표시만 생략
        pass
    # 보존 후보(그 병원 검사만)
    retention = int(policy.get("retention_days", 0) or 0)
    over = 0
    if retention > 0:
        from app.services.backup_service import retention_candidates

        over = sum(1 for s in retention_candidates(db, retention) if s.hospital_id == hid)
    return {"studies": studies, "series": series, "instances": instances,
            "disk": disk, "retention_days": retention, "retention_over": over}


class PolicyBody(BaseModel):
    enabled: bool = False
    schedule_time: str = "02:00"
    retention_days: int = 0
    compression: str = "none"
    target_dir: str = ""


@router.get("/policy")
def policy_get(hid: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    _require_admin(user, hid)
    return _get_policy(db, hid)


@router.put("/policy")
def policy_put(hid: int, body: PolicyBody, db: Session = Depends(get_db),
               user: dict = Depends(current_user)):
    _require_admin(user, hid)
    from app.services.settings_service import set_setting

    merged = body.model_dump()
    set_setting(db, _policy_key(hid), merged, scope="global")
    db.add(AuditLog(account_id=user.get("uid"), action="hosp_backup_policy",
                    target_type="setting", target_id=_policy_key(hid), detail=merged))
    db.commit()
    return merged


@router.get("/compressions")
def compressions(hid: int, user: dict = Depends(current_user)):
    _require_admin(user, hid)
    from app.services.backup_service import COMPRESSION_LABELS

    return {"items": [{"key": k, "label": v} for k, v in COMPRESSION_LABELS.items()]}


class RunBody(BaseModel):
    compression: str = ""
    target_dir: str = ""
    date_from: str = ""
    date_to: str = ""


def _run_job_in_thread(job_id: int) -> None:
    from app.db import SessionLocal
    from app.services.backup_service import run_backup_job

    with SessionLocal() as db:
        try:
            run_backup_job(db, job_id)
        except Exception:  # noqa: BLE001 — 작업 상태에 기록됨
            pass


@router.post("/backup")
def backup_run(hid: int, body: RunBody, background: BackgroundTasks,
               db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """병원 수동 백업 — kind='hospital:{hid}' 작업 생성(러너가 그 병원 검사만 백업)."""
    _require_admin(user, hid)
    from app.services.backup_service import TRANSFER_SYNTAX

    policy = _get_policy(db, hid)
    comp = body.compression or policy.get("compression", "none")
    if comp not in TRANSFER_SYNTAX:
        raise HTTPException(status_code=400, detail=f"알 수 없는 압축 포맷: {comp}")
    job = BackupJob(
        kind=f"hospital:{hid}", status="queued", compression=comp,
        target_dir=body.target_dir or policy.get("target_dir", ""),
        date_from=body.date_from.strip(), date_to=body.date_to.strip(),
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    db.add(AuditLog(account_id=user.get("uid"), action="hosp_backup_run",
                    target_type="backup_job", target_id=str(job.id),
                    detail={"hospital_id": hid, "compression": comp}))
    db.commit()
    background.add_task(_run_job_in_thread, job.id)
    return _job_dict(job)


def _job_dict(j: BackupJob) -> dict:
    return {
        "id": j.id, "kind": j.kind, "status": j.status, "compression": j.compression,
        "target_dir": j.target_dir, "date_from": j.date_from, "date_to": j.date_to,
        "study_count": j.study_count, "instance_count": j.instance_count,
        "total_bytes": j.total_bytes, "error": j.error,
        "started_at": j.started_at.isoformat() if j.started_at else None,
        "finished_at": j.finished_at.isoformat() if j.finished_at else None,
        "created_at": j.created_at.isoformat() if j.created_at else None,
    }


@router.get("/jobs")
def jobs(hid: int, limit: int = 30, db: Session = Depends(get_db),
         user: dict = Depends(current_user)):
    _require_admin(user, hid)
    rows = db.execute(
        select(BackupJob).where(BackupJob.kind == f"hospital:{hid}")
        .order_by(BackupJob.id.desc()).limit(limit)
    ).scalars().all()
    return {"items": [_job_dict(j) for j in rows]}


class PurgeBody(BaseModel):
    retention_days: int = 0
    confirm: bool = False


@router.post("/purge-preview")
def purge_preview(hid: int, body: PurgeBody, db: Session = Depends(get_db),
                  user: dict = Depends(current_user)):
    _require_admin(user, hid)
    from app.services.backup_service import retention_candidates

    if body.retention_days <= 0:
        raise HTTPException(status_code=400, detail="보존 기간(retention_days)은 1 이상이어야 합니다")
    cands = [s for s in retention_candidates(db, body.retention_days) if s.hospital_id == hid]
    return {"count": len(cands),
            "items": [{"id": s.id, "study_date": s.study_date, "modality": s.modality,
                       "study_desc": s.study_desc} for s in cands[:50]]}


@router.post("/purge")
def purge(hid: int, body: PurgeBody, db: Session = Depends(get_db),
          user: dict = Depends(current_user)):
    """보존 초과 검사 영구 삭제(그 병원만) — confirm=true 필수(파괴적). 삭제 전 백업 권장."""
    _require_admin(user, hid)
    from app.api.management import _delete_study_rows
    from app.dicom.orthanc import OrthancClient
    from app.services.backup_service import retention_candidates

    if not body.confirm:
        raise HTTPException(status_code=400, detail="삭제 확인(confirm=true)이 필요합니다")
    if body.retention_days <= 0:
        raise HTTPException(status_code=400, detail="보존 기간(retention_days)은 1 이상이어야 합니다")
    cands = [s for s in retention_candidates(db, body.retention_days) if s.hospital_id == hid]
    client = OrthancClient()
    orthanc_alive = client.alive()
    deleted = 0
    orthanc_removed = 0
    try:
        for s in cands:
            if orthanc_alive and s.orthanc_id:
                try:
                    r = client._client.delete(f"/studies/{s.orthanc_id}")  # noqa: SLF001 — 관리용 원시 삭제(서버 purge 와 동일 경로)
                    if r.status_code in (200, 204):
                        orthanc_removed += 1
                except Exception:  # noqa: BLE001
                    pass
            _delete_study_rows(db, s)
            deleted += 1
        db.add(AuditLog(account_id=user.get("uid"), action="hosp_storage_purge",
                        target_type="study", target_id=f"{deleted}건",
                        detail={"hospital_id": hid, "retention_days": body.retention_days,
                                "deleted": deleted, "orthanc_removed": orthanc_removed}))
        db.commit()
    finally:
        client.close()
    return {"ok": True, "deleted": deleted, "orthanc_removed": orthanc_removed}
