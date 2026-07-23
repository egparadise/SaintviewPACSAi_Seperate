"""WebPACS 브리지 테스트 — 모의 webpacs_api(실 uvicorn 스레드) + 가짜 Orthanc.

인계 서버 계약(로그인/워크리스트/series/viewer/DICOMweb v2 인스턴스)을 재현한
harness/mock_webpacs_api.build_app 을 임시 포트로 띄워 브리지 전 구간을 검증한다.
(httpx 동기 Client 는 ASGITransport 를 못 쓰므로 실 HTTP 서버로 검증 — 실전과 동일 스택)
"""
from __future__ import annotations

import io
import socket
import sys
import threading
import time
from pathlib import Path

import httpx
import pytest
from pydicom import dcmread

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "harness"))

from mock_webpacs_api import build_app  # noqa: E402

from app.services import webpacs_bridge as wb  # noqa: E402


@pytest.fixture(scope="module")
def mock_remote():
    """모의 원격 서버(검사 2건 × 3장)를 임시 포트 uvicorn 스레드로 기동."""
    import uvicorn

    app = build_app(num_studies=2, instances_per_study=3)
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    for _ in range(200):
        if server.started:
            break
        time.sleep(0.05)
    assert server.started, "모의 webpacs 서버 기동 실패"
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    t.join(timeout=5)


def _client(base_url: str) -> wb.WebPacsClient:
    return wb.WebPacsClient(base_url, "webpacs", "webpacs1234")


class FakeOrthanc:
    """가짜 Orthanc — 업로드 기록 + 마지막 검사 메타 응답(브리지 등록 경로용)."""

    uploaded: list = []

    def __init__(self, *a, **kw):
        pass

    def alive(self) -> bool:
        return True

    def upload_dicom(self, data: bytes) -> dict:
        ds = dcmread(io.BytesIO(data), force=True)
        FakeOrthanc.uploaded.append(ds)
        return {"ParentStudy": f"fake-{str(ds.StudyInstanceUID)[-8:]}", "Status": "Success"}

    def study_metadata(self, sid: str) -> dict:
        ds = FakeOrthanc.uploaded[-1]
        return {
            "MainDicomTags": {
                "StudyInstanceUID": str(ds.StudyInstanceUID),
                "AccessionNumber": str(getattr(ds, "AccessionNumber", "")),
                "StudyDate": str(getattr(ds, "StudyDate", "")),
                "StudyTime": str(getattr(ds, "StudyTime", "")),
                "StudyDescription": str(getattr(ds, "StudyDescription", "")),
                "ModalitiesInStudy": "CT",
            },
            "PatientMainDicomTags": {
                "PatientID": str(getattr(ds, "PatientID", "")),
                "PatientName": str(getattr(ds, "PatientName", "")),
                "PatientBirthDate": str(getattr(ds, "PatientBirthDate", "")),
                "PatientSex": str(getattr(ds, "PatientSex", "")),
            },
        }

    def close(self) -> None:
        pass


def test_client_login_list_detail(mock_remote):
    c = _client(mock_remote)
    try:
        rows = c.list_studies({"limit": "10"})
        assert len(rows) == 2
        assert rows[0]["study_instance_uid"]
        assert c.study_count() == 2
        detail = c.study_detail(1)
        assert detail["patient_id"] == "WPX0001"
        series = c.series_viewer(1)
        assert len(series) == 1 and len(series[0]["images"]) == 3
        # DICOMweb v2 인스턴스 — 표준 DICOM 파싱 가능해야 한다
        img = series[0]["images"][0]
        data = c.instance_dicom(series[0]["study_instance_uid"],
                                series[0]["series_instance_uid"], img["sop_instance_uid"])
        ds = dcmread(io.BytesIO(data), force=True)
        assert str(ds.SOPInstanceUID) == img["sop_instance_uid"]
    finally:
        c.close()


def test_client_relogin_on_401(mock_remote):
    """토큰 무효화(만료 재현) 후 호출 → 1회 재로그인으로 자동 복구."""
    c = _client(mock_remote)
    try:
        c.list_studies()
        with httpx.Client(base_url=mock_remote) as raw:
            raw.post("/__test__/expire-token")
            before = raw.get("/__test__/state").json()["logins"]
        rows = c.list_studies()
        assert len(rows) == 2
        with httpx.Client(base_url=mock_remote) as raw:
            assert raw.get("/__test__/state").json()["logins"] == before + 1
    finally:
        c.close()


def test_login_failure_raises(mock_remote):
    c = wb.WebPacsClient(mock_remote, "webpacs", "wrong-pw")
    try:
        with pytest.raises(wb.WebPacsError):
            c.login()
    finally:
        c.close()


