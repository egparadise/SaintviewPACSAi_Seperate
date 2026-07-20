"""앱 설정 — 환경변수 단일 소스 (CLAUDE.md 절대 규칙 4: 시크릿은 env로만)."""
from __future__ import annotations

import os
from functools import lru_cache

from dotenv import load_dotenv

load_dotenv()


class Settings:
    # 환경: dev | prod — prod에서는 기본 시크릿을 거부한다(§8 보안 게이트)
    env: str = os.getenv("SAINTVIEW_ENV", "dev")
    # DB (D-1: PostgreSQL+pgvector, 개발 폴백 SQLite)
    database_url: str = os.getenv(
        "SAINTVIEW_DATABASE_URL",
        "sqlite:///./dev.db",
    )
    # 인증
    jwt_secret: str = os.getenv("SAINTVIEW_JWT_SECRET", "dev-only-change-me")
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = int(os.getenv("SAINTVIEW_JWT_EXPIRE_MINUTES", "480"))
    # Orthanc (D-3)
    orthanc_url: str = os.getenv("SAINTVIEW_ORTHANC_URL", "http://localhost:8042")
    # 클라이언트(브라우저)가 쓰는 썸네일 프리뷰 베이스 — 기본은 상대경로 '/orthanc'(Vite 프록시→localhost:8042).
    # 같은 출처라 원격(Tailscale) 접속에서도 동작. 직접 노출하려면 SAINTVIEW_ORTHANC_PREVIEW_BASE=http://<IP>:8042 로 override.
    orthanc_preview_base: str = os.getenv("SAINTVIEW_ORTHANC_PREVIEW_BASE", "/orthanc")
    # 메인 서버 페이지 — 통합 상태/관리용 외부 서비스 주소
    ohif_url: str = os.getenv("SAINTVIEW_OHIF_URL", "http://localhost:3000")
    api_url: str = os.getenv("SAINTVIEW_API_URL", "http://localhost:8000")
    pg_host: str = os.getenv("SAINTVIEW_PG_HOST", "localhost")
    pg_port: int = int(os.getenv("SAINTVIEW_PG_PORT", "5433"))
    orthanc_user: str = os.getenv("SAINTVIEW_ORTHANC_USER", "saintview")
    orthanc_password: str = os.getenv("SAINTVIEW_ORTHANC_PASSWORD", "saintview_dev")
    # AI (CLAUDE.md §4)
    ai_model: str = os.getenv("SAINTVIEW_AI_MODEL", "claude-opus-4-8")
    ai_mode: str = os.getenv("SAINTVIEW_AI_MODE", "mock")  # mock | live
    ai_auto_generate: bool = os.getenv("SAINTVIEW_AI_AUTO_GENERATE", "1") == "1"
    # MWL (P2) — Orthanc worklists 플러그인 폴더 (compose에서 deploy/worklists 마운트)
    mwl_dir: str = os.getenv("SAINTVIEW_MWL_DIR", "../deploy/worklists")
    # 가입(공개) — 운영에서는 승인 절차로 대체 가능. dev 기본 활성.
    signup_enabled: bool = os.getenv("SAINTVIEW_SIGNUP_ENABLED", "1") == "1"
    # MPPS SCP — 장비의 N-CREATE/N-SET(수행 단계) 수신 → 오더 상태 갱신
    mpps_enabled: bool = os.getenv("SAINTVIEW_MPPS_ENABLED", "1") == "1"
    mpps_port: int = int(os.getenv("SAINTVIEW_MPPS_PORT", "11112"))
    mpps_aet: str = os.getenv("SAINTVIEW_MPPS_AET", "SAINTVIEW")
    # 임베딩 (D-2)
    embedding_backend: str = os.getenv("SAINTVIEW_EMBEDDING_BACKEND", "local")  # local | voyage
    embedding_dim: int = int(os.getenv("SAINTVIEW_EMBEDDING_DIM", "256"))

    @property
    def is_postgres(self) -> bool:
        return self.database_url.startswith("postgresql")

    def validate_for_prod(self) -> None:
        """파일럿/운영 기동 게이트 — 기본 시크릿·약한 설정이면 기동 거부."""
        if self.env != "prod":
            return
        problems = []
        if self.jwt_secret == "dev-only-change-me" or len(self.jwt_secret) < 32:
            problems.append("SAINTVIEW_JWT_SECRET: 32자 이상 무작위 값 필요")
        if os.getenv("SAINTVIEW_ADMIN_PASSWORD", "admin1234") == "admin1234":
            problems.append("SAINTVIEW_ADMIN_PASSWORD: 기본값 사용 금지")
        if self.orthanc_password == "saintview_dev":
            problems.append("SAINTVIEW_ORTHANC_PASSWORD: 기본값 사용 금지")
        if self.database_url.startswith("sqlite"):
            problems.append("SAINTVIEW_DATABASE_URL: prod는 PostgreSQL 필수(D-1)")
        if problems:
            raise RuntimeError("prod 보안 게이트 실패:\n- " + "\n- ".join(problems))


@lru_cache
def get_settings() -> Settings:
    return Settings()
