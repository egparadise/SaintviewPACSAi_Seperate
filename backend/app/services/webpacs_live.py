"""WebPACS Live — 인계 PACS(A: webpacs_api)를 단일 원본으로 하는 실시간 직결 모드.

미러(가져오기) 방식과 달리 **복사가 없다**: 워크리스트·검사 상세·판독문·주석은
매 요청 A 의 REST 를 호출해 우리 뷰어 계약(StudyRow/StudyDetail/Report/series-tree)으로
변환하고, 판독 저장/승인은 A 의 `pacs_study_report` 로 되돌려 쓴다(DB 트리거가
study_status 반영). 픽셀은 A DICOMweb v2 인스턴스를 받아 서버측 디코드+윈도잉으로
`/rendered` 동형 PNG/JPEG 를 만든다(디스크 캐시 — 원본 bytes 만 캐시, W/L 은 요청별).

식별자: 가상 검사 id(vid) = VID_BASE + A study_idx. 프론트 api.ts 가 vid 대역이면
`/api/webpacs/live/...` 로 라우팅하므로 뷰어 본체는 무수정으로 동작한다.

동시성/presence: A 의 선점 모델을 그대로 사용 — change_status/report(RI, FOR UPDATE,
타 판독의 409). "누가 잡고 있나"는 study_status==RI + doctor_user_name 이 원본 신호이고
B 클라이언트 간 열람은 인메모리 하트비트로 보강한다.
"""
from __future__ import annotations

import io
import json
import os
import logging
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.services.webpacs_bridge import (
    WebPacsClient,
    WebPacsError,
    client_from_config,
    get_bridge_config,
)

logger = logging.getLogger("saintview.webpacs_live")

VID_BASE = 90_000_000

CACHE_DIR = Path(__file__).resolve().parents[2] / "cache" / "webpacs_live"
CACHE_MAX_FILES = 4000  # 인스턴스 원본 캐시 상한(FIFO 정리)


def is_live_id(study_id: int) -> bool:
    return study_id >= VID_BASE


def to_vid(remote_idx: int) -> int:
    return VID_BASE + int(remote_idx)


def to_remote_idx(vid: int) -> int:
    if not is_live_id(vid):
        raise WebPacsError(f"Live 검사 id 가 아닙니다: {vid}")
    return int(vid) - VID_BASE


# ── 클라이언트 해석 ───────────────────────────────────────────────────────
# 서비스 계정(공유 브리지) — 이미지 검색(<img> 인증 불가)·설정·미인증 경로용.
_client_lock = threading.Lock()
_client: WebPacsClient | None = None
_client_key: tuple | None = None
# per-user A 클라이언트 풀 — (base_url, a_user_id) 키. A 는 계정당 단일 유효 토큰이라
# 같은 A 사용자는 하나의 클라이언트(=하나의 A 토큰)를 공유해 401 폭풍을 막는다.
_user_clients: dict[str, WebPacsClient] = {}
_user_lock = threading.Lock()


def service_client(db: Session) -> WebPacsClient:
    """서비스 계정(공유 브리지) 클라이언트 — 설정(주소/계정) 변경 시 재생성.
    이미지 검색·설정 등 사용자 귀속이 필요 없는 경로용."""
    global _client, _client_key
    cfg = get_bridge_config(db)
    if not cfg.get("enabled"):
        raise WebPacsError("WebPACS 브리지가 비활성입니다 (설정에서 활성화)")
    key = (cfg.get("base_url"), cfg.get("user_id"), cfg.get("password"),
           bool(cfg.get("verify_ssl", True)))
    with _client_lock:
        if _client is None or _client_key != key:
            if _client is not None:
                try:
                    _client.close()
                except Exception:  # noqa: BLE001
                    pass
            _client = client_from_config(cfg)
            _client_key = key
        return _client


def user_client(sess: dict) -> WebPacsClient:
    """사용자별 A 클라이언트 — 그 사용자의 A 토큰으로 A 에 접근·기록(판독 귀속의 핵심).
    sess: webpacs_session 레코드({base_url, token, refresh, a_user_id, sid, verify_ssl, ...})."""
    from app.services import webpacs_session

    key = f"{sess.get('base_url')}|{sess.get('a_user_id')}"
    sid = sess.get("sid", "")
    with _user_lock:
        cli = _user_clients.get(key)
        if cli is None:
            cli = WebPacsClient(
                sess["base_url"], str(sess.get("a_user_id") or ""),
                verify_ssl=bool(sess.get("verify_ssl", True)),
                token=sess.get("token"), refresh_token=sess.get("refresh"),
                on_token=(lambda t, _sid=sid: webpacs_session.update_token(_sid, t)),
            )
            _user_clients[key] = cli
        else:
            # 최신 세션 토큰을 반영(다른 창에서 재로그인해 토큰이 바뀐 경우)
            if sess.get("token"):
                cli._token = sess["token"]  # noqa: SLF001 — 같은 A 사용자 토큰 동기화
        return cli


