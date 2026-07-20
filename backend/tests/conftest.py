"""테스트 환경 — 임시 SQLite + mock AI. import 전에 env 고정."""
import os
import sys
import tempfile
from pathlib import Path

_tmpdir = tempfile.mkdtemp(prefix="saintview_test_")
os.environ["SAINTVIEW_DATABASE_URL"] = f"sqlite:///{_tmpdir}/test.db"
os.environ["SAINTVIEW_AI_MODE"] = "mock"
os.environ["SAINTVIEW_EMBEDDING_BACKEND"] = "local"
os.environ["SAINTVIEW_JWT_SECRET"] = "test-secret"
# 앱 lifespan의 MPPS 리스너는 끄고(포트 충돌 방지), MPPS 테스트는 전용 포트로 직접 띄운다
os.environ["SAINTVIEW_MPPS_ENABLED"] = "0"
# AI 판독 초안은 운영 기본 보류(off) — 생성 기계를 검증하는 기존 테스트를 위해 env 로 강제 활성
# (ai.policy 를 덮어쓰는 테스트가 있어도 env 가 우선이라 순서 무관. 보류 동작 자체는 test_ai_hold 가 검증)
os.environ["SAINTVIEW_AI_DRAFT_ENABLED"] = "1"

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402

from app.db import SessionLocal, init_db  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def _init_database():
    init_db()
    with SessionLocal() as db:
        from app.services.auth_service import ensure_default_admin

        ensure_default_admin(db)
    yield


@pytest.fixture()
def db():
    with SessionLocal() as session:
        yield session


@pytest.fixture(scope="session")
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    # lifespan 없이 라우터만 테스트 (워커는 process_once로 직접 구동)
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c


@pytest.fixture(scope="session")
def auth_headers(client):
    r = client.post("/api/auth/login", json={"username": "admin", "password": "admin1234"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}
