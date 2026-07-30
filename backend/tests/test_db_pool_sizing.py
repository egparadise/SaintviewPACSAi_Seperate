"""DB 커넥션 풀은 **스레드풀보다 커야 한다.**

기본 QueuePool 은 5+10=15 인데 anyio 스레드풀은 40 이다. 핸들러 대부분이 sync 라
`Depends(get_db)` 로 잡은 커넥션을 원격(A) 왕복이 끝날 때까지 쥐고 있으므로, A 가 느려지면
**16번째 요청부터** 커넥션을 기다린다. 그 대기가 다시 스레드를 쥔다.

즉 스레드풀 40이 차기 **전에** DB 풀이 먼저 마르고, DB 를 거의 안 쓰는 관리자 로그인까지
pool_timeout(기본 30초)을 다 기다린 뒤 500 이 났다.
"""
from __future__ import annotations

import time

import pytest
from sqlalchemy import create_engine
from sqlalchemy.exc import TimeoutError as SATimeoutError
from sqlalchemy.pool import QueuePool

from app import db as dbmod


def _kwargs_for(url: str, monkeypatch) -> dict:
    """_make_engine 이 create_engine 에 넘기는 인자만 가로챈다.

    실제 접속(psycopg 드라이버)은 필요 없다 — 우리가 고정하려는 것은 **풀 설정**이다.
    """
    class S:
        database_url = url
    monkeypatch.setattr(dbmod, "get_settings", lambda: S())
    seen: dict = {}

    def fake_create_engine(u, **kw):
        seen.update(kw)
        return object()

    monkeypatch.setattr(dbmod, "create_engine", fake_create_engine)
    dbmod._make_engine()                 # noqa: SLF001
    return seen


def test_postgres_pool_is_larger_than_threadpool(monkeypatch):
    """풀 ≥ 스레드풀(40) 이어야 '커넥션 때문에 스레드가 대기' 가 사라진다."""
    kw = _kwargs_for("postgresql+psycopg://u:p@localhost/x", monkeypatch)
    assert kw.get("pool_size", 5) >= 40, f"pool_size={kw.get('pool_size')} — 스레드풀 40 보다 작다"
    assert kw.get("max_overflow", 10) >= 20
    assert kw.get("pool_timeout", 30) <= 5, "커넥션 대기 30초는 요청을 그만큼 매단다"


def test_sqlite_gets_no_queuepool_args(monkeypatch):
    """SQLite 는 QueuePool 을 안 쓴다 — pool_size 를 주면 TypeError 다(분기 회귀 방어)."""
    kw = _kwargs_for("sqlite:///:memory:", monkeypatch)
    for bad in ("pool_size", "max_overflow", "pool_timeout"):
        assert bad not in kw, f"SQLite 에 {bad} 를 넘기면 create_engine 이 TypeError 다"
    assert "connect_args" in kw


def test_sqlite_engine_really_builds(monkeypatch):
    """가로채지 않고 실제로 만들어 본다 — 위 분기가 맞는지 최종 확인."""
    class S:
        database_url = "sqlite:///:memory:"
    monkeypatch.setattr(dbmod, "get_settings", lambda: S())
    eng = dbmod._make_engine()           # noqa: SLF001
    with eng.connect() as c:
        assert c is not None


def test_pool_timeout_fails_fast_instead_of_hanging():
    """풀이 마르면 **빨리** 실패해야 한다 — 30초 매달림 회귀 방어."""
    # SQLite 기본은 SingletonThreadPool 이라 풀 인자를 안 받는다 — QueuePool 을 명시한다
    eng = create_engine("sqlite:///:memory:", poolclass=QueuePool,
                        pool_size=1, max_overflow=0, pool_timeout=0.3)
    held = eng.connect()
    try:
        t0 = time.time()
        with pytest.raises(SATimeoutError):
            eng.connect()
        assert time.time() - t0 < 3, "커넥션 대기가 너무 길다"
    finally:
        held.close()
