"""서버 유지관리(Maintenance) API — 저장공간 현황·백업 정책 v2·백업 실행/이력·복원·미러링·데이터 지우기.

관리자 콘솔 서버 섹션(요구 2·3·4·11·12·13) 백엔드. 전부 admin 전용,
파괴 작업(restore 실행/wipe)은 감사 로그 + confirm 토큰 필수.
계층: 라우터(검증·감사) → services/backup_service(실동작).
"""
from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.api.deps import admin_user
from app.db import get_db
from app.models import AuditLog, BackupJob, Hospital, Study
from app.services.backup_service import (
    TRANSFER_SYNTAX,
    dir_size_bytes,
    enforce_quota,
    get_policy,
    resolve_target,
    run_backup_job,
    run_db_backup,
    run_mirror,
    set_policy,
)

router = APIRouter(prefix="/api/maintenance", tags=["maintenance"])

_MB = 1024 * 1024
_GB = 1024 * 1024 * 1024


def _audit(db: Session, user: dict, action: str, target: str, detail: dict) -> None:
    db.add(AuditLog(account_id=user.get("uid"), action=action,
                    target_type="maintenance", target_id=target[:64], detail=detail))


# ════════════════════════════════ 저장공간 현황 (요구 2·3) ════════════════════════════════
def _db_size(db: Session) -> dict:
    """DB 저장 공간 — PostgreSQL은 pg_database_size, SQLite는 파일 크기."""
    from app.config import get_settings

    s = get_settings()
    dialect = db.bind.dialect.name if db.bind else "?"
    try:
        if dialect == "postgresql":
            size = db.execute(text("SELECT pg_database_size(current_database())")).scalar() or 0
            return {"size_mb": round(size / _MB, 2), "detail": "PostgreSQL pg_database_size"}
        if s.database_url.startswith("sqlite"):
            p = Path(s.database_url.split("///", 1)[1])
            size = p.stat().st_size if p.exists() else 0
            return {"size_mb": round(size / _MB, 2), "detail": f"SQLite 파일 · {p.name}"}
        return {"size_mb": 0, "detail": f"{dialect} — 크기 조회 미지원"}
    except Exception as e:  # noqa: BLE001 — 현황 표시용, 실패는 상세로 강등
        return {"size_mb": 0, "detail": f"조회 실패: {str(e)[:120]}"}


def _image_storage() -> dict:
    """Image Storage 공간 — Orthanc /statistics + 서버 디스크 여유(우아 강등)."""
    out = {"size_mb": 0, "instances": 0, "disk_free_gb": 0, "disk_total_gb": 0}
    try:
        usage = shutil.disk_usage(Path(__file__).resolve().anchor or "/")
        out["disk_free_gb"] = round(usage.free / _GB, 2)
        out["disk_total_gb"] = round(usage.total / _GB, 2)
    except OSError:
        pass
    try:
        from app.dicom.orthanc import OrthancClient

        client = OrthancClient()
        try:
            if client.alive():
                st = client.statistics()
                out["size_mb"] = round(int(st.get("TotalDiskSize", 0) or 0) / _MB, 2)
                out["instances"] = int(st.get("CountInstances", 0) or 0)
                out["orthanc_ok"] = True
            else:
                out["orthanc_ok"] = False
        finally:
            client.close()
    except Exception:  # noqa: BLE001 — Orthanc 미가용은 0/false 로 보고
        out["orthanc_ok"] = False
    return out


@router.get("/storage")
def storage(db: Session = Depends(get_db), user: dict = Depends(admin_user)):
    """저장공간 통합 현황 — {db, image, backup} (요구 2·3)."""
    policy = get_policy(db)
    backup_root = resolve_target(policy.get("target_dir", ""))
    return {
        "db": _db_size(db),
        "image": _image_storage(),
        "backup": {
            "path": str(backup_root),
            "size_mb": round(dir_size_bytes(backup_root) / _MB, 2),
            "quota_gb": float(policy.get("quota_gb") or 0),
        },
    }


