"""WebPACS Live API — 인계 PACS(A) 직결 모드의 뷰어 동형 엔드포인트.

프론트 api.ts 가 가상 id(vid ≥ 90,000,000)를 감지하면 이 라우터로 옵니다.
응답 스키마는 기존 로컬 계약(/api/worklist·/api/studies/{id}/…·/api/reports/…)과 동형 —
뷰어/판독 컴포넌트는 무수정으로 동작합니다. 데이터 원본은 전적으로 A(복사 없음).

픽셀(rendered/thumb)은 <img>·Cornerstone 이 Authorization 헤더 없이 요청하므로
인증 의존성을 걸지 않는다(개발 기본 — 기존 Orthanc /dicom-web 프록시와 동일 자세.
운영은 리버스 프록시에서 접근 통제 — docs/INTEGRATION_WEBPACS.md).
"""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import current_user, require_effective
from app.db import get_db
from app.services.webpacs_bridge import WebPacsConflict, WebPacsError
from app.services import webpacs_live as live

router = APIRouter(prefix="/api/webpacs/live", tags=["webpacs-live"])

_UID_RE = re.compile(r"^[0-9.]{1,64}$")   # DICOM UID — 숫자/점만(경로 인젝션 차단)


def _uid(*values: str) -> None:
    """DICOM UID 화이트리스트 — `?`·`/` 등 인젝션으로 원격 인스턴스 원본 노출 차단."""
    for v in values:
        if not _UID_RE.match(v or ""):
            raise HTTPException(status_code=400, detail="잘못된 UID 형식입니다")


def _wrap(fn, *args, **kw):
    """WebPacs 예외 → HTTP 매핑(409 는 사용자 메시지 그대로).

    호출 인자는 반드시 이 함수 내부에서 평가되도록 fn 을 클로저로 넘길 것
    (인자 위치에서 live_client()/to_remote_idx() 가 먼저 평가되면 502/409 가 500 으로 샌다)."""
    try:
        return fn(*args, **kw)
    except WebPacsConflict as e:
        raise HTTPException(status_code=409, detail=str(e))
    except WebPacsError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/worklist")
def worklist(
    q: str = "", pid: str = "", pname: str = "", modality: str = "",
    date_from: str = "", date_to: str = "",
    limit: int = Query(100, le=300), offset: int = 0,
    db: Session = Depends(get_db), user: dict = Depends(current_user),
):
    return _wrap(lambda: live.live_worklist(db, {
        "q": q, "pid": pid, "pname": pname, "modality": modality,
        "date_from": date_from, "date_to": date_to, "limit": limit, "offset": offset,
    }, user))


