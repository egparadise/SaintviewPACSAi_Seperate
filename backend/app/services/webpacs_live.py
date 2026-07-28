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

import contextlib
import io
import json
import os
import logging
import threading
import time
from collections import OrderedDict
from pathlib import Path
from collections.abc import Callable
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


# 과거검사(동일 환자) 캐시 — A 의 환자별 검사 검색이 느린 사이트가 있어(실측 4.1초)
# 뷰어 오픈 경로에서 떼어냈다. 같은 환자를 다시 열 때는 이 캐시로 즉답한다.
_REL_CACHE: OrderedDict[str, tuple[float, list]] = OrderedDict()
_REL_TTL = 60.0
_REL_MAX = 256
_REL_LOCK = threading.Lock()


def live_related(db: Session, vid: int, user: dict | None = None,
                 row: dict | None = None) -> list[dict]:
    """동일 환자의 다른 A 검사 목록(과거검사).

    ⚠ **뷰어 오픈 경로에 두면 안 된다.** A 의 환자별 검사 검색은 사이트에 따라 수 초가 걸리는데
    (실측 4.11초), 예전에는 이것이 live_detail 안에 있어서 뷰어가 그만큼 검은 화면으로 대기했다.
    지금은 별도 엔드포인트이고, 프론트는 화면을 띄운 뒤 따로 불러 채운다.
    """
    client = live_client(db, user)
    idx = to_remote_idx(vid)
    # row 가 오면 상세를 다시 받지 않는다 — live_detail 에서 이미 받은 것을 재사용
    r = row if row is not None else client.study_detail(idx)
    if not r:
        return []
    pid = str(r.get("patient_id") or "")
    if not pid:
        return []
    ck = f"{getattr(client, 'base_url', '')}|{pid}"
    now = time.time()
    with _REL_LOCK:
        hit = _REL_CACHE.get(ck)
        if hit and now - hit[0] < _REL_TTL:
            return [x for x in hit[1] if x["id"] != vid]
    out: list[dict] = []
    try:
        others = client.list_studies({
            "patient_id": pid, "limit": "30",
            "order_json": json.dumps([{"key": "study_idx", "order": "desc"}]),
        })
        for o in others:
            od, _ = _split_datetime(str(o.get("study_datetime") or ""))
            st, _, _ = _map_status(str(o.get("study_status") or ""))
            out.append({
                "id": to_vid(int(o.get("study_idx"))),
                "study_uid": str(o.get("study_instance_uid") or ""),
                "study_date": od,
                "modality": str(o.get("study_modality") or ""),
                "study_desc": str(o.get("study_description") or ""),
                "status": st,
            })
    except Exception:  # noqa: BLE001 — 과거검사 실패는 화면을 막지 않는다
        return []
    with _REL_LOCK:
        _REL_CACHE[ck] = (now, out)
        _REL_CACHE.move_to_end(ck)
        while len(_REL_CACHE) > _REL_MAX:
            _REL_CACHE.popitem(last=False)
    return [x for x in out if x["id"] != vid]


def invalidate_tree(vid: int = 0) -> None:
    """시리즈 트리 캐시 무효화 — vid 를 주면 그 검사만, 비우면 전체.

    왜 필요한가: _TREE_CACHE 는 vid 키로 30초 TTL 이다. 그런데 A 에 시리즈가 추가되면
    (촬영이 이어지는 검사는 흔하다) SSE 로 '바뀌었다'는 신호는 받으면서도 트리는 최대
    30초 동안 옛 것을 내준다 — 뷰어에 새 시리즈가 안 보인다.
    related·instance 는 이미 무효화 통로가 있는데 트리만 없어서 만들었다.
    테스트 격리에도 쓴다(앞선 테스트가 덥혀 놓은 트리가 다음 테스트로 새는 것을 막는다).
    """
    with _TREE_LOCK:
        if not vid:
            _TREE_CACHE.clear()
            return
        _TREE_CACHE.pop(vid, None)


def invalidate_related(patient_key: str = "") -> None:
    """과거검사 캐시 무효화 — 새 검사가 들어와 목록이 바뀌었을 때/테스트 격리용.
    patient_key 를 주면 그 환자만, 비우면 전체."""
    with _REL_LOCK:
        if not patient_key:
            _REL_CACHE.clear()
            return
        for k in [k for k in _REL_CACHE if k.endswith(f"|{patient_key}")]:
            _REL_CACHE.pop(k, None)