def live_client(db: Session, user: dict | None = None) -> WebPacsClient:
    """Live 데이터/판독 호출용 클라이언트 해석.

    - user 세션에 A 자격이 있으면 **그 사용자의 A 계정** 클라이언트(요구4·6: 실제 판독의 귀속).
    - 없으면 서비스 계정(공유 브리지)로 폴백(하위호환·이미지·미인증 경로).
    """
    if user:
        from app.services import webpacs_session

        sess = webpacs_session.get(user.get("sid", ""))
        if sess and sess.get("base_url"):
            return user_client(sess)
    return service_client(db)


def has_user_a_session(user: dict | None) -> bool:
    if not user:
        return False
    from app.services import webpacs_session

    return webpacs_session.get(user.get("sid", "")) is not None


def a_user_idx_of(user: dict | None) -> int | None:
    """현재 사용자의 A user_idx(판독 귀속용) — per-user 세션이 있을 때만."""
    if not user:
        return None
    from app.services import webpacs_session

    sess = webpacs_session.get(user.get("sid", ""))
    if sess and sess.get("a_user_idx") is not None:
        try:
            return int(sess["a_user_idx"])
        except (TypeError, ValueError):
            return None
    return None


# ── A study_status → B 상태 매핑 ─────────────────────────────────────────
# I/IR 수신중 · C 취소 · E/RE 대기 · RI 작성중(선점) · REF 참조 · R/RR 작성 · A/RA 승인
def _map_status(study_status: str) -> tuple[str, str, bool]:
    """반환: (B status, read_state, report_locked)."""
    s = (study_status or "").upper()
    if s == "RI":
        return "reading", "reading", False
    if s in ("R", "RR", "REF"):
        return "reading", "read", False
    if s in ("A", "RA"):
        return "finalized", "fixed", True
    return "received", "unread", False   # I/IR/E/RE/C 등


def _split_datetime(dt: str) -> tuple[str, str]:
    """'2026-07-22 13:42:54' → ('20260722','134254')."""
    digits = "".join(ch for ch in str(dt or "") if ch.isdigit())
    return digits[:8], digits[8:14]


# ── B 클라이언트 간 열람/작성 하트비트 (vid 전용, 인메모리) ────────────────
# 슬롯 키 = f"{user}:{kind}" → {ts, typing}. kind: viewer(열람) | report(판독창)
_HEARTBEAT: dict[int, dict[str, dict]] = {}
_HB_LOCK = threading.Lock()
_HB_TTL = 120.0
_HB_TYPING_TTL = 90.0


def live_heartbeat(vids: list[int], username: str, kind: str, typing: bool = False) -> None:
    now = time.time()
    with _HB_LOCK:
        for vid in vids[:64]:
            _HEARTBEAT.setdefault(int(vid), {})[f"{username}:{kind}"] = {"ts": now, "typing": typing}
        for vid in list(_HEARTBEAT):
            slots = {k: v for k, v in _HEARTBEAT[vid].items() if now - v["ts"] < _HB_TTL}
            if slots:
                _HEARTBEAT[vid] = slots
            else:
                del _HEARTBEAT[vid]


def _viewers_of(vid: int) -> list[str]:
    now = time.time()
    with _HB_LOCK:
        slots = _HEARTBEAT.get(int(vid), {})
        return sorted({k.split(":", 1)[0] for k, v in slots.items() if now - v["ts"] < _HB_TTL})


def _report_typers_of(vid: int, exclude: str = "") -> list[str]:
    """이 검사 판독창에서 최근 입력 중인 B 사용자(자기 제외) — B-B 동시 판독 경고용."""
    now = time.time()
    with _HB_LOCK:
        slots = _HEARTBEAT.get(int(vid), {})
        out = set()
        for k, v in slots.items():
            user, _, kind = k.partition(":")
            if kind == "report" and v.get("typing") and now - v["ts"] < _HB_TYPING_TTL \
                    and user and user != exclude:
                out.add(user)
        return sorted(out)


