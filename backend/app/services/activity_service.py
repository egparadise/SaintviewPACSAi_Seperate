"""검사 활동(하트비트) 서비스 — 판독 상태(read_state) 계산 (SPEC §B).

뷰어/판독창이 45s 간격으로 보내는 하트비트를 (study_id, kind, username) 당
1행으로 upsert 하고, 워크리스트 행의 read_state/viewer_open/report_typing 등
QC 메타를 페이지 단위 배치 쿼리로 계산한다(N+1 금지).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import (
    Annotation,
    Instance,
    PatientMerge,
    Report,
    Series,
    Study,
    StudyActivity,
)

# 하트비트 TTL(초) — 45s 주기 전송 기준 여유 배수
ACTIVE_TTL = 120    # 뷰어 열림/판독창 활성 판정
TYPING_TTL = 90     # 판독문 입력 중(typing) 판정
CLEANUP_AGE = 3600  # 1시간 지난 하트비트 행은 기회적 삭제

HEARTBEAT_KINDS = ("viewer", "report")
MAX_HEARTBEAT_IDS = 64


def _aware_utc(dt: datetime | None) -> datetime | None:
    """naive/aware 안전 비교 유틸 — SQLite 는 naive 로 돌려줄 수 있어 UTC 로 간주해 정규화."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def heartbeat(
    db: Session,
    *,
    username: str,
    study_ids: list[int],
    kind: str,
    typing: bool = False,
    scope_hospital_id: int | None = None,
) -> int:
    """하트비트 upsert — (study_id, kind, username) 당 1행 유지, last_seen 갱신.

    study_ids 는 실존 검사만 반영하고, scope_hospital_id 가 주어지면 그 병원 검사로
    제한한다(타 병원 read_state 오염·미존재 id 무제한 적재 방지 — 불일치 id 는 무시).
    호출 시 1시간(CLEANUP_AGE) 지난 행을 기회적으로 정리한다. 반환: 반영한 검사 수.
    """
    if kind not in HEARTBEAT_KINDS:
        raise ValueError(f"kind 는 {HEARTBEAT_KINDS} 중 하나여야 합니다: {kind}")
    now = datetime.now(timezone.utc)
    ids = list(dict.fromkeys(int(s) for s in study_ids))  # 중복 제거(순서 유지)
    if ids:
        # 실존·병원 스코프 배치 검증 — StudyActivity.study_id 는 FK 가 아니므로 필수
        q = select(Study.id).where(Study.id.in_(ids))
        if scope_hospital_id is not None:
            q = q.where(Study.hospital_id == scope_hospital_id)
        valid = {sid for (sid,) in db.execute(q)}
        ids = [sid for sid in ids if sid in valid]

    def _apply() -> None:
        for sid in ids:
            row = db.execute(
                select(StudyActivity).where(
                    StudyActivity.study_id == sid,
                    StudyActivity.kind == kind,
                    StudyActivity.username == username,
                )
            ).scalar_one_or_none()
            if row:
                row.last_seen = now
                row.typing = bool(typing)
            else:
                db.add(
                    StudyActivity(
                        study_id=sid, kind=kind, username=username,
                        typing=bool(typing), last_seen=now,
                    )
                )
        # 기회적 정리 — 오래된 하트비트 행 삭제(테이블 무한 성장 방지)
        cutoff = now - timedelta(seconds=CLEANUP_AGE)
        db.execute(delete(StudyActivity).where(StudyActivity.last_seen < cutoff))

    _apply()
    try:
        db.commit()
    except IntegrityError:
        # 동일 (study,kind,user) 키 동시 INSERT 경합 — 한쪽이 유니크 제약에 걸리면
        # 롤백 후 1회 재시도(경합 상대가 커밋한 행을 UPDATE 경로로 갱신)로 자기치유
        db.rollback()
        _apply()
        db.commit()
    return len(ids)


