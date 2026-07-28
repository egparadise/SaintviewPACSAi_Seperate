"""단일 워커 배포 계약 게이트.

세 갈래를 모두 덮는다:
  · 다중 워커로 보이는 입력  → workers>=2, certain=True (prod 기동 거부)
  · 단일 워커로 보이는 입력  → workers==1 (절대 막지 않는다 — 오탐이 최악이다)
  · 판단 불가 입력           → certain=False (경고만, 기동은 막지 않는다)

실제 프로세스는 하나도 띄우지 않는다 — argv/env/마커디렉터리를 전부 주입한다.
"""
import pytest

from app.config import detect_worker_plan

UV = "/usr/local/lib/python3.11/site-packages/uvicorn/__main__.py"
GU = "/usr/local/lib/python3.11/site-packages/gunicorn/__main__.py"
UV_SCRIPT = "/opt/saintview-viewer/venv/bin/uvicorn"
UV_WIN = r"C:\Python311\Scripts\uvicorn.exe"


# ══════════════════════ 1. 다중 워커로 보이는 입력 ══════════════════════
@pytest.mark.parametrize("argv, env, expect_workers, expect_source", [
    # uvicorn --workers N (실험: 워커 프로세스에서도 argv 가 마스터 것 그대로 보존된다)
    ([UV, "app.main:app", "--port", "8010", "--workers", "2"], {}, 2, "cli"),
    ([UV, "app.main:app", "--workers=4"], {}, 4, "cli"),
    # 콘솔 스크립트로 뜬 경우도 같다
    ([UV_SCRIPT, "app.main:app", "--workers", "3"], {}, 3, "cli"),
    ([UV_WIN, "app.main:app", "--workers", "2"], {}, 2, "cli"),
    # gunicorn -w N / --workers N
    ([GU, "-w", "2", "app.main:app"], {}, 2, "cli"),
    ([GU, "-w4", "app.main:app"], {}, 4, "cli"),
    ([GU, "--workers=8", "app.main:app"], {}, 8, "cli"),
    # 플래그 없이 WEB_CONCURRENCY 만 — argv 에는 흔적이 없다(uvicorn·gunicorn 공통 기본값)
    ([UV, "app.main:app"], {"WEB_CONCURRENCY": "2"}, 2, "WEB_CONCURRENCY"),
    ([GU, "app.main:app"], {"WEB_CONCURRENCY": "3"}, 3, "WEB_CONCURRENCY"),
    # 같은 플래그가 여러 번이면 마지막이 이긴다(click·argparse 공통)
    ([UV, "app.main:app", "--workers", "1", "--workers", "4"], {}, 4, "cli"),
])
def test_multi_worker_is_detected(argv, env, expect_workers, expect_source):
    plan = detect_worker_plan(argv=argv, environ=env)
    assert plan["workers"] == expect_workers
    assert plan["source"] == expect_source
    assert plan["certain"] is True, "확실한 신호인데 certain=False 면 게이트가 안 걸린다"
    assert plan["server"] in ("uvicorn", "gunicorn")


# ══════════════════════ 2. 단일 워커로 보이는 입력 (오탐 금지) ══════════════════════
@pytest.mark.parametrize("argv, env, why", [
    # 현행 기동 명령 그대로 — start_viewer_suite.bat:55 / backend/server_restart.bat:22
    ([UV, "app.main:app", "--port", "8010", "--log-level", "warning"], {}, "현행 기동"),
    ([UV, "app.main:app", "--port", "8000", "--log-level", "warning"], {}, "현행 기동(8000)"),
    # [오탐 증거] uvicorn 은 --reload 가 있으면 workers 를 무시하고 1개만 띄운다
    ([UV, "app.main:app", "--workers", "2", "--reload"], {}, "--reload 가 workers 를 무시"),
    ([UV, "app.main:app", "--reload"], {"WEB_CONCURRENCY": "4"}, "--reload 는 env 도 무시"),
    # [우선순위] 명시 플래그가 WEB_CONCURRENCY 를 이긴다
    ([UV, "app.main:app", "--workers", "1"], {"WEB_CONCURRENCY": "4"}, "--workers 1 이 이긴다"),
    ([GU, "-w", "1", "app.main:app"], {"WEB_CONCURRENCY": "4"}, "-w 1 이 이긴다"),
    # 값이 그대로 1
    ([GU, "--workers=1", "app.main:app"], {}, "gunicorn -w 1"),
    # WEB_CONCURRENCY=1
    ([UV, "app.main:app"], {"WEB_CONCURRENCY": "1"}, "WEB_CONCURRENCY=1"),
])
def test_single_worker_is_never_blocked(argv, env, why):
    plan = detect_worker_plan(argv=argv, environ=env)
    assert plan["workers"] == 1, f"오탐: 정상 단일 워커 기동을 막는다 ({why})"


