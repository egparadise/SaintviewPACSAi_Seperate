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


@pytest.fixture(scope="module")
def pixel_client(live_ready):
    """브라우저처럼 픽셀 쿠키(sv_pix)만으로 영상을 받는 클라이언트.

    Authorization 헤더를 **쓰지 않는다** — <img src> 가 헤더를 붙일 수 없다는 것이
    이 기능의 전제이므로, 테스트도 그 조건에서만 통과해야 의미가 있다.
    base_url 이 https 인 이유: 쿠키가 Secure 라 http 로는 쿠키 자체가 되돌아가지 않는다
    (개발·운영 모두 HTTPS 라는 설계 전제를 테스트에서도 그대로 지킨다).
    """
    from fastapi.testclient import TestClient

    from app.main import app

    c = TestClient(app, base_url="https://testserver")
    r = c.post("/api/auth/webpacs-login", json={"user_id": "dr_kim", "user_passwd": "kim1234"})
    assert r.status_code == 200, r.text
    assert c.cookies.get("sv_pix"), "로그인이 픽셀 쿠키를 발급하지 않았다"
    return c


def _no_cred_client():
    """자격증명이 전혀 없는 새 클라이언트(쿠키 항아리 비어 있음)."""
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app, base_url="https://testserver")


VID1 = VID_BASE + 1


@pytest.fixture(autouse=True)
def _isolate_live_caches():
    """테스트마다 Live 캐시를 비운다.

    webpacs_live 는 모듈 수준 캐시를 세 벌 들고 있다(_TREE_CACHE 30초 · _REL_CACHE ·
    디코드/인코드). 모의 A 서버는 호출마다 **새 UID 를 생성**하므로, 앞 테스트가 덥혀 놓은
    트리가 남아 있으면 뒤 테스트에서 detail 의 UID 와 tree 의 UID 가 달라져 엉뚱하게 깨진다
    (실제로 test_live_detail_and_tree 가 그렇게 실패했다).
    개별 테스트에서 손으로 비우던 것을 여기로 올려 다시는 새지 않게 한다.
    """
    from app.services import webpacs_live as live

    live.invalidate_tree()
    live.invalidate_related()
    yield
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


def test_live_prefetch_and_decode_cache(client, auth_headers, live_ready, pixel_client):
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
    r1 = pixel_client.get(url, params={"window": "40,400"})
    t1 = _t.perf_counter()
    # 다른 W/L — 디코드는 캐시, 윈도잉만
    r2 = pixel_client.get(url, params={"window": "80,500"})
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
    # 헤더 없이 쿠키만으로(<img> 계약)
    r = pixel_client.get(url, params={"window": "500,1000,linear"})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "image/png"
    assert r.content[:8] == b"\x89PNG\r\n\x1a\n"
    # JPEG 형식 파라미터
    r = pixel_client.get(url, params={"accept": "image/jpeg", "quality": 80})
    assert r.status_code == 200 and r.content[:2] == b"\xff\xd8"
    # 썸네일
    r = pixel_client.get(s["instances"][0]["preview_url"])
    assert r.status_code == 200 and r.headers["content-type"].startswith("image/")



