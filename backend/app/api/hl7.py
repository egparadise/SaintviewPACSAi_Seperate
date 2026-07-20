"""HL7/MWL/원격판독/가상환자 API — 병원별 EMR·장비 연동 4종(레인 H).

- 병원별 설정: hl7.config · remote.reading · mwl.config · testgen.config (hospital 스코프)
- inbox/outbox 조회·재처리·전송, 전역 MLLP 리스너 기동/중지(기본 off)
- POST /api/hl7/remote-report — 병원별 API 키 인증(외부 원격판독사 입력 창구)
- MWL SCP 기동/중지(병원별 포트), 가상 환자 생성기
"""
from __future__ import annotations

import hmac
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import admin_user, current_user
from app.api.hospitals import _require_access
from app.db import get_db
from app.models import AuditLog, Hl7Inbox, Hl7Outbox, Hospital, Report, Study
from app.services import hl7 as hl7_svc
from app.services import mwl as mwl_svc
from app.services import testgen as testgen_svc
from app.services.settings_service import get_hospital_setting, set_hospital_setting

router = APIRouter(prefix="/api/hl7", tags=["hl7"])

# 이 라우터가 관리하는 병원 스코프 설정 키(화이트리스트)
HOSPITAL_CONFIG_KEYS = {"hl7.config", "remote.reading", "mwl.config", "testgen.config"}


def _require_admin_access(user: dict, hid: int) -> None:
    """쓰기 가드 — 시스템 관리자 전부, 병원 관리자(role=admin)는 자기 병원만."""
    _require_access(user, hid)
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="관리자 권한이 필요합니다")


def _get_hospital(db: Session, hid: int) -> Hospital:
    h = db.get(Hospital, hid)
    if not h:
        raise HTTPException(status_code=404, detail="병원을 찾을 수 없습니다")
    return h


# ════════════════════════════ 병원별 설정 (4키) ════════════════════════════

@router.get("/hospitals/{hid}/config/{key}")
def read_config(hid: int, key: str, db: Session = Depends(get_db),
                user: dict = Depends(current_user)):
    if key not in HOSPITAL_CONFIG_KEYS:
        raise HTTPException(status_code=404, detail="알 수 없는 설정 키")
    _require_access(user, hid)
    _get_hospital(db, hid)
    value = get_hospital_setting(db, hid, key, default={}) or {}
    if key == "testgen.config":
        value = testgen_svc.merged_config(value)  # 기본 규칙 병합해 노출
    return {"key": key, "hospital_id": hid, "value": value}


class ConfigBody(BaseModel):
    value: dict


@router.put("/hospitals/{hid}/config/{key}")
def write_config(hid: int, key: str, body: ConfigBody, db: Session = Depends(get_db),
                 user: dict = Depends(current_user)):
    if key not in HOSPITAL_CONFIG_KEYS:
        raise HTTPException(status_code=404, detail="알 수 없는 설정 키")
    _require_admin_access(user, hid)
    _get_hospital(db, hid)
    set_hospital_setting(db, hid, key, body.value)
    db.add(AuditLog(action="hl7_config_update", target_type="hospital", target_id=str(hid),
                    detail={"by": user["sub"], "key": key}))
    db.commit()
    return {"ok": True, "key": key, "hospital_id": hid}


# ════════════════════════════ inbox / outbox ════════════════════════════

def _msg_out(m: Hl7Inbox | Hl7Outbox) -> dict:
    return {
        "id": m.id, "hospital_id": m.hospital_id, "direction": m.direction,
        "msg_type": m.msg_type, "patient_id": m.patient_id, "accession": m.accession,
        "status": m.status, "error": m.error, "parsed_json": m.parsed_json,
        "retry_count": getattr(m, "retry_count", None),
        "created_at": m.created_at.isoformat() if m.created_at else None,
        "processed_at": m.processed_at.isoformat() if m.processed_at else None,
    }