@pytest.mark.parametrize("argv", [
    # argv[0] 게이트 — 우리가 uvicorn/gunicorn CLI 밑이 아니면 아예 판단하지 않는다.
    ["/usr/local/lib/python3.11/site-packages/pytest/__main__.py", "-q"],
    ["/opt/venv/bin/pytest", "backend/tests"],
    ["/opt/venv/bin/alembic", "upgrade", "head", "--workers", "4"],
    ["-c"],                                   # python -c "..."
    [""],                                     # 임베디드/대화형
    ["/opt/tools/my-launcher", "--workers", "8", "uvicorn", "app.main:app"],  # 남의 래퍼
    ["/opt/venv/bin/uvicorn.py", "--workers", "4"],  # uvicorn 을 흉내낸 스크립트
    [],
])
def test_non_server_argv0_is_ignored(argv):
    plan = detect_worker_plan(argv=argv, environ={"WEB_CONCURRENCY": "8"})
    assert plan["server"] is None
    assert plan["workers"] == 1
    assert plan["certain"] is True
    assert plan["source"] == "default"


# ══════════════════════ 3. 판단 불가 입력 (경고만) ══════════════════════
@pytest.mark.parametrize("argv, env", [
    # [미탐] gunicorn 설정 파일이 workers 를 정할 수 있다 — argv/env 어디에도 안 나온다
    ([GU, "-c", "gunicorn.conf.py", "app.main:app"], {}),
    ([GU, "--config", "/etc/gunicorn.conf.py", "app.main:app"], {}),
    ([GU, "--config=/etc/gunicorn.conf.py", "app.main:app"], {}),
    ([GU, "-c/etc/gunicorn.conf.py", "app.main:app"], {}),
    # 값이 정수가 아니다 → 추측하지 않는다
    ([UV, "app.main:app", "--workers", "auto"], {}),
    ([UV, "app.main:app", "--workers"], {}),
    ([UV, "app.main:app"], {"WEB_CONCURRENCY": "many"}),
])
def test_uncertain_never_blocks(argv, env):
    plan = detect_worker_plan(argv=argv, environ=env)
    assert plan["certain"] is False, "확정 불가인데 certain=True 면 오탐/오차단 위험"


def test_config_file_with_explicit_flag_is_certain():
    """gunicorn 은 CLI 가 설정 파일을 덮는다 → -c 가 있어도 -w 명시면 확정이다."""
    plan = detect_worker_plan(argv=[GU, "-c", "conf.py", "-w", "2", "app.main:app"], environ={})
    assert plan["workers"] == 2
    assert plan["certain"] is True


def test_server_software_env_is_recorded():
    plan = detect_worker_plan(argv=[GU, "-w", "2", "app.main:app"],
                              environ={"SERVER_SOFTWARE": "gunicorn/26.0.0"})
    assert plan["server"] == "gunicorn"
    assert plan["server_software"] is True


def test_real_argv_does_not_trip_the_gate():
    """지금 이 pytest 실행의 진짜 sys.argv 로도 게이트가 걸리면 안 된다."""
    plan = detect_worker_plan()
    assert plan["workers"] == 1
    assert plan["certain"] is True


