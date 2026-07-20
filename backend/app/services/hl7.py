"""HL7 v2 연동 서비스 — 최소 파서(자체 구현)·MLLP 리스너/클라이언트·inbox/outbox 처리.

외부 HL7 라이브러리 의존 금지(레인 H 계약) — 표준 파이프(|) 구분 최소 파서를 직접 구현한다.
- 수신(ADT^A04/A08): 환자 정보를 hl7_inbox.parsed_json 에 캐시(뷰어 patient_key 매핑 보강)
- 수신(ORM^O01): 기존 Order 모델 재사용 — '촬영을 위한 환자 정보 가져오기'
- 발신(ORU^R01): 판독 확정 시 outbox 적재 → 설정된 대상 host:port 로 MLLP 전송(실패 시 재시도 카운트)

병원 매핑: 병원별 hl7.config(hospital 스코프) = {enabled, port, facility, oru: {host, port}}.
같은 포트를 공유하는 병원들은 MSH-5/6(수신 애플리케이션/기관)으로 구분한다.
"""
from __future__ import annotations

import logging
import socket
import threading
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AuditLog, Hl7Inbox, Hl7Outbox, Order

logger = logging.getLogger("saintview.hl7")

# MLLP 프레이밍 바이트 (HL7 Minimal Lower Layer Protocol)
MLLP_START = b"\x0b"
MLLP_END = b"\x1c\x0d"

# 크기 상한 — 거대 메시지로 인한 raw 저장 폭주·메모리 고갈 방지(HL7 v2 메시지는 통상 수 KB)
MAX_FRAME_BYTES = 1 * 1024 * 1024    # 단일 메시지(프레임) 상한 — 초과 시 AE 거부, 저장 안 함
MAX_BUFFER_BYTES = 4 * 1024 * 1024   # 프레임 종료 없는 수신 누적 상한 — 초과 시 연결 종료

CONFIG_KEY = "hl7.config"


def _decode_hl7(b: bytes) -> str:
    """HL7 바이트 디코딩 — 한국 HIS/RIS 는 통상 EUC-KR 로 보낸다. UTF-8 우선, 실패 시 CP949 폴백.

    가드: EUC-KR 바이트가 우연히 유효 UTF-8 인 짧은 한글(예 '징'=C2A1→'¡')을 놓치지 않도록,
    UTF-8 결과에 한글은 없는데 Latin-1 보충 문자만 있으면 CP949 재해석을 시도해
    한글이 나오는 쪽을 채택한다.
    """
    try:
        s = b.decode("utf-8")
        has_hangul = any("가" <= c <= "힣" for c in s)
        has_latin1_sup = any("\xa1" <= c <= "\xff" for c in s)
        if not has_hangul and has_latin1_sup:
            try:
                s2 = b.decode("cp949")
                if any("가" <= c <= "힣" for c in s2):
                    return s2
            except UnicodeDecodeError:
                pass
        return s
    except UnicodeDecodeError:
        pass
    try:
        return b.decode("cp949")
    except UnicodeDecodeError:
        return b.decode("utf-8", errors="replace")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _safe_int(v, default: int = 0) -> int:
    """설정값 방어적 정수 변환 — 병원 설정 오염(문자열 포트 등)이 전체 처리를 깨지 않게."""
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


# ════════════════════════════ 최소 HL7 v2 파서 (자체 구현) ════════════════════════════

def parse_hl7(raw: str) -> list[list[str]]:
    """HL7 v2 원문 → 세그먼트 리스트. 각 세그먼트는 필드 리스트(인덱스 0 = 세그먼트명).

    MSH 특례: MSH-1 은 필드 구분자 자체이므로 fields[1] = '|' 로 정렬해
    표준 필드 번호(MSH-9 = fields[9])와 인덱스가 일치하도록 한다.
    """
    segments: list[list[str]] = []
    for line in raw.replace("\r\n", "\r").replace("\n", "\r").split("\r"):
        line = line.strip()
        if not line:
            continue
        if line.startswith("MSH") and len(line) > 3:
            sep = line[3]
            rest = line[4:].split(sep)
            segments.append(["MSH", sep, *rest])
        else:
            segments.append(line.split("|"))
    return segments


def hl7_get(segments: list[list[str]], seg_id: str, field: int, component: int = 0) -> str:
    """세그먼트/필드/컴포넌트 접근 — 없으면 빈 문자열(방어적)."""
    for seg in segments:
        if seg and seg[0] == seg_id:
            if field >= len(seg):
                return ""
            value = seg[field]
            if component > 0:
                parts = value.split("^")
                return parts[component - 1] if component <= len(parts) else ""
            return value
    return ""


