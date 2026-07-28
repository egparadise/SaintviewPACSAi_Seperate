"""동시성·캐시 회귀 관문 — 되돌리면 실패한다.

여기 모인 것들은 전부 "조용히 틀리는" 부류다. 예외도 500 도 안 나고, 화면에는 그럴듯한
결과가 뜬다. 그래서 발견이 늦고, PACS 에서는 오독·잠금·검은 타일로 사용자에게 도달한다.
각 테스트는 고치기 전 코드에서 실제로 실패하는 형태로 썼다.
"""
from __future__ import annotations

import threading
import time

import pytest


# ══════════════════════════ ① Live 시리즈 트리 캐시 키에 A 서버 ══════════════════════════
def test_tree_cache_is_keyed_by_a_server_not_just_vid(monkeypatch):
    """브리지 주소를 바꾸면 이전 서버의 트리를 내주면 안 된다.

    vid = VID_BASE + study_idx 이고 study_idx 는 **A 서버 로컬 시퀀스**다. 서버가 바뀌면
    같은 study_idx 가 전혀 다른 환자의 검사를 가리킨다. 예전 키는 vid 정수 하나뿐이라
    서버 X 에서 덥힌 트리를 서버 Y 의 같은 vid 에 그대로 내줬고, 그 UID 의 원본이 아직
    디스크 캐시에 남아 있으면 **이전 환자의 영상이 새 검사 화면에 그려졌다**.
    """
    from app.services import webpacs_live as live

    live.invalidate_tree()

    class FakeClient:
        def __init__(self, base_url: str, tag: str, n: int):
            self.base_url = base_url
            self._tag, self._n = tag, n

        def series_viewer(self, _idx):
            return [{
                "series_instance_uid": f"1.2.{self._tag}.1",
                "study_instance_uid": f"1.2.{self._tag}.0",
                "series_sequence": 1, "series_description": "AX",
                "images": [{"sop_instance_uid": f"1.2.{self._tag}.{i}",
                            "image_sequence": i} for i in range(1, self._n + 1)],
            }]

        def series_metadata(self, *_a, **_kw):
            return []

    x = FakeClient("http://server-x", "X", 2)
    y = FakeClient("http://server-y", "Y", 5)

    vid = live.VID_BASE + 1
    monkeypatch.setattr(live, "live_client", lambda db, user=None: x)
    tx = live.live_series_tree(None, vid, None)
    assert tx["study_uid"] == "1.2.X.0"
    assert len(tx["series"][0]["instances"]) == 2

    # 관리자가 브리지를 서버 Y 로 바꿨다 — TTL(30s) 이 남아 있어도 Y 의 값이 나와야 한다
    monkeypatch.setattr(live, "live_client", lambda db, user=None: y)
    ty = live.live_series_tree(None, vid, None)
    assert ty is not tx, "다른 A 서버인데 캐시된 같은 객체를 돌려줬다"
    assert ty["study_uid"] == "1.2.Y.0", f"이전 서버의 트리를 내줬다: {ty['study_uid']}"
    assert len(ty["series"][0]["instances"]) == 5

    # 그리고 X 는 여전히 자기 것을 유지한다(서버별로 따로 캐시된다)
    monkeypatch.setattr(live, "live_client", lambda db, user=None: x)
    assert live.live_series_tree(None, vid, None)["study_uid"] == "1.2.X.0"
    live.invalidate_tree()


def test_invalidate_tree_by_vid_clears_every_server(monkeypatch):
    """vid 로 무효화하면 어느 서버분이든 다 지워져야 한다(키가 튜플이 됐으므로)."""
    from app.services import webpacs_live as live

    live.invalidate_tree()
    vid = live.VID_BASE + 7
    with live._TREE_LOCK:
        live._TREE_CACHE[("http://a", vid)] = (time.time(), {"study_uid": "A"})
        live._TREE_CACHE[("http://b", vid)] = (time.time(), {"study_uid": "B"})
        live._TREE_CACHE[("http://a", vid + 1)] = (time.time(), {"study_uid": "keep"})

    live.invalidate_tree(vid)

    with live._TREE_LOCK:
        left = list(live._TREE_CACHE)
    assert left == [("http://a", vid + 1)], left
    live.invalidate_tree()