@router.get("/hospitals/{hid}/inbox")
def list_inbox(hid: int, status: str = "", msg_type: str = "", limit: int = 50,
               db: Session = Depends(get_db), user: dict = Depends(current_user)):
    _require_access(user, hid)
    q = select(Hl7Inbox).where(Hl7Inbox.hospital_id == hid)
    if status:
        q = q.where(Hl7Inbox.status == status)
    if msg_type:
        q = q.where(Hl7Inbox.msg_type.like(f"{msg_type}%"))
    rows = db.execute(q.order_by(Hl7Inbox.id.desc()).limit(min(limit, 200))).scalars().all()
    return {"items": [_msg_out(m) for m in rows]}


@router.get("/hospitals/{hid}/outbox")
def list_outbox(hid: int, status: str = "", limit: int = 50,
                db: Session = Depends(get_db), user: dict = Depends(current_user)):
    _require_access(user, hid)
    q = select(Hl7Outbox).where(Hl7Outbox.hospital_id == hid)
    if status:
        q = q.where(Hl7Outbox.status == status)
    rows = db.execute(q.order_by(Hl7Outbox.id.desc()).limit(min(limit, 200))).scalars().all()
    return {"items": [_msg_out(m) for m in rows]}


@router.post("/hospitals/{hid}/inbox/{mid}/reprocess")
def reprocess_inbox(hid: int, mid: int, db: Session = Depends(get_db),
                    user: dict = Depends(current_user)):
    """오류 수신건 재처리 — 원문을 다시 파싱해 새 inbox 행으로 처리한다."""
    _require_admin_access(user, hid)
    item = db.get(Hl7Inbox, mid)
    if not item or item.hospital_id != hid:
        raise HTTPException(status_code=404, detail="수신 메시지를 찾을 수 없습니다")
    new_item = hl7_svc.process_inbound(db, item.raw, hid)
    db.add(AuditLog(action="hl7_reprocess", target_type="hl7_inbox", target_id=str(mid),
                    detail={"by": user["sub"], "new_id": new_item.id, "status": new_item.status}))
    db.commit()
    return _msg_out(new_item)


@router.post("/hospitals/{hid}/outbox/{mid}/send")
def send_outbox(hid: int, mid: int, db: Session = Depends(get_db),
                user: dict = Depends(current_user)):
    """outbox 1건 즉시 전송(설정 oru.host/port MLLP) — 실패 시 재시도 카운트 증가."""
    _require_admin_access(user, hid)
    item = db.get(Hl7Outbox, mid)
    if not item or item.hospital_id != hid:
        raise HTTPException(status_code=404, detail="발신 메시지를 찾을 수 없습니다")
    cfg = get_hospital_setting(db, hid, "hl7.config", default={}) or {}
    item = hl7_svc.send_outbox_item(db, item, cfg)
    return _msg_out(item)


@router.post("/outbox/sync")
def sync_outbox(db: Session = Depends(get_db), user: dict = Depends(admin_user)):
    """HL7 활성 병원의 확정 판독 중 ORU 미적재분 일괄 적재(멱등)."""
    count = hl7_svc.sync_finalized_reports(db)
    return {"ok": True, "enqueued": count}


class IngestBody(BaseModel):
    raw: str
    hospital_id: int | None = None


@router.post("/ingest")
def ingest(body: IngestBody, db: Session = Depends(get_db), user: dict = Depends(admin_user)):
    """HL7 원문 직접 주입(테스트·연동 점검용) — MLLP 소켓 없이 동일 처리 경로."""
    if not body.raw.strip():
        raise HTTPException(status_code=400, detail="raw는 필수입니다")
    if body.hospital_id is not None:
        _get_hospital(db, body.hospital_id)
    item = hl7_svc.process_inbound(db, body.raw, body.hospital_id)
    return _msg_out(item)