def msg_type_of(segments: list[list[str]]) -> str:
    """MSH-9 → 'ADT^A04' 형태(타입^이벤트)."""
    v = hl7_get(segments, "MSH", 9)
    parts = v.split("^")
    return "^".join(parts[:2]) if len(parts) >= 2 else v


def build_segment(fields: list[str]) -> str:
    return "|".join(fields)


def build_msh(msg_type: str, *, sending_app: str = "SAINTVIEW", sending_fac: str = "SAINTVIEW",
              receiving_app: str = "", receiving_fac: str = "", control_id: str = "") -> str:
    ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    cid = control_id or f"SV{ts}"
    return build_segment([
        "MSH", "^~\\&", sending_app, sending_fac, receiving_app, receiving_fac,
        ts, "", msg_type, cid, "P", "2.5",
    ])


def build_ack(segments: list[list[str]], code: str = "AA", text: str = "") -> str:
    """수신 메시지에 대한 ACK^xxx 생성 — MSA-2 는 원문 MSH-10(제어 ID)."""
    control_id = hl7_get(segments, "MSH", 10)
    sending_app = hl7_get(segments, "MSH", 3)
    sending_fac = hl7_get(segments, "MSH", 4)
    msh = build_msh("ACK", receiving_app=sending_app, receiving_fac=sending_fac)
    msa = build_segment(["MSA", code, control_id, text])
    return msh + "\r" + msa + "\r"


def build_oru(*, patient_id: str, patient_name: str, birth_date: str, sex: str,
              accession: str, modality: str, study_desc: str,
              reading: str, conclusion: str, reporter: str,
              receiving_app: str = "", receiving_fac: str = "") -> str:
    """판독 결과 → ORU^R01. OBX-5 에 판독/결론을 줄 단위로 싣는다."""
    lines = [
        build_msh("ORU^R01", receiving_app=receiving_app, receiving_fac=receiving_fac),
        build_segment(["PID", "1", "", patient_id, "", patient_name, "", birth_date, sex]),
        build_segment([
            "OBR", "1", "", accession, f"{modality}^{study_desc}", "", "",
            datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S"),
            "", "", "", "", "", "", "", reporter,
        ]),
    ]
    seq = 1
    for section, text in (("READING", reading), ("CONCLUSION", conclusion)):
        for ln in (text or "").splitlines() or ([""] if not text else []):
            lines.append(build_segment(["OBX", str(seq), "TX", section, "", ln, "", "", "", "", "F"]))
            seq += 1
    return "\r".join(lines) + "\r"


# ════════════════════════════ 수신 처리 (inbox) ════════════════════════════

def _pid_info(segments: list[list[str]]) -> dict:
    """PID 세그먼트 → 환자 정보 dict (환자 캐시·오더 생성 공용)."""
    name_raw = hl7_get(segments, "PID", 5)
    # HL7 PN: Family^Given → DICOM PN 표기(Last^First) 그대로 유지
    return {
        "patient_id": hl7_get(segments, "PID", 3, 1) or hl7_get(segments, "PID", 3),
        "patient_name": name_raw,
        "birth_date": hl7_get(segments, "PID", 7)[:8],
        "sex": hl7_get(segments, "PID", 8)[:8],
    }


def process_inbound(db: Session, raw: str, hospital_id: int | None = None) -> Hl7Inbox:
    """HL7 원문 1건 수신 처리 — inbox 기록 + 타입별 액션(ADT=환자 캐시, ORM=오더 생성).

    예외는 삼키지 않되 inbox 행에 status=error 로 남기고 그대로 반환한다(재처리 대상).
    """
    segments = parse_hl7(raw)
    mtype = msg_type_of(segments)
    info = _pid_info(segments)
    accession = hl7_get(segments, "OBR", 3) or hl7_get(segments, "ORC", 2)
    item = Hl7Inbox(
        hospital_id=hospital_id, msg_type=mtype[:16],
        patient_id=info["patient_id"][:64], accession=accession[:64],
        raw=raw, parsed_json=info, status="received",
    )
    db.add(item)
    db.flush()
    try:
        if mtype in ("ADT^A04", "ADT^A08"):
            # 환자 정보 캐시 — parsed_json 이 곧 캐시(최신 행 우선 조회)
            item.status = "done"
        elif mtype == "ORM^O01":
            _create_order_from_orm(db, segments, info, hospital_id, item)
            item.status = "done"
        else:
            item.status = "done"
            item.error = f"처리 규칙 없는 타입({mtype}) — 기록만"
        item.processed_at = _utcnow()
        db.commit()
    except Exception as e:  # noqa: BLE001 — 오류는 행에 남기고 재처리 가능하게
        db.rollback()
        item = db.get(Hl7Inbox, item.id) or item
        item.status = "error"
        item.error = str(e)[:1000]
        db.commit()
        logger.exception("HL7 수신 처리 오류 (inbox=%s type=%s)", item.id, mtype)
    return item