# ════════════════════════════════ 백업 정책 v2 (요구 4·11) ════════════════════════════════
def _policy_out(policy: dict) -> dict:
    """내부 정책 → API 계약 형태({at, repeat, format, path, ...})."""
    at = str(policy.get("schedule_time", "02:00"))
    if len(at.split(":")) == 2:
        at += ":00"
    return {
        "enabled": bool(policy.get("enabled")),
        "at": at,
        "repeat": policy.get("repeat", "daily"),
        "weekday": int(policy.get("weekday") or 0),
        "day": int(policy.get("day") or 1),
        "retention_days": int(policy.get("retention_days") or 0),
        "format": policy.get("compression", "none"),
        "path": policy.get("target_dir", ""),
        "quota_gb": float(policy.get("quota_gb") or 0),
        "mirror_path": policy.get("mirror_path", ""),
        "db_backup": bool(policy.get("db_backup")),
    }


@router.get("/backup-policy")
def backup_policy_get(db: Session = Depends(get_db), user: dict = Depends(admin_user)):
    return _policy_out(get_policy(db))


class BackupPolicyV2Body(BaseModel):
    enabled: bool = False
    at: str = "02:00:00"                 # HH:MM:SS
    repeat: str = "daily"                # daily|weekly|monthly|quarterly|yearly
    weekday: int | None = None           # weekly: 0=월 … 6=일
    day: int | None = None               # monthly/quarterly/yearly: 실행 일
    retention_days: int = 0
    format: str = "none"                 # 압축 포맷(기존 compression 키)
    path: str = ""                       # 백업 공간 경로
    quota_gb: float | None = None        # 용량 상한(GB, 0=무제한)
    mirror_path: str | None = None       # 미러링 경로
    db_backup: bool = False              # DB 덤프 동반 여부


@router.put("/backup-policy")
def backup_policy_put(body: BackupPolicyV2Body, db: Session = Depends(get_db),
                      user: dict = Depends(admin_user)):
    if body.format not in TRANSFER_SYNTAX:
        raise HTTPException(status_code=400, detail=f"알 수 없는 압축 포맷: {body.format}")
    patch: dict = {
        "enabled": body.enabled, "schedule_time": body.at.strip(), "repeat": body.repeat,
        "retention_days": body.retention_days, "compression": body.format,
        "target_dir": body.path.strip(), "db_backup": body.db_backup,
    }
    if body.weekday is not None:
        patch["weekday"] = body.weekday
    if body.day is not None:
        patch["day"] = body.day
    if body.quota_gb is not None:
        patch["quota_gb"] = body.quota_gb
    if body.mirror_path is not None:
        patch["mirror_path"] = body.mirror_path.strip()
    saved = set_policy(db, patch)
    _audit(db, user, "backup_policy_v2", "backup.policy", _policy_out(saved))
    db.commit()
    return _policy_out(saved)


# ════════════════════════════════ 백업 실행/이력 (요구 4) ════════════════════════════════
def _job_item(j: BackupJob) -> dict:
    """BackupJob → 통합 이력 항목({id,kind,ts,size_mb,path,status})."""
    return {
        "id": j.id,
        "kind": "db" if j.kind == "db" else "dicom",
        "ts": (j.created_at.isoformat() if j.created_at else None),
        "size_mb": round((j.total_bytes or 0) / _MB, 2),
        "path": j.target_dir,
        "status": j.status,
        "detail": {"source": j.kind, "compression": j.compression,
                   "studies": j.study_count, "instances": j.instance_count,
                   "error": j.error or ""},
    }


def _run_dicom_job_thread(job_id: int) -> None:
    """백그라운드 DICOM 백업 — 자체 세션, 종료 후 quota 정리."""
    from app.db import SessionLocal

    with SessionLocal() as bg:
        try:
            run_backup_job(bg, job_id)
            policy = get_policy(bg)
            quota = float(policy.get("quota_gb") or 0)
            if quota > 0:
                enforce_quota(resolve_target(policy.get("target_dir", "")), quota)
        except Exception:  # noqa: BLE001 — 작업 상태에 기록됨
            pass


