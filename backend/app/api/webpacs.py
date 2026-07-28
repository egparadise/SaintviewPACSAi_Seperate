"""WebPACS 브리지 API — 인계 웹서비스(webpacs_api) 검사 탐색·가져오기.

- 설정(GET/PUT /api/webpacs/config)·연결 테스트(POST /test)는 관리자 전용.
- 원격 검사 목록(GET /studies)·가져오기(POST /import/{idx})는 로그인 사용자.
- 가져오기는 백그라운드(스레드풀)로 실행, 상태는 GET /import/{idx}/status 폴링.
"""
from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import admin_user, current_user
from app.db import get_db
from app.services.webpacs_bridge import (
    CONFIG_KEYS,
    SETTING_KEY,
    WebPacsError,
    client_from_config,
    find_local_study_id,
    get_bridge_config,
    get_import_job,
    import_study,
)

router = APIRouter(prefix="/api/webpacs", tags=["webpacs"])


def _masked(cfg: dict) -> dict:
    out = {k: v for k, v in cfg.items() if k != "password"}
    out["has_password"] = bool(cfg.get("password"))
    return out


@router.get("/config")
def read_config(db: Session = Depends(get_db), user: dict = Depends(admin_user)):
    return {"value": _masked(get_bridge_config(db))}


class ConfigBody(BaseModel):
    value: dict


@router.put("/config")
def write_config(body: ConfigBody, db: Session = Depends(get_db),
                 user: dict = Depends(admin_user)):
    from app.services.settings_service import get_setting, set_setting

    before = get_bridge_config(db)
    stored = dict(get_setting(db, SETTING_KEY, default={}) or {})
    for k in CONFIG_KEYS:
        if k in body.value:
            v = body.value[k]
            # 비밀번호는 빈값이면 기존값 유지(마스킹된 GUI 왕복 보호)
            if k == "password" and not v:
                continue
            stored[k] = v
    set_setting(db, SETTING_KEY, stored)
    after = get_bridge_config(db)
    # ⚠ A 서버(주소/계정)가 바뀌면 **캐시를 반드시 비운다**. service_client 는 키가 바뀌면
    #   재생성되지만 캐시는 그대로 남는다. 캐시에 들어 있는 것은 이전 서버의
    #   study/series/sop UID·디코드 픽셀이라, 그대로 내주면 새 서버의 검사 화면에
    #   **이전 환자의 영상**이 뜬다(PACS 에서는 오독 위험).
    if (before.get("base_url"), before.get("user_id")) != (after.get("base_url"), after.get("user_id")):
        from app.services import webpacs_live as live

        live.invalidate_tree()
        live.invalidate_related()
        live.invalidate_pixel_caches()
    return {"ok": True, "value": _masked(after)}


@router.post("/test")
def test_connection(db: Session = Depends(get_db), user: dict = Depends(admin_user)):
    """원격 로그인 + 검사 수 조회로 연결 확인."""
    cfg = get_bridge_config(db)
    try:
        client = client_from_config(cfg)
        try:
            client.login()
            count = client.study_count()
        finally:
            client.close()
        return {"ok": True, "study_count": count}
    except WebPacsError as e:
        return {"ok": False, "detail": str(e)}
    except Exception as e:  # noqa: BLE001 — 네트워크/SSL 등 원인 그대로 노출
        return {"ok": False, "detail": f"{type(e).__name__}: {str(e)[:200]}"}


