"""서버 유지관리(B1) — 저장공간·백업 정책 v2(반복/quota/미러/DB덤프)·복원·지우기.

계약: GET /api/maintenance/storage · GET|PUT /backup-policy · POST /backup-run ·
GET /backups · POST /restore(dry) · POST /wipe(confirm='WIPE') · POST /mirror-run.
"""
from __future__ import annotations

import time
from datetime import datetime

from sqlalchemy import select

from app.models import AuditLog, BackupJob, Hospital, Study
from app.services.backup_service import enforce_quota, schedule_due
from app.services.study_service import register_study


# ════════════════════════════════ 정책 v2 왕복 ════════════════════════════════
def test_policy_v2_roundtrip(client, auth_headers, tmp_path):
    body = {
        "enabled": True, "at": "03:15:30", "repeat": "weekly", "weekday": 2,
        "retention_days": 14, "format": "jpeg2000_lossless", "path": str(tmp_path),
        "quota_gb": 5.5, "mirror_path": str(tmp_path / "mirror"), "db_backup": True,
    }
    r = client.put("/api/maintenance/backup-policy", headers=auth_headers, json=body)
    assert r.status_code == 200, r.text
    got = client.get("/api/maintenance/backup-policy", headers=auth_headers).json()
    assert got["at"] == "03:15:30" and got["repeat"] == "weekly" and got["weekday"] == 2
    assert got["format"] == "jpeg2000_lossless" and got["quota_gb"] == 5.5
    assert got["mirror_path"].endswith("mirror") and got["db_backup"] is True
    # 기존(v1) 정책 엔드포인트와 같은 저장소 공유 — HH:MM:SS 그대로 유지
    v1 = client.get("/api/admin/backup/policy", headers=auth_headers).json()
    assert v1["schedule_time"] == "03:15:30" and v1["compression"] == "jpeg2000_lossless"


def test_policy_v2_validation(client, auth_headers):
    # 알 수 없는 압축 포맷은 400
    r = client.put("/api/maintenance/backup-policy", headers=auth_headers,
                   json={"format": "bogus"})
    assert r.status_code == 400
    # 잘못된 repeat/시각은 안전값으로 보정(daily / 02:00)
    r2 = client.put("/api/maintenance/backup-policy", headers=auth_headers,
                    json={"repeat": "hourly", "at": "no-time", "format": "none"})
    assert r2.status_code == 200
    assert r2.json()["repeat"] == "daily"
    assert r2.json()["at"] == "02:00:00"
    # 범위 밖 시각(99:99)은 저장되면 영원히 실행되지 않으므로 안전값으로 보정
    r3 = client.put("/api/maintenance/backup-policy", headers=auth_headers,
                    json={"at": "99:99:99", "format": "none"})
    assert r3.status_code == 200
    assert r3.json()["at"] == "02:00:00"
    # 정상 경계값(23:59:59)은 그대로 유지
    r4 = client.put("/api/maintenance/backup-policy", headers=auth_headers,
                    json={"at": "23:59:59", "format": "none"})
    assert r4.json()["at"] == "23:59:59"


def test_maintenance_requires_admin(client):
    assert client.get("/api/maintenance/storage").status_code == 401


# ════════════════════════════════ 스케줄 반복 규칙 ════════════════════════════════
def test_schedule_due_repeat_rules():
    base = {"schedule_time": "02:00:00", "repeat": "daily", "weekday": 0, "day": 15}
    # daily: 시각만 지나면 due
    assert schedule_due(base, datetime(2026, 7, 10, 3, 0)) is True
    assert schedule_due(base, datetime(2026, 7, 10, 1, 59)) is False
    # weekly: 지정 요일(2=수)만
    weekly = {**base, "repeat": "weekly", "weekday": 2}
    assert schedule_due(weekly, datetime(2026, 7, 8, 3, 0)) is True   # 수요일
    assert schedule_due(weekly, datetime(2026, 7, 9, 3, 0)) is False  # 목요일
    # monthly: 지정 일(15)만
    monthly = {**base, "repeat": "monthly"}
    assert schedule_due(monthly, datetime(2026, 7, 15, 3, 0)) is True
    assert schedule_due(monthly, datetime(2026, 7, 16, 3, 0)) is False
    # monthly 말일 보정: day=31, 2월은 말일(28)에 실행
    eom = {**base, "repeat": "monthly", "day": 31}
    assert schedule_due(eom, datetime(2026, 2, 28, 3, 0)) is True
    # quarterly: 1/4/7/10월의 지정 일만
    quarterly = {**base, "repeat": "quarterly", "day": 1}
    assert schedule_due(quarterly, datetime(2026, 4, 1, 3, 0)) is True
    assert schedule_due(quarterly, datetime(2026, 5, 1, 3, 0)) is False
    # yearly: 1월의 지정 일만
    yearly = {**base, "repeat": "yearly", "day": 1}
    assert schedule_due(yearly, datetime(2026, 1, 1, 3, 0)) is True
    assert schedule_due(yearly, datetime(2026, 2, 1, 3, 0)) is False
    # HH:MM:SS 초 단위 비교
    sec = {**base, "schedule_time": "02:00:30"}
    assert schedule_due(sec, datetime(2026, 7, 10, 2, 0, 29)) is False
    assert schedule_due(sec, datetime(2026, 7, 10, 2, 0, 30)) is True


