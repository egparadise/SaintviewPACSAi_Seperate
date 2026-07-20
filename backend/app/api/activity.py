"""활동 하트비트 API — 뷰어 열림/판독창 작업 신호 수신 (SPEC §B)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import current_user
from app.db import get_db
from app.services.activity_service import HEARTBEAT_KINDS, MAX_HEARTBEAT_IDS, heartbeat

router = APIRouter(prefix="/api", tags=["activity"])


class HeartbeatBody(BaseModel):
    study_ids: list[int]
    kind: str = "viewer"   # viewer | report
    typing: bool = False   # kind=report 일 때 판독문 입력 진행 중


@router.post("/activity/heartbeat")
def post_heartbeat(
    body: HeartbeatBody,
    db: Session = Depends(get_db),
    user: dict = Depends(current_user),
):
    """하트비트 upsert — (study_id, kind, username) 당 1행. username=토큰 sub.

    병원 스코프: 워크리스트(_scoped_hospital)와 동일 — 시스템 관리자/미소속은 전체,
    병원 소속 사용자는 자기 병원 검사만 반영(타 병원 read_state 오염 방지, 불일치는 무시).
    """
    if len(body.study_ids) > MAX_HEARTBEAT_IDS:
        raise HTTPException(
            status_code=400, detail=f"study_ids 는 최대 {MAX_HEARTBEAT_IDS}건까지 허용됩니다"
        )
    if body.kind not in HEARTBEAT_KINDS:
        raise HTTPException(status_code=400, detail="kind 는 viewer 또는 report 여야 합니다")
    is_sys_admin = user.get("role") == "admin" and not user.get("hid")
    heartbeat(
        db,
        username=user["sub"],
        study_ids=body.study_ids,
        kind=body.kind,
        typing=body.typing,
        scope_hospital_id=None if is_sys_admin else (user.get("hid") or None),
    )
    return {"ok": True}