def live_detail(db: Session, vid: int, user: dict | None = None,
                with_related: bool = True) -> dict:
    """StudyDetail 동형.

    with_related=False 면 과거검사 조회를 건너뛴다 — 뷰어 오픈 경로 전용(§live_related 주석).
    """
    client = live_client(db, user)
    idx = to_remote_idx(vid)
    r = client.study_detail(idx)
    if not r:
        raise WebPacsError("원격 검사를 찾을 수 없습니다")
    row = _row_of(r)
    row["clinical_info"] = str(r.get("study_comment") or r.get("report_study_comment") or "")
    row["orthanc_id"] = ""
    row["series"] = []
    row["related_exams"] = live_related(db, vid, user, row=r) if with_related else []
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


# 동일 SOP 동시 요청 직렬화 — 프리페치(8스레드)와 화면 요청이 같은 인스턴스를 동시에 집으면
# ① A 로 같은 수 MB 를 두 번 받고 ② 같은 .part 에 동시 기록해 캐시가 깨졌다(손상 재시도 경로가
# 그 증거). SOP 단위 락으로 한 번만 받고 나머지는 그 결과를 기다린다.
_INFLIGHT_LOCK = threading.Lock()
# key → [Lock, 참조 수]. 예전엔 "잠기지 않은 항목"을 회수했는데, 락 객체를 이미 받아 들고
# acquire 직전인 스레드의 항목도 그 조건을 만족한다 — 회수되면 뒤이은 요청이 **새 락**을 만들어
# 같은 SOP 를 동시에 내려받는다(상호배제 붕괴). 참조 수가 0 일 때만 지운다.
_INFLIGHT: dict[str, list] = {}
_DEC_INFLIGHT: dict[str, list] = {}


@contextlib.contextmanager
def _named_lock(registry: dict[str, list], key: str):
    with _INFLIGHT_LOCK:
        ent = registry.get(key)
        if ent is None:
            ent = registry[key] = [threading.Lock(), 0]
        ent[1] += 1
    try:
        with ent[0]:
            yield
    finally:
        with _INFLIGHT_LOCK:
            ent[1] -= 1
            if ent[1] <= 0 and registry.get(key) is ent:
                del registry[key]


def _sop_lock(sop_uid: str):
    return _named_lock(_INFLIGHT, sop_uid)


def get_instance_bytes(client: WebPacsClient, study_uid: str, series_uid: str,
                       sop_uid: str, *, force: bool = False) -> bytes:
    p = _cache_path(sop_uid)
    if p.exists() and not force:
        try:
            return p.read_bytes()
        except OSError:
            pass
    with _sop_lock(sop_uid):
        if p.exists() and not force:      # 락 대기 중 다른 스레드가 받아 놨으면 그걸 쓴다
            try:
                return p.read_bytes()
            except OSError:
                pass
        data = client.instance_dicom(study_uid, series_uid, sop_uid)
        try:
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            # 원자적 쓰기 — 중단/디스크풀로 잘린 파일이 남아 영구 렌더 실패로 고착되는 것 방지.
            # 임시 파일명에 스레드 id 를 넣어 강제 재다운로드(force)끼리도 겹치지 않게 한다.
            tmp = p.with_suffix(f".{threading.get_ident():x}.part")
            tmp.write_bytes(data)
            os.replace(tmp, p)
            _prune_cache()
        except OSError:  # 캐시 실패는 서빙을 막지 않는다
            pass
    return data


def instance_is_cached(sop_uid: str) -> bool:
    return _cache_path(sop_uid).exists()