# ════════════════════════════════ quota 정리 ════════════════════════════════
def test_enforce_quota_removes_oldest(tmp_path):
    # 오래된 순으로 3개 항목(각 ~1KB) 생성
    for i, name in enumerate(["old", "mid", "new"]):
        d = tmp_path / name
        d.mkdir()
        (d / "f.dcm").write_bytes(b"x" * 1024)
        t = time.time() - (3 - i) * 3600
        import os

        os.utime(d, (t, t))
    # 상한 ~2KB → 가장 오래된 'old' 삭제
    removed = enforce_quota(tmp_path, 2 * 1024 / (1024 ** 3))
    assert "old" in removed
    assert (tmp_path / "new").exists(), "최신 백업은 보존"
    # 상한 0(무제한) → 아무것도 삭제 안 함
    assert enforce_quota(tmp_path, 0) == []
    # 극단 상한이어도 최신 1건은 남긴다
    removed2 = enforce_quota(tmp_path, 1 / (1024 ** 3))
    assert (tmp_path / "new").exists()
    assert "mid" in removed2


# ════════════════════════════════ 저장공간 현황 ════════════════════════════════
def test_storage_overview_contract(client, auth_headers):
    r = client.get("/api/maintenance/storage", headers=auth_headers)
    assert r.status_code == 200, r.text
    data = r.json()
    assert set(data) >= {"db", "image", "backup"}
    assert data["db"]["size_mb"] >= 0 and "detail" in data["db"]  # SQLite 파일 크기
    assert {"size_mb", "instances", "disk_free_gb", "disk_total_gb"} <= set(data["image"])
    assert {"path", "size_mb", "quota_gb"} <= set(data["backup"])


# ════════════════════════════════ 백업 실행(db)·이력 통합 ════════════════════════════════
def test_backup_run_db_and_history(client, auth_headers, tmp_path):
    client.put("/api/maintenance/backup-policy", headers=auth_headers,
               json={"format": "none", "path": str(tmp_path)})
    r = client.post("/api/maintenance/backup-run", headers=auth_headers, json={"kind": "db"})
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert len(items) == 1 and items[0]["kind"] == "db"
    assert items[0]["status"] == "done", items[0]["detail"]
    assert items[0]["size_mb"] > 0  # SQLite 파일 복사 폴백
    assert items[0]["path"].endswith(".sqlite")
    # 이력 통합 목록에 노출
    hist = client.get("/api/maintenance/backups", headers=auth_headers).json()["items"]
    assert any(i["id"] == items[0]["id"] and i["kind"] == "db" for i in hist)
    # 잘못된 kind는 400
    assert client.post("/api/maintenance/backup-run", headers=auth_headers,
                       json={"kind": "tape"}).status_code == 400


# ════════════════════════════════ 복원(dry·DB 우아 강등) ════════════════════════════════
def test_restore_dry_and_db_guidance(client, auth_headers, db, tmp_path):
    # DICOM 백업(done) 준비 — 파일 2개
    sdir = tmp_path / "20240101" / "R-UID-1"
    sdir.mkdir(parents=True)
    (sdir / "a.dcm").write_bytes(b"DICM-a")
    (sdir / "b.dcm").write_bytes(b"DICM-b")
    job = BackupJob(kind="manual", status="done", compression="none",
                    target_dir=str(tmp_path), study_count=1, instance_count=2, total_bytes=12)
    db.add(job)
    db.commit()
    db.refresh(job)
    # dry=true → 요약만(업로드/등록 없음)
    r = client.post("/api/maintenance/restore", headers=auth_headers,
                    json={"backup_id": job.id, "scope": "system", "dry": True})
    assert r.status_code == 200, r.text
    assert r.json()["dry"] is True and r.json()["files_found"] == 2
    # UI 계약: 사람이 읽는 summary 한 줄(미리보기 패널에 그대로 노출)
    assert "summary" in r.json() and "2" in r.json()["summary"]
    # 존재하지 않는 백업 404, 미완료 백업 409
    assert client.post("/api/maintenance/restore", headers=auth_headers,
                       json={"backup_id": 999999, "dry": True}).status_code == 404
    pending = BackupJob(kind="manual", status="queued", target_dir=str(tmp_path))
    db.add(pending)
    db.commit()
    db.refresh(pending)
    assert client.post("/api/maintenance/restore", headers=auth_headers,
                       json={"backup_id": pending.id, "dry": True}).status_code == 409
    # DB 백업 복원 실행 → pg_restore 자동 실행 대신 파일 준비+수동 안내(우아 강등)
    dump = tmp_path / "db_x.dump"
    dump.write_bytes(b"PGDMP")
    dbjob = BackupJob(kind="db", status="done", target_dir=str(dump), total_bytes=5)
    db.add(dbjob)
    db.commit()
    db.refresh(dbjob)
    r2 = client.post("/api/maintenance/restore", headers=auth_headers,
                     json={"backup_id": dbjob.id, "scope": "system", "dry": False})
    assert r2.status_code == 200
    assert r2.json()["executed"] is False and "pg_restore" in r2.json()["guidance"]
    assert "summary" in r2.json()  # UI가 안내(guidance)와 함께 노출하는 한 줄 요약
    # hospital 범위는 유효한 hid 필수
    assert client.post("/api/maintenance/restore", headers=auth_headers,
                       json={"backup_id": job.id, "scope": "hospital", "dry": True}
                       ).status_code == 400


