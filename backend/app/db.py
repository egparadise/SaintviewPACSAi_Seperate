"""SQLAlchemy 엔진·세션. 계층 규칙: repositories만 세션을 직접 사용한다."""
from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings


class Base(DeclarativeBase):
    pass


def _make_engine():
    settings = get_settings()
    kwargs = {}
    if settings.database_url.startswith("sqlite"):
        # check_same_thread=False: 워커/백업 스레드 공유. timeout: 동시 쓰기(백업 스레드)
        # 시 즉시 OperationalError 대신 락 대기(운영 Postgres는 무관).
        # ⚠ SQLite 는 QueuePool 을 쓰지 않으므로 pool_size 를 주면 TypeError 다.
        kwargs["connect_args"] = {"check_same_thread": False, "timeout": 30}
    else:
        # ⚠ 커넥션 풀이 스레드풀보다 작으면 **풀이 먼저 마른다.**
        #   기본 QueuePool 은 5+10=15 인데 anyio 스레드풀은 40 이다. 핸들러 대부분이 sync 라
        #   Depends(get_db) 로 잡은 커넥션을 원격(A) 왕복이 끝날 때까지 쥐고 있으므로,
        #   A 가 느려지면 16번째 요청부터 **DB 와 무관한 관리자 로그인까지** 커넥션을 기다리다
        #   30초 뒤 500 이 났다. 풀을 스레드풀보다 크게 잡아 그 대기를 원천 제거한다.
        #   (단일 워커 계약이라 Postgres 기본 max_connections=100 안에서 안전하다.)
        kwargs.update(pool_size=40, max_overflow=20, pool_timeout=5, pool_pre_ping=True)
    return create_engine(settings.database_url, **kwargs)


engine = _make_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _sync_columns() -> None:
    """모델에 새로 추가된 단순 컬럼을 ALTER로 보정 (가산 전용, SQLite·Postgres 공통).

    create_all은 기존 테이블을 변경하지 않아 모델 진화 시 스키마가 어긋난다 —
    개발 환경은 이 보정으로 자가 치유한다(운영 정식 배포는 Alembic 권장).
    NOT NULL은 default와 함께만 추가한다.
    """
    from sqlalchemy import inspect, text

    insp = inspect(engine)
    existing_tables = set(insp.get_table_names())
    with engine.connect() as conn:
        for table in Base.metadata.tables.values():
            if table.name not in existing_tables:
                continue  # 새 테이블은 create_all이 만든다
            have = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name in have or col.primary_key:
                    continue
                ddl = col.type.compile(engine.dialect)
                conn.execute(text(f'ALTER TABLE {table.name} ADD COLUMN "{col.name}" {ddl}'))
        conn.commit()


def init_db() -> None:
    """개발/테스트용 스키마 생성 (운영은 Alembic 마이그레이션)."""
    from app import models  # noqa: F401  모델 등록

    if get_settings().is_postgres:
        with engine.connect() as conn:
            from sqlalchemy import text

            conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            conn.commit()
    Base.metadata.create_all(engine)
    # 신규 컬럼 보정 — Postgres 도 포함(기존엔 SQLite 한정이라 모델 진화 시 dev Postgres 가 500 나던 문제)
    _sync_columns()
