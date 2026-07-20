"""레인 H — HL7 파서/오더 생성/원격판독 키 인증/가상환자 생성기/MWL 매칭 테스트."""
from __future__ import annotations

import time

from sqlalchemy import select

from app.db import SessionLocal
from app.models import Hl7Inbox, Hl7Outbox, Hospital, Order, Patient, Report, Study
from app.services import hl7 as hl7_svc
from app.services import testgen as testgen_svc
from app.services.settings_service import set_hospital_setting


def _mk_hospital(db, prefix="HL7") -> Hospital:
    h = Hospital(code=f"{prefix}-{time.time_ns()}", name="HL7테스트병원")
    db.add(h)
    db.commit()
    db.refresh(h)
    return h


def _adt_raw(pid="P1001", name="HONG^GILDONG", event="A04") -> str:
    return "\r".join([
        f"MSH|^~\\&|EMR|HOSP|SAINTVIEW|SVFAC|20260710120000||ADT^{event}|MSG001|P|2.5",
        f"PID|1||{pid}^^^HOSP||{name}||19800101|M",
    ])


def _orm_raw(pid="P2001", accession="ACC-HL7-1") -> str:
    return "\r".join([
        "MSH|^~\\&|EMR|HOSP|SAINTVIEW|SVFAC|20260710120000||ORM^O01|MSG002|P|2.5",
        f"PID|1||{pid}^^^HOSP||KIM^CHULSOO||19750315|F",
        f"ORC|NW|{accession}",
        f"OBR|1||{accession}|CR^CHEST PA|||20260711093000",
    ])


# ════════════════════════════ 파서 (ADT/ORM/ORU 왕복) ════════════════════════════

def test_parse_adt_fields():
    seg = hl7_svc.parse_hl7(_adt_raw())
    assert hl7_svc.msg_type_of(seg) == "ADT^A04"
    assert hl7_svc.hl7_get(seg, "MSH", 5) == "SAINTVIEW"   # 수신 앱(병원 매핑)
    assert hl7_svc.hl7_get(seg, "PID", 3, 1) == "P1001"
    assert hl7_svc.hl7_get(seg, "PID", 5) == "HONG^GILDONG"
    assert hl7_svc.hl7_get(seg, "PID", 7) == "19800101"


def test_oru_roundtrip_and_ack():
    raw = hl7_svc.build_oru(
        patient_id="P9", patient_name="LEE^YOUNG", birth_date="19900101", sex="F",
        accession="ACC-9", modality="CT", study_desc="BRAIN",
        reading="뇌실질 이상 없음.\n출혈 소견 없음.", conclusion="정상 소견", reporter="drkim",
    )
    seg = hl7_svc.parse_hl7(raw)
    assert hl7_svc.msg_type_of(seg) == "ORU^R01"
    assert hl7_svc.hl7_get(seg, "PID", 3) == "P9"
    assert hl7_svc.hl7_get(seg, "OBR", 3) == "ACC-9"
    obx_lines = [s[5] for s in seg if s[0] == "OBX"]
    assert "뇌실질 이상 없음." in obx_lines and "정상 소견" in obx_lines
    # ACK 왕복 — 원문 MSH-10 이 MSA-2 로 반사
    ack = hl7_svc.build_ack(hl7_svc.parse_hl7(_adt_raw()), "AA")
    ack_seg = hl7_svc.parse_hl7(ack)
    assert hl7_svc.hl7_get(ack_seg, "MSA", 1) == "AA"
    assert hl7_svc.hl7_get(ack_seg, "MSA", 2) == "MSG001"


# ════════════════════════════ 수신 처리 (ADT 캐시 / ORM 오더) ════════════════════════════

def test_adt_inbound_caches_patient(db):
    h = _mk_hospital(db)
    item = hl7_svc.process_inbound(db, _adt_raw(pid="PADT1"), h.id)
    assert item.status == "done" and item.msg_type == "ADT^A04"
    cached = hl7_svc.cached_patient(db, h.id, "PADT1")
    assert cached and cached["patient_name"] == "HONG^GILDONG"