# ── 워크리스트/상세 매핑 ─────────────────────────────────────────────────
def _row_of(r: dict) -> dict:
    status, read_state, locked = _map_status(str(r.get("study_status") or ""))
    d, t = _split_datetime(str(r.get("study_datetime") or ""))
    vid = to_vid(int(r.get("study_idx")))
    doctor = str(r.get("doctor_user_name") or "")
    viewers = _viewers_of(vid)
    memo = ""
    if read_state == "reading" and doctor:
        memo = f"판독중: {doctor}"
    elif viewers:
        memo = f"열람중: {', '.join(viewers)}"
    return {
        "id": vid,
        "study_uid": str(r.get("study_instance_uid") or ""),
        "patient_key": str(r.get("patient_id") or ""),
        "patient_name": str(r.get("patient_name") or ""),
        "sex": str(r.get("patient_sex") or ""),
        "birth_date": "".join(ch for ch in str(r.get("patient_birthday") or "") if ch.isdigit()),
        "accession_no": str(r.get("study_accession_no") or ""),
        "study_date": d,
        "study_time": t,
        "modality": str(r.get("study_modality") or ""),
        "body_part": str(r.get("study_body_part") or ""),
        "study_desc": str(r.get("study_description") or ""),
        "status": status,
        "emergency": str(r.get("study_emergency") or "") == "ER",
        "has_key": False,
        "critical": False,
        "series_count": int(r.get("series_count") or 0),
        "instance_count": int(r.get("image_count") or 0),
        "report_status": {"reading": "in_review", "read": "in_review", "fixed": "finalized"}.get(read_state),
        "impression_preview": str(r.get("report_conclusion") or "")[:120],
        "institution": str(r.get("hospital_name") or ""),
        "referring_physician": doctor,
        "memo": memo,
        "finalized_at": "",
        "department": str(r.get("center_name") or ""),
        "source_aet": "WEBPACS-LIVE",
        "bookmark": False,
        "order_name": "",
        # QC/판독 상태 필드
        "read_state": read_state,
        "viewer_open": bool(viewers),
        "report_typing": False,
        "has_report_text": bool(r.get("report_reading") or r.get("report_conclusion")),
        "image_changed": False,
        "merged": False,
        "report_locked": locked,
    }


def live_worklist(db: Session, params: dict[str, Any], user: dict | None = None) -> dict:
    """A 워크리스트 실시간 조회 → StudyRow 배열(vid). 최신순.
    per-user 세션이 있으면 그 사용자 A 계정으로 조회(A 권한 스코프 그대로 적용)."""
    client = live_client(db, user)
    q: dict[str, str] = {
        "limit": str(min(int(params.get("limit") or 100), 300)),
        "offset": str(int(params.get("offset") or 0)),
        "order_json": json.dumps([{"key": "study_idx", "order": "desc"}]),
    }
    if params.get("pid"):
        q["patient_id"] = str(params["pid"])
    if params.get("pname"):
        q["patient_name"] = str(params["pname"])
    if params.get("modality"):
        q["study_modality"] = str(params["modality"])
    if params.get("date_from"):
        q["study_datetime_start"] = str(params["date_from"])
    if params.get("date_to"):
        q["study_datetime_end"] = str(params["date_to"])
    if params.get("q"):
        q["study_search"] = str(params["q"])
    rows = client.list_studies(q)
    total = client.study_count({k: v for k, v in q.items()
                                if k not in ("limit", "offset", "order_json")})
    items = [_row_of(r) for r in rows
             if str(r.get("study_status") or "").upper() not in ("C",)]
    return {"items": items, "total": total}


def live_detail(db: Session, vid: int, user: dict | None = None) -> dict:
    """StudyDetail 동형 — related_exams 는 동일 환자의 다른 A 검사(vid)."""
    client = live_client(db, user)
    idx = to_remote_idx(vid)
    r = client.study_detail(idx)
    if not r:
        raise WebPacsError("원격 검사를 찾을 수 없습니다")
    row = _row_of(r)
    related: list[dict] = []
    pid = str(r.get("patient_id") or "")
    if pid:
        try:
            others = client.list_studies({
                "patient_id": pid, "limit": "30",
                "order_json": json.dumps([{"key": "study_idx", "order": "desc"}]),
            })
            for o in others:
                if int(o.get("study_idx")) == idx:
                    continue
                od, _ = _split_datetime(str(o.get("study_datetime") or ""))
                st, _, _ = _map_status(str(o.get("study_status") or ""))
                related.append({
                    "id": to_vid(int(o.get("study_idx"))),
                    "study_uid": str(o.get("study_instance_uid") or ""),
                    "study_date": od,
                    "modality": str(o.get("study_modality") or ""),
                    "study_desc": str(o.get("study_description") or ""),
                    "status": st,
                })
        except Exception:  # noqa: BLE001 — 과거검사 실패는 상세 자체를 막지 않음
            pass
    row["clinical_info"] = str(r.get("study_comment") or r.get("report_study_comment") or "")
    row["orthanc_id"] = ""
    row["series"] = []
    row["related_exams"] = related
    return row


# ── series-tree (A series/viewer + v2 시리즈 메타데이터의 기하 태그) ───────
_TREE_CACHE: OrderedDict[int, tuple[float, dict]] = OrderedDict()
_TREE_TTL = 30.0
_TREE_LOCK = threading.Lock()


def _tag(meta: dict, key: str, default=None):
    v = meta.get(key)
    if not v or not isinstance(v, dict):
        return default
    vals = v.get("Value")
    if not vals:
        return default
    return vals


def _tag1(meta: dict, key: str, default=None):
    vals = _tag(meta, key)
    if vals is None:
        return default
    v = vals[0]
    if isinstance(v, dict):   # PN {"Alphabetic": ...}
        return v.get("Alphabetic", default)
    return v