@router.get("/studies")
def remote_studies(
    patient_id: str = "",
    patient_name: str = "",
    modality: str = "",
    date_from: str = Query("", description="검사일 시작 YYYY-MM-DD"),
    date_to: str = Query("", description="검사일 끝 YYYY-MM-DD"),
    q: str = Query("", description="자유 검색(원격 study_search OR 매칭)"),
    limit: int = Query(50, le=300),
    offset: int = 0,
    db: Session = Depends(get_db),
    user: dict = Depends(current_user),
):
    """원격 워크리스트 프록시 — 인계 서버 검색 파라미터로 매핑해 조회.

    각 행에 imported_study_id(로컬 보유 시 우리 검사 id)를 주입해
    프론트가 [가져오기]/[열기]를 구분해 표시할 수 있게 한다.
    """
    cfg = get_bridge_config(db)
    if not cfg.get("enabled"):
        raise HTTPException(status_code=409, detail="WebPACS 브리지가 비활성입니다 (설정에서 활성화)")
    params: dict[str, str] = {"limit": str(limit), "offset": str(offset)}
    if patient_id:
        params["patient_id"] = patient_id
    if patient_name:
        params["patient_name"] = patient_name
    if modality:
        params["study_modality"] = modality
    if date_from:
        params["study_datetime_start"] = date_from
    if date_to:
        params["study_datetime_end"] = date_to
    if q:
        params["study_search"] = q
    try:
        client = client_from_config(cfg)
        try:
            rows = client.list_studies(params)
            total = client.study_count(params)
        finally:
            client.close()
    except WebPacsError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"원격 조회 실패: {str(e)[:200]}")

    items = []
    for r in rows:
        uid = str(r.get("study_instance_uid") or "")
        items.append({
            "study_idx": r.get("study_idx"),
            "study_uid": uid,
            "patient_id": r.get("patient_id") or "",
            "patient_name": r.get("patient_name") or "",
            "patient_sex": r.get("patient_sex") or "",
            "patient_birth": r.get("patient_birthday") or "",
            "study_datetime": r.get("study_datetime") or "",
            "modality": r.get("study_modality") or "",
            "body_part": r.get("study_body_part") or "",
            "study_desc": r.get("study_description") or "",
            "series_count": r.get("series_count") or 0,
            "image_count": r.get("image_count") or 0,
            "study_status": r.get("study_status") or "",
            "hospital_name": r.get("hospital_name") or "",
            "imported_study_id": find_local_study_id(db, uid),
        })
    return {"items": items, "total": total}


def _run_import(remote_idx: int, hospital_id: int | None) -> None:
    """백그라운드 가져오기 — 요청 세션과 분리된 자체 DB 세션 사용."""
    from app.db import SessionLocal

    with SessionLocal() as db:
        cfg = get_bridge_config(db)
        try:
            import_study(db, cfg, remote_idx, hospital_id=hospital_id)
        except Exception:
            # 상태는 IMPORT_JOBS 에 error 로 기록됨 — 폴링으로 노출
            import logging

            logging.getLogger("saintview.webpacs").exception(
                "WebPACS 가져오기 실패 study_idx=%s", remote_idx)


@router.post("/import/{remote_idx}")
def start_import(
    remote_idx: int,
    tasks: BackgroundTasks,
    hospital_id: int = Query(0, description="귀속 병원(0=요청자 병원/설정값)"),
    db: Session = Depends(get_db),
    user: dict = Depends(current_user),
):
    cfg = get_bridge_config(db)
    if not cfg.get("enabled"):
        raise HTTPException(status_code=409, detail="WebPACS 브리지가 비활성입니다 (설정에서 활성화)")
    # 이미 로컬 보유면 즉시 반환(멱등) — 원격 detail 1회 조회
    try:
        client = client_from_config(cfg)
        try:
            detail = client.study_detail(remote_idx)
        finally:
            client.close()
    except WebPacsError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"원격 조회 실패: {str(e)[:200]}")
    uid = str(detail.get("study_instance_uid") or "")
    existing = find_local_study_id(db, uid)
    if existing:
        return {"status": "exists", "study_id": existing, "study_uid": uid}
    job = get_import_job(remote_idx)
    if job and job.get("status") == "running":
        return {"status": "running"}
    eff_hid = user.get("hid") or hospital_id or None
    tasks.add_task(_run_import, remote_idx, eff_hid)
    return {"status": "started"}


@router.get("/import/{remote_idx}/status")
def import_status(remote_idx: int, db: Session = Depends(get_db),
                  user: dict = Depends(current_user)):
    job = get_import_job(remote_idx)
    if not job:
        return {"status": "none"}
    out = dict(job)
    # 완료 후 study_id 미해결(경합) 대비 — study_uid 로 재조회
    if out.get("status") in ("done", "exists") and not out.get("study_id"):
        out["study_id"] = find_local_study_id(db, str(out.get("study_uid") or ""))
    return out
