"""단일 워커 배포 계약의 **런타임 백스톱** — 감지만 하고 절대 기동을 거부하지 않는다.

왜 필요한가
    config.detect_worker_plan() 은 argv+env 만 보므로 두 경로를 못 잡는다:
      · gunicorn `-c gunicorn.conf.py` 안의 `workers = 2`
      · 프로그램적 `uvicorn.run(..., workers=2)`
    이 경우에도 워커들은 **같은 부모** 아래 형제로 뜬다. 그래서 각 워커가 런타임
    디렉터리에 마커를 남기고, 잠시 뒤 살아있는 형제 수를 세면 알 수 있다.

'형제' 를 무엇으로 정의하는가 — ppid 만으로는 부족하다
    ppid 는 재사용되고(리눅스 기본 pid_max=32768), 데몬화된 프로세스는 ppid 가 1 로
    고정되며, /tmp 는 호스트 전역이라 무관한 인스턴스끼리 섞인다. 그래서 네 겹으로 좁혔다:
      (1) ppid<=1 이면 **검사 자체를 포기**한다(None). systemd Type=simple 이나 컨테이너
          init 밑에서는 '같은 부모' 라는 정의가 성립하지 않는다 — 그 구간에서 억지로
          세면 무관한 백엔드 2대를 형제로 오인한다. 미탐이 오탐보다 낫다.
      (2) 마커 디렉터리를 **설치경로+포트 스코프**로 가른다(/tmp 전역 공유 회피).
      (3) 마커에 부모와 자신의 **starttime**(리눅스 /proc/<pid>/stat 22번째 필드)을 적고,
          계수할 때 현재 값과 대조한다 → pid 재사용으로 살아난 유령 형제를 배제한다.
      (4) **좀비(state=Z)는 죽은 것으로 센다.** `/proc/<pid>` 는 좀비에도 존재한다 —
          deploy/update_server.sh 가 `kill -0` 을 버리고 포트 해제로 판정하는 것과 같은 이유다.

왜 여기서는 거부하지 않는가
    이미 요청을 받고 있는 워커를 죽이면 supervisor 가 무한 재기동 루프에 빠진다.
    → logger.error + /api/status 노출까지만 한다.
    (기동 시점의 '확실한' 다중 워커는 config.validate_for_prod() 가 마스터까지 내려 막는다.)

설계 원칙: **이 모듈이 새로운 실패 모드가 되면 본말전도다.**
    · 모든 파일 I/O 는 실패해도 조용히 포기한다(마커를 못 써도 서버는 정상 동작).
    · pid 생사·신원 판정이 불가능하면 검사 자체를 포기한다(추측하지 않는다).
    · 죽은 pid 의 마커만 지운다 — 살아있는지 모르면 아무것도 지우지 않는다.
"""
from __future__ import annotations

import hashlib
import logging
import os
import sys
import tempfile
from pathlib import Path

logger = logging.getLogger("saintview")

_DIR_NAME = "saintview-worker-guard"
_PREFIX = "w-"

# 마지막 검사 결과(표시용). 값 자체가 정합성에 쓰이지 않으므로 워커별로 달라도 무해하다.
_state: dict = {"checked": False, "count": None, "warned": False}
_marker_path: Path | None = None


# ── 런타임 디렉터리 ──────────────────────────────────────────────────────────
def _install_root() -> str:
    """이 백엔드의 설치 경로(.../backend). 인스턴스 스코프의 1차 키."""
    try:
        return str(Path(__file__).resolve().parents[2])
    except Exception:  # noqa: BLE001
        return ""


def argv_port(argv: list[str] | None = None) -> str:
    """기동 인자에서 포트를 뽑는다(못 뽑으면 ''). 마스터/워커가 argv 를 공유하므로 형제끼리 같다.

    uvicorn `--port N`, gunicorn `-b host:port`/`--bind host:port` 를 본다.
    """
    a = list(sys.argv if argv is None else argv)
    for i, t in enumerate(a):
        v: str | None = None
        if t in ("--port", "-b", "--bind") and i + 1 < len(a):
            v = a[i + 1]
        elif t.startswith("--port=") or t.startswith("--bind="):
            v = t.split("=", 1)[1]
        if v is None:
            continue
        tail = str(v).rsplit(":", 1)[-1].strip()
        if tail.isdigit():
            return tail
    return ""


def scope_token(argv: list[str] | None = None) -> str:
    """인스턴스 스코프 토큰 — 설치경로+포트.

    한 호스트에서 서로 다른 백엔드(운영 8010 / 스테이징 8000 / 다른 병원)를 돌려도
    마커가 섞이지 않는다. /tmp 는 호스트 전역(systemd 기본 PrivateTmp=no)이라 필요하다.
    """
    raw = f"{_install_root()}|{argv_port(argv)}"
    return hashlib.sha1(raw.encode("utf-8", "replace")).hexdigest()[:12]


