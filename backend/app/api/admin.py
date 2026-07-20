from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import admin_user, current_user
from app.db import get_db
from app.models import AiJob, AuditLog

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/ai-jobs")
def ai_jobs(
    status: str = "",
    limit: int = 50,
    db: Session = Depends(get_db),
    user: dict = Depends(current_user),
):
    q = select(AiJob).order_by(AiJob.id.desc()).limit(limit)
    if status:
        q = q.where(AiJob.status == status)
    jobs = db.execute(q).scalars().all()
    return {
        "items": [
            {
                "id": j.id,
                "study_id": j.study_id,
                "kind": j.kind,
                "status": j.status,
                "error": j.error,
                "latency_sec": j.latency_sec,
                "created_at": j.created_at.isoformat() if j.created_at else None,
            }
            for j in jobs
        ]
    }


@router.post("/dicom-nodes/apply")
def apply_dicom_nodes(db: Session = Depends(get_db), user: dict = Depends(admin_user)):
    """dicom.nodes 설정의 SCU 노드를 Orthanc DicomModalities로 반영 — C-STORE/C-FIND 대상 등록."""
    from app.dicom.orthanc import OrthancClient
    from app.services.settings_service import get_setting

    nodes = (get_setting(db, "dicom.nodes", default={}) or {}).get("items", [])
    client = OrthancClient()
    try:
        if not client.alive():
            return {"ok": False, "detail": "Orthanc에 연결할 수 없습니다", "applied": 0}
        applied = 0
        errors: list[str] = []
        for n in nodes:
            name = str(n.get("name", "")).strip()
            aet = str(n.get("ae_title", "")).strip()
            ip = str(n.get("ip", "")).strip()
            try:
                port = int(n.get("port", 0))
            except (TypeError, ValueError):
                port = 0
            if not (name and aet and ip and 0 < port < 65536):
                errors.append(f"{name or '(이름없음)'}: AET/IP/Port 불완전")
                continue
            r = client._client.put(f"/modalities/{name}", json=[aet, ip, port])
            if r.status_code in (200, 204):
                applied += 1
            else:
                errors.append(f"{name}: HTTP {r.status_code}")
        db.add(AuditLog(action="dicom_nodes_apply", target_type="setting", target_id="dicom.nodes",
                        detail={"by": user["sub"], "applied": applied, "errors": errors}))
        db.commit()
        return {"ok": True, "applied": applied, "errors": errors}
    finally:
        client.close()


@router.post("/net-test/ping")
def net_ping(body: dict, user: dict = Depends(admin_user)):
    """Ping 테스트 — ICMP(시스템 ping) + 포트 지정 시 TCP 연결 확인."""
    import platform
    import socket
    import subprocess
    import time

    ip = str(body.get("ip", "")).strip()
    if not ip:
        raise HTTPException(status_code=400, detail="ip는 필수입니다")
    flag = "-n" if platform.system() == "Windows" else "-c"
    t0 = time.monotonic()
    try:
        r = subprocess.run(["ping", flag, "1", "-w" if platform.system() == "Windows" else "-W",
                            "2000" if platform.system() == "Windows" else "2", ip],
                           capture_output=True, timeout=5)
        icmp_ok = r.returncode == 0
    except (subprocess.TimeoutExpired, OSError):
        icmp_ok = False
    icmp_ms = round((time.monotonic() - t0) * 1000)

    tcp_ok = None
    port = body.get("port")
    if port:
        try:
            with socket.create_connection((ip, int(port)), timeout=3):
                tcp_ok = True
        except OSError:
            tcp_ok = False
    return {"ok": icmp_ok or tcp_ok is True, "icmp": icmp_ok, "icmp_ms": icmp_ms, "tcp": tcp_ok}


@router.post("/net-test/echo")
def net_dicom_echo(body: dict, user: dict = Depends(admin_user)):
    """DICOM C-ECHO 테스트 — pynetdicom Verification SCU."""
    ip = str(body.get("ip", "")).strip()
    try:
        port = int(body.get("port", 0))
    except (TypeError, ValueError):
        port = 0
    aet = str(body.get("ae_title", "")).strip() or "ANY-SCP"
    if not ip or not (0 < port < 65536):
        raise HTTPException(status_code=400, detail="ip/port가 올바르지 않습니다")
    try:
        from pynetdicom import AE
        from pynetdicom.sop_class import Verification

        ae = AE(ae_title="SAINTVIEW")
        ae.add_requested_context(Verification)
        ae.acse_timeout = 5
        ae.network_timeout = 5
        assoc = ae.associate(ip, port, ae_title=aet)
        if not assoc.is_established:
            return {"ok": False, "detail": "연관(Association) 수립 실패 — AE Title/IP/Port 확인"}
        status = assoc.send_c_echo()
        assoc.release()
        ok = bool(status and getattr(status, "Status", 1) == 0)
        return {"ok": ok, "detail": "C-ECHO 성공" if ok else f"C-ECHO 응답 상태 {getattr(status, 'Status', '?')}"}
    except Exception as e:  # noqa: BLE001 — 테스트 결과로 보고
        return {"ok": False, "detail": f"C-ECHO 실패: {e}"}


