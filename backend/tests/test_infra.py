"""인프라(레인 O) — 컨테이너 액션 화이트리스트·병원 프로비저닝 템플릿 치환(docker 모킹)·
DDNS URL 조립·토큰 마스킹·병원별 Orthanc URL 해석(공유 폴백).

main.py 라우터 등록은 레인 H(통합) 몫이므로 여기서는 로컬 앱에 infra 라우터만 마운트해 검증한다.
"""
from __future__ import annotations

import subprocess
import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import infra
from app.api.deps import admin_user
from app.models import Hospital
from app.services import ddns_service, docker_service


@pytest.fixture(scope="module")
def infra_client():
    app = FastAPI()
    app.include_router(infra.router)
    app.dependency_overrides[admin_user] = lambda: {"uid": 1, "role": "admin", "username": "admin"}
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c


def _ok_cp(stdout: str = "ok") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")


# ════════════════════════════ 컨테이너 액션 화이트리스트 ════════════════════════════
def test_container_action_rejects_arbitrary_names(infra_client, monkeypatch):
    """saintview-* 아닌 이름·주입 시도는 docker 호출 없이 400."""
    called = []
    monkeypatch.setattr(docker_service, "_docker", lambda *a, **k: called.append(a) or _ok_cp())
    for bad in ("postgres", "saintview-db;rm", "saintview-a b", "saintview-$(reboot)", "-saintview-x"):
        r = infra_client.post(f"/api/infra/containers/{bad}/action", json={"action": "restart"})
        assert r.status_code == 400, f"{bad!r} → {r.status_code}"
    assert called == []  # 화이트리스트 위반은 docker 에 절대 도달하지 않는다


def test_container_action_rejects_unknown_action(infra_client, monkeypatch):
    called = []
    monkeypatch.setattr(docker_service, "_docker", lambda *a, **k: called.append(a) or _ok_cp())
    r = infra_client.post("/api/infra/containers/saintview-ohif/action", json={"action": "exec"})
    assert r.status_code == 400
    assert called == []


def test_container_action_allows_whitelisted(infra_client, monkeypatch):
    seen: list[list[str]] = []

    def fake_docker(args, timeout=120):
        seen.append(args)
        return _ok_cp("saintview-ohif")

    monkeypatch.setattr(docker_service, "_docker", fake_docker)
    r = infra_client.post("/api/infra/containers/saintview-ohif/action", json={"action": "restart"})
    assert r.status_code == 200 and r.json()["ok"] is True
    assert seen == [["restart", "saintview-ohif"]]  # 인자 리스트 그대로(shell 미경유)


# ════════════════════════════ 병원 프로비저닝 (docker 모킹) ════════════════════════════
def _mk_hospital(db) -> int:
    h = Hospital(code=f"T{uuid.uuid4().hex[:8]}", name="테스트병원")
    db.add(h)
    db.commit()
    db.refresh(h)
    return h.id


def test_provision_renders_template_and_records_registry(infra_client, db, tmp_path, monkeypatch):
    hid = _mk_hospital(db)
    compose_calls = []

    def fake_compose(args, compose_file, project):
        compose_calls.append({"args": args, "file": str(compose_file), "project": project})
        return _ok_cp()

    monkeypatch.setattr(docker_service, "_compose", fake_compose)
    monkeypatch.setattr(docker_service, "generated_dir", lambda: tmp_path)

    r = infra_client.post(f"/api/infra/hospitals/{hid}/provision")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True

    # 치환 결과 파일 — 자리표시자 잔존 없음 + 핵심 값 반영
    rendered = (tmp_path / f"hospital-h{hid}.yml").read_text(encoding="utf-8")
    assert "{{" not in rendered
    assert f"saintview-orthanc-h{hid}" in rendered
    assert f"SAINTVIEW_H{hid}" in rendered
    entry = body["entry"]
    assert f'"{entry["web_port"]}:8042"' in rendered
    assert f'"{entry["dicom_port"]}:4242"' in rendered

    # compose up -d 가 렌더링된 파일·병원 프로젝트로 호출됨
    assert compose_calls and compose_calls[0]["args"] == ["up", "-d"]
    assert compose_calls[0]["project"] == f"saintview-h{hid}"

    # 레지스트리(infra.containers) 기록 — 병원별 URL 해석의 근거
    reg = docker_service.get_registry(db)
    assert reg[str(hid)]["url"] == f"http://localhost:{entry['web_port']}"
    assert reg[str(hid)]["container"] == f"saintview-orthanc-h{hid}"


def test_provision_unknown_hospital_404(infra_client):
    assert infra_client.post("/api/infra/hospitals/999999/provision").status_code == 404