class BackupRunBody(BaseModel):
    kind: str = "dicom"  # dicom | db | both


@router.post("/backup-run")
def backup_run(body: BackupRunBody, background: BackgroundTasks,
               db: Session = Depends(get_db), user: dict = Depends(admin_user)):
    """수동 백업 실행 — dicom(백그라운드)·db(pg_dump/SQLite 복사, 동기)·both."""
    if body.kind not in ("dicom", "db", "both"):
        raise HTTPException(status_code=400, detail="kind는 dicom|db|both")
    policy = get_policy(db)
    items: list[dict] = []
    if body.kind in ("db", "both"):
        job = run_db_backup(db, target_dir=policy.get("target_dir", ""))
        items.append(_job_item(job))
    if body.kind in ("dicom", "both"):
        job = BackupJob(kind="manual", status="queued",
                        compression=policy.get("compression", "none"),
                        target_dir=policy.get("target_dir", ""), date_from="", date_to="")
        db.add(job)
        db.commit()
        db.refresh(job)
        background.add_task(_run_dicom_job_thread, job.id)
        items.append(_job_item(job))
    _audit(db, user, "maintenance_backup_run", body.kind,
           {"kind": body.kind, "jobs": [i["id"] for i in items]})
    db.commit()
    return {"ok": True, "items": items}


@router.get("/backups")
def backups(limit: int = 50, db: Session = Depends(get_db), user: dict = Depends(admin_user)):
    """백업 이력 통합(DICOM 수동/스케줄 + DB 덤프)."""
    rows = db.execute(select(BackupJob).order_by(BackupJob.id.desc()).limit(limit)).scalars().all()
    return {"items": [_job_item(j) for j in rows]}


# ════════════════════════════════ 복원 (요구 12·13) ════════════════════════════════
class RestoreBody(BaseModel):
    backup_id: int
    scope: str = "system"      # system | hospital
    hid: int | None = None
    dry: bool = False


def _restore_summary(job: BackupJob) -> dict:
    root = Path(job.target_dir) if job.target_dir else resolve_target("")
    files = 0
    size = 0
    if job.kind == "db":
        if root.is_file():
            files, size = 1, root.stat().st_size
    elif root.exists():
        for p in root.rglob("*.dcm"):
            files += 1
            size += p.stat().st_size
    size_mb = round(size / _MB, 2)
    return {
        "backup": _job_item(job),
        "files_found": files,
        "size_mb": size_mb,
        "studies": job.study_count,
        "instances": job.instance_count,
        # UI 계약(summary): 사람이 읽는 한 줄 요약 — 프론트 미리보기/완료 메시지에 그대로 노출
        "summary": (f"복원 대상 파일 {files}개 ({size_mb} MB) · "
                    f"검사 {job.study_count or 0}건 · 인스턴스 {job.instance_count or 0}건"),
    }