def live_series_tree(db: Session, vid: int, user: dict | None = None) -> dict:
    """series-tree 동형 — instances 에 rows/cols/spacing/position/orientation 포함.
    구조는 사용자 무관이라 vid 로 캐시(픽셀 취득은 서비스 계정)."""
    with _TREE_LOCK:
        hit = _TREE_CACHE.get(vid)
        if hit and time.time() - hit[0] < _TREE_TTL:
            return hit[1]
    client = live_client(db, user)
    idx = to_remote_idx(vid)
    series_rows = client.series_viewer(idx)
    study_uid = ""
    series_out: list[dict] = []
    for s in series_rows:
        se_uid = str(s.get("series_instance_uid") or "")
        st_uid = str(s.get("study_instance_uid") or "")
        study_uid = study_uid or st_uid
        if not se_uid or not st_uid:
            continue
        # v2 메타데이터 — 인스턴스별 기하(실패 시 기본값 폴백)
        meta_by_sop: dict[str, dict] = {}
        try:
            for m in client.series_metadata(st_uid, se_uid):
                sop = _tag1(m, "00080018")
                if sop:
                    meta_by_sop[str(sop)] = m
        except Exception:  # noqa: BLE001
            logger.warning("Live 시리즈 메타데이터 실패 series=%s — 기하 폴백", se_uid)
        instances = []
        for img in s.get("images") or []:
            sop = str(img.get("sop_instance_uid") or "")
            if not sop:
                continue
            m = meta_by_sop.get(sop, {})
            spacing = _tag(m, "00280030") or []
            position = _tag(m, "00200032") or []
            orientation = _tag(m, "00200037") or []
            instances.append({
                "orthanc_id": "",
                "sop_uid": sop,
                "instance_number": int(_tag1(m, "00200013", img.get("image_sequence") or 0) or 0),
                "preview_url": f"/api/webpacs/live/thumb/{st_uid}/{se_uid}/{sop}",
                "rows": int(_tag1(m, "00280010", 0) or 0),
                "cols": int(_tag1(m, "00280011", 0) or 0),
                "pixel_spacing": [float(x) for x in spacing][:2],
                "position": [float(x) for x in position][:3],
                "orientation": [float(x) for x in orientation][:6],
                "series_uid": se_uid,
                "study_uid": st_uid,
            })
        instances.sort(key=lambda i: (i["instance_number"], i["sop_uid"]))
        series_out.append({
            "series_uid": se_uid,
            "modality": str(_tag1(meta_by_sop.get(instances[0]["sop_uid"], {}), "00080060", "") or "") if instances else "",
            "series_desc": str(s.get("series_description") or ""),
            "series_number": int(s.get("series_sequence") or 0),
            "instances": instances,
        })
    series_out.sort(key=lambda s: s["series_number"])
    tree = {"study_uid": study_uid, "series": series_out}
    with _TREE_LOCK:
        _TREE_CACHE[vid] = (time.time(), tree)
        while len(_TREE_CACHE) > 64:
            _TREE_CACHE.popitem(last=False)
    return tree


def find_uids(db: Session, vid: int, sop_uid: str, user: dict | None = None) -> tuple[str, str, str] | None:
    """sop → (study_uid, series_uid, sop_uid) — series-tree 캐시 기반."""
    tree = live_series_tree(db, vid, user)
    for s in tree["series"]:
        for inst in s["instances"]:
            if inst["sop_uid"] == sop_uid:
                return tree["study_uid"], s["series_uid"], sop_uid
    return None


# ── 픽셀 — 원본 bytes 디스크 캐시 + 서버측 디코드/윈도잉 렌더 ──────────────
def _cache_path(sop_uid: str) -> Path:
    safe = "".join(ch if ch.isalnum() or ch == "." else "_" for ch in sop_uid)
    return CACHE_DIR / f"{safe}.dcm"


def get_instance_bytes(client: WebPacsClient, study_uid: str, series_uid: str,
                       sop_uid: str, *, force: bool = False) -> bytes:
    p = _cache_path(sop_uid)
    if p.exists() and not force:
        try:
            return p.read_bytes()
        except OSError:
            pass
    data = client.instance_dicom(study_uid, series_uid, sop_uid)
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        # 원자적 쓰기 — 중단/디스크풀로 잘린 파일이 남아 영구 렌더 실패로 고착되는 것 방지
        tmp = p.with_suffix(".part")
        tmp.write_bytes(data)
        os.replace(tmp, p)
        _prune_cache()
    except OSError:  # 캐시 실패는 서빙을 막지 않는다
        pass
    return data


def invalidate_instance(sop_uid: str) -> None:
    """손상 캐시 무효화 — 렌더 실패 시 삭제 후 재다운로드 유도."""
    try:
        _cache_path(sop_uid).unlink(missing_ok=True)
    except OSError:
        pass


def _prune_cache() -> None:
    try:
        files = sorted(CACHE_DIR.glob("*.dcm"), key=lambda f: f.stat().st_mtime)
        for f in files[:-CACHE_MAX_FILES] if len(files) > CACHE_MAX_FILES else []:
            f.unlink(missing_ok=True)
    except OSError:
        pass