# ══════════════════════ prod 게이트 연동 ══════════════════════
def _strong(monkeypatch, s):
    monkeypatch.setattr(s, "env", "prod")
    monkeypatch.setattr(s, "jwt_secret", "x" * 48)
    monkeypatch.setattr(s, "orthanc_password", "strong-orthanc-pw")
    monkeypatch.setattr(s, "database_url", "postgresql+psycopg2://u:p@h/db")
    monkeypatch.setenv("SAINTVIEW_ADMIN_PASSWORD", "strong-admin-pw")


def test_prod_gate_rejects_multi_worker(monkeypatch):
    import app.config as cfg

    s = cfg.Settings()
    _strong(monkeypatch, s)
    monkeypatch.setattr(cfg, "detect_worker_plan",
                        lambda *a, **k: {"server": "uvicorn", "workers": 4,
                                         "source": "cli", "certain": True,
                                         "server_software": False})
    with pytest.raises(RuntimeError) as exc:
        s.validate_for_prod()
    msg = str(exc.value)
    assert "워커 4개" in msg
    assert "--workers 1" in msg          # 어떻게 하라는지까지 적혀 있어야 한다


def test_prod_gate_allows_uncertain_multi_worker(monkeypatch):
    """확정 불가(gunicorn 설정 파일)면 기동을 막지 않는다 — 오탐이 최악이다."""
    import app.config as cfg

    s = cfg.Settings()
    _strong(monkeypatch, s)
    monkeypatch.setattr(cfg, "detect_worker_plan",
                        lambda *a, **k: {"server": "gunicorn", "workers": 2,
                                         "source": "config-file", "certain": False,
                                         "server_software": True})
    s.validate_for_prod()  # 예외 없음


def test_dev_never_blocked_by_multi_worker(monkeypatch):
    import app.config as cfg

    s = cfg.Settings()
    monkeypatch.setattr(s, "env", "dev")
    monkeypatch.setattr(cfg, "detect_worker_plan",
                        lambda *a, **k: {"server": "uvicorn", "workers": 8,
                                         "source": "cli", "certain": True,
                                         "server_software": False})
    s.validate_for_prod()  # dev 는 즉시 return — 예외 없음


# ══════════════════════ 런타임 백스톱(형제 세기) ══════════════════════
from app.services import worker_guard  # noqa: E402


def _mk(tmp_path, ppid, pids):
    for pid in pids:
        (tmp_path / worker_guard.marker_name(ppid, pid)).write_text(str(pid))
    return tmp_path


def test_siblings_multi(tmp_path):
    """같은 ppid 아래 살아있는 워커 2개 → 다중 워커."""
    _mk(tmp_path, 100, [201, 202])
    n = worker_guard.count_live_siblings(tmp_path, ppid=100, alive=lambda p: True)
    assert n == 2


def test_siblings_single(tmp_path):
    """구 프로세스(다른 ppid)와 죽은 마커가 섞여 있어도 1로 센다 — 재기동 오탐 방지."""
    _mk(tmp_path, 100, [201, 999])          # 999 는 죽은 워커
    _mk(tmp_path, 555, [301, 302])          # 재기동 전 살아남은 구 서버(부모가 다르다)
    n = worker_guard.count_live_siblings(tmp_path, ppid=100, alive=lambda p: p != 999)
    assert n == 1
    # 죽은 마커는 정리된다
    assert not (tmp_path / worker_guard.marker_name(100, 999)).exists()
    # 남의 ppid 마커는 건드리지 않는다
    assert (tmp_path / worker_guard.marker_name(555, 301)).exists()


def test_siblings_unknown_gives_up(tmp_path):
    """pid 생사를 모르면 검사 자체를 포기한다(None) — 추측해서 경고하지 않는다."""
    _mk(tmp_path, 100, [201, 202])
    assert worker_guard.count_live_siblings(tmp_path, ppid=100, alive=lambda p: None) is None
    # 디렉터리가 아예 없어도 판단 불가
    assert worker_guard.count_live_siblings(tmp_path / "nope", ppid=100,
                                            alive=lambda p: True) is None
    # 판정 포기 시 마커를 지우지 않는다
    assert (tmp_path / worker_guard.marker_name(100, 201)).exists()