def _create_order_from_orm(db: Session, segments: list[list[str]], info: dict,
                           hospital_id: int | None, item: Hl7Inbox) -> None:
    """ORM^O01 → Order 생성 (촬영을 위한 환자 정보 가져오기)."""
    accession = (hl7_get(segments, "OBR", 3) or hl7_get(segments, "ORC", 2)).split("^")[0]
    if accession:
        dup = db.execute(select(Order).where(Order.accession_no == accession)).scalar_one_or_none()
        if dup is not None:
            item.parsed_json = {**info, "order_id": dup.id, "duplicate": True}
            return  # 동일 Accession 재수신 — 중복 오더 생성 방지
    service = hl7_get(segments, "OBR", 4)  # 예: CR^CHEST PA
    modality = (service.split("^")[0] or "OT")[:16]
    desc = service.split("^")[1] if "^" in service else service
    sched = hl7_get(segments, "OBR", 7) or hl7_get(segments, "ORC", 9)
    order = Order(
        patient_key=(info["patient_id"] or "UNKNOWN")[:128],
        patient_name=info["patient_name"][:128],
        birth_date=info["birth_date"], sex=info["sex"],
        accession_no=accession[:64], modality=modality,
        scheduled_date=sched[:8], scheduled_time=sched[8:14],
        procedure_desc=desc[:256], hospital_id=hospital_id,
    )
    db.add(order)
    db.flush()
    if not order.accession_no:
        order.accession_no = f"SV{order.id:08d}"
    item.parsed_json = {**info, "order_id": order.id, "accession": order.accession_no}
    db.add(AuditLog(action="hl7_orm_order", target_type="order", target_id=str(order.id),
                    detail={"hospital_id": hospital_id, "accession": order.accession_no}))


def cached_patient(db: Session, hospital_id: int | None, patient_id: str) -> dict | None:
    """HL7 환자ID → 최신 ADT 캐시 조회 — 뷰어 patient_key 일치 보강용."""
    q = (select(Hl7Inbox)
         .where(Hl7Inbox.patient_id == patient_id, Hl7Inbox.msg_type.like("ADT^%"),
                Hl7Inbox.status == "done")
         .order_by(Hl7Inbox.id.desc()).limit(1))
    if hospital_id is not None:
        q = q.where(Hl7Inbox.hospital_id == hospital_id)
    row = db.execute(q).scalar_one_or_none()
    return dict(row.parsed_json or {}) if row else None


# ════════════════════════════ MLLP 리스너 (전역, 기본 off) ════════════════════════════

