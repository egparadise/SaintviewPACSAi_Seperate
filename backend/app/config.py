"""앱 설정 — 환경변수 단일 소스 (CLAUDE.md 절대 규칙 4: 시크릿은 env로만)."""
from __future__ import annotations

import os
import signal
import sys
from functools import lru_cache
from pathlib import Path, PurePath

from dotenv import load_dotenv

load_dotenv()


# ══════════════════════════ 단일 워커 배포 계약 ══════════════════════════
# 이 백엔드는 **단일 워커 전용**이다. 캐시·락·인플라이트·세션이 전부 프로세스
# 인메모리(모듈 전역 dict)라 워커가 2개 이상이면 조용히 깨진다:
#   · webpacs_session._SESSIONS(A 토큰)  → 로그인한 워커가 아닌 곳으로 요청이 가면 401
#   · security_service._fail_counts       → 로그인 실패 잠금 임계값이 실질 N배(브루트포스 방어 약화)
#   · webpacs_live._INFLIGHT/_sop_lock    → SOP 직렬화 붕괴 + 같은 .part 파일에 동시 기록(캐시 손상)
#   · _DECODE_CACHE/_ENC_CACHE/STT 모델   → 상한이 워커 수만큼 곱해져 OOM
#   · MPPS/MWL/MLLP 리스너                → 2번째 워커부터 bind 실패(조용히 반쪽 동작)
# 자세한 목록은 docs/DEPLOYMENT.md '단일 워커 배포 계약' 절 참조.

MULTI_WORKER_MESSAGE = (
    "다중 워커 금지 — 이 백엔드는 캐시·락·인플라이트·A세션이 모두 프로세스 인메모리라 "
    "워커마다 따로 돌아 조용히 깨진다(A 로그인 랜덤 만료 / 로그인 실패 잠금 임계값 N배 / "
    "같은 SOP 중복 다운로드·.part 파일 동시 기록으로 캐시 손상 / 디코드·인코드 캐시와 STT 모델이 "
    "워커 수만큼 곱해져 OOM / MPPS·MWL 포트 bind 실패). "
    "지금 바로 할 일: --workers 1 (gunicorn 은 -w 1)로 띄우고 WEB_CONCURRENCY 를 지워라. "
    "정말 워커를 늘리려면 먼저 상태를 프로세스 밖으로 빼야 한다 — 세션·실패카운터는 DB/Redis 로, "
    "인플라이트 락은 파일락/Redis 락으로, 디코드·인코드 캐시는 공유 저장소로, "
    "MPPS·MWL·MLLP·SSE·DDNS·ai_worker 는 별도 단일 프로세스로 분리."
)

_UVICORN = "uvicorn"
_GUNICORN = "gunicorn"


def _argv0_server(argv0: str) -> str | None:
    """argv[0] 이 정말 uvicorn/gunicorn CLI 인지 확정한다.

    이 게이트가 오탐 차단의 핵심이다 — pytest·alembic·python -c·자체 래퍼처럼
    '--workers' 를 자기 옵션으로 쓰는 다른 프로그램을 여기서 전부 걸러낸다.
    허용 형태는 두 가지뿐:
      · `python -m uvicorn`  → argv[0] = .../uvicorn/__main__.py
      · 콘솔 스크립트        → argv[0] = .../bin/uvicorn, ...\\Scripts\\uvicorn.exe
    (`uvicorn.py` 같은 임의 스크립트는 일부러 받지 않는다 — 남의 래퍼일 수 있다)
    """
    if not argv0:
        return None
    p = PurePath(str(argv0).replace("\\", "/"))
    name = p.name.lower()
    parent = p.parent.name.lower()
    if name == "__main__.py":
        return parent if parent in (_UVICORN, _GUNICORN) else None
    stem = name
    for suffix in (".exe", "-script.py"):
        if stem.endswith(suffix):
            stem = stem[: -len(suffix)]
            break
    return stem if stem in (_UVICORN, _GUNICORN) else None