def test_siblings_ignores_foreign_files(tmp_path):
    _mk(tmp_path, 100, [201])
    (tmp_path / "w-100-notapid").write_text("x")
    (tmp_path / "README").write_text("x")
    assert worker_guard.count_live_siblings(tmp_path, ppid=100, alive=lambda p: True) == 1


def test_snapshot_reflects_check(tmp_path):
    worker_guard.reset_for_test()
    assert worker_guard.snapshot() == {"multi_worker": False, "worker_count": None}
    _mk(tmp_path, 700, [801, 802])
    worker_guard.check_once(tmp_path, ppid=700, alive=lambda p: True)
    assert worker_guard.snapshot() == {"multi_worker": True, "worker_count": 2}
    worker_guard.reset_for_test()
    worker_guard.check_once(tmp_path, ppid=700, alive=lambda p: p == 801)
    assert worker_guard.snapshot() == {"multi_worker": False, "worker_count": 1}
    worker_guard.reset_for_test()


def test_write_marker_failure_is_silent(monkeypatch, tmp_path):
    """마커를 못 써도 서버는 정상 동작해야 한다(백스톱이 새 실패 모드가 되면 안 된다).

    런타임 디렉터리 자리에 **파일**이 있어 mkdir 이 실패하는 상황을 만든다
    (권한 없는 경로에서 실제로 나는 실패와 같은 계열).
    """
    blocker = tmp_path / "blocker"
    blocker.write_text("not a directory")
    monkeypatch.setenv("SAINTVIEW_RUNTIME_DIR", str(blocker))
    assert worker_guard.write_marker() is None
    worker_guard.remove_marker()  # 예외 없음
    # 검사도 조용히 '판단 불가' 로 떨어진다
    assert worker_guard.count_live_siblings() is None


def test_status_exposes_worker_fields(client):
    r = client.get("/api/status")
    assert r.status_code == 200
    body = r.json()
    assert "multi_worker" in body and "worker_count" in body
    assert body["multi_worker"] is False  # 테스트는 단일 프로세스다


# ══════════════════ 4. 무한 재기동 루프 차단 (마스터 종료) ══════════════════
# 게이트 예외는 **워커 자식**에서 난다 — 마스터를 함께 내리지 않으면 '기동 거부'가 아니라
# 0.5초 주기 무한 재기동 루프가 된다(실측 uvicorn 0.34.0: 30초에 8회, 로그 1334줄).
import app.config as cfg  # noqa: E402

_PLAN2 = {"server": "uvicorn", "workers": 2, "source": "cli",
          "certain": True, "server_software": False}


def _spy():
    calls = []
    return calls, lambda pid, sig: calls.append((pid, sig))


def test_master_is_terminated_when_multi_worker_is_certain():
    calls, kill = _spy()
    got = cfg.terminate_worker_master(_PLAN2, argv=[UV, "app.main:app", "--workers", "2"],
                                      getppid=lambda: 4242, kill=kill,
                                      environ={}, verify=lambda s, p: True)
    assert got and "4242" in got
    import signal as _sig
    assert calls == [(4242, _sig.SIGTERM)]


def test_master_is_never_touched_when_argv0_is_not_the_server():
    """가장 중요한 안전장치 — plan 이 모의됐어도 진짜 argv[0] 이 서버 CLI 가 아니면 손대지 않는다.

    이게 없으면 pytest·스크립트에서 게이트가 돌 때 **남의 셸을 죽인다**.
    """
    calls, kill = _spy()
    for argv in (["/opt/venv/bin/pytest", "-q"], ["/opt/tools/my-launcher"], [""], []):
        assert cfg.terminate_worker_master(_PLAN2, argv=argv, getppid=lambda: 4242,
                                           kill=kill, environ={},
                                           verify=lambda s, p: True) is None
    assert calls == []