@router.post("/restore")
def restore(body: RestoreBody, db: Session = Depends(get_db), user: dict = Depends(admin_user)):
    """백업 시점 복원 — dry=true는 요약만. DICOM=Orthanc 재업로드+등록,
    DB=pg_restore 직접 실행은 위험하므로 파일 준비+수동 절차 안내로 우아 강등."""
    if body.scope not in ("system", "hospital"):
        raise HTTPException(status_code=400, detail="scope는 system|hospital")
    if body.scope == "hospital":
        if body.hid is None or not db.get(Hospital, body.hid):
            raise HTTPException(status_code=400, detail="hospital 범위에는 유효한 hid가 필요합니다")
    job = db.get(BackupJob, body.backup_id)
    if not job:
        raise HTTPException(status_code=404, detail="백업을 찾을 수 없습니다")
    if job.status != "done":
        raise HTTPException(status_code=409, detail=f"완료된 백업만 복원할 수 있습니다(현재: {job.status})")

    summary = _restore_summary(job)
    if body.dry:
        return {"ok": True, "dry": True, "scope": body.scope, "hid": body.hid, **summary}

    # ── DB 백업: 실행하지 않고 수동 복원 안내(파괴적 pg_restore 우아 강등) ──
    if job.kind == "db":
        cmd = (f"pg_restore --clean --if-exists -d <DB_URL> \"{job.target_dir}\""
               if job.target_dir.endswith(".dump")
               else f"서버 중지 후 SQLite 파일을 교체: {job.target_dir}")
        _audit(db, user, "maintenance_restore", f"backup:{job.id}",
               {"kind": "db", "executed": False, "scope": body.scope})
        db.commit()
        return {"ok": True, "dry": False, "executed": False, "kind": "db",
                "prepared_file": job.target_dir,
                "summary": f"DB 복원 파일 준비됨 — {job.target_dir} (자동 실행 안 함, 아래 안내대로 수동 복원)",
                "guidance": ("DB 복원은 서비스 중단이 필요한 파괴 작업이므로 자동 실행하지 않습니다. "
                             f"준비된 덤프로 수동 실행하세요: {cmd}")}

    # ── DICOM 백업: Orthanc 재업로드 + 검사 등록 ──
    import pydicom

    from app.dicom.orthanc import OrthancClient
    from app.services.study_service import register_study

    root = Path(job.target_dir) if job.target_dir else resolve_target("")
    if not root.exists():
        raise HTTPException(status_code=409, detail=f"백업 경로가 없습니다: {root}")
    client = OrthancClient()
    uploaded = failed = 0
    study_uids: dict[str, str] = {}  # study_uid → orthanc parent study id
    try:
        if not client.alive():
            raise HTTPException(status_code=503, detail="Orthanc에 연결할 수 없어 복원할 수 없습니다")
        for p in sorted(root.rglob("*.dcm")):
            data = p.read_bytes()
            try:
                res = client.upload_dicom(data)
                uploaded += 1
            except Exception:  # noqa: BLE001 — 실패 건은 카운트로 보고
                failed += 1
                continue
            try:
                import io

                ds = pydicom.dcmread(io.BytesIO(data), stop_before_pixels=True)
                uid = str(getattr(ds, "StudyInstanceUID", "") or "")
                if uid and uid not in study_uids:
                    study_uids[uid] = str(res.get("ParentStudy", ""))
                    s = register_study(
                        db, study_uid=uid,
                        patient_key=str(getattr(ds, "PatientID", "") or "UNKNOWN"),
                        patient_name=str(getattr(ds, "PatientName", "") or ""),
                        study_date=str(getattr(ds, "StudyDate", "") or ""),
                        modality=str(getattr(ds, "Modality", "") or ""),
                        study_desc=str(getattr(ds, "StudyDescription", "") or ""),
                        accession_no=str(getattr(ds, "AccessionNumber", "") or ""),
                        orthanc_id=study_uids[uid],
                    )
                    if body.scope == "hospital":
                        s.hospital_id = body.hid
            except Exception:  # noqa: BLE001 — 태그 파싱 실패해도 업로드는 유지
                pass
    finally:
        client.close()
    _audit(db, user, "maintenance_restore", f"backup:{job.id}",
           {"kind": "dicom", "executed": True, "scope": body.scope, "hid": body.hid,
            "uploaded": uploaded, "failed": failed, "studies": len(study_uids)})
    db.commit()
    return {"ok": True, "dry": False, "executed": True, "kind": "dicom",
            "uploaded": uploaded, "failed": failed, "studies_registered": len(study_uids),
            "summary": f"업로드 {uploaded}건 · 실패 {failed}건 · 검사 등록 {len(study_uids)}건"}


# ════════════════════════════════ 데이터 지우기 (요구 13) ════════════════════════════════
class WipeBody(BaseModel):
    scope: str            # hospital | system
    hid: int | None = None
    confirm: str = ""     # 반드시 'WIPE'