def _read_workers_flag(argv: list[str], server: str) -> tuple[int | None, bool]:
    """`--workers N` / `--workers=N` / `-w N` / `-w N`(gunicorn) 을 읽는다.

    반환 (값, 플래그가 있었는가). 값 파싱에 실패하면 (None, True).
    같은 플래그가 여러 번이면 **마지막**이 이긴다(click·argparse 공통 동작).
    ※ uvicorn 에는 -w 단축옵션이 없다 → gunicorn 에서만 본다.
    """
    longs = ("--workers",)
    shorts = ("-w",) if server == _GUNICORN else ()
    raw: str | None = None
    found = False
    i = 0
    n = len(argv)
    while i < n:
        a = argv[i]
        got: str | None = None
        if a in longs or a in shorts:
            found = True
            got = argv[i + 1] if i + 1 < n else None
            i += 1
        elif any(a.startswith(lo + "=") for lo in longs):
            found = True
            got = a.split("=", 1)[1]
        elif shorts and a.startswith("-w") and not a.startswith("--") and len(a) > 2:
            found = True                      # -w2 / -w=2 (argparse 가 받는 붙임 형태)
            got = a[2:].lstrip("=")
        if got is not None:
            raw = got
        i += 1
    if not found:
        return None, False
    try:
        return int(str(raw).strip()), True
    except (TypeError, ValueError):
        return None, True


def _has_config_flag(argv: list[str]) -> bool:
    """gunicorn 의 설정 파일 지정(-c / --config) 여부 — 설정 파일이 workers 를 덮을 수 있다."""
    for a in argv:
        if a in ("-c", "--config") or a.startswith("--config="):
            return True
        if a.startswith("-c") and not a.startswith("--") and len(a) > 2:
            return True
    return False


def detect_worker_plan(argv: list[str] | None = None,
                       environ: dict | None = None) -> dict:
    """기동 시 '몇 워커로 뜰 예정인가'를 **선언(argv+env)만 보고** 판정한다.

    반환: {'server': 'uvicorn'|'gunicorn'|None, 'workers': int,
           'source': 'cli'|'WEB_CONCURRENCY'|'reload'|'config-file'|'default',
           'certain': bool, 'server_software': bool}

    순수 함수다(프로세스를 세지 않는다). uvicorn·gunicorn 모두 워커 프로세스 안에서도
    sys.argv 가 마스터의 것 그대로 보존되므로, 앱 import 시점에 자기가 몇 워커로 떴는지
    알 수 있다. 판정 순서는 실제 동작을 그대로 따른다:
      (a) argv[0] 이 uvicorn/gunicorn CLI 가 아니면 판단하지 않는다(server=None, workers=1).
      (b) uvicorn + --reload 면 uvicorn 이 workers 를 **무시**하고 1개만 띄운다 → 1 확정.
      (c) 명시 플래그(--workers/-w)가 env·설정파일을 이긴다.
      (d) 플래그가 없으면 WEB_CONCURRENCY(uvicorn·gunicorn 공통 기본값).
      (e) 아무것도 없으면 1.
    certain=False 는 '워커 수를 확정할 수 없다'는 뜻이며, 이때는 기동을 막지 않는다.
    """
    argv = list(sys.argv if argv is None else argv)
    env = os.environ if environ is None else environ
    plan: dict = {"server": None, "workers": 1, "source": "default",
                  "certain": True, "server_software": False}

    server = _argv0_server(argv[0] if argv else "")
    if server is None:
        return plan
    plan["server"] = server
    plan["server_software"] = str(env.get("SERVER_SOFTWARE", "")).startswith(_GUNICORN)
    rest = argv[1:]

    # (b) uvicorn --reload 는 workers 를 무시한다(uvicorn 이 경고를 찍고 1개만 띄운다).
    if server == _UVICORN and any(a in ("--reload", "-r") for a in rest):
        plan["source"] = "reload"
        return plan

    # (c) 명시 플래그 우선
    value, found = _read_workers_flag(rest, server)
    if found:
        plan["source"] = "cli"
        if value is None:
            plan["certain"] = False          # 값이 이상하다 → 판단하지 않는다
            return plan
        plan["workers"] = max(1, value)
        return plan                          # 설정파일·env 를 이긴다

    # gunicorn 설정 파일은 argv/env 어디에도 workers 를 남기지 않는다 → 확정 불가로 표시
    if server == _GUNICORN and _has_config_flag(rest):
        plan["certain"] = False
        plan["source"] = "config-file"

    # (d) WEB_CONCURRENCY (gunicorn/config.py 의 workers 기본값, uvicorn 도 동일 문서화)
    wc = str(env.get("WEB_CONCURRENCY", "")).strip()
    if wc:
        try:
            plan["workers"] = max(1, int(wc))
            plan["source"] = "WEB_CONCURRENCY"
        except ValueError:
            plan["certain"] = False
    return plan