def test_orm_inbound_creates_order(db):
    h = _mk_hospital(db)
    acc = f"ACC-ORM-{time.time_ns()}"
    item = hl7_svc.process_inbound(db, _orm_raw(pid="PORM1", accession=acc), h.id)
    assert item.status == "done", item.error
    order = db.execute(select(Order).where(Order.accession_no == acc)).scalar_one()
    assert order.patient_key == "PORM1"
    assert order.modality == "CR"
    assert order.scheduled_date == "20260711"
    assert order.hospital_id == h.id
    # 동일 Accession 재수신 — 중복 오더 미생성
    hl7_svc.process_inbound(db, _orm_raw(pid="PORM1", accession=acc), h.id)
    n = len(db.execute(select(Order).where(Order.accession_no == acc)).scalars().all())
    assert n == 1


# ════════════════════════════ 원격판독 키 인증 ════════════════════════════

def _mk_study(db, h: Hospital, acc: str) -> Study:
    p = Patient(patient_key=f"RPT-{time.time_ns()}")
    db.add(p)
    db.flush()
    s = Study(patient_id=p.id, study_uid=f"1.2.3.{time.time_ns()}", accession_no=acc,
              modality="CR", hospital_id=h.id)
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def test_remote_report_key_403(client, db):
    h = _mk_hospital(db, "RMT")
    set_hospital_setting(db, h.id, "remote.reading", {"enabled": True, "api_key": "secret-key-1"})
    _mk_study(db, h, "ACC-RMT-403")
    r = client.post("/api/hl7/remote-report", json={
        "hospital_key": "wrong-key", "accession": "ACC-RMT-403", "reading": "판독문",
    })
    assert r.status_code == 403


def test_remote_report_creates_draft(client, db):
    h = _mk_hospital(db, "RMT2")
    set_hospital_setting(db, h.id, "remote.reading", {"enabled": True, "api_key": "secret-key-2"})
    study = _mk_study(db, h, "ACC-RMT-OK")
    r = client.post("/api/hl7/remote-report", json={
        "hospital_key": "secret-key-2", "accession": "ACC-RMT-OK",
        "reading": "폐야 깨끗함", "conclusion": "정상", "reporter": "원격판독의",
    })
    assert r.status_code == 200, r.text
    body = r.json()
    with SessionLocal() as db2:
        rep = db2.get(Report, body["report_id"])
        assert rep.study_id == study.id and rep.status == "draft"
        assert rep.created_by.startswith("remote:")
        assert "폐야 깨끗함" in rep.narrative_text
        # 최근 수신 이력(RMT^RPT) 기록
        hist = db2.execute(select(Hl7Inbox).where(
            Hl7Inbox.hospital_id == h.id, Hl7Inbox.msg_type == "RMT^RPT")).scalars().all()
        assert len(hist) == 1


def test_remote_report_locked_409(client, db):
    """확정 잠금(Fixed) 검사 — 외부 원격판독 입력도 내부 경로와 동일하게 409 차단 (SPEC §C)."""
    h = _mk_hospital(db, "RMT5")
    set_hospital_setting(db, h.id, "remote.reading", {"enabled": True, "api_key": "secret-key-5"})
    study = _mk_study(db, h, "ACC-RMT-LOCK")
    study.report_locked = True
    db.commit()
    r = client.post("/api/hl7/remote-report", json={
        "hospital_key": "secret-key-5", "accession": "ACC-RMT-LOCK", "reading": "잠금 중 입력",
    })
    assert r.status_code == 409, r.text
    assert "잠금" in r.json()["detail"]
    # 잠금 중 리포트 미생성
    with SessionLocal() as db2:
        reps = db2.execute(select(Report).where(Report.study_id == study.id)).scalars().all()
        assert reps == []
    # 잠금 해제 후 정상 입력
    study.report_locked = False
    db.commit()
    r = client.post("/api/hl7/remote-report", json={
        "hospital_key": "secret-key-5", "accession": "ACC-RMT-LOCK", "reading": "해제 후 판독",
    })
    assert r.status_code == 200, r.text


def test_remote_report_disabled_403(client, db):
    h = _mk_hospital(db, "RMT3")
    set_hospital_setting(db, h.id, "remote.reading", {"enabled": False, "api_key": "secret-key-3"})
    r = client.post("/api/hl7/remote-report", json={
        "hospital_key": "secret-key-3", "accession": "X", "reading": "판독문",
    })
    assert r.status_code == 403


