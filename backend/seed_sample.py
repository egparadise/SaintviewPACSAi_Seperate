"""샘플 데이터 시드(개발용) — 샘플 병원 + 계정 + Client 좌석.

실행: cd backend && py -3.11 seed_sample.py
멱등(idempotent): 이미 있으면 건너뛴다. 운영 배포에는 사용하지 말 것.

생성:
  병원: SAMPLE01 (샘플병원)
  계정: sample_admin(병원 관리자) · sample_dr(영상의학과 의사) · sample_rt(방사선사)
        — 비밀번호 모두 sample1234
  Client 좌석: 판독실-1, 판독실-2
  장비: SAMPLE_CT (CT)
"""
from __future__ import annotations

from sqlalchemy import select

from app.db import SessionLocal, init_db
from app.models import Account, Client, Hospital, Modality
from app.services.auth_service import hash_password

HCODE = "SAMPLE01"
PW = "sample1234"


def _ensure_account(db, username, role, hid, display_name, title=""):
    a = db.execute(select(Account).where(Account.username == username)).scalar_one_or_none()
    if a:
        a.hospital_id, a.role, a.enabled = hid, role, True
        return a, False
    a = Account(username=username, password_hash=hash_password(PW), role=role,
                hospital_id=hid, display_name=display_name, title=title, enabled=True)
    db.add(a)
    return a, True


def main() -> None:
    init_db()
    with SessionLocal() as db:
        h = db.execute(select(Hospital).where(Hospital.code == HCODE)).scalar_one_or_none()
        if not h:
            h = Hospital(code=HCODE, name="샘플병원", address="서울시 중구 샘플로 1",
                         departments="영상의학과,내과,정형외과", phone="02-0000-0000",
                         license_clients=5, modality_limit=5, enabled=True, enforce_isolation=True,
                         billing_method="monthly_transfer", contact="샘플관리자")
            db.add(h)
            db.flush()
            print(f"병원 생성: {h.code} ({h.name})")
        else:
            print(f"병원 존재: {h.code} ({h.name})")
        from app.services.hospital_net import assign_hospital_dicom

        h.server_host = h.server_host or "localhost"
        assign_hospital_dicom(h)  # 병원별 DICOM 포트/AET 배정
        print(f"  DICOM: 수신(SCP) {h.scp_aet}@{h.server_host}:{h.scp_port} · 조회(Q/R) {h.qr_aet}:{h.qr_port}")

        for u, role, name, title in [
            ("sample_admin", "admin", "샘플관리자", "전산관리자"),
            ("sample_dr", "radiologist", "김영상", "영상의학과 전문의"),
            ("sample_rt", "technologist", "이방사", "방사선사"),
        ]:
            _, created = _ensure_account(db, u, role, h.id, name, title)
            print(f"  계정 {'생성' if created else '갱신'}: {u} / {PW} ({role})")

        for seat in ["판독실-1", "판독실-2"]:
            exists = db.execute(
                select(Client).where(Client.hospital_id == h.id, Client.name == seat)
            ).scalar_one_or_none()
            if not exists:
                n = db.execute(select(Client).where(Client.hospital_id == h.id)).scalars().all()
                db.add(Client(hospital_id=h.id, name=seat, code=f"{h.code}-C{len(n)+1:02d}",
                              location="판독실", enabled=True))
                print(f"  Client 좌석 생성: {seat}")

        # 미배정(NULL) 검사를 샘플병원에 귀속 — Client 뷰어(병원 스코프)에서 보이도록
        from app.models import Study

        orphans = db.execute(select(Study).where(Study.hospital_id.is_(None))).scalars().all()
        for s in orphans:
            s.hospital_id = h.id
        if orphans:
            print(f"  미배정 검사 {len(orphans)}건 → {h.code} 귀속")

        mod = db.execute(select(Modality).where(Modality.name == "SAMPLE_CT")).scalar_one_or_none()
        if not mod:
            db.add(Modality(name="SAMPLE_CT", ae_title="SAMPLECT", host="192.168.0.100", port=104,
                            modality_type="CT", role="both", hospital_id=h.id, allow_receive=True,
                            enabled=True))
            print("  장비 생성: SAMPLE_CT (CT)")

        db.commit()
        print("\n=== 시드 완료 ===")
        print(f"Client 뷰어 로그인 → 병원 ID: {HCODE} · 개별 ID: sample_dr · PW: {PW}")
        print(f"관리자(병원) 로그인 → ID: sample_admin · PW: {PW}")


if __name__ == "__main__":
    main()