def render_instance(data: bytes, wc: float | None, ww: float | None,
                    fmt: str = "png", quality: int = 90) -> tuple[bytes, str]:
    """DICOM bytes → 윈도잉 8bit PNG/JPEG. localpacs.render_png 와 동일 규칙.

    W/L: 쿼리 > 태그 > min-max. MONOCHROME1 반전·RGB·멀티프레임 첫 프레임.
    반환: (bytes, media_type).
    """
    import numpy as np
    import pydicom
    from PIL import Image
    from pydicom.uid import ImplicitVRLittleEndian

    from app.services.localpacs_service import _tag_window

    ds = pydicom.dcmread(io.BytesIO(data), force=True)
    if not getattr(ds, "file_meta", None) or "TransferSyntaxUID" not in ds.file_meta:
        ds.file_meta = getattr(ds, "file_meta", None) or pydicom.dataset.FileMetaDataset()
        ds.file_meta.TransferSyntaxUID = ImplicitVRLittleEndian
    arr = ds.pixel_array

    photometric = str(getattr(ds, "PhotometricInterpretation", "") or "").upper()
    samples = int(getattr(ds, "SamplesPerPixel", 1) or 1)
    is_rgb = samples == 3 or (arr.ndim == 3 and arr.shape[-1] == 3 and "MONOCHROME" not in photometric)
    if is_rgb:
        if arr.ndim == 4:
            arr = arr[0]
    elif arr.ndim == 3:
        arr = arr[0]

    if is_rgb:
        rgb = arr.astype(np.float32)
        if rgb.max() > 255:
            rgb = rgb / rgb.max() * 255.0
        img = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), mode="RGB")
    else:
        d = arr.astype(np.float32)
        slope = float(getattr(ds, "RescaleSlope", 1) or 1)
        intercept = float(getattr(ds, "RescaleIntercept", 0) or 0)
        d = d * slope + intercept
        if wc is None or ww is None:
            tag_wc, tag_ww = _tag_window(ds)
            wc = wc if wc is not None else tag_wc
            ww = ww if ww is not None else tag_ww
        if wc is None or ww is None or ww <= 0:
            lo, hi = float(d.min()), float(d.max())
            if hi <= lo:
                hi = lo + 1.0
        else:
            lo, hi = wc - ww / 2.0, wc + ww / 2.0
        norm = np.clip((d - lo) / (hi - lo), 0.0, 1.0)
        if photometric == "MONOCHROME1":
            norm = 1.0 - norm
        img = Image.fromarray((norm * 255.0).astype(np.uint8), mode="L")

    buf = io.BytesIO()
    if fmt == "jpeg":
        img.convert("L" if img.mode == "L" else "RGB").save(
            buf, format="JPEG", quality=max(1, min(int(quality or 90), 100)))
        return buf.getvalue(), "image/jpeg"
    img.save(buf, format="PNG")
    return buf.getvalue(), "image/png"


# ── 판독 (A pacs_study_report ↔ 우리 Report 계약) ─────────────────────────
def _sr_from_remote(reading: str, conclusion: str, remote: dict | None = None) -> dict:
    findings = []
    body, recommendation = _split_recommendation(reading)
    if body.strip():
        findings.append({
            "organ": "", "observation": body.strip(),
            "severity": "critical" if "[CRITICAL]" in body.upper() else "normal",
            "measurements": [],
        })
    return {
        "exam": {}, "clinical_info": str((remote or {}).get("report_study_comment") or ""),
        "comparison": {},
        "findings": findings,
        "impression": [{"rank": 1, "statement": conclusion or "", "confidence": "high", "codes": []}],
        "recommendation": [{"text": recommendation}] if recommendation else [],
        "critical": [],
        # A 왕복 코멘트(요구6) — 판독 도크·창이 표시·편집
        "refer_comment": str((remote or {}).get("report_refer_comment") or ""),
    }


_RECO_MARK = "[권고] "


def _split_recommendation(reading: str) -> tuple[str, str]:
    """reading 평문에서 [권고] 섹션 분리(무손실 왕복)."""
    if _RECO_MARK in reading:
        head, _, tail = reading.partition(_RECO_MARK)
        return head.rstrip("\n"), tail.strip()
    return reading, ""


def _reading_from_sr(sr: dict) -> tuple[str, str]:
    """SR → (reading 평문, conclusion). recommendation·critical·비교를 텍스트 섹션으로
    직렬화해 A 평문 왕복에서 소실되지 않게 한다(요구6 SR 구조 보존)."""
    lines = []
    comp = (sr.get("comparison") or {}) if isinstance(sr.get("comparison"), dict) else {}
    if comp.get("summary"):
        lines.append(f"[비교] {comp['summary']}")
    for f in sr.get("findings") or []:
        organ = str(f.get("organ") or "")
        obs = str(f.get("observation") or "")
        sev = " [CRITICAL]" if f.get("severity") == "critical" and "[CRITICAL]" not in obs.upper() else ""
        lines.append(f"{organ + ': ' if organ and organ != '판독' else ''}{obs}{sev}")
    recos = [str(r.get("text") or r) for r in (sr.get("recommendation") or []) if r]
    reading = "\n".join(lines)
    reco_txt = "\n".join(x for x in recos if x)
    if reco_txt:
        reading = f"{reading}\n{_RECO_MARK}{reco_txt}" if reading else f"{_RECO_MARK}{reco_txt}"
    conclusion = "\n".join(str(i.get("statement") or "") for i in (sr.get("impression") or []))
    return reading, conclusion