@pytest.mark.parametrize("plan, ppid, env, verify, why", [
    ({**_PLAN2, "certain": False}, 4242, {}, lambda s, p: True, "확정 불가면 손대지 않는다"),
    ({**_PLAN2, "workers": 1}, 4242, {}, lambda s, p: True, "단일 워커"),
    ({**_PLAN2, "server": None}, 4242, {}, lambda s, p: True, "서버 미확정"),
    (_PLAN2, 1, {}, lambda s, p: True, "부모가 init — reparent 된 상태"),
    (_PLAN2, 0, {}, lambda s, p: True, "부모 없음"),
    (_PLAN2, 4242, {"SAINTVIEW_WORKER_GATE_KILL_MASTER": "0"}, lambda s, p: True, "운영자 탈출구"),
    (_PLAN2, 4242, {}, lambda s, p: False, "부모가 uvicorn 마스터가 아니다"),
])
def test_master_kill_guards(plan, ppid, env, verify, why):
    calls, kill = _spy()
    assert cfg.terminate_worker_master(plan, argv=[UV, "app.main:app", "--workers", "2"],
                                       getppid=lambda: ppid, kill=kill,
                                       environ=env, verify=verify) is None, why
    assert calls == [], why


def test_master_kill_failure_never_raises():
    """루프 차단 실패가 게이트 자체를 삼키면 본말전도다 — 예외를 밖으로 내보내지 않는다."""
    def boom(pid, sig):
        raise PermissionError("no such process")

    assert cfg.terminate_worker_master(_PLAN2, argv=[UV, "--workers", "2"],
                                       getppid=lambda: 4242, kill=boom,
                                       environ={}, verify=lambda s, p: True) is None


def test_prod_gate_message_warns_when_master_was_not_killed(monkeypatch):
    """마스터를 못 내렸으면 '무한 재기동 루프' 와 조치 명령이 메시지에 반드시 들어간다."""
    s = cfg.Settings()
    _strong(monkeypatch, s)
    monkeypatch.setattr(cfg, "detect_worker_plan", lambda *a, **k: dict(_PLAN2))
    monkeypatch.setattr(cfg, "terminate_worker_master", lambda *a, **k: None)
    with pytest.raises(RuntimeError) as exc:
        s.validate_for_prod()
    msg = str(exc.value)
    assert "무한 재기동 루프" in msg
    assert "pkill" in msg


def test_prod_gate_message_reports_loop_break(monkeypatch):
    s = cfg.Settings()
    _strong(monkeypatch, s)
    monkeypatch.setattr(cfg, "detect_worker_plan", lambda *a, **k: dict(_PLAN2))
    monkeypatch.setattr(cfg, "terminate_worker_master", lambda *a, **k: "SIGTERM 보냄")
    with pytest.raises(RuntimeError) as exc:
        s.validate_for_prod()
    assert "루프 차단: SIGTERM 보냄" in str(exc.value)


def test_prod_gate_does_not_touch_master_for_other_problems(monkeypatch):
    """다중 워커가 아닌 이유로 게이트가 걸릴 때는 부모에게 아무 신호도 보내지 않는다."""
    s = cfg.Settings()
    _strong(monkeypatch, s)
    monkeypatch.setattr(s, "jwt_secret", "short")
    monkeypatch.setattr(cfg, "detect_worker_plan",
                        lambda *a, **k: {"server": None, "workers": 1, "source": "default",
                                         "certain": True, "server_software": False})
    called = []
    monkeypatch.setattr(cfg, "terminate_worker_master",
                        lambda *a, **k: called.append(a) or "x")
    with pytest.raises(RuntimeError):
        s.validate_for_prod()
    assert called == []


# ══════════════════ 5. 형제 정의: ppid 만으로는 안 된다 ══════════════════
def _stat_line(pid: int, comm: str, state: str, starttime: int) -> str:
    """리눅스 /proc/<pid>/stat 한 줄. fields[0]=state(3번), fields[19]=starttime(22번)."""
    fields = [state] + ["0"] * 18 + [str(starttime)] + ["0"] * 30
    return f"{pid} ({comm}) " + " ".join(fields) + "\n"


