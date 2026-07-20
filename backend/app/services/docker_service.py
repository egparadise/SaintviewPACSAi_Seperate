"""Docker 컨테이너 관리 서비스(레인 O) — saintview-* 조회/제어 + 병원별 Orthanc 프로비저닝.

보안 원칙:
- docker CLI 는 항상 인자 리스트(subprocess, shell=False)로 호출 — 임의 명령 주입 불가.
- 컨테이너 이름은 화이트리스트 정규식(saintview-*)과 액션 화이트리스트로 이중 검증.
- 파괴/원격 작업(start·stop·restart·provision·remove)은 호출부(api/infra)가 감사 로그를 남긴다.

병원별 컨테이너 레지스트리는 전역 설정 `infra.containers` 에 기록한다:
  {"<hid>": {"container","url","dicom_port","web_port","volume","aet"}}
"""
from __future__ import annotations

import json
import logging
import re
import subprocess
from pathlib import Path

from sqlalchemy.orm import Session

from app.services.settings_service import get_setting, set_setting

logger = logging.getLogger("saintview.infra.docker")

# ── 화이트리스트 (임의 명령 주입 방지) ──
CONTAINER_PREFIX = "saintview-"
ALLOWED_ACTIONS = ("start", "stop", "restart")
# 이름: saintview- 로 시작 + docker 이름 안전 문자만 (공백/세미콜론/파이프 등 전부 거부)
_NAME_RE = re.compile(r"^saintview-[A-Za-z0-9][A-Za-z0-9_.-]*$")

INFRA_CONTAINERS_KEY = "infra.containers"  # 전역 설정 키 (global-only — 레인 H ALLOWED_KEYS 계약)

# 병원별 포트 자동 할당 기준(base + hid, 충돌 시 다음 빈 포트)
_DICOM_PORT_BASE = 4300
_WEB_PORT_BASE = 8100


class DockerUnavailable(RuntimeError):
    """docker CLI 미설치/데몬 미기동 — 호출부에서 503 등으로 우아 강등."""


def validate_container_name(name: str) -> str:
    """컨테이너 이름 화이트리스트 검증 — 통과 못 하면 ValueError(→ API 400)."""
    if not isinstance(name, str) or not _NAME_RE.match(name):
        raise ValueError(f"허용되지 않은 컨테이너 이름입니다 (saintview-* 만 제어 가능): {name!r}")
    return name


def validate_action(action: str) -> str:
    if action not in ALLOWED_ACTIONS:
        raise ValueError(f"허용되지 않은 액션입니다 ({'/'.join(ALLOWED_ACTIONS)}): {action!r}")
    return action


def _docker(args: list[str], timeout: int = 120) -> subprocess.CompletedProcess:
    """docker CLI 실행 — shell=False 고정. docker 미설치는 DockerUnavailable."""
    try:
        return subprocess.run(
            ["docker", *args], capture_output=True, text=True, timeout=timeout
        )
    except FileNotFoundError as e:  # docker CLI 자체가 없음
        raise DockerUnavailable("docker CLI 를 찾을 수 없습니다") from e
    except subprocess.TimeoutExpired as e:
        raise DockerUnavailable(f"docker 명령 시간 초과({timeout}s)") from e


def docker_available() -> bool:
    try:
        return _docker(["version", "--format", "{{.Server.Version}}"], timeout=15).returncode == 0
    except DockerUnavailable:
        return False


def list_containers() -> list[dict]:
    """saintview-* 컨테이너 목록 — 이름/상태/포트/이미지 (docker ps -a)."""
    cp = _docker([
        "ps", "-a", "--filter", f"name={CONTAINER_PREFIX}", "--format", "{{json .}}",
    ])
    if cp.returncode != 0:
        raise DockerUnavailable(cp.stderr.strip()[:200] or "docker ps 실패")
    items: list[dict] = []
    for line in cp.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        name = str(row.get("Names", ""))
        if not name.startswith(CONTAINER_PREFIX):  # 필터 부분일치 방어
            continue
        items.append({
            "name": name,
            "image": row.get("Image", ""),
            "state": row.get("State", ""),          # running | exited | ...
            "status": row.get("Status", ""),        # "Up 2 hours" 등 사람용
            "ports": row.get("Ports", ""),
        })
    items.sort(key=lambda x: x["name"])
    return items


