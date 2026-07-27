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

    app = build_app(num_studies=3, instances_per_study=3)
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
VID3 = VID_BASE + 3


def test_live_worklist_vids(client, auth_headers, live_ready):
    r = client.get("/api/webpacs/live/worklist", headers=auth_headers)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["total"] == 3
    ids = [i["id"] for i in data["items"]]
    assert ids == [VID3, VID2, VID1]   # 최신순(study_idx desc)
    row = next(i for i in data["items"] if i["id"] == VID1)
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


def test_live_prefetch_and_decode_cache(client, auth_headers, live_ready):
    """속도 개선: 프리페치(병렬 원본 예열) + 디코드 캐시(재요청 디코드 생략)."""
    import time as _t

    from app.services import webpacs_live as wl

    # 프리페치 킥 — 백그라운드(TestClient 는 동기 실행)로 원본 디스크 캐시 예열
    r = client.post(f"/api/webpacs/live/studies/{VID1}/prefetch", headers=auth_headers)
    assert r.status_code == 200 and r.json()["started"]

    tree = client.get(f"/api/webpacs/live/studies/{VID1}/series-tree",
                      headers=auth_headers).json()
    s = tree["series"][0]
    sop = s["instances"][0]["sop_uid"]
    url = (f"/api/webpacs/live/dicom-web/studies/{tree['study_uid']}"
           f"/series/{s['series_uid']}/instances/{sop}/rendered")
    # 디코드 캐시 초기화 후 첫 렌더(디코드 발생) vs 둘째(캐시 히트) 시간 비교
    with wl._DECODE_LOCK:
        wl._DECODE_CACHE.clear()
    t0 = _t.perf_counter()
    r1 = client.get(url, params={"window": "40,400"})
    t1 = _t.perf_counter()
    r2 = client.get(url, params={"window": "80,500"})   # 다른 W/L — 디코드는 캐시, 윈도잉만
    t2 = _t.perf_counter()
    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.content[:8] == b"\x89PNG\r\n\x1a\n"
    # 캐시 히트(둘째)가 첫 요청보다 느리지 않아야(윈도잉만) — 디코드 캐시 동작 확인
    assert (t2 - t1) <= (t1 - t0) + 0.05
    # sop 가 디코드 캐시에 적재됨
    assert sop in wl._DECODE_CACHE
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


