"""레인 S — 보안 강화(방어적) 테스트.

잠금 임계·리셋·잠금 중 401 / allowlist 차단·통과·자기잠금 경고 /
무결성 감지(의심 확장자·대량 변화·백업 변조) / Defender 우아 강등.
"""
import pytest

from app.services import security_service as sec
from app.services.settings_service import set_setting

# main.py 의 security 라우터 등록은 레인 H 몫(guarded try-import 계약) — 병합 전에도
# 이 레인의 테스트가 자립하도록 미등록 시에만 여기서 등록한다(중복 등록 방지).
from app.api import security as _security_api  # noqa: E402
from app.main import app as _app  # noqa: E402

if not any(getattr(r, "path", "").startswith("/api/security") for r in _app.routes):
    _app.include_router(_security_api.router)


@pytest.fixture(autouse=True)
def _reset_security(db):
    """각 테스트 전후 인메모리 잠금·정책·스냅샷 초기화(테스트 간 오염 방지)."""
    sec.reset_state()
    set_setting(db, sec.POLICY_KEY, {}, scope="global")
    set_setting(db, sec.INTEGRITY_KEY, {}, scope="global")
    yield
    sec.reset_state()
    set_setting(db, sec.POLICY_KEY, {}, scope="global")
    set_setting(db, sec.INTEGRITY_KEY, {}, scope="global")


# ════════════════════════════ ③ 로그인 실패 잠금 ════════════════════════════
def test_lockout_after_threshold_then_401(client, db):
    """연속 실패 N회 → 잠금 → 올바른 비밀번호로도 401."""
    sec.set_policy(db, {"threshold": 3, "lock_min": 15})
    for _ in range(3):
        r = client.post("/api/auth/login", json={"username": "admin", "password": "wrong-pw"})
        assert r.status_code == 401
    # 잠금 중 — 올바른 비밀번호도 401 + 잠금 안내
    r = client.post("/api/auth/login", json={"username": "admin", "password": "admin1234"})
    assert r.status_code == 401
    assert "잠금" in r.json()["detail"]
    # 잠금 현황에 계정·IP 키가 잡힌다
    ov = sec.lockout_overview()
    assert any(l["key"] == "user:admin" for l in ov["locked"])
    # 해제 후 정상 로그인
    sec.reset_state()
    r = client.post("/api/auth/login", json={"username": "admin", "password": "admin1234"})
    assert r.status_code == 200


def test_lockout_counter_resets_on_success(client, db):
    """성공 로그인 시 카운터 리셋 — 임계 3에서 2실패+성공+2실패는 잠기지 않는다."""
    sec.set_policy(db, {"threshold": 3, "lock_min": 15})
    for _ in range(2):
        assert client.post("/api/auth/login",
                           json={"username": "admin", "password": "bad"}).status_code == 401
    assert client.post("/api/auth/login",
                       json={"username": "admin", "password": "admin1234"}).status_code == 200
    for _ in range(2):
        assert client.post("/api/auth/login",
                           json={"username": "admin", "password": "bad"}).status_code == 401
    # 아직 잠금 아님 — 올바른 비밀번호로 로그인 가능
    assert client.post("/api/auth/login",
                       json={"username": "admin", "password": "admin1234"}).status_code == 200
    assert sec.lockout_overview()["locked"] == []


def test_lockout_admin_reset_endpoint(client, auth_headers, db):
    """관리자 잠금 해제 API — 존재하지 않는 계정 잠금도 요약에 잡히고 해제된다."""
    sec.set_policy(db, {"threshold": 2, "lock_min": 15})
    for _ in range(2):
        client.post("/api/auth/login", json={"username": "ghost", "password": "bad"})
    r = client.get("/api/security/summary", headers=auth_headers)
    assert r.status_code == 200
    assert any(l["key"] == "user:ghost" for l in r.json()["lockouts"]["locked"])
    # 전체 해제
    r = client.post("/api/security/lockouts/reset", headers=auth_headers, json={"key": ""})
    assert r.status_code == 200 and r.json()["ok"]
    assert r.json()["lockouts"]["locked"] == []


