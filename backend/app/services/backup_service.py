"""백업/저장공간 서비스 — 설정 기간 데이터 백업 + 압축(JPEG/JPEG2000 등) + 보존 정책.

실동작: Orthanc에서 인스턴스를 받아 지정 전송구문으로 트랜스코드해 백업 디렉토리에 기록.
폴백: 압축 코덱 플러그인이 없으면 원본(비압축)으로 저장하고 fallback 카운트를 남긴다.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import BackupJob, Study
from app.services.settings_service import get_setting, set_setting

# 압축 포맷 → DICOM 전송구문 UID (백업 시 적용)
# ⚠ orthancteam/orthanc 이미지는 JPEG2000/JPEG-LS/JPEG 무손실 트랜스코딩을 기본 지원(실측 확인).
#   JPEG 베이스라인(4.50)은 8비트 영상 전용 — 16비트 CT/MR은 변환 불가 시 원본 폴백.
TRANSFER_SYNTAX: dict[str, str] = {
    "none": "1.2.840.10008.1.2.1",            # Explicit VR Little Endian (비압축)
    "jpeg2000_lossless": "1.2.840.10008.1.2.4.90",
    "jpeg2000": "1.2.840.10008.1.2.4.91",     # 손실
    "jpegls_lossless": "1.2.840.10008.1.2.4.80",  # JPEG-LS 무손실 (16비트 권장)
    "jpeg_lossless": "1.2.840.10008.1.2.4.70",
    "jpeg": "1.2.840.10008.1.2.4.50",         # JPEG Baseline (손실, 8비트 전용)
    "htj2k_lossless": "1.2.840.10008.1.2.4.201",  # HTJ2K 무손실 — Orthanc 미지원 → 자체 OpenJPH 인코딩
}
COMPRESSION_LABELS: dict[str, str] = {
    "none": "비압축 DICOM",
    "jpeg2000_lossless": "JPEG2000 무손실",
    "jpeg2000": "JPEG2000 (손실)",
    "jpegls_lossless": "JPEG-LS 무손실",
    "jpeg_lossless": "JPEG 무손실",
    "jpeg": "JPEG 베이스라인 (손실·8비트 전용)",
    "htj2k_lossless": "HTJ2K 무손실 (OpenJPH 자체 인코딩·고속 디코딩)",
}

BACKUP_POLICY_KEY = "backup.policy"
REPEATS = ("daily", "weekly", "monthly", "quarterly", "yearly")
DEFAULT_POLICY = {
    "enabled": False,
    "schedule_time": "02:00",     # HH:MM 또는 HH:MM:SS (스케줄 백업 시각)
    "retention_days": 0,          # 0=무제한(보존 정책 미적용)
    "compression": "none",
    "target_dir": "",             # 비우면 backend/backup
    # ── v2 확장(관리자 콘솔 서버 섹션) ──
    "repeat": "daily",            # daily|weekly|monthly|quarterly|yearly
    "weekday": 0,                 # weekly: 0=월 … 6=일
    "day": 1,                     # monthly/quarterly/yearly: 실행 일(1~31, 말일 초과분은 말일로 보정)
    "quota_gb": 0,                # 백업 공간 용량 상한(GB, 0=무제한) — 초과 시 오래된 백업 정리
    "mirror_path": "",            # 미러링 대상 경로(비우면 미러링 없음)
    "db_backup": False,           # 스케줄 백업 시 DB 덤프도 함께 수행
}


def _safe(name: str) -> str:
    """경로 구성요소 안전화 — traversal·구분자 제거."""
    s = re.sub(r"[^A-Za-z0-9._-]", "_", str(name or "").strip())
    return (s or "unknown")[:96]


def get_policy(db: Session) -> dict:
    return {**DEFAULT_POLICY, **(get_setting(db, BACKUP_POLICY_KEY, default={}) or {})}


def set_policy(db: Session, policy: dict) -> dict:
    cur = get_policy(db)
    merged = {**cur, **{k: policy[k] for k in DEFAULT_POLICY if k in policy}}
    # 검증
    if merged["compression"] not in TRANSFER_SYNTAX:
        merged["compression"] = "none"
    # 시각은 실제 유효 범위(00~23시, 00~59분·초)만 허용 — '99:99' 등은 저장돼도 영원히 실행되지 않으므로 보정
    if not re.match(r"^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$", str(merged["schedule_time"])):
        merged["schedule_time"] = "02:00"
    merged["retention_days"] = max(0, int(merged.get("retention_days") or 0))
    if merged.get("repeat") not in REPEATS:
        merged["repeat"] = "daily"
    merged["weekday"] = min(6, max(0, int(merged.get("weekday") or 0)))
    merged["day"] = min(31, max(1, int(merged.get("day") or 1)))
    merged["quota_gb"] = max(0.0, float(merged.get("quota_gb") or 0))
    merged["mirror_path"] = str(merged.get("mirror_path") or "").strip()
    merged["db_backup"] = bool(merged.get("db_backup"))
    set_setting(db, BACKUP_POLICY_KEY, merged, scope="global")
    return merged


def _default_backup_dir() -> Path:
    # backend/app/services/backup_service.py → parents[2] = backend
    return Path(__file__).resolve().parents[2] / "backup"


def resolve_target(target_dir: str) -> Path:
    return Path(target_dir).expanduser() if target_dir.strip() else _default_backup_dir()


def _studies_in_range(db: Session, date_from: str, date_to: str) -> list[Study]:
    q = select(Study).where(Study.orthanc_id != "")
    if date_from:
        q = q.where(Study.study_date >= date_from)
    if date_to:
        q = q.where(Study.study_date <= date_to)
    return list(db.execute(q.order_by(Study.study_date)).scalars().all())


def run_backup_job(db: Session, job_id: int, *, client=None) -> BackupJob:
    """백업 작업 실행 — 인스턴스별 트랜스코드 후 디렉토리에 기록. job 상태/통계 갱신."""
    from app.dicom.orthanc import OrthancClient

    job = db.get(BackupJob, job_id)
    if job is None:
        raise ValueError(f"BackupJob {job_id} 없음")
    job.status = "running"
    job.started_at = datetime.now(timezone.utc)
    db.commit()

    own_client = client is None
    client = client or OrthancClient()
    ts_uid = TRANSFER_SYNTAX.get(job.compression, TRANSFER_SYNTAX["none"])
    root = resolve_target(job.target_dir)
    fallbacks = 0
    try:
        if not client.alive():
            raise RuntimeError("Orthanc에 연결할 수 없습니다")
        studies = _studies_in_range(db, job.date_from, job.date_to)
        # 병원 스코프 백업 — kind="hospital:{hid}" 작업은 해당 병원 검사만
        if (job.kind or "").startswith("hospital:"):
            try:
                _hid = int(job.kind.split(":", 1)[1])
                studies = [st for st in studies if st.hospital_id == _hid]
            except ValueError:
                pass
        total_bytes = 0
        inst_count = 0
        done_studies = 0
        for study in studies:
            try:
                instances = client.study_instances(study.orthanc_id)
            except httpx.HTTPError:
                continue
            sdir = root / _safe(study.study_date or "nodate") / _safe(study.study_uid)
            sdir.mkdir(parents=True, exist_ok=True)
            if job.compression == "htj2k_lossless":
                # HTJ2K — Orthanc 가 트랜스코딩하지 못하므로 자체 OpenJPH(WASM/Node) 배치 인코딩
                from app.services.htj2k_service import encode_study_htj2k

                try:
                    b, n, fb = encode_study_htj2k(client, study, sdir)
                    total_bytes += b
                    inst_count += n
                    fallbacks += fb
                    done_studies += 1
                except Exception:  # noqa: BLE001 — 검사 단위 실패는 건너뛰고 계속
                    pass
                continue
            for inst in instances:
                oid = inst["orthanc_id"]
                try:
                    data = client.instance_file(oid, transcode=ts_uid if job.compression != "none" else None)
                except httpx.HTTPError:
                    # 트랜스코드 실패 → 원본으로 폴백
                    try:
                        data = client.instance_file(oid)
                        fallbacks += 1
                    except httpx.HTTPError:
                        continue
                fname = f"{_safe(inst.get('sop_uid') or oid)}.dcm"
                (sdir / fname).write_bytes(data)
                total_bytes += len(data)
                inst_count += 1
            done_studies += 1
        job.study_count = done_studies
        job.instance_count = inst_count
        job.total_bytes = total_bytes
        job.status = "done"
        if fallbacks:
            job.error = f"압축 폴백(원본 저장) {fallbacks}건 — Orthanc 코덱 플러그인 확인"
    except Exception as e:  # noqa: BLE001 — 작업 결과로 기록
        job.status = "failed"
        job.error = str(e)[:500]
    finally:
        job.finished_at = datetime.now(timezone.utc)
        db.commit()
        if own_client:
            client.close()
    return job


def storage_overview(db: Session) -> dict:
    """저장공간 현황 — Orthanc 디스크 사용량 + DB 카운트 + 백업 대상 디스크 여유 + 보존 후보."""
    import shutil

    from app.dicom.orthanc import OrthancClient

    policy = get_policy(db)
    out: dict = {"policy": policy, "orthanc": None}
    out["db"] = {
        "studies": db.execute(select(func.count()).select_from(Study)).scalar() or 0,
    }
    # Orthanc 통계
    client = OrthancClient()
    try:
        if client.alive():
            st = client.statistics()
            out["orthanc"] = {
                "alive": True,
                "studies": st.get("CountStudies"),
                "series": st.get("CountSeries"),
                "instances": st.get("CountInstances"),
                "disk_size": int(st.get("TotalDiskSize", 0) or 0),
                "uncompressed_size": int(st.get("TotalUncompressedSize", 0) or 0),
            }
        else:
            out["orthanc"] = {"alive": False}
    except httpx.HTTPError as e:
        out["orthanc"] = {"alive": False, "error": str(e)[:200]}
    finally:
        client.close()
    # 백업 대상 디스크 여유
    target = resolve_target(policy.get("target_dir", ""))
    try:
        check = target if target.exists() else target.parent
        usage = shutil.disk_usage(check)
        out["disk"] = {"path": str(target), "total": usage.total,
                       "used": usage.used, "free": usage.free}
    except OSError as e:
        out["disk"] = {"path": str(target), "error": str(e)[:200]}
    # 보존 정책 후보(설정 기간 초과 검사)
    rd = int(policy.get("retention_days") or 0)
    if rd > 0:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=rd)).strftime("%Y%m%d")
        out["retention"] = {
            "cutoff_date": cutoff, "retention_days": rd,
            "candidate_studies": db.execute(
                select(func.count()).select_from(Study).where(
                    Study.study_date != "", Study.study_date < cutoff
                )
            ).scalar() or 0,
        }
    else:
        out["retention"] = {"retention_days": 0, "candidate_studies": 0}
    return out


LAST_SCHEDULED_KEY = "backup.last_scheduled"


def schedule_due(policy: dict, now: datetime) -> bool:
    """반복 규칙(일/주/월/분기/연) 기준으로 오늘이 실행일이고 예정 시각을 지났는지 판정."""
    import calendar

    repeat = policy.get("repeat", "daily")
    if repeat == "weekly":
        if now.weekday() != int(policy.get("weekday") or 0):
            return False
    elif repeat in ("monthly", "quarterly", "yearly"):
        day = int(policy.get("day") or 1)
        last_day = calendar.monthrange(now.year, now.month)[1]
        if now.day != min(day, last_day):  # 말일 초과 설정(예: 31)은 말일로 보정
            return False
        if repeat == "quarterly" and now.month not in (1, 4, 7, 10):
            return False
        if repeat == "yearly" and now.month != 1:
            return False
    try:
        parts = [int(p) for p in str(policy["schedule_time"]).split(":")]
        hh, mm = parts[0], parts[1]
        ss = parts[2] if len(parts) > 2 else 0
    except (ValueError, KeyError, IndexError):
        return False
    return (now.hour * 3600 + now.minute * 60 + now.second) >= (hh * 3600 + mm * 60 + ss)


def maybe_run_scheduled_backup(db: Session, *, now: datetime | None = None, client=None) -> BackupJob | None:
    """스케줄 백업 — 정책이 enabled이고 반복 규칙상 실행일·예정 시각을 지났고 오늘 미실행이면 1회 실행.

    실행 후: quota_gb 초과분 오래된 백업 정리, db_backup 이면 DB 덤프도 수행.
    """
    policy = get_policy(db)
    if not policy.get("enabled"):
        return None
    now = now or datetime.now()  # 로컬 벽시계 기준(스케줄 시각도 로컬)
    today = now.strftime("%Y%m%d")
    last = (get_setting(db, LAST_SCHEDULED_KEY, default={}) or {}).get("date", "")
    if last == today:
        return None
    if not schedule_due(policy, now):
        return None
    set_setting(db, LAST_SCHEDULED_KEY, {"date": today}, scope="global")
    job = BackupJob(
        kind="scheduled", status="queued", compression=policy.get("compression", "none"),
        target_dir=policy.get("target_dir", ""), date_from="", date_to="",
    )
    db.add(job)
    db.commit()
    run_backup_job(db, job.id, client=client)
    if policy.get("db_backup"):
        try:
            run_db_backup(db, target_dir=policy.get("target_dir", ""))
        except Exception:  # noqa: BLE001 — DB 덤프 실패가 DICOM 백업 결과를 막지 않도록
            pass
    quota = float(policy.get("quota_gb") or 0)
    if quota > 0:
        removed = enforce_quota(resolve_target(policy.get("target_dir", "")), quota)
        if removed:
            db.refresh(job)
            note = f"용량 상한({quota}GB) 초과 — 오래된 백업 {len(removed)}건 정리"
            job.error = (job.error + " · " if job.error else "") + note
            db.commit()
    return job


def retention_candidates(db: Session, retention_days: int) -> list[Study]:
    if retention_days <= 0:
        return []
    cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).strftime("%Y%m%d")
    return list(db.execute(
        select(Study).where(Study.study_date != "", Study.study_date < cutoff)
    ).scalars().all())


# ════════════════════════════════ v2 — 용량 상한·DB 덤프·미러링 ════════════════════════════════
def dir_size_bytes(root: Path) -> int:
    """디렉토리 총 크기(바이트) — 미존재/접근불가 항목은 0으로 우아 강등."""
    total = 0
    try:
        if root.is_file():
            return root.stat().st_size
        for p in root.rglob("*"):
            try:
                if p.is_file():
                    total += p.stat().st_size
            except OSError:
                continue
    except OSError:
        return total
    return total


def enforce_quota(root: Path, quota_gb: float) -> list[str]:
    """백업 공간 용량 상한 강제 — 초과 시 최상위 항목을 오래된 순으로 삭제(최신 1건은 보존).

    반환: 삭제한 항목 이름 목록(감사 로그 기록용).
    """
    import shutil as _shutil

    removed: list[str] = []
    if quota_gb <= 0 or not root.exists():
        return removed
    limit = int(quota_gb * (1024 ** 3))
    try:
        entries = sorted(root.iterdir(), key=lambda p: p.stat().st_mtime)
    except OSError:
        return removed
    while len(entries) > 1 and dir_size_bytes(root) > limit:
        victim = entries.pop(0)  # 가장 오래된 항목부터
        try:
            if victim.is_dir():
                _shutil.rmtree(victim)
            else:
                victim.unlink()
            removed.append(victim.name)
        except OSError:
            break  # 삭제 불가 시 중단(무한루프 방지)
    return removed


def run_db_backup(db: Session, *, target_dir: str = "") -> BackupJob:
    """DB 백업 — PostgreSQL은 pg_dump 서버측 실행(-Fc), SQLite는 파일 복사 폴백.

    결과는 BackupJob(kind='db')로 이력 통합(target_dir=산출 파일 경로).
    """
    import shutil as _shutil
    import subprocess

    from app.config import get_settings

    s = get_settings()
    root = resolve_target(target_dir or get_policy(db).get("target_dir", ""))
    job = BackupJob(kind="db", status="running", compression="none",
                    target_dir=str(root), date_from="", date_to="",
                    started_at=datetime.now(timezone.utc))
    db.add(job)
    db.commit()
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    try:
        root.mkdir(parents=True, exist_ok=True)
        url = s.database_url
        if url.startswith("sqlite"):
            src = Path(url.split("///", 1)[1])
            if not src.exists():
                raise RuntimeError(f"SQLite 파일을 찾을 수 없습니다: {src}")
            out = root / f"db_{ts}.sqlite"
            _shutil.copy2(src, out)
        elif url.startswith("postgresql"):
            # pg_dump는 dialect 접미(+psycopg 등) 없는 표준 URI만 받는다
            dsn = re.sub(r"^postgresql\+\w+", "postgresql", url)
            out = root / f"db_{ts}.dump"
            proc = subprocess.run(  # noqa: S603 — 서버측 관리 작업(고정 인자)
                ["pg_dump", "-Fc", "-f", str(out), dsn],
                capture_output=True, text=True, timeout=600,
            )
            if proc.returncode != 0:
                raise RuntimeError(f"pg_dump 실패: {(proc.stderr or '')[:300]}")
        else:
            raise RuntimeError(f"지원하지 않는 DB URL: {url.split(':', 1)[0]}")
        job.target_dir = str(out)
        job.total_bytes = out.stat().st_size
        job.status = "done"
    except FileNotFoundError:
        job.status = "failed"
        job.error = "pg_dump 실행 파일을 찾을 수 없습니다 — PostgreSQL 클라이언트 도구를 설치하세요"
    except Exception as e:  # noqa: BLE001 — 작업 결과로 기록
        job.status = "failed"
        job.error = str(e)[:500]
    finally:
        job.finished_at = datetime.now(timezone.utc)
        db.commit()
    return job


def run_mirror(root: Path, mirror_path: str) -> dict:
    """백업 산출물 → 미러 경로 증분 복사(동일 크기 파일은 건너뜀)."""
    import shutil as _shutil

    dest_root = Path(mirror_path).expanduser()
    copied = skipped = 0
    bytes_copied = 0
    errors: list[str] = []
    if not root.exists():
        return {"copied": 0, "skipped": 0, "bytes": 0, "errors": ["백업 경로가 없습니다"]}
    for src in root.rglob("*"):
        if not src.is_file():
            continue
        rel = src.relative_to(root)
        dst = dest_root / rel
        try:
            if dst.exists() and dst.stat().st_size == src.stat().st_size:
                skipped += 1
                continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            _shutil.copy2(src, dst)
            copied += 1
            bytes_copied += src.stat().st_size
        except OSError as e:
            errors.append(f"{rel}: {str(e)[:80]}")
    return {"copied": copied, "skipped": skipped, "bytes": bytes_copied, "errors": errors}