def runtime_dir() -> Path:
    """마커 디렉터리. SAINTVIEW_RUNTIME_DIR 로 override 가능(권한 문제 회피용)."""
    base = os.getenv("SAINTVIEW_RUNTIME_DIR") or tempfile.gettempdir()
    return Path(base) / _DIR_NAME / scope_token()


def marker_name(ppid: int, pid: int) -> str:
    return f"{_PREFIX}{ppid}-{pid}"


# ── /proc 기반 신원·상태 ─────────────────────────────────────────────────────
def proc_dir() -> Path | None:
    """리눅스 /proc 경로(없으면 None).

    SAINTVIEW_PROC_DIR 로 override 할 수 있다 — 윈도우 개발기에서 리눅스 전용 분기를
    **실제로 테스트하기 위한** 주입구다(읽기 전용 진단 경로라 운영 위험이 없다).
    """
    override = os.getenv("SAINTVIEW_PROC_DIR")
    try:
        if override:
            p = Path(override)
            return p if p.is_dir() else None
        if os.name != "posix":
            return None
        p = Path("/proc")
        return p if p.is_dir() else None
    except Exception:  # noqa: BLE001
        return None


def _proc_stat_fields(pid: int) -> list[str] | None:
    """/proc/<pid>/stat 을 comm 이후로 잘라 필드 리스트로 준다.

    반환 리스트의 [0] 이 stat 3번 필드(state)다 — comm 에 공백·괄호가 들어갈 수 있어
    반드시 **마지막 ')'** 뒤부터 잘라야 한다(예: `(uvi corn)` 같은 이름).
    """
    root = proc_dir()
    if root is None:
        return None
    try:
        raw = (root / str(pid) / "stat").read_text(encoding="utf-8", errors="replace")
        return raw[raw.rindex(")") + 1:].split()
    except Exception:  # noqa: BLE001
        return None


def proc_identity(pid: int) -> str:
    """pid 의 '신원' — 리눅스 starttime(stat 22번째 필드). 못 구하면 ''.

    pid 는 재사용되지만 (pid, starttime) 쌍은 사실상 유일하다. 리눅스가 아니면 ''를
    돌려주고, 그때는 대조를 생략한다(대조 없이도 기존 동작 이상으로 나빠지지 않는다).
    """
    f = _proc_stat_fields(pid)
    if not f or len(f) <= 19:               # index 19 == stat 22번째 필드(starttime)
        return ""
    return f[19]


def pid_alive(pid: int) -> bool | None:
    """True=살아있음 / False=죽음 / None=판정 불가(→ 호출자는 검사를 포기해야 한다).

    ⚠ Windows 에서 os.kill(pid, 0) 을 쓰면 안 된다 — CPython 은 이를
      TerminateProcess(handle, 0) 으로 구현하므로 **대상 프로세스를 실제로 죽인다**.
    ⚠ 리눅스에서 `/proc/<pid>` 존재만 보면 **좀비를 살아있다고 센다**. 좀비는 이미
      종료된 프로세스이고 요청을 처리하지 않으므로 죽은 것으로 판정한다.
    """
    try:
        if pid <= 0:
            return False
        root = proc_dir()
        if root is not None:
            if not (root / str(pid)).exists():
                return False
            f = _proc_stat_fields(pid)
            if f and f[0] == "Z":
                return False     # 좀비 = 이미 죽었다(요청을 처리하지 않는다)
            return True
        if os.name == "nt":
            return _pid_alive_windows(pid)
    except Exception:  # noqa: BLE001 — 판정 실패는 '모름' 이지 오류가 아니다
        return None
    return None


def _pid_alive_windows(pid: int) -> bool | None:
    try:
        import ctypes
        from ctypes import wintypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k32.OpenProcess.restype = wintypes.HANDLE
        k32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        k32.GetExitCodeProcess.restype = wintypes.BOOL
        k32.CloseHandle.argtypes = [wintypes.HANDLE]

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False  # 없거나 접근 불가 — 과소집계(미탐)는 허용, 오탐은 금지
        try:
            code = wintypes.DWORD()
            if not k32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return None
            return code.value == 259  # STILL_ACTIVE
        finally:
            k32.CloseHandle(handle)
    except Exception:  # noqa: BLE001
        return None


# ── 마커 쓰기/지우기 ─────────────────────────────────────────────────────────
def marker_body(ppid: int, pid: int) -> str:
    """마커 내용 — 부모와 자신의 신원(starttime)까지 적는다(pid 재사용 방어)."""
    return (f"pid={pid}\n"
            f"self_id={proc_identity(pid)}\n"
            f"ppid={ppid}\n"
            f"parent_id={proc_identity(ppid)}\n")