def _comments_from_sr(sr: dict) -> dict:
    """SR 에서 A 코멘트 필드 추출 — 있으면 그 값, 없으면 None(A 미변경)."""
    out: dict[str, Any] = {}
    ci = sr.get("clinical_info")
    if ci is not None:
        out["study_comment"] = str(ci)[:2000]
    rc = sr.get("refer_comment")
    if rc is not None:
        out["refer_comment"] = str(rc)[:2000]
    return out


def _has_critical(sr: dict) -> bool:
    if sr.get("critical"):
        return True
    for f in sr.get("findings") or []:
        obs = str(f.get("observation") or "")
        if f.get("severity") == "critical" or "[CRITICAL]" in obs.upper():
            return True
    return False


def _report_out(vid: int, remote: dict | None) -> dict:
    """A report_data → 우리 _report_out 동형. 없으면 편집 가능한 빈 초안(dock 계약)."""
    if not remote:
        return {
            "id": vid, "study_id": vid, "version": 1, "status": "draft",
            "sr_json": _sr_from_remote("", ""), "narrative_text": "",
            "created_by": "", "reviewed_by": None, "finalized_at": None,
            "ai_model": None, "ai_sources": [], "diff_metrics": {"live": True},
        }
    status = str(remote.get("report_status") or "R").upper()
    finalized = status in ("A", "RA")
    return {
        "id": vid,
        "study_id": vid,
        "version": 1,
        "status": "finalized" if finalized else "in_review",
        "sr_json": _sr_from_remote(str(remote.get("report_reading") or ""),
                                   str(remote.get("report_conclusion") or ""), remote),
        "narrative_text": str(remote.get("report_reading") or ""),
        "created_by": str(remote.get("report_create_name") or remote.get("report_create_id") or ""),
        "reviewed_by": str(remote.get("report_approve_name") or "") or None,
        "finalized_at": str(remote.get("report_approve_datetime") or "") or None,
        "ai_model": None,
        "ai_sources": [],
        "diff_metrics": {"live": True, "remote_report_idx": remote.get("report_idx"),
                         "remote_status": status,
                         "updated_at": str(remote.get("report_update_datetime") or "")},
    }


def live_reports(db: Session, vid: int, user: dict | None = None) -> dict:
    client = live_client(db, user)
    remote = client.report_get(to_remote_idx(vid))
    return {"items": [_report_out(vid, remote)]}