def preview_bytes(db: Session, study_uid: str, series_uid: str, sop_uid: str) -> bytes | None:
    """저해상 미리보기 JPEG — A 가 배치로 미리 만들어 둔 512×512 q80 을 그대로 받는다.

    A 는 인스턴스마다 thumb/{sop}.jpg(128px)와 rendered/{sop}_512x512_q80.jpg 를 백그라운드로
    생성해 MinIO 에 (평문으로) 넣어 둔다. 즉 **원본 DICOM 을 건드리지 않고** 곧바로 보여줄 수
    있는 그림이 이미 있다. 512 실패 시 128 썸네일이라도 준다(빈 화면보다 낫다).
    """
    client = service_client(db)
    try:
        data = client.rendered_preview(study_uid, series_uid, sop_uid)
        if data:
            return data
    except WebPacsError:
        pass
    try:
        return client.thumbnail(study_uid, series_uid, sop_uid)
    except WebPacsError:
        return None


def invalidate_instance(sop_uid: str) -> None:
    """손상 캐시 무효화 — 렌더 실패 시 삭제 후 재다운로드 유도."""
    try:
        _cache_path(sop_uid).unlink(missing_ok=True)
    except OSError:
        pass
    with _DECODE_LOCK:
        _DECODE_CACHE.pop(sop_uid, None)


# 프루닝 상각 — 예전엔 인스턴스를 받을 때마다 캐시 폴더 전체를 stat+정렬했다.
# 4000개 상한에서 **호출당 약 140ms**, 그것도 프리페치 8스레드가 동시에 → 200장 CT 하나에
# 순수 디렉터리 스캔만 수십 초. 그 시간 동안 같은 단일 워커가 화면 프레임을 못 낸다.
# 이제 상한을 넘길 가능성이 있을 때만(쓰기 N회마다) 스캔한다.
_PRUNE_EVERY = 256
_prune_counter = 0
_PRUNE_LOCK = threading.Lock()


def _prune_cache(force: bool = False) -> None:
    global _prune_counter
    with _PRUNE_LOCK:
        _prune_counter += 1
        if not force and _prune_counter % _PRUNE_EVERY != 0:
            return
    try:
        files = sorted(CACHE_DIR.glob("*.dcm"), key=lambda f: f.stat().st_mtime)
        for f in files[:-CACHE_MAX_FILES] if len(files) > CACHE_MAX_FILES else []:
            f.unlink(missing_ok=True)
        # os.replace 실패·프로세스 중단으로 남은 임시 파일 회수 — glob("*.dcm") 이 못 잡아
        # 무한정 쌓이던 것들. 1시간 넘게 방치된 것만(진행 중인 쓰기는 건드리지 않는다).
        cutoff = time.time() - 3600
        for f in CACHE_DIR.glob("*.part"):
            try:
                if f.stat().st_mtime < cutoff:
                    f.unlink(missing_ok=True)
            except OSError:
                pass
    except OSError:
        pass


# 디코드 결과 메모리 캐시 — DICOM 픽셀 디코드(JPEG2000 등)는 비싸므로 sop 단위로 1회만 디코드하고
# 그 뒤 스크롤 재방문·W/L 드래그는 윈도잉(싼 연산)만 수행 → 재요청 즉시 응답.
# 그레이: rescale 적용 float32 배열(윈도잉 대기), RGB: uint8. 메모리 상한 LRU.
_DECODE_CACHE: "OrderedDict[str, dict]" = OrderedDict()
_DECODE_LOCK = threading.Lock()
_DECODE_MAX = 300   # 512²×4B ≈ 1MB/장 → 최대 ~300MB(대형 매트릭스는 개수만큼 더)


def _decode_pixels(data: bytes) -> dict:
    """DICOM bytes → 디코드 산출물(윈도잉 전). {rgb} 또는 {gray, tag_wc, tag_ww, mono1}."""
    import numpy as np
    import pydicom
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
        rgb = arr.astype(np.float32)
        if rgb.max() > 255:
            rgb = rgb / rgb.max() * 255.0
        return {"rgb": np.clip(rgb, 0, 255).astype(np.uint8)}
    if arr.ndim == 3:
        arr = arr[0]
    slope = float(getattr(ds, "RescaleSlope", 1) or 1)
    intercept = float(getattr(ds, "RescaleIntercept", 0) or 0)
    gray = arr.astype(np.float32) * slope + intercept
    tag_wc, tag_ww = _tag_window(ds)
    return {"gray": gray, "tag_wc": tag_wc, "tag_ww": tag_ww,
            "mono1": photometric == "MONOCHROME1"}


