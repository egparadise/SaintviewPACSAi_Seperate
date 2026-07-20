from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import current_user
from app.db import get_db
from app.models import Study
from app.services.study_service import (
    WorklistFilter,
    queue_ai_job,
    search_worklist,
    study_detail,
    worklist_counts,
)

router = APIRouter(prefix="/api", tags=["worklist"])


@router.get("/worklist")
def worklist(
    q: str = Query("", description="통합 검색(환자 ID/이름)"),
    pid: str = Query("", description="환자 ID (필드별)"),
    pname: str = Query("", description="환자 이름 (필드별)"),
    sex: str = "",
    desc: str = Query("", description="검사명 (Study Description)"),
    modality: str = "",
    body_part: str = "",
    status: str = "",
    date_from: str = "",
    date_to: str = "",
    finding: str = Query("", description="소견/임프레션 텍스트 검색 (F-2)"),
    emergency: bool = False,
    key: bool = Query(False, description="키이미지 등록 검사만 (F-16)"),
    hospital_id: int = Query(0, description="선택한 병원으로 스코프(0=자동)"),
    limit: int = Query(100, le=500),
    offset: int = 0,
    db: Session = Depends(get_db),
    user: dict = Depends(current_user),
):
    items, total = search_worklist(
        db,
        WorklistFilter(
            patient_query=q,
            patient_id=pid,
            patient_name=pname,
            sex=sex,
            study_desc=desc,
            modality=modality,
            body_part=body_part,
            status=status,
            date_from=date_from,
            date_to=date_to,
            finding_query=finding,
            emergency_only=emergency,
            key_only=key,
            hospital_id=_scoped_hospital(db, user, hospital_id),
            limit=limit,
            offset=offset,
        ),
    )
    return {"items": items, "total": total}


@router.get("/worklist/counts")
def worklist_counts_ep(
    q: str = "",
    pid: str = "",
    pname: str = "",
    sex: str = "",
    desc: str = "",
    modality: str = "",
    body_part: str = "",
    date_from: str = "",
    date_to: str = "",
    finding: str = "",
    key: bool = False,
    hospital_id: int = Query(0, description="선택 병원 스코프(0=자동)"),
    db: Session = Depends(get_db),
    user: dict = Depends(current_user),
):
    """SAINT VIEW 상태 카운트 바 — 목록과 동일 스코프/필터(상태·응급 제외)에서 상태별 전 검사 정확 집계."""
    return worklist_counts(
        db,
        WorklistFilter(
            patient_query=q, patient_id=pid, patient_name=pname, sex=sex, study_desc=desc,
            modality=modality, body_part=body_part, date_from=date_from, date_to=date_to,
            finding_query=finding, key_only=key,
            hospital_id=_scoped_hospital(db, user, hospital_id),
        ),
    )


def _scoped_hospital(db: Session, user: dict, selected: int = 0) -> int | None:
    """병원 스코프 결정 (병원 선택 → PACS Viewer 흐름):
    - 시스템 관리자(병원 미소속 admin): 선택 병원으로 필터, 미선택이면 전체.
    - 병원 소속 사용자: 항상 자기 병원으로 고정(테넌시).
    - 그 외(레거시 단일테넌시): 전체.
    """
    is_sys_admin = user.get("role") == "admin" and not user.get("hid")
    hid = user.get("hid")
    if is_sys_admin:
        return selected or None
    if hid:
        return hid  # 병원 소속 — 자기 병원 고정
    return None


def _require_study(db: Session, study_id: int, user: dict) -> Study:
    """검사 단위 병원 스코프 가드 — 시스템관리자=전체, 병원 소속=자기 병원 검사만.
    없거나 타 병원이면 404(존재 은닉). 모든 per-study 엔드포인트 단일 진입점(테넌시 IDOR 차단)."""
    study = db.get(Study, study_id)
    if not study:
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    is_sys_admin = user.get("role") == "admin" and not user.get("hid")
    if not is_sys_admin and user.get("hid") and study.hospital_id != user.get("hid"):
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    return study


class NlQueryBody(BaseModel):
    text: str