def test_remote_report_bruteforce_lockout(client, db):
    """키 무차별 대입 — 실패 감사 로그 + IP 잠금(429), 잠금 해제 후 정상 입력·카운터 리셋."""
    from app.models import AuditLog
    from app.services import security_service as sec
    from app.services.settings_service import set_setting

    sec.reset_state()
    sec.set_policy(db, {"threshold": 3, "lock_min": 15})
    h = _mk_hospital(db, "RMTB")
    set_hospital_setting(db, h.id, "remote.reading", {"enabled": True, "api_key": "brute-key"})
    _mk_study(db, h, "ACC-RMT-BRUTE")

    def _denied_count() -> int:
        with SessionLocal() as db2:
            return len(db2.execute(select(AuditLog).where(
                AuditLog.action == "remote_report_denied")).scalars().all())

    try:
        before = _denied_count()
        for _ in range(3):
            r = client.post("/api/hl7/remote-report", json={
                "hospital_key": "wrong-key", "accession": "ACC-RMT-BRUTE", "reading": "x"})
            assert r.status_code == 403
        # 임계 도달 — 올바른 키로도 429 (키 검증 자체를 차단해 무차별 대입 무력화)
        r = client.post("/api/hl7/remote-report", json={
            "hospital_key": "brute-key", "accession": "ACC-RMT-BRUTE", "reading": "x"})
        assert r.status_code == 429
        # 실패 3건 전부 감사 로그에 남는다
        assert _denied_count() - before == 3
        # 잠금 해제(관리자) 후 정상 키 → 성공 + IP 카운터 리셋
        sec.reset_state()
        r = client.post("/api/hl7/remote-report", json={
            "hospital_key": "brute-key", "accession": "ACC-RMT-BRUTE", "reading": "정상 판독"})
        assert r.status_code == 200, r.text
        assert "ip:testclient" not in sec.lockout_overview()["counting"]
    finally:
        sec.reset_state()
        set_setting(db, sec.POLICY_KEY, {}, scope="global")


# ════════════════════════════ ORU outbox (확정 → 적재, 멱등) ════════════════════════════

def test_oru_enqueue_idempotent(db):
    h = _mk_hospital(db, "ORU")
    set_hospital_setting(db, h.id, "hl7.config", {"enabled": True, "port": 12575})
    study = _mk_study(db, h, f"ACC-ORU-{time.time_ns()}")
    from datetime import datetime, timezone

    rep = Report(study_id=study.id, version=1, status="finalized",
                 narrative_text="판독 본문", reviewed_by="drlee",
                 finalized_at=datetime.now(timezone.utc))
    db.add(rep)
    db.commit()
    db.refresh(rep)
    item1 = hl7_svc.enqueue_oru(db, rep.id)
    item2 = hl7_svc.enqueue_oru(db, rep.id)
    assert item1 is not None and item1.id == item2.id  # 멱등
    assert item1.msg_type == "ORU^R01" and item1.status == "queued"
    seg = hl7_svc.parse_hl7(item1.raw)
    assert hl7_svc.hl7_get(seg, "OBR", 3) == study.accession_no
    # sync 경로도 재적재하지 않는다
    assert hl7_svc.sync_finalized_reports(db) == 0
    n = len(db.execute(select(Hl7Outbox).where(
        Hl7Outbox.accession == study.accession_no)).scalars().all())
    assert n == 1


# ════════════════════════════ 가상 환자 생성기 ════════════════════════════

def test_testgen_api_unique(client, db, auth_headers):
    h = _mk_hospital(db, "TG")
    set_hospital_setting(db, h.id, "testgen.config",
                         {"pid_prefix": "TGX", "acc_prefix": "TGA", "modalities": ["CR"]})
    r1 = client.post("/api/hl7/testgen", headers=auth_headers,
                     json={"hospital_id": h.id, "count": 3})
    assert r1.status_code == 200, r1.text
    items1 = r1.json()["items"]
    assert len(items1) == 3
    assert all(i["patient_key"].startswith("TGX") for i in items1)
    assert all(i["modality"] == "CR" for i in items1)
    r2 = client.post("/api/hl7/testgen", headers=auth_headers,
                     json={"hospital_id": h.id, "count": 2})
    items2 = r2.json()["items"]
    pids = [i["patient_key"] for i in items1 + items2]
    accs = [i["accession_no"] for i in items1 + items2]
    assert len(set(pids)) == 5 and len(set(accs)) == 5  # 반복 호출에도 유일
    # 생성 오더는 MWL 조회 대상(scheduled)
    order = db.get(Order, items1[0]["order_id"])
    assert order.status == "scheduled" and order.hospital_id == h.id