def decode_cached(sop_uid: str) -> bool:
    """이 SOP 의 디코드 결과가 메모리에 있나 — 있으면 원본 파일을 읽을 필요가 없다."""
    with _DECODE_LOCK:
        return sop_uid in _DECODE_CACHE


def _decoded(sop_uid: str | None, load: Callable[[], bytes]) -> dict:
    """sop 캐시된 디코드 산출물 반환(없으면 디코드 후 캐시). sop 미지정이면 캐시 없이 디코드.

    load 는 **필요할 때만** 원본 bytes 를 준다 — 캐시 적중 시 수 MB 디스크 읽기를 통째로 생략.
    같은 SOP 를 동시에 요청하면 한 스레드만 디코드하고 나머지는 결과를 기다린다(중복 디코드 제거).
    """
    if not sop_uid:
        return _decode_pixels(load())
    with _DECODE_LOCK:
        hit = _DECODE_CACHE.get(sop_uid)
        if hit is not None:
            _DECODE_CACHE.move_to_end(sop_uid)
            return hit
    with _named_lock(_DEC_INFLIGHT, sop_uid):
        with _DECODE_LOCK:                       # 대기 중 다른 스레드가 채웠으면 그걸 쓴다
            hit = _DECODE_CACHE.get(sop_uid)
            if hit is not None:
                _DECODE_CACHE.move_to_end(sop_uid)
                return hit
        dec = _decode_pixels(load())
        with _DECODE_LOCK:
            _DECODE_CACHE[sop_uid] = dec
            _DECODE_CACHE.move_to_end(sop_uid)
            while len(_DECODE_CACHE) > _DECODE_MAX:
                _DECODE_CACHE.popitem(last=False)
    return dec


def render_instance(data: bytes | Callable[[], bytes], wc: float | None, ww: float | None,
                    fmt: str = "png", quality: int = 90,
                    sop_uid: str | None = None) -> tuple[bytes, str]:
    """디코드(캐시) + 윈도잉 8bit PNG/JPEG. W/L: 쿼리 > 태그 > min-max.

    data 는 bytes 또는 **지연 로더**(callable). sop_uid 주면 디코드 결과를 메모리 캐시 →
    재스크롤·W/L 드래그는 윈도잉만(디코드·디스크 읽기 생략).
    """
    import numpy as np
    from PIL import Image

    dec = _decoded(sop_uid, data if callable(data) else (lambda: data))
    if "rgb" in dec:
        img = Image.fromarray(dec["rgb"], mode="RGB")
    else:
        d = dec["gray"]
        if wc is None or ww is None:
            wc = wc if wc is not None else dec["tag_wc"]
            ww = ww if ww is not None else dec["tag_ww"]
        if wc is None or ww is None or ww <= 0:
            lo, hi = float(d.min()), float(d.max())
            if hi <= lo:
                hi = lo + 1.0
        else:
            lo, hi = wc - ww / 2.0, wc + ww / 2.0
        norm = np.clip((d - lo) / (hi - lo), 0.0, 1.0)
        if dec["mono1"]:
            norm = 1.0 - norm
        img = Image.fromarray((norm * 255.0).astype(np.uint8), mode="L")

    buf = io.BytesIO()
    if fmt == "jpeg":
        img.convert("L" if img.mode == "L" else "RGB").save(
            buf, format="JPEG", quality=max(1, min(int(quality or 90), 100)))
        return buf.getvalue(), "image/jpeg"
    img.save(buf, format="PNG", compress_level=1)   # 낮은 압축=빠른 인코딩(전송은 로컬망)
    return buf.getvalue(), "image/png"


# 인코딩 산출물 캐시 — (SOP·윈도우·형식·품질)은 불변이라 재인코딩이 순수 낭비였다.
# PNG 인코딩은 512²에서 ~20ms, 2048²에서 ~95ms — 시네·다중 페인·창 여러 개면 이것만으로
# 단일 워커의 코어가 포화된다. 브라우저 캐시(ETag/max-age)가 1차, 이건 창·사용자 간 공유용.
_ENC_CACHE: "OrderedDict[str, tuple[bytes, str]]" = OrderedDict()
_ENC_LOCK = threading.Lock()
_ENC_MAX_BYTES = 192 * 1024 * 1024
_enc_bytes = 0