# ── 다중 워커 게이트: 무한 재기동 루프 차단 ────────────────────────────────────
# 왜 이게 필요한가 (실측, uvicorn 0.34.0)
#   validate_for_prod() 는 lifespan 안에서 호출되므로 RuntimeError 가 나는 곳은
#   **워커 자식 프로세스**다. uvicorn 의 supervisors/multiprocess.py 는 0.5초마다
#   keep_subprocess_alive() 를 돌려 죽은 워커를 무한히 다시 띄운다(gunicorn arbiter 동일).
#   실측: `SAINTVIEW_ENV=prod uvicorn app.main:app --port 8794 --workers 2` →
#   30초 동안 'Started server process' 8회 / 'Application startup failed' 8회, 로그 1334줄.
#   매 사이클 앱 전체를 spawn 으로 재import(≈3.7초, 전부 CPU) 하고 마스터는 끝내 안 죽는다.
#   즉 예외만 던져서는 문서가 말하는 '기동 거부'가 되지 않는다.
#   (포트는 LISTEN 으로는 안 보인다 — 마스터가 bind_socket() 으로 bind 만 해 두고 listen() 은
#    워커가 하기 때문이다. 그러나 소켓은 점유돼 있어 다른 프로세스는 bind 에 실패한다.)
# → 그래서 예외를 던지기 **전에** 마스터에게 종료 신호를 보내 루프 자체를 끊는다.
_KILL_MASTER_ENV = "SAINTVIEW_WORKER_GATE_KILL_MASTER"


def _parent_is_server_master(server: str, ppid: int) -> bool | None:
    """부모가 정말 그 서버(uvicorn/gunicorn)의 마스터인지 확인한다.

    True=맞다 / False=아니다(좀비·커널스레드 포함) / None=확인 수단이 없다(리눅스가 아님).
    확인 불가(None)일 때 진행을 허용하는 근거: 호출부가 이미 '내 argv[0] 이 그 서버 CLI 다'
    를 확정했고, 다중 워커 모드에서 그 CLI 프로세스의 자식은 마스터의 자식뿐이다.
    """
    try:
        if os.name != "posix" or not Path("/proc").is_dir():
            return None
        base = Path(f"/proc/{ppid}")
        if not base.exists():
            return False
        raw = base.joinpath("cmdline").read_bytes().replace(b"\x00", b" ")
        text = raw.decode("utf-8", "replace").strip().lower()
        if not text:
            return False                     # 커널 스레드(cmdline 이 비어 있다)
        return server in text
    except Exception:  # noqa: BLE001 — 확인 실패는 '모름' 이다
        return None