class MllpListener:
    """포트 1개당 리스너 스레드 1개. 예외는 커넥션 단위로 격리한다."""

    def __init__(self, port: int) -> None:
        self.port = port
        self._stop = threading.Event()
        self._sock: socket.socket | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("0.0.0.0", self.port))
        self._sock.listen(5)
        self._sock.settimeout(1.0)
        self._thread = threading.Thread(target=self._loop, daemon=True, name=f"mllp-{self.port}")
        self._thread.start()
        logger.info("MLLP 리스너 시작 — 포트 %d", self.port)

    def stop(self) -> None:
        self._stop.set()
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
        if self._thread is not None:
            self._thread.join(timeout=3)
        logger.info("MLLP 리스너 종료 — 포트 %d", self.port)

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                conn, addr = self._sock.accept()  # type: ignore[union-attr]
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                self._handle_conn(conn)
            except Exception:  # noqa: BLE001 — 커넥션 단위 격리
                logger.exception("MLLP 커넥션 처리 오류 (peer=%s)", addr)
            finally:
                try:
                    conn.close()
                except OSError:
                    pass

    def _handle_conn(self, conn: socket.socket) -> None:
        conn.settimeout(10.0)
        buf = b""
        while True:
            try:
                chunk = conn.recv(65536)
            except socket.timeout:
                break
            if not chunk:
                break
            buf += chunk
            if len(buf) > MAX_BUFFER_BYTES:
                # 프레임 종료 없이 무한 누적 — 메모리 고갈 방지 위해 연결 종료(격리)
                logger.warning("MLLP 수신 버퍼 상한 초과(%d bytes) — 연결 종료 (포트 %d)",
                               len(buf), self.port)
                break
            while MLLP_END in buf:
                frame, buf = buf.split(MLLP_END, 1)
                raw = _decode_hl7(frame.lstrip(MLLP_START))
                ack = self._dispatch(raw)
                conn.sendall(MLLP_START + ack.encode("utf-8") + MLLP_END)

    def _dispatch(self, raw: str) -> str:
        """메시지 1건 — 병원 해석 후 inbox 처리. 실패해도 ACK(AE)로 응답."""
        from app.db import SessionLocal

        if len(raw) > MAX_FRAME_BYTES:
            # 거대 메시지 — raw 저장 없이 즉시 거부(크기 상한). MSH 는 앞부분에서 파싱 가능
            logger.warning("MLLP 메시지 크기 상한 초과(%d bytes) — AE 거부 (포트 %d)",
                           len(raw), self.port)
            return build_ack(parse_hl7(raw[:4096]), "AE", "메시지 크기 상한 초과(1MB)")
        segments = parse_hl7(raw)
        try:
            with SessionLocal() as db:
                hid = resolve_hospital(db, self.port,
                                       hl7_get(segments, "MSH", 5), hl7_get(segments, "MSH", 6))
                item = process_inbound(db, raw, hid)
                code = "AA" if item.status != "error" else "AE"
                return build_ack(segments, code, item.error[:80] if item.error else "")
        except Exception as e:  # noqa: BLE001
            logger.exception("MLLP 메시지 디스패치 오류")
            return build_ack(segments, "AE", str(e)[:80])


_listeners: dict[int, MllpListener] = {}
_listeners_lock = threading.Lock()


def hospital_hl7_configs(db: Session) -> list[tuple[int, dict]]:
    """모든 병원의 hl7.config — [(hospital_id, config)] (enabled 여부 무관, 호출부 판단)."""
    from app.models import AppSetting

    rows = db.execute(select(AppSetting).where(
        AppSetting.scope == "hospital", AppSetting.key == CONFIG_KEY)).scalars().all()
    out = []
    for r in rows:
        try:
            out.append((int(r.scope_id), dict(r.value or {})))
        except (TypeError, ValueError):
            continue
    return out


def resolve_hospital(db: Session, port: int, msh5: str, msh6: str) -> int | None:
    """포트 + MSH-5/6(수신 앱/기관) → hospital_id. 매칭 없으면 None(전역 귀속)."""
    candidates = [(hid, cfg) for hid, cfg in hospital_hl7_configs(db)
                  if cfg.get("enabled") and _safe_int(cfg.get("port") or 0) == port]
    if len(candidates) == 1:
        return candidates[0][0]
    for hid, cfg in candidates:
        fac = str(cfg.get("facility") or "")
        if fac and fac in (msh5, msh6):
            return hid
    return candidates[0][0] if candidates else None


def start_listener(port: int) -> dict:
    """포트별 MLLP 리스너 기동(이미 있으면 재사용)."""
    with _listeners_lock:
        if port in _listeners:
            return {"port": port, "running": True, "already": True}
        listener = MllpListener(port)
        listener.start()
        _listeners[port] = listener
    return {"port": port, "running": True}


def stop_listener(port: int) -> dict:
    with _listeners_lock:
        listener = _listeners.pop(port, None)
    if listener is not None:
        listener.stop()
    return {"port": port, "running": False}


def listener_status() -> list[dict]:
    with _listeners_lock:
        return [{"port": p, "running": True} for p in sorted(_listeners)]


# ════════════════════════════ 발신 (outbox — ORU^R01) ════════════════════════════

