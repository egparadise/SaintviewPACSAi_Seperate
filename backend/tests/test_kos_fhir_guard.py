"""4차: KOS·FHIR·이미지 가드 검증."""
import io

from app.db import SessionLocal
from app.services.study_service import queue_ai_job, register_study
from app.workers.ai_worker import process_once


def test_kos_dataset_structure(db):
    """KOS가 동일 Study 귀속 + 참조 무결성(Evidence)을 갖는지."""
    from app.dicom.kos import build_kos_dataset
    from app.models import Patient, Study

    study = register_study(
        db, study_uid="1.2.840.999.9.1", patient_key="P900", patient_name="김영희",
        study_date="20260611", modality="CT", body_part="CHEST", study_desc="CT",
    )
    patient = db.get(Patient, study.patient_id)
    ds = build_kos_dataset(
        study=study, patient=patient,
        key_images=[
            {"sop_uid": "1.2.3.1", "sop_class_uid": "1.2.840.10008.5.1.4.1.1.2", "series_uid": "1.2.3"},
            {"sop_uid": "1.2.3.2", "sop_class_uid": "1.2.840.10008.5.1.4.1.1.2", "series_uid": "1.2.3"},
        ],
    )
    assert ds.Modality == "KO"
    assert ds.SOPClassUID == "1.2.840.10008.5.1.4.1.1.88.59"
    assert ds.StudyInstanceUID == "1.2.840.999.9.1"
    assert ds.ConceptNameCodeSequence[0].CodeValue == "113000"
    assert len(ds.ContentSequence) == 2
    ev = ds.CurrentRequestedProcedureEvidenceSequence[0]
    assert ev.StudyInstanceUID == "1.2.840.999.9.1"
    refs = ev.ReferencedSeriesSequence[0].ReferencedSOPSequence
    assert {r.ReferencedSOPInstanceUID for r in refs} == {"1.2.3.1", "1.2.3.2"}


def test_key_images_api_and_kos_guard(client, auth_headers):
    with SessionLocal() as db:
        study = register_study(
            db, study_uid="1.2.840.999.9.2", patient_key="P901", patient_name="이철수",
            study_date="20260611", modality="CT", body_part="CHEST", study_desc="CT",
        )
        sid = study.id
    r = client.put(f"/api/studies/{sid}/key-images", headers=auth_headers,
                   json={"items": [{"sop_uid": "1.1", "orthanc_id": "x", "instance_number": 1}]})
    assert r.status_code == 200
    # 선택 없는 검사의 KOS 전송은 409
    with SessionLocal() as db:
        empty = register_study(
            db, study_uid="1.2.840.999.9.3", patient_key="P902", patient_name="박민수",
            study_date="20260611", modality="CT", body_part="CHEST", study_desc="CT",
        )
        eid = empty.id
    assert client.post(f"/api/studies/{eid}/send-kos", headers=auth_headers).status_code == 409


def test_fhir_export(client, auth_headers):
    with SessionLocal() as db:
        study = register_study(
            db, study_uid="1.2.840.999.9.4", patient_key="P903", patient_name="홍길동",
            study_date="20260611", study_time="120000", modality="CT", body_part="CHEST",
            study_desc="CT Chest", clinical_info="검진",
        )
        queue_ai_job(db, study)
        sid = study.id
    while process_once():  # 큐 잔여 작업까지 모두 처리 (테스트 격리)
        pass
    reports = client.get(f"/api/studies/{sid}/reports", headers=auth_headers).json()["items"]
    rid = reports[0]["id"]
    client.post(f"/api/reports/{rid}/finalize", headers=auth_headers)

    r = client.get(f"/api/reports/{rid}/export?format=fhir", headers=auth_headers)
    assert r.status_code == 200
    assert "fhir" in r.headers["content-type"]
    body = r.json()
    assert body["resourceType"] == "DiagnosticReport"
    assert body["status"] == "final"
    assert body["code"]["coding"][0]["code"] == "18748-4"
    assert body["imagingStudy"][0]["identifier"]["value"].endswith("1.2.840.999.9.4")
    assert body["conclusion"]
    assert body["extension"][0]["valueBoolean"] is True  # AI 생성 표시
    assert body["effectiveDateTime"].startswith("2026-06-11T12:00:00")


def test_image_guard_masks_strips():
    """상·하단 스트립이 검정으로 마스킹되고 중앙은 보존되는지."""
    from PIL import Image

    from app.rag.image_guard import mask_burn_in

    src = Image.new("RGB", (100, 100), (255, 255, 255))
    buf = io.BytesIO()
    src.save(buf, format="PNG")

    out = Image.open(io.BytesIO(mask_burn_in(buf.getvalue())))
    assert out.getpixel((50, 2)) == (0, 0, 0)      # 상단 마스킹
    assert out.getpixel((50, 98)) == (0, 0, 0)     # 하단 마스킹
    assert out.getpixel((50, 50)) == (255, 255, 255)  # 중앙 보존