# ════════════════════════════ MLLP 리스너 (전역, 기본 off) ════════════════════════════

@router.get("/listener/status")
def get_listener_status(user: dict = Depends(admin_user)):
    return {"items": hl7_svc.listener_status()}


class ListenerBody(BaseModel):
    port: int


@router.post("/listener/start")
def listener_start(body: ListenerBody, user: dict = Depends(admin_user)):
    if not (1 <= body.port <= 65535):
        raise HTTPException(status_code=400, detail="포트 범위는 1~65535")
    try:
        return hl7_svc.start_listener(body.port)
    except OSError as e:
        raise HTTPException(status_code=409, detail=f"리스너 기동 실패(포트 사용 중?): {e}")


@router.post("/listener/stop")
def listener_stop(body: ListenerBody, user: dict = Depends(admin_user)):
    return hl7_svc.stop_listener(body.port)


# ════════════════════════════ 원격판독 판독문 input ════════════════════════════

class RemoteReportBody(BaseModel):
    hospital_key: str            # 병원별 API 키(remote.reading 설정)
    accession: str = ""
    study_uid: str = ""
    reading: str
    conclusion: str = ""
    reporter: str = ""


def _hospital_by_api_key(db: Session, key: str) -> Hospital | None:
    """remote.reading {enabled, api_key} 가 일치하는 병원 — 키 인증(상수시간 비교)."""
    from app.models import AppSetting

    if not key:
        return None
    rows = db.execute(select(AppSetting).where(
        AppSetting.scope == "hospital", AppSetting.key == "remote.reading")).scalars().all()
    for r in rows:
        v = dict(r.value or {})
        # hmac.compare_digest — 타이밍 공격으로 키를 한 글자씩 추정하지 못하게
        if v.get("enabled") and v.get("api_key") and hmac.compare_digest(str(v["api_key"]), key):
            try:
                return db.get(Hospital, int(r.scope_id))
            except (TypeError, ValueError):
                continue
    return None