def terminate_worker_master(plan: dict,
                            argv: list[str] | None = None,
                            getppid=None,
                            kill=None,
                            environ: dict | None = None,
                            verify=None) -> str | None:
    """다중 워커가 **확실**할 때 부모(마스터)를 함께 내려 무한 재기동 루프를 끊는다.

    반환: 실제로 한 일(로그용 문자열) 또는 None(아무것도 하지 않음).
    인자는 전부 테스트 주입구다 — 기본값이면 진짜 sys.argv/os.getppid/os.kill 을 쓴다.

    **오발 방지 조건**(하나라도 어긋나면 아무것도 하지 않는다):
      (a) SAINTVIEW_WORKER_GATE_KILL_MASTER=0 이면 끈다(운영자 탈출구).
      (b) plan 이 certain 이고 workers>=2 이며 server 가 정해져 있다.
      (c) **진짜** sys.argv[0] 이 그 서버 CLI 다 — plan 이 주입/모의된 경우(pytest 등)에는
          여기서 걸러진다. 이 조건이 '남의 셸을 죽이는' 최악의 사고를 막는 핵심이다.
      (d) ppid 가 0/1 이 아니다(부모가 이미 사라져 init 로 reparent 된 상태면 손대지 않는다).
      (e) 리눅스면 /proc/<ppid>/cmdline 에 그 서버 이름이 실제로 들어 있다.
    """
    try:
        env = os.environ if environ is None else environ
        if str(env.get(_KILL_MASTER_ENV, "1")).strip().lower() in ("0", "false", "no", "off"):
            return None                                                    # (a)
        server = plan.get("server")
        if not (plan.get("certain") and int(plan.get("workers", 1)) >= 2
                and server in (_UVICORN, _GUNICORN)):
            return None                                                    # (b)
        real_argv = list(sys.argv if argv is None else argv)
        if _argv0_server(real_argv[0] if real_argv else "") != server:
            return None                                                    # (c)
        ppid = int((os.getppid if getppid is None else getppid)())
        if ppid <= 1:
            return None                                                    # (d)
        if (_parent_is_server_master if verify is None else verify)(server, ppid) is False:
            return None                                                    # (e)
        sig = signal.SIGTERM
        (os.kill if kill is None else kill)(ppid, sig)
        return f"{server} 마스터(pid={ppid})에 SIGTERM 전송 — 워커 재기동 루프 차단"
    except Exception:  # noqa: BLE001 — 루프 차단 실패가 게이트 자체를 삼키면 본말전도다
        return None    # 실패 = '아무것도 못 했다'. 호출부가 수동 종료 안내를 붙인다.


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
    # ⚠ 기본값은 127.0.0.1 — 'localhost' 는 IPv6(::1) 우선 조회 후 IPv4 폴백으로 연결당 ~200ms
    # 지연이 붙어 프레임 로딩이 느려진다(실측: localhost 219ms vs 127.0.0.1 11ms).
    orthanc_url: str = os.getenv("SAINTVIEW_ORTHANC_URL", "http://127.0.0.1:8042")
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
    # 가입(공개) — **기본 비활성**. 켜려면 SAINTVIEW_SIGNUP_ENABLED=1 을 명시해야 한다.
    # 왜 기본을 뒤집었나: /api/signup 은 무인증으로 병원+관리자 계정을 즉석 생성한다. 그 계정으로
    # 로그인하면 픽셀 쿠키(sv_pix)가 발급되므로, 기본이 켜져 있으면 익명 공격자가 '가입→로그인'
    # 두 번으로 Live PHI 픽셀 게이트를 통째로 우회한다(인증이 셀프서비스 = 실질 무인증).
    # 승인 절차(app/api/signup.py — enabled=False 생성)와 함께 2중으로 막는다.
    signup_enabled: bool = os.getenv("SAINTVIEW_SIGNUP_ENABLED", "0") == "1"
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
        if self.signup_enabled:
            problems.append(
                "SAINTVIEW_SIGNUP_ENABLED: prod 는 공개 자가가입 금지(0으로 내려라) — "
                "무인증 가입은 '가입→로그인' 두 번으로 Live 픽셀(PHI) 인증을 통째로 우회한다. "
                "병원/계정 등록은 관리자 콘솔(/api/admin/hospitals·accounts)로 한다."
            )
        # 단일 워커 배포 계약 — 확실할 때만 막는다(certain=False 면 기동을 방해하지 않는다).
        plan = detect_worker_plan()
        multi = bool(plan["certain"] and plan["workers"] >= 2)
        if multi:
            problems.append(
                f"워커 {plan['workers']}개({plan['server']}, 근거={plan['source']}): "
                + MULTI_WORKER_MESSAGE
            )
        if problems:
            tail = ""
            if multi:
                # ⚠ 이 예외는 **워커 자식**에서 난다 — 마스터를 함께 내리지 않으면
                #    '기동 거부' 가 아니라 무한 재기동 루프가 된다(위 주석의 실측 참조).
                acted = terminate_worker_master(plan)
                tail = ("\n(루프 차단: " + acted + ")") if acted else (
                    "\n⚠ 마스터를 내리지 못했다 — 이 예외는 워커 자식에서 나므로 마스터가 "
                    "0.5초마다 워커를 다시 띄워 무한 재기동 루프가 된다(포트는 마스터가 "
                    "점유한 채, 요청은 전부 실패). 마스터 프로세스를 직접 종료한 뒤 "
                    "--workers 1 로 다시 띄워라: pkill -f 'uvicorn.*--workers'")
            raise RuntimeError("prod 보안 게이트 실패:\n- " + "\n- ".join(problems) + tail)


@lru_cache
def get_settings() -> Settings:
    return Settings()
