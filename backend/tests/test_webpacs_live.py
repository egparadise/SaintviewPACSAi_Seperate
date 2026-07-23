"""WebPACS Live(직결) 테스트 — 모의 A 서버(실 uvicorn 스레드)로 전 구간 검증.

복사 없는 직결 계약: 워크리스트(vid)·상세·series-tree(기하)·rendered(서버 윈도잉)·
판독 왕복(R/A + RI 선점 409)·주석 왕복·presence(하트비트/state).
"""
from __future__ import annotations

import socket
import sys
import threading
import time
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "harness"))

from mock_webpacs_api import build_app  # noqa: E402

from app.services.webpacs_live import VID_BASE  # noqa: E402


@pytest.fixture(scope="module")
def mock_remote():
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
    assert server.started
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    t.join(timeout=5)


@pytest.fixture(scope="module")
def live_ready(mock_remote):
    """브리지 설정을 모의 A 로 지정(모듈 전체 공유). TestClient/auth 는 함수 픽스처라
    모듈 픽스처에서 못 쓰므로 여기서 직접 로그인해 설정한다."""
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        r = c.post("/api/auth/login", json={"username": "admin", "password": "admin1234"})
        headers = {"Authorization": f"Bearer {r.json()['token']}"}
        r = c.put("/api/webpacs/config", headers=headers, json={"value": {
            "enabled": True, "base_url": mock_remote,
            "user_id": "webpacs", "password": "webpacs1234",
        }})
        assert r.status_code == 200
    return mock_remote


VID1 = VID_BASE + 1
VID2 = VID_BASE + 2


def test_live_worklist_vids(client, auth_headers, live_ready):
    r = client.get("/api/webpacs/live/worklist", headers=auth_headers)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["total"] == 2
    ids = [i["id"] for i in data["items"]]
    assert ids == [VID2, VID1]   # 최신순(study_idx desc)
    row = data["items"][1]
    assert row["patient_key"] == "WPX0001"
    assert row["read_state"] == "unread" and row["status"] == "received"
    assert row["source_aet"] == "WEBPACS-LIVE"
    assert row["study_date"] == "20260723" and row["study_time"] == "120000"


def test_live_detail_and_tree(client, auth_headers, live_ready):
    r = client.get(f"/api/webpacs/live/studies/{VID1}", headers=auth_headers)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["id"] == VID1 and d["patient_key"] == "WPX0001"
    assert isinstance(d["related_exams"], list)

    r = client.get(f"/api/webpacs/live/studies/{VID1}/series-tree", headers=auth_headers)
    assert r.status_code == 200, r.text
    tree = r.json()
    assert tree["study_uid"] == d["study_uid"]
    assert len(tree["series"]) == 1
    insts = tree["series"][0]["instances"]
    assert len(insts) == 3
    assert insts[0]["rows"] == 64 and insts[0]["cols"] == 64   # v2 metadata 기하
    assert insts[0]["preview_url"].startswith("/api/webpacs/live/thumb/")
    assert [i["instance_number"] for i in insts] == [1, 2, 3]

    # instances(키이미지 UI 계약)
    r = client.get(f"/api/webpacs/live/studies/{VID1}/instances", headers=auth_headers)
    assert r.status_code == 200 and len(r.json()["items"]) == 3


def test_live_rendered_and_thumb(client, auth_headers, live_ready):
    tree = client.get(f"/api/webpacs/live/studies/{VID1}/series-tree",
                      headers=auth_headers).json()
    s = tree["series"][0]
    sop = s["instances"][0]["sop_uid"]
    url = (f"/api/webpacs/live/dicom-web/studies/{tree['study_uid']}"
           f"/series/{s['series_uid']}/instances/{sop}/rendered")
    r = client.get(url, params={"window": "500,1000,linear"})   # 무인증(<img> 계약)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "image/png"
    assert r.content[:8] == b"\x89PNG\r\n\x1a\n"
    # JPEG 형식 파라미터
    r = client.get(url, params={"accept": "image/jpeg", "quality": 80})
    assert r.status_code == 200 and r.content[:2] == b"\xff\xd8"
    # 썸네일
    r = client.get(s["instances"][0]["preview_url"])
    assert r.status_code == 200 and r.headers["content-type"].startswith("image/")