@router.post("/worklist/nl-query")
def nl_query(body: NlQueryBody, user: dict = Depends(current_user)):
    """S1 자연어 검색 — 자연어를 필터로 변환해 미리보기 반환(적용은 사용자 확인 후)."""
    from app.rag.nl_query import nl_to_query

    if not body.text.strip():
        raise HTTPException(status_code=400, detail="검색 문장을 입력하세요")
    return nl_to_query(body.text)


@router.get("/studies/{study_id}")
def get_study(study_id: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    _require_study(db, study_id, user)   # 병원 스코프 가드
    detail = study_detail(db, study_id)
    if not detail:
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    return detail


@router.post("/studies/{study_id}/analyze")
def analyze(study_id: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """AI 초안 (재)생성 트리거 — 워커가 비동기 처리."""
    study = _require_study(db, study_id, user)
    if not study:
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    if study.report_locked:
        # 확정 잠금(Fixed) 중 AI 재생성 차단 (SPEC §C)
        from app.services.report_service import LOCKED_MSG

        raise HTTPException(status_code=409, detail=LOCKED_MSG)
    job = queue_ai_job(db, study, kind="regenerate")
    if job is None:
        # AI 판독 보류(ai.policy.draft_enabled=off) — RAG Structured Report 개편 전까지 기본 비활성
        raise HTTPException(status_code=409,
                            detail="AI 판독 초안 기능이 보류 중입니다 — 설정 > AI 에서 활성화할 수 있습니다")
    return {"job_id": job.id, "status": job.status}


class BookmarkBody(BaseModel):
    bookmark: bool


@router.put("/studies/{study_id}/bookmark")
def set_bookmark(
    study_id: int, body: BookmarkBody, db: Session = Depends(get_db), user: dict = Depends(current_user)
):
    """BOOKMARK 컬럼(★) 토글 — UBPACS Filter Setting 항목."""
    from app.models import AuditLog

    study = _require_study(db, study_id, user)
    if not study:
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    study.bookmark = body.bookmark
    db.add(AuditLog(action="bookmark_set", target_type="study", target_id=str(study_id),
                    detail={"by": user["sub"], "bookmark": body.bookmark}))
    db.commit()
    return {"ok": True, "bookmark": study.bookmark}


class MemoBody(BaseModel):
    memo: str


@router.put("/studies/{study_id}/memo")
def set_memo(
    study_id: int, body: MemoBody, db: Session = Depends(get_db), user: dict = Depends(current_user)
):
    """MEMO window (UBPACS-Z Worklist 구성) — 검사 단위 사용자 메모."""
    from app.models import AuditLog

    study = _require_study(db, study_id, user)
    if not study:
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    study.memo = body.memo[:2000]
    db.add(AuditLog(action="memo_set", target_type="study", target_id=str(study_id),
                    detail={"by": user["sub"], "len": len(body.memo)}))
    db.commit()
    return {"ok": True}


class PriorityBody(BaseModel):
    emergency: bool


@router.put("/studies/{study_id}/priority")
def set_priority(
    study_id: int, body: PriorityBody, db: Session = Depends(get_db), user: dict = Depends(current_user)
):
    """F-15: Emergency/STAT 플래그 토글 (컨텍스트 메뉴 Priority)."""
    from app.models import AuditLog

    study = _require_study(db, study_id, user)
    if not study:
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    study.emergency = body.emergency
    db.add(AuditLog(action="priority_set", target_type="study", target_id=str(study_id),
                    detail={"by": user["sub"], "emergency": body.emergency}))
    db.commit()
    return {"ok": True, "emergency": study.emergency}


@router.get("/studies/{study_id}/series-tree")
def series_tree(study_id: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """시리즈→인스턴스 트리 + 썸네일 URL — 자체 뷰어 세로 썸네일용."""
    from app.config import get_settings
    from app.dicom.orthanc import OrthancClient

    study = _require_study(db, study_id, user)
    if not study:
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    if not study.orthanc_id:
        return {"study_uid": study.study_uid, "series": []}
    import logging

    import httpx as _httpx

    client = OrthancClient()
    try:
        # alive() 사전 왕복 제거 — 실패는 아래 호출이 곧바로 드러난다(열기당 GET /system 1회 절감)
        tree = client.series_tree(study.orthanc_id)
    except _httpx.HTTPError as e:
        # Orthanc 미가용/HTTP 오류만 우아 강등(빈 트리) — 코드 버그류는 그대로 500 으로 노출
        logging.getLogger("saintview.worklist").warning(
            "series-tree Orthanc 실패(study=%s, orthanc=%s): %s", study_id, study.orthanc_id, e)
        return {"study_uid": study.study_uid, "series": []}
    finally:
        client.close()
    # Exam Control 오버레이 — 소프트 삭제·재귀속(이동) 반영(DB 행 없으면 원본 그대로)
    from app.services.examctl_service import overlay_viewer_tree

    tree = overlay_viewer_tree(db, study, tree)
    base = get_settings().orthanc_preview_base   # 클라이언트 브라우저용(상대경로 기본, Vite 프록시)
    for s in tree:
        for inst in s["instances"]:
            inst["preview_url"] = f"{base}/instances/{inst['orthanc_id']}/preview"
    return {"study_uid": study.study_uid, "series": tree}


@router.get("/studies/{study_id}/instances")
def study_instances(study_id: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """인스턴스 목록 + 썸네일 URL — 키이미지 선택 UI (F-16)."""
    from app.config import get_settings
    from app.dicom.orthanc import OrthancClient

    study = _require_study(db, study_id, user)
    if not study:
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    if not study.orthanc_id:
        return {"items": [], "key_images": study.key_images or []}
    client = OrthancClient()
    try:
        if not client.alive():
            return {"items": [], "key_images": study.key_images or []}
        items = client.study_instances(study.orthanc_id)
    finally:
        client.close()
    # Exam Control 반영 — 소프트 삭제 이미지 제외 + 재귀속(이동 In) 추가
    from app.services.examctl_service import filter_visible_instances

    items = filter_visible_instances(db, study, items)
    base = get_settings().orthanc_preview_base   # 클라이언트 브라우저용(상대경로 기본, Vite 프록시)
    for it in items:
        it["preview_url"] = f"{base}/instances/{it['orthanc_id']}/preview"
    return {"items": items, "key_images": study.key_images or []}


@router.post("/import-dicom")
async def import_dicom(
    files: list[UploadFile] = File(...),
    hospital_id: int = Query(0, description="선택 병원 귀속(시스템 관리자용, 0=자동)"),
    db: Session = Depends(get_db),
    user: dict = Depends(current_user),
):
    """USB/CD 등에서 고른 .dcm 파일을 Orthanc(자체 저장소)에 올리고 로컬 DB에 등록.

    원본 PiViewSTAR 'Import DICOM Files' 대응 — 파일별 결과(성공/중복/실패)를 반환한다.
    """
    import io
    import os
    import re
    from pathlib import Path

    from pydicom import dcmread

    from app.dicom.orthanc import OrthancClient
    from app.models import AuditLog
    from app.services.study_service import register_study

    client = OrthancClient()
    if not client.alive():
        raise HTTPException(status_code=503, detail="Orthanc 저장소에 연결할 수 없습니다")

    # 로컬 폴더 저장소 — 환자ID/검사일_모달리티/SOP.dcm (SAINTVIEW_IMPORT_DIR 로 변경 가능)
    import_root = Path(os.getenv("SAINTVIEW_IMPORT_DIR",
                                 str(Path(__file__).resolve().parents[2] / "storage" / "import")))
    safe = lambda s: re.sub(r"[^\w\-.]", "_", s or "UNKNOWN")[:64]  # noqa: E731

    def _image_to_sc(raw: bytes, filename: str) -> bytes | None:
        """JPEG/PNG/BMP → DICOM Secondary Capture 변환 (일반 이미지도 PACS 파이프라인으로)."""
        try:
            import io as _io
            from datetime import datetime

            from PIL import Image
            from pydicom.dataset import Dataset, FileMetaDataset
            from pydicom.uid import ExplicitVRLittleEndian, generate_uid

            img = Image.open(_io.BytesIO(raw)).convert("RGB")
            stem = re.sub(r"\.[^.]+$", "", filename or "image")
            meta = FileMetaDataset()
            meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.7"   # Secondary Capture
            meta.MediaStorageSOPInstanceUID = generate_uid()
            meta.TransferSyntaxUID = ExplicitVRLittleEndian
            ds = Dataset()
            ds.file_meta = meta
            ds.SOPClassUID = meta.MediaStorageSOPClassUID
            ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
            ds.StudyInstanceUID = generate_uid()
            ds.SeriesInstanceUID = generate_uid()
            ds.PatientID = "MEDIA"
            ds.PatientName = safe(stem)[:48]
            ds.Modality = "OT"
            now = datetime.now()
            ds.StudyDate = now.strftime("%Y%m%d")
            ds.StudyTime = now.strftime("%H%M%S")
            ds.StudyDescription = f"Media Import — {stem[:40]}"
            ds.SeriesNumber = 1
            ds.InstanceNumber = 1
            ds.SamplesPerPixel = 3
            ds.PhotometricInterpretation = "RGB"
            ds.PlanarConfiguration = 0
            ds.Rows, ds.Columns = img.height, img.width
            ds.BitsAllocated = 8
            ds.BitsStored = 8
            ds.HighBit = 7
            ds.PixelRepresentation = 0
            ds.PixelData = img.tobytes()
            buf = _io.BytesIO()
            ds.save_as(buf, write_like_original=False)
            return buf.getvalue()
        except Exception:  # noqa: BLE001 — 변환 실패 시 원본 그대로(Orthanc가 거부)
            return None

    results = []
    ok = 0
    parent_studies: set[str] = set()   # 업로드된 인스턴스의 Orthanc StudyID — 즉시 등록용
    for f in files:
        data = await f.read()
        if not data:
            results.append({"filename": f.filename, "size": 0, "status": "빈 파일"})
            continue
        # 일반 이미지(JPEG/PNG/BMP)는 DICOM SC 로 변환해 동일 파이프라인으로 등록
        if re.search(r"\.(jpe?g|png|bmp)$", f.filename or "", re.I):
            sc = _image_to_sc(data, f.filename or "image")
            if sc is not None:
                data = sc
        try:
            r = client.upload_dicom(data)
            status = "중복" if r.get("Status") == "AlreadyStored" else "성공"
            if status == "성공":
                ok += 1
            if r.get("ParentStudy"):
                parent_studies.add(r["ParentStudy"])
            # 로컬 폴더에 사본 저장 (중복 포함 — 파일 단위 실패는 격리)
            try:
                ds = dcmread(io.BytesIO(data), stop_before_pixels=True, force=True)
                sub = import_root / safe(str(getattr(ds, "PatientID", ""))) \
                    / f"{safe(str(getattr(ds, 'StudyDate', '')))}_{safe(str(getattr(ds, 'Modality', '')))}"
                sub.mkdir(parents=True, exist_ok=True)
                name = safe(str(getattr(ds, "SOPInstanceUID", "")) or f.filename or "instance")
                (sub / f"{name}.dcm").write_bytes(data)
            except Exception:  # noqa: BLE001 — 로컬 사본 실패는 Import 자체를 막지 않는다
                pass
            results.append({"filename": f.filename, "size": len(data), "status": status})
        except Exception as e:  # noqa: BLE001 — 파일 단위 실패는 격리해 계속 진행
            results.append({"filename": f.filename, "size": len(data),
                            "status": f"실패: {str(e)[:60]}"})

    # 즉시 등록 — StableStudy 대기 없이 업로드된 검사들을 로컬 DB(studies)에 직접 upsert
    registered = 0
    for sid in parent_studies:
        try:
            meta = client.study_metadata(sid)
            tags = meta.get("MainDicomTags", {})
            ptags = meta.get("PatientMainDicomTags", {})
            register_study(
                db,
                study_uid=tags.get("StudyInstanceUID", ""),
                patient_key=ptags.get("PatientID", "UNKNOWN"),
                patient_name=ptags.get("PatientName", ""),
                birth_date=ptags.get("PatientBirthDate", ""),
                sex=ptags.get("PatientSex", ""),
                accession_no=tags.get("AccessionNumber", ""),
                study_date=tags.get("StudyDate", ""),
                study_time=tags.get("StudyTime", ""),
                modality=tags.get("ModalitiesInStudy", "").split("\\")[0]
                if tags.get("ModalitiesInStudy") else "",
                study_desc=tags.get("StudyDescription", ""),
                institution=tags.get("InstitutionName", ""),
                referring_physician=str(tags.get("ReferringPhysicianName", "")),
                department=tags.get("InstitutionalDepartmentName", ""),
                source_aet="IMPORT",
                orthanc_id=sid,
            )
            registered += 1
            # 수신 검사와 동일: 자동 AI 초안 큐잉(중복 가드)
            from sqlalchemy import select as _select

            from app.config import get_settings
            from app.models import AiJob
            from app.services.study_service import queue_ai_job

            st = db.execute(_select(Study).where(
                Study.study_uid == tags.get("StudyInstanceUID", ""))).scalar_one_or_none()
            # 병원 귀속 — Import 는 장비 AET 매핑이 없어 hospital_id=None 이 되므로,
            # 요청자 병원(hid) 또는 선택 병원으로 귀속해 병원 스코프 워크리스트에서도 보이게 한다
            eff_hid = user.get("hid") or hospital_id or None
            if st and st.hospital_id is None and eff_hid:
                st.hospital_id = eff_hid
            if st and st.status == "received" and get_settings().ai_auto_generate:
                pending = db.execute(_select(AiJob.id).where(
                    AiJob.study_id == st.id, AiJob.status.in_(["queued", "running"])).limit(1)).first()
                if not pending:
                    queue_ai_job(db, st)
        except Exception:  # noqa: BLE001 — 검사 단위 등록 실패 격리(상주 워커가 재시도)
            continue
    client.close()

    db.add(AuditLog(account_id=user.get("uid"), action="import_dicom",
                    target_type="study", target_id="",
                    detail={"by": user["sub"], "files": len(files), "uploaded": ok,
                            "registered": registered, "dir": str(import_root)}))
    db.commit()
    return {"processed": len(files), "uploaded": ok, "registered": registered,
            "saved_dir": str(import_root), "results": results}


class KeyImagesBody(BaseModel):
    items: list[dict]  # [{"sop_uid","orthanc_id","instance_number"}]


@router.put("/studies/{study_id}/key-images")
def set_key_images(
    study_id: int, body: KeyImagesBody, db: Session = Depends(get_db), user: dict = Depends(current_user)
):
    from app.models import AuditLog

    study = _require_study(db, study_id, user)
    if not study:
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    study.key_images = body.items
    db.add(AuditLog(action="key_images_set", target_type="study", target_id=str(study_id),
                    detail={"by": user["sub"], "count": len(body.items)}))
    db.commit()
    return {"ok": True, "count": len(body.items)}


class PresentationBody(BaseModel):
    # 시리즈별 표시상태 {series_uid: {wl, invert, flipH, flipV, rot, fx, shutter}}
    series: dict = {}


@router.put("/studies/{study_id}/presentation")
def set_presentation(
    study_id: int, body: PresentationBody, db: Session = Depends(get_db), user: dict = Depends(current_user)
):
    """검사 표시상태(적용 툴: W/L·방향·필터·셔터) 저장 — 재오픈 시 자동 재현. 주석과 별도(주석은 annotations)."""
    from app.models import AuditLog
    from app.services.settings_service import set_setting

    study = _require_study(db, study_id, user)
    if not study:
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    # 빈 값(시리즈 0)은 저장분 삭제로 취급 → 워크리스트 변경표시 해제
    set_setting(db, f"pstate:{study_id}", {"series": body.series or {}}, scope="global")
    db.add(AuditLog(action="presentation_save", target_type="study", target_id=str(study_id),
                    detail={"by": user["sub"], "series": len(body.series or {})}))
    db.commit()
    return {"ok": True, "series": len(body.series or {})}


@router.get("/studies/{study_id}/presentation")
def get_presentation(study_id: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """저장된 표시상태 로드 — 뷰어가 검사 오픈 시 호출해 적용."""
    from app.services.settings_service import get_setting

    v = get_setting(db, f"pstate:{study_id}", default={}) or {}
    return {"series": v.get("series", {}) if isinstance(v, dict) else {}}


@router.post("/studies/{study_id}/ctr")
def measure_ctr_endpoint(
    study_id: int, db: Session = Depends(get_db), user: dict = Depends(current_user)
):
    """S2 자동계측 CTR(심흉비) — AI 초안 계측 + numeric_verify. 확정 아님(라벨 필수)."""
    from sqlalchemy import delete

    from app.models import Annotation, AuditLog
    from app.rag.ctr import measure_ctr

    study = _require_study(db, study_id, user)
    if not study:
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    if study.modality not in ("CR", "DX"):
        raise HTTPException(status_code=409, detail="CTR은 흉부 X선(CR/DX)에서만 계측합니다")

    png: bytes | None = None
    if study.orthanc_id:
        from app.dicom.orthanc import OrthancClient
        from app.rag.image_guard import mask_burn_in

        client = OrthancClient()
        try:
            if client.alive():
                raw = client.study_preview_png(study.orthanc_id)
                if raw:
                    png = mask_burn_in(raw)  # PHI 게이트(절대 규칙 1) — 번인 마스킹 후 전송
        finally:
            client.close()

    result = measure_ctr(study.study_uid, png)

    # AI 계측 주석 영속화 — 기존 ctr 주석은 교체
    db.execute(delete(Annotation).where(Annotation.study_id == study_id, Annotation.kind == "ctr"))
    if result["verified"] and result["ctr"] is not None:
        for name, seg in (("cardiac", result["cardiac"]), ("thoracic", result["thoracic"])):
            db.add(Annotation(
                study_id=study_id, kind="ctr",
                points=[[seg["x1"], seg["y"]], [seg["x2"], seg["y"]]],
                value=result["ctr"], unit="ratio",
                text=f"CTR {name} (AI 초안)",
                source="ai", confidence=result["confidence"], verified=True,
                created_by=user["sub"],
            ))
    db.add(AuditLog(action="ctr_measure", target_type="study", target_id=str(study_id),
                    detail={"by": user["sub"], "ctr": result["ctr"], "verified": result["verified"],
                            "source": result["source"]}))
    db.commit()
    return result


def _anno_out(a) -> dict:
    return {
        "id": a.id, "series_uid": a.series_uid, "sop_uid": a.sop_uid, "kind": a.kind,
        "points": a.points or [], "value": a.value, "unit": a.unit, "text": a.text,
        "source": a.source, "confidence": a.confidence, "verified": a.verified,
        "created_by": a.created_by,
    }


@router.get("/studies/{study_id}/annotations")
def get_annotations(study_id: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """주석/계측 목록 (07 A.4) — 뷰어 로드 시 복원."""
    from sqlalchemy import select

    from app.models import Annotation

    rows = db.execute(select(Annotation).where(Annotation.study_id == study_id)).scalars().all()
    return {"items": [_anno_out(a) for a in rows]}


class AnnotationsBody(BaseModel):
    items: list[dict]  # [{series_uid, sop_uid, kind, points, value?, unit?, text?, source?, confidence?, verified?}]


@router.put("/studies/{study_id}/annotations")
def put_annotations(
    study_id: int, body: AnnotationsBody, db: Session = Depends(get_db), user: dict = Depends(current_user)
):
    """주석 전체 교체 저장 — 뷰어 Save. AI 주석(source=ai)은 라벨 보존."""
    from sqlalchemy import delete

    from app.models import Annotation, AuditLog

    study = _require_study(db, study_id, user)
    if not study:
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    if len(body.items) > 500:
        raise HTTPException(status_code=400, detail="주석은 검사당 500개 이하")
    db.execute(delete(Annotation).where(Annotation.study_id == study_id))
    for it in body.items:
        pts = it.get("points") or []
        if not isinstance(pts, list):
            continue
        db.add(Annotation(
            study_id=study_id,
            series_uid=str(it.get("series_uid", ""))[:128],
            sop_uid=str(it.get("sop_uid", ""))[:128],
            kind=str(it.get("kind", "line"))[:32],
            points=pts,
            value=it.get("value"),
            unit=str(it.get("unit", ""))[:16],
            text=str(it.get("text", ""))[:512],
            source="ai" if it.get("source") == "ai" else "user",
            confidence=it.get("confidence"),
            verified=bool(it.get("verified", False)),
            created_by=user["sub"],
        ))
    db.add(AuditLog(action="annotations_save", target_type="study", target_id=str(study_id),
                    detail={"by": user["sub"], "count": len(body.items)}))
    db.commit()
    return {"ok": True, "count": len(body.items)}


class GspsBody(BaseModel):
    images: list[dict]        # [{sop_uid, series_uid, rows, cols}]
    annotations: list[dict]   # 07 A.4 주석 (points 0~1)
    wc: float | None = None
    ww: float | None = None
    label: str = "SAINTVIEW"


@router.post("/studies/{study_id}/send-gsps")
def send_gsps(
    study_id: int, body: GspsBody, db: Session = Depends(get_db), user: dict = Depends(current_user)
):
    """주석·W/L을 GSPS 표준 객체로 Orthanc(동일 Study)에 저장."""
    from app.dicom.gsps import build_gsps_dataset, gsps_bytes
    from app.dicom.orthanc import OrthancClient
    from app.models import AuditLog, Patient

    study = _require_study(db, study_id, user)
    if not study:
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    if not body.images:
        raise HTTPException(status_code=400, detail="참조 이미지가 없습니다")
    client = OrthancClient()
    try:
        if not client.alive():
            raise HTTPException(status_code=503, detail="Orthanc에 연결할 수 없습니다")
        patient = db.get(Patient, study.patient_id)
        ds = build_gsps_dataset(
            study=study, patient=patient, images=body.images,
            annotations=body.annotations, wc=body.wc, ww=body.ww,
            label=body.label, creator=user["sub"],
        )
        result = client.upload_dicom(gsps_bytes(ds))
        db.add(AuditLog(action="send_gsps", target_type="study", target_id=str(study_id),
                        detail={"by": user["sub"], "annotations": len(body.annotations),
                                "orthanc": result.get("ID", "")}))
        db.commit()
        return {"ok": True, "sop_instance_uid": ds.SOPInstanceUID}
    finally:
        client.close()


class RoiStatsBody(BaseModel):
    sop_uid: str
    kind: str = "rect"            # rect | ellipse | circle
    points: list[list[float]]    # 0~1 정규화 좌표


@router.post("/studies/{study_id}/roi-stats")
def roi_stats(study_id: int, body: RoiStatsBody, db: Session = Depends(get_db),
              user: dict = Depends(current_user)):
    """ROI HU 통계(평균·최소·최대·표준편차·면적) + 기본 W/L — 픽셀 데이터 기반."""
    import io

    from pydicom import dcmread

    from app.dicom.orthanc import OrthancClient
    from app.dicom.roi import roi_statistics

    study = _require_study(db, study_id, user)
    if not study or not study.orthanc_id:
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    if len(body.points) < 2:
        raise HTTPException(status_code=400, detail="ROI 좌표가 부족합니다")
    client = OrthancClient()
    try:
        if not client.alive():
            raise HTTPException(status_code=503, detail="Orthanc에 연결할 수 없습니다")
        oid = None
        for inst in client.study_instances(study.orthanc_id):
            if inst.get("sop_uid") == body.sop_uid:
                oid = inst["orthanc_id"]
                break
        if not oid:
            raise HTTPException(status_code=404, detail="해당 영상을 찾을 수 없습니다")
        try:
            ds = dcmread(io.BytesIO(client.instance_file(oid)), force=True)
            arr = ds.pixel_array
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=f"픽셀 디코딩 실패: {e}")
        if getattr(arr, "ndim", 2) != 2:
            raise HTTPException(status_code=422, detail="그레이스케일 2D 영상만 지원합니다")
        rows, cols = arr.shape
        has_rescale = hasattr(ds, "RescaleSlope") or hasattr(ds, "RescaleIntercept")
        slope = float(getattr(ds, "RescaleSlope", 1) or 1)
        intercept = float(getattr(ds, "RescaleIntercept", 0) or 0)
        ps = getattr(ds, "PixelSpacing", None)
        pixel_spacing = [float(ps[0]), float(ps[1])] if ps else None
        pts_px = [[p[0] * cols, p[1] * rows] for p in body.points]
        stats = roi_statistics(arr, slope=slope, intercept=intercept, kind=body.kind,
                               points_px=pts_px, pixel_spacing=pixel_spacing,
                               has_rescale=has_rescale)
        # 드래그 W/L 초기화용 기본 W/L (태그 → 없으면 데이터 범위)
        wc, ww = _default_wl(ds, arr, slope, intercept)
        stats["wc"], stats["ww"] = wc, ww
        return stats
    finally:
        client.close()


def _default_wl(ds, arr, slope: float, intercept: float):
    """기본 W/L — WindowCenter/Width 태그 우선, 없으면 HU 데이터 범위."""
    def _scalar(v):
        try:
            return float(v[0]) if hasattr(v, "__len__") and not isinstance(v, str) else float(v)
        except (TypeError, ValueError):
            return None
    wc = _scalar(getattr(ds, "WindowCenter", None))
    ww = _scalar(getattr(ds, "WindowWidth", None))
    if wc is not None and ww is not None and ww > 0:
        return round(wc, 1), round(ww, 1)
    import numpy as np

    hu = np.asarray(arr, dtype=float) * slope + intercept
    lo, hi = float(np.percentile(hu, 1)), float(np.percentile(hu, 99))
    return round((lo + hi) / 2, 1), round(max(hi - lo, 1), 1)


@router.get("/studies/{study_id}/gsps")
def load_gsps(study_id: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """검사에 귀속된 GSPS(PR) 객체를 찾아 주석·W/L로 파싱(불러오기 — 타사 PR 표시)."""
    from app.dicom.gsps import GSPS_SOP_CLASS, parse_gsps_dataset
    from app.dicom.orthanc import OrthancClient
    from pydicom import dcmread

    study = _require_study(db, study_id, user)
    if not study:
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    if not study.orthanc_id:
        return {"items": []}
    client = OrthancClient()
    items = []
    try:
        if not client.alive():
            raise HTTPException(status_code=503, detail="Orthanc에 연결할 수 없습니다")
        for inst in client.study_instances(study.orthanc_id):
            oid = inst["orthanc_id"]
            try:
                if client.instance_meta(oid).get("sop_class_uid") != GSPS_SOP_CLASS:
                    continue
                data = client.instance_file(oid)
                import io as _io

                parsed = parse_gsps_dataset(dcmread(_io.BytesIO(data), force=True))
                parsed["sop_instance_uid"] = inst.get("sop_uid", "")
                items.append(parsed)
            except Exception:  # noqa: BLE001 — 개별 인스턴스 오류는 건너뜀
                continue
        return {"items": items}
    finally:
        client.close()


@router.post("/studies/{study_id}/send-kos")
def send_kos(study_id: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """키이미지 선택을 KOS 표준 객체로 Orthanc에 저장 (F-16)."""
    import io

    from app.dicom.kos import build_kos_dataset
    from app.dicom.orthanc import OrthancClient
    from app.models import AuditLog, Patient

    study = _require_study(db, study_id, user)
    if not study:
        raise HTTPException(status_code=404, detail="검사를 찾을 수 없습니다")
    if not study.key_images:
        raise HTTPException(status_code=409, detail="선택된 키이미지가 없습니다")
    client = OrthancClient()
    try:
        if not client.alive():
            raise HTTPException(status_code=503, detail="Orthanc에 연결할 수 없습니다")
        enriched = []
        for ki in study.key_images:
            meta = client.instance_meta(ki["orthanc_id"]) if ki.get("orthanc_id") else {}
            enriched.append({**ki, **meta})
        patient = db.get(Patient, study.patient_id)
        ds = build_kos_dataset(study=study, patient=patient, key_images=enriched, creator=user["sub"])
        buf = io.BytesIO()
        ds.save_as(buf, write_like_original=False)
        result = client.upload_dicom(buf.getvalue())
        db.add(AuditLog(action="send_kos", target_type="study", target_id=str(study_id),
                        detail={"by": user["sub"], "orthanc": result.get("ID", "")}))
        db.commit()
        return {"ok": True, "sop_instance_uid": ds.SOPInstanceUID}
    finally:
        client.close()
