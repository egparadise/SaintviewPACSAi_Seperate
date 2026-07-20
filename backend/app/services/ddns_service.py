"""DDNS 갱신 서비스(레인 O) — duckdns/dynu/custom 공급자 + 주기 갱신 스레드.

설정(전역 `ddns.config`): {provider, domain, token, url_template, interval_min, enabled}
상태(전역 `ddns.status`): {last_ip, last_at, ok, detail}

보안: 토큰은 로그/응답에 절대 노출하지 않는다 — API 응답은 mask_config(),
httpx 예외 메시지는 _sanitize() 로 토큰을 지운 뒤 기록한다.
"""
from __future__ import annotations

import logging
import threading
from datetime import datetime, timezone

import httpx
from sqlalchemy.orm import Session

from app.services.settings_service import get_setting, set_setting

logger = logging.getLogger("saintview.infra.ddns")

DDNS_CONFIG_KEY = "ddns.config"   # 전역 설정 키 (global-only — 레인 H ALLOWED_KEYS 계약)
DDNS_STATUS_KEY = "ddns.status"

MASK = "••••"  # •••• — 프론트 왕복 시 '변경 없음' 표식

# 공급자별 갱신 URL 템플릿 — custom 은 사용자 url_template({domain}{token}{ip}) 사용
PROVIDER_TEMPLATES: dict[str, str] = {
    "duckdns": "https://www.duckdns.org/update?domains={domain}&token={token}&ip={ip}",
    "dynu": "https://api.dynu.com/nic/update?hostname={domain}&password={token}&myip={ip}",
}

_DEFAULTS: dict = {
    "provider": "duckdns",     # duckdns | dynu | custom
    "domain": "",
    "token": "",
    "url_template": "",        # custom 전용
    "interval_min": 30,
    "enabled": False,
}

# 공인 IP 조회 서비스(순서대로 시도)
_IP_SERVICES = ("https://api.ipify.org", "https://ifconfig.me/ip", "https://icanhazip.com")


def get_config(db: Session) -> dict:
    cfg = get_setting(db, DDNS_CONFIG_KEY, default={}) or {}
    out = dict(_DEFAULTS)
    if isinstance(cfg, dict):
        out.update({k: cfg[k] for k in _DEFAULTS if k in cfg})
    return out


def mask_config(cfg: dict) -> dict:
    """API 응답용 — 토큰은 마스킹, 설정 여부만 노출."""
    out = dict(cfg)
    token = str(out.pop("token", "") or "")
    out["token"] = MASK if token else ""
    out["token_set"] = bool(token)
    return out


def save_config(db: Session, patch: dict) -> dict:
    """설정 병합 저장 — 토큰이 빈값/마스크(••••)면 기존 토큰 유지."""
    cur = get_config(db)
    incoming_token = str(patch.get("token", MASK) or "")
    if incoming_token in ("", MASK, "****"):
        patch = {**patch, "token": cur["token"]}
    merged = {**cur, **{k: patch[k] for k in _DEFAULTS if k in patch}}
    merged["interval_min"] = max(1, int(merged.get("interval_min") or 30))
    set_setting(db, DDNS_CONFIG_KEY, merged, scope="global")
    return merged


def get_status(db: Session) -> dict:
    st = get_setting(db, DDNS_STATUS_KEY, default={}) or {}
    return st if isinstance(st, dict) else {}


def build_update_url(cfg: dict, ip: str) -> str:
    """공급자 갱신 URL 조립 — 순수 함수(pytest 검증). 미지원 공급자는 ValueError."""
    provider = str(cfg.get("provider", ""))
    if provider == "custom":
        template = str(cfg.get("url_template", "") or "")
        if not template:
            raise ValueError("custom 공급자는 url_template 이 필요합니다")
    else:
        template = PROVIDER_TEMPLATES.get(provider, "")
        if not template:
            raise ValueError(f"지원하지 않는 DDNS 공급자입니다: {provider!r}")
    return template.format(
        domain=str(cfg.get("domain", "")), token=str(cfg.get("token", "")), ip=ip
    )


def _sanitize(text: str, token: str) -> str:
    """오류 메시지에서 토큰 제거 — httpx 예외는 URL(토큰 포함)을 담을 수 있다."""
    return text.replace(token, MASK) if token else text


def fetch_public_ip(timeout: float = 10.0) -> str:
    last_err = ""
    for url in _IP_SERVICES:
        try:
            r = httpx.get(url, timeout=timeout)
            if r.status_code == 200 and r.text.strip():
                return r.text.strip()
            last_err = f"HTTP {r.status_code}"
        except httpx.HTTPError as e:
            last_err = str(e)[:120]
    raise RuntimeError(f"공인 IP 조회 실패: {last_err}")


def update_now(db: Session) -> dict:
    """공인 IP 조회 → 공급자 갱신 API 호출 → 상태 기록. 토큰은 어디에도 남기지 않는다."""
    cfg = get_config(db)
    token = str(cfg.get("token", ""))
    status: dict = {"last_at": datetime.now(timezone.utc).isoformat(), "ok": False,
                    "last_ip": "", "detail": ""}
    try:
        if not cfg.get("domain"):
            raise ValueError("도메인이 설정되어 있지 않습니다")
        ip = fetch_public_ip()
        status["last_ip"] = ip
        url = build_update_url(cfg, ip)
        r = httpx.get(url, timeout=15)
        body = r.text.strip()[:120]
        ok = r.status_code == 200 and "KO" not in body.upper().split()
        status["ok"] = ok
        status["detail"] = _sanitize(f"HTTP {r.status_code} · {body}" if body else f"HTTP {r.status_code}", token)
    except Exception as e:  # noqa: BLE001 — 상태로 기록해 화면에 노출(토큰 제거)
        status["detail"] = _sanitize(str(e)[:200], token)
        logger.warning("DDNS 갱신 실패(%s): %s", cfg.get("provider"), status["detail"])
    set_setting(db, DDNS_STATUS_KEY, status, scope="global")
    return status


# ════════════════════════════ 주기 갱신 워커(데몬 스레드) ════════════════════════════
_worker: threading.Thread | None = None
_wake = threading.Event()   # 설정 변경/수동 갱신 시 즉시 깨움
_lock = threading.Lock()


def _loop() -> None:
    from app.db import SessionLocal

    while True:
        interval_min = 30
        try:
            with SessionLocal() as db:
                cfg = get_config(db)
                interval_min = max(1, int(cfg.get("interval_min") or 30))
                if cfg.get("enabled") and cfg.get("domain"):
                    update_now(db)
        except Exception:  # noqa: BLE001 — 워커는 죽지 않는다(다음 주기 재시도)
            logger.exception("DDNS 워커 주기 처리 실패")
        _wake.wait(interval_min * 60)
        _wake.clear()


def ensure_worker() -> None:
    """지연 기동(서버 재시작 금지 환경) — 설정 저장/조회 시 호출해 워커를 보장한다."""
    global _worker
    with _lock:
        if _worker is not None and _worker.is_alive():
            _wake.set()  # 설정 변경 즉시 반영
            return
        _worker = threading.Thread(target=_loop, name="saintview-ddns", daemon=True)
        _worker.start()
