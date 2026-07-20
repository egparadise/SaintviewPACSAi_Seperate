"""13차 — 주석 영속화·CTR(S2)·GSPS·외부AI(F-12)·오더/MWL/MPPS 검증."""
from app.db import SessionLocal
from app.services.study_service import queue_ai_job, register_study
from app.workers.ai_worker import process_once


def _make_study(db, uid: str, *, patient: str, modality: str = "CR", draft: bool = False) -> int:
    study = register_study(
        db,
        study_uid=uid,
        patient_key=patient,
        patient_name="테스트",
        study_date="20260611",
        modality=modality,
        body_part="CHEST",
        study_desc="Chest PA",
        clinical_info="검진",
    )
    if draft:
        queue_ai_job(db, study)
    return study.id


# ── 주석 영속화 (07 A.4) ─────────────────────────────────────


def test_annotations_roundtrip(client, auth_headers):
    with SessionLocal() as db:
        sid = _make_study(db, "1.2.840.999.13.1", patient="P1300")
    items = [
        {"series_uid": "s1", "sop_uid": "i1", "kind": "length",
         "points": [[0.1, 0.2], [0.5, 0.2]], "value": 42.5, "unit": "mm"},
        {"series_uid": "s1", "sop_uid": "i1", "kind": "text",
         "points": [[0.3, 0.7]], "text": "참고 병변"},
    ]
    r = client.put(f"/api/studies/{sid}/annotations", headers=auth_headers, json={"items": items})
    assert r.status_code == 200 and r.json()["count"] == 2

    got = client.get(f"/api/studies/{sid}/annotations", headers=auth_headers).json()["items"]
    assert len(got) == 2
    length = next(a for a in got if a["kind"] == "length")
    assert length["value"] == 42.5 and length["unit"] == "mm"
    assert length["source"] == "user"

    # 전체 교체 의미론
    r = client.put(f"/api/studies/{sid}/annotations", headers=auth_headers, json={"items": []})
    assert client.get(f"/api/studies/{sid}/annotations", headers=auth_headers).json()["items"] == []


# ── S2 자동계측 CTR ──────────────────────────────────────────