@router.post("/net-test/db")
def net_db_test(db: Session = Depends(get_db), user: dict = Depends(admin_user)):
    """DB 연동 테스트 — 현재 엔진으로 SELECT 1."""
    import time

    from sqlalchemy import text

    t0 = time.monotonic()
    try:
        db.execute(text("SELECT 1"))
        ms = round((time.monotonic() - t0) * 1000, 1)
        from app.config import get_settings

        url = get_settings().database_url
        masked = url.split("@")[-1] if "@" in url else url  # 자격증명 마스킹
        return {"ok": True, "latency_ms": ms, "dialect": db.bind.dialect.name if db.bind else "?", "target": masked}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "detail": str(e)}


@router.get("/audit")
def audit(limit: int = 100, db: Session = Depends(get_db), user: dict = Depends(admin_user)):
    rows = db.execute(select(AuditLog).order_by(AuditLog.id.desc()).limit(limit)).scalars().all()
    return {
        "items": [
            {
                "id": a.id,
                "account_id": a.account_id,
                "action": a.action,
                "target_type": a.target_type,
                "target_id": a.target_id,
                "detail": a.detail,
                "created_at": a.created_at.isoformat() if a.created_at else None,
            }
            for a in rows
        ]
    }


@router.get("/orthanc-status")
def orthanc_status(db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """네트워크 설정 페이지(화면분석 §5.3) — 연결 상태 + 시스템 정보 + 검사 수."""
    import httpx as _httpx

    from app.config import get_settings
    from app.dicom.orthanc import OrthancClient

    s = get_settings()
    client = OrthancClient()
    try:
        if not client.alive():
            return {"alive": False, "url": s.orthanc_url}
        sys_info = client._client.get("/system").json()
        count = len(client._client.get("/studies").json())
        return {
            "alive": True,
            "url": s.orthanc_url,
            "name": sys_info.get("Name"),
            "aet": sys_info.get("DicomAet"),
            "dicom_port": sys_info.get("DicomPort"),
            "version": sys_info.get("Version"),
            "studies_count": count,
        }
    except _httpx.HTTPError as e:
        return {"alive": False, "url": s.orthanc_url, "error": str(e)[:200]}
    finally:
        client.close()


@router.get("/ai-quality")
def ai_quality(db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """F-20: AI 품질 지표 — 확정 판독의 diff_metrics 집계 (설계 §10 수용도)."""
    from app.models import Report

    rows = db.execute(
        select(Report).where(Report.status == "finalized")
    ).scalars().all()
    with_ai = [r for r in rows if (r.diff_metrics or {}).get("has_ai_draft")]
    n = len(with_ai)
    if n == 0:
        return {"finalized_total": len(rows), "with_ai_draft": 0}
    accepted = sum(1 for r in with_ai if r.diff_metrics.get("accepted_unmodified"))
    avg_mod = sum(r.diff_metrics.get("modified_ratio", 0) for r in with_ai) / n
    critical_dropped = sum(1 for r in with_ai if r.diff_metrics.get("critical_dropped"))
    critical_added = sum(1 for r in with_ai if r.diff_metrics.get("critical_added"))
    return {
        "finalized_total": len(rows),
        "with_ai_draft": n,
        "accepted_unmodified": accepted,
        "acceptance_rate": round(accepted / n, 4),
        "avg_modified_ratio": round(avg_mod, 4),
        "critical_dropped": critical_dropped,  # 초안의 critical이 확정에서 빠짐 — 리뷰 대상
        "critical_added": critical_added,      # 판독의가 critical 추가 — AI 미탐 신호
    }


@router.post("/sync-orthanc")
def sync_orthanc(since: int = 0, db: Session = Depends(get_db), user: dict = Depends(admin_user)):
    """Orthanc 변경 피드 수동 동기화(운영은 워커 폴링)."""
    from app.dicom.orthanc import OrthancClient, sync_new_studies

    client = OrthancClient()
    if not client.alive():
        return {"ok": False, "detail": "Orthanc에 연결할 수 없습니다"}
    registered, last = sync_new_studies(db, client, since=since)
    client.close()
    return {"ok": True, "registered": registered, "last_seq": last}