@router.get("/studies/{vid}")
def study_detail(vid: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    return _wrap(lambda: live.live_detail(db, vid, user))


@router.get("/studies/{vid}/series-tree")
def series_tree(vid: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    return _wrap(lambda: live.live_series_tree(db, vid, user))


@router.get("/studies/{vid}/instances")
def instances(vid: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """키이미지 UI 계약 동형 — Live 는 키이미지 미지원(빈 선택)."""
    tree = _wrap(lambda: live.live_series_tree(db, vid, user))
    items = [
        {"sop_uid": i["sop_uid"], "instance_number": i["instance_number"],
         "preview_url": i["preview_url"], "series_uid": s["series_uid"]}
        for s in tree["series"] for i in s["instances"]
    ]
    return {"items": items, "key_images": []}


@router.get("/studies/{vid}/reports")
def reports(vid: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    return _wrap(lambda: live.live_reports(db, vid, user))


class SrBody(BaseModel):
    sr_json: dict
    cvr: bool = False   # critical value report — A 알림톡(UA_1296) 발송


@router.put("/reports/{vid}")
def update_report(vid: int, body: SrBody, db: Session = Depends(get_db),
                  user: dict = Depends(require_effective("report.write"))):
    return _wrap(lambda: live.live_save_report(db, vid, body.sr_json, approve=False,
                                               cvr=body.cvr, user=user))


class FinalizeBody(BaseModel):
    sr_json: dict | None = None
    cvr: bool = False


@router.post("/reports/{vid}/finalize")
def finalize_report(vid: int, body: FinalizeBody | None = None, db: Session = Depends(get_db),
                    user: dict = Depends(require_effective("report.finalize"))):
    b = body or FinalizeBody()
    return _wrap(lambda: live.live_save_report(
        db, vid, b.sr_json or live.live_reports(db, vid, user)["items"][0]["sr_json"],
        approve=True, cvr=b.cvr, user=user))


@router.post("/reports/{vid}/finalize-with")
def finalize_with(vid: int, body: FinalizeBody, db: Session = Depends(get_db),
                  user: dict = Depends(require_effective("report.finalize"))):
    """저장+승인 원자 경로 — dock 승인(update→finalize 2call)을 1call 로 쓸 수도 있게."""
    return _wrap(lambda: live.live_save_report(
        db, vid, body.sr_json or live.live_reports(db, vid, user)["items"][0]["sr_json"],
        approve=True, cvr=body.cvr, user=user))


@router.get("/studies/{vid}/state")
def state(vid: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    return _wrap(lambda: live.live_state(db, vid, me=user.get("sub", ""), user=user))


@router.post("/studies/{vid}/claim")
def claim(vid: int, db: Session = Depends(get_db),
          user: dict = Depends(require_effective("report.write"))):
    """판독 작성중 선점(A change_status/report — RI). 타 판독의 작성중=409."""
    return _wrap(lambda: live.live_client(db, user).change_status(live.to_remote_idx(vid), "report"))


@router.post("/studies/{vid}/release")
def release(vid: int, db: Session = Depends(get_db),
            user: dict = Depends(require_effective("report.write"))):
    """선점 해제(A change_status/end → 대기 E). 저장 없이 닫을 때."""
    return _wrap(lambda: live.live_client(db, user).change_status(live.to_remote_idx(vid), "end"))


class HeartbeatBody(BaseModel):
    study_ids: list[int]
    kind: str = "viewer"
    typing: bool = False


@router.post("/heartbeat")
def heartbeat(body: HeartbeatBody, user: dict = Depends(current_user)):
    live.live_heartbeat([i for i in body.study_ids if live.is_live_id(i)],
                        user.get("sub", ""), body.kind, body.typing)
    return {"ok": True}


class AnnoBody(BaseModel):
    items: list[dict]


@router.get("/studies/{vid}/annotations")
def annotations_get(vid: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    return _wrap(lambda: live.live_annotations_get(db, vid, user))


@router.put("/studies/{vid}/annotations")
def annotations_put(vid: int, body: AnnoBody, db: Session = Depends(get_db),
                    user: dict = Depends(require_effective("report.write"))):
    if len(body.items) > 500:
        raise HTTPException(status_code=400, detail="주석이 너무 많습니다(≤500)")
    return _wrap(lambda: live.live_annotations_put(db, vid, body.items, user))


class PstateBody(BaseModel):
    series: dict


@router.get("/studies/{vid}/presentation")
def presentation_get(vid: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    return _wrap(lambda: live.live_presentation_get(db, vid, user))


@router.put("/studies/{vid}/presentation")
def presentation_put(vid: int, body: PstateBody, db: Session = Depends(get_db),
                     user: dict = Depends(current_user)):
    return _wrap(lambda: live.live_presentation_put(db, vid, body.series, user))


# ── A 대응 기능(요구5) — 메모·응급·북마크·PDF ────────────────────────────
class MemoBody(BaseModel):
    memo: str = ""


@router.put("/studies/{vid}/memo")
def set_memo(vid: int, body: MemoBody, db: Session = Depends(get_db),
             user: dict = Depends(current_user)):
    return _wrap(lambda: live.live_set_memo(db, vid, body.memo, user))


class PriorityBody(BaseModel):
    emergency: bool = False


@router.put("/studies/{vid}/priority")
def set_priority(vid: int, body: PriorityBody, db: Session = Depends(get_db),
                 user: dict = Depends(current_user)):
    return _wrap(lambda: live.live_set_priority(db, vid, body.emergency, user))


class BookmarkBody(BaseModel):
    bookmark: bool = False


@router.put("/studies/{vid}/bookmark")
def set_bookmark(vid: int, body: BookmarkBody, db: Session = Depends(get_db),
                 user: dict = Depends(current_user)):
    return _wrap(lambda: live.live_set_bookmark(db, vid, body.bookmark, user))


@router.get("/reports/{vid}/pdf")
def report_pdf(vid: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    pdf, fname = _wrap(lambda: live.live_report_pdf(db, vid, user))
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{fname}"'})


class RoiBody(BaseModel):
    sop_uid: str
    kind: str = "rect"
    points: list[list[float]]


@router.post("/studies/{vid}/roi-stats")
def roi_stats(vid: int, body: RoiBody, db: Session = Depends(get_db),
              user: dict = Depends(current_user)):
    """서버 픽셀 HU 통계 — A 인스턴스를 받아 로컬과 동일 계산(roi.roi_statistics)."""
    import io as _io

    from pydicom import dcmread

    from app.dicom.roi import roi_statistics

    if len(body.points) < 2:
        raise HTTPException(status_code=400, detail="좌표가 부족합니다")
    uids = _wrap(lambda: live.find_uids(db, vid, body.sop_uid, user))
    if not uids:
        raise HTTPException(status_code=404, detail="인스턴스를 찾을 수 없습니다")
    data = _wrap(lambda: live.get_instance_bytes(live.service_client(db), *uids))
    try:
        ds = dcmread(_io.BytesIO(data), force=True)
        return roi_statistics(ds, body.kind, body.points)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"픽셀 해석 실패: {str(e)[:120]}")


def _render_with_retry(db: Session, study_uid: str, series_uid: str, sop_uid: str,
                       wc, ww, fmt: str, quality: int) -> tuple[bytes, str]:
    """캐시 유래 렌더 실패 시 캐시 무효화 후 1회 재다운로드-재시도(손상 캐시 영구 고착 방지)."""
    client = _wrap(lambda: live.service_client(db))
    data = _wrap(lambda: live.get_instance_bytes(client, study_uid, series_uid, sop_uid))
    try:
        return live.render_instance(data, wc, ww, fmt=fmt, quality=quality)
    except Exception:  # noqa: BLE001 — 손상 캐시 의심 → 삭제 후 강제 재다운로드 1회
        live.invalidate_instance(sop_uid)
        data = _wrap(lambda: live.get_instance_bytes(client, study_uid, series_uid, sop_uid, force=True))
        return live.render_instance(data, wc, ww, fmt=fmt, quality=quality)


# ── 픽셀 (무인증 — <img>/Cornerstone 헤더 없는 요청. 모듈 독스트링 참조) ──
@router.get("/dicom-web/studies/{study_uid}/series/{series_uid}/instances/{sop_uid}/rendered")
def rendered(study_uid: str, series_uid: str, sop_uid: str,
             window: str = "", accept: str = "", quality: int = 90,
             db: Session = Depends(get_db)):
    """뷰어 rendered 동형 — window=C,W[,linear] 서버측 윈도잉. Orthanc 프록시 대체."""
    _uid(study_uid, series_uid, sop_uid)   # UID 인젝션 차단(원본 DICOM 노출 방지)
    wc = ww = None
    if window:
        parts = window.split(",")
        try:
            wc = float(parts[0])
            ww = float(parts[1])
        except (ValueError, IndexError):
            wc = ww = None
    fmt = "jpeg" if "jpeg" in (accept or "") else "png"
    try:
        img, media = _render_with_retry(db, study_uid, series_uid, sop_uid, wc, ww, fmt, quality)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 — 코덱/픽셀 문제를 502 로 구분
        raise HTTPException(status_code=502, detail=f"렌더 실패: {str(e)[:120]}")
    return Response(content=img, media_type=media,
                    headers={"Cache-Control": "private, max-age=60"})


@router.get("/thumb/{study_uid}/{series_uid}/{sop_uid}")
def thumb(study_uid: str, series_uid: str, sop_uid: str, db: Session = Depends(get_db)):
    """썸네일 — A v2 사전생성 썸네일 프록시(실패 시 렌더 폴백)."""
    _uid(study_uid, series_uid, sop_uid)   # UID 인젝션 차단(?/ 로 인스턴스 원본 노출 방지)
    client = _wrap(lambda: live.service_client(db))
    data = None
    try:
        data = client.thumbnail(study_uid, series_uid, sop_uid)
    except WebPacsError:
        data = None
    if data:
        return Response(content=data, media_type="image/jpeg",
                        headers={"Cache-Control": "private, max-age=3600"})
    try:
        img, media = _render_with_retry(db, study_uid, series_uid, sop_uid, None, None, "jpeg", 70)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"썸네일 실패: {str(e)[:120]}")
    return Response(content=img, media_type=media,
                    headers={"Cache-Control": "private, max-age=3600"})
