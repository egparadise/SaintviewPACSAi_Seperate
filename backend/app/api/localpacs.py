"""Local Server 모드 API — /api/local (서버 Orthanc/Postgres 와 분리된 로컬 PACS).

루트 = server.network.local_share_dir. 전 엔드포인트 인증(current_user) 필수,
경로는 local.db 조회로만 해석(루트 이탈 방지). 미설정 시 400 안내.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import current_user, require_effective
from app.db import get_db
from app.services import localpacs_service as svc
from app.services.settings_service import get_setting

router = APIRouter(prefix="/api/local", tags=["local"])


def _root(db: Session) -> Path:
    """설정에서 로컬 PACS 루트를 해석 — 미설정이면 400."""
    cfg = get_setting(db, "server.network", default={}) or {}
    try:
        return svc.resolve_root(str(cfg.get("local_share_dir", "") or ""))
    except svc.LocalPacsNotConfigured as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/init")
def local_init(db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """폴더 구조(DB/Image/Temp)+local.db 스키마 생성 — idempotent."""
    return svc.init_dirs(_root(db))


@router.post("/import")
def local_import(
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
    user: dict = Depends(current_user),
):
    """multipart files[] → Temp 저장→pydicom 판정(비DICOM 스킵)→Image 배치→local.db 등록."""
    return svc.import_files(_root(db), files)


@router.get("/studies")
def local_studies(q: str = "", db: Session = Depends(get_db), user: dict = Depends(current_user)):
    return svc.list_studies(_root(db), q)


@router.get("/studies/{study_id}/tree")
def local_study_tree(
    study_id: int, db: Session = Depends(get_db), user: dict = Depends(current_user)
):
    tree = svc.study_tree(_root(db), study_id)
    if tree is None:
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    return tree


@router.get("/instances/{iid}/rendered")
def local_instance_rendered(
    iid: int,
    wc: float | None = None,
    ww: float | None = None,
    db: Session = Depends(get_db),
    user: dict = Depends(current_user),
):
    """인스턴스 → PNG(8bit W/L, MONOCHROME1 반전·RGB 지원)."""
    path = svc.instance_path(_root(db), iid)
    if path is None:
        raise HTTPException(status_code=404, detail="이미지를 찾을 수 없습니다")
    try:
        png = svc.render_png(path, wc=wc, ww=ww)
    except Exception:  # noqa: BLE001 — 픽셀 미보유·손상 파일 등은 사용자 메시지로
        raise HTTPException(status_code=422, detail="이미지를 렌더링할 수 없습니다")
    return Response(content=png, media_type="image/png")


@router.delete("/studies/{study_id}")
def local_delete_study(
    study_id: int, db: Session = Depends(get_db), user: dict = Depends(current_user)
):
    """로컬 검사 삭제(파일+local.db) — 서버 DB에 감사 로그 기록."""
    result = svc.delete_study(_root(db), study_id)
    if result is None:
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    from app.models import AuditLog

    db.add(
        AuditLog(
            account_id=user.get("uid"),
            action="local_study_delete",
            target_type="local_study",
            target_id=str(study_id),
            detail={"removed_files": result.get("removed_files", 0), "by": user.get("sub", "")},
        )
    )
    db.commit()
    return result


# ════════════════════ Exam Control(로컬) — /api/local/examctl ════════════════════
# 서버 /api/examctl 과 동형 응답 계약 — 프론트(ExamControl.tsx)가 모드에 따라 스왑 소비.
# 파일/DICOM 원본 불변, local.db 소프트 삭제·귀속 변경만. 전 변이 작업 감사 로그.
class SelectionBody(BaseModel):
    series_uids: list[str] = []
    sop_uids: list[str] = []


class AssignBody(SelectionBody):
    target_study_id: int


class MergeBody(BaseModel):
    """환자 병합 요청 — 검사 id 로 받고 환자를 역해석(서버 merge 와 동형)."""
    master_study_id: int
    slave_study_id: int


class UnmergeBody(BaseModel):
    """병합 해제 요청 — study_id(이동/마스터 검사) 또는 merge_id 중 하나."""
    study_id: int | None = None
    merge_id: int | None = None


def _require_selection(body: SelectionBody) -> None:
    if not body.series_uids and not body.sop_uids:
        raise HTTPException(status_code=400, detail="대상 시리즈/이미지를 선택하세요")


def _audit_local(db: Session, user: dict, action: str, body: SelectionBody, extra: dict) -> None:
    """로컬 examctl 작업을 서버 AuditLog 에 기록(local_examctl_*)."""
    from app.models import AuditLog

    db.add(AuditLog(
        account_id=user.get("uid"),
        action=action,
        target_type="local_study",
        target_id="",
        detail={
            "by": user.get("sub", ""),
            "series": body.series_uids[:20],
            "images": body.sop_uids[:20],
            "n_series": len(body.series_uids),
            "n_images": len(body.sop_uids),
            **extra,
        },
    ))
    db.commit()


@router.get("/examctl/studies")
def local_examctl_studies(
    q: str = "", db: Session = Depends(get_db), user: dict = Depends(current_user)
):
    """로컬 검사 목록 — localStudies 재사용(이미지 수는 소프트 삭제 제외 실측)."""
    return svc.list_studies(_root(db), q)


@router.get("/examctl/studies/{study_id}/tree")
def local_examctl_tree(
    study_id: int, db: Session = Depends(get_db), user: dict = Depends(current_user)
):
    """시리즈→이미지 트리 — Exam Control 은 deleted 포함(플래그) 표시."""
    tree = svc.examctl_tree(_root(db), study_id)
    if tree is None:
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    return tree


@router.get("/examctl/trash")
def local_examctl_trash(db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """휴지통 — 소프트 삭제된 시리즈/이미지 목록(Recovery 대상)."""
    return {"items": svc.examctl_trash(_root(db))}


@router.post("/examctl/delete")
def local_examctl_delete(
    body: SelectionBody, db: Session = Depends(get_db), user: dict = Depends(current_user)
):
    """소프트 삭제(휴지통) — 시리즈 삭제는 하위 이미지 포함. 파일 원본은 불변."""
    _require_selection(body)
    result = svc.examctl_delete(_root(db), body.series_uids, body.sop_uids)
    if result is None:
        raise HTTPException(status_code=404, detail="대상을 찾을 수 없습니다")
    _audit_local(db, user, "local_examctl_delete", body, result)
    return result


@router.post("/examctl/restore")
def local_examctl_restore(
    body: SelectionBody, db: Session = Depends(get_db), user: dict = Depends(current_user)
):
    """복구(Recovery) — 휴지통에서 되살린다(이미지 복구는 부모 시리즈도 복구)."""
    _require_selection(body)
    result = svc.examctl_restore(_root(db), body.series_uids, body.sop_uids)
    if result is None:
        raise HTTPException(status_code=404, detail="대상을 찾을 수 없습니다")
    _audit_local(db, user, "local_examctl_restore", body, result)
    return result


@router.post("/examctl/unassign")
def local_examctl_unassign(
    body: SelectionBody, db: Session = Depends(get_db), user: dict = Depends(current_user)
):
    """선택 항목을 현재 검사에서 분리 — 로컬 미배정(UNASSIGNED) 버킷 검사로 이동."""
    _require_selection(body)
    result = svc.examctl_unassign(_root(db), body.series_uids, body.sop_uids)
    if result is None:
        raise HTTPException(status_code=404, detail="대상을 찾을 수 없습니다")
    _audit_local(db, user, "local_examctl_unassign", body, result)
    return result


@router.post("/examctl/assign")
def local_examctl_assign(
    body: AssignBody, db: Session = Depends(get_db), user: dict = Depends(current_user)
):
    """선택 항목(미배정 포함)을 대상 로컬 검사로 이동(재귀속) — local.db 계층만."""
    _require_selection(body)
    result = svc.examctl_assign(
        _root(db), body.target_study_id, body.series_uids, body.sop_uids
    )
    err = result.get("error")
    if err == "target_not_found":
        raise HTTPException(status_code=404, detail="대상 검사를 찾을 수 없습니다")
    if err == "not_found":
        raise HTTPException(status_code=404, detail="대상을 찾을 수 없습니다")
    if err == "self_assign":
        raise HTTPException(
            status_code=400,
            detail="이동할 항목이 없습니다 — 선택 항목이 이미 대상 검사에 속해 있습니다"
            " (자기 자신으로는 이동할 수 없습니다)",
        )
    _audit_local(db, user, "local_examctl_assign", body,
                 {**result, "target_study_id": body.target_study_id})
    return result


@router.post("/examctl/merge")
def local_examctl_merge(
    body: MergeBody,
    db: Session = Depends(get_db),
    user: dict = Depends(require_effective("study.match")),
):
    """환자 병합 — Slave 환자의 전 검사를 Master 환자로 귀속(local.db 계층만, 원본 불변).

    권한: 서버 병합(study.match)과 동일 — 환자 귀속 변경은 모드와 무관하게 같은 요건.
    """
    result = svc.examctl_merge(_root(db), body.master_study_id, body.slave_study_id)
    err = result.get("error")
    if err == "not_found":
        raise HTTPException(status_code=404, detail="병합 대상 검사를 찾을 수 없습니다")
    if err == "same_patient":
        raise HTTPException(
            status_code=400, detail="동일 환자입니다 — 서로 다른 환자의 검사를 선택하세요"
        )
    if err == "unassigned":
        raise HTTPException(
            status_code=400, detail="미배정 보관함(UNASSIGNED)은 병합할 수 없습니다"
        )
    if err == "already_merged":
        raise HTTPException(
            status_code=400,
            detail="이미 활성 병합에 관여된 환자입니다 — 먼저 병합을 해제하세요",
        )
    _audit_local(db, user, "local_examctl_merge", SelectionBody(), {
        **result,
        "master_study_id": body.master_study_id,
        "slave_study_id": body.slave_study_id,
    })
    return result


@router.post("/examctl/unmerge")
def local_examctl_unmerge(
    body: UnmergeBody,
    db: Session = Depends(get_db),
    user: dict = Depends(require_effective("study.unmatch")),
):
    """병합 해제 — originals 스냅샷으로 환자 필드 원복(서버 unmerge 와 동형).

    권한: 서버 해제(study.unmatch)와 동일.
    """
    if body.study_id is None and body.merge_id is None:
        raise HTTPException(status_code=400, detail="study_id 또는 merge_id 를 지정하세요")
    result = svc.examctl_unmerge(
        _root(db), study_id=body.study_id, merge_id=body.merge_id
    )
    if result.get("error") == "not_found":
        raise HTTPException(status_code=404, detail="해제할 병합을 찾을 수 없습니다")
    _audit_local(db, user, "local_examctl_unmerge", SelectionBody(), {
        **result,
        "study_id": body.study_id,
    })
    return result


@router.get("/examctl/merges")
def local_examctl_merges(db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """활성(미해제) 병합 목록 — Unmerge 대상 선택용."""
    return {"items": svc.examctl_merges(_root(db))}
