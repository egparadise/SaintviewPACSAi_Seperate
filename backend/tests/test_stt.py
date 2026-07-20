"""38차 — 서버측 STT(Whisper/OpenAI) 동작 고정(엔진 선택·폴백 경계)."""
from __future__ import annotations

from app.services.settings_service import set_setting


def test_stt_browser_engine_rejects_server(client, auth_headers, db):
    set_setting(db, "ai.policy", {"stt_engine": "browser"}, scope="global")
    r = client.post("/api/stt", headers=auth_headers,
                    files={"audio": ("d.webm", b"x" * 16, "audio/webm")})
    assert r.status_code == 400  # 서버 STT 비활성 안내


def test_stt_empty_audio_rejected(client, auth_headers, db):
    set_setting(db, "ai.policy", {"stt_engine": "openai_api"}, scope="global")
    r = client.post("/api/stt", headers=auth_headers,
                    files={"audio": ("d.webm", b"", "audio/webm")})
    assert r.status_code == 400  # 빈 오디오


def test_stt_openai_without_key_returns_501(client, auth_headers, db, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    set_setting(db, "ai.policy", {"stt_engine": "openai_api"}, scope="global")
    r = client.post("/api/stt", headers=auth_headers,
                    files={"audio": ("d.webm", b"x" * 16, "audio/webm")})
    assert r.status_code == 501  # 키 미설정 안내
    set_setting(db, "ai.policy", {"stt_engine": "browser"}, scope="global")  # 복원


def test_stt_status_reports_engine_and_availability(client, auth_headers, db, monkeypatch):
    """상태 엔드포인트 — 현재 엔진·설치/키 상태를 보고(관리자 패널·Client 마이크 소비)."""
    set_setting(db, "ai.policy", {"stt_engine": "browser"}, scope="global")
    r = client.get("/api/stt/status", headers=auth_headers)
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["engine"] == "browser" and b["ready"] is True  # 브라우저는 항상 구동 가능
    for k in ("faster_whisper", "openai_whisper", "whisper_local", "openai_api_key"):
        assert k in b["available"]
    # OpenAI 엔진 + 키 없음 → ready False
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    set_setting(db, "ai.policy", {"stt_engine": "openai_api"}, scope="global")
    b2 = client.get("/api/stt/status", headers=auth_headers).json()
    assert b2["engine"] == "openai_api" and b2["ready"] is False
    # 키 설정 시 ready True
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    b3 = client.get("/api/stt/status", headers=auth_headers).json()
    assert b3["ready"] is True
    set_setting(db, "ai.policy", {"stt_engine": "browser"}, scope="global")  # 복원