def test_live_report_roundtrip_and_finalize(client, auth_headers, live_ready):
    # 빈 초안(합성) — A 에 리포트 없음
    r = client.get(f"/api/webpacs/live/studies/{VID2}/reports", headers=auth_headers)
    assert r.status_code == 200
    rep = r.json()["items"][0]
    assert rep["status"] == "draft" and rep["id"] == VID2

    # 저장(R) — dock 계약: PUT /reports/{id} {sr_json}
    sr = {"findings": [{"organ": "판독", "observation": "폐야 청명", "severity": "normal"}],
          "impression": [{"rank": 1, "statement": "정상 소견", "confidence": "high"}]}
    r = client.put(f"/api/webpacs/live/reports/{VID2}", headers=auth_headers,
                   json={"sr_json": sr})
    assert r.status_code == 200, r.text
    saved = r.json()
    assert saved["status"] == "in_review"
    assert "폐야 청명" in saved["narrative_text"]
    assert saved["sr_json"]["impression"][0]["statement"] == "정상 소견"

    # A DB(모의) 반영 확인 — 워크리스트 행 read_state=read, 임프레션 미리보기
    r = client.get("/api/webpacs/live/worklist", headers=auth_headers)
    row = next(i for i in r.json()["items"] if i["id"] == VID2)
    assert row["read_state"] == "read"
    assert row["impression_preview"] == "정상 소견"

    # 승인(A)
    r = client.post(f"/api/webpacs/live/reports/{VID2}/finalize", headers=auth_headers)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "finalized"
    r = client.get(f"/api/webpacs/live/studies/{VID2}/state", headers=auth_headers)
    st = r.json()
    assert st["study_status"] == "A" and st["read_state"] == "fixed" and st["report_locked"]


def test_live_claim_conflict_409(client, auth_headers, live_ready, mock_remote):
    # 타 판독의 선점 재현 → 저장/선점 409 + 사용자 메시지
    with httpx.Client(base_url=mock_remote) as raw:
        raw.post("/__test__/claim-as-other/1")
    r = client.post(f"/api/webpacs/live/studies/{VID1}/claim", headers=auth_headers)
    assert r.status_code == 409
    assert "다른 판독의" in r.json()["detail"]
    r = client.put(f"/api/webpacs/live/reports/{VID1}", headers=auth_headers,
                   json={"sr_json": {"findings": [], "impression": [{"statement": "x"}]}})
    assert r.status_code == 409
    # presence — 워크리스트 행이 작성중(✍)+판독의 표시
    r = client.get("/api/webpacs/live/worklist", headers=auth_headers)
    row = next(i for i in r.json()["items"] if i["id"] == VID1)
    assert row["read_state"] == "reading"
    assert "Mock Doctor 999" in row["memo"]


def test_live_annotations_and_presentation(client, auth_headers, live_ready):
    items = [{"series_uid": "s", "sop_uid": "i", "kind": "len",
              "points": [[0.1, 0.2], [0.3, 0.4]], "value": 12.5, "unit": "mm",
              "text": "", "source": "user"}]
    r = client.put(f"/api/webpacs/live/studies/{VID2}/annotations", headers=auth_headers,
                   json={"items": items})
    assert r.status_code == 200 and r.json()["count"] == 1
    r = client.get(f"/api/webpacs/live/studies/{VID2}/annotations", headers=auth_headers)
    assert r.json()["items"][0]["value"] == 12.5

    r = client.put(f"/api/webpacs/live/studies/{VID2}/presentation", headers=auth_headers,
                   json={"series": {"1.2.3": {"wl": [40, 400], "invert": True}}})
    assert r.status_code == 200
    r = client.get(f"/api/webpacs/live/studies/{VID2}/presentation", headers=auth_headers)
    assert r.json()["series"]["1.2.3"]["invert"] is True


def test_live_heartbeat_presence(client, auth_headers, live_ready):
    r = client.post("/api/webpacs/live/heartbeat", headers=auth_headers,
                    json={"study_ids": [VID2], "kind": "viewer", "typing": False})
    assert r.status_code == 200
    r = client.get(f"/api/webpacs/live/studies/{VID2}/state", headers=auth_headers)
    assert "admin" in r.json()["viewers"]


def test_live_empty_approve_blocked(client, auth_headers, live_ready):
    """빈 판독 승인 차단(적대검증 #3) — 합성 빈 초안이 A 에 승인으로 나가지 않게."""
    # study 1 은 이미 앞 테스트에서 판독 저장됨 — 새로운 미판독 검사가 없으므로
    # finalize-with 에 빈 sr 을 명시적으로 넘겨 검증
    r = client.post(f"/api/webpacs/live/reports/{VID2}/finalize-with", headers=auth_headers,
                    json={"sr_json": {"findings": [], "impression": [{"statement": ""}]}})
    assert r.status_code == 409
    assert "빈 판독" in r.json()["detail"]


def test_live_bad_uid_rejected(client, live_ready):
    """UID 인젝션 차단(적대검증 #7) — ?/ 등으로 원본 인스턴스 노출 방지."""
    r = client.get("/api/webpacs/live/thumb/1.2.3/1.2.3/1.2.3%3Ffoo")
    assert r.status_code == 400
    r = client.get("/api/webpacs/live/dicom-web/studies/bad-uid/series/1.2/instances/1.2/rendered")
    assert r.status_code == 400


def test_live_claim_bad_vid_not_500(client, auth_headers, live_ready):
    """vid 경계(적대검증 #6) — 로컬 id 로 claim 시 500 이 아니라 502(WebPacsError)."""
    r = client.post("/api/webpacs/live/studies/1/claim", headers=auth_headers)
    assert r.status_code == 502   # to_remote_idx → WebPacsError → 502 (500 아님)
