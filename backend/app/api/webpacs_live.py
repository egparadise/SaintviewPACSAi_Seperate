"""WebPACS Live API — 인계 PACS(A) 직결 모드의 뷰어 동형 엔드포인트.

프론트 api.ts 가 가상 id(vid ≥ 90,000,000)를 감지하면 이 라우터로 옵니다.
응답 스키마는 기존 로컬 계약(/api/worklist·/api/studies/{id}/…·/api/reports/…)과 동형 —
뷰어/판독 컴포넌트는 무수정으로 동작합니다. 데이터 원본은 전적으로 A(복사 없음).

픽셀(rendered/thumb)은 <img> 가 Authorization 헤더를 붙일 수 없어 예전에는 무인증이었다
(운영은 리버스 프록시에서 통제한다고 적어 두었으나 deploy/nginx-viewer.conf 에 그런 통제는
없었다 — /api/ 를 그대로 백엔드로 프록시한다). 지금은 deps.pixel_user 로 인증한다:
Authorization 헤더가 있으면 그대로 쓰고, 없으면 HttpOnly 픽셀 쿠키(sv_pix=불투명 sid)를
받는다. URL 은 한 글자도 바뀌지 않으므로 ETag/304·캐시·미리보기(preview=1)가 모두 그대로다.
선택 근거와 버린 대안(서명 URL·쿼리 토큰)은 app/api/deps.py 의 주석에 있다.

⚠ 남은 한계(인가): 인증만 있고 인가는 없다 — 로그인한 사용자면 UID 를 아는 어떤 검사의
픽셀도 받을 수 있다(워크리스트/series-tree 에도 병원 스코프가 없다). Live 는 A 단일 원본이고
브리지 설정(webpacs.bridge)이 전역 1개(base_url·서비스 계정)라 B 에는 'A 의 이 검사가 어느
가입 병원 것인가'를 판정할 근거 자체가 없다 — 스코프를 넣으려면 A↔병원 매핑을 먼저 설계해야
하므로 이번 변경 범위 밖이다. 후속으로 '그 세션이 series-tree 로 연 study_uid 집합'을 기록해
스코프를 좁힌다.
  ※ 다만 '누구나 로그인 자격을 자가 발급'하던 경로는 막았다 — 공개 가입은 기본 OFF 이고
    (SAINTVIEW_SIGNUP_ENABLED 기본 0, prod 는 켜져 있으면 기동 거부), 켜더라도 가입으로
    만들어진 병원·계정은 승인 전까지 enabled=False 라 로그인 자체가 안 된다.
⚠ 범위 밖(더 큰 구멍): 비-Live 모드의 preview_url(/orthanc/instances/*/preview)과
/dicom-web/* 는 여전히 무인증으로 Orthanc·OHIF nginx 에 직결 프록시된다. 별도 항목으로 처리.
"""
from __future__ import annotations

import hashlib
import re

from fastapi import (
    APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, Response,
)
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import current_user, pixel_user, require_effective
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
def study_detail(vid: int, related: int = 1, db: Session = Depends(get_db),
                 user: dict = Depends(current_user)):
    """related=0 이면 과거검사 조회를 건너뛴다 — 뷰어 오픈은 이 경로를 쓴다.

    A 의 환자별 검사 검색이 사이트에 따라 수 초(실측 4.11s)라서, 예전에는 뷰어가
    그 시간만큼 '뷰어 로딩…' 상태로 멈춰 있었다. 과거검사는 화면이 뜬 뒤 따로 받는다.
    """
    return _wrap(lambda: live.live_detail(db, vid, user, with_related=bool(related)))