def live_save_report(db: Session, vid: int, sr_json: dict, *, approve: bool = False,
                     cvr: bool = False, user: dict | None = None) -> dict:
    """판독 저장(R/RR)/승인(A/RA) — A 로 되돌려 쓰기.

    귀속(요구4·6): per-user 세션이면 그 사용자의 A 계정으로 저장 →
    A pacs_study_report 의 report_create_name/report_approve_name 이 **실제 판독의**로 기록.

    완결(요구6): 재판독(RE→RR, RE/RR 승인→RA) 매핑, CVR 조건부 전송(critical value report
    알림톡), study/refer 코멘트 왕복. 안전 규칙(적대검증, fail-closed) 유지.
    """
    from app.services.webpacs_bridge import WebPacsConflict

    client = live_client(db, user)
    idx = to_remote_idx(vid)
    reading, conclusion = _reading_from_sr(sr_json or {})
    if approve and not (reading.strip() or conclusion.strip()):
        raise WebPacsConflict("빈 판독은 승인할 수 없습니다 (판독문 또는 결론을 입력하세요)")

    detail = client.study_detail(idx)
    cur = str(detail.get("study_status") or "").upper()
    assignee_idx = detail.get("user_idx")
    remote = client.report_get(idx)

    # 이미 승인된 검사 — 저장/재승인 금지(강등·중복 승인 방지). 재판독은 원격에서 RE 로 열어야 함.
    if cur in ("A", "RA"):
        raise WebPacsConflict("이미 승인된 판독입니다 — 재판독은 원격에서 재판독 대기(RE)로 여세요")

    # 다른 판독의가 작성중(RI) — 상태로 직접 판정(fail-closed). per-user 면 내 A user_idx 와 비교.
    my_idx = a_user_idx_of(user) if has_user_a_session(user) else _bridge_user_idx(db)
    if cur == "RI" and assignee_idx is not None and my_idx is not None and assignee_idx != my_idx:
        raise WebPacsConflict("다른 판독의가 작성 중입니다 — 목록을 새로고침하세요")

    # 재판독 구분(요구6): RE(재판독 대기)·RR(재판독 작성) 계열이면 R/A 대신 RR/RA 로 기록.
    rework = cur in ("RE", "RR")
    save_status = ("RA" if rework else "A") if approve else ("RR" if rework else "R")

    # 선점(RI) — 미완료 상태에서만. 이미 R/RR/REF(작성완료·미승인) 는 수정 저장이라 선점 생략.
    claimed = False
    if cur not in ("R", "RR", "REF"):
        try:
            client.change_status(idx, "report")
            claimed = True
        except WebPacsConflict:
            raise   # 타 판독의 작성중/완료 — 저장 차단(A 가 최종 판정)

    comments = _comments_from_sr(sr_json or {})
    payload: dict[str, Any] = {
        "study_idx": idx,
        "report_status": save_status,
        "report_reading": reading,
        "report_conclusion": conclusion,
        # CVR(critical value report) — critical 소견이거나 사용자가 CVR 지정 시 알림톡 발송(UA_1296)
        "report_cvr_send": "Y" if (cvr or _has_critical(sr_json or {})) else "N",
    }
    if comments.get("study_comment") is not None:
        payload["report_study_comment"] = comments["study_comment"]
    if comments.get("refer_comment") is not None:
        payload["report_refer_comment"] = comments["refer_comment"]
    # 실제 판독의 귀속 — per-user 면 A user_idx 를 명시(A 는 None/0 이면 토큰 사용자로 세팅하므로
    # per-user 토큰만으로도 올바르나, 명시해 이중 안전).
    if my_idx is not None:
        payload["report_create_idx"] = my_idx
        if approve:
            payload["report_approve_idx"] = my_idx
    if remote and remote.get("report_idx"):
        payload["report_idx"] = remote["report_idx"]
    try:
        client.report_save(payload)
    except Exception:
        if claimed:   # 선점만 하고 저장 실패 — A 검사가 RI 로 고착되지 않게 해제
            try:
                client.change_status(idx, "end")
            except Exception:  # noqa: BLE001 — 해제 실패는 원 예외를 가리지 않는다
                pass
        raise
    return _report_out(vid, client.report_get(idx))


def _bridge_user_idx(db: Session) -> int | None:
    """서비스 계정(공유 브리지)의 원격 user_idx — 로그인 응답 user_data 에서 1회 확보(캐시).
    (per-user 세션이 없을 때의 폴백 귀속·presence 판정용)."""
    client = service_client(db)
    cached = getattr(client, "_sv_user_idx", "unset")
    if cached != "unset":
        return cached
    try:
        body = client.login()
        uid = (body.get("user_data") or {}).get("user_idx")
        uid = int(uid) if uid is not None else None
    except Exception:  # noqa: BLE001
        uid = None
    client._sv_user_idx = uid   # type: ignore[attr-defined]
    return uid


# ── 상태/presence (실시간 변경 감지 폴링용) ───────────────────────────────
def live_state(db: Session, vid: int, me: str = "", user: dict | None = None) -> dict:
    client = live_client(db, user)
    idx = to_remote_idx(vid)
    r = client.study_detail(idx)
    ss = str(r.get("study_status") or "").upper()
    status, read_state, locked = _map_status(ss)
    report = client.report_get(idx)
    # "다른 사람이 작성 중" 서버 판정(프론트 이름 매칭 불필요):
    #  A 판독의가 RI 선점 + 나(내 A user_idx)가 아님, 또는 다른 B 사용자가 판독창 입력 중.
    my_idx = a_user_idx_of(user) if has_user_a_session(user) else _bridge_user_idx(db)
    a_other = (ss == "RI" and r.get("user_idx") is not None
               and my_idx is not None and r.get("user_idx") != my_idx)
    b_typers = _report_typers_of(vid, exclude=me)
    other_writing = bool(a_other or b_typers)
    return {
        "study_status": str(r.get("study_status") or ""),
        "status": status,
        "read_state": read_state,
        "report_locked": locked,
        "assignee": str(r.get("doctor_user_name") or ""),
        "report_status": str((report or {}).get("report_status") or ""),
        "report_updated": str((report or {}).get("report_update_datetime") or ""),
        "report_writer": str((report or {}).get("report_create_name") or ""),
        "viewers": _viewers_of(vid),
        "other_writing": other_writing,          # ← 프론트 배너는 이 불리언만 사용
        "other_writers": b_typers or ([str(r.get("doctor_user_name") or "")] if a_other else []),
    }


# ── 주석/표시상태 — A pacs_image_annotation 에 우리 포맷으로 공존 저장 ─────
SV_ANNO_TOOL = "sv_annotation"       # (StudyUID, tool_name) 1행 — A 뷰어 주석과 별도 슬롯
SV_PSTATE_TOOL = "sv_presentation"


def _study_uid_of(db: Session, vid: int, user: dict | None = None) -> str:
    tree = live_series_tree(db, vid, user)
    if tree["study_uid"]:
        return tree["study_uid"]
    detail = live_client(db, user).study_detail(to_remote_idx(vid))
    return str(detail.get("study_instance_uid") or "")