# ════════════════════════════ ③ 관리자 IP allowlist ════════════════════════════
def test_allowlist_blocks_and_passes(client, auth_headers, db):
    """allowlist 미포함 IP → 403, 포함(정확 일치) → 통과, 빈 목록 → 제한 없음."""
    # TestClient 의 client.host 는 'testclient' — CIDR 만 있으면 차단된다
    sec.set_policy(db, {"admin_allowlist": ["10.0.0.0/8"]})
    r = client.get("/api/security/summary", headers=auth_headers)
    assert r.status_code == 403
    # 정확 일치 항목 추가 → 통과
    sec.set_policy(db, {"admin_allowlist": ["10.0.0.0/8", "testclient"]})
    assert client.get("/api/security/summary", headers=auth_headers).status_code == 200
    # 빈 목록 → 제한 없음
    sec.set_policy(db, {"admin_allowlist": []})
    assert client.get("/api/security/summary", headers=auth_headers).status_code == 200


def test_allowlist_self_lock_warning(client, auth_headers, db):
    """자기 잠금 방지 — 현재 요청 IP 미포함 allowlist 저장 시 경고 반환(저장은 수행)."""
    r = client.put("/api/security/policy", headers=auth_headers,
                   json={"value": {"admin_allowlist": ["203.0.113.9"]}})
    assert r.status_code == 200
    assert r.json()["warning"]  # 경고 문자열 존재
    # 이후 보안 API 는 실제로 차단된다(경고의 의미 검증)
    assert client.get("/api/security/summary", headers=auth_headers).status_code == 403
    # 현재 IP 포함 저장 → 경고 없음 (직전 차단 상태이므로 서비스로 우선 복구)
    sec.set_policy(db, {"admin_allowlist": []})
    r = client.put("/api/security/policy", headers=auth_headers,
                   json={"value": {"admin_allowlist": ["testclient"]}})
    assert r.status_code == 200
    assert r.json()["warning"] == ""


def test_ip_allowed_cidr_and_exact():
    assert sec.ip_allowed("192.168.0.7", ["192.168.0.0/24"])
    assert not sec.ip_allowed("192.168.1.7", ["192.168.0.0/24"])
    assert sec.ip_allowed("testclient", ["testclient"])   # 호스트명 정확 일치
    assert sec.ip_allowed("1.2.3.4", [])                  # 빈 목록 = 제한 없음
    assert not sec.ip_allowed("", ["10.0.0.0/8"])         # IP 미확인 + 제한 존재 → 거부


# ════════════════════════════ ② 무결성 감시 (랜섬 방지 — 탐지) ════════════════════════════
def test_integrity_detects_suspicious_extension(client, auth_headers, db, tmp_path):
    watch = tmp_path / "spool"
    watch.mkdir()
    for i in range(5):
        (watch / f"img_{i}.dcm").write_bytes(b"x" * 100)
    sec.set_policy(db, {"watch_paths": [str(watch)]})
    # 기준선 스캔 — 이상 없음(해당 경로 기준)
    r = client.post("/api/security/integrity/scan", headers=auth_headers)
    assert r.status_code == 200
    assert not [a for a in r.json()["alerts"] if str(watch) in a]
    # 랜섬 의심 확장자 등장 → 경고
    (watch / "img_0.dcm.encrypted").write_bytes(b"y")
    (watch / "ransom.locked").write_bytes(b"y")
    r = client.post("/api/security/integrity/scan", headers=auth_headers)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "warn"
    assert any("의심 확장자" in a and str(watch) in a for a in body["alerts"])
    # 이력 조회에 경고가 남는다
    r = client.get("/api/security/integrity", headers=auth_headers)
    assert any("의심 확장자" in a["message"] for a in r.json()["alerts"])


def test_integrity_detects_mass_delete(db, tmp_path):
    watch = tmp_path / "storage"
    watch.mkdir()
    for i in range(20):
        (watch / f"f_{i}.dcm").write_bytes(b"data")
    sec.set_policy(db, {"watch_paths": [str(watch)], "mass_change_pct": 30})
    res = sec.run_integrity_scan(db)  # 기준선
    assert not [a for a in res["alerts"] if str(watch) in a]
    for i in range(15):  # 75% 삭제 — 임계 30% 초과
        (watch / f"f_{i}.dcm").unlink()
    res = sec.run_integrity_scan(db)
    assert res["status"] == "warn"
    assert any("대량 삭제" in a and str(watch) in a for a in res["alerts"])