def test_ctr_mock_verified(client, auth_headers):
    with SessionLocal() as db:
        sid = _make_study(db, "1.2.840.999.13.2", patient="P1301", modality="CR")
    r = client.post(f"/api/studies/{sid}/ctr", headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["verified"] is True
    assert 0.2 <= body["ctr"] <= 0.95
    assert body["source"] == "mock"
    # AI 계측 주석 2건(cardiac/thoracic) 영속화 + 라벨
    annos = client.get(f"/api/studies/{sid}/annotations", headers=auth_headers).json()["items"]
    ctr_annos = [a for a in annos if a["kind"] == "ctr"]
    assert len(ctr_annos) == 2
    assert all(a["source"] == "ai" and a["verified"] for a in ctr_annos)


def test_ctr_rejects_non_xray(client, auth_headers):
    with SessionLocal() as db:
        sid = _make_study(db, "1.2.840.999.13.3", patient="P1302", modality="MR")
    assert client.post(f"/api/studies/{sid}/ctr", headers=auth_headers).status_code == 409


def test_ctr_numeric_verify():
    from app.rag.ctr import numeric_verify

    ok, _ = numeric_verify({"cardiac": {"x1": 0.3, "x2": 0.7, "y": 0.6},
                            "thoracic": {"x1": 0.1, "x2": 0.9, "y": 0.55}})
    assert ok
    bad, note = numeric_verify({"cardiac": {"x1": 0.7, "x2": 0.3, "y": 0.6},
                                "thoracic": {"x1": 0.1, "x2": 0.9, "y": 0.55}})
    assert not bad and note


# ── GSPS ─────────────────────────────────────────────────────


def test_gsps_build():
    import pydicom

    from app.dicom.gsps import GSPS_SOP_CLASS, build_gsps_dataset, gsps_bytes

    with SessionLocal() as db:
        sid = _make_study(db, "1.2.840.999.13.4", patient="P1303")
        from app.models import Patient, Study

        study = db.get(Study, sid)
        patient = db.get(Patient, study.patient_id)
        ds = build_gsps_dataset(
            study=study, patient=patient,
            images=[{"sop_uid": "i1", "series_uid": "s1", "rows": 512, "cols": 512}],
            annotations=[
                {"sop_uid": "i1", "kind": "length", "points": [[0.1, 0.2], [0.5, 0.2]],
                 "value": 42.5, "unit": "mm"},
                {"sop_uid": "i1", "kind": "ellipse", "points": [[0.2, 0.3], [0.6, 0.5]]},
                {"sop_uid": "i1", "kind": "text", "points": [[0.3, 0.7]], "text": "병변"},
            ],
            wc=40, ww=400, creator="admin",
        )
    assert ds.SOPClassUID == GSPS_SOP_CLASS
    assert ds.Modality == "PR"
    assert ds.StudyInstanceUID == "1.2.840.999.13.4"  # 동일 Study 귀속
    assert len(ds.GraphicAnnotationSequence) == 3
    assert ds.SoftcopyVOILUTSequence[0].WindowWidth == 400.0
    ell = ds.GraphicAnnotationSequence[1].GraphicObjectSequence[0]
    assert ell.GraphicType == "ELLIPSE" and ell.NumberOfGraphicPoints == 4
    # 직렬화 가능 + 재파싱
    import io

    parsed = pydicom.dcmread(io.BytesIO(gsps_bytes(ds)))
    assert parsed.SOPClassUID == GSPS_SOP_CLASS


# ── F-12 외부 AI 결과 병합 ───────────────────────────────────


def test_external_ai_merge(client, auth_headers):
    with SessionLocal() as db:
        sid = _make_study(db, "1.2.840.999.13.5", patient="P1304", draft=True)
    process_once()

    r = client.post(f"/api/studies/{sid}/external-ai", headers=auth_headers, json={
        "vendor": "LunitClone", "model": "cxr-3.0",
        "results": [
            {"label": "Nodule", "observation": "RUL 8mm 결절 의심", "severity": "significant",
             "confidence": 0.91},
        ],
    })
    assert r.status_code == 200, r.text
    sr = r.json()["sr_json"]
    assert any("[외부AI LunitClone]" in f["organ"] for f in sr["findings"])
    assert any("외부 AI" in c for c in sr["ai_meta"]["caveats"])
    assert r.json()["ai_sources"]["external_ai"][0]["vendor"] == "LunitClone"


def test_external_ai_validation_and_critical(client, auth_headers):
    with SessionLocal() as db:
        sid = _make_study(db, "1.2.840.999.13.6", patient="P1305")
    # severity 화이트리스트 위반
    assert client.post(f"/api/studies/{sid}/external-ai", headers=auth_headers, json={
        "vendor": "V", "results": [{"label": "x", "severity": "fatal", "confidence": 0.5}],
    }).status_code == 400
    # confidence 범위 위반
    assert client.post(f"/api/studies/{sid}/external-ai", headers=auth_headers, json={
        "vendor": "V", "results": [{"label": "x", "confidence": 1.5}],
    }).status_code == 400
    # critical → 응급 플래그 + 리포트 없으면 초안 생성
    r = client.post(f"/api/studies/{sid}/external-ai", headers=auth_headers, json={
        "vendor": "V", "results": [{"label": "Pneumothorax", "severity": "critical",
                                    "confidence": 0.95}],
    })
    assert r.status_code == 200 and r.json()["status"] == "draft"
    detail = client.get(f"/api/studies/{sid}", headers=auth_headers).json()
    assert detail["emergency"] is True


# ── 오더 / MWL / MPPS ────────────────────────────────────────


def test_orders_crud_and_mpps_transitions(client, auth_headers):
    r = client.post("/api/orders", headers=auth_headers, json={
        "patient_key": "P1306", "patient_name": "오더환자", "modality": "CT",
        "scheduled_date": "20260612", "procedure_desc": "Chest CT",
    })
    assert r.status_code == 200, r.text
    order = r.json()
    assert order["accession_no"].startswith("SV")  # 자동 채번
    oid = order["id"]

    items = client.get("/api/orders?status=scheduled", headers=auth_headers).json()["items"]
    assert any(o["id"] == oid for o in items)

    # MPPS 전이: scheduled → in_progress → completed
    assert client.put(f"/api/orders/{oid}/status", headers=auth_headers,
                      json={"status": "in_progress"}).status_code == 200
    assert client.put(f"/api/orders/{oid}/status", headers=auth_headers,
                      json={"status": "completed"}).status_code == 200
    # completed 후 전이 불가
    assert client.put(f"/api/orders/{oid}/status", headers=auth_headers,
                      json={"status": "in_progress"}).status_code == 409
    # scheduled → completed 직행 불가
    r2 = client.post("/api/orders", headers=auth_headers, json={"patient_key": "P1307"})
    assert client.put(f"/api/orders/{r2.json()['id']}/status", headers=auth_headers,
                      json={"status": "completed"}).status_code == 409


def test_mwl_export(client, auth_headers, tmp_path):
    import pydicom

    from app.config import get_settings

    client.post("/api/orders", headers=auth_headers, json={
        "patient_key": "P1308", "patient_name": "엠더블유엘", "modality": "CR",
        "scheduled_date": "20260613", "scheduled_time": "0930", "procedure_desc": "Chest PA",
        "station_aet": "CR01",
    })
    get_settings().mwl_dir = str(tmp_path)
    r = client.post("/api/orders/export-mwl", headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["count"] >= 1
    files = list(tmp_path.glob("sv*.wl"))
    assert files
    ds = pydicom.dcmread(files[0])
    assert ds.PatientID
    sps = ds.ScheduledProcedureStepSequence[0]
    assert sps.Modality and sps.ScheduledStationAETitle


# ── 14차: 워크리스트 페이지 탭·검색 폴더 트리 설정 ──────────


def test_worklist_tabs_and_tree_settings(client, auth_headers):
    # 트리 라운드트립 (탐색기형 — 조건 누적 병합은 프론트 책임, 서버는 저장/로밍)
    tree = {"nodes": [{"id": "n1", "label": "응급실", "filter": {"emergency": True},
                       "children": [{"id": "n2", "label": "DR", "filter": {"modality": "DX"},
                                     "children": []}]}]}
    assert client.put("/api/settings/worklist.tree", headers=auth_headers,
                      json={"value": tree, "scope": "user"}).status_code == 200
    got = client.get("/api/settings/worklist.tree", headers=auth_headers).json()["value"]
    assert got["nodes"][0]["children"][0]["filter"]["modality"] == "DX"

    # 탭: 10개 초과 거부 (UBPACS-Z 규격)
    ok_tabs = {"items": [{"id": f"t{i}", "label": f"W{i}", "filter": {}} for i in range(10)]}
    assert client.put("/api/settings/worklist.tabs", headers=auth_headers,
                      json={"value": ok_tabs, "scope": "user"}).status_code == 200
    over = {"items": [{"id": f"t{i}", "label": f"W{i}", "filter": {}} for i in range(11)]}
    assert client.put("/api/settings/worklist.tabs", headers=auth_headers,
                      json={"value": over, "scope": "user"}).status_code == 400


# ── 15차: DICOM 헤더 컬럼·MEMO (UBPACS-Z 조회 확장) ─────────


def test_memo_and_dicom_columns(client, auth_headers):
    with SessionLocal() as db:
        study = register_study(
            db, study_uid="1.2.840.999.15.1", patient_key="P1500", patient_name="컬럼",
            study_date="20260611", modality="CR", body_part="CHEST", study_desc="Chest PA",
            clinical_info="검진", institution="성모병원", referring_physician="Kim^Doctor",
        )
        sid = study.id
    row = client.get("/api/worklist?pid=P1500", headers=auth_headers).json()["items"][0]
    assert row["institution"] == "성모병원"
    assert row["referring_physician"] == "Kim^Doctor"
    assert row["memo"] == ""

    assert client.put(f"/api/studies/{sid}/memo", headers=auth_headers,
                      json={"memo": "추적검사 필요"}).status_code == 200
    row2 = client.get("/api/worklist?pid=P1500", headers=auth_headers).json()["items"][0]
    assert row2["memo"] == "추적검사 필요"


# ── 16차: 상용구 DB·판독 서명·오더 폼·DICOM 노드 ────────────


def test_phrases_crud_and_shortcut(client, auth_headers):
    r = client.post("/api/phrases", headers=auth_headers, json={
        "name": "정상 흉부", "text": "No active lung lesion.", "modality": "CR",
        "body_part": "CHEST", "shortcut": "1",
    })
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    assert r.json()["category"] == "CR-CHEST"

    # 단축키 중복 거부
    assert client.post("/api/phrases", headers=auth_headers, json={
        "name": "x", "text": "y", "shortcut": "1",
    }).status_code == 409
    # 단축키 2글자 거부
    assert client.post("/api/phrases", headers=auth_headers, json={
        "name": "x", "text": "y", "shortcut": "AB",
    }).status_code == 400

    items = client.get("/api/phrases", headers=auth_headers).json()["items"]
    assert any(p["id"] == pid for p in items)
    assert client.put(f"/api/phrases/{pid}", headers=auth_headers, json={
        "name": "정상 흉부", "text": "Unremarkable.", "shortcut": "1",
    }).status_code == 200
    assert client.delete(f"/api/phrases/{pid}", headers=auth_headers).status_code == 200


def test_phrase_template_kind(client, auth_headers):
    # 템플릿(kind=template) — 판독/결론 분리 본문, 단축키 없음
    r = client.post("/api/phrases", headers=auth_headers, json={
        "name": "흉부 정상 템플릿", "kind": "template", "modality": "CR",
        "reading_text": "Both lungs are clear.", "text": "No active lung lesion.",
    })
    assert r.status_code == 200, r.text
    assert r.json()["kind"] == "template"
    assert r.json()["reading_text"] == "Both lungs are clear."
    assert r.json()["shortcut"] == ""  # 템플릿은 단축키 없음
    # 판독/결론 둘 다 비면 400
    assert client.post("/api/phrases", headers=auth_headers, json={
        "name": "x", "kind": "template",
    }).status_code == 400
    client.delete(f"/api/phrases/{r.json()['id']}", headers=auth_headers)


def test_profile_and_finalize_signature(client, auth_headers):
    # 판독의 등록 (설정 > Reading)
    assert client.put("/api/auth/profile", headers=auth_headers,
                      json={"display_name": "홍길동", "license_no": "12345"}).status_code == 200
    prof = client.get("/api/auth/profile", headers=auth_headers).json()
    assert prof["display_name"] == "홍길동" and prof["license_no"] == "12345"

    # 확정 시 서명(이름·면허번호) 기록
    with SessionLocal() as db:
        sid = _make_study(db, "1.2.840.999.16.1", patient="P1600", draft=True)
    process_once()
    rid = client.get(f"/api/studies/{sid}/reports", headers=auth_headers).json()["items"][0]["id"]
    r = client.post(f"/api/reports/{rid}/finalize", headers=auth_headers)
    assert r.status_code == 200
    sig = r.json()["diff_metrics"]["signature"]
    assert sig["name"] == "홍길동" and sig["license_no"] == "12345"


def test_order_form_fields_and_mwl_tags(client, auth_headers, tmp_path):
    import pydicom

    from app.config import get_settings

    r = client.post("/api/orders", headers=auth_headers, json={
        "patient_key": "P1601", "patient_name": "HONG^GILDONG", "modality": "CR",
        "scheduled_date": "20260614", "procedure_desc": "Chest PA",
        "body_part": "CHEST", "projection": "PA",
    })
    assert r.status_code == 200, r.text
    o = r.json()
    assert o["dicom_study_id"].startswith("S")  # StudyID 자동 채번
    assert o["body_part"] == "CHEST" and o["projection"] == "PA"

    get_settings().mwl_dir = str(tmp_path)
    client.post("/api/orders/export-mwl", headers=auth_headers)
    found = list(tmp_path.glob("sv*.wl"))
    assert found
    # 본 오더의 .wl에서 PN·StudyID·BodyPart 확인 (export는 scheduled 전체를 내보냄)
    for f in found:
        d = pydicom.dcmread(f)
        if d.AccessionNumber == o["accession_no"]:
            assert str(d.PatientName) == "HONG^GILDONG"
            assert d.StudyID == o["dicom_study_id"]
            assert d.ScheduledProcedureStepSequence[0].BodyPartExamined == "CHEST"
            break
    else:
        raise AssertionError("오더 .wl 미발견")


def test_stt_engine_guards(client, auth_headers):
    # 기본(browser) — 서버 STT 비활성 안내
    r = client.post("/api/stt", headers=auth_headers,
                    files={"audio": ("a.webm", b"x" * 10, "audio/webm")})
    assert r.status_code == 400
    # whisper_local 선택 + 라이브러리 미설치 → 501 설치 안내 (폴백 무중단)
    client.put("/api/settings/ai.policy", headers=auth_headers,
               json={"value": {"auto_generate": True, "stt_engine": "whisper_local"}, "scope": "global"})
    r2 = client.post("/api/stt", headers=auth_headers,
                     files={"audio": ("a.webm", b"x" * 10, "audio/webm")})
    assert r2.status_code in (200, 501)  # 설치돼 있으면 200, 아니면 설치 안내
    # 원복
    client.put("/api/settings/ai.policy", headers=auth_headers,
               json={"value": {"auto_generate": True, "stt_engine": "browser"}, "scope": "global"})


def test_report_prefs_setting(client, auth_headers):
    assert client.put("/api/settings/report.prefs", headers=auth_headers,
                      json={"value": {"ai_panel": True, "auto_apply": False}, "scope": "user"}).status_code == 200
    got = client.get("/api/settings/report.prefs", headers=auth_headers).json()["value"]
    assert got["auto_apply"] is False


def test_viewer_hp_setting(client, auth_headers):
    rules = {"rules": [{"id": "hp1", "name": "흉부 CR 정면", "modality": "CR",
                        "body_part": "CHEST", "projection": "PA",
                        "s": {"r": 1, "c": 1}, "i": {"r": 1, "c": 1}, "wl": "-600,1500"}]}
    assert client.put("/api/settings/viewer.hp", headers=auth_headers,
                      json={"value": rules, "scope": "user"}).status_code == 200
    got = client.get("/api/settings/viewer.hp", headers=auth_headers).json()["value"]
    assert got["rules"][0]["name"] == "흉부 CR 정면"


def test_dicom_nodes_global_only(client, auth_headers):
    nodes = {"items": [{"name": "CR01", "role": "scu", "ae_title": "CR01", "ip": "192.168.0.10", "port": 104}]}
    assert client.put("/api/settings/dicom.nodes", headers=auth_headers,
                      json={"value": nodes, "scope": "user"}).status_code == 400
    assert client.put("/api/settings/dicom.nodes", headers=auth_headers,
                      json={"value": nodes, "scope": "global"}).status_code == 200
    got = client.get("/api/settings/dicom.nodes", headers=auth_headers).json()["value"]
    assert got["items"][0]["ae_title"] == "CR01"


# ── 17차: 북마크·부서/AET·ORDER NAME 컬럼 ───────────────────


def test_bookmark_and_order_name_columns(client, auth_headers):
    with SessionLocal() as db:
        study = register_study(
            db, study_uid="1.2.840.999.17.1", patient_key="P1700", patient_name="컬럼2",
            study_date="20260611", modality="CR", body_part="CHEST", study_desc="Chest PA",
            accession_no="ACC1700", department="영상의학과", source_aet="CR01",
        )
        sid = study.id
    # 같은 accession의 오더 → ORDER NAME 매칭
    client.post("/api/orders", headers=auth_headers, json={
        "patient_key": "P1700", "accession_no": "ACC1700", "modality": "CR",
        "procedure_desc": "흉부 정면 촬영",
    })
    row = client.get("/api/worklist?pid=P1700", headers=auth_headers).json()["items"][0]
    assert row["department"] == "영상의학과"
    assert row["source_aet"] == "CR01"
    assert row["order_name"] == "흉부 정면 촬영"
    assert row["bookmark"] is False

    assert client.put(f"/api/studies/{sid}/bookmark", headers=auth_headers,
                      json={"bookmark": True}).status_code == 200
    row2 = client.get("/api/worklist?pid=P1700", headers=auth_headers).json()["items"][0]
    assert row2["bookmark"] is True


# ── 29차: 서버 네트워크 — 폴더 공유·DB 테스트 ───────────────


def test_server_network_share(client, auth_headers, tmp_path):
    # 미설정 시 안내
    client.put("/api/settings/server.network", headers=auth_headers,
               json={"value": {}, "scope": "global"})
    assert client.get("/api/share", headers=auth_headers).status_code == 404

    # 디렉토리 설정 → 목록/다운로드 (path traversal 차단)
    (tmp_path / "hello.txt").write_text("share-me", encoding="utf-8")
    assert client.put("/api/settings/server.network", headers=auth_headers,
                      json={"value": {"local_share_dir": str(tmp_path),
                                      "web": {"ip": "127.0.0.1", "port": 8000, "ae_title": "SAINTVIEW"}},
                            "scope": "global"}).status_code == 200
    # user scope 거부(전역 전용)
    assert client.put("/api/settings/server.network", headers=auth_headers,
                      json={"value": {}, "scope": "user"}).status_code == 400

    r = client.get("/api/share", headers=auth_headers)
    assert r.status_code == 200
    assert any(f["name"] == "hello.txt" for f in r.json()["items"])
    dl = client.get("/api/share/file?name=hello.txt", headers=auth_headers)
    assert dl.status_code == 200 and dl.content == b"share-me"
    assert client.get("/api/share/file?name=..%2F..%2Fsecret", headers=auth_headers).status_code in (400, 404)


def test_net_db_test(client, auth_headers):
    r = client.post("/api/admin/net-test/db", headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["ok"] is True
    assert "latency_ms" in r.json()


# ── 번인 OCR 가드 — 폴백 무중단 ─────────────────────────────


def test_image_guard_ocr_fallback():
    import io

    from PIL import Image

    from app.rag.image_guard import mask_burn_in

    img = Image.new("RGB", (200, 200), (120, 120, 120))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    out = mask_burn_in(buf.getvalue())  # pytesseract 유무와 무관하게 동작해야 함
    masked = Image.open(io.BytesIO(out))
    assert masked.getpixel((100, 5)) == (0, 0, 0)      # 상단 스트립
    assert masked.getpixel((100, 195)) == (0, 0, 0)    # 하단 스트립
