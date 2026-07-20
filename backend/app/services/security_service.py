"""보안 강화 서비스 (레인 S) — 전부 방어적(탐지·설정·경고) 기능. 공격 코드 없음.

① 바이러스: Windows Defender 상태 조회(Get-MpComputerStatus) + 빠른 스캔 트리거(비동기).
   PowerShell/Defender 미가용 환경(리눅스·컨테이너·권한 부족)에서는 우아 강등(available=False).
② 랜섬웨어 방지(탐지·경고만 — 자동 차단 없음):
   - 백업 보호: 백업 산출물 읽기 전용 속성 + SHA-256 해시 매니페스트 기록·검증(변조 감지)
   - 무결성 감시: 스토리지·백업 폴더 스냅샷(파일 수·총량·확장자 분포)을 기록하고
     '대량 삭제/이름변경·의심 확장자(.encrypted/.locked 등)·급격한 변화율'을 감지 → 경고+감사 로그
③ 접근 보안:
   - 로그인 실패 잠금: 계정·IP 별 연속 실패 N회(security.policy.threshold) → lock_min 분 잠금(인메모리)
   - 관리자 API IP allowlist: security.policy.admin_allowlist (CIDR/IP/호스트명, 빈=제한 없음)
   - 감사 로그 요약: 로그인 실패 통계(24h)

설정 키: security.policy (global 전용 — api/settings.py ALLOWED_KEYS 등록은 레인 H 몫)
스냅샷 키: security.integrity (global — 최근 스냅샷·경고 이력)
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import logging
import os
import re
import stat
import subprocess
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import AuditLog
from app.services.settings_service import get_setting, set_setting

logger = logging.getLogger("saintview.security")

POLICY_KEY = "security.policy"
INTEGRITY_KEY = "security.integrity"

DEFAULT_POLICY: dict = {
    "threshold": 5,        # 연속 로그인 실패 잠금 임계(계정·IP 별)
    "lock_min": 15,        # 잠금 시간(분)
    "admin_allowlist": [],  # 관리자(보안) API 허용 IP/CIDR/호스트명 — 빈 목록 = 제한 없음
    "protect_backups": False,  # 백업 산출물 읽기 전용 + 해시 매니페스트 기록
    "watch_paths": [],     # 추가 무결성 감시 경로(스토리지·백업 폴더는 기본 포함)
    "mass_change_pct": 30,  # 급격한 변화율 경고 임계(%)
}

# 랜섬웨어가 흔히 남기는 의심 확장자(탐지 전용 목록)
SUSPICIOUS_EXTS = frozenset({
    ".encrypted", ".locked", ".crypt", ".crypted", ".cry", ".enc",
    ".lockbit", ".ryuk", ".conti", ".akira", ".phobos", ".cerber",
    ".wcry", ".wncry", ".onion", ".makop", ".stop", ".djvu",
})

MANIFEST_NAME = ".integrity_manifest.json"  # 백업 해시 매니페스트(감시 대상에서 제외)
_MAX_MANIFEST_FILES = 2000                  # 한 번의 스캔에서 다루는 백업 파일 상한
_MAX_HASH_BYTES = 64 * 1024 * 1024          # 이보다 큰 파일은 크기 비교만(스캔 지연 방지)


# ════════════════════════════ 정책 (security.policy) ════════════════════════════
def get_policy(db: Session) -> dict:
    return {**DEFAULT_POLICY, **(get_setting(db, POLICY_KEY, default={}) or {})}


def set_policy(db: Session, policy: dict, client_ip: str = "", actor_id: int | None = None) -> tuple[dict, str]:
    """정책 저장(검증 포함). 반환: (저장된 정책, 경고 메시지).

    자기 잠금 방지: allowlist 에 현재 요청 IP 가 없으면 저장은 하되 경고를 반환한다.
    """
    cur = get_policy(db)
    merged = {**cur, **{k: policy[k] for k in DEFAULT_POLICY if k in policy}}
    merged["threshold"] = min(100, max(1, int(merged.get("threshold") or 5)))
    merged["lock_min"] = min(1440, max(1, int(merged.get("lock_min") or 15)))
    merged["mass_change_pct"] = min(95, max(5, int(merged.get("mass_change_pct") or 30)))
    merged["protect_backups"] = bool(merged.get("protect_backups"))
    merged["admin_allowlist"] = [str(e).strip() for e in (merged.get("admin_allowlist") or []) if str(e).strip()]
    merged["watch_paths"] = [str(p).strip() for p in (merged.get("watch_paths") or []) if str(p).strip()]
    set_setting(db, POLICY_KEY, merged, scope="global")
    db.add(AuditLog(account_id=actor_id, action="security_policy_update", target_type="setting",
                    target_id=POLICY_KEY, detail={"threshold": merged["threshold"],
                                                  "lock_min": merged["lock_min"],
                                                  "allowlist_len": len(merged["admin_allowlist"])}))
    db.commit()
    warning = ""
    if merged["admin_allowlist"] and client_ip and not ip_allowed(client_ip, merged["admin_allowlist"]):
        warning = (f"⚠ 현재 접속 IP({client_ip})가 allowlist에 없습니다 — "
                   "이후 관리자 보안 API 접근이 차단됩니다(자기 잠금 주의)")
    return merged, warning


# ════════════════════════════ ① Defender (바이러스) ════════════════════════════
def _run_powershell(command: str, timeout: int = 12) -> str:
    """PowerShell 실행 — 미가용/실패는 호출부에서 우아 강등."""
    proc = subprocess.run(  # noqa: S603 — 고정 명령(사용자 입력 미포함), 방어적 상태 조회
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", command],
        capture_output=True, text=True, timeout=timeout,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "PowerShell 실패")[:300])
    return proc.stdout


def _ps_json_value(v):
    """PS 5.1 ConvertTo-Json 의 '/Date(밀리초)/' 날짜를 ISO 문자열로 변환."""
    if isinstance(v, str):
        m = re.match(r"^/Date\((\d+)\)/$", v)
        if m:
            try:
                return datetime.fromtimestamp(int(m.group(1)) / 1000, tz=timezone.utc).isoformat()
            except (ValueError, OSError, OverflowError):
                return v
    return v


def defender_status() -> dict:
    """Windows Defender 상태 — 실시간 보호/서명 날짜/마지막 스캔. 미가용 시 우아 강등."""
    fields = ("AMServiceEnabled", "AntivirusEnabled", "RealTimeProtectionEnabled",
              "AntivirusSignatureVersion", "AntivirusSignatureLastUpdated",
              "QuickScanEndTime", "FullScanEndTime")
    cmd = f"Get-MpComputerStatus | Select-Object {','.join(fields)} | ConvertTo-Json -Compress"
    try:
        raw = _run_powershell(cmd)
        data = json.loads(raw.strip() or "{}")
        out = {k: _ps_json_value(data.get(k)) for k in fields}
        out["available"] = True
        return out
    except Exception as e:  # noqa: BLE001 — PS 미가용/권한/파싱 실패 전부 강등 대상
        logger.info("Defender 상태 조회 불가(우아 강등): %s", str(e)[:200])
        return {"available": False, "reason": str(e)[:200]}


def start_defender_scan(db: Session | None = None, actor_id: int | None = None) -> dict:
    """빠른 스캔(Start-MpScan -ScanType QuickScan) 비동기 트리거 — 완료를 기다리지 않는다."""
    try:
        subprocess.Popen(  # noqa: S603 — 고정 명령, 방어적 스캔 트리거
            ["powershell", "-NoProfile", "-NonInteractive", "-Command",
             "Start-MpScan -ScanType QuickScan"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        if db is not None:
            db.add(AuditLog(account_id=actor_id, action="security_defender_scan",
                            target_type="security", target_id="quick_scan"))
            db.commit()
        return {"started": True, "message": "빠른 스캔을 시작했습니다 (백그라운드 실행)"}
    except (OSError, FileNotFoundError) as e:
        return {"started": False, "reason": f"PowerShell/Defender 미가용: {str(e)[:150]}"}


# ════════════════════════════ ② 무결성 감시 (랜섬 방지 — 탐지·경고) ════════════════════════════
def _storage_dir() -> Path:
    # backend/app/services/security_service.py → parents[2] = backend
    return Path(__file__).resolve().parents[2] / "storage"


def watch_targets(db: Session) -> list[Path]:
    """감시 대상: 스토리지 폴더 + 백업 폴더 + 정책 추가 경로(중복 제거)."""
    from app.services import backup_service

    policy = get_policy(db)
    backup_root = backup_service.resolve_target(backup_service.get_policy(db).get("target_dir", ""))
    paths = [_storage_dir(), backup_root] + [Path(p).expanduser() for p in policy.get("watch_paths", [])]
    seen: set[str] = set()
    out: list[Path] = []
    for p in paths:
        key = str(p.resolve()) if p.exists() else str(p)
        if key not in seen:
            seen.add(key)
            out.append(p)
    return out


def scan_directory(root: Path) -> dict:
    """폴더 스냅샷 — 파일 수·총량·확장자 분포·의심 확장자. 접근 불가 항목은 건너뜀."""
    snap = {"exists": root.exists(), "files": 0, "bytes": 0,
            "exts": {}, "suspicious": 0, "suspicious_names": []}
    if not snap["exists"]:
        return snap
    exts: dict[str, int] = {}
    try:
        for p in root.rglob("*"):
            try:
                if not p.is_file() or p.name == MANIFEST_NAME:
                    continue
                snap["files"] += 1
                snap["bytes"] += p.stat().st_size
                ext = p.suffix.lower()
                exts[ext or "(없음)"] = exts.get(ext or "(없음)", 0) + 1
                if ext in SUSPICIOUS_EXTS:
                    snap["suspicious"] += 1
                    if len(snap["suspicious_names"]) < 10:
                        snap["suspicious_names"].append(p.name)
            except OSError:
                continue
    except OSError:
        pass
    # 확장자 분포는 상위 20개만 저장(스냅샷 비대 방지)
    snap["exts"] = dict(sorted(exts.items(), key=lambda kv: -kv[1])[:20])
    return snap


def _compare_snapshots(prev_paths: dict, cur_paths: dict, pct: int) -> list[str]:
    """이전↔현재 스냅샷 비교 — 의심 확장자·급격한 변화율·대량 이름변경 감지."""
    alerts: list[str] = []
    for path, cur in cur_paths.items():
        if not cur.get("exists"):
            continue
        if cur.get("suspicious", 0) > 0:
            names = ", ".join(cur.get("suspicious_names", [])[:5])
            alerts.append(f"{path}: 의심 확장자 파일 {cur['suspicious']}건 감지 ({names})")
        prev = (prev_paths or {}).get(path)
        if not prev or not prev.get("exists"):
            continue
        pf, cf = int(prev.get("files", 0)), int(cur.get("files", 0))
        if pf >= 10:
            delta = cf - pf
            limit = max(10, pf * pct // 100)
            if abs(delta) >= limit:
                kind = "대량 삭제" if delta < 0 else "급격한 파일 증가"
                alerts.append(f"{path}: {kind} 의심 — 파일 수 {pf} → {cf} (변화율 {abs(delta) * 100 // pf}%)")
            elif abs(delta) < max(1, pf // 10):
                # 파일 수는 비슷한데 확장자 분포가 크게 이동 → 대량 이름변경(암호화) 의심
                pe, ce = prev.get("exts", {}), cur.get("exts", {})
                moved = sum(abs(ce.get(e, 0) - pe.get(e, 0)) for e in set(pe) | set(ce)) // 2
                if moved >= limit:
                    alerts.append(f"{path}: 대량 이름변경 의심 — 확장자 분포 이동 {moved}건")
    return alerts


def _sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _set_readonly(p: Path) -> None:
    try:
        os.chmod(p, stat.S_IREAD)  # Windows: 읽기 전용 속성 / POSIX: r--
    except OSError:
        pass


def protect_and_verify_backups(root: Path) -> list[str]:
    """백업 보호 — 신규 파일: SHA-256 기록+읽기 전용 설정, 기존 파일: 해시 재검증(변조 감지).

    반환: 경고 목록(변조 의심 등). 매니페스트는 백업 루트의 .integrity_manifest.json.
    """
    alerts: list[str] = []
    if not root.exists():
        return alerts
    mpath = root / MANIFEST_NAME
    manifest: dict = {}
    if mpath.exists():
        try:
            manifest = json.loads(mpath.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            manifest = {}
    changed = False
    count = 0
    for p in sorted(root.rglob("*")):
        if not p.is_file() or p.name == MANIFEST_NAME:
            continue
        count += 1
        if count > _MAX_MANIFEST_FILES:
            break
        rel = str(p.relative_to(root))
        try:
            size = p.stat().st_size
            entry = manifest.get(rel)
            if entry is None:
                # 신규 백업 산출물 — 해시 기록 + 읽기 전용
                digest = _sha256(p) if size <= _MAX_HASH_BYTES else ""
                manifest[rel] = {"sha256": digest, "size": size}
                _set_readonly(p)
                changed = True
            else:
                if int(entry.get("size", -1)) != size:
                    alerts.append(f"백업 변조 의심: {rel} — 크기 변경 {entry.get('size')} → {size}")
                elif entry.get("sha256") and size <= _MAX_HASH_BYTES and _sha256(p) != entry["sha256"]:
                    alerts.append(f"백업 변조 의심: {rel} — SHA-256 불일치")
        except OSError:
            continue
    # 매니페스트에 있는데 사라진 파일 → 삭제 경고
    live = {str(p.relative_to(root)) for p in root.rglob("*") if p.is_file() and p.name != MANIFEST_NAME}
    missing = [rel for rel in manifest if rel not in live]
    if missing:
        alerts.append(f"백업 파일 삭제 감지: {len(missing)}건 (예: {', '.join(missing[:3])})")
        for rel in missing:  # 다음 스캔 중복 경고 방지 — 삭제 사실은 감사 로그에 남는다
            manifest.pop(rel, None)
        changed = True
    if changed:
        try:
            if mpath.exists():
                os.chmod(mpath, stat.S_IREAD | stat.S_IWRITE)
            mpath.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
        except OSError as e:
            alerts.append(f"매니페스트 기록 실패: {str(e)[:120]}")
    return alerts


def get_integrity_state(db: Session) -> dict:
    """최근 스냅샷·경고 이력 조회 (GET /api/security/integrity)."""
    store = get_setting(db, INTEGRITY_KEY, default={}) or {}
    snaps = store.get("snapshots", [])
    return {
        "status": store.get("status", "unknown"),
        "last_scan": store.get("last_scan", ""),
        "latest": snaps[-1] if snaps else None,
        "snapshots": snaps,
        "alerts": store.get("alerts", []),
    }


def run_integrity_scan(db: Session, actor_id: int | None = None) -> dict:
    """즉시 무결성 검사 — 스냅샷 기록 + 이전과 비교해 경고 산출(자동 차단 없음).

    주기 실행은 통합 단계에서 워커 루프가 이 함수를 호출하도록 배선한다(엔드포인트와 동일 로직).
    """
    policy = get_policy(db)
    cur_paths = {str(t): scan_directory(t) for t in watch_targets(db)}
    store = get_setting(db, INTEGRITY_KEY, default={}) or {}
    snaps: list = store.get("snapshots", [])
    prev_paths = (snaps[-1] or {}).get("paths", {}) if snaps else {}
    alerts = _compare_snapshots(prev_paths, cur_paths, int(policy["mass_change_pct"]))
    if policy.get("protect_backups"):
        from app.services import backup_service

        backup_root = backup_service.resolve_target(backup_service.get_policy(db).get("target_dir", ""))
        alerts += protect_and_verify_backups(backup_root)
    now = datetime.now(timezone.utc).isoformat()
    snapshot = {"taken_at": now, "paths": cur_paths}
    snaps.append(snapshot)
    alert_log = store.get("alerts", [])
    for a in alerts:
        alert_log.append({"at": now, "message": a})
    status = "warn" if alerts else "ok"
    set_setting(db, INTEGRITY_KEY, {
        "status": status, "last_scan": now,
        "snapshots": snaps[-12:], "alerts": alert_log[-30:],
    }, scope="global")
    if alerts:
        db.add(AuditLog(account_id=actor_id, action="security_integrity_alert", target_type="security",
                        target_id="integrity", detail={"alerts": alerts[:10]}))
        db.commit()
    return {"status": status, "alerts": alerts, "snapshot": snapshot}


# ════════════════════════════ ③ 접근 보안 — 로그인 실패 잠금 ════════════════════════════
_state_lock = threading.Lock()
_fail_counts: dict[str, int] = {}       # "user:이름" / "ip:주소" → 연속 실패 횟수
_locked_until: dict[str, float] = {}    # 키 → 잠금 해제 시각(epoch)


def _keys(username: str, ip: str) -> list[str]:
    keys = []
    if username and username.strip():
        keys.append(f"user:{username.strip().lower()}")
    if ip:
        keys.append(f"ip:{ip}")
    return keys


def _remaining(key: str, now: float) -> float:
    until = _locked_until.get(key, 0.0)
    if until <= now:
        _locked_until.pop(key, None)  # 만료 잠금 정리
        return 0.0
    return until - now


def locked_remaining(username: str, ip: str) -> float:
    """잠금 잔여 시간(초) — 계정·IP 중 큰 값. 0이면 잠금 없음."""
    now = time.time()
    with _state_lock:
        return max([_remaining(k, now) for k in _keys(username, ip)] or [0.0])


def ensure_login_allowed(db: Session, username: str, ip: str) -> None:
    """로그인 경로 훅 ① — 잠금 중이면 401 (계정 존재 여부 노출 방지 위해 401 유지)."""
    remain = locked_remaining(username, ip)
    if remain > 0:
        raise HTTPException(
            status_code=401,
            detail=f"로그인 실패가 누적되어 잠금되었습니다. 약 {int(remain // 60) + 1}분 후 다시 시도하세요",
        )


def record_login_failure(db: Session, username: str, ip: str) -> None:
    """로그인 경로 훅 ② — 실패 카운트 증가, 임계 도달 시 잠금 + 감사 로그."""
    policy = get_policy(db)
    threshold, lock_min = int(policy["threshold"]), int(policy["lock_min"])
    newly_locked: list[str] = []
    with _state_lock:
        for key in _keys(username, ip):
            cnt = _fail_counts.get(key, 0) + 1
            _fail_counts[key] = cnt
            if cnt >= threshold and key not in _locked_until:
                _locked_until[key] = time.time() + lock_min * 60
                newly_locked.append(key)
    for key in newly_locked:
        db.add(AuditLog(action="login_lockout", target_type="account", target_id=username[:64],
                        detail={"key": key, "ip": ip, "threshold": threshold, "lock_min": lock_min}))
    if newly_locked:
        db.commit()
        logger.warning("로그인 잠금 발동: %s (임계 %d회, %d분)", newly_locked, threshold, lock_min)


def reset_login_failures(username: str, ip: str) -> None:
    """로그인 경로 훅 ③ — 성공 시 카운터·잠금 리셋."""
    with _state_lock:
        for key in _keys(username, ip):
            _fail_counts.pop(key, None)
            _locked_until.pop(key, None)


def clear_lockout(key: str = "") -> int:
    """관리자 잠금 해제 — key 지정 시 해당 키만, 빈 값이면 전체. 반환: 해제 건수."""
    with _state_lock:
        if key:
            n = int(key in _locked_until or key in _fail_counts)
            _locked_until.pop(key, None)
            _fail_counts.pop(key, None)
            return n
        n = len(_locked_until)
        _locked_until.clear()
        _fail_counts.clear()
        return n


def lockout_overview() -> dict:
    """활성 잠금·실패 카운터 현황(대시보드용)."""
    now = time.time()
    with _state_lock:
        locks = [{"key": k, "remaining_sec": int(_remaining(k, now))}
                 for k in list(_locked_until) if _remaining(k, now) > 0]
        counting = {k: v for k, v in _fail_counts.items() if k not in _locked_until and v > 0}
    return {"locked": locks, "counting": counting}


def reset_state() -> None:
    """테스트 전용 — 인메모리 잠금 상태 초기화."""
    with _state_lock:
        _fail_counts.clear()
        _locked_until.clear()


# ════════════════════════════ ③ 접근 보안 — 관리자 IP allowlist ════════════════════════════
def ip_allowed(client_ip: str, allowlist: list[str]) -> bool:
    """빈 allowlist = 제한 없음. 항목은 정확 일치(호스트명 포함) 또는 CIDR 포함 검사."""
    if not allowlist:
        return True
    if not client_ip:
        return False
    for entry in allowlist:
        if client_ip == entry:
            return True
        try:
            if ipaddress.ip_address(client_ip) in ipaddress.ip_network(entry, strict=False):
                return True
        except ValueError:
            continue  # IP 형식이 아닌 항목(호스트명 등)은 정확 일치만
    return False


def enforce_admin_allowlist(db: Session, client_ip: str) -> None:
    """관리자 보안 API IP 게이트 — allowlist 미포함 IP 는 403.

    통합 단계에서 deps.admin_user 에 동일 검사를 배선할 수 있도록 함수로 노출한다.
    """
    allowlist = get_policy(db).get("admin_allowlist", [])
    if not ip_allowed(client_ip, allowlist):
        raise HTTPException(status_code=403, detail="allowlist에 등록되지 않은 IP입니다 (security.policy.admin_allowlist)")


# ════════════════════════════ ④ 종합 요약 (대시보드) ════════════════════════════
def login_failure_stats(db: Session, hours: int = 24) -> dict:
    """감사 로그 기반 로그인 실패 통계 — 최근 N시간 총 건수 + 상위 대상."""
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    base = select(func.count()).select_from(AuditLog).where(
        AuditLog.action == "login_failed", AuditLog.created_at >= since)
    total = db.execute(base).scalar() or 0
    top = db.execute(
        select(AuditLog.target_id, func.count().label("n"))
        .where(AuditLog.action == "login_failed", AuditLog.created_at >= since)
        .group_by(AuditLog.target_id).order_by(func.count().desc()).limit(5)
    ).all()
    lockouts = db.execute(
        select(func.count()).select_from(AuditLog).where(
            AuditLog.action == "login_lockout", AuditLog.created_at >= since)
    ).scalar() or 0
    return {"hours": hours, "failed_total": int(total), "lockout_events": int(lockouts),
            "top_targets": [{"username": t or "(빈값)", "count": int(n)} for t, n in top]}


def security_summary(db: Session) -> dict:
    """보안 대시보드 종합 — defender·무결성·잠금 현황·allowlist·실패 통계."""
    policy = get_policy(db)
    integ = get_integrity_state(db)
    return {
        "defender": defender_status(),
        "integrity": {"status": integ["status"], "last_scan": integ["last_scan"],
                      "alerts": integ["alerts"][-10:], "latest": integ["latest"]},
        "lockouts": lockout_overview(),
        "login_failures": login_failure_stats(db),
        "policy": policy,
    }