def _a_doctor_headers(client, user="dr_kim", pw="kim1234"):
    """A 의사 계정 로그인 토큰 — 판독 저장 자격 게이트(전문의 분류) 통과용.
    2026-08-07 계약: B 로컬 토큰(서비스 계정 폴백)으로는 판독 저장이 409 로 막힌다."""
    r = client.post("/api/auth/webpacs-login", json={"user_id": user, "user_passwd": pw})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_live_report_roundtrip_and_finalize(client, auth_headers, live_ready):
    doc_tok = _a_doctor_headers(client)

    # 빈 초안(합성) — A 에 리포트 없음
    r = client.get(f"/api/webpacs/live/studies/{VID2}/reports", headers=auth_headers)
    assert r.status_code == 200
    rep = r.json()["items"][0]
    assert rep["status"] == "draft" and rep["id"] == VID2

    # 저장(R) — dock 계약: PUT /reports/{id} {sr_json}
    sr = {"findings": [{"organ": "판독", "observation": "폐야 청명", "severity": "normal"}],
          "impression": [{"rank": 1, "statement": "정상 소견", "confidence": "high"}]}
    r = client.put(f"/api/webpacs/live/reports/{VID2}", headers=doc_tok,
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
    r = client.post(f"/api/webpacs/live/reports/{VID2}/finalize", headers=doc_tok)
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
    doc_tok = _a_doctor_headers(client)
    # study 1 은 이미 앞 테스트에서 판독 저장됨 — 새로운 미판독 검사가 없으므로
    # finalize-with 에 빈 sr 을 명시적으로 넘겨 검증
    r = client.post(f"/api/webpacs/live/reports/{VID2}/finalize-with", headers=doc_tok,
                    json={"sr_json": {"findings": [], "impression": [{"statement": ""}]}})
    assert r.status_code == 409
    assert "빈 판독" in r.json()["detail"]


def test_live_bad_uid_rejected(client, live_ready, pixel_client):
    """UID 인젝션 차단(적대검증 #7) — ?/ 등으로 원본 인스턴스 노출 방지.

    ⚠ 상태코드 순서가 바뀌었다(픽셀 인증 도입). 예전에는 자격 없이 잘못된 UID 를 보내면
      400 이었지만, 지금은 인증 의존성이 함수 본문보다 먼저 실행되므로 401 이다.
      '자격이 없으면 예외 없이 401' 을 택했다 — 무자격자가 UID 판정으로 엔드포인트를
      탐침하지 못하게 하고, 규칙에 예외를 두지 않기 위해서다.
      인증된 호출자에 대한 400 계약은 그대로다. 아래에서 양쪽을 모두 고정한다.
    """
    # ① 자격 있음 → 기존 400 계약 유지
    r = pixel_client.get("/api/webpacs/live/thumb/1.2.3/1.2.3/1.2.3%3Ffoo")
    assert r.status_code == 400, r.text
    r = pixel_client.get(
        "/api/webpacs/live/dicom-web/studies/bad-uid/series/1.2/instances/1.2/rendered")
    assert r.status_code == 400, r.text

    # ② 자격 없음 → 400 이 아니라 401(인증이 형식 검증보다 먼저)
    anon = _no_cred_client()
    assert anon.get("/api/webpacs/live/thumb/1.2.3/1.2.3/1.2.3%3Ffoo").status_code == 401
    assert anon.get(
        "/api/webpacs/live/dicom-web/studies/bad-uid/series/1.2/instances/1.2/rendered"
    ).status_code == 401


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
    doc_tok = _a_doctor_headers(client)
    sr = {"findings": [{"organ": "폐", "observation": "종괴 의심", "severity": "critical"}],
          "impression": [{"statement": "악성 의심 — CVR"}],
          "clinical_info": "흉통 3일", "refer_comment": "의뢰: 흉부외과"}
    r = client.put(f"/api/webpacs/live/reports/{VID3}", headers=doc_tok, json={"sr_json": sr})
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


def test_live_preview_uses_prebaked_render(client, auth_headers, live_ready, mock_remote,
                                           pixel_client):
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
    r = pixel_client.get(url)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "image/jpeg"
    assert r.content[:2] == b"\xff\xd8"          # JPEG SOI
    after = httpx.get(f"{mock_remote}/__test__/state").json()
    # 사전생성 파라미터(viewport=512x512 & quality=80 & window 없음)로 요청했는가
    assert after["rendered_prebaked"] == before["rendered_prebaked"] + 1
    # 원본 DICOM 다운로드는 0건이어야 한다
    assert after["instance_calls"] == before["instance_calls"]


def test_live_rendered_etag_304(client, auth_headers, live_ready, pixel_client):
    """rendered 는 (SOP·윈도우·형식·품질)이 불변이므로 ETag 로 304 — 재방문 재다운로드 제거."""
    from app.services.webpacs_live import VID_BASE

    vid = VID_BASE + 2
    tree = client.get(f"/api/webpacs/live/studies/{vid}/series-tree", headers=auth_headers).json()
    s0 = tree["series"][0]
    url = (f"/api/webpacs/live/dicom-web/studies/{tree['study_uid']}"
           f"/series/{s0['series_uid']}/instances/{s0['instances'][0]['sop_uid']}/rendered")
    r = pixel_client.get(url)
    assert r.status_code == 200, r.text
    etag = r.headers.get("ETag")
    # 쿠키 방식(A)을 택한 이유 중 하나 — URL 이 그대로라 ETag/304·캐시 수명이 살아 있다
    assert etag and "max-age=3600" in r.headers.get("Cache-Control", "")
    r2 = pixel_client.get(url, headers={"If-None-Match": etag})
    assert r2.status_code == 304
    assert r2.headers.get("ETag") == etag


# ─────────────── 픽셀 인증(PHI) — deps.pixel_user ───────────────
@pytest.fixture(scope="module")
def pixel_urls(client, auth_headers, live_ready):
    """실제로 픽셀이 나오는 rendered·thumb URL 한 쌍(존재하는 UID)."""
    tree = client.get(f"/api/webpacs/live/studies/{VID1}/series-tree",
                      headers=auth_headers).json()
    s0 = tree["series"][0]
    i0 = s0["instances"][0]
    rendered = (f"/api/webpacs/live/dicom-web/studies/{tree['study_uid']}"
                f"/series/{s0['series_uid']}/instances/{i0['sop_uid']}/rendered")
    return {"rendered": rendered, "thumb": i0["preview_url"]}


def test_pixel_requires_credentials_401(pixel_urls):
    """자격 없이 픽셀 GET → 401. (예전 계약: 200 + PHI 픽셀)

    이 테스트가 '공허하지 않다'는 근거: webpacs_live.rendered/thumb 에서
    Depends(pixel_user) 를 떼면 그 즉시 200 이 돌아와 실패한다.
    """
    anon = _no_cred_client()
    for key in ("rendered", "thumb"):
        r = anon.get(pixel_urls[key])
        assert r.status_code == 401, f"{key}: 자격 없이 {r.status_code} — PHI 픽셀이 열려 있다"
        assert not r.headers.get("content-type", "").startswith("image/")


def test_pixel_forged_or_expired_credentials_401(pixel_urls):
    """위조/만료 자격은 모두 401 — 조용히 통과하는 경로가 없어야 한다."""
    import time as _t
    from datetime import datetime, timedelta, timezone

    import jwt as _jwt

    from app.config import get_settings

    anon = _no_cred_client()
    url = pixel_urls["rendered"]

    # ① 존재하지 않는 sid 쿠키
    assert anon.get(url, headers={"Cookie": "sv_pix=" + "0" * 32}).status_code == 401
    # ② 비어 있지 않지만 형식만 그럴싸한 쿠키(길이 초과 포함)
    assert anon.get(url, headers={"Cookie": "sv_pix=" + "a" * 200}).status_code == 401
    # ③ 다른 키로 서명한 JWT(위조)
    forged = _jwt.encode({"sub": "attacker", "role": "admin",
                          "exp": datetime.now(timezone.utc) + timedelta(hours=1)},
                         "not-the-real-secret", algorithm="HS256")
    assert anon.get(url, headers={"Authorization": f"Bearer {forged}"}).status_code == 401
    # ④ 올바른 키로 서명했지만 만료된 JWT
    st = get_settings()
    expired = _jwt.encode({"sub": "admin", "role": "admin", "exp": int(_t.time()) - 60},
                          st.jwt_secret, algorithm=st.jwt_algorithm)
    assert anon.get(url, headers={"Authorization": f"Bearer {expired}"}).status_code == 401
    # ⑤ 쿠키를 JWT 로 채워도 통하지 않는다 — 쿠키 값은 불투명 sid 여야 한다
    valid = _jwt.encode({"sub": "admin", "role": "admin",
                         "exp": datetime.now(timezone.utc) + timedelta(hours=1)},
                        st.jwt_secret, algorithm=st.jwt_algorithm)
    assert anon.get(url, headers={"Cookie": f"sv_pix={valid}"}).status_code == 401


def test_pixel_cookie_grants_access(pixel_client, pixel_urls):
    """정상 자격(로그인이 심어 준 HttpOnly 쿠키) → 200 + 실제 픽셀. 헤더는 쓰지 않는다."""
    assert "authorization" not in {k.lower() for k in pixel_client.headers}
    r = pixel_client.get(pixel_urls["rendered"])
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("image/")
    assert r.content[:8] == b"\x89PNG\r\n\x1a\n"
    r = pixel_client.get(pixel_urls["thumb"])
    assert r.status_code == 200 and r.headers["content-type"].startswith("image/")


def test_pixel_bearer_path_still_works(pixel_urls, auth_headers):
    """기존 Bearer 경로 유지 — 쿠키 없이 헤더만으로도 200(다른 호출자·테스트가 쓴다)."""
    anon = _no_cred_client()
    r = anon.get(pixel_urls["rendered"], headers=auth_headers)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("image/")


def test_logout_revokes_pixel_cookie(live_ready, pixel_urls):
    """로그아웃하면 같은 쿠키로 더 이상 픽셀을 못 받는다(취소 가능한 자격증명).

    JWT 를 쿠키에 담았다면 이 테스트는 통과할 수 없다 — 서명이 유효한 동안 계속 열린다.
    """
    from fastapi.testclient import TestClient

    from app.main import app

    c = TestClient(app, base_url="https://testserver")
    r = c.post("/api/auth/webpacs-login", json={"user_id": "dr_lee", "user_passwd": "lee1234"})
    assert r.status_code == 200, r.text
    sid = c.cookies.get("sv_pix")
    assert sid
    assert c.get(pixel_urls["rendered"]).status_code == 200

    # 프론트와 동일하게 Bearer 를 실어 보낸다 — 픽셀 쿠키는 Path=/api/webpacs/live 라
    # /api/auth/logout 에는 전송되지 않으므로 세션 식별은 토큰이 한다(auth.logout 주석 참조).
    tok = r.json()["token"]
    assert c.post("/api/auth/logout", headers={"Authorization": f"Bearer {tok}"}).status_code == 200
    # ① 서버가 Set-Cookie 로 지웠고
    assert not c.cookies.get("sv_pix")
    # ② 쿠키 값을 손으로 되살려도 세션이 없어 401 이다(서버측 취소가 실체)
    assert c.get(pixel_urls["rendered"], headers={"Cookie": f"sv_pix={sid}"}).status_code == 401


def test_pixel_cookie_dies_when_session_revoked(db, live_ready, pixel_urls):
    """중복 로그인 인계로 취소된 세션의 쿠키는 카운트다운 후 401.

    다른 브라우저에 남아 있던 구 세션 쿠키가 살아 있으면 인계가 무의미해진다.
    """
    from datetime import datetime, timedelta, timezone

    from fastapi.testclient import TestClient
    from sqlalchemy import select

    from app.main import app
    from app.models import ActiveSession

    c = TestClient(app, base_url="https://testserver")
    r = c.post("/api/auth/webpacs-login", json={"user_id": "dr_kim", "user_passwd": "kim1234"})
    assert r.status_code == 200, r.text
    sid = c.cookies.get("sv_pix")
    assert c.get(pixel_urls["rendered"]).status_code == 200

    # 인계(force)와 같은 상태를 만든다 — 카운트다운이 이미 지난 시점
    row = db.execute(select(ActiveSession).where(ActiveSession.session_id == sid)).scalar_one()
    row.revoke_deadline = datetime.now(timezone.utc) - timedelta(seconds=1)
    row.revoke_reason = "다른 곳에서 로그인됨"
    db.commit()

    assert c.get(pixel_urls["rendered"]).status_code == 401


def test_get_instance_bytes_dedupes_concurrent_downloads(tmp_path, monkeypatch):
    """동일 SOP 를 여러 스레드가 동시에 요청해도 A 원본 다운로드는 1회.

    예전엔 파일 존재 여부만 보고 각자 받아서 ① A 로 같은 수 MB 를 두 번 받고
    ② 같은 임시 파일에 동시에 써서 캐시가 깨졌다(손상 캐시 재시도 경로가 그 증거).
    락 없이 실행하면 이 테스트는 calls == 6 으로 실패한다.
    """
    import concurrent.futures as cf

    from app.services import webpacs_live as live

    monkeypatch.setattr(live, "CACHE_DIR", tmp_path)
    sop = "1.2.3.4.5.99"
    calls = []
    lock = threading.Lock()

    class _Slow:
        def instance_dicom(self, study_uid, series_uid, sop_uid):
            with lock:
                calls.append(sop_uid)
            time.sleep(0.15)          # 다른 스레드가 확실히 겹쳐 들어오도록
            return b"DICM-PAYLOAD"

    cli = _Slow()
    with cf.ThreadPoolExecutor(max_workers=6) as ex:
        out = [f.result() for f in
               [ex.submit(live.get_instance_bytes, cli, "1.2", "1.2.3", sop) for _ in range(6)]]

    assert out == [b"DICM-PAYLOAD"] * 6
    assert len(calls) == 1, f"원본 다운로드가 {len(calls)}회 발생(1회여야 함)"
    assert (tmp_path / f"{sop}.dcm").read_bytes() == b"DICM-PAYLOAD"
    assert not list(tmp_path.glob("*.part")), "임시 파일이 남았다"


def test_viewer_open_skips_slow_patient_search(client, auth_headers, live_ready, mock_remote):
    """⚡ 뷰어 오픈 경로(related=0)는 A 의 환자별 검사 검색을 하지 않는다.

    A 의 환자별 검색은 사이트에 따라 수 초가 걸린다(실측 4.11s). 예전에는 이것이
    live_detail 안에 있어서 뷰어가 그만큼 '뷰어 로딩…' 으로 멈춰 있었다.
    """
    from app.services import webpacs_live as live

    vid = VID_BASE + 1
    live.invalidate_related()      # 앞선 테스트가 덥혀 놓은 캐시와 격리
    live.invalidate_tree()         # 시리즈 트리도 vid 키 30초 캐시라 같이 비운다

    def calls():
        return httpx.get(f"{mock_remote}/__test__/state").json()["list_calls"]

    # ① 오픈 경로 — 검색 0회
    before = calls()
    r = client.get(f"/api/webpacs/live/studies/{vid}?related=0", headers=auth_headers)
    assert r.status_code == 200, r.text
    assert r.json()["related_exams"] == []
    assert calls() == before, "오픈 경로에서 환자별 검사 검색이 발생했다"

    # ② 과거검사는 별도 경로로 받는다 — 이때만 검색
    before = calls()
    r = client.get(f"/api/webpacs/live/studies/{vid}/related", headers=auth_headers)
    assert r.status_code == 200, r.text
    assert isinstance(r.json()["items"], list)
    assert calls() == before + 1

    # ③ 같은 환자 재요청은 캐시 — 추가 검색 없음
    before = calls()
    client.get(f"/api/webpacs/live/studies/{vid}/related", headers=auth_headers)
    assert calls() == before, "환자 단위 캐시가 동작하지 않는다"

    # ④ 기본(related 생략)은 기존 계약 유지 — related_exams 가 채워진다
    r = client.get(f"/api/webpacs/live/studies/{vid}", headers=auth_headers)
    assert r.status_code == 200
    assert "related_exams" in r.json()


def test_live_sr_matches_frontend_contract(client, auth_headers, live_ready):
    """Live 판독 SR 이 프론트 SrJson 계약과 **키·모양**이 같아야 한다.

    실제로 깨졌던 계약: 백엔드가 단수 `recommendation`(항목 {text})을 내는데 프론트는
    복수 `recommendations`(항목 {action, timeframe})를 필수로 읽었다. T-View 워크리스트의
    판독 패널이 `draft.recommendations.length` 에서 TypeError 를 던졌고, ErrorBoundary 가
    없어 **앱 전체가 백지**가 됐다(새로고침하면 선택이 풀려 살아나므로 '간헐'처럼 보였다).
    """
    vid = VID_BASE + 1
    sr = client.get(f"/api/webpacs/live/studies/{vid}/reports",
                    headers=auth_headers).json()["items"][0]["sr_json"]

    # 로컬(비-Live) 판독이 내는 것과 같은 키 집합이어야 한다
    for key in ("exam", "comparison", "findings", "impression", "recommendations"):
        assert key in sr, f"SR 에 '{key}' 가 없다 — 프론트가 그대로 읽다가 죽는다: {sorted(sr)}"
    assert "recommendation" not in sr, "구 단수 키가 남아 있다"

    assert isinstance(sr["findings"], list) and isinstance(sr["impression"], list)
    assert isinstance(sr["recommendations"], list)
    for r in sr["recommendations"]:
        assert set(r) >= {"action", "timeframe"}, f"권고 항목 모양이 계약과 다르다: {r}"

    # 역방향(SR → A 평문) 도 새 계약을 읽어야 한다 — 저장 시 권고가 소실되면 안 된다.
    # (A 선점 상태에 의존하지 않도록 매핑 함수를 직접 검증)
    from app.services.webpacs_live import _reading_from_sr

    reading, conclusion = _reading_from_sr({
        "comparison": {"summary": ""},
        "findings": [{"organ": "폐", "observation": "결절 의심", "severity": ""}],
        "impression": [{"statement": "추적 필요"}],
        "recommendations": [{"action": "3개월 후 CT 추적", "timeframe": "3m"}],
    })
    assert "결절 의심" in reading
    assert "3개월 후 CT 추적" in reading, f"권고가 A 평문에서 소실됐다: {reading!r}"
    assert conclusion == "추적 필요"

    # 구 형식(단수 recommendation/{text})도 계속 받아준다 — 이미 저장된 판독 호환
    old_reading, _ = _reading_from_sr({"recommendation": [{"text": "구형식 권고"}]})
    assert "구형식 권고" in old_reading


def test_live_report_blocked_for_non_radiologist(client, live_ready):
    """★ 2026-08-07 계약 — 전문의 미분류 A 계정(doctor_major 없음)은 판독 저장이 막힌다."""
    r = client.post("/api/auth/webpacs-login",
                    json={"user_id": "nurse_choi", "user_passwd": "choi1234"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["doctor"]["radiologist"] is False, "로그인 응답이 자격 없음을 알려야 한다"
    tok = {"Authorization": f"Bearer {body['token']}"}
    sr = {"findings": [{"organ": "판독", "observation": "정상"}],
          "impression": [{"statement": "무자격 저장 시도"}]}
    r = client.put(f"/api/webpacs/live/reports/{VID3}", headers=tok, json={"sr_json": sr})
    assert r.status_code == 409, r.text
    assert "판독 저장 권한" in r.json()["detail"]


def test_live_doctor_login_autofills_signature(client, live_ready, db):
    """★ 전문의 A 로그인 → 판독의 등록(이름·면허번호)이 미러 계정에 자동 저장(확정 서명용)."""
    r = client.post("/api/auth/webpacs-login",
                    json={"user_id": "dr_kim", "user_passwd": "kim1234"})
    assert r.status_code == 200, r.text
    assert r.json()["doctor"] == {"registered": True, "license_no": "10011",
                                  "major_no": "90011", "radiologist": True}
    from sqlalchemy import select

    from app.models import Account

    acc = db.execute(select(Account).where(Account.username == "dr_kim")).scalar_one()
    assert acc.display_name == "김판독"
    assert acc.license_no == "10011", "면허번호가 자동으로 채워져야 한다(그림의 판독의 등록)"
