"""파일럿 보안: prod 게이트 + 비밀번호 변경."""
import pytest


def test_prod_gate_rejects_default_secrets(monkeypatch):
    from app.config import Settings

    s = Settings()
    monkeypatch.setattr(s, "env", "prod")
    # 테스트 환경의 시크릿/SQLite는 prod 기준 미달 → 기동 거부
    with pytest.raises(RuntimeError) as exc:
        s.validate_for_prod()
    msg = str(exc.value)
    assert "JWT_SECRET" in msg or "DATABASE_URL" in msg


def test_prod_gate_passes_with_strong_config(monkeypatch):
    from app.config import Settings

    s = Settings()
    monkeypatch.setattr(s, "env", "prod")
    monkeypatch.setattr(s, "jwt_secret", "x" * 48)
    monkeypatch.setattr(s, "orthanc_password", "strong-orthanc-pw")
    monkeypatch.setattr(s, "database_url", "postgresql+psycopg2://u:p@h/db")
    monkeypatch.setenv("SAINTVIEW_ADMIN_PASSWORD", "strong-admin-pw")
    s.validate_for_prod()  # 예외 없음


def test_change_password_flow(client, auth_headers):
    # 잘못된 현재 비밀번호 → 401
    r = client.post("/api/auth/change-password", headers=auth_headers,
                    json={"current_password": "wrong", "new_password": "newpass1234"})
    assert r.status_code == 401
    # 8자 미만 → 400
    r = client.post("/api/auth/change-password", headers=auth_headers,
                    json={"current_password": "admin1234", "new_password": "short"})
    assert r.status_code == 400
    # 정상 변경 → 새 비밀번호로 로그인 → 원복
    r = client.post("/api/auth/change-password", headers=auth_headers,
                    json={"current_password": "admin1234", "new_password": "newpass1234"})
    assert r.status_code == 200
    assert client.post("/api/auth/login",
                       json={"username": "admin", "password": "newpass1234"}).status_code == 200
    assert client.post("/api/auth/login",
                       json={"username": "admin", "password": "admin1234"}).status_code == 401
    # 원복 (다른 테스트 영향 방지)
    r = client.post("/api/auth/change-password", headers=auth_headers,
                    json={"current_password": "newpass1234", "new_password": "admin1234"})
    assert r.status_code == 200