def test_testgen_explicit_orders(client, db, auth_headers):
    """명시 모드(오더 입력형) — 환자 1명 + 검사 항목별 오더 n건, Accession -1,-2… 유일화."""
    h = _mk_hospital(db, "TGE")
    r = client.post("/api/hl7/testgen", headers=auth_headers, json={
        "hospital_id": h.id,
        "patient": {"patient_id": "TGE-P1", "accession": "TGE-ACC", "sex": "M",
                    "last_name": "KIM", "first_name": "CHULSOO",
                    "physician": "DR.LEE", "department": "영상의학과", "modality": "CR"},
        "exams": [
            {"region": "Chest", "body_part": "CHEST", "projection": "PA"},
            {"region": "Chest", "body_part": "RIB", "projection": "Oblique"},
            {"region": "Skull", "body_part": "SKULL", "projection": "AP"},
        ],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    orders = body["orders"]
    assert len(orders) == 3 and body["patient_key"] == "TGE-P1"
    accs = [o["accession_no"] for o in orders]
    assert accs == ["TGE-ACC-1", "TGE-ACC-2", "TGE-ACC-3"]  # 항목별 접미사·유일
    assert len(set(accs)) == 3
    assert orders[0]["body_part"] == "CHEST" and orders[0]["projection"] == "PA"
    for o in orders:
        order = db.get(Order, o["order_id"])
        assert order.patient_key == "TGE-P1"
        assert order.patient_name == "KIM^CHULSOO"
        assert order.modality == "CR" and order.sex == "M"
        assert order.status == "scheduled" and order.hospital_id == h.id  # MWL 조회 대상
        assert order.physician == "DR.LEE" and order.department == "영상의학과"  # 오더 컬럼 보존
    # MWL 데이터셋에 의뢰의/진료과 노출 — ReferringPhysicianName(0008,0090)·부서(0008,1040)
    from app.dicom.mwl import build_mwl_dataset

    ds = build_mwl_dataset(db.get(Order, orders[0]["order_id"]))
    assert str(ds.ReferringPhysicianName) == "DR.LEE"
    assert str(ds.InstitutionalDepartmentName) == "영상의학과"


def test_testgen_explicit_extended_fields(client, db, auth_headers):
    """명시 모드 확장 필드 — 생년월일·예약일/시각·장비 AET·Study ID 가 Order 에 저장된다."""
    h = _mk_hospital(db, "TGX")
    r = client.post("/api/hl7/testgen", headers=auth_headers, json={
        "hospital_id": h.id,
        "patient": {"last_name": "CHOI", "modality": "CT",
                    "birth_date": "19700101", "scheduled_date": "20260812",
                    "scheduled_time": "0930", "station_aet": "CT01", "dicom_study_id": "SID9"},
        "exams": [
            {"region": "Brain", "body_part": "BRAIN", "projection": "Contrast (Post)"},
            {"region": "Chest", "body_part": "CHEST", "projection": "Non-Contrast (Pre)"},
        ],
    })
    assert r.status_code == 200, r.text
    orders = [db.get(Order, o["order_id"]) for o in r.json()["orders"]]
    assert all(o.birth_date == "19700101" for o in orders)
    assert all(o.scheduled_date == "20260812" and o.scheduled_time == "0930" for o in orders)
    assert all(o.station_aet == "CT01" for o in orders)
    # Study ID: 다건이면 -1/-2 접미
    assert [o.dicom_study_id for o in orders] == ["SID9-1", "SID9-2"]
    # 미입력 시 폴백 — 예약일/시각은 오늘/현재, Study ID 는 T{id} 자동 채번
    r2 = client.post("/api/hl7/testgen", headers=auth_headers, json={
        "hospital_id": h.id, "patient": {"last_name": "SEO", "modality": "CR"},
        "exams": [{"region": "Chest", "body_part": "CHEST", "projection": "PA"}],
    })
    o2 = db.get(Order, r2.json()["orders"][0]["order_id"])
    assert o2.scheduled_date and len(o2.scheduled_date) == 8       # 오늘로 채움
    assert o2.dicom_study_id.startswith("T")                       # 자동 채번


def test_testgen_explicit_autogen_ids(client, db, auth_headers):
    """명시 모드 — patient_id/accession 미입력 시 생성 규칙(프리픽스/자릿수)으로 채움."""
    h = _mk_hospital(db, "TGF")
    set_hospital_setting(db, h.id, "testgen.config",
                         {"pid_prefix": "TGF", "pid_digits": 5, "acc_prefix": "TGFA"})
    r = client.post("/api/hl7/testgen", headers=auth_headers, json={
        "hospital_id": h.id,
        "patient": {"last_name": "PARK"},
        "exams": [{"region": "Abdomen", "body_part": "KUB", "projection": "AP"}],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["patient_key"].startswith("TGF") and len(body["patient_key"]) == 8  # TGF+5자리
    assert body["orders"][0]["accession_no"].startswith("TGFA")


def test_testgen_explicit_validation_400(client, db, auth_headers):
    """명시 모드 필수값 — last_name 누락·exams 빈 목록·body_part 누락은 400."""
    h = _mk_hospital(db, "TGV")
    exam = {"region": "Chest", "body_part": "CHEST", "projection": "PA"}
    r = client.post("/api/hl7/testgen", headers=auth_headers, json={
        "hospital_id": h.id, "patient": {"last_name": "  "}, "exams": [exam]})
    assert r.status_code == 400
    r = client.post("/api/hl7/testgen", headers=auth_headers, json={
        "hospital_id": h.id, "patient": {"last_name": "KIM"}, "exams": []})
    assert r.status_code == 400
    r = client.post("/api/hl7/testgen", headers=auth_headers, json={
        "hospital_id": h.id, "patient": {"last_name": "KIM"},
        "exams": [{"region": "Chest", "body_part": "", "projection": "PA"}]})
    assert r.status_code == 400


def test_testgen_bulk_mode_regression(client, db, auth_headers):
    """벌크 모드 하위 호환 — patient 없는 요청은 기존 count 기반 동작({items, dicom})."""
    h = _mk_hospital(db, "TGB")
    r = client.post("/api/hl7/testgen", headers=auth_headers,
                    json={"hospital_id": h.id, "count": 2})
    assert r.status_code == 200, r.text
    body = r.json()
    assert "items" in body and len(body["items"]) == 2
    assert "dicom" in body and body["dicom"]["requested"] is False


def test_testgen_synthetic_dicom_bytes(db):
    """합성 SC DICOM 이 생성 ID/Accession 을 반영하는지 (Orthanc 없이 바이트 검증)."""
    import io

    from pydicom import dcmread

    h = _mk_hospital(db, "TGD")
    out = testgen_svc.generate(db, h.id, {"pid_prefix": "TGD"}, 1)
    order = db.get(Order, out["items"][0]["order_id"])
    ds = dcmread(io.BytesIO(testgen_svc.build_synthetic_sc(order)))
    assert str(ds.PatientID) == order.patient_key
    assert str(ds.AccessionNumber) == order.accession_no
    assert ds.Rows == 64 and len(ds.PixelData) == 64 * 64


def test_testgen_pid_skips_existing_patient(db):
    """실환자(Patient) 테이블에 같은 프리픽스 ID 가 있으면 그 다음 시퀀스부터(충돌 방지)."""
    db.add(Patient(patient_key="TGP000042"))
    db.commit()
    assert testgen_svc._next_seq(db, {"pid_prefix": "TGP"}) == 43
    h = _mk_hospital(db, "TGP")
    out = testgen_svc.generate(db, h.id, {"pid_prefix": "TGP"}, 1)
    assert out["items"][0]["patient_key"] == "TGP000043"


def test_testgen_accession_collision_suffix(db):
    """기존 검사(Study)가 선점한 Accession 은 R{n} 접미사로 회피 — 미선점은 기본 형식."""
    h = _mk_hospital(db, "TGZ")
    _mk_study(db, h, "TGZ99999999")
    assert testgen_svc._unique_accession(db, {"acc_prefix": "TGZ"}, 99999999) == "TGZ99999999R1"
    assert testgen_svc._unique_accession(db, {"acc_prefix": "TGZ"}, 12345678) == "TGZ12345678"


# ════════════════════════════ MLLP 리스너 하드닝 (크기 상한·격리) ════════════════════════════

def _free_port() -> int:
    import socket

    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def test_mllp_listener_hardening(db):
    """비정상·거대·부분 메시지에 크래시 없이 격리 — 거대 메시지는 AE 거부 + raw 미저장."""
    import socket as sk

    port = _free_port()
    hl7_svc.start_listener(port)
    try:
        # ① 정상 메시지 왕복
        ack = hl7_svc.send_mllp("127.0.0.1", port, _adt_raw(pid="PMLLP-OK"))
        assert hl7_svc.hl7_get(hl7_svc.parse_hl7(ack), "MSA", 1) == "AA"
        # ② 쓰레기 메시지(MSH 없음·제어문자) — 크래시 없이 ACK 응답
        ack = hl7_svc.send_mllp("127.0.0.1", port, "garbage|||\x00\x01|no-msh")
        assert "MSA|" in ack
        # ③ 거대 메시지(1MB 상한 초과) — AE 거부 + inbox 에 raw 저장 안 됨
        huge = _adt_raw(pid="PHUGE") + "\rOBX|1|TX|X||" + "A" * (hl7_svc.MAX_FRAME_BYTES + 100)
        ack = hl7_svc.send_mllp("127.0.0.1", port, huge, timeout=30.0)
        assert hl7_svc.hl7_get(hl7_svc.parse_hl7(ack), "MSA", 1) == "AE"
        with SessionLocal() as db2:
            assert db2.execute(select(Hl7Inbox).where(
                Hl7Inbox.patient_id == "PHUGE")).scalars().all() == []
        # ④ 부분 프레임(종료 바이트 없이 끊김) — 커넥션 격리, 리스너 생존
        s = sk.create_connection(("127.0.0.1", port), timeout=5)
        s.sendall(b"\x0bMSH|^~\\&|partial-frame-no-end")
        s.close()
        ack = hl7_svc.send_mllp("127.0.0.1", port, _adt_raw(pid="PMLLP-OK2"))
        assert hl7_svc.hl7_get(hl7_svc.parse_hl7(ack), "MSA", 1) == "AA"
        # 이중 기동 가드 — 같은 포트 재기동 요청은 재사용(already)
        assert hl7_svc.start_listener(port).get("already") is True
    finally:
        hl7_svc.stop_listener(port)


# ════════════════════════════ MWL 매칭 (SCP 핸들러 코어) ════════════════════════════

def test_mwl_order_matching():
    from pydicom.dataset import Dataset

    from app.services.mwl import order_matches

    order = Order(patient_key="TP1", modality="CR", scheduled_date="20260711",
                  station_aet="CR01", accession_no="A1", status="scheduled")
    q = Dataset()
    sps = Dataset()
    sps.Modality = "CR"
    sps.ScheduledStationAETitle = "CR01"
    sps.ScheduledProcedureStepStartDate = "20260711"
    q.ScheduledProcedureStepSequence = [sps]
    assert order_matches(order, q)
    sps.Modality = "CT"
    assert not order_matches(order, q)
    sps.Modality = ""
    sps.ScheduledProcedureStepStartDate = "20260701-20260712"  # 범위 질의
    assert order_matches(order, q)
    q2 = Dataset()
    q2.PatientID = "OTHER"
    assert not order_matches(order, q2)


def test_mwl_scp_cfind_roundtrip(db):
    """실 DIMSE — MWL SCP 기동 후 장비(SCU) C-FIND 로 scheduled 오더 조회."""
    import socket

    from pydicom.dataset import Dataset
    from pynetdicom import AE
    from pynetdicom.sop_class import ModalityWorklistInformationFind

    from app.services.mwl import start_mwl, stop_mwl

    h = _mk_hospital(db, "MWL")
    acc = f"ACC-MWL-{time.time_ns()}"
    db.add(Order(patient_key="PMWL1", patient_name="KO^A", modality="US",
                 scheduled_date="20260712", accession_no=acc, status="scheduled",
                 hospital_id=h.id))
    db.commit()

    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()

    start_mwl(h.id, port, "TESTMWL")
    try:
        scu = AE()
        scu.add_requested_context(ModalityWorklistInformationFind)
        assoc = scu.associate("127.0.0.1", port, ae_title="TESTMWL")
        assert assoc.is_established, "MWL SCP 연관 수립 실패"
        query = Dataset()
        query.PatientID = ""
        query.AccessionNumber = acc
        sps = Dataset()
        sps.Modality = "US"
        sps.ScheduledStationAETitle = ""
        sps.ScheduledProcedureStepStartDate = ""
        query.ScheduledProcedureStepSequence = [sps]
        results = [ds for st, ds in assoc.send_c_find(query, ModalityWorklistInformationFind)
                   if st and st.Status == 0xFF00]
        assoc.release()
        assert len(results) == 1
        assert str(results[0].AccessionNumber) == acc
        assert str(results[0].PatientID) == "PMWL1"
    finally:
        stop_mwl(h.id)