@router.post("/remote-report")
def remote_report(body: RemoteReportBody, request: Request, db: Session = Depends(get_db)):
    """외부 원격판독사의 판독문 입력 창구 — JWT 대신 병원별 API 키로 인증한다.

    무차별 대입 방어(레인 S 연동): 키 실패는 감사 로그 + IP 실패 카운트에 누적되고,
    임계(security.policy.threshold) 도달 시 해당 IP 는 잠금(429)된다. 성공 시 카운터 리셋.
    """
    from app.services import security_service

    ip = request.client.host if request.client else ""
    if security_service.locked_remaining("", ip) > 0:
        raise HTTPException(status_code=429,
                            detail="인증 실패가 누적되어 잠시 차단되었습니다. 잠시 후 다시 시도하세요")
    hospital = _hospital_by_api_key(db, body.hospital_key.strip())
    if hospital is None:
        # 실패 감사 로그 + 잠금 카운트(로그인 잠금과 동일 정책 공유 — IP 키)
        security_service.record_login_failure(db, "", ip)
        db.add(AuditLog(action="remote_report_denied", target_type="security",
                        target_id=(ip or "unknown")[:64], detail={"reason": "invalid_api_key"}))
        db.commit()
        raise HTTPException(status_code=403, detail="유효하지 않은 병원 API 키이거나 원격판독이 비활성입니다")
    security_service.reset_login_failures("", ip)
    if not body.reading.strip():
        raise HTTPException(status_code=400, detail="reading은 필수입니다")
    if not body.accession and not body.study_uid:
        raise HTTPException(status_code=400, detail="accession 또는 study_uid가 필요합니다")

    q = select(Study)
    if body.study_uid:
        q = q.where(Study.study_uid == body.study_uid)
    else:
        q = q.where(Study.accession_no == body.accession)
    study = db.execute(q.order_by(Study.id.desc()).limit(1)).scalar_one_or_none()
    if study is None:
        raise HTTPException(status_code=404, detail="해당 검사를 찾을 수 없습니다")
    if study.hospital_id is not None and study.hospital_id != hospital.id:
        raise HTTPException(status_code=403, detail="이 병원 소속 검사가 아닙니다")

    from app.services.report_service import LOCKED_MSG, latest_report

    # 확정 잠금(Fixed) — 내부 경로(update/finalize/external-ai 등)와 동일하게 외부
    # 원격판독 입력도 차단(SPEC §C: 잠금 중 모든 판독 변이 409)
    if bool(study.report_locked):
        raise HTTPException(status_code=409, detail=LOCKED_MSG)

    reporter = (body.reporter or "remote")[:64]
    latest = latest_report(db, study.id)
    sr = {
        "exam": {"modality": study.modality, "body_part": study.body_part,
                 "technique": study.study_desc},
        "comparison": {"prior_study_refs": [], "summary": ""},
        "findings": [{"organ": f"[원격판독 {reporter}]", "observation": body.reading.strip(),
                      "severity": "normal", "measurements": []}],
        "impression": ([{"rank": 1, "statement": body.conclusion.strip(),
                         "confidence": "high", "codes": []}] if body.conclusion.strip() else []),
        "recommendations": [],
        "ai_meta": {"caveats": [f"외부 원격판독 입력 ({hospital.name or hospital.code})"]},
    }
    narrative = body.reading.strip() + (f"\n\n[결론] {body.conclusion.strip()}" if body.conclusion.strip() else "")
    if latest is not None and latest.status != "finalized" and latest.created_by.startswith("remote:"):
        # 동일 창구의 미확정 초안은 갱신(버전 난립 방지)
        latest.sr_json = sr
        latest.narrative_text = narrative
        report = latest
    else:
        report = Report(
            study_id=study.id, version=(latest.version + 1) if latest else 1,
            status="draft", sr_json=sr, narrative_text=narrative,
            created_by=f"remote:{reporter}",
        )
        db.add(report)
        if study.status in ("received",):
            study.status = "draft_ready"
    # 수신 이력 — 패널 '최근 수신' 표시용(inbox 재사용, PII 원문 저장 없음)
    db.add(Hl7Inbox(hospital_id=hospital.id, msg_type="RMT^RPT",
                    patient_id="", accession=study.accession_no or "",
                    raw="", parsed_json={"reporter": reporter, "study_id": study.id},
                    status="done", processed_at=datetime.now(timezone.utc)))
    db.add(AuditLog(action="remote_report", target_type="study", target_id=str(study.id),
                    detail={"hospital_id": hospital.id, "reporter": reporter,
                            "accession": study.accession_no}))
    db.commit()
    return {"ok": True, "report_id": report.id, "study_id": study.id,
            "version": report.version, "status": report.status}


# ════════════════════════════ MWL SCP (병원별, 기본 off) ════════════════════════════