def qc_meta(db: Session, studies: list[Study]) -> dict[int, dict]:
    """워크리스트 페이지 행들의 QC 메타 배치 계산 — study_id → 메타 dict.

    read_state 우선순위(SPEC §B):
      ① fixed  = study.report_locked
      ② read   = study.status == "finalized"
      ③ reading = 판독 하트비트 활성 or study.status=="reading" or 최신 리포트 in_review
      ④ open   = 뷰어 하트비트 활성
      ⑤ unread
    """
    if not studies:
        return {}
    now = datetime.now(timezone.utc)
    ids = [s.id for s in studies]

    # ── 하트비트 활성 집합 (naive/aware 안전 비교) ──
    viewer_open: set[int] = set()
    report_active: set[int] = set()
    typing_set: set[int] = set()
    acts = db.execute(
        select(StudyActivity).where(StudyActivity.study_id.in_(ids))
    ).scalars().all()
    for a in acts:
        seen = _aware_utc(a.last_seen)
        if seen is None:
            continue
        age = (now - seen).total_seconds()
        if a.kind == "viewer" and age <= ACTIVE_TTL:
            viewer_open.add(a.study_id)
        elif a.kind == "report":
            if age <= ACTIVE_TTL:
                report_active.add(a.study_id)
            if a.typing and age <= TYPING_TTL:
                typing_set.add(a.study_id)

    # ── 리포트: 최신 버전 상태 + 텍스트 존재 여부 (배치) ──
    latest_status: dict[int, str] = {}
    latest_ver: dict[int, int] = {}
    has_text: set[int] = set()
    rep_rows = db.execute(
        select(
            Report.study_id, Report.version, Report.status,
            func.length(Report.narrative_text),
        ).where(Report.study_id.in_(ids))
    ).all()
    for sid, ver, status, text_len in rep_rows:
        if (text_len or 0) > 0:
            has_text.add(sid)
        if ver >= latest_ver.get(sid, 0):
            latest_ver[sid] = ver
            latest_status[sid] = status

    # ── 이미지 변경 흔적: 주석 / 소프트 삭제 시리즈·이미지 (배치) ──
    anno_set = {
        sid for (sid,) in db.execute(
            select(Annotation.study_id).where(Annotation.study_id.in_(ids)).distinct()
        )
    }
    del_series = {
        sid for (sid,) in db.execute(
            select(Series.study_id)
            .where(Series.study_id.in_(ids), Series.deleted_at.isnot(None))
            .distinct()
        )
    }
    del_images = {
        sid for (sid,) in db.execute(
            select(Series.study_id)
            .join(Instance, Instance.series_id == Series.id)
            .where(Series.study_id.in_(ids), Instance.deleted_at.isnot(None))
            .distinct()
        )
    }
    # ── 저장된 표시상태(pstate: 적용 툴 W/L·방향·필터·셔터) — 워크리스트 변경표시 반영 ──
    from app.models import AppSetting

    pstate_key_to_id = {f"pstate:{i}": i for i in ids}
    pstate_set: set[int] = set()
    if pstate_key_to_id:
        for key, val in db.execute(
            select(AppSetting.key, AppSetting.value).where(
                AppSetting.scope == "global", AppSetting.key.in_(list(pstate_key_to_id))
            )
        ):
            if isinstance(val, dict) and val.get("series"):
                pstate_set.add(pstate_key_to_id[key])

    # ── 병합: 활성 병합(undone_at IS NULL)의 master 환자 집합 — PatientMerge 직접 쿼리 ──
    patient_ids = {s.patient_id for s in studies}
    master_pids = {
        pid for (pid,) in db.execute(
            select(PatientMerge.master_patient_id)
            .where(
                PatientMerge.undone_at.is_(None),
                PatientMerge.master_patient_id.in_(patient_ids),
            )
            .distinct()
        )
    }

    out: dict[int, dict] = {}
    for s in studies:
        locked = bool(s.report_locked)  # ALTER 추가 컬럼은 기존 행 NULL 가능 → bool 강제
        if locked:
            state = "fixed"
        elif s.status == "finalized":
            state = "read"
        elif (
            s.id in report_active
            or s.status == "reading"
            or latest_status.get(s.id) == "in_review"
        ):
            state = "reading"
        elif s.id in viewer_open:
            state = "open"
        else:
            state = "unread"
        out[s.id] = {
            "read_state": state,
            "viewer_open": s.id in viewer_open,
            "report_typing": s.id in typing_set,
            "has_report_text": s.id in has_text,
            "image_changed": (
                s.id in anno_set
                or s.id in pstate_set
                or bool(s.key_images)
                or s.id in del_series
                or s.id in del_images
                or s.merged_from is not None
            ),
            "merged": s.merged_from is not None or s.patient_id in master_pids,
            "report_locked": locked,
        }
    return out