def test_allocate_ports_skips_used():
    registry = {
        "1": {"dicom_port": 4301, "web_port": 8101},
        "2": {"dicom_port": 4303, "web_port": 8103},  # hid=3 기본 포트를 선점
    }
    dicom, web = docker_service.allocate_ports(registry, 3)
    assert dicom == 4304 and web == 8104  # 충돌 → 다음 빈 포트
    # 자기 자신의 기존 포트는 재사용(멱등)
    dicom1, web1 = docker_service.allocate_ports(registry, 1)
    assert dicom1 == 4301 and web1 == 8101


# ════════════════════════════ DDNS — URL 조립·토큰 마스킹 ════════════════════════════
def test_ddns_build_update_url():
    cfg = {"provider": "duckdns", "domain": "myhosp.duckdns.org", "token": "tok-123"}
    assert ddns_service.build_update_url(cfg, "1.2.3.4") == (
        "https://www.duckdns.org/update?domains=myhosp.duckdns.org&token=tok-123&ip=1.2.3.4"
    )
    dynu = {"provider": "dynu", "domain": "h.dynu.net", "token": "pw"}
    assert ddns_service.build_update_url(dynu, "5.6.7.8") == (
        "https://api.dynu.com/nic/update?hostname=h.dynu.net&password=pw&myip=5.6.7.8"
    )
    custom = {"provider": "custom", "domain": "d", "token": "t",
              "url_template": "https://x/u?h={domain}&k={token}&i={ip}"}
    assert ddns_service.build_update_url(custom, "9.9.9.9") == "https://x/u?h=d&k=t&i=9.9.9.9"
    with pytest.raises(ValueError):
        ddns_service.build_update_url({"provider": "nope"}, "1.1.1.1")
    with pytest.raises(ValueError):  # custom 인데 템플릿 없음
        ddns_service.build_update_url({"provider": "custom", "url_template": ""}, "1.1.1.1")


def test_ddns_token_masked_in_api_and_preserved_on_resave(infra_client, db):
    secret = "super-secret-token"
    r = infra_client.put("/api/infra/ddns", json={
        "provider": "duckdns", "domain": "h.duckdns.org", "token": secret,
        "interval_min": 15, "enabled": False,
    })
    assert r.status_code == 200, r.text
    # 응답 어디에도 원문 토큰이 없다 (마스킹 •••• + token_set 플래그만)
    assert secret not in r.text
    assert r.json()["config"]["token_set"] is True

    g = infra_client.get("/api/infra/ddns")
    assert g.status_code == 200 and secret not in g.text

    # 마스크된 토큰(••••)을 그대로 재저장해도 원본 토큰이 유지된다
    masked = g.json()["config"]
    r2 = infra_client.put("/api/infra/ddns", json={**masked, "domain": "h2.duckdns.org"})
    assert r2.status_code == 200
    raw = ddns_service.get_config(db)
    assert raw["token"] == secret and raw["domain"] == "h2.duckdns.org"


def test_ddns_sanitize_strips_token():
    assert "tok" not in ddns_service._sanitize("https://x/u?token=tok failed", "tok")


def test_ddns_custom_requires_template(infra_client):
    r = infra_client.put("/api/infra/ddns", json={
        "provider": "custom", "domain": "d", "enabled": True, "url_template": "",
    })
    assert r.status_code == 400


# ════════════════════════════ 병원별 Orthanc URL 해석 (공유 폴백) ════════════════════════════
def test_orthanc_url_resolution_with_fallback(db):
    from app.config import get_settings
    from app.dicom.orthanc import client_for_hospital, orthanc_url_for_hospital

    reg = docker_service.get_registry(db)
    reg["777"] = {"container": "saintview-orthanc-h777", "url": "http://localhost:8877",
                  "dicom_port": 5077, "web_port": 8877, "volume": "/v", "aet": "SAINTVIEW_H777"}
    docker_service.save_registry(db, reg)

    assert orthanc_url_for_hospital(db, 777) == "http://localhost:8877"
    assert orthanc_url_for_hospital(db, 424242) is None  # 미등록 → 공유 폴백
    assert orthanc_url_for_hospital(db, None) is None

    c = client_for_hospital(db, 777)
    try:
        assert str(c._client.base_url).rstrip("/") == "http://localhost:8877"
    finally:
        c.close()
    shared = client_for_hospital(db, 424242)
    try:  # 기존 동작 무회귀 — 공유 Orthanc URL 그대로
        assert str(shared._client.base_url).rstrip("/") == get_settings().orthanc_url.rstrip("/")
    finally:
        shared.close()