def live_annotations_get(db: Session, vid: int, user: dict | None = None) -> dict:
    uid = _study_uid_of(db, vid, user)
    rows = live_client(db, user).annotation_get(uid)
    for row in rows:
        if row.get("annotation_tool_name") == SV_ANNO_TOOL:
            try:
                return {"items": json.loads(row.get("annotation_tool_value") or "[]")}
            except (TypeError, ValueError):
                return {"items": []}
    return {"items": []}


def live_annotations_put(db: Session, vid: int, items: list[dict], user: dict | None = None) -> dict:
    uid = _study_uid_of(db, vid, user)
    live_client(db, user).annotation_change(uid, SV_ANNO_TOOL, json.dumps(items, ensure_ascii=False))
    return {"ok": True, "count": len(items)}


def live_presentation_get(db: Session, vid: int, user: dict | None = None) -> dict:
    uid = _study_uid_of(db, vid, user)
    rows = live_client(db, user).annotation_get(uid)
    for row in rows:
        if row.get("annotation_tool_name") == SV_PSTATE_TOOL:
            try:
                return {"series": json.loads(row.get("annotation_tool_value") or "{}")}
            except (TypeError, ValueError):
                return {"series": {}}
    return {"series": {}}


def live_presentation_put(db: Session, vid: int, series: dict, user: dict | None = None) -> dict:
    uid = _study_uid_of(db, vid, user)
    live_client(db, user).annotation_change(uid, SV_PSTATE_TOOL, json.dumps(series, ensure_ascii=False))
    return {"ok": True, "series": len(series)}


# ── A 대응 기능(요구5) — 메모·응급·북마크·PDF ────────────────────────────
def live_set_memo(db: Session, vid: int, memo: str, user: dict | None = None) -> dict:
    """메모(Hospital Comment) → A study_comment 업데이트."""
    live_client(db, user).study_update(to_remote_idx(vid), {"study_comment": memo[:2000]})
    return {"ok": True}


def live_set_priority(db: Session, vid: int, emergency: bool, user: dict | None = None) -> dict:
    """응급 우선순위 토글 → A study_emergency(ER/NR)."""
    live_client(db, user).study_status_change(
        to_remote_idx(vid), {"study_emergency": "ER" if emergency else "NR"})
    return {"ok": True, "emergency": emergency}


def live_set_bookmark(db: Session, vid: int, bookmark: bool, user: dict | None = None) -> dict:
    """북마크 토글 → A BookMark."""
    live_client(db, user).bookmark_toggle(to_remote_idx(vid), bookmark)
    return {"ok": True, "bookmark": bookmark}


class _Attr:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class _Fmt:
    """이미 포맷된 문자열을 strftime 계약에 맞춰 반환(렌더러의 finalized_at.strftime 대응)."""
    def __init__(self, s: str):
        self._s = s

    def strftime(self, _fmt: str) -> str:
        return self._s


def live_report_pdf(db: Session, vid: int, user: dict | None = None) -> tuple[bytes, str]:
    """판독서 PDF — A 판독 데이터를 우리 PDF 렌더러로 생성(A 자체 PDF 없음, 데이터는 있음).
    render_report_pdf 가 ORM(Report/Study/Patient)을 읽으므로 덕타이핑 shim + 위임 db 로 재사용."""
    from app.services.pdf_service import render_report_pdf

    detail = live_detail(db, vid, user)
    report = live_reports(db, vid, user)["items"][0]
    patient = _Attr(patient_key=detail.get("patient_key", ""), name_masked=detail.get("patient_name", ""),
                    sex=detail.get("sex", ""), birth_date=detail.get("birth_date", ""))
    study = _Attr(patient_id=1, accession_no=detail.get("accession_no", ""),
                  study_uid=detail.get("study_uid", ""), study_desc=detail.get("study_desc", ""),
                  study_date=detail.get("study_date", ""), study_time=detail.get("study_time", ""),
                  modality=detail.get("modality", ""), body_part=detail.get("body_part", ""),
                  key_images=[])
    fin = report.get("finalized_at")
    rep = _Attr(study=study, sr_json=report.get("sr_json") or {}, version=report.get("version", 1),
                status=report.get("status", ""), diff_metrics=report.get("diff_metrics") or {},
                created_by=report.get("created_by") or "",
                reviewed_by=report.get("reviewed_by") or report.get("created_by") or "",
                finalized_at=_Fmt(str(fin)) if fin else None)

    class _LiveDb:   # get_setting 는 실 db 위임, Patient 조회는 shim 반환
        def get(self, _model, _pk):
            return patient

        def execute(self, *a, **k):
            return db.execute(*a, **k)

    pdf = render_report_pdf(_LiveDb(), rep)   # type: ignore[arg-type]
    fname = f"report_{detail.get('patient_key', '')}_{detail.get('study_date', '')}.pdf"
    return pdf, fname
