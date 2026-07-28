"""배포 패키지 빌드 — Viewer Suite(WebPACS 브리지 포함)를 타 사이트 반출용으로 조립.

산출물: build/SaintviewViewerSuite-dist-<YYYYMMDD>-<git짧은해시>/ + 동명 .zip

포함: backend 소스(+tests·migrations·seed) · frontend 소스+프로덕션 dist · deploy(compose·ohif)
      · harness(모의 서버·스모크) · docs · 런처(start_viewer_suite.bat) · VERSION.txt
제외(시크릿·런타임 아티팩트): backend/.env, frontend/certs(개인키 — 런처가 현장 자동 생성),
      node_modules, __pycache__, *.log, *.db, storage/, deploy/generated·orthanc-generated.json·
      scp-policy.env, harness/out_dicom, dist 외 build 산출물.

실행: py -3.11 deploy/make_dist.py   (저장소 루트 어디서든 가능)
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import zipfile
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# (소스 경로, 패키지 내 경로) — 디렉토리는 ignore 필터를 거쳐 복사
INCLUDE_DIRS = [
    ("backend/app", "backend/app"),
    ("backend/migrations", "backend/migrations"),
    ("backend/tests", "backend/tests"),
    ("backend/tools", "backend/tools"),
    ("frontend/src", "frontend/src"),
    ("frontend/public", "frontend/public"),
    ("frontend/dist", "frontend/dist"),
    ("deploy/ohif", "deploy/ohif"),
    ("harness", "harness"),
    ("docs", "docs"),
]
INCLUDE_FILES = [
    "README.md",
    "start_viewer_suite.bat",
    "backend/alembic.ini",
    "backend/requirements.txt",
    "backend/seed_sample.py",
    "backend/server_restart.bat",
    "backend/.env.example",
    "frontend/index.html",
    "frontend/package.json",
    "frontend/package-lock.json",
    "frontend/tsconfig.json",
    "frontend/tsconfig.app.json",
    "frontend/tsconfig.node.json",
    "frontend/vite.config.ts",
    "frontend/eslint.config.js",
    "frontend/.env",                       # 포트·베이스 URL 만 — 시크릿 없음(검증됨)
    "frontend/README.md",
    "deploy/docker-compose.yml",
    "deploy/docker-compose.prod.yml",
    "deploy/gen_prod_conf.py",
    "deploy/hospital-orthanc.template.yml",
    "deploy/README_PILOT.md",
    # ⚡ 운영 nginx 설정 — 이게 빠져 있으면 현장에서 gzip·캐시가 꺼진 채로 서비스된다
    #    (실측: 미적용 서버가 index-*.js 823KB 를 무압축 전송. QUICKSTART §7 참조)
    "deploy/nginx-viewer.conf",
    # 전송 최적화 패치(자립 스크립트) — 원격 진단(--check)·적용(--apply)·되돌리기(--rollback).
    # server 블록을 편집하지 않고 conf.d 드롭인 한 장만 쓰므로 되돌리기가 파일 삭제 하나다.
    "deploy/patch_nginx.sh",
    "deploy/apply_nginx.ps1",   # Windows nginx 용(셸 스크립트가 안 도는 환경)
    # 실서버 갱신기 — 이 패키지 자신을 서버에 적용한다(프론트 dist·백엔드 app·의존성·nginx·재시작·검증).
    # **반드시 패키지 안에 있어야 한다.** 빠지면 "패키지 하나만 서버에 올리면 된다"가 거짓이 되고,
    # 스크립트가 옆에서 patch_nginx.sh 를 찾는 전제(SELF_DIR)도 깨진다.
    "deploy/update_server.sh",
]
# 시크릿·개인키 — 패키지에 절대 포함 금지(포함 시 빌드 실패)
FORBIDDEN = ["backend/.env", "frontend/certs/dev.key", "frontend/certs/dev.crt"]

IGNORE = shutil.ignore_patterns(
    "__pycache__", "*.pyc", "node_modules", "*.log", "*.db", "out_dicom",
    ".pytest_cache", "certs",
)


# 서버(Linux)에서 sh 로 실행되는 파일 — 반드시 LF 로 담아야 한다.
# 왜 여기서도 막는가: .gitattributes 규칙은 **다음 체크아웃부터** 듣는다. 이미 CRLF 로
# 체크아웃돼 있는 작업 트리에서 지금 빌드하면 shutil.copy2 가 CR 을 그대로 패키지에
# 넣고, 서버에서는 `sh update_server.sh --apply` 가 64행 `set -eu` 에서
# "set: Illegal option -" 로 즉사한다(직접 실행은 셔뱅이 `/bin/sh\r` 이라 rc=127).
# 빌드가 마지막 관문이므로 여기서 정규화하고, 아래에서 'CR 0건' 을 단정한다.
LF_SUFFIXES = {".sh"}


def copy_file(src, dst) -> None:  # noqa: ANN001 — copytree(copy_function=) 이 str 을 넘긴다
    """텍스트 스크립트는 개행을 LF 로 정규화해 복사(실행 비트 포함 메타데이터 보존)."""
    s, d = Path(src), Path(dst)
    if d.is_dir():                       # copytree 관례상 대상이 디렉터리일 수 있다
        d = d / s.name
    if s.suffix in LF_SUFFIXES:
        d.write_bytes(s.read_bytes().replace(b"\r\n", b"\n"))
        shutil.copystat(s, d)            # 실행 비트·mtime 보존(copy2 와 동일한 메타데이터)
    else:
        shutil.copy2(s, d)


def assert_no_crlf(root: Path) -> list[str]:
    """패키지 안의 셸 스크립트에 CR 이 한 바이트도 없음을 단정한다."""
    bad = []
    for p in sorted(root.rglob("*")):
        if p.is_file() and p.suffix in LF_SUFFIXES and b"\r" in p.read_bytes():
            bad.append(str(p.relative_to(root)))
    return bad


def git_short_hash() -> str:
    try:
        return subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"], cwd=ROOT,
            capture_output=True, text=True, check=True,
        ).stdout.strip()
    except Exception:  # noqa: BLE001 — git 없는 환경(반출본에서 재실행 등)
        return "nogit"


def main() -> int:
    stamp = datetime.now().strftime("%Y%m%d")
    name = f"SaintviewViewerSuite-dist-{stamp}-{git_short_hash()}"
    out = ROOT / "build" / name
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    if not (ROOT / "frontend/dist/index.html").exists():
        print("ERROR: frontend/dist 가 없습니다 — 먼저 `cd frontend && npm run build`", file=sys.stderr)
        return 1

    for src, dst in INCLUDE_DIRS:
        s = ROOT / src
        if not s.exists():
            print(f"WARN: {src} 없음 — 건너뜀")
            continue
        shutil.copytree(s, out / dst, ignore=IGNORE, copy_function=copy_file)
    for f in INCLUDE_FILES:
        s = ROOT / f
        if not s.exists():
            print(f"WARN: {f} 없음 — 건너뜀")
            continue
        d = out / f
        d.parent.mkdir(parents=True, exist_ok=True)
        copy_file(s, d)

    # compose 가 마운트하는 런타임 디렉토리 자리 확보(빈 폴더)
    (out / "deploy/worklists").mkdir(parents=True, exist_ok=True)
    (out / "deploy/worklists/.gitkeep").write_text("")

    # 버전 스탬프
    (out / "VERSION.txt").write_text(
        f"Saintview Viewer Suite (WebPACS bridge 포함)\n"
        f"commit: {git_short_hash()}\nbuilt:  {datetime.now().isoformat(timespec='seconds')}\n",
        encoding="utf-8",
    )

    # 시크릿 유출 게이트 — 금지 파일이 패키지에 있으면 실패
    leaked = [f for f in FORBIDDEN if (out / f).exists()]
    # 이름 기반 2차 스캔(개인키류)
    for p in out.rglob("*"):
        if p.is_file() and p.suffix in (".key", ".pem") :
            leaked.append(str(p.relative_to(out)))
    if leaked:
        print(f"ERROR: 시크릿 의심 파일 포함 — 중단: {leaked}", file=sys.stderr)
        shutil.rmtree(out)
        return 2

    # 개행 게이트 — CRLF 셸 스크립트는 서버에서 첫 실행문부터 죽으므로 패키지를 내보내지
    # 않는다(운영자가 보는 것은 "set: Illegal option -" 한 줄뿐이라 원인 추적이 어렵다).
    crlf = assert_no_crlf(out)
    if crlf:
        print(f"ERROR: CRLF 셸 스크립트 포함 — 중단(서버에서 실행 불가): {crlf}", file=sys.stderr)
        shutil.rmtree(out)
        return 3

    # zip
    zip_path = ROOT / "build" / f"{name}.zip"
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(out.rglob("*")):
            if p.is_file():
                zf.write(p, f"{name}/{p.relative_to(out)}")

    n_files = sum(1 for p in out.rglob("*") if p.is_file())
    print(f"OK: {out}")
    print(f"OK: {zip_path}  ({zip_path.stat().st_size / 1048576:.1f} MB, {n_files} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