# ─────────────── 요구4·6: per-user A 로그인 + 실제 판독의 귀속 ───────────────
def test_webpacs_login_per_user(client, live_ready):
    """요구4: 원격 PACS(A) 계정으로 직접 로그인 → 그 사용자의 A 세션."""
    r = client.post("/api/auth/webpacs-login",
                    json={"user_id": "dr_kim", "user_passwd": "kim1234"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["a_user_name"] == "김판독" and body["a_user_idx"] == 11
    assert body["role"] == "doctor"   # group_level 50 → 판독의
    # 잘못된 비번은 401
    r = client.post("/api/auth/webpacs-login",
                    json={"user_id": "dr_kim", "user_passwd": "wrong"})
    assert r.status_code == 401


def test_live_report_attribution(client, live_ready):
    """요구6: 판독이 실제 판독의(A 계정) 이름으로 A DB 에 기록."""
    # dr_lee 로 A 로그인 → 그 세션으로 판독 저장
    r = client.post("/api/auth/webpacs-login",
                    json={"user_id": "dr_lee", "user_passwd": "lee1234"})
    tok = {"Authorization": f"Bearer {r.json()['token']}"}
    sr = {"findings": [{"organ": "판독", "observation": "정상"}],
          "impression": [{"statement": "정상 소견"}]}
    r = client.put(f"/api/webpacs/live/reports/{VID3}", headers=tok, json={"sr_json": sr})
    assert r.status_code == 200, r.text
    # A DB(모의)에 이판독 이름으로 작성자 기록
    assert r.json()["created_by"] == "이판독"


def test_live_cvr_and_comments(client, auth_headers, live_ready):
    """요구6: CVR 조건부 전송(critical) · 코멘트 왕복. VID3 는 앞 테스트에서 R 저장됨(수정 저장)."""
    sr = {"findings": [{"organ": "폐", "observation": "종괴 의심", "severity": "critical"}],
          "impression": [{"statement": "악성 의심 — CVR"}],
          "clinical_info": "흉통 3일", "refer_comment": "의뢰: 흉부외과"}
    r = client.put(f"/api/webpacs/live/reports/{VID3}", headers=auth_headers, json={"sr_json": sr})
    assert r.status_code == 200, r.text
    # 재조회 시 코멘트가 SR 에 실려 돌아옴(왕복)
    rep = client.get(f"/api/webpacs/live/studies/{VID3}/reports", headers=auth_headers).json()["items"][0]
    assert rep["sr_json"]["clinical_info"] == "흉통 3일"
    assert rep["sr_json"].get("refer_comment") == "의뢰: 흉부외과"


def test_live_memo_priority_bookmark_pdf(client, auth_headers, live_ready):
    """요구5: A 대응 차단기능 구현 — 메모·응급·북마크·PDF. (fresh VID VID_BASE+... 오염 회피)."""
    from app.services.webpacs_live import VID_BASE
    vid = VID_BASE + 1   # 판독 저장 안 된 검사 — memo/priority/bookmark 는 판독 상태 무관
    r = client.put(f"/api/webpacs/live/studies/{vid}/memo", headers=auth_headers,
                   json={"memo": "판독 메모 테스트"})
    assert r.status_code == 200 and r.json()["ok"]
    r = client.put(f"/api/webpacs/live/studies/{vid}/priority", headers=auth_headers,
                   json={"emergency": True})
    assert r.status_code == 200 and r.json()["emergency"] is True
    r = client.put(f"/api/webpacs/live/studies/{vid}/bookmark", headers=auth_headers,
                   json={"bookmark": True})
    assert r.status_code == 200
    # 메모(study_comment)가 상세 clinical_info 로 표시
    d = client.get(f"/api/webpacs/live/studies/{vid}", headers=auth_headers).json()
    assert d["clinical_info"] == "판독 메모 테스트"
    # PDF — application/pdf 바이너리
    r = client.get(f"/api/webpacs/live/reports/{vid}/pdf", headers=auth_headers)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf"
    assert r.content[:4] == b"%PDF"


def test_live_sse_status_endpoint(client, auth_headers, live_ready):
    """A SSE 구독 상태 — 모의 A 에는 /see/stream 이 없으므로 connected=false(폴링 폴백)."""
    r = client.get("/api/webpacs/live/sse-status", headers=auth_headers)
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["enabled"] is True          # 브리지 활성
    assert "connected" in s and "rev" in s
    # 미연결이어도 프론트가 폴링으로 폴백하므로 기능 손실 없음


def test_live_preview_uses_prebaked_render(client, auth_headers, live_ready, mock_remote):
    """⚡ 첫 화면용 저해상 미리보기 — A 가 미리 만들어 둔 512×512 q80 JPEG 을 그대로 전달.

    핵심은 '원본 DICOM 을 받지 않는다'는 것. 예전 경로는 프레임 1장을 띄우려고 수 MB DICOM 을
    내려받아 디코드하고 PNG 로 다시 인코딩했다.
    """
    from app.services.webpacs_live import VID_BASE

    vid = VID_BASE + 2
    tree = client.get(f"/api/webpacs/live/studies/{vid}/series-tree", headers=auth_headers).json()
    s0 = tree["series"][0]
    sop = s0["instances"][0]["sop_uid"]

    before = httpx.get(f"{mock_remote}/__test__/state").json()
    url = (f"/api/webpacs/live/dicom-web/studies/{tree['study_uid']}"
           f"/series/{s0['series_uid']}/instances/{sop}/rendered?preview=1")
    r = client.get(url)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "image/jpeg"
    assert r.content[:2] == b"\xff\xd8"          # JPEG SOI
    after = httpx.get(f"{mock_remote}/__test__/state").json()
    # 사전생성 파라미터(viewport=512x512 & quality=80 & window 없음)로 요청했는가
    assert after["rendered_prebaked"] == before["rendered_prebaked"] + 1
    # 원본 DICOM 다운로드는 0건이어야 한다
    assert after["instance_calls"] == before["instance_calls"]


def test_live_rendered_etag_304(client, auth_headers, live_ready):
    """rendered 는 (SOP·윈도우·형식·품질)이 불변이므로 ETag 로 304 — 재방문 재다운로드 제거."""
    from app.services.webpacs_live import VID_BASE

    vid = VID_BASE + 2
    tree = client.get(f"/api/webpacs/live/studies/{vid}/series-tree", headers=auth_headers).json()
    s0 = tree["series"][0]
    url = (f"/api/webpacs/live/dicom-web/studies/{tree['study_uid']}"
           f"/series/{s0['series_uid']}/instances/{s0['instances'][0]['sop_uid']}/rendered")
    r = client.get(url)
    assert r.status_code == 200, r.text
    etag = r.headers.get("ETag")
    assert etag and "max-age=3600" in r.headers.get("Cache-Control", "")
    r2 = client.get(url, headers={"If-None-Match": etag})
    assert r2.status_code == 304
    assert r2.headers.get("ETag") == etag