def test_import_study_registers_worklist(db, mock_remote, monkeypatch):
    """가져오기 전 구간 — 원격 다운로드 → (가짜)Orthanc 업로드 → 워크리스트 등록."""
    FakeOrthanc.uploaded = []
    monkeypatch.setattr("app.dicom.orthanc.OrthancClient", FakeOrthanc)

    cfg = {"base_url": mock_remote, "user_id": "webpacs",
           "password": "webpacs1234", "verify_ssl": True, "hospital_id": 0}
    result = wb.import_study(db, cfg, 1)
    assert result["status"] == "done"
    assert result["total"] == 3 and result["done"] == 3 and result["failed"] == 0
    assert result["study_id"]
    assert len(FakeOrthanc.uploaded) == 3

    from app.models import Study

    st = db.get(Study, result["study_id"])
    assert st is not None
    assert st.study_uid == result["study_uid"]
    assert st.source_aet == "WEBPACS"

    # 멱등 — 같은 검사 재가져오기는 exists (재다운로드 없음)
    FakeOrthanc.uploaded = []
    again = wb.import_study(db, cfg, 1)
    assert again["status"] == "exists"
    assert again["study_id"] == result["study_id"]
    assert len(FakeOrthanc.uploaded) == 0

    # 진행 상태 레지스트리
    job = wb.get_import_job(1)
    assert job and job["status"] == "exists"


def test_webpacs_api_config_and_studies(client, auth_headers, mock_remote):
    """API 레인 — 설정 마스킹 왕복, 원격 목록 프록시, 비활성 409."""
    # 비활성 상태 → 409
    r = client.put("/api/webpacs/config", headers=auth_headers,
                   json={"value": {"enabled": False}})
    assert r.status_code == 200
    r = client.get("/api/webpacs/studies", headers=auth_headers)
    assert r.status_code == 409

    # 설정 저장 — 비밀번호는 응답에서 마스킹
    r = client.put("/api/webpacs/config", headers=auth_headers, json={"value": {
        "enabled": True, "base_url": mock_remote,
        "user_id": "webpacs", "password": "webpacs1234",
    }})
    assert r.status_code == 200
    body = r.json()["value"]
    assert body["has_password"] is True and "password" not in body

    # 빈 비밀번호로 재저장 → 기존 비밀번호 유지
    r = client.put("/api/webpacs/config", headers=auth_headers, json={"value": {
        "enabled": True, "password": "",
    }})
    assert r.json()["value"]["has_password"] is True

    r = client.get("/api/webpacs/config", headers=auth_headers)
    assert r.status_code == 200 and "password" not in r.json()["value"]

    # 원격 목록 프록시 — 실제 설정값(base_url)으로 모의 서버 조회
    r = client.get("/api/webpacs/studies", headers=auth_headers)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["total"] == 2 and len(data["items"]) == 2
    # 앞 테스트에서 study 1을 가져왔으므로 로컬 매핑이 채워지고, study 2는 미보유
    assert data["items"][0]["imported_study_id"] is not None
    assert data["items"][1]["imported_study_id"] is None
    assert data["items"][0]["patient_id"].startswith("WPX")

    # 검색 매핑 — patient_id 필터
    r = client.get("/api/webpacs/studies", headers=auth_headers,
                   params={"patient_id": "WPX0002"})
    assert r.status_code == 200
    assert [i["study_idx"] for i in r.json()["items"]] == [2]


def test_webpacs_api_import_endpoint(client, auth_headers, mock_remote, monkeypatch):
    """가져오기 엔드포인트 — 시작 → (TestClient 는 배경작업 동기 실행) → 상태/멱등."""
    FakeOrthanc.uploaded = []
    monkeypatch.setattr("app.dicom.orthanc.OrthancClient", FakeOrthanc)

    r = client.put("/api/webpacs/config", headers=auth_headers, json={"value": {
        "enabled": True, "base_url": mock_remote,
        "user_id": "webpacs", "password": "webpacs1234",
    }})
    assert r.status_code == 200

    r = client.post("/api/webpacs/import/2", headers=auth_headers)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "started"

    # TestClient 는 응답 직후 BackgroundTasks 를 동기 실행 — 상태 폴링은 즉시 완료 상태
    r = client.get("/api/webpacs/import/2/status", headers=auth_headers)
    assert r.status_code == 200
    st = r.json()
    assert st["status"] == "done", st
    assert st["study_id"]

    # 재시도 → 이미 보유(exists)
    r = client.post("/api/webpacs/import/2", headers=auth_headers)
    assert r.json()["status"] == "exists"
    assert r.json()["study_id"] == st["study_id"]

    # 워크리스트에 노출 확인
    r = client.get("/api/worklist", headers=auth_headers, params={"pid": "WPX0002"})
    assert r.status_code == 200
    items = r.json()["items"]
    assert any(i["id"] == st["study_id"] for i in items)