def container_action(name: str, action: str) -> dict:
    """단일 컨테이너 start/stop/restart — 이름·액션 화이트리스트 검증 후 실행."""
    validate_container_name(name)
    validate_action(action)
    cp = _docker([action, name])
    ok = cp.returncode == 0
    detail = (cp.stdout if ok else cp.stderr).strip()[:300]
    if not ok:
        logger.warning("컨테이너 %s %s 실패: %s", name, action, detail)
    return {"ok": ok, "name": name, "action": action, "detail": detail}


# ════════════════════════════ 병원별 Orthanc 프로비저닝 ════════════════════════════
def project_root() -> Path:
    # app/services/docker_service.py → parents[2]=backend, parents[3]=저장소 루트
    return Path(__file__).resolve().parents[3]


def deploy_dir() -> Path:
    return project_root() / "deploy"


def generated_dir() -> Path:
    d = deploy_dir() / "generated"
    d.mkdir(parents=True, exist_ok=True)
    return d


def hospital_container_name(hid: int) -> str:
    return f"saintview-orthanc-h{int(hid)}"


def get_registry(db: Session) -> dict:
    reg = get_setting(db, INFRA_CONTAINERS_KEY, default={}) or {}
    return reg if isinstance(reg, dict) else {}


def save_registry(db: Session, reg: dict) -> None:
    set_setting(db, INFRA_CONTAINERS_KEY, reg, scope="global")


def allocate_ports(registry: dict, hid: int) -> tuple[int, int]:
    """포트 자동 할당 — 기본 base+hid, 다른 병원이 쓰고 있으면 다음 빈 포트.

    반환: (dicom_port, web_port). 순수 함수 — pytest 로 직접 검증.
    """
    used_dicom = {int(v.get("dicom_port", 0)) for k, v in registry.items()
                  if isinstance(v, dict) and str(k) != str(hid)}
    used_web = {int(v.get("web_port", 0)) for k, v in registry.items()
                if isinstance(v, dict) and str(k) != str(hid)}

    def _pick(base: int, used: set[int]) -> int:
        port = base + int(hid)
        while port in used:
            port += 1
        return port

    return _pick(_DICOM_PORT_BASE, used_dicom), _pick(_WEB_PORT_BASE, used_web)


def render_hospital_compose(
    hid: int, *, dicom_port: int, web_port: int, volume_dir: str, orthanc_password: str
) -> str:
    """템플릿({{PLACEHOLDER}}) 치환 — deploy/hospital-orthanc.template.yml 기반. 순수 함수."""
    template_path = deploy_dir() / "hospital-orthanc.template.yml"
    text = template_path.read_text(encoding="utf-8")
    rendered = (
        text.replace("{{HID}}", str(int(hid)))
        .replace("{{DICOM_PORT}}", str(int(dicom_port)))
        .replace("{{WEB_PORT}}", str(int(web_port)))
        .replace("{{VOLUME_DIR}}", volume_dir)
        .replace("{{ORTHANC_PASSWORD}}", orthanc_password)
    )
    if "{{" in rendered:  # 치환 누락은 배포 사고 — 즉시 실패
        raise ValueError("템플릿 치환 누락: " + ",".join(sorted(set(re.findall(r"\{\{(\w+)\}\}", rendered)))))
    return rendered


def _compose(args: list[str], compose_file: Path, project: str) -> subprocess.CompletedProcess:
    return _docker(["compose", "-f", str(compose_file), "-p", project, *args], timeout=300)


