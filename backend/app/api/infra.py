"""인프라 관리 API(레인 O) — 컨테이너(OHIF/Orthanc/DB) 제어·병원별 Orthanc 프로비저닝·DDNS.

전부 admin 전용. 파괴/원격 작업(컨테이너 액션·프로비저닝·제거·DDNS 갱신)은 감사 로그 필수.
계층: 라우터(검증·감사) → services/docker_service·ddns_service(실동작).
파일명 계약: app/api/infra.py — main.py(레인 H)가 guarded try-import 로 등록한다.
"""
from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import admin_user
from app.db import get_db
from app.models import AuditLog, Hospital
from app.services import ddns_service, docker_service
from app.services.docker_service import DockerUnavailable

router = APIRouter(prefix="/api/infra", tags=["infra"])


def _audit(db: Session, user: dict, action: str, target: str, detail: dict) -> None:
    db.add(AuditLog(account_id=user.get("uid"), action=action,
                    target_type="infra", target_id=target[:64], detail=detail))


# ════════════════════════════ 컨테이너 조회/제어 ════════════════════════════
@router.get("/containers")
def containers(user: dict = Depends(admin_user)):
    """saintview-* 컨테이너 현황 — docker 미가용은 docker_ok=false 로 우아 강등."""
    try:
        items = docker_service.list_containers()
        return {"docker_ok": True, "items": items}
    except DockerUnavailable as e:
        return {"docker_ok": False, "items": [], "detail": str(e)[:200]}


class ContainerActionBody(BaseModel):
    action: str  # start | stop | restart


@router.post("/containers/{name}/action")
def container_action(name: str, body: ContainerActionBody,
                     db: Session = Depends(get_db), user: dict = Depends(admin_user)):
    """컨테이너 start/stop/restart — 이름·액션 화이트리스트 검증(임의 명령 주입 불가)."""
    try:
        result = docker_service.container_action(name, body.action)
    except ValueError as e:  # 화이트리스트 위반 → 400
        raise HTTPException(status_code=400, detail=str(e))
    except DockerUnavailable as e:
        raise HTTPException(status_code=503, detail=f"docker 미가용: {str(e)[:200]}")
    _audit(db, user, "infra_container_action", name,
           {"action": body.action, "ok": result["ok"], "detail": result["detail"]})
    db.commit()
    return result


# ════════════════════════════ OHIF 구성 조회 ════════════════════════════
def _parse_ohif_config(text: str) -> dict:
    """app-config.js 에서 데이터소스 핵심 값만 추출(정규식 — JS 실행 없음)."""
    def _find(key: str) -> str:
        m = re.search(rf"{key}\s*:\s*['\"]([^'\"]*)['\"]", text)
        return m.group(1) if m else ""

    return {
        "friendlyName": _find("friendlyName"),
        "wadoUriRoot": _find("wadoUriRoot"),
        "qidoRoot": _find("qidoRoot"),
        "wadoRoot": _find("wadoRoot"),
        "imageRendering": _find("imageRendering"),
        "defaultDataSourceName": _find("defaultDataSourceName"),
    }


@router.get("/ohif/config")
def ohif_config(user: dict = Depends(admin_user)):
    """OHIF 실구성 표시 — 앱 설정(app-config.js)·nginx 프록시·컨테이너 상태."""
    from app.config import get_settings

    deploy = docker_service.deploy_dir()
    cfg_path = deploy / "ohif" / "app-config.js"
    nginx_path = deploy / "ohif" / "nginx-default.conf"
    datasource: dict = {}
    proxy = ""
    if cfg_path.is_file():
        datasource = _parse_ohif_config(cfg_path.read_text(encoding="utf-8"))
    if nginx_path.is_file():
        m = re.search(r"proxy_pass\s+(\S+?);", nginx_path.read_text(encoding="utf-8"))
        proxy = m.group(1) if m else ""

    container = None
    try:
        for c in docker_service.list_containers():
            if c["name"] == "saintview-ohif":
                container = c
                break
    except DockerUnavailable:
        pass
    return {
        "ohif_url": get_settings().ohif_url,
        "config_path": str(cfg_path),
        "datasource": datasource,
        "proxy_pass": proxy,  # OHIF nginx 가 /dicom-web 을 Orthanc 로 중계(같은 오리진 CORS 우회)
        "container": container,
    }


# ════════════════════════════ 병원별 Orthanc 컨테이너 ════════════════════════════
@router.get("/hospitals")
def hospital_containers(db: Session = Depends(get_db), user: dict = Depends(admin_user)):
    """병원 목록 + 프로비저닝 레지스트리 + 라이브 컨테이너 상태 병합."""
    registry = docker_service.get_registry(db)
    live: dict[str, dict] = {}
    docker_ok = True
    try:
        live = {c["name"]: c for c in docker_service.list_containers()}
    except DockerUnavailable:
        docker_ok = False
    items = []
    from sqlalchemy import select

    for h in db.execute(select(Hospital).order_by(Hospital.id)).scalars().all():
        entry = registry.get(str(h.id)) if isinstance(registry.get(str(h.id)), dict) else None
        c = live.get(docker_service.hospital_container_name(h.id)) if entry else None
        items.append({
            "hid": h.id, "code": h.code, "name": h.name,
            "provisioned": bool(entry), "entry": entry,
            "state": (c or {}).get("state", ""), "status": (c or {}).get("status", ""),
        })
    return {"docker_ok": docker_ok, "items": items,
            # 정직한 안내(패널 표시용): DB 는 이미 hospital_id 논리 분리 + 병원 단위 백업/지우기 구현
            "db_note": "DB는 hospital_id 논리 분리로 병원별 격리되며, 병원 단위 백업/복원/지우기는 유지관리에서 이미 제공됩니다. 여기서는 영상 저장(Orthanc)만 병원별 컨테이너로 물리 분리합니다."}