@router.get("/hospitals/{hid}/mwl/status")
def get_mwl_status(hid: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    _require_access(user, hid)
    _get_hospital(db, hid)
    return mwl_svc.mwl_status(hid)


@router.post("/hospitals/{hid}/mwl/start")
def mwl_start(hid: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """mwl.config {enabled, port, aet, registered_only} 로 병원별 MWL SCP 기동."""
    _require_admin_access(user, hid)
    _get_hospital(db, hid)
    cfg = get_hospital_setting(db, hid, "mwl.config", default={}) or {}
    if not cfg.get("enabled"):
        raise HTTPException(status_code=409, detail="mwl.config.enabled 가 꺼져 있습니다")
    try:
        port = int(cfg.get("port") or 0)
    except (TypeError, ValueError):  # 설정 오염(문자열 포트 등) → 500 대신 명확한 400
        port = 0
    if not (1 <= port <= 65535):
        raise HTTPException(status_code=400, detail="mwl.config.port 설정이 필요합니다")
    try:
        result = mwl_svc.start_mwl(hid, port, str(cfg.get("aet") or "SAINTVIEW"),
                                   bool(cfg.get("registered_only")))
    except OSError as e:
        raise HTTPException(status_code=409, detail=f"MWL SCP 기동 실패(포트 사용 중?): {e}")
    db.add(AuditLog(action="mwl_scp_start", target_type="hospital", target_id=str(hid),
                    detail={"by": user["sub"], "port": port}))
    db.commit()
    return result


@router.post("/hospitals/{hid}/mwl/stop")
def mwl_stop(hid: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    _require_admin_access(user, hid)
    result = mwl_svc.stop_mwl(hid)
    db.add(AuditLog(action="mwl_scp_stop", target_type="hospital", target_id=str(hid),
                    detail={"by": user["sub"]}))
    db.commit()
    return result


# ════════════════════════════ 가상 환자 생성기 ════════════════════════════

class TestgenExam(BaseModel):
    """명시 모드 검사 항목 — Region/BodyPart/Projection (오더 1건씩 생성)."""
    region: str = ""
    body_part: str = ""
    projection: str = ""


class TestgenPatient(BaseModel):
    """명시 모드 환자 정보 — RIS 오더 입력 폼. last_name 만 필수(400 검증)."""
    patient_id: str = ""
    accession: str = ""
    sex: str = ""
    last_name: str = ""
    first_name: str = ""
    physician: str = ""
    department: str = ""
    modality: str = ""
    # 오더 입력 확장 필드 — 미입력 시 서버가 기본값(오늘/현재시각/자동 채번)으로 채움
    birth_date: str = ""
    scheduled_date: str = ""
    scheduled_time: str = ""
    station_aet: str = ""
    dicom_study_id: str = ""


class TestgenBody(BaseModel):
    hospital_id: int
    count: int = 1
    with_dicom: bool = False   # 합성 DICOM 생성·Orthanc 등록 (벌크 모드 전용)
    station_aet: str = ""
    # 명시 모드(오더 입력형) — patient 가 있으면 exams 항목별 오더 생성(벌크 하위 호환 유지)
    patient: TestgenPatient | None = None
    exams: list[TestgenExam] = []


@router.post("/testgen")
def testgen(body: TestgenBody, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """가상 환자+오더 생성 — MWL 로 장비가 조회 가능.

    - 명시 모드(patient 포함): 환자 1명 + exams 항목별 오더 생성 → {orders: [...]}
    - 벌크 모드(patient 없음, 기존 동작): count 건 랜덤 생성 → {items: [...], dicom: {...}}
    """
    _require_admin_access(user, body.hospital_id)
    _get_hospital(db, body.hospital_id)
    stored = get_hospital_setting(db, body.hospital_id, "testgen.config", default={}) or {}
    if body.patient is not None:
        # ── 명시 모드 검증 — 필수값 누락은 400 ──
        if not body.patient.last_name.strip():
            raise HTTPException(status_code=400, detail="last_name(성)은 필수입니다")
        if not body.exams:
            raise HTTPException(status_code=400, detail="검사 항목(exams)이 최소 1건 필요합니다")
        if any(not e.body_part.strip() for e in body.exams):
            raise HTTPException(status_code=400, detail="각 검사 항목의 body_part는 필수입니다")
        if len(body.exams) > 50:
            raise HTTPException(status_code=400, detail="검사 항목은 최대 50건")
        return testgen_svc.generate_explicit(
            db, body.hospital_id, stored,
            patient=body.patient.model_dump(),
            exams=[e.model_dump() for e in body.exams], by=user["sub"])
    if not (1 <= body.count <= 50):
        raise HTTPException(status_code=400, detail="count는 1~50")
    return testgen_svc.generate(db, body.hospital_id, stored, body.count,
                                with_dicom=body.with_dicom,
                                station_aet=body.station_aet, by=user["sub"])