def enqueue_oru(db: Session, report_id: int) -> Hl7Outbox | None:
    """판독 확정 리포트 → ORU^R01 생성 후 outbox 적재(멱등 — 동일 report_id 는 1회).

    통합 지점: report_service.finalize_report 이후 이 함수를 호출하면 된다(레인 H 제공).
    """
    from app.models import Patient, Report

    report = db.get(Report, report_id)
    if report is None or report.status != "finalized":
        return None
    # 멱등 — 동일 report_id 로 이미 적재된 ORU 가 있으면 재적재하지 않는다
    exists = db.execute(select(Hl7Outbox).where(
        Hl7Outbox.msg_type == "ORU^R01",
        Hl7Outbox.accession == (report.study.accession_no or ""),
    )).scalars().all()
    for e in exists:
        if (e.parsed_json or {}).get("report_id") == report_id:
            return e
    study = report.study
    patient = db.get(Patient, study.patient_id)
    sr = report.sr_json or {}
    conclusion = " / ".join(
        i.get("statement", "") for i in sr.get("impression", []) if i.get("statement"))
    raw = build_oru(
        patient_id=patient.patient_key if patient else "",
        patient_name=patient.name_masked if patient else "",
        birth_date=patient.birth_date if patient else "",
        sex=patient.sex if patient else "",
        accession=study.accession_no or "", modality=study.modality,
        study_desc=study.study_desc, reading=report.narrative_text,
        conclusion=conclusion, reporter=report.reviewed_by or report.created_by,
    )
    item = Hl7Outbox(
        hospital_id=study.hospital_id, msg_type="ORU^R01",
        patient_id=(patient.patient_key if patient else "")[:64],
        accession=(study.accession_no or "")[:64], raw=raw,
        parsed_json={"report_id": report_id, "study_id": study.id}, status="queued",
    )
    db.add(item)
    db.commit()
    return item


def sync_finalized_reports(db: Session, limit: int = 200) -> int:
    """HL7 활성 병원의 확정 리포트 중 outbox 미적재분을 일괄 적재(멱등) — 통합 전 폴링 경로."""
    from app.models import Report, Study

    enabled_hids = {hid for hid, cfg in hospital_hl7_configs(db) if cfg.get("enabled")}
    if not enabled_hids:
        return 0
    rows = db.execute(
        select(Report).join(Study, Report.study_id == Study.id)
        .where(Report.status == "finalized", Study.hospital_id.in_(enabled_hids))
        .order_by(Report.id.desc()).limit(limit)
    ).scalars().all()
    count = 0
    for r in rows:
        existing_ids = {
            (o.parsed_json or {}).get("report_id")
            for o in db.execute(select(Hl7Outbox).where(
                Hl7Outbox.accession == (r.study.accession_no or ""))).scalars()
        }
        if r.id in existing_ids:
            continue
        if enqueue_oru(db, r.id) is not None:
            count += 1
    return count


def send_mllp(host: str, port: int, raw: str, timeout: float = 10.0) -> str:
    """MLLP 클라이언트 — 메시지 전송 후 ACK 원문 반환(호출부에서 MSA-1 판정)."""
    with socket.create_connection((host, port), timeout=timeout) as sock:
        sock.sendall(MLLP_START + raw.encode("utf-8") + MLLP_END)
        sock.settimeout(timeout)
        buf = b""
        while MLLP_END not in buf:
            chunk = sock.recv(65536)
            if not chunk:
                break
            buf += chunk
    return _decode_hl7(buf.split(MLLP_END, 1)[0].lstrip(MLLP_START))


def send_outbox_item(db: Session, item: Hl7Outbox, cfg: dict) -> Hl7Outbox:
    """outbox 1건 전송 — 성공 sent / 실패 retry_count 증가(최대 초과 시 error)."""
    oru = dict(cfg.get("oru") or {})
    host, port = str(oru.get("host") or ""), _safe_int(oru.get("port") or 0)
    max_retry = _safe_int(cfg.get("oru_retry_max") or 3, default=3)
    if not host or not port:
        item.status = "error"
        item.error = "발신 대상(oru.host/port) 미설정"
        db.commit()
        return item
    try:
        ack_raw = send_mllp(host, port, item.raw)
        ack_code = hl7_get(parse_hl7(ack_raw), "MSA", 1)
        if ack_code and ack_code != "AA":
            raise RuntimeError(f"수신측 ACK 거부: {ack_code}")
        item.status = "sent"
        item.error = ""
        item.processed_at = _utcnow()
    except Exception as e:  # noqa: BLE001 — 실패는 재시도 카운트로 남긴다
        item.retry_count += 1
        item.error = str(e)[:1000]
        item.status = "error" if item.retry_count >= max_retry else "queued"
        logger.warning("ORU 전송 실패 (outbox=%s retry=%d): %s", item.id, item.retry_count, e)
    db.commit()
    return item