def parse_marker(text: str) -> dict:
    """key=value 줄들을 dict 로. 옛 형식(pid 숫자만)이면 빈 dict — 대조를 생략한다."""
    out: dict = {}
    for line in str(text).splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def write_marker() -> Path | None:
    """자기 자신을 형제 목록에 등록한다. 실패하면 조용히 None(검사만 못 할 뿐)."""
    global _marker_path
    try:
        d = runtime_dir()
        d.mkdir(parents=True, exist_ok=True)
        ppid, pid = os.getppid(), os.getpid()
        p = d / marker_name(ppid, pid)
        p.write_text(marker_body(ppid, pid), encoding="ascii")
        _marker_path = p
        return p
    except Exception:  # noqa: BLE001
        return None


def remove_marker() -> None:
    global _marker_path
    try:
        if _marker_path is not None:
            _marker_path.unlink(missing_ok=True)
    except Exception:  # noqa: BLE001
        pass
    finally:
        _marker_path = None


# ── 형제 세기 ────────────────────────────────────────────────────────────────
def count_live_siblings(marker_dir: Path | str | None = None,
                        ppid: int | None = None,
                        alive=None,
                        parent_id: str | None = None,
                        identity=None,
                        self_pid: int | None = None) -> int | None:
    """같은 부모 아래 **살아있는** 워커 수. 판정 불가면 None(→ 아무 판단도 하지 않는다).

    인자는 전부 테스트용 주입구다(실제 프로세스를 띄우지 않고 표를 검증할 수 있게).
    """
    try:
        d = Path(marker_dir) if marker_dir is not None else runtime_dir()
        pp = os.getppid() if ppid is None else ppid
        is_alive = pid_alive if alive is None else alive
        ident = proc_identity if identity is None else identity
        me = os.getpid() if self_pid is None else self_pid
        # (1) 부모가 init(1)/없음(0) → '같은 부모=형제' 라는 정의가 성립하지 않는다.
        #     데몬화·systemd·컨테이너에서 무관한 인스턴스를 형제로 오인하느니 포기한다.
        if pp <= 1:
            return None
        if not d.is_dir():
            return None
        cur_parent = (parent_id if parent_id is not None else ident(pp)) or ""
        n = 0
        for f in sorted(d.glob(f"{_PREFIX}{pp}-*")):
            try:
                pid = int(f.name.rsplit("-", 1)[1])
            except (ValueError, IndexError):
                continue  # 우리 형식이 아닌 파일은 무시
            try:
                meta = parse_marker(f.read_text(encoding="ascii", errors="replace"))
            except OSError:
                meta = {}
            # (2) 부모 신원 대조 — ppid 가 재사용됐다면 이건 '다른 부모' 의 잔여 마커다.
            if cur_parent and meta.get("parent_id") and meta["parent_id"] != cur_parent:
                _drop(f)
                continue
            state = is_alive(pid)
            if state is None:
                return None  # 하나라도 모르면 전체 판정을 포기한다(오탐 금지)
            if not state:
                _drop(f)     # 죽은 워커의 잔여 마커만 정리
                continue
            # (3) 살아있는 pid 라도 **재사용된 남의 프로세스**일 수 있다 → 신원 대조.
            want = meta.get("self_id")
            if want and pid != me:
                now = ident(pid)
                if now and now != want:
                    _drop(f)
                    continue
            n += 1
        return n
    except Exception:  # noqa: BLE001
        return None


def _drop(f: Path) -> None:
    try:
        f.unlink(missing_ok=True)
    except OSError:
        pass


def check_once(marker_dir: Path | str | None = None,
               ppid: int | None = None,
               alive=None,
               **kw) -> int | None:
    """1회 검사 + 다중 워커면 경고 로그(워커당 1회). 반환은 형제 수(또는 None)."""
    n = count_live_siblings(marker_dir, ppid, alive, **kw)
    _state["checked"] = True
    _state["count"] = n
    if n is not None and n >= 2 and not _state["warned"]:
        _state["warned"] = True
        from app.config import MULTI_WORKER_MESSAGE

        logger.error("[다중 워커 감지 — 런타임] 같은 부모 아래 워커 %d개가 돌고 있다. %s",
                     n, MULTI_WORKER_MESSAGE)
    return n


def snapshot() -> dict:
    """/api/status 노출용. multi_worker 는 '확실히 2개 이상' 일 때만 True."""
    n = _state["count"]
    return {"multi_worker": bool(n is not None and n >= 2), "worker_count": n}


def reset_for_test() -> None:
    _state.update({"checked": False, "count": None, "warned": False})