@router.post("/wipe")
def wipe(body: WipeBody, db: Session = Depends(get_db), user: dict = Depends(admin_user)):
    """데이터 지우기 — hospital=해당 병원 검사·리포트·Orthanc 정리, system=전체.

    파괴 작업: confirm='WIPE' 필수 + 감사 로그. 백업/복원과 조합해 '지우고 복원' 흐름을 구성.
    """
    if body.confirm != "WIPE":
        raise HTTPException(status_code=400, detail="확인 토큰(confirm='WIPE')이 필요합니다")
    if body.scope not in ("hospital", "system"):
        raise HTTPException(status_code=400, detail="scope는 hospital|system")
    if body.scope == "hospital":
        if body.hid is None or not db.get(Hospital, body.hid):
            raise HTTPException(status_code=400, detail="hospital 범위에는 유효한 hid가 필요합니다")
        studies = db.execute(select(Study).where(Study.hospital_id == body.hid)).scalars().all()
    else:
        studies = db.execute(select(Study)).scalars().all()

    from app.api.hospital_admin import _orthanc_delete_study  # 기존 삭제 로직 재사용
    from app.api.management import _delete_study_rows

    deleted = orthanc_removed = 0
    for s in studies:
        if _orthanc_delete_study(s.orthanc_id):
            orthanc_removed += 1
        _delete_study_rows(db, s)
        deleted += 1
    _audit(db, user, "maintenance_wipe", f"{body.scope}:{body.hid or 'all'}",
           {"scope": body.scope, "hid": body.hid,
            "deleted": deleted, "orthanc_removed": orthanc_removed})
    db.commit()
    return {"ok": True, "scope": body.scope, "hid": body.hid,
            "deleted": deleted, "orthanc_removed": orthanc_removed}


# ════════════════════════════════ 서버 포털 리스너 (서버 설정 IP:Port 연동) ════════════════════════════════
# server.network.web(IP·Port) 저장분과 별개로, 지정 주소에 리다이렉트 리스너를 (재)기동한다.
# 저장만 하고 리스너가 없어 연결 거부되던 문제를 해소 — 접속 시 랜딩 포털로 302.
class PortalApplyBody(BaseModel):
    ip: str = ""
    port: int = 0


def _landing_url(db: Session) -> str:
    """리다이렉트 대상 랜딩 포털 URL — server.network.web.landing_url 설정이 있으면 사용(없으면 빈값)."""
    from app.services.settings_service import get_setting

    net = get_setting(db, "server.network", default={}) or {}
    web = net.get("web", {}) if isinstance(net, dict) else {}
    return str((web or {}).get("landing_url", "") or "").strip()


@router.post("/portal/apply")
def portal_apply(body: PortalApplyBody, db: Session = Depends(get_db),
                 user: dict = Depends(admin_user)):
    """지정 ip:port 에 포털 리다이렉트 리스너 (재)기동. 바인드 실패는 400+원인."""
    from app.services import portal_listener

    res = portal_listener.start(body.ip, body.port, target_url=_landing_url(db))
    _audit(db, user, "portal_apply", f"{body.ip}:{body.port}",
           {"ip": body.ip, "port": body.port, "ok": bool(res.get("ok")),
            "detail": res.get("detail", "")})
    db.commit()
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("detail", "포털 리스너 기동 실패"))
    return {"ok": True, "warning": res.get("warning", ""), **portal_listener.status()}


@router.post("/portal/stop")
def portal_stop(db: Session = Depends(get_db), user: dict = Depends(admin_user)):
    """포털 리스너 중지."""
    from app.services import portal_listener

    res = portal_listener.stop()
    _audit(db, user, "portal_stop", "portal", {"stopped": bool(res.get("stopped"))})
    db.commit()
    return {"ok": True, **portal_listener.status()}


@router.get("/portal/status")
def portal_status(user: dict = Depends(admin_user)):
    """포털 리스너 현재 상태 — {running, host, port, target, since, error}."""
    from app.services import portal_listener

    return portal_listener.status()