# ══════════════════════════ ② Live 디스크 캐시 프루닝 중단 ══════════════════════════
def test_prune_is_not_aborted_by_a_concurrent_delete(tmp_path, monkeypatch):
    """정렬 중에 파일 하나가 사라져도 정리는 끝까지 돌아야 한다.

    예전에는 `sorted(glob, key=lambda f: f.stat().st_mtime)` 라 stat 이 던진
    FileNotFoundError 가 바깥 `except OSError: pass` 에 잡혀 **정리 전체**가 중단됐다.
    한 파일 건너뛰기가 아니라 그 사이클 정리량이 0 이고, 다음 기회는 쓰기 256회 뒤라
    상한이 조용히 무시된다.
    """
    from app.services import webpacs_live as live

    monkeypatch.setattr(live, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(live, "CACHE_MAX_FILES", 10)
    monkeypatch.setattr(live, "_prune_counter", 0)

    files = []
    for i in range(60):
        p = tmp_path / f"sop{i:03d}.dcm"
        p.write_bytes(b"x")
        files.append(p)

    victim = files[30]

    class DirShim:
        """glob 이 이름을 내준 **직후** 한 건이 사라지는 상황을 결정적으로 만든다.
        실제로는 invalidate_instance(손상 캐시 삭제)나 다른 스레드의 프루닝이 그 역할을 한다."""

        def __init__(self, real):
            self._real = real

        def glob(self, pat):
            names = list(self._real.glob(pat))
            if pat == "*.dcm":
                victim.unlink(missing_ok=True)
            return iter(names)

        def __getattr__(self, name):
            return getattr(self._real, name)

    monkeypatch.setattr(live, "CACHE_DIR", DirShim(tmp_path))
    live._prune_cache(force=True)

    left = len(list(tmp_path.glob("*.dcm")))
    assert left <= 10, f"프루닝이 중단돼 상한을 넘겼다: {left}개 남음(상한 10)"


# ══════════════════════════ ③ HTJ2K 캐시 원자 쓰기 ══════════════════════════
def test_htj2k_cache_write_is_atomic(tmp_path):
    """쓰는 중에 읽어도 **빈 파일이 보이면 안 된다**.

    write_bytes() 는 'wb' 로 열어 먼저 0바이트로 자른다. 그 순간 다른 스레드가
    exists()→read_bytes() 하면 b"" 를 받아 Content-Length:0 인 정상 200 멀티파트를
    내보낸다 — 전송 오류가 아니라 성공이라 재시도도 안 걸리고 뷰어에 검은 타일이 남는다.
    실측된 찢긴 읽기는 전부 정확히 0바이트(=O_TRUNC 구간)였다.
    """
    from app.api import htj2k_stream as h

    payload = b"J2C!" + b"\xa5" * (512 * 1024 - 4)
    ROUNDS = 300
    # 매 회차 새 프레임 경로 — 실제로도 스크롤은 프레임마다 다른 파일을 만든다.
    # (같은 경로를 지웠다 다시 쓰면 Windows 에서 읽는 쪽이 열고 있어 unlink 가 거부돼
    #  경합 자체가 안 생긴다 — 그래서 경로를 돌린다.)
    cur = [tmp_path / "seed_1.j2c"]
    h._atomic_write(cur[0], payload)

    torn: list[tuple[str, int]] = []
    stop = threading.Event()

    def reader():
        # get_frame 의 적중 경로와 **같은 모양**: exists() 로 보고 read_bytes() 로 읽는다
        while not stop.is_set():
            p = cur[0]
            if p.exists():
                try:
                    b = p.read_bytes()
                except OSError:
                    continue
                if len(b) != len(payload):
                    torn.append((p.name, len(b)))

    ts = [threading.Thread(target=reader, daemon=True) for _ in range(6)]
    for t in ts:
        t.start()
    try:
        for i in range(ROUNDS):
            nxt = tmp_path / f"1.2.3.4_{i}.j2c"
            cur[0] = nxt              # 읽는 쪽이 즉시 이 경로를 보기 시작한다
            h._atomic_write(nxt, payload)
    finally:
        stop.set()
        for t in ts:
            t.join(timeout=5)

    assert not torn, f"찢긴 읽기 {len(torn)}건 (첫 {torn[:3]}) — 0바이트면 O_TRUNC 창"
    assert cur[0].read_bytes() == payload


def test_htj2k_atomic_write_leaves_no_part_files(tmp_path):
    """정상 경로에서 .part 가 남으면 안 된다(*.j2c glob 이 못 잡아 무한정 쌓인다)."""
    from app.api import htj2k_stream as h

    h._atomic_write(tmp_path / "1.2.3.4_1.j2c", b"x" * 4096)
    assert list(tmp_path.glob("*.j2c"))
    assert not list(tmp_path.glob("*.part"))


def test_htj2k_prune_reaps_orphan_part_files(tmp_path, monkeypatch):
    """중단으로 남은 오래된 .part 는 프루닝이 회수한다."""
    import os as _os

    from app.api import htj2k_stream as h

    monkeypatch.setattr(h, "CACHE", tmp_path)
    monkeypatch.setattr(h, "CACHE_MAX_MB", 100)
    old = tmp_path / "1.2.3_1.dead.part"
    old.write_bytes(b"x" * 1024)
    _os.utime(old, (time.time() - 7200, time.time() - 7200))
    fresh = tmp_path / "1.2.3_2.live.part"          # 진행 중인 쓰기는 건드리지 않는다
    fresh.write_bytes(b"x" * 1024)

    h._prune_cache(force=True)

    assert not old.exists(), "1시간 넘은 고아 .part 가 남았다"
    assert fresh.exists(), "진행 중일 수 있는 .part 를 지웠다"


def test_htj2k_inflight_guard_is_atomic_and_leak_free(monkeypatch):
    """같은 시리즈 프리인코딩은 1회만 뜨고, 스레드 생성이 실패하면 표시가 남지 않아야 한다."""
    from app.api import htj2k_stream as h

    h._inflight_series.clear()
    ser = "1.2.900.1"

    # 검사-후-추가가 원자적인가 — 락으로 감쌌으므로 한 스레드만 통과한다
    winners: list[bool] = []
    barrier = threading.Barrier(24)

    def contend():
        barrier.wait()
        with h._INFLIGHT_LOCK:
            new = ser not in h._inflight_series
            h._inflight_series.add(ser)
        if new:
            winners.append(True)

    ts = [threading.Thread(target=contend) for _ in range(24)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert len(winners) == 1, f"프리인코딩 스레드가 {len(winners)}개 떴다(기대 1)"
    h._inflight_series.clear()

    # Thread.start() 가 실패하면(스레드 고갈) 표시를 반드시 풀어야 한다 —
    # 안 그러면 그 시리즈는 프로세스가 죽을 때까지 다시는 프리인코딩되지 않는다.
    src = (h.__file__)
    with open(src, encoding="utf-8") as f:
        body = f.read()
    assert "except RuntimeError:" in body and "_inflight_series.discard(ser)" in body, \
        "Thread.start() 실패 시 in-flight 표시를 푸는 경로가 없다"


# ══════════════════════════ ④ 공유 A 클라이언트 토큰 ══════════════════════════
def test_shared_client_never_reverts_to_an_older_token():
    """같은 A 계정으로 창을 두 개 열어도 옛 토큰이 최신 토큰을 되덮으면 안 된다.

    per-user 클라이언트는 (base_url, a_user_id) 로 **공유**된다. 예전에는 세션 레코드의
    토큰을 무조건 대입해서, 창2 가 refresh 로 받은 새 토큰을 창1 의 다음 요청이 옛 값으로
    되덮었다 — 두 창이 서로의 토큰을 밀어내며 401 이 사용자에게 새어 나갔다.
    """
    from app.services import webpacs_live as live
    from app.services import webpacs_session

    live._user_clients.clear()
    base, uid = "http://a.example", "reader1"
    sess_a = {"sid": "sidA", "base_url": base, "a_user_id": uid,
              "token": "TOK-A", "refresh": "R", "token_ts": 100.0}
    sess_b = dict(sess_a, sid="sidB", token="TOK-B", token_ts=200.0)

    webpacs_session.clear("sidA")
    webpacs_session.clear("sidB")
    try:
        cli = live.user_client(sess_a)
        assert cli._token == "TOK-A"

        # 창2 가 더 새 토큰으로 들어온다 — 채택되어야 한다
        assert live.user_client(sess_b) is cli
        assert cli._token == "TOK-B"

        # 창1 이 옛 세션 레코드 그대로 다시 요청한다 — **되덮으면 안 된다**
        live.user_client(sess_a)
        assert cli._token == "TOK-B", "옛 토큰이 최신 토큰을 되덮었다(401 왕복의 원인)"
    finally:
        live._user_clients.clear()


def test_token_refresh_reaches_every_session_of_that_account():
    """토큰 갱신은 그 A 계정의 **모든** 세션에 반영돼야 한다.

    예전 on_token 은 클라이언트를 처음 만든 sid 에 못박혀 있어, 나중에 같은 계정으로
    들어온 창의 세션은 갱신을 영원히 못 받고 만료 토큰에 갇혔다(요청마다 401+refresh 왕복).
    """
    from app.services import webpacs_session

    base, uid = "http://a.example", "reader9"
    webpacs_session.put("sid1", {"base_url": base, "a_user_id": uid, "token": "OLD"})
    webpacs_session.put("sid2", {"base_url": base, "a_user_id": uid, "token": "OLD"})
    webpacs_session.put("sid3", {"base_url": base, "a_user_id": "other", "token": "KEEP"})
    try:
        n = webpacs_session.update_token_by_account(base, uid, "NEW")
        assert n == 2, n
        assert webpacs_session.get("sid1")["token"] == "NEW"
        assert webpacs_session.get("sid2")["token"] == "NEW"
        assert webpacs_session.get("sid3")["token"] == "KEEP"   # 다른 계정은 건드리지 않는다
    finally:
        for s in ("sid1", "sid2", "sid3"):
            webpacs_session.clear(s)


def test_authed_sends_the_token_it_will_compare_against():
    """헤더에 붙인 토큰과 stale 판정에 쓰는 토큰이 같아야 한다.

    예전 _authed 는 used = _ensure_token() 으로 읽은 뒤 _headers() 에서 self._token 을
    **다시** 읽었다. 그 사이 다른 스레드가 토큰을 바꾸면 요청은 새 토큰 Y 로 나가는데
    used 는 옛 토큰 X 라, 401 이 나도 _relogin_if_stale(X) 가 self._token(Y) != X 라며
    재인증을 건너뛰어 401 이 호출자에게 그대로 새어 나갔다.
    """
    import httpx

    from app.services.webpacs_bridge import WebPacsClient

    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("Authorization", ""))
        return httpx.Response(200, json={})

    cli = WebPacsClient("http://a.example", "u", token="TOK-X",
                        transport=httpx.MockTransport(handler))
    try:
        real_ensure = cli._ensure_token

        def racing_ensure():
            used = real_ensure()
            cli._token = "TOK-Y"      # 다른 스레드가 끼어들어 토큰을 바꾼 상황
            return used

        cli._ensure_token = racing_ensure
        cli._request("GET", "/x")
        assert seen[0] == "Bearer TOK-X", f"used 와 다른 토큰을 보냈다: {seen[0]}"
    finally:
        cli.close()


def test_adopt_token_ignores_stale_and_takes_newer():
    from app.services.webpacs_bridge import WebPacsClient

    cli = WebPacsClient("http://a.example", "u", token="T1")
    try:
        assert cli.adopt_token("T2", 50.0) is True     # _token_ts 는 0 — 더 새 것
        assert cli._token == "T2"
        assert cli.adopt_token("T1", 10.0) is False    # 더 오래된 것은 무시
        assert cli._token == "T2"
        assert cli.adopt_token("T3", 90.0) is True
        assert cli._token == "T3"
    finally:
        cli.close()


# ══════════════════════════ ⑤ 로그인 실패 카운터 ══════════════════════════
def test_failure_counter_clears_when_the_lockout_expires(monkeypatch):
    """잠금이 만료되면 카운터도 함께 0 이어야 한다.

    예전에는 _remaining 이 _locked_until 만 지우고 _fail_counts 는 남겼다. 그래서 형을
    다 치른 계정이 **오타 한 번**에 lock_min(기본 15분) 전체를 다시 맞았다. ip: 키도 같이
    올라 NAT 뒤 판독실 전체가 한 사람의 오타로 반복 차단됐다.
    """
    from app.services import security_service as sec

    sec.reset_state()
    now = [1_000_000.0]
    monkeypatch.setattr(sec.time, "time", lambda: now[0])
    monkeypatch.setattr(sec, "get_policy", lambda db: {"threshold": 3, "lock_min": 1})

    class _DB:
        def add(self, *_a, **_k): pass
        def commit(self): pass

    db = _DB()
    for _ in range(3):
        sec.record_login_failure(db, "reader", "10.0.0.9")
    assert sec.locked_remaining("reader", "10.0.0.9") > 0

    now[0] += 61          # 잠금 만료
    assert sec.locked_remaining("reader", "10.0.0.9") == 0
    assert sec._fail_counts.get("user:reader") in (None, 0), sec._fail_counts

    # 만료 뒤 오타 한 번 — 다시 잠기면 안 된다(임계는 3이다)
    sec.record_login_failure(db, "reader", "10.0.0.9")
    assert sec.locked_remaining("reader", "10.0.0.9") == 0, "오타 1회에 다시 잠겼다"
    sec.reset_state()


def test_failure_counter_decays_when_failures_are_not_consecutive(monkeypatch):
    """'연속 실패' 는 실제로 연속일 때만 쌓여야 한다 — 감쇠 창이 지나면 0 으로."""
    from app.services import security_service as sec

    sec.reset_state()
    now = [2_000_000.0]
    monkeypatch.setattr(sec.time, "time", lambda: now[0])
    monkeypatch.setattr(sec, "get_policy", lambda db: {"threshold": 3, "lock_min": 5})

    class _DB:
        def add(self, *_a, **_k): pass
        def commit(self): pass

    db = _DB()
    sec.record_login_failure(db, "reader2", "10.0.0.8")
    sec.record_login_failure(db, "reader2", "10.0.0.8")
    assert sec._fail_counts["user:reader2"] == 2

    now[0] += 5 * 60 + 1                     # 감쇠 창(lock_min) 경과
    sec.record_login_failure(db, "reader2", "10.0.0.8")
    assert sec._fail_counts["user:reader2"] == 1, "몇 분 전 오타가 오늘 잠금에 합산됐다"
    assert sec.locked_remaining("reader2", "10.0.0.8") == 0
    sec.reset_state()


# ══════════════════════════ ⑥ 모드 프로파일 ══════════════════════════
@pytest.mark.parametrize("key,expect", [("saintvidw", "sv"), ("infi", "infi"), ("ty", "ty")])
def test_every_mode_profile_carries_client_viewer(key, expect):
    """프로파일이 client_viewer 를 안 실으면 [적용]해도 뷰어가 안 바뀐다.

    SettingsModal 의 적용은 `{...현재값, ...prof.viewer, mode_key}` 병합이라 **없는 키는
    직전 값이 그대로 남는다**. 그래서 'SaintView' 를 골라도 화면은 I-View 그대로인데
    mode_key 만 저장돼 콤보에는 '적용됨' 으로 보였다(저장은 되는데 반영이 안 되는 증상).
    """
    from app.services.mode_profiles import DEFAULT_MODE_PROFILES

    prof = DEFAULT_MODE_PROFILES["profiles"][key]
    assert prof["viewer"].get("client_viewer") == expect, prof["viewer"]