# ════════════════════════════════ wipe 가드·병원 범위 ════════════════════════════════
def test_wipe_guards_and_hospital_scope(client, auth_headers, db):
    # confirm 토큰 없으면 거부
    assert client.post("/api/maintenance/wipe", headers=auth_headers,
                       json={"scope": "hospital", "hid": 1}).status_code == 400
    assert client.post("/api/maintenance/wipe", headers=auth_headers,
                       json={"scope": "everything", "confirm": "WIPE"}).status_code == 400
    # hospital 범위인데 hid 없음/미존재 → 400
    assert client.post("/api/maintenance/wipe", headers=auth_headers,
                       json={"scope": "hospital", "confirm": "WIPE"}).status_code == 400
    # 병원 + 소속 검사 2건, 타병원 검사 1건 준비
    h = Hospital(code=f"WIPE-{time.time_ns()}", name="지움병원")
    other = Hospital(code=f"KEEP-{time.time_ns()}", name="보존병원")
    db.add_all([h, other])
    db.commit()
    s1 = register_study(db, study_uid=f"W-UID-{time.time_ns()}", patient_key="PW1",
                        patient_name="김^환자", study_date="20240201", modality="CT")
    s2 = register_study(db, study_uid=f"W-UID-{time.time_ns()}", patient_key="PW2",
                        patient_name="이^환자", study_date="20240202", modality="MR")
    keep = register_study(db, study_uid=f"K-UID-{time.time_ns()}", patient_key="PK1",
                          patient_name="박^환자", study_date="20240203", modality="US")
    s1.hospital_id = h.id
    s2.hospital_id = h.id
    keep.hospital_id = other.id
    db.commit()
    keep_id, hid = keep.id, h.id
    r = client.post("/api/maintenance/wipe", headers=auth_headers,
                    json={"scope": "hospital", "hid": hid, "confirm": "WIPE"})
    assert r.status_code == 200, r.text
    assert r.json()["deleted"] == 2
    db.expire_all()
    remain = db.execute(select(Study).where(Study.hospital_id == hid)).scalars().all()
    assert remain == [], "지정 병원 검사는 전부 삭제"
    assert db.get(Study, keep_id) is not None, "타병원 검사는 보존"
    # 파괴 작업 감사 로그 필수
    log = db.execute(
        select(AuditLog).where(AuditLog.action == "maintenance_wipe")
        .order_by(AuditLog.id.desc())
    ).scalars().first()
    assert log is not None and log.detail["hid"] == hid and log.detail["deleted"] == 2


# ════════════════════════════════ 미러링 ════════════════════════════════
def test_mirror_run_incremental(client, auth_headers, tmp_path):
    src = tmp_path / "bk"
    mirror = tmp_path / "mir"
    src.mkdir()
    (src / "20240101").mkdir()
    (src / "20240101" / "a.dcm").write_bytes(b"AAAA")
    client.put("/api/maintenance/backup-policy", headers=auth_headers,
               json={"format": "none", "path": str(src), "mirror_path": str(mirror)})
    r = client.post("/api/maintenance/mirror-run", headers=auth_headers)
    assert r.status_code == 200, r.text
    assert r.json()["copied"] == 1
    assert (mirror / "20240101" / "a.dcm").read_bytes() == b"AAAA"
    # 재실행 → 증분(동일 파일 skip)
    r2 = client.post("/api/maintenance/mirror-run", headers=auth_headers)
    assert r2.json()["copied"] == 0 and r2.json()["skipped"] == 1
    # mirror_path 미설정이면 400
    client.put("/api/maintenance/backup-policy", headers=auth_headers,
               json={"format": "none", "path": str(src), "mirror_path": ""})
    assert client.post("/api/maintenance/mirror-run", headers=auth_headers).status_code == 400