def _fake_proc(tmp_path, monkeypatch, procs: dict):
    """가짜 /proc 을 만들고 SAINTVIEW_PROC_DIR 로 물린다. procs = {pid: (comm, state, start)}."""
    root = tmp_path / "proc"
    root.mkdir(parents=True, exist_ok=True)
    for pid, (comm, state, start) in procs.items():
        d = root / str(pid)
        d.mkdir(parents=True, exist_ok=True)
        (d / "stat").write_text(_stat_line(pid, comm, state, start), encoding="ascii")
    monkeypatch.setenv("SAINTVIEW_PROC_DIR", str(root))
    return root


def test_ppid_1_gives_up_entirely(tmp_path):
    """ppid<=1(데몬화·systemd·컨테이너)에서는 '같은 부모=형제'가 성립하지 않는다 → 검사 포기.

    억지로 세면 한 호스트의 무관한 백엔드 2대가 서로를 형제로 오인한다(오탐 > 미탐 금지).
    """
    _mk(tmp_path, 1, [201, 202])
    assert worker_guard.count_live_siblings(tmp_path, ppid=1, alive=lambda p: True) is None
    _mk(tmp_path, 0, [301])
    assert worker_guard.count_live_siblings(tmp_path, ppid=0, alive=lambda p: True) is None


def test_zombie_is_counted_as_dead(tmp_path, monkeypatch):
    """/proc/<pid> 는 좀비에도 존재한다 — update_server.sh 가 kill -0 을 버린 것과 같은 함정."""
    _fake_proc(tmp_path, monkeypatch, {
        501: ("python3", "S", 111),   # 살아있음
        502: ("python3", "Z", 222),   # 좀비 = 죽은 것
    })
    assert worker_guard.pid_alive(501) is True
    assert worker_guard.pid_alive(502) is False
    assert worker_guard.pid_alive(503) is False  # /proc 에 아예 없다


def test_proc_identity_survives_weird_comm(tmp_path, monkeypatch):
    """comm 에 공백·괄호가 들어가도 starttime 을 정확히 뽑는다(마지막 ')' 기준)."""
    _fake_proc(tmp_path, monkeypatch, {601: ("uvi corn) x", "S", 987654)})
    assert worker_guard.proc_identity(601) == "987654"
    assert worker_guard.proc_identity(999999) == ""   # 없으면 빈 문자열(대조 생략)


def _mk2(d, ppid, pid, parent_id, self_id):
    (d / worker_guard.marker_name(ppid, pid)).write_text(
        f"pid={pid}\nself_id={self_id}\nppid={ppid}\nparent_id={parent_id}\n", encoding="ascii")


def test_parent_identity_mismatch_is_not_a_sibling(tmp_path):
    """ppid 가 재사용된 경우 — 옛 부모 밑의 마커를 형제로 세면 안 된다."""
    _mk2(tmp_path, 100, 201, parent_id="OLD", self_id="a")
    _mk2(tmp_path, 100, 202, parent_id="NOW", self_id="b")
    n = worker_guard.count_live_siblings(tmp_path, ppid=100, alive=lambda p: True,
                                         parent_id="NOW",
                                         identity=lambda p: {201: "a", 202: "b"}.get(p, ""),
                                         self_pid=999)
    assert n == 1
    assert not (tmp_path / worker_guard.marker_name(100, 201)).exists()   # 잔여 마커 정리
    assert (tmp_path / worker_guard.marker_name(100, 202)).exists()


