"""Live 3D 원본 DICOM 파일 엔드포인트 — 재발 방지 계약.

실제 사고: 3D(MPR/MIP)가 로컬 Orthanc QIDO 만 질의 → Live 검사는 검색 결과가
빈 배열(200 [])이라 "영상 시리즈가 없습니다" 로 죽었다. 수정의 서버 절반이 이것:
  GET /api/webpacs/live/dicom-web/studies/{s}/series/{se}/instances/{sop}
원본 P10 bytes 를 get_instance_bytes(디스크 캐시+a_pixel_slot+SOP 락)로 서빙한다.

계약:
  · 무자격 → 401 (rendered 와 동일한 pixel_user 게이트 — PHI 픽셀 경로)
  · SOP UID 불변 → ETag 304 (볼륨 재구성 재방문이 공짜여야 한다)
  · media_type application/dicom · UID 인젝션 400
"""
from __future__ import annotations

import hashlib
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app

U = "/api/webpacs/live/dicom-web/studies/1.2.3/series/1.2.4/instances/1.2.5"


def _client() -> TestClient:
    return TestClient(app, base_url="https://testserver")


def _auth(c: TestClient) -> dict[str, str]:
    r = c.post("/api/auth/login", json={"username": "admin", "password": "admin1234"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_unauthenticated_is_401():
    """★ 인증이 UID 검증보다 먼저 — 무자격자는 언제나 401 (rendered 와 같은 계약)."""
    with _client() as c:
        assert c.get(U).status_code == 401


def test_file_served_with_etag_and_304():
    """원본 bytes 그대로 + application/dicom + ETag 304 왕복."""
    fake = b"DICM-fake-p10-bytes"
    with _client() as c:
        h = _auth(c)
        with patch("app.api.webpacs_live.live.service_client", return_value=object()), \
             patch("app.api.webpacs_live.live.get_instance_bytes", return_value=fake):
            r = c.get(U, headers=h)
            assert r.status_code == 200, r.text
            assert r.content == fake
            assert r.headers["content-type"].startswith("application/dicom")
            etag = r.headers["etag"]
            assert etag == 'W/"dcm-' + hashlib.sha1(b"1.2.5").hexdigest()[:20] + '"'
            r2 = c.get(U, headers={**h, "If-None-Match": etag})
            assert r2.status_code == 304, "SOP 는 불변 — 304 가 안 나오면 볼륨 재구성마다 전량 재다운로드다"


def test_bad_uid_rejected():
    """UID 인젝션 차단 — rendered 와 같은 _uid 게이트를 태워야 한다."""
    with _client() as c:
        h = _auth(c)
        r = c.get("/api/webpacs/live/dicom-web/studies/abc%20def/series/1.2/instances/1.3",
                  headers=h)
        assert r.status_code == 400