def provision_hospital(db: Session, hid: int) -> dict:
    """병원 전용 Orthanc 컨테이너 생성 — 템플릿 치환 → compose up → 레지스트리 기록.

    이미 등록된 병원이면 같은 포트를 재사용(멱등)한다.
    """
    from app.config import get_settings

    registry = get_registry(db)
    existing = registry.get(str(hid)) if isinstance(registry.get(str(hid)), dict) else None
    if existing:
        dicom_port, web_port = int(existing["dicom_port"]), int(existing["web_port"])
    else:
        dicom_port, web_port = allocate_ports(registry, hid)

    volume = (generated_dir() / f"orthanc-h{hid}-data").resolve()
    volume.mkdir(parents=True, exist_ok=True)
    rendered = render_hospital_compose(
        hid,
        dicom_port=dicom_port,
        web_port=web_port,
        volume_dir=volume.as_posix(),
        orthanc_password=get_settings().orthanc_password,
    )
    compose_file = generated_dir() / f"hospital-h{hid}.yml"
    compose_file.write_text(rendered, encoding="utf-8")

    cp = _compose(["up", "-d"], compose_file, f"saintview-h{hid}")
    ok = cp.returncode == 0
    entry = {
        "container": hospital_container_name(hid),
        "url": f"http://localhost:{web_port}",
        "dicom_port": dicom_port,
        "web_port": web_port,
        "volume": volume.as_posix(),
        "aet": f"SAINTVIEW_H{hid}",
        "compose_file": compose_file.as_posix(),
    }
    if ok:
        registry[str(hid)] = entry
        save_registry(db, registry)
    detail = (cp.stdout if ok else cp.stderr).strip()[-300:]
    return {"ok": ok, "hid": hid, "entry": entry, "detail": detail}


def hospital_action(db: Session, hid: int, action: str) -> dict:
    """병원 컨테이너 start|stop|remove — remove 는 compose down + 레지스트리 해제.

    데이터 볼륨(호스트 바인드)은 삭제하지 않는다(파괴 최소화 — 재프로비저닝 시 재사용).
    """
    registry = get_registry(db)
    entry = registry.get(str(hid))
    if not isinstance(entry, dict):
        raise ValueError(f"등록된 병원 컨테이너가 없습니다: hid={hid}")
    name = validate_container_name(str(entry.get("container", "")))

    if action in ("start", "stop", "restart"):
        return container_action(name, action)
    if action == "remove":
        compose_file = Path(str(entry.get("compose_file", "")))
        if compose_file.is_file():
            cp = _compose(["down"], compose_file, f"saintview-h{hid}")
        else:  # compose 파일 유실 시 컨테이너만 제거 (이름은 위에서 검증됨)
            cp = _docker(["rm", "-f", name])
        ok = cp.returncode == 0
        if ok:
            registry.pop(str(hid), None)
            save_registry(db, registry)
        return {"ok": ok, "name": name, "action": "remove",
                "detail": (cp.stdout if ok else cp.stderr).strip()[-300:]}
    raise ValueError(f"허용되지 않은 액션입니다 (start/stop/restart/remove): {action!r}")


def main_action(action: str) -> dict:
    """메인 스택(deploy/docker-compose.yml — db·orthanc·ohif) 일괄 start|stop|restart.

    start 는 compose up -d(미생성 컨테이너 생성 포함), stop/restart 는 컨테이너 유지.
    """
    action = validate_action(action)
    compose_file = deploy_dir() / "docker-compose.yml"
    if not compose_file.is_file():
        raise ValueError(f"메인 compose 파일이 없습니다: {compose_file}")
    args = {"start": ["up", "-d"], "stop": ["stop"], "restart": ["restart"]}[action]
    cp = _docker(["compose", "-f", str(compose_file), *args], timeout=300)
    ok = cp.returncode == 0
    return {"ok": ok, "name": "main-stack", "action": action,
            "detail": (cp.stdout if ok else cp.stderr).strip()[-300:]}