@router.post("/hospitals/{hid}/provision")
def hospital_provision(hid: int, db: Session = Depends(get_db), user: dict = Depends(admin_user)):
    """병원 전용 Orthanc 생성 — 템플릿 치환·compose up·infra.containers 기록(멱등)."""
    if not db.get(Hospital, hid):
        raise HTTPException(status_code=404, detail=f"병원을 찾을 수 없습니다: hid={hid}")
    try:
        result = docker_service.provision_hospital(db, hid)
    except DockerUnavailable as e:
        raise HTTPException(status_code=503, detail=f"docker 미가용: {str(e)[:200]}")
    except (ValueError, OSError) as e:
        raise HTTPException(status_code=500, detail=f"프로비저닝 실패: {str(e)[:200]}")
    _audit(db, user, "infra_hospital_provision", f"hid:{hid}",
           {"ok": result["ok"], "entry": result["entry"], "detail": result["detail"]})
    db.commit()
    if not result["ok"]:
        raise HTTPException(status_code=502, detail=f"docker compose 실패: {result['detail']}")
    return result


class HospitalActionBody(BaseModel):
    action: str  # start | stop | restart | remove


@router.post("/hospitals/{hid}/action")
def hospital_container_action(hid: int, body: HospitalActionBody,
                              db: Session = Depends(get_db), user: dict = Depends(admin_user)):
    try:
        result = docker_service.hospital_action(db, hid, body.action)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except DockerUnavailable as e:
        raise HTTPException(status_code=503, detail=f"docker 미가용: {str(e)[:200]}")
    _audit(db, user, "infra_hospital_action", f"hid:{hid}",
           {"action": body.action, "ok": result["ok"], "detail": result["detail"]})
    db.commit()
    return result


# ════════════════════════════ DDNS ════════════════════════════
class DdnsBody(BaseModel):
    provider: str = "duckdns"      # duckdns | dynu | custom
    domain: str = ""
    token: str = ""                # 빈값/•••• 이면 기존 토큰 유지
    url_template: str = ""         # custom: {domain} {token} {ip}
    interval_min: int = 30
    enabled: bool = False


@router.get("/ddns")
def ddns_get(db: Session = Depends(get_db), user: dict = Depends(admin_user)):
    """DDNS 설정+상태 — 토큰은 마스킹(••••)해서만 반환."""
    cfg = ddns_service.get_config(db)
    if cfg.get("enabled"):
        ddns_service.ensure_worker()  # 서버 재기동 없이 워커 보장(지연 기동)
    return {"config": ddns_service.mask_config(cfg), "status": ddns_service.get_status(db)}


@router.put("/ddns")
def ddns_put(body: DdnsBody, db: Session = Depends(get_db), user: dict = Depends(admin_user)):
    if body.provider not in ("duckdns", "dynu", "custom"):
        raise HTTPException(status_code=400, detail="provider는 duckdns|dynu|custom")
    if body.provider == "custom" and body.enabled and not body.url_template.strip():
        raise HTTPException(status_code=400, detail="custom 공급자는 url_template 이 필요합니다")
    saved = ddns_service.save_config(db, body.model_dump())
    if saved.get("enabled"):
        ddns_service.ensure_worker()
    _audit(db, user, "infra_ddns_config", saved.get("provider", ""),
           ddns_service.mask_config(saved))  # 감사 로그에도 토큰 마스킹
    db.commit()
    return {"config": ddns_service.mask_config(saved)}


@router.post("/ddns/update")
def ddns_update(db: Session = Depends(get_db), user: dict = Depends(admin_user)):
    """[지금 갱신] — 공인 IP 조회 → 공급자 갱신 API 호출. 결과는 상태로 기록."""
    status = ddns_service.update_now(db)
    _audit(db, user, "infra_ddns_update", str(status.get("last_ip", "")), dict(status))
    db.commit()
    return {"ok": bool(status.get("ok")), "status": status}


# ════════════════════════════ 메인 스택 일괄 제어 (부모 컨테이너) ════════════════════════════
class MainActionBody(BaseModel):
    action: str  # start | stop | restart


@router.post("/main/action")
def main_stack_action(body: MainActionBody,
                      db: Session = Depends(get_db), user: dict = Depends(admin_user)):
    """메인 docker 스택(db·orthanc·ohif) 일괄 start/stop/restart — 시스템 구조도 부모 박스."""
    try:
        result = docker_service.main_action(body.action)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except DockerUnavailable as e:
        raise HTTPException(status_code=503, detail=f"docker 미가용: {str(e)[:200]}")
    _audit(db, user, "infra_main_action", "main-stack",
           {"action": body.action, "ok": result["ok"], "detail": result["detail"]})
    db.commit()
    return result
