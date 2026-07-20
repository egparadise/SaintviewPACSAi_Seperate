"""app_setting 조회/저장 — scope 오버라이드(user > source > global, 화면분석 §5.7)."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AppSetting

# 병원 기본값으로 관리·폴백되는 워크리스트 설정 키 — 관리 콘솔 [뷰어·워크리스트 설정](wl-setting
# 엔드포인트)과 /api/settings 사용자 폴백이 공유하는 단일 소스(이중 정의 금지).
WL_HOSPITAL_KEYS = ("worklist.prefs", "worklist.tabs", "worklist.tree")


def get_setting(db: Session, key: str, *, user: str = "", source: str = "", default=None):
    """우선순위: user > source > global."""
    candidates = []
    if user:
        candidates.append(("user", user))
    if source:
        candidates.append(("source", source))
    candidates.append(("global", ""))
    for scope, scope_id in candidates:
        row = db.execute(
            select(AppSetting).where(
                AppSetting.scope == scope,
                AppSetting.scope_id == scope_id,
                AppSetting.key == key,
            )
        ).scalar_one_or_none()
        if row is not None:
            return row.value
    return default


def get_hospital_setting(db: Session, hospital_id: int, key: str, default=None):
    """병원(hospital) 스코프 설정 — 병원별 권한 매트릭스·장비 노드·SCU 등."""
    row = db.execute(
        select(AppSetting).where(
            AppSetting.scope == "hospital",
            AppSetting.scope_id == str(hospital_id),
            AppSetting.key == key,
        )
    ).scalar_one_or_none()
    return row.value if row is not None else default


def set_hospital_setting(db: Session, hospital_id: int, key: str, value: dict) -> None:
    set_setting(db, key, value, scope="hospital", scope_id=str(hospital_id))


def ai_draft_enabled(db: Session) -> bool:
    """AI 판독 초안(Structured Report) 기능 마스터 스위치 — **기본 보류(off)**.

    향후 RAG 기반 Structured Report 개편 전까지 기능을 보류한다(2026-07-20 결정).
    - 운영: 설정 `ai.policy.draft_enabled`(관리자 GUI 설정>AI)로만 활성화.
    - 테스트/하네스: env `SAINTVIEW_AI_DRAFT_ENABLED=1` 오버라이드(설정 덮어쓰기와 무관하게
      생성 기계 자체를 검증) — env 가 설정보다 우선.
    """
    import os

    env = os.getenv("SAINTVIEW_AI_DRAFT_ENABLED")
    if env in ("0", "1"):
        return env == "1"
    policy = get_setting(db, "ai.policy", default={}) or {}
    return bool(policy.get("draft_enabled", False))


def set_setting(db: Session, key: str, value: dict, *, scope: str = "global", scope_id: str = "") -> None:
    row = db.execute(
        select(AppSetting).where(
            AppSetting.scope == scope, AppSetting.scope_id == scope_id, AppSetting.key == key
        )
    ).scalar_one_or_none()
    if row is None:
        db.add(AppSetting(scope=scope, scope_id=scope_id, key=key, value=value))
    else:
        row.value = value
    db.commit()