def test_pid_reuse_ghost_is_not_a_sibling(tmp_path):
    """pid 는 재사용된다(pid_max=32768) — 살아있는 pid 라도 신원이 다르면 남의 프로세스다."""
    _mk2(tmp_path, 100, 201, parent_id="NOW", self_id="a")
    _mk2(tmp_path, 100, 202, parent_id="NOW", self_id="b")      # 202 는 죽고 pid 가 재사용됨
    n = worker_guard.count_live_siblings(tmp_path, ppid=100, alive=lambda p: True,
                                         parent_id="NOW",
                                         identity=lambda p: {201: "a", 202: "OTHER"}.get(p, ""),
                                         self_pid=999)
    assert n == 1, "pid 재사용을 걸러내지 못하면 단일 워커를 다중 워커로 오탐한다"
    assert not (tmp_path / worker_guard.marker_name(100, 202)).exists()


def test_matching_identities_count_as_siblings(tmp_path):
    """진짜 형제 2개(부모·자기 신원 모두 일치)는 정상적으로 잡아야 한다 — 미탐도 안 된다."""
    _mk2(tmp_path, 100, 201, parent_id="NOW", self_id="a")
    _mk2(tmp_path, 100, 202, parent_id="NOW", self_id="b")
    n = worker_guard.count_live_siblings(tmp_path, ppid=100, alive=lambda p: True,
                                         parent_id="NOW",
                                         identity=lambda p: {201: "a", 202: "b"}.get(p, ""),
                                         self_pid=201)
    assert n == 2


def test_identity_unavailable_falls_back_to_old_behaviour(tmp_path):
    """리눅스가 아니면 starttime 이 없다 → 대조를 생략하고 기존 판정(생사)만 쓴다."""
    _mk2(tmp_path, 100, 201, parent_id="", self_id="")
    _mk2(tmp_path, 100, 202, parent_id="", self_id="")
    n = worker_guard.count_live_siblings(tmp_path, ppid=100, alive=lambda p: True,
                                         parent_id="", identity=lambda p: "", self_pid=999)
    assert n == 2


# ══════════════════ 6. 마커 디렉터리 스코프 (/tmp 전역 공유 회피) ══════════════════
def test_runtime_dir_is_scoped_per_instance(monkeypatch, tmp_path):
    """포트가 다른 백엔드는 마커 디렉터리가 갈려야 한다 — /tmp 는 호스트 전역이다."""
    monkeypatch.setenv("SAINTVIEW_RUNTIME_DIR", str(tmp_path))
    monkeypatch.setattr(worker_guard.sys, "argv", ["/x/uvicorn", "app.main:app", "--port", "8010"])
    a = worker_guard.runtime_dir()
    monkeypatch.setattr(worker_guard.sys, "argv", ["/x/uvicorn", "app.main:app", "--port", "8000"])
    b = worker_guard.runtime_dir()
    assert a != b
    assert a.parent == b.parent == tmp_path / "saintview-worker-guard"


@pytest.mark.parametrize("argv, port", [
    (["/x/uvicorn", "app.main:app", "--port", "8010"], "8010"),
    (["/x/uvicorn", "app.main:app", "--port=8000"], "8000"),
    (["/x/gunicorn", "-b", "127.0.0.1:8011", "app.main:app"], "8011"),
    (["/x/gunicorn", "--bind=0.0.0.0:8012", "app.main:app"], "8012"),
    (["/x/uvicorn", "app.main:app"], ""),
    (["/x/uvicorn", "--port", "notaport"], ""),
])
def test_argv_port_extraction(argv, port):
    assert worker_guard.argv_port(argv) == port


def test_marker_roundtrip_records_identities(monkeypatch, tmp_path):
    """마커에 자기·부모 신원이 실제로 적히고, 다시 읽힌다."""
    monkeypatch.setenv("SAINTVIEW_RUNTIME_DIR", str(tmp_path))
    p = worker_guard.write_marker()
    assert p is not None and p.exists()
    meta = worker_guard.parse_marker(p.read_text(encoding="ascii"))
    import os as _os
    assert meta["pid"] == str(_os.getpid())
    assert meta["ppid"] == str(_os.getppid())
    assert "self_id" in meta and "parent_id" in meta
    worker_guard.remove_marker()
    assert not p.exists()