def test_integrity_detects_mass_rename(db, tmp_path):
    """파일 수는 그대로인데 확장자 분포가 대량 이동 → 암호화(이름변경) 의심."""
    watch = tmp_path / "img"
    watch.mkdir()
    for i in range(20):
        (watch / f"f_{i}.dcm").write_bytes(b"data")
    sec.set_policy(db, {"watch_paths": [str(watch)], "mass_change_pct": 30})
    sec.run_integrity_scan(db)  # 기준선
    for i in range(20):  # 전부 다른 확장자로 이름변경(수는 동일) — .xyz 는 의심 목록엔 없음
        (watch / f"f_{i}.dcm").rename(watch / f"f_{i}.xyz")
    res = sec.run_integrity_scan(db)
    assert res["status"] == "warn"
    assert any("이름변경" in a and str(watch) in a for a in res["alerts"])


def test_backup_protection_hash_and_tamper(db, tmp_path):
    """백업 보호 — 읽기 전용 + 해시 기록, 내용 변조 시 SHA-256 불일치 경고."""
    import os
    import stat

    from app.services import backup_service

    backup_root = tmp_path / "backup"
    backup_root.mkdir()
    f = backup_root / "20260101" / "study1.dcm"
    f.parent.mkdir()
    f.write_bytes(b"DICM-original")
    old_backup = backup_service.get_policy(db).get("target_dir", "")
    try:
        backup_service.set_policy(db, {"target_dir": str(backup_root)})
        sec.set_policy(db, {"protect_backups": True, "watch_paths": []})
        res = sec.run_integrity_scan(db)
        assert not [a for a in res["alerts"] if "변조" in a]
        # 매니페스트 생성 + 파일 읽기 전용
        assert (backup_root / sec.MANIFEST_NAME).exists()
        assert not (f.stat().st_mode & stat.S_IWRITE)
        # 변조(랜섬 시뮬레이션이 아닌 단순 내용 교체) → 다음 검사에서 감지
        os.chmod(f, stat.S_IREAD | stat.S_IWRITE)
        f.write_bytes(b"DICM-tampered")
        res = sec.run_integrity_scan(db)
        assert res["status"] == "warn"
        assert any("변조 의심" in a for a in res["alerts"])
    finally:
        backup_service.set_policy(db, {"target_dir": old_backup})
        os.chmod(f, stat.S_IREAD | stat.S_IWRITE)  # tmp 정리 가능하도록 복구


# ════════════════════════════ ① Defender 우아 강등 ════════════════════════════
def test_defender_graceful_degradation(client, auth_headers, monkeypatch):
    """PowerShell 미가용 환경 — 500이 아니라 available=False 로 우아 강등."""
    def _boom(cmd, timeout=12):
        raise FileNotFoundError("powershell not found")

    monkeypatch.setattr(sec, "_run_powershell", _boom)
    r = client.get("/api/security/defender", headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["available"] is False
    assert r.json()["reason"]


def test_defender_scan_graceful_degradation(client, auth_headers, monkeypatch):
    import subprocess

    def _boom(*a, **k):
        raise FileNotFoundError("powershell not found")

    monkeypatch.setattr(subprocess, "Popen", _boom)
    r = client.post("/api/security/defender/scan", headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["started"] is False


def test_defender_status_parses_ps_json(monkeypatch):
    """PS 5.1 ConvertTo-Json 의 /Date(ms)/ 날짜 변환 포함 파싱."""
    payload = ('{"AMServiceEnabled":true,"AntivirusEnabled":true,'
               '"RealTimeProtectionEnabled":true,"AntivirusSignatureVersion":"1.2.3",'
               '"AntivirusSignatureLastUpdated":"\\/Date(1767225600000)\\/",'
               '"QuickScanEndTime":null,"FullScanEndTime":null}')
    monkeypatch.setattr(sec, "_run_powershell", lambda cmd, timeout=12: payload)
    st = sec.defender_status()
    assert st["available"] is True
    assert st["RealTimeProtectionEnabled"] is True
    assert st["AntivirusSignatureLastUpdated"].startswith("2026-01-01")


# ════════════════════════════ 종합 요약 ════════════════════════════
def test_summary_shape(client, auth_headers, db, monkeypatch):
    monkeypatch.setattr(sec, "defender_status", lambda: {"available": False, "reason": "test"})
    r = client.get("/api/security/summary", headers=auth_headers)
    assert r.status_code == 200
    body = r.json()
    assert set(body) >= {"defender", "integrity", "lockouts", "login_failures", "policy"}
    assert body["policy"]["threshold"] == 5  # 기본값
    assert "failed_total" in body["login_failures"]