@router.get("/studies/{vid}/compare-candidates")
def live_compare_candidates(vid: int, basis: str = "patient",
                            modality: int = 0, body_part: int = 0, period: str = "all",
                            db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """Live Compare 후보 — 로컬 경로와 같은 계약(basis/modality/body_part/period)."""
    from app.services import compare_basis

    items = _wrap(lambda: compare_basis.live_candidates(
        db, vid, user, basis=basis,
        by_modality=bool(modality), by_body_part=bool(body_part), period=period))
    return {"items": items, "basis": basis, "period": period,
            "by_modality": bool(modality), "by_body_part": bool(body_part)}


@router.get("/studies/{vid}/related")
def study_related(vid: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """과거검사(동일 환자) — 뷰어가 화면을 띄운 뒤 별도로 받아 채운다. 환자 단위 60초 캐시."""
    return {"items": _wrap(lambda: live.live_related(db, vid, user))}


@router.get("/studies/{vid}/series-tree")
def series_tree(vid: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    return _wrap(lambda: live.live_series_tree(db, vid, user))


@router.post("/studies/{vid}/prefetch")
def prefetch(vid: int, tasks: BackgroundTasks, db: Session = Depends(get_db),
             user: dict = Depends(current_user)):
    """검사 오픈 시 호출 — 전 인스턴스 원본을 백그라운드 병렬 예열(A→B 지연 은닉).
    즉시 반환하고 워밍은 백그라운드에서 진행. 별도 DB 세션 사용."""
    def _bg():
        from app.db import SessionLocal
        with SessionLocal() as bg_db:
            try:
                live.prefetch_series(bg_db, vid, user)
            except Exception:  # noqa: BLE001 — 프리페치 실패는 온디맨드 렌더로 폴백
                pass
    tasks.add_task(_bg)
    return {"ok": True, "started": True}


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


@router.get("/sse-status")
def sse_status(db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """A SSE(`/see/stream`) 구독 상태 + 변경 리비전.

    프론트는 이 값(rev)이 바뀔 때만 워크리스트를 재조회한다 → 5초 고정 폴링 대체.
    connected=false 면 프론트가 기존 폴링으로 자동 폴백(A 구버전·연결 실패 대비)."""
    from app.services.webpacs_sse import ensure_sse

    return ensure_sse(db)


@router.get("/studies/{vid}/state")
def state(vid: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    return _wrap(lambda: live.live_state(db, vid, me=user.get("sub", ""), user=user))


@router.post("/studies/{vid}/claim")
def claim(vid: int, db: Session = Depends(get_db),
          user: dict = Depends(require_effective("report.write"))):
    """판독 작성중 선점(A change_status/report — RI). 타 판독의 작성중=409."""
    out = _wrap(lambda: live.live_client(db, user).change_status(live.to_remote_idx(vid), "report"))
    live.invalidate_live_state(vid)      # 내가 방금 바꾼 상태는 즉시 보여야 한다
    return out


@router.post("/studies/{vid}/release")
def release(vid: int, db: Session = Depends(get_db),
            user: dict = Depends(require_effective("report.write"))):
    """선점 해제(A change_status/end → 대기 E). 저장 없이 닫을 때."""
    out = _wrap(lambda: live.live_client(db, user).change_status(live.to_remote_idx(vid), "end"))
    live.invalidate_live_state(vid)
    return out


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
    """캐시 유래 렌더 실패 시 캐시 무효화 후 1회 재다운로드-재시도(손상 캐시 영구 고착 방지).

    ⚡ 원본 bytes 는 **지연 로드** — 디코드 결과가 메모리에 있으면(스크롤 재방문·W/L 드래그)
    수 MB 파일 읽기를 통째로 건너뛴다. 예전엔 캐시 적중이어도 매 프레임 read_bytes() 를 했다.
    """
    client_box: list = []

    def _client():
        if not client_box:
            client_box.append(_wrap(lambda: live.service_client(db)))
        return client_box[0]

    def _load(force: bool = False):
        return _wrap(lambda: live.get_instance_bytes(
            _client(), study_uid, series_uid, sop_uid, force=force))

    try:
        return live.render_instance(_load, wc, ww, fmt=fmt, quality=quality, sop_uid=sop_uid)
    except Exception:  # noqa: BLE001 — 손상 캐시 의심 → 삭제 후 강제 재다운로드 1회
        live.invalidate_instance(sop_uid)
        return live.render_instance(lambda: _load(True), wc, ww,
                                    fmt=fmt, quality=quality, sop_uid=sop_uid)


# ── 픽셀 (PHI — pixel_user: Bearer 또는 HttpOnly 픽셀 쿠키. 모듈 독스트링 참조) ──
@router.get("/dicom-web/studies/{study_uid}/series/{series_uid}/instances/{sop_uid}/rendered")
def rendered(study_uid: str, series_uid: str, sop_uid: str, request: Request,
             window: str = "", accept: str = "", quality: int = 90, preview: int = 0,
             db: Session = Depends(get_db), user: dict = Depends(pixel_user)):
    """뷰어 rendered 동형 — window=C,W[,linear] 서버측 윈도잉. Orthanc 프록시 대체.

    ⚠ 상태코드 순서 — 인증(401)이 UID 형식 검증(400)보다 먼저다. FastAPI 는 의존성을 모두
      푼 뒤에야 함수 본문을 실행하므로 자격 없이 잘못된 UID 를 보내면 400 이 아니라 401 이
      나온다. 이 순서를 택한 이유: '자격이 없으면 언제나 401' 이 예외 없이 성립해야
      추론이 쉽고, 무자격자가 UID 형식 판정으로 엔드포인트 동작을 탐침하지 못한다.
      인증된 호출자에 대한 400 계약은 그대로다(test_live_bad_uid_rejected 가 양쪽을 고정).
    """
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
    # ⚡ preview=1 — A 가 배치로 미리 만들어 둔 512×512 q80 JPEG(≈40KB)을 그대로 전달한다.
    # 원본 DICOM(수 MB) 다운로드·디코드·인코딩을 전부 건너뛰므로 첫 화면이 즉시 뜬다.
    # 뷰어는 이걸 먼저 깔고 그 위에 원본 해상도를 얹는다(2단계 표시).
    if preview:
        key = f"pv|{sop_uid}"
        hit = live.encoded_get(key)
        if hit is None:
            data = _wrap(lambda: live.preview_bytes(db, study_uid, series_uid, sop_uid))
            if not data:
                raise HTTPException(status_code=404, detail="미리보기 없음")
            hit = (data, "image/jpeg")
            live.encoded_put(key, hit)
        return Response(content=hit[0], media_type=hit[1],
                        headers={"Cache-Control": "private, max-age=3600"})
    # (SOP, 윈도우, 형식, 품질) 은 **불변** — 같은 키면 항상 같은 바이트다.
    # 그래서 ETag 로 304 를 줄 수 있고, 캐시 수명을 60초에서 1시간으로 올려도 안전하다.
    # (예전 60초: 60초 지나 되돌아온 슬라이스마다 재다운로드+재렌더가 걸렸다)
    etag = 'W/"' + hashlib.sha1(
        f"{sop_uid}|{window}|{fmt}|{quality}".encode()).hexdigest()[:20] + '"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag,
                                                  "Cache-Control": "private, max-age=3600"})
    cached = live.encoded_get(etag)
    if cached is None:
        try:
            cached = _render_with_retry(db, study_uid, series_uid, sop_uid, wc, ww, fmt, quality)
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001 — 코덱/픽셀 문제를 502 로 구분
            raise HTTPException(status_code=502, detail=f"렌더 실패: {str(e)[:120]}")
        live.encoded_put(etag, cached)
    img, media = cached
    return Response(content=img, media_type=media,
                    headers={"Cache-Control": "private, max-age=3600", "ETag": etag})


@router.get("/thumb/{study_uid}/{series_uid}/{sop_uid}")
def thumb(study_uid: str, series_uid: str, sop_uid: str, db: Session = Depends(get_db),
          user: dict = Depends(pixel_user)):
    """썸네일 — A v2 사전생성 썸네일 프록시(실패 시 렌더 폴백).

    rendered 와 같은 이유로 pixel_user 를 쓴다(썸네일 <img> 도 헤더를 못 붙인다).
    응답 URL 은 series-tree 의 preview_url 그대로 — 프론트 11개 소비 지점 수정 0."""
    _uid(study_uid, series_uid, sop_uid)   # UID 인젝션 차단(?/ 로 인스턴스 원본 노출 방지)
    key = f"th|{sop_uid}"
    hit = live.encoded_get(key)       # B 측 캐시 — 예전엔 썸네일마다 A 왕복을 그대로 했다
    if hit is not None:
        return Response(content=hit[0], media_type=hit[1],
                        headers={"Cache-Control": "private, max-age=86400"})
    # ★ 미리보기 상한 **안**에서 가져온다(preview_bytes 가 rendered→thumbnail 폴백까지 한다).
    #   예전에는 여기서 A 를 직접 불러 게이트 밖이었고, 썸네일이 시리즈마다 나가므로
    #   스레드풀을 채우는 가장 쉬운 경로였다.
    try:
        data = live.preview_bytes(db, study_uid, series_uid, sop_uid)
    except WebPacsError:
        data = None
    if data:
        live.encoded_put(key, (data, "image/jpeg"))
        return Response(content=data, media_type="image/jpeg",
                        headers={"Cache-Control": "private, max-age=86400"})
    # 렌더 폴백 — A 가 썸네일을 미리 만들어 두지 않은 사이트가 실제로 있다.
    # ⚠ 한 번 404 로 바꿨다가 **썸네일이 통째로 빈 화면**이 됐다(실사용 회귀). 폴백은 필요하다.
    #   다만 무제한으로 두면 썸네일 폭주가 스레드풀을 먹으므로 **프리뷰 게이트 안**에서만 돈다.
    #   (내부의 원본 취득은 픽셀 슬롯을 잠깐 쓰지만, 동시 진입 자체가 프리뷰 상한으로 묶인다.
    #    픽셀 슬롯 보유자는 프리뷰 슬롯을 기다리지 않으므로 교착은 없다.)
    try:
        with live.a_preview_slot():
            img, media = _render_with_retry(db, study_uid, series_uid, sop_uid, None, None, "jpeg", 70)
    except WebPacsError:
        raise HTTPException(status_code=404, detail="썸네일 없음 — 원격 PACS 응답 지연")
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"썸네일 실패: {str(e)[:120]}")
    live.encoded_put(key, (img, "image/jpeg"))
    return Response(content=img, media_type=media,
                    headers={"Cache-Control": "private, max-age=3600"})