# ════════════════════════════════ 미러링 (요구 11) ════════════════════════════════
@router.post("/mirror-run")
def mirror_run(db: Session = Depends(get_db), user: dict = Depends(admin_user)):
    """시스템 미러링 — 백업 산출물을 mirror_path 로 증분 복사."""
    policy = get_policy(db)
    mp = str(policy.get("mirror_path") or "").strip()
    if not mp:
        raise HTTPException(status_code=400, detail="백업 정책에 mirror_path 가 설정되어 있지 않습니다")
    result = run_mirror(resolve_target(policy.get("target_dir", "")), mp)
    _audit(db, user, "maintenance_mirror_run", mp,
           {"copied": result["copied"], "skipped": result["skipped"],
            "bytes": result["bytes"], "errors": result["errors"][:10]})
    db.commit()
    return {"ok": True, "mirror_path": mp, **result}


# ════════════════════════════ 한글 인코딩 복구 (EUC-KR mojibake) ════════════════════════════
def _recover_kr(s: str | None) -> str | None:
    """Latin-1 로 잘못 디코딩된 EUC-KR 텍스트 복구 — 정상 UTF-8 한글은 보존(멱등).

    깨진 행만 latin-1 재인코딩이 성공(코드포인트 0-255)하므로, 실패(=정상 한글)는 원문 유지.
    추가 가드: 복구 결과에 한글 음절이 없으면 원문 유지 — 정상 서양어(예 'SÃO PAULO')가
    우연히 유효 CP949 바이트쌍을 이뤄 한자 잡음으로 오변환되는 것을 차단.
    """
    if not s or all(ord(c) < 128 for c in s):
        return s
    try:
        fixed = s.encode("latin-1").decode("cp949")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s
    return fixed if any("가" <= c <= "힣" for c in fixed) else s


class RepairEncodingBody(BaseModel):
    dry_run: bool = True   # true=변경 없이 대상 건수·표본만 반환


@router.post("/repair-encoding")
def repair_encoding(body: RepairEncodingBody, db: Session = Depends(get_db),
                    user: dict = Depends(admin_user)):
    """DB에 깨진 채 저장된 한글(EUC-KR→Latin-1 mojibake)을 일괄 복구.

    원인: Orthanc DefaultEncoding 미설정(Latin1) 시기에 수신된 검사 메타데이터.
    latin-1 인코딩 성공 + 복구 결과 한글 포함이 '깨진 행' 판별이라 반복 실행해도 안전(멱등).
    전 병원 데이터를 스캔하고 samples 에 환자명이 포함되므로 시스템 관리자 전용.
    """
    from app.api.hospitals import _is_system_admin
    from app.models import Order, Patient, Series

    if not _is_system_admin(user):
        raise HTTPException(status_code=403, detail="시스템 관리자 전용 기능입니다 (전 병원 데이터 스캔)")

    targets = [
        (Study, ["study_desc", "clinical_info", "institution", "referring_physician", "department"]),
        (Patient, ["name_masked"]),
        (Series, ["series_desc"]),
        (Order, ["patient_name", "procedure_desc", "department"]),
        (Hospital, ["departments"]),
    ]
    fixed = 0
    samples: list[dict] = []
    for model, cols in targets:
        # yield_per — 대용량 테이블 전량 메모리 적재 방지(스트리밍 스캔)
        for row in db.execute(select(model).execution_options(yield_per=500)).scalars():
            for col in cols:
                cur = getattr(row, col, None)
                new = _recover_kr(cur)
                if new != cur:
                    if len(samples) < 20:
                        samples.append({"table": model.__tablename__, "col": col,
                                        "before": cur, "after": new})
                    if not body.dry_run:
                        setattr(row, col, new)
                    fixed += 1
    if not body.dry_run:
        _audit(db, user, "maintenance_repair_encoding", "all", {"fixed": fixed})
        db.commit()
    return {"ok": True, "dry_run": body.dry_run, "fixed": fixed, "samples": samples}