def encoded_get(key: str) -> tuple[bytes, str] | None:
    with _ENC_LOCK:
        hit = _ENC_CACHE.get(key)
        if hit is not None:
            _ENC_CACHE.move_to_end(key)
        return hit


def encoded_put(key: str, value: tuple[bytes, str]) -> None:
    global _enc_bytes
    n = len(value[0])
    if n > _ENC_MAX_BYTES // 4:      # 단일 프레임이 캐시를 독식하지 않게
        return
    with _ENC_LOCK:
        if key in _ENC_CACHE:
            _enc_bytes -= len(_ENC_CACHE[key][0])
        _ENC_CACHE[key] = value
        _ENC_CACHE.move_to_end(key)
        _enc_bytes += n
        while _enc_bytes > _ENC_MAX_BYTES and _ENC_CACHE:
            _, v = _ENC_CACHE.popitem(last=False)
            _enc_bytes -= len(v[0])


# ── 시리즈 병렬 프리페치 — 검사 오픈 시 A→B 원본 다운로드를 백그라운드 선행(지연 은닉) ──
_prefetch_lock = threading.Lock()
_prefetching: set[int] = set()


def prefetch_series(db: Session, vid: int, user: dict | None = None) -> int:
    """활성 검사의 전 인스턴스 원본 bytes 를 병렬로 디스크 캐시에 예열(A→B 지연 은닉).
    반환: 예열 시도 인스턴스 수. 이미 진행 중이면 0."""
    from concurrent.futures import ThreadPoolExecutor

    with _prefetch_lock:
        if vid in _prefetching:
            return 0
        _prefetching.add(vid)
    try:
        client = service_client(db)   # 이미지 취득은 서비스 계정
        tree = live_series_tree(db, vid, user)
        # 순서가 중요하다: 뷰어는 각 시리즈의 **가운데** 슬라이스부터 연다(index=len/2).
        # 예전엔 0번부터 순서대로 받아서, 200장 CT 라면 화면에 필요한 장이 101번째 순번이었다
        # → 프리페치가 도는 내내 화면은 온디맨드 다운로드를 기다렸다. 이제 가운데에서 바깥으로.
        # SR/KO/PR 등 비영상 시리즈는 뷰어가 거르므로 받지 않는다.
        SKIP = {"SR", "KO", "PR", "DOC", "REG", "SEG", "RTSTRUCT"}
        targets: list[tuple[str, str, str]] = []
        for s in tree["series"]:
            if str(s.get("modality") or "").upper() in SKIP:
                continue
            insts = [i for i in s["instances"] if not _cache_path(i["sop_uid"]).exists()]
            if not insts:
                continue
            mid = len(insts) // 2
            order = sorted(range(len(insts)), key=lambda k: abs(k - mid))
            targets += [(tree["study_uid"], s["series_uid"], insts[k]["sop_uid"]) for k in order]
        if not targets:
            return 0

        def _one(t):
            try:
                get_instance_bytes(client, *t)
            except Exception:  # noqa: BLE001 — 개별 실패는 무시(온디맨드에서 재시도)
                pass

        with ThreadPoolExecutor(max_workers=8) as ex:
            list(ex.map(_one, targets))
        return len(targets)
    finally:
        with _prefetch_lock:
            _prefetching.discard(vid)


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
        # ⚠ 키는 **복수 recommendations**, 항목은 {action, timeframe} — 프론트 SrJson 계약이다
        #    (api.ts SrJson / 로컬 report_service 와 동일). 예전엔 단수 "recommendation" 에
        #    {text:...} 를 담아, 이 SR 을 파고드는 화면(T-View 워크리스트 판독 패널)이
        #    `draft.recommendations.length` 에서 TypeError 로 죽어 **앱 전체가 백지**가 됐다.
        "recommendations": ([{"action": recommendation, "timeframe": ""}]
                           if recommendation else []),
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
    # 신규 계약(recommendations/{action}) 우선, 구 형식(recommendation/{text})도 계속 수용
    _raw = sr.get("recommendations") or sr.get("recommendation") or []
    recos = [str((r.get("action") or r.get("text") or "") if isinstance(r, dict) else r)
             for r in _raw if r]
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
