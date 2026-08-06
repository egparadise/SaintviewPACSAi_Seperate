#!/bin/sh
# Saintview Viewer Suite — 실서버 갱신 (프론트 dist + 백엔드 app + nginx 최적화)
#
# 이 파일과 배포 패키지만 서버에 있으면 된다(저장소 체크아웃 불필요).
#
# 무엇을 하나
#   [1] 사전 점검 → [2] 설치 경로 발견 → [3] 백업 → [4] 파일 교체 →
#   [5] 파이썬 신규 의존성 → [6] nginx 드롭인(patch_nginx.sh 위임) →
#   [7] 백엔드 재시작 → [8] 검증
#   (단계는 8개다. --migrate 를 주면 [5] 뒤에 번호 없는 'DB 마이그레이션' 블록이 하나 낀다)
#
# 진단은 항상·무료·읽기전용이다
#   [2] 끝에서 DB 체제를 읽기만 한다: DB URL(마스킹) · 패키지 head 리비전 ·
#       DB 의 alembic 스탬프 · 미적용 리비전 목록 · 이번 패키지가 migrations/ 를
#       바꾸는지 여부. 아무것도 쓰지 않으며, 실패는 전부 '판정 불가' 로 내려앉는다
#       (DB·파이썬 판정 실패가 배포를 막지 않는다).
#   [7] 에서 백엔드가 도커 컨테이너면 bind mount 를 **증명**한다. 증명된 경우에만
#       docker restart 하고(그때는 systemctl restart 와 의미가 같다), 코드가 이미지
#       안이라고 증명되면 재시작하지 않고 '이번 갱신은 백엔드에 무효' 로 확정 실패시킨다.
#
# 불변식(이 스크립트의 핵심 규약)
#   [3] 백업 집합 == [4] 쓰기 집합 == [롤백] 복구 집합 == 지문 검증 범위.
#   네 개가 어긋나면 롤백이 되돌리지 못한 파일을 남긴 채 '복구 완료' 를 찍는다.
#   → 백엔드 대상 목록은 아래 BK_FILES / BK_DIRS **한 곳에만** 둔다.
#
# 절대 건드리지 않는 것 (배포 패키지에 애초에 들어 있지 않다 — 삭제형 동기화만 막으면 된다)
#   backend/.env, backend/dev.db, frontend/certs/, /etc/nginx/certs/*,
#   deploy/generated/**(병원별 Orthanc SQLite 인덱스), deploy/orthanc-generated.json,
#   deploy/scp-policy.env, deploy/worklists/*.wl, Docker 명명 볼륨(pgdata/orthanc)
#   → 그래서 이 스크립트는 **어디에도 rm -rf / rsync --delete 를 쓰지 않는다**(덮어쓰기 전용).
#
# 사용법
#   적용(서버에서, root 권한):
#       sudo sh update_server.sh --apply /경로/SaintviewViewerSuite-dist-YYYYMMDD-해시
#   경로 자동발견이 실패하면 직접 지정:
#       sudo sh update_server.sh --apply <패키지> --prefix /opt/saintview-viewer
#       ※ --prefix 를 주면 nginx 추론이 그 값을 **덮지 않는다**(명시가 추론을 이긴다).
#         종료코드: 0=적용·검증 모두 통과 / 2=적용은 끝났으나 검증 미완료(curl 없음) / 1=실패
#   미리보기 / 원격 진단 / 되돌리기:
#       sh   update_server.sh --dry-run  <패키지>
#       sh   update_server.sh --check    https://sv70.cloudcare.life
#       sudo sh update_server.sh --rollback [타임스탬프]
#         종료코드: 0=쓰기 집합 전부 복구 / 2=부분 복구(옛 포맷 백업 — 아래 불변식 참고) / 1=실패
#
#   옵션:  --prefix <설치루트>  --port <백엔드포트(기본 8010)>  --url <검증용 공개주소>
#          --pybin <백엔드가 쓰는 파이썬>   (venv 자동판정이 어긋날 때만)
#          --skip-nginx  --skip-restart
#          --migrate   DB 마이그레이션(alembic upgrade head)을 **허용**한다. 기본은 하지 않는다.
#                      ⚠ 이 스크립트의 핵심 불변식(백업 집합 = 쓰기 집합 = 복구 집합)이
#                        깨지는 유일한 지점이다 — **--rollback 은 DB 를 되돌리지 못한다**.
#                      다음 경우에는 플래그를 줘도 **거부한다**(거부가 기능이다):
#                        · DB 에 alembic_version 이 없음(= init_db() 가 만든 미스탬프 스키마).
#                          초기 리비전부터 재생돼 이미 있는 테이블에서 터진다. stamp 는
#                          사람이 스키마를 대조한 뒤 내리는 판단이지 배포 스크립트의 몫이 아니다.
#                        · head 가 여러 개(머지 필요) / DB 리비전이 패키지에 없음 / 판정 불가
#                        · SV_DB_BACKUP_DONE=1 이 없음(DB 백업 사실을 사람이 명시해야 한다)
#                      거부하면 파일 갱신은 그대로 끝내고 exit 2(요청 작업 미완료)로 보고한다.
#
#   환경변수:  SV_BACKUP_DIR  SV_BACKEND_LOG
#              SV_KEEP_BACKUPS=<개수> (기본 5 — 갱신 1회당 백업이 10MB 를 넘는다)
#              SV_FORCE_KILL=1  (종료 대기 초과 시 kill -9 를 허용 — 기본은 하지 않는다)
#              SV_TERM_WAIT=<초> (기본 30)
#              SV_DB_BACKUP_DONE=1  (--migrate 전용 — DB 백업을 마쳤다는 명시적 확인)
set -eu

PORT=8010
PREFIX=""
PKG=""
URL=""
MODE=""
STAMP=""
SKIP_NGINX=0
SKIP_RESTART=0
PYBIN_SET=""      # --pybin 으로 사람이 명시한 값(추론이 덮지 않는다)
PYDEPS_FAIL=0     # [5] 의 실패를 [8]·최종 배너까지 전파한다
MIGRATE=0            # --migrate: 마이그레이션을 '허용' 받았는가(허용받아도 거부할 수 있다)
MIGRATE_FAIL=0       # upgrade 를 실제로 돌렸는데 실패했다 → 확정 실패(exit 1)
MIGRATE_DONE=0       # upgrade 를 실제로 적용했다 → 배너에서 '롤백으로 못 되돌린다' 고 못 박는다
MIGRATE_INCOMPLETE=0 # --migrate 를 줬으나 거부했다 → 요청 작업 미완료(exit 2)
MIGRATE_UNVERIFIED=0 # upgrade 는 돌았는데 적용 후 리비전을 **읽지 못했다** → 미검증(exit 2)

# ── [2] 의 DB 진단 결과(읽기전용). 전 단계가 이 값을 근거로 말한다 ──────────
# ⚠ set -u 아래이므로 **반드시 여기서 초기화**한다(진단이 통째로 건너뛰어도 참조된다).
DB_URL_SHOWN=""      # 마스킹된 DB URL(원문은 어디에도 출력하지 않는다)
DB_KIND=""           # PostgreSQL | SQLite | 기타 | ?
DB_HEAD=""           # migrations/ 의 head 리비전(파일에서만 얻는다 — 출처는 DB_HEAD_SRC)
DB_HEAD_SRC=""       # "패키지" | "설치 트리" — head/미적용 목록을 **어느 트리에서** 읽었는가
ALEM_DIR=""          # 위 head/history 를 실행한 alembic 트리(= alembic.ini 가 있는 디렉터리)
DB_CURRENT=""        # DB 의 alembic 스탬프
DB_PENDING=""        # 미적용 리비전 목록(줄바꿈 구분)
DB_PENDING_N=0
DB_NOTE=""
DB_VERDICT="skip"    # latest|behind|unstamped|unknown-rev|multihead|undetermined|skip
MIG_VERDICT="unknown"  # same|changed|unknown — 이번 패키지가 migrations/ 를 바꾸는가

# ── [7] 의 런타임 판정. [8] 이 '왜 구버전인가' 를 귀속시키는 근거 ────────────
UNIT=""; CID=""; RUNTIME_CG=""; RUNTIME_UNCERTAIN=0
RUNTIME_CG_UNIT=""   # cgroup 에서 뽑혔지만 '백엔드 유닛이 아니다' 로 버린 이름(안내용)
DOCKER_VERDICT=""    # bind | image | unknown  (빈 값 = 도커가 아님)
DOCKER_NOTE=""; DOCKER_BIND_EVID=""
BACKUP_ROOT="${SV_BACKUP_DIR:-/var/backups/saintview-viewer}"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
TS="$(date +%Y%m%d%H%M%S)"

# ── 백엔드 '쓰기 집합' 단일 정의 ────────────────────────────────────────────
# 이 두 목록이 [3] 백업 · [4] 교체 · [롤백] 복구 · 지문 계산의 **유일한** 근거다.
# 왜 이렇게 묶는가: 예전에는 세 곳이 각자 목록을 손으로 들고 있었고, [4] 에
# alembic.ini · migrations/ · tools/ · .env.example 이 추가될 때 [3]/[롤백] 이
# 따라오지 않았다. 그 결과 롤백이 app/ 만 되돌리고도 '✅ 파일 복구 완료' 를 찍어,
# 운영자는 v48 로 돌아갔다고 믿지만 마이그레이션 리비전은 v50 인 혼합 트리가 남았다.
# → 목록을 한 곳에만 두어 다음에 대상이 늘어도 세 단계가 자동으로 함께 움직인다.
#   (app/ 과 frontend dist 는 취급이 특수해 — 정확 교체 / 복사 순서 — 따로 다룬다)
BK_FILES="requirements.txt alembic.ini .env.example"
BK_DIRS="migrations tools"

# ── 출력 도우미 ────────────────────────────────────────────────────────────
# ⚠ echo 를 쓰지 않는다. Debian/Ubuntu 의 /bin/sh 는 dash 이고 dash 의 내장 echo 는
#   XSI 방식으로 **백슬래시 이스케이프를 해석**한다. 그래서 `say "tr '\\0' ' ' < ..."`
#   같은 안내문이 NUL 바이트로 깨져 나가고(터미널은 NUL 을 버리므로 운영자가 복사하면
#   `tr '' ' '` 이 되어 exit 0 으로 조용히 잘못 동작한다), 경로·에러문자열처럼 백슬래시가
#   섞일 수 있는 값도 전부 같은 위험을 진다.
#   POSIX printf 의 %s 는 인자 안의 이스케이프를 해석하지 않는다 → 셸별 차이가 사라진다.
# ※ 이 블록은 인자 파싱보다 **위에** 있어야 한다. 파싱에서 die 를 쓸 수 있어야
#   값 빠진 옵션에 셸 원시 에러 대신 사람이 읽는 안내가 나간다.
STEP_N=0
step() { STEP_N=$((STEP_N + 1)); printf '\n[%d/8] %s\n' "$STEP_N" "$*"; }
say()  { printf '    %s\n' "$*"; }
ok()   { printf '  ✅ %s\n' "$*"; }
warn() { printf '  ⚠  %s\n' "$*"; }
die()  { printf '  ❌ %s\n\n' "$*"; exit 1; }
outln() { printf '%s\n' "$*"; }   # 들여쓰기 없는 한 줄(변수 값을 담아도 안전하다)

# 검증 결과 누적(마지막에 한꺼번에 판정한다 — 첫 실패에서 죽으면 원인 파악이 어렵다)
V_FAIL=0
vok()   { printf '  ✅ %s\n' "$*"; }
vng()   { printf '  ❌ %s\n' "$*"; V_FAIL=$((V_FAIL + 1)); }

curl_ok() { command -v curl >/dev/null 2>&1; }

# ── 인자 파싱 ──────────────────────────────────────────────────────────────
# ⚠ 값을 받는 옵션은 **값이 있는지 확인한 뒤에만** shift 한다. 무조건 shift 하면
#   값이 빠졌을 때($#=1) 안쪽 shift 가 $# 을 0 으로 만들고, 루프 끝의 shift 가 실패해
#   set -e 가 usage 도 '알 수 없는 인자' 도 못 찍은 채 셸을 죽인다
#   (dash: "shift: can't shift that many" / bash: 아무 출력 없이 exit 1).
while [ $# -gt 0 ]; do
  case "$1" in
    --apply)    MODE=apply;    PKG="${2:-}";  case "$PKG" in -*|"") PKG="" ;; *) shift ;; esac ;;
    --dry-run)  MODE=dryrun;   PKG="${2:-}";  case "$PKG" in -*|"") PKG="" ;; *) shift ;; esac ;;
    --check)    MODE=check;    URL="${2:-}";  case "$URL" in -*|"") URL="" ;; *) shift ;; esac ;;
    --rollback) MODE=rollback; STAMP="${2:-}";case "$STAMP" in -*|"") STAMP="" ;; *) shift ;; esac ;;
    --prefix)   PREFIX="${2:-}"
                case "$PREFIX" in -*|"") die "--prefix 에 설치 루트 경로가 필요합니다 (예: --prefix /opt/saintview-viewer)" ;; *) shift ;; esac ;;
    --port)     PORT="${2:-}"
                case "$PORT" in ''|*[!0-9]*) die "--port 에 숫자 포트가 필요합니다 (예: --port 8010)" ;; *) shift ;; esac
                # printf '%04X' "$PORT"(port_busy/find_backend_pid)가 깨지지 않도록 범위까지 본다.
                if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then die "--port 는 1..65535 여야 합니다: $PORT"; fi ;;
    --url)      URL="${2:-}"
                case "$URL" in -*|"") die "--url 에 주소가 필요합니다 (예: --url https://sv70.cloudcare.life)" ;; *) shift ;; esac ;;
    --pybin)    PYBIN_SET="${2:-}"
                case "$PYBIN_SET" in -*|"") die "--pybin 에 파이썬 실행파일 경로가 필요합니다" ;; *) shift ;; esac ;;
    --skip-nginx)   SKIP_NGINX=1 ;;
    --skip-restart) SKIP_RESTART=1 ;;
    --migrate)      MIGRATE=1 ;;
    -h|--help)  MODE=help ;;
    *)          outln "알 수 없는 인자: $1"; MODE=help ;;
  esac
  shift
done
[ -n "$MODE" ] || MODE=help
# --prefix 를 '사람이 줬는지' 는 PREFIX 자체로는 알 수 없다(detect_paths 가 재대입한다).
# 추론이 명시값을 덮지 못하게 하려면 이 사실을 따로 보관해야 한다.
PREFIX_SET=""
if [ -n "$PREFIX" ]; then PREFIX_SET=1; fi

# 상태코드만 뽑는다. curl 은 연결 실패 시 -w 로 이미 '000' 을 찍고 나서 비-0 으로 끝나므로
# `|| echo 000` 을 붙이면 '000000' 이 된다 → 종료상태만 삼키고 값은 그대로 쓴다.
hcode() {
  HC="$(curl -sS -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || true)"
  case "$HC" in ''|*[!0-9]*) HC=000 ;; esac
  printf '%s' "$HC"
}

# ── 배포 지문(fingerprint) ────────────────────────────────────────────────
# 왜 필요한가: 백업/롤백이 '무엇을' 담고 있는지 기계가 알아야 한다. 타임스탬프만으로는
# '이미 신버전이 백업된 디렉터리' 를 되돌리면서 성공을 보고하는 거짓 롤백을 막을 수 없다.
HASHER=""
pick_hasher() {
  for h in sha256sum sha1sum md5sum cksum; do
    if command -v "$h" >/dev/null 2>&1; then HASHER="$h"; return 0; fi
  done
  return 1
}
# 디렉터리의 *.py 내용을 경로 순서대로 이어 해시한다(파일명이 아니라 내용+순서를 본다 —
# 백업본과 실서버는 경로 접두사가 다르므로 경로 자체는 비교 대상이 될 수 없다).
tree_hash() {
  if [ ! -d "$1" ]; then printf 'none'; return 0; fi
  if [ -z "$HASHER" ]; then pick_hasher || { printf 'nohasher'; return 0; }; fi
  find "$1" -type f -name '*.py' 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do
    "$HASHER" "$f" 2>/dev/null | awk '{print $1}'
  done | "$HASHER" 2>/dev/null | awk '{print $1}'
}
asset_of() {  # $1 = index.html 이 들어 있는 디렉터리
  grep -o 'assets/index-[A-Za-z0-9_-]*\.js' "$1/index.html" 2>/dev/null | sort -u | head -1
}

# app/ 밖의 백엔드 쓰기 집합(BK_FILES · BK_DIRS)의 지문.
# tree_hash 와 두 가지가 다르다:
#   · 확장자를 가리지 않는다 — alembic.ini 와 tools/*.mjs 는 *.py 필터에 안 걸린다.
#   · **상대경로까지** 해싱한다 — 파일이 통째로 사라진 것과 내용이 바뀐 것을 모두 잡아야
#     '롤백했는데 migrations/ 만 신버전' 같은 혼합 상태를 감지할 수 있다.
# 설치 트리($BACKEND_DIR)와 백업 디렉터리($BDIR)는 같은 상대구조를 쓰므로 값이 직접 비교된다.
# $1 = 루트(설치 트리 또는 백업 디렉터리)
extra_hash() {
  if [ -z "$HASHER" ]; then pick_hasher || { printf 'nohasher'; return 0; }; fi
  XR="$1"
  {
    for p in $BK_FILES; do
      if [ -f "$XR/$p" ]; then
        printf '%s ' "$p"; "$HASHER" "$XR/$p" 2>/dev/null | awk '{print $1}'
      fi
    done
    for d in $BK_DIRS; do
      if [ -d "$XR/$d" ]; then
        # __pycache__ 는 실행 중에 생겼다 사라지므로 지문에서 뺀다(안 그러면 백업본과
        # 설치 트리가 영원히 불일치한다).
        find "$XR/$d" -type f ! -path '*/__pycache__/*' 2>/dev/null | LC_ALL=C sort \
        | while IFS= read -r f; do
            printf '%s ' "${f#"$XR"/}"; "$HASHER" "$f" 2>/dev/null | awk '{print $1}'
          done
      fi
    done
  } | "$HASHER" 2>/dev/null | awk '{print $1}'
}
# migrations/ 만의 지문. extra_hash 의 부분집합이지만 **따로** 필요하다:
# '이번 갱신이 스키마를 건드리는가' 라는 질문은 migrations/ 하나로 답이 나오는데,
# extra_hash 는 tools/·requirements.txt 변경까지 섞여 있어 그 질문에 답할 수 없다.
# 이 값을 쓰면 '이번 릴리스는 스키마를 안 바꾼다' 는 사실을 주석이 아니라 **계산**으로
# 말하게 되고, 다음 릴리스에서 자동으로 참/거짓이 갱신돼 안내문이 썩지 않는다.
# $1 = 루트(설치 트리 또는 패키지의 backend/)
mig_hash() {
  if [ -z "$HASHER" ]; then pick_hasher || { printf 'nohasher'; return 0; }; fi
  MH="$1"
  if [ ! -d "$MH/migrations" ]; then printf 'none'; return 0; fi
  find "$MH/migrations" -type f ! -path '*/__pycache__/*' 2>/dev/null | LC_ALL=C sort \
  | while IFS= read -r f; do
      printf '%s ' "${f#"$MH"/}"; "$HASHER" "$f" 2>/dev/null | awk '{print $1}'
    done | "$HASHER" 2>/dev/null | awk '{print $1}'
}

# 지문 비교. 0=같음 1=다름 2=비교불가(해시 도구 없음)
fp_same() {  # $1=assetA $2=hashA $3=assetB $4=hashB
  case "$2$4" in *nohasher*)
    if [ -n "$1" ] && [ "$1" = "$3" ]; then return 2; fi
    return 1 ;;
  esac
  if [ "$1" = "$3" ] && [ "$2" = "$4" ]; then return 0; fi
  return 1
}

# manifest.env 값 읽기. `.` 로 source 하면 PORT·PKG 같은 현재 변수까지 덮어써 버리므로
# 필요한 키만 뽑아 쓴다. 따옴표 유무 양쪽(구 버전 백업 호환)을 모두 받는다.
mval() {  # $1=파일 $2=키
  sed -n "s/^$2=['\"]\{0,1\}\([^'\"]*\)['\"]\{0,1\}\$/\1/p" "$1" 2>/dev/null | head -1
}
# 경로를 manifest 키로 쓸 수 있게 정규화한다(requirements.txt → requirements_txt).
# mval 의 sed 는 키를 정규식으로 쓰므로 '.' 같은 메타문자가 그대로 들어가면 안 된다.
mkey() { printf '%s' "$1" | tr -c 'A-Za-z0-9' '_'; }

# ── 소유권 보존 ────────────────────────────────────────────────────────────
# cp -a 는 **패키지(root 소유)의 소유권까지 복사**한다. 비-root 서비스 계정으로 도는
# 배포에서는 이것만으로 backend/app 과 frontend/dist 가 root:root 로 바뀌어
# __pycache__ 생성·앱의 임시파일 쓰기가 EACCES 로 깨진다. 복사 후 되돌린다.
own_of() {  # $1=경로 → "user:group" (실패 시 빈 문자열)
  stat -c '%U:%G' "$1" 2>/dev/null || true
}

# ── 마지막 방어선: 시스템 최상위에는 절대 쓰지 않는다 ──────────────────────
# 경로 계산이 어디서 어떻게 틀리든(manifest 파싱 실패로 빈 문자열, nginx 추론 오판 등)
# root 로 `cp -a <dist>/. /` · `mv /app ...` · `chown -R <계정> /` 를 실행하는 일만은
# 막아야 한다. 값을 만든 쪽이 아니라 **쓰는 쪽**에서 한 번 더 본다.
#   0 = 위험(쓰면 안 됨)   1 = 안전
unsafe_target() {
  case "${1:-}" in
    ''|/|/bin|/boot|/dev|/etc|/home|/lib|/lib32|/lib64|/libx32|/media|/mnt|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var) return 0 ;;
  esac
  case "$1" in /*) ;; *) return 0 ;; esac   # 절대경로가 아니면 위험(상대경로 쓰기 금지)
  return 1
}

# 심볼릭 링크·`..` 를 푼 실물 경로. 문자열만 다른 같은 디렉터리를 '불일치' 로 오판하지 않기 위해.
realdir() {
  [ -n "${1:-}" ] || { printf ''; return 0; }
  ( cd "$1" 2>/dev/null && pwd -P ) 2>/dev/null || printf '%s' "$1"
}

# ── 외부 명령 시간 제한 ────────────────────────────────────────────────────
# DB 접속과 docker inspect 는 네트워크·데몬 사정으로 무한정 멈출 수 있다. 진단 하나가
# 배포창을 통째로 잡아먹는 일은 없어야 한다. timeout(coreutils)이 있으면 쓰고,
# 없다고 진단 자체를 포기하지는 않는다(그냥 실행한다).
TIMEOUT_BIN="$(command -v timeout 2>/dev/null || true)"
to_run() {  # $1=초  $2...=명령
  TR_S="$1"; shift
  if [ -n "$TIMEOUT_BIN" ]; then "$TIMEOUT_BIN" "$TR_S" "$@"; else "$@"; fi
}

# ── DB URL 마스킹 ──────────────────────────────────────────────────────────
# 실서버 backend/.env 의 SAINTVIEW_DATABASE_URL 에는 Postgres 비밀번호가 그대로
# 박혀 있다. 원문을 찍으면 배포 로그·운영자 스크롤백·ssh 세션 기록에 유출된다 —
# 마스킹은 미관이 아니라 요건이다. 스킴 + host:port/dbname 만 남긴다.
mask_url() {
  MU="${1:-}"
  case "$MU" in
    '')    printf '(빈 값)'; return 0 ;;
    *://*) ;;
    *)     printf '(형식 불명 — 출력하지 않습니다)'; return 0 ;;
  esac
  MU_S="${MU%%://*}"                                    # 스킴
  MU_R="${MU#*://}"
  MU_R="${MU_R%%\?*}"                                   # 쿼리스트링 제거(여기에도 암호가 온다)
  # ⚠ authority 와 path 를 **먼저** 가른 뒤 authority 안에서만 자격증명을 지운다.
  #   · `${x#*@}`(최단 일치)만 쓰면 비밀번호에 '@' 가 섞였을 때 첫 '@' 까지만 지워
  #     뒷부분이 그대로 나간다(sv:p@ss@host → ***@ss@host — 비밀번호 유출).
  #   · 그렇다고 통째로 `##*@`(최장 일치)를 쓰면 path 의 '@'(RFC 3986 에서 합법)까지
  #     먹어 host:port 가 통째로 사라진다(...@host:5432/db@archive → ***@archive).
  #   → 분리한 뒤 authority 안에서만 최장 일치. 두 오류가 동시에 닫힌다.
  MU_A="${MU_R%%/*}"
  case "$MU_R" in
    */*) MU_P="/${MU_R#*/}" ;;
    *)   MU_P="" ;;
  esac
  case "$MU_A" in *@*) MU_A="***@${MU_A##*@}" ;; esac    # 자격증명 통째 제거(마지막 '@' 까지)
  printf '%s://%s%s' "$MU_S" "$MU_A" "$MU_P"
}

chown_back() {  # $1=경로 $2="user:group"
  if unsafe_target "${1:-}"; then
    warn "시스템 경로에는 소유권을 바꾸지 않습니다(경로 계산 오류로 보입니다): '${1:-}'"
    return 0
  fi
  [ -n "${2:-}" ] || return 0
  case "$2" in *:*) ;; *) return 0 ;; esac
  case "$2" in *UNKNOWN*|*:) return 0 ;; esac
  [ "$2" = "root:root" ] && return 0
  [ -e "$1" ] || return 0
  chown -R "$2" "$1" 2>/dev/null || warn "소유권 복원 실패: $1 → $2 (수동: chown -R $2 $1)"
}

# ── 포트/프로세스 생사 판정 ────────────────────────────────────────────────
# 재시작에서 '구 프로세스가 죽었나' 를 kill -0 으로 보면 안 된다: 좀비(Z)에도 성공한다.
# 우리가 실제로 알고 싶은 것은 **포트가 풀렸는가**(= 새 프로세스를 띄울 수 있는가)다.
port_busy() {  # 0=리스너 있음 1=없음 2=판정불가
  if command -v ss >/dev/null 2>&1; then
    if ss -lntH "sport = :$PORT" 2>/dev/null | grep -q .; then return 0; else return 1; fi
  fi
  if command -v lsof >/dev/null 2>&1; then
    if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | grep -q .; then return 0; else return 1; fi
  fi
  if [ -r /proc/net/tcp ]; then
    HEXP="$(printf '%04X' "$PORT")"
    for f in /proc/net/tcp /proc/net/tcp6; do
      [ -r "$f" ] || continue
      if awk -v h=":$HEXP\$" '$4=="0A" && $2 ~ h {found=1} END{exit found?0:1}' "$f" 2>/dev/null; then
        return 0
      fi
    done
    return 1
  fi
  if command -v netstat >/dev/null 2>&1; then
    if netstat -lntn 2>/dev/null | awk -v p=":$PORT\$" '$4 ~ p {found=1} END{exit found?0:1}'; then
      return 0
    else return 1; fi
  fi
  return 2
}

# 0=종료됨(좀비 포함) 1=아직 살아있음
# ※ /proc/PID/stat 의 상태문자는 comm 에 공백·괄호가 들어갈 수 있어 $3 로 못 뽑는다.
#   마지막 ')' 뒤부터 잘라야 한다.
proc_gone() {
  [ -n "${1:-}" ] || return 0
  if [ -d "/proc/$1" ]; then
    PS_="$(sed -n 's/.*) //p' "/proc/$1/stat" 2>/dev/null | awk '{print $1}')"
    [ "$PS_" = "Z" ] && return 0
    [ -n "$PS_" ] && return 1
  fi
  kill -0 "$1" 2>/dev/null || return 0
  return 1
}

# ═══════════════════════════════════════════════════════════════════════════
# [1] 사전 점검
# ═══════════════════════════════════════════════════════════════════════════
precheck() {
  step "사전 점검"

  if [ "$MODE" = "apply" ] || [ "$MODE" = "rollback" ]; then
    [ "$(id -u)" = "0" ] || die "root 권한이 필요합니다.  sudo sh $(basename "$0") ... 로 다시 실행하세요"
    ok "root 권한"
  fi

  if [ "$MODE" = "apply" ] || [ "$MODE" = "dryrun" ]; then
    [ -n "$PKG" ] || die "패키지 경로가 없습니다.  --apply /경로/SaintviewViewerSuite-dist-YYYYMMDD-해시"
    [ -d "$PKG" ] || die "패키지 디렉터리가 아닙니다: $PKG  (zip 이라면 먼저 unzip 하세요)"
    PKG="$(cd "$PKG" && pwd)"
    # make_dist.py 가 만드는 3대 산출물이 모두 있어야 정상 패키지다.
    for f in VERSION.txt frontend/dist/index.html backend/app/main.py backend/requirements.txt; do
      [ -e "$PKG/$f" ] || die "패키지에 $f 가 없습니다 — 잘못된 경로이거나 손상된 패키지입니다"
    done
    ok "패키지: $PKG"
    say "버전: $(head -1 "$PKG/VERSION.txt" 2>/dev/null || echo '?')"
    # 프론트 참조 자산을 미리 뽑아 둔다([8] 검증의 기준선).
    PKG_ASSET="$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' "$PKG/frontend/dist/index.html" | sort -u | head -1)"
    [ -n "$PKG_ASSET" ] || die "패키지 index.html 에서 assets/index-*.js 참조를 찾지 못했습니다"
    say "참조 자산: $PKG_ASSET"
  fi

  if [ "$MODE" = "apply" ] || [ "$MODE" = "dryrun" ]; then
    NGINX="$(command -v nginx || true)"
    if [ -n "$NGINX" ]; then ok "nginx: $NGINX"
    else warn "nginx 를 PATH 에서 찾지 못했습니다 — 프론트 경로 자동발견과 [6] 단계가 제한됩니다"; fi
    curl_ok && ok "curl 사용 가능" \
            || warn "curl 이 없습니다 — HTTP 검증을 건너뜁니다(디스크 검증은 그대로 수행하고, 최종 판정은 '검증 미완료'가 됩니다)"
    # 과거 실행이 중단돼 /etc/nginx/conf.d 에 남았을 수 있는 brotli 탐침 파일을 회수한다.
    # (파일을 쓰는 실행이므로 apply 에서만. 그리고 root 여야 지울 수 있다)
    if [ "$MODE" = "apply" ] && [ "$(id -u)" = "0" ]; then probe_reap_stale; fi
  fi

  # 백엔드 생존 확인. 살아 있어야 [2] 에서 PID→cwd 로 설치 경로를 역추적할 수 있다.
  BACKEND_ALIVE=0
  if curl_ok; then
    if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      BACKEND_ALIVE=1; ok "백엔드 살아있음 (127.0.0.1:$PORT)"
    else
      warn "백엔드가 127.0.0.1:$PORT/api/health 에 응답하지 않습니다"
      warn "  → 이미 죽어 있을 수 있습니다. --prefix 로 설치 경로를 직접 지정하세요"
    fi
  fi
}

# ═══════════════════════════════════════════════════════════════════════════
# [2] 설치 경로 자동 발견
#     원칙: 추측하지 않는다. 두 개의 독립 근거(백엔드 PID 의 cwd / nginx root)를
#           각각 구해 **대조**하고, 어긋나면 멈춘다.
# ═══════════════════════════════════════════════════════════════════════════

# 포트 점유 PID 찾기 — 서버에 무엇이 깔려 있는지 모르므로 사다리로 내려간다.
# ss(iproute2) → lsof → fuser → netstat → procfs 직접 스캔.
# ※ 패키지를 설치해서 도구를 확보하려 들지 않는다(운영 서버 변경 금지).
# ※ 타 사용자 PID 를 보려면 root 가 필요하다. 비root 면 조용히 빈 결과가 나오므로
#    '없음' 과 '못 봄' 을 구분해 표시한다.
find_backend_pid() {
  BPID=""
  if command -v ss >/dev/null 2>&1; then
    BPID="$(ss -lptnH "sport = :$PORT" 2>/dev/null \
            | sed -n 's/.*pid=\([0-9]\{1,\}\).*/\1/p' | head -1)"
  fi
  if [ -z "$BPID" ] && command -v lsof >/dev/null 2>&1; then
    BPID="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
  fi
  if [ -z "$BPID" ] && command -v fuser >/dev/null 2>&1; then
    BPID="$(fuser -n tcp "$PORT" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' | head -1)"
  fi
  if [ -z "$BPID" ] && command -v netstat >/dev/null 2>&1; then
    BPID="$(netstat -lptn 2>/dev/null | awk -v p=":$PORT\$" '$4 ~ p {print $7}' \
            | cut -d/ -f1 | grep -E '^[0-9]+$' | head -1)"
  fi
  if [ -z "$BPID" ] && [ -r /proc/net/tcp ]; then
    # 최종 폴백 — 리눅스면 무조건 통한다. /proc/net/tcp 는 포트가 16진수다.
    HEX="$(printf '%04X' "$PORT")"
    INO="$(awk -v h=":$HEX" '$4=="0A" && $2 ~ h {print $10}' /proc/net/tcp /proc/net/tcp6 2>/dev/null | head -1)"
    if [ -n "$INO" ]; then
      for p in /proc/[0-9]*; do
        if ls -l "$p/fd" 2>/dev/null | grep -q "socket:\[$INO\]"; then BPID="${p##*/}"; break; fi
      done
    fi
  fi
  [ -n "$BPID" ] && return 0 || return 1
}

# ── 백엔드가 **실제로 실행 중인** 파이썬 찾기 ──────────────────────────────
# ⚠ /proc/PID/exe 를 쓰면 안 된다. venv 는 기본(심볼릭 링크) 생성이라
#   venv/bin/python → /usr/bin/python3.x 이고, exe 는 링크를 다 푼 **베이스
#   인터프리터**를 가리킨다. 그 파이썬에 pip install 하면
#     · 백엔드(venv)에는 패키지가 그대로 없어 ISO 반출이 계속 501 이고
#     · requirements 전량이 시스템 파이썬에 설치돼 OS 를 오염시킨다.
#   → 실행된 경로 그 자체인 **argv[0]** 을 쓴다(심볼릭 링크를 풀지 않는다).
#   그리고 VIRTUAL_ENV / 파일시스템의 venv / sys.prefix 로 **교차검증**한다.
resolve_pybin() {
  PYBIN=""; PYBIN_SRC=""

  if [ -n "$PYBIN_SET" ]; then
    [ -x "$PYBIN_SET" ] || die "--pybin 이 실행 가능한 파일이 아닙니다: $PYBIN_SET"
    PYBIN="$PYBIN_SET"; PYBIN_SRC="--pybin(사용자 지정)"
  fi

  # (a) argv[0] — 가장 직접적인 근거
  A0=""
  if [ -z "$PYBIN" ] && [ -n "${BPID:-}" ] && [ -r "/proc/$BPID/cmdline" ]; then
    A0="$(tr '\0' '\n' < "/proc/$BPID/cmdline" 2>/dev/null | head -1)"
    case "$A0" in
      /*) ;;
      */*) A0="${CWD:-.}/$A0" ;;                       # 상대경로 → 프로세스 cwd 기준 절대화
      "") ;;
      *)  A0="$(command -v "$A0" 2>/dev/null || true)" ;;  # PATH 로 실행된 이름뿐
    esac
    if [ -n "$A0" ]; then
      # dirname 만 정규화한다. readlink -f 로 마지막 성분까지 풀면 venv 링크가
      # 베이스 인터프리터로 되돌아가 버린다(이 버그의 원인 그 자체).
      A0D="$(dirname "$A0")"; A0B="$(basename "$A0")"
      if [ -d "$A0D" ]; then A0="$(cd "$A0D" && pwd)/$A0B"; A0D="$(cd "$A0D" && pwd)"; fi
      case "$A0B" in
        python|python[0-9]*|pypy*)
          PYBIN="$A0"; PYBIN_SRC="argv[0]" ;;
        *)
          # uvicorn/gunicorn 같은 콘솔 스크립트로 떴다면 같은 bin/ 의 python 이 그 환경이다.
          if   [ -x "$A0D/python" ];  then PYBIN="$A0D/python";  PYBIN_SRC="argv[0] 스크립트의 bin/python"
          elif [ -x "$A0D/python3" ]; then PYBIN="$A0D/python3"; PYBIN_SRC="argv[0] 스크립트의 bin/python3"
          else
            SB="$(sed -n '1s/^#![[:space:]]*//p' "$A0" 2>/dev/null | awk '{print $1}')"
            if [ -n "$SB" ] && [ -x "$SB" ]; then PYBIN="$SB"; PYBIN_SRC="argv[0] 스크립트의 shebang"; fi
          fi ;;
      esac
    fi
  fi

  # (b) 파일시스템의 venv — 프로세스가 이미 죽어 있을 때의 폴백이자, (a) 의 대조군
  FS_VENV_PY=""
  for c in "$BACKEND_DIR/venv/bin/python" "$BACKEND_DIR/.venv/bin/python" \
           "${PREFIX:-}/venv/bin/python" "${PREFIX:-}/.venv/bin/python"; do
    case "$c" in /venv/*|/.venv/*) continue ;; esac   # PREFIX 가 비었을 때의 잘못된 경로 방지
    if [ -x "$c" ]; then FS_VENV_PY="$c"; break; fi
  done
  if [ -z "$PYBIN" ] && [ -n "$FS_VENV_PY" ]; then
    PYBIN="$FS_VENV_PY"; PYBIN_SRC="파일시스템 venv(프로세스 미발견 폴백)"
  fi

  if [ -z "$PYBIN" ]; then
    warn "백엔드가 쓰는 파이썬을 특정하지 못했습니다"
    return 0
  fi
  [ -x "$PYBIN" ] || { warn "인터프리터가 실행 가능하지 않습니다: $PYBIN"; PYBIN=""; return 0; }

  say "인터프리터: $PYBIN   (근거: $PYBIN_SRC)"
  PYPREFIX="$("$PYBIN" -c 'import sys; print(sys.prefix)' 2>/dev/null || true)"
  if [ -n "$PYPREFIX" ]; then say "sys.prefix: $PYPREFIX"; fi

  # ── 교차검증. 사람이 --pybin 으로 못 박았으면 검증하지 않는다(명시가 추론을 이긴다).
  [ -n "$PYBIN_SET" ] && return 0

  # (c) 프로세스 환경의 VIRTUAL_ENV
  VENV_ENV=""
  if [ -n "${BPID:-}" ] && [ -r "/proc/$BPID/environ" ]; then
    VENV_ENV="$(tr '\0' '\n' < "/proc/$BPID/environ" 2>/dev/null | sed -n 's/^VIRTUAL_ENV=//p' | head -1)"
  fi
  if [ -n "$VENV_ENV" ] && [ -n "$PYPREFIX" ] && [ "$VENV_ENV" != "$PYPREFIX" ]; then
    warn "인터프리터 근거가 어긋납니다:"
    warn "  VIRTUAL_ENV = $VENV_ENV"
    warn "  sys.prefix  = $PYPREFIX  ($PYBIN)"
    die "어느 파이썬에 설치할지 확정할 수 없습니다.  --pybin '$VENV_ENV/bin/python' 으로 지정하세요"
  fi

  # (d) 설치 트리에 venv 가 있는데 그 밖의 파이썬을 골랐다면 거의 확실히 오판이다.
  if [ -n "$FS_VENV_PY" ] && [ -n "$PYPREFIX" ]; then
    FSP="$("$FS_VENV_PY" -c 'import sys; print(sys.prefix)' 2>/dev/null || true)"
    if [ -n "$FSP" ] && [ "$FSP" != "$PYPREFIX" ]; then
      warn "인터프리터 근거가 어긋납니다:"
      warn "  설치 트리의 venv = $FS_VENV_PY  (prefix=$FSP)"
      warn "  프로세스 기준     = $PYBIN  (prefix=$PYPREFIX)"
      die "venv 를 두고 시스템 파이썬에 설치하면 백엔드에는 반영되지 않습니다.  --pybin 으로 지정하세요"
    fi
  fi
}

# ── 런타임 판별(읽기전용) ──────────────────────────────────────────────────
# cgroup 한 줄에서 systemd 유닛과 docker 컨테이너 ID 를 뽑는다. [7] 안에 박아 두면
# dry-run 이 같은 사실을 말할 수 없어서(그리고 [8] 이 원인을 귀속시킬 수 없어서)
# 밖으로 뺐다. 아무것도 바꾸지 않는다.
# ⚠ 세 번째 결과가 중요하다: cgroup 에 컨테이너 흔적은 있는데 docker CID 로 특정하지
#   못한 경우(podman/containerd/k8s). 이것을 '맨 프로세스' 로 흘려보내면 컨테이너 안
#   프로세스에 kill -TERM 을 보내는 셈이 되어, 컨테이너가 통째로 죽고 재기동 정책에
#   따라 **구 이미지로 다시 뜬다**. 그래서 별도 '판정 불가' 로 가른다.
detect_runtime() {
  UNIT=""; CID=""; RUNTIME_CG=""; RUNTIME_UNCERTAIN=0; RUNTIME_CG_UNIT=""
  [ -n "${BPID:-}" ] || return 0
  [ -r "/proc/$BPID/cgroup" ] || return 0
  RUNTIME_CG="$(cat "/proc/$BPID/cgroup" 2>/dev/null || true)"
  # cgroup v1/v2, 시스템/사용자 유닛, docker/k8s 로 형태가 제각각이라
  # 단일 정규식으로는 반드시 어딘가 틀린다 → 두 패턴을 각각 시도한다.
  UNIT="$(printf '%s' "$RUNTIME_CG" | sed -n 's#.*[:/]\([A-Za-z0-9@._-]\{1,\}\.service\).*#\1#p' | head -1)"
  CID="$(printf '%s' "$RUNTIME_CG" | sed -n 's#.*/docker[-/]\([0-9a-f]\{12,64\}\).*#\1#p' | head -1)"
  if [ -z "$CID" ]; then
    case "$RUNTIME_CG" in
      */docker*|*kubepods*|*libpod*|*/crio-*|*containerd*|*/lxc*) RUNTIME_UNCERTAIN=1 ;;
    esac
  fi
  # ⚠ UNIT 과 RUNTIME_UNCERTAIN 은 **동시에** 참일 수 있다. 컨테이너의 cgroup 경로에는
  #   그 컨테이너를 담고 있는 상위 유닛이 그대로 박혀 있기 때문이다:
  #     podman rootless : /user.slice/user-1000.slice/user@1000.service/.../libpod-*.scope
  #     containerd      : /system.slice/containerd.service/kubepods-pod*.slice
  #     lxc             : /lxc/web01/system.slice/<컨테이너 안 유닛>.service
  #   여기서 뽑히는 `.service` 는 **백엔드의 유닛이 아니다**. 그대로 두면 do_restart 의
  #   UNIT 분기가 '판정 불가' 가드보다 먼저 이겨서 호스트의 containerd.service /
  #   user@1000.service 를 재시작하고(= 그 머신의 컨테이너 전부가 내려간다) '✅ 재시작
  #   완료' 라는 거짓 성공을 찍는다. 근거가 없으므로 후보에서 지운다.
  if [ "$RUNTIME_UNCERTAIN" = "1" ] && [ -n "$UNIT" ]; then
    RUNTIME_CG_UNIT="$UNIT"; UNIT=""
  else
    RUNTIME_CG_UNIT=""
  fi
  # 공개 포트 배포에서 ss 가 docker-proxy 를 집으면 UNIT 이 런타임 데몬으로 잡힌다.
  # 이름만으로 명백히 '백엔드 유닛이 아닌' 것은 컨테이너 흔적이 없어도 거른다.
  case "$UNIT" in
    docker.service|containerd.service|crio.service|podman.service|user@*.service|init.scope)
      RUNTIME_CG_UNIT="$UNIT"; UNIT=""; RUNTIME_UNCERTAIN=1 ;;
  esac
  return 0
}

# ── 도커 bind mount '증명' ─────────────────────────────────────────────────
# 예전에는 여기서 안내문만 찍고 return 1 했다(정답 명령을 출력하면서 실행은 사람에게
# 떠넘겼다). 그 결과 도커로 도는 서버는 매번 수동이었고, 더 나쁘게는 '왜 구버전인가'
# 를 [8] 이 몰라서 '재시작 누락 의심' 이라는 **틀린 원인**을 찍었다.
#   bind mount 가 증명된 restart 는 systemctl restart 와 의미가 정확히 같다(코드는
#   진짜로 교체됐다) → 거부할 이유가 없다. 거부해야 하는 것은 '증명 못 한' 경우다.
# ⚠ Source 비교는 결국 문자열 비교다. 심볼릭 링크·`..` 는 realdir 로 풀지만, 해석에
#   실패하면 **'없음' 이 아니라 '판정 불가'** 로 떨어뜨린다(안전한 쪽 오류).
#   '마운트 있음' 으로 잘못 판정하면 이미지 내장인데도 restart 하고 '완료' 를 찍는
#   가장 나쁜 사고가 재현된다.
# 결과: DOCKER_VERDICT = bind | image | unknown  (+ DOCKER_NOTE / DOCKER_BIND_EVID)
docker_verdict() {  # $1 = 컨테이너 ID
  DOCKER_VERDICT="unknown"; DOCKER_NOTE=""; DOCKER_BIND_EVID=""
  DV_CID="${1:-}"
  [ -n "$DV_CID" ] || { DOCKER_NOTE="컨테이너 ID 를 얻지 못했습니다"; return 0; }
  if ! command -v docker >/dev/null 2>&1; then
    DOCKER_NOTE="docker CLI 가 PATH 에 없습니다"; return 0
  fi
  DV_TGT="$(realdir "${BACKEND_DIR:-}")"
  case "$DV_TGT" in /?*) ;; *) DOCKER_NOTE="설치 경로를 정규화하지 못했습니다: ${BACKEND_DIR:-}"; return 0 ;; esac
  [ -d "$DV_TGT" ] || { DOCKER_NOTE="설치 경로가 디렉터리가 아닙니다: $DV_TGT"; return 0; }

  DVRC=0
  DV_M="$(to_run 20 docker inspect \
            --format '{{range .Mounts}}{{.Type}}|{{.Source}}|{{.Destination}}{{"\n"}}{{end}}' \
            "$DV_CID" 2>/dev/null)" || DVRC=$?
  if [ "$DVRC" != "0" ]; then
    DOCKER_NOTE="docker inspect 실패(exit $DVRC — 데몬 권한 없음 / 알 수 없는 컨테이너)"
    return 0
  fi
  DVF="$(mktemp 2>/dev/null || true)"
  [ -n "$DVF" ] || { DOCKER_NOTE="임시파일을 만들지 못해 마운트를 해석하지 못했습니다"; return 0; }
  printf '%s\n' "$DV_M" > "$DVF"

  # ※ 파이프라인의 while 은 서브셸이라 변수가 밖으로 안 나온다(dash) → 파일 리다이렉션.
  DV_HIT=""; DV_UNRES=0; DV_BINDS=0
  while IFS='|' read -r dvt dvs dvd; do
    [ -n "$dvt" ] || continue
    [ "$dvt" = "bind" ] || continue
    DV_BINDS=$((DV_BINDS + 1))
    if [ -f "$dvs" ] && [ ! -d "$dvs" ]; then continue; fi   # 파일 바인드는 코드 트리를 덮을 수 없다
    if [ ! -d "$dvs" ]; then
      # 호스트에 존재하지 않는 Source — 해석 실패다. '없음' 으로 단정하면 안 된다.
      DV_UNRES=1; DOCKER_NOTE="마운트 원본을 호스트에서 해석하지 못했습니다: $dvs"
      continue
    fi
    dvr="$(realdir "$dvs")"
    if [ "$dvr" = "$DV_TGT" ]; then DV_HIT="$dvs → $dvd (완전일치)"; break; fi
    case "$DV_TGT" in "$dvr"/*) DV_HIT="$dvs → $dvd (설치 경로의 상위)"; break ;; esac
  done < "$DVF"
  rm -f "$DVF"

  if [ -n "$DV_HIT" ]; then
    DOCKER_VERDICT="bind"; DOCKER_BIND_EVID="$DV_HIT"
    return 0
  fi
  if [ "$DV_UNRES" = "1" ]; then DOCKER_VERDICT="unknown"; return 0; fi
  DOCKER_VERDICT="image"
  DOCKER_NOTE="bind 마운트 ${DV_BINDS}건 중 $DV_TGT 를 덮는 것이 없습니다"
  return 0
}

# ── 이번 패키지가 migrations/ 를 바꾸는가 ──────────────────────────────────
# 결론을 저장소 diff 로 하드코딩하지 않는다. 실서버가 이 저장소보다 옛 패키지로 돌고
# 있을 수 있고(어느 dist 로 설치됐는지 스크립트는 모른다), 그러면 '스키마 변경 없음'
# 이라는 결론이 통째로 성립하지 않는다 → 매 실행 지문으로 계산한다.
mig_compare() {
  MIG_VERDICT="unknown"
  [ -n "${PKG:-}" ] || return 0
  [ -n "${BACKEND_DIR:-}" ] || return 0
  MC_A="$(mig_hash "$BACKEND_DIR")"
  MC_B="$(mig_hash "$PKG/backend")"
  case "$MC_A$MC_B" in *nohasher*) return 0 ;; esac
  if [ "$MC_A" = "$MC_B" ]; then MIG_VERDICT="same"; else MIG_VERDICT="changed"; fi
  return 0
}

# ── [2] DB 진단 — 항상 돌고, 아무것도 바꾸지 않는다 ────────────────────────
# 왜 [2] 끝인가: 백업·교체보다 **먼저** 현장의 DB 체제를 알아야 --migrate 의 허용/거부를
# 사실로 판단할 수 있고, dry-run 이 아무 위험 없이 같은 사실을 학습할 수 있다.
# ⚠ 이 진단은 **재시작 전** 스냅샷이다. 재시작 직후 lifespan 의 init_db() 가
#   create_all() + 누락 컬럼 ALTER 로 스키마를 또 바꾸므로, 여기서 출력한 상태와
#   최종 상태는 다를 수 있다. 그 사실을 출력에 명시한다.
# ⚠ 실패는 전부 '판정 불가' 다. 파이썬을 못 찾거나 DB 에 접속 못 한다고 배포를 막으면
#   그 자체가 새 회귀다 — 모든 단계가 조건부·비치명적이다.
db_probe() {
  say "DB 진단(읽기전용) — 아래는 **재시작 전** 시점의 상태입니다"

  # 이번 패키지가 migrations/ 를 건드리는지는 파이썬 없이도 답할 수 있다 → 먼저 한다.
  mig_compare
  case "$MIG_VERDICT" in
    same)    ok "이번 갱신은 migrations/ 를 바꾸지 않습니다 — 스키마 작업 없음 (근거: 설치 트리와 패키지의 migrations/ 지문 동일)" ;;
    changed) warn "이번 갱신은 migrations/ 를 바꿉니다 — 스키마 작업이 필요할 수 있습니다 (근거: 지문 불일치)" ;;
    *)       say  "  migrations/ 변경 여부: 판정 불가(해시 도구 없음)" ;;
  esac

  if [ -z "${PYBIN:-}" ] || [ ! -x "${PYBIN:-}" ]; then
    DB_VERDICT="undetermined"; DB_NOTE="백엔드 파이썬을 특정하지 못했습니다(--pybin 으로 지정)"
    warn "DB 진단 불가: $DB_NOTE"
    return 0
  fi
  if [ ! -f "$BACKEND_DIR/alembic.ini" ]; then
    DB_VERDICT="undetermined"; DB_NOTE="alembic.ini 가 없습니다: $BACKEND_DIR/alembic.ini"
    warn "DB 진단 불가: $DB_NOTE"
    return 0
  fi

  # (1) DB URL — .env 를 손으로 파싱하지 않는다.
  #   (a) python-dotenv 의 load_dotenv() 는 기본 override=False 라 **실제 프로세스
  #       환경변수가 .env 를 이긴다**(systemd Environment= / docker -e). 손파싱은 오답이다.
  #   (b) load_dotenv() 는 CWD 기준이라 cwd 가 틀리면 조용히 sqlite:///./dev.db 로 떨어진다.
  #   → migrations/env.py 가 쓰는 것과 **같은 단일 소스**(app.config.get_settings)를 부른다.
  DBU="$( cd "$BACKEND_DIR" 2>/dev/null && to_run 20 "$PYBIN" -c \
          'from app.config import get_settings; print(get_settings().database_url)' 2>/dev/null )" || DBU=""
  if [ -n "$DBU" ]; then
    DB_URL_SHOWN="$(mask_url "$DBU")"
    case "$DBU" in
      postgres*)  DB_KIND="PostgreSQL" ;;
      sqlite*)    DB_KIND="SQLite" ;;
      *)          DB_KIND="기타" ;;
    esac
    say "  DB: $DB_KIND  $DB_URL_SHOWN   (비밀번호는 마스킹했습니다)"
  else
    DB_KIND="?"
    warn "DB URL 을 읽지 못했습니다(app.config 임포트 실패) — 이후 판정은 '불가' 입니다"
  fi

  # ── head·미적용 목록은 **패키지 트리**에서 읽는다 ──────────────────────────
  # ⚠ 여기가 이 진단의 급소다. db_probe 는 [2](detect_paths 끝)에서 돌고 파일 교체는
  #   [4](do_copy)다. alembic.ini 의 `script_location = %(here)s/migrations` 는 **ini 가
  #   있는 디렉터리** 기준이므로, `-c "$BACKEND_DIR/alembic.ini"` 로 heads 를 읽으면
  #   아직 교체되지 않은 **설치 트리(=구 패키지)** 의 head 가 나온다. 그 값을 '패키지
  #   head' 라 부르면, 리비전을 하나 추가한 가장 흔한 릴리스에서 DB스탬프 == 구 head
  #   가 되어 verdict 가 latest 로 떨어지고, --migrate 가 정확히 필요한 그 상황에서만
  #   no-op + exit 0 이 나간다(신 코드 + 구 스키마로 서비스가 재기동된다).
  #   → heads·history 는 env.py 를 돌리지 않는 **파일 전용** 명령이라 패키지 트리에서
  #     실행해도 DB 접속도 app 임포트도 필요 없다. 그래서 이 둘만 패키지로 돌린다.
  #   → 반대로 `current`(아래 (3))는 env.py 가 **cwd 기준 .env** 를 읽어야 하므로
  #     반드시 설치 트리에서 돈다. -c 까지 패키지로 돌리면 app.config 가 .env 를 못 찾아
  #     sqlite:///./dev.db 로 조용히 떨어져 남의 DB 를 진단하게 된다.
  ALEM_DIR="$BACKEND_DIR"; DB_HEAD_SRC="설치 트리"
  if [ -n "${PKG:-}" ] && [ -f "$PKG/backend/alembic.ini" ] && [ -d "$PKG/backend/migrations/versions" ]; then
    ALEM_DIR="$PKG/backend"; DB_HEAD_SRC="패키지"
  fi

  # (2) head — **DB 를 건드리지 않고** 파일에서만 얻는다.
  HOUT="$( cd "$ALEM_DIR" && to_run 30 "$PYBIN" -m alembic -c "$ALEM_DIR/alembic.ini" heads 2>/dev/null )" || HOUT=""
  DB_HEAD="$(printf '%s\n' "$HOUT" | sed -n 's/^\([0-9a-f]\{6,\}\).*/\1/p' | head -1)"
  HEAD_N="$(printf '%s\n' "$HOUT" | sed -n 's/^\([0-9a-f]\{6,\}\).*/\1/p' | grep -c . || true)"
  if [ -z "$DB_HEAD" ]; then
    # ⚠ 파싱 실패를 '최신' 으로 읽으면 안 된다. alembic 버전업으로 문구가 바뀌어도
    #   조용히 오판하지 않도록, 해석 못 한 것은 전부 '판정 불가' 다.
    DB_VERDICT="undetermined"
    DB_NOTE="alembic heads 출력을 해석하지 못했습니다(alembic 미설치 또는 출력 형식 변경)"
    warn "DB 진단 불가: $DB_NOTE"
    return 0
  fi
  if [ "${HEAD_N:-1}" -gt 1 ]; then
    DB_VERDICT="multihead"; DB_NOTE="head 가 ${HEAD_N}개입니다(머지 필요)"
    warn "$DB_HEAD_SRC 트리의 마이그레이션 head 가 ${HEAD_N}개입니다 — 사람이 머지해야 합니다(--migrate 는 거부합니다)"
    return 0
  fi
  say "  head 리비전: $DB_HEAD   (출처: $DB_HEAD_SRC 트리의 migrations/)"

  # ── 교차검사 ────────────────────────────────────────────────────────────────
  # 'DB 스탬프 == head → 미적용 없음' 이 참이려면 그 head 가 **패키지의** head 여야
  # 한다. 패키지 트리를 읽지 못해 설치 트리로 떨어졌는데(=구 head) 이번 패키지가
  # migrations/ 를 바꾼다면, 두 사실은 정면으로 모순이다. 예전 구현은 이 조합에서
  # '⚠ migrations/ 를 바꿉니다' 와 '✅ 미적용 없음' 을 한 화면에 함께 찍고도 아무도
  # 대조하지 않아 조용한 no-op + exit 0 을 만들었다. 모르면 '모름' 으로 무너진다.
  if [ "$DB_HEAD_SRC" != "패키지" ] && [ "$MIG_VERDICT" = "changed" ]; then
    DB_VERDICT="undetermined"
    DB_NOTE="패키지의 alembic 트리를 읽지 못해 head 를 설치 트리에서 얻었는데, 이번 패키지는 migrations/ 를 바꿉니다"
    warn "DB 진단 불가(교차검사 모순): $DB_NOTE"
    say  "    → 구 head 와 DB 스탬프가 같다는 사실을 '미적용 없음' 으로 읽으면 패키지가 새로"
    say  "      추가한 리비전이 통째로 빠집니다. 그래서 '최신' 이 아니라 '판정 불가' 입니다."
    say  "    확인: $PKG/backend/alembic.ini 와 $PKG/backend/migrations/versions 가 있는지 보세요."
    return 0
  fi

  # (3) DB 스탬프 — 여기서만 실제 접속이 일어난다.
  #   백엔드가 컨테이너 안이고 DB 호스트명이 도커 네트워크 이름(db:5432)이면 호스트에서
  #   실행하는 이 스크립트는 접속 자체를 못 한다. 그때 '미적용 없음' 으로 오판하는 것이
  #   최악이므로 반드시 '판정 불가' 로 명시한다.
  COUT="$(mktemp 2>/dev/null || true)"; CERR="$(mktemp 2>/dev/null || true)"
  if [ -z "$COUT" ] || [ -z "$CERR" ]; then
    rm -f "$COUT" "$CERR" 2>/dev/null || true
    DB_VERDICT="undetermined"; DB_NOTE="임시파일을 만들지 못했습니다"
    warn "DB 스탬프 판정 불가: $DB_NOTE"
    return 0
  fi
  CRC=0
  ( cd "$BACKEND_DIR" && to_run 30 "$PYBIN" -m alembic -c "$BACKEND_DIR/alembic.ini" current ) \
      >"$COUT" 2>"$CERR" || CRC=$?
  if [ "$CRC" != "0" ]; then
    DB_VERDICT="undetermined"
    DB_NOTE="alembic current 실패(exit $CRC) — DB 에 접속하지 못했을 가능성이 큽니다"
    warn "DB 스탬프 판정 불가: $DB_NOTE"
    say  "    (백엔드가 컨테이너 안이고 DB 호스트명이 도커 네트워크 이름이면 호스트에서는 접속할 수 없습니다)"
    # stderr 에도 접속 URL 이 섞여 나올 수 있다 → 자격증명을 지운 뒤 마지막 3줄만.
    # ⚠ 문자클래스에서 '@' 를 빼면(`[^/@ ]*`) 첫 '@' 에서 멈춰, 비밀번호에 '@' 가 섞였을 때
    #   뒷부분이 그대로 로그에 남는다(sv:p@ss@host → ***@ss@host). '@' 를 허용하고 '/' 만
    #   막으면 BRE 의 최장 일치가 authority 안 **마지막 '@'** 까지 먹는다 — path 의 '@' 는
    #   앞에 '/' 가 있어 애초에 이 클래스가 넘어가지 못하므로 host:port 도 안전하다.
    #   (URL 이 잘못 적혀 접속에 실패한 상황이 바로 이 분기라 노출 빈도가 가장 높다)
    sed -e 's#://[^/ ]*@#://***@#g' "$CERR" 2>/dev/null | tail -3 \
      | while IFS= read -r l; do say "    | $l"; done
    rm -f "$COUT" "$CERR"
    return 0
  fi
  DB_CURRENT="$(sed -n 's/^\([0-9a-f]\{6,\}\).*/\1/p' "$COUT" | head -1)"
  CBYTES="$(tr -d ' \t\n\r' < "$COUT" 2>/dev/null | wc -c | tr -d ' ')"
  rm -f "$COUT" "$CERR"

  if [ -z "$DB_CURRENT" ]; then
    if [ "${CBYTES:-0}" -eq 0 ]; then
      # (c) alembic_version 테이블 자체가 없다 — 단정해서 알린다.
      DB_VERDICT="unstamped"
      warn "이 DB 에는 alembic_version 이 없습니다 — alembic 이 소유하지 않는 스키마입니다"
      say  "    근거: app/main.py 의 lifespan 이 **매 기동마다** init_db() 를 호출하고,"
      say  "          app/db.py 의 init_db() 가 create_all() + 누락 컬럼 ALTER 로 스키마를 만듭니다."
      say  "    → 이 DB 에 'alembic upgrade head' 를 돌리면 체인의 뿌리(initial_schema)부터"
      say  "      재생돼 **이미 있는 테이블 위에서 터집니다**. --migrate 를 줘도 거부합니다."
    else
      DB_VERDICT="undetermined"; DB_NOTE="alembic current 출력을 해석하지 못했습니다"
      warn "DB 스탬프 판정 불가: $DB_NOTE"
    fi
    return 0
  fi
  say "  DB 스탬프 리비전: $DB_CURRENT"

  if [ "$DB_CURRENT" = "$DB_HEAD" ]; then
    DB_VERDICT="latest"
    ok "DB 리비전이 $DB_HEAD_SRC head 와 같습니다 — 미적용 마이그레이션 없음"
    if [ "$MIG_VERDICT" = "changed" ]; then
      # 한 화면에 '바뀝니다' 와 '미적용 없음' 이 함께 나오는 조합을 그냥 두지 않는다.
      # head 를 패키지에서 읽었으므로 이것은 모순이 아니라 **리비전 추가가 없는
      # 내용 변경**(기존 리비전 파일 수정 등)이다 — 그 사실을 명시한다.
      say "    ※ migrations/ 지문은 바뀌었지만 head 는 그대로입니다 = 새 리비전이 추가되지"
      say "       않은 내용 변경입니다(head 는 $DB_HEAD_SRC 트리에서 읽었습니다)."
    fi
    return 0
  fi

  # current 가 head 의 조상인가 = head 로 가는 경로가 있는가. (DB 를 건드리지 않는다)
  # ※ heads 와 **같은 트리**에서 읽어야 한다. 다른 트리에서 읽으면 예고한 목록과
  #   실제 적용분이 어긋난다(동의 범위 밖의 마이그레이션이 들어간다).
  RANGE="$( cd "$ALEM_DIR" && to_run 30 "$PYBIN" -m alembic -c "$ALEM_DIR/alembic.ini" \
            history -r "$DB_CURRENT:head" 2>/dev/null )" || RANGE=""
  if [ -z "$RANGE" ]; then
    # (d) DB 의 리비전이 패키지 migrations/ 에 없다 — 롤백 잔재이거나 다른 계보다.
    DB_VERDICT="unknown-rev"; DB_NOTE="DB 리비전 $DB_CURRENT 이 $DB_HEAD_SRC 트리의 migrations/ 에 없습니다"
    warn "DB 리비전 $DB_CURRENT 이 $DB_HEAD_SRC 트리의 migrations/ 에 없습니다"
    say  "    (DB 가 패키지보다 신버전이거나 — 롤백 잔재 — 계보가 다른 패키지입니다)"
    return 0
  fi
  DB_PENDING="$(printf '%s\n' "$RANGE" | sed -n 's/.*-> \([0-9a-f][0-9a-f]*\).*/\1/p' \
                | grep -v "^$DB_CURRENT\$" || true)"
  DB_PENDING_N="$(printf '%s' "$DB_PENDING" | grep -c . || true)"
  if [ "${DB_PENDING_N:-0}" -lt 1 ]; then
    DB_VERDICT="undetermined"; DB_NOTE="미적용 리비전 목록을 해석하지 못했습니다"
    warn "DB 스탬프 판정 불가: $DB_NOTE"
    return 0
  fi
  DB_VERDICT="behind"
  warn "미적용 마이그레이션 ${DB_PENDING_N}건 (DB=$DB_CURRENT → $DB_HEAD_SRC head=$DB_HEAD)"
  printf '%s\n' "$DB_PENDING" | while IFS= read -r r; do say "    · $r"; done
  if [ "$MIG_VERDICT" = "same" ]; then
    say "    ※ 다만 이번 패키지는 migrations/ 를 바꾸지 않습니다 — 이 미적용분은 이번 갱신 때문이 아닙니다."
  fi
  return 0
}

detect_paths() {
  step "설치 경로 발견"

  BPID=""; BACKEND_DIR=""; FRONT_DIR=""; PYBIN=""; RUN_USER=""; CWD=""
  RC=0; find_backend_pid || RC=$?
  if [ -n "$BPID" ]; then
    say "포트 $PORT 점유 PID: $BPID"
    if [ -r "/proc/$BPID/cmdline" ]; then
      say "cmdline: $(tr '\0' ' ' < "/proc/$BPID/cmdline")"
    fi
    # 저장소 계약상 uvicorn 은 반드시 <설치루트>/backend 에서 뜬다
    # (config.py 의 load_dotenv() 가 CWD 기준으로 .env 를 읽기 때문. cwd 가 틀리면
    #  SAINTVIEW_DATABASE_URL 을 못 읽고 sqlite:///./dev.db 로 조용히 떨어진다.)
    CWD="$(readlink -f "/proc/$BPID/cwd" 2>/dev/null || true)"
    if [ -n "$CWD" ] && [ -f "$CWD/app/main.py" ]; then
      BACKEND_DIR="$CWD"
      ok "백엔드 디렉터리: $BACKEND_DIR  (프로세스 cwd)"
    elif [ -n "$CWD" ]; then
      warn "PID $BPID 의 cwd 가 백엔드처럼 보이지 않습니다: $CWD"
    else
      warn "/proc/$BPID/cwd 를 읽지 못했습니다(root 권한 필요)"
    fi
    RUN_USER="$(stat -c %U "/proc/$BPID" 2>/dev/null || true)"
    # ※ 아래를 `[ -n "$X" ] && say ...` 로 쓰면 조건이 거짓일 때 목록 전체가 1 을 반환해
    #    set -e 가 셸을 그 자리에서 죽인다(dash 에서 실제로 확인). 반드시 if 로 쓴다.
    if [ -n "$RUN_USER" ]; then say "실행 사용자: $RUN_USER"; fi
    # 컨테이너/서비스 소속을 원문 그대로 남긴다(파싱은 [7] 에서).
    if [ -r "/proc/$BPID/cgroup" ]; then
      say "cgroup: $(head -1 "/proc/$BPID/cgroup")"
    fi
  else
    warn "포트 $PORT 점유 프로세스를 찾지 못했습니다(도구 부재·비root·컨테이너 NAT 가능)"
    if command -v docker >/dev/null 2>&1; then
      say "docker 확인: $(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep "$PORT" || echo '해당 없음')"
    fi
  fi

  # --prefix 가 있으면 그것이 최우선(사람이 명시한 값을 추론이 덮지 않는다)
  if [ -n "$PREFIX" ]; then
    PREFIX="$(cd "$PREFIX" 2>/dev/null && pwd || printf '%s\n' "$PREFIX")"
    [ -d "$PREFIX" ] || die "--prefix 경로가 없습니다: $PREFIX"
    BACKEND_DIR="$PREFIX/backend"
    FRONT_DIR="$PREFIX/frontend/dist"
    ok "사용자 지정 설치 루트: $PREFIX"
  elif [ -n "$BACKEND_DIR" ]; then
    PREFIX="$(dirname "$BACKEND_DIR")"
    if [ -d "$PREFIX/frontend/dist" ]; then FRONT_DIR="$PREFIX/frontend/dist"; fi
  fi

  # 프론트 root 를 nginx 설정에서도 뽑아 대조한다.
  # ※ nginx -T 는 include 를 평탄화해 준다. 다만 server_name 우선순위·location 의
  #   root/alias 재정의까지 정확히 해석하려면 상태기계가 필요하다 — 여기서는
  #   후보만 모으고 **실제 파일 존재 여부로 확정**한다(파일이 이긴다).
  NGX_ROOTS=""
  if [ -n "${NGINX:-}" ] && [ "$(id -u)" = "0" ]; then
    NGX_ROOTS="$("$NGINX" -T 2>/dev/null \
      | sed 's/#.*//' \
      | sed -n 's/^[[:space:]]*root[[:space:]]\{1,\}\([^;]*\);.*/\1/p' \
      | sed 's/[[:space:]]*$//' | sort -u)"
  fi
  # ⚠ 이 루프에는 break 가 없다 → 조건을 만족하는 **사전순 마지막** root 가 남는다.
  #   조건(`index.html` 에 `assets/index-` 포함)은 Vite 로 빌드한 아무 SPA 나 통과하므로,
  #   같은 nginx 가 다른 SPA 도 서빙하면 그 사이트가 이길 수 있다
  #   (기본 템플릿의 `/opt/saintview-viewer/...` 는 `/srv`·`/var/www` 에 항상 진다).
  #   → 마지막을 임의로 고르지 않는다. 후보를 세어 2개 이상이면 사람에게 넘긴다.
  NGX_PICK=""; NGX_N=0; NGX_CANDS=""
  for r in $NGX_ROOTS; do
    case "$r" in *'$'*) warn "nginx root 에 변수가 있어 정적 해석 불가: $r"; continue ;; esac
    if [ -f "$r/index.html" ] && grep -q 'assets/index-' "$r/index.html" 2>/dev/null; then
      NGX_PICK="$r"; NGX_N=$((NGX_N + 1)); NGX_CANDS="$NGX_CANDS $r"
    fi
  done
  if [ "$NGX_N" -gt 1 ]; then
    warn "nginx 가 서빙하는 SPA docroot 후보가 여러 개입니다:$NGX_CANDS"
    if [ -n "$PREFIX_SET" ]; then
      warn "  → --prefix 가 명시돼 있으므로 nginx 추론은 쓰지 않습니다"
      NGX_PICK=""
    else
      die "어느 것이 우리 사이트인지 확정할 수 없습니다 — --prefix <설치루트> 로 명시하세요 (후보:$NGX_CANDS)"
    fi
  fi
  if [ -n "$NGX_PICK" ]; then say "nginx root 후보: $NGX_PICK"; fi

  if [ -z "$FRONT_DIR" ] && [ -n "$NGX_PICK" ]; then
    FRONT_DIR="$NGX_PICK"
  elif [ -n "$FRONT_DIR" ] && [ -n "$NGX_PICK" ] && [ "$FRONT_DIR" != "$NGX_PICK" ]; then
    # 백엔드와 프론트가 서로 다른 디렉터리에서 서빙되고 있다는 뜻이다.
    # 잘못된 쪽에 덮어쓰면 아무 일도 일어나지 않거나(무반영) 엉뚱한 사이트를 깨뜨린다.
    if [ "$(realdir "$FRONT_DIR")" = "$(realdir "$NGX_PICK")" ]; then
      # 심볼릭 링크라 문자열만 다를 뿐 같은 실물 디렉터리다 — 불일치가 아니다.
      say "nginx root 와 표기만 다르고 같은 실물 디렉터리입니다: $NGX_PICK ≡ $FRONT_DIR"
    elif [ -n "$PREFIX_SET" ]; then
      # 위 455 줄 규약: **사람이 명시한 값을 추론이 덮지 않는다**.
      # 덮으면 --prefix 를 정확히 줘도 dist 가 남의 사이트 docroot 로 들어가고(그 사이트
      # index.html 이 우리 것으로 교체돼 즉시 죽는다), 백엔드만 --prefix 대로 갱신되는
      # 부분 적용이 되며, 백업도 남의 docroot 스냅샷이라 롤백이 우리 프론트를 못 되돌린다.
      warn "프론트 경로 불일치:  --prefix기준=$FRONT_DIR  nginx기준=$NGX_PICK"
      warn "  → --prefix 를 명시했으므로 명시값을 씁니다(추론이 덮지 않습니다): $FRONT_DIR"
      say  "  nginx 가 정말 다른 곳을 서빙 중이라면 nginx 설정을 고치거나 --prefix 를 그쪽으로 주세요."
    else
      warn "프론트 경로 불일치:  cwd기준=$FRONT_DIR  nginx기준=$NGX_PICK"
      die "어디에 배포할지 확정할 수 없습니다 — --prefix <설치루트> 로 명시하세요 (잘못 고르면 남의 사이트를 덮어씁니다)"
    fi
  fi

  [ -n "$BACKEND_DIR" ] || die "백엔드 경로를 찾지 못했습니다.  --prefix <설치루트> 로 지정하세요"
  [ -n "$FRONT_DIR" ]   || die "프론트 dist 경로를 찾지 못했습니다.  --prefix <설치루트> 로 지정하세요"
  if unsafe_target "$FRONT_DIR";   then die "프론트 경로가 시스템 최상위입니다 — 중단합니다: $FRONT_DIR"; fi
  if unsafe_target "$BACKEND_DIR"; then die "백엔드 경로가 시스템 최상위입니다 — 중단합니다: $BACKEND_DIR"; fi
  [ -f "$BACKEND_DIR/app/main.py" ] || die "백엔드 경로가 이상합니다(app/main.py 없음): $BACKEND_DIR"
  [ -f "$FRONT_DIR/index.html" ]    || die "프론트 경로가 이상합니다(index.html 없음): $FRONT_DIR"

  ok "백엔드: $BACKEND_DIR"
  ok "프론트: $FRONT_DIR"

  # 인터프리터는 **파일을 건드리기 전인 지금** 확정한다. 교차검증이 어긋나면 여기서
  # 멈춰야 안전하다([3] 백업 이후에 죽으면 반쯤 적용된 상태가 남는다).
  resolve_pybin

  # 런타임(systemd 유닛 / 도커 컨테이너)도 여기서 확정한다. 읽기만 하므로 dry-run 도
  # 같은 사실을 볼 수 있고, [7]·[8] 이 같은 근거로 말하게 된다.
  detect_runtime

  # DB 진단은 **항상·무료·읽기전용**이다(옵션이 없다). 파일을 건드리기 전에 현장의
  # 체제를 알아야 --migrate 의 허용/거부를 사실로 판단할 수 있다.
  db_probe

  # 소유권 기준선도 지금 잡는다([4] 의 cp -a 가 root:root 로 덮어쓰기 전 값이어야 한다).
  FOWN="$(own_of "$FRONT_DIR")"
  BOWN="$(own_of "$BACKEND_DIR/app")"
  [ -n "$FOWN" ] || FOWN="${RUN_USER:+$RUN_USER:$RUN_USER}"
  [ -n "$BOWN" ] || BOWN="${RUN_USER:+$RUN_USER:$RUN_USER}"
  if [ -n "$FOWN" ] || [ -n "$BOWN" ]; then
    say "소유권 기준선: 프론트=${FOWN:-?}  백엔드app=${BOWN:-?}"
  fi
}

# ═══════════════════════════════════════════════════════════════════════════
# [3] 백업
# ═══════════════════════════════════════════════════════════════════════════
do_backup() {
  step "백업"
  BDIR="$BACKUP_ROOT/$TS"
  mkdir -p "$BDIR"

  # 지금 서버에 올라가 있는 것의 지문(= 이 백업의 내용물 지문).
  CUR_ASSET="$(asset_of "$FRONT_DIR")"
  CUR_APP="$(tree_hash "$BACKEND_DIR/app")"
  CUR_EXTRA="$(extra_hash "$BACKEND_DIR")"
  CUR_MIG="$(mig_hash "$BACKEND_DIR")"
  PKG_APP="$(tree_hash "$PKG/backend/app")"
  say "현재 지문: asset=${CUR_ASSET:-?} app=${CUR_APP} extra=${CUR_EXTRA}"
  say "패키지 지문: asset=${PKG_ASSET:-?} app=${PKG_APP}"

  cp -a "$FRONT_DIR"          "$BDIR/frontend-dist"
  cp -a "$BACKEND_DIR/app"    "$BDIR/backend-app"
  # [4] do_copy 가 덮어쓰는 것은 **전부** 백업한다. 하나라도 빠지면 롤백이 그 경로를
  # 신버전 그대로 남긴 채 '복구 완료' 를 찍는다(이 스크립트의 실제 사고 사례).
  for p in $BK_FILES; do
    if [ -f "$BACKEND_DIR/$p" ]; then cp -a "$BACKEND_DIR/$p" "$BDIR/$p"; fi
  done
  for d in $BK_DIRS; do
    if [ -d "$BACKEND_DIR/$d" ]; then cp -a "$BACKEND_DIR/$d" "$BDIR/$d"; fi
  done

  # 롤백 대상을 기계가 읽을 수 있게 기록해 둔다(사람이 경로를 기억할 필요가 없게).
  # FP_* 가 핵심이다: 롤백이 '되돌릴 것이 있는지' 를 판단하는 유일한 근거다.
  # ABSENT_* 도 마찬가지로 필수다: '백업 당시 그 경로가 없었다' 는 사실을 남겨야
  # 롤백이 '백업에 없음 = 백업이 부실함' 과 '백업에 없음 = 원래 없었음' 을 구분해
  # 후자에서만 신버전 산출물을 옆으로 치울 수 있다.
  # BK_FORMAT 은 백업 포맷 세대다. 1(=이 필드가 없음)은 부수 트리를 담지 않은 옛 백업이라
  # 롤백이 app/ 만 되돌릴 수 있다는 사실을 사람에게 알려야 한다.
  {
    outln "BK_FORMAT='2'"
    outln "TS='$TS'"
    outln "FRONT_DIR='$FRONT_DIR'"
    outln "BACKEND_DIR='$BACKEND_DIR'"
    outln "PORT='$PORT'"
    outln "PKG='${PKG:-}'"
    outln "FP_ASSET='${CUR_ASSET}'"
    outln "FP_APP='${CUR_APP}'"
    outln "FP_EXTRA='${CUR_EXTRA}'"
    # migrations/ 만의 지문. FP_EXTRA 는 tools/·requirements.txt 변경까지 섞여 있어
    # '이번 적용이 스키마 파일을 건드렸는가' 라는 질문에 답할 수 없다 → 따로 남긴다.
    # (mval 은 `^FP_MIG=` 로 앵커되므로 아래 FP_MIG_AFTER 와 섞이지 않는다.)
    outln "FP_MIG='${CUR_MIG}'"
    outln "FOWN='${FOWN:-}'"
    outln "BOWN='${BOWN:-}'"
    for p in $BK_FILES; do
      if [ ! -f "$BACKEND_DIR/$p" ]; then outln "ABSENT_$(mkey "$p")='1'"; fi
    done
    for d in $BK_DIRS; do
      if [ ! -d "$BACKEND_DIR/$d" ]; then outln "ABSENT_$(mkey "$d")='1'"; fi
    done
  } > "$BDIR/manifest.env"

  # ⚠ 이미 패키지와 같은 버전이 올라가 있으면 이 백업은 '신버전 스냅샷' 이다.
  #   그런 백업으로 롤백하면 신버전을 신버전으로 덮으면서 '복구 완료' 를 찍는
  #   거짓 성공이 된다.
  #   예전에는 이것을 $BACKUP_ROOT/LATEST 파일로 막는다고 적어 뒀지만, do_rollback 은
  #   LATEST 를 **한 번도 읽지 않았다**(쓰기만 하는 죽은 파일이었다). 주석과 코드가
  #   어긋난 채 '보호되고 있다' 고 믿게 만들었으므로 파일 자체를 없앤다.
  #   실제 보호는 [4] 끝에서 덧붙이는 **적용 후 지문(FP_*_AFTER)** 이 담당한다:
  #   FP_* == FP_*_AFTER 인 백업 = '아무것도 바꾸지 않은 적용(no-op)' 이고,
  #   do_rollback 이 이런 백업을 자동 선택에서 제외한다.
  SAMERC=0; fp_same "$CUR_ASSET" "$CUR_APP" "$PKG_ASSET" "$PKG_APP" || SAMERC=$?
  if [ "$SAMERC" = "0" ]; then
    warn "이미 패키지와 같은 버전이 배포돼 있습니다 — 이 백업은 롤백 자동 선택에서 제외됩니다"
    say "  (되돌릴 수 있는 것은 '패키지 이전' 상태를 담은 더 오래된 백업입니다)"
  fi
  rm -f "$BACKUP_ROOT/LATEST" 2>/dev/null || true
  # 의존성 롤백 기준선(pycdlib 하나만 넣었다면 되돌리기는 pip uninstall 한 줄이다)
  if [ -n "${PYBIN:-}" ] && [ -x "$PYBIN" ]; then
    "$PYBIN" -m pip freeze > "$BDIR/pip-freeze.txt" 2>/dev/null || true
  fi
  prune_backups
  ok "백업 위치: $BDIR"
  say "되돌리기:  sudo sh $(basename "$0") --rollback $TS"
}

# 오래된 백업 정리 — 갱신 1회당 프론트 dist 전체를 복사하므로 백업 하나가 10MB 를 넘는다.
# 상한이 없으면 배포를 거듭할수록 /var 가 조용히 찬다(실측: 3회 적용에 34MB).
# 되돌리기는 사실상 직전 몇 세대만 쓰므로 최근 N개만 남긴다(SV_KEEP_BACKUPS, 기본 5).
# ⚠ 방금 만든 백업($TS)은 어떤 경우에도 지우지 않는다 — 그러면 이번 적용이 되돌릴 수 없어진다.
prune_backups() {
  KEEP="${SV_KEEP_BACKUPS:-5}"
  case "$KEEP" in
    ''|*[!0-9]*) return 0 ;;    # 숫자가 아니면 정리하지 않는다(사고 방지)
  esac
  [ "$KEEP" -ge 1 ] || return 0
  N=0
  # 이름이 14자리 타임스탬프라 역순 정렬 = 최신순. manifest.env 가 있는 것만 우리 백업으로 본다.
  for d in $(ls -1 "$BACKUP_ROOT" 2>/dev/null | sort -r); do
    B="$BACKUP_ROOT/$d"
    if [ ! -f "$B/manifest.env" ]; then continue; fi
    N=$((N + 1))
    if [ "$N" -le "$KEEP" ]; then continue; fi
    if [ "$d" = "$TS" ]; then continue; fi
    rm -rf "$B" && say "· 오래된 백업 정리: $d" || warn "백업 정리 실패(무시): $d"
  done
}

# ═══════════════════════════════════════════════════════════════════════════
# [4] 파일 교체 — 덮어쓰기 전용(additive). 어디에도 rm -rf / --delete 를 쓰지 않는다.
# ═══════════════════════════════════════════════════════════════════════════
do_copy() {
  step "파일 교체"

  # ── 프론트 ───────────────────────────────────────────────────────────────
  # 순서가 중요하다: assets → 루트 아이콘 → **index.html 마지막**.
  # index.html 은 no-cache 라 즉시 보이는데, 그 시점에 청크가 디스크에 없으면
  # 새로 접속한 사용자가 흰 화면을 본다.
  #
  # 구 자산을 지우지 않는 이유: 번들의 vite preload 헬퍼가 'vite:preloadError' 를
  # dispatch 한 뒤 그대로 rethrow 하는데, 앱 어디에도 그 리스너가 없다. 열려 있는
  # 탭이 삭제된 지연로드 청크를 요청하면 판독 중 화면이 그대로 죽는다.
  # 파일명이 콘텐츠 해시라 신·구가 충돌하지 않으므로 비용은 디스크뿐이다.
  say "프론트: assets → 루트파일 → index.html 순서로 덮어씁니다(구 자산은 남깁니다)"
  mkdir -p "$FRONT_DIR/assets"
  # .gz/.br 사전압축본이 함께 복사돼야 gzip_static/brotli_static 이 동작한다.
  # 확장자 필터를 걸지 말 것 — 통째로 복사한다.
  cp -a "$PKG/frontend/dist/assets/." "$FRONT_DIR/assets/"
  ok "assets 복사 완료 ($(ls -1 "$PKG/frontend/dist/assets" | wc -l) 개)"

  for f in "$PKG/frontend/dist"/*; do
    b="$(basename "$f")"
    case "$b" in
      assets|index.html) continue ;;   # ※ [ ] && continue 는 set -e 에서 셸을 죽인다 → case 사용
    esac
    cp -a "$f" "$FRONT_DIR/"
  done
  ok "루트 자산 복사 완료"

  cp -a "$PKG/frontend/dist/index.html" "$FRONT_DIR/index.html"
  ok "index.html 교체 (참조: $PKG_ASSET)"

  # ── 백엔드 ───────────────────────────────────────────────────────────────
  # app/ 만 덮는다. .env·dev.db·certs 는 패키지에 없으므로 덮일 수 없고,
  # 삭제도 하지 않으므로 안전하다.
  # tests/ 와 harness/ 는 운영에 불필요해 일부러 복사하지 않는다(공격면 축소).
  # ⚠ 여기서 덮어쓰는 대상은 **반드시** BK_FILES/BK_DIRS 안에 있어야 한다.
  #   그래야 [3] 이 백업하고 [롤백] 이 되돌린다. 목록 밖의 경로를 여기에 직접
  #   추가하면 '롤백해도 신버전이 남는' 사고가 그대로 재현된다.
  say "백엔드: app/ · $BK_FILES · $BK_DIRS 를 덮어씁니다"
  cp -a "$PKG/backend/app/." "$BACKEND_DIR/app/"
  for p in $BK_FILES; do
    # .env.example 은 파일만 갱신한다. **절대 .env 로 복사하지 않는다** —
    # 실서버 JWT 시크릿·DB URL·WebPACS 계정이 dev 기본값으로 통째로 덮인다.
    if [ -f "$PKG/backend/$p" ]; then cp -a "$PKG/backend/$p" "$BACKEND_DIR/$p"; fi
  done
  for d in $BK_DIRS; do
    if [ -d "$PKG/backend/$d" ]; then
      mkdir -p "$BACKEND_DIR/$d"; cp -a "$PKG/backend/$d/." "$BACKEND_DIR/$d/"
    fi
  done
  ok "백엔드 코드 교체 완료 (.env / DB / 인증서 미접촉)"

  # 스테일 .pyc 는 소스보다 mtime 이 앞서면 무시되지만, 삭제된 모듈의 캐시가
  # 남아 import 가 성공해 버리는 경우가 있어 캐시만 비운다(소스는 안 지운다).
  find "$BACKEND_DIR/app" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true

  # ── 소유권 원복 ──────────────────────────────────────────────────────────
  # cp -a 가 패키지(root:root)의 소유권까지 복사해 서비스 계정 소유였던 트리가
  # root:root 로 바뀐다. 읽기는 되지만 __pycache__ 생성이 막혀 기동이 느려지고,
  # 앱이 그 경로에 파일을 만드는 기능은 EACCES 로 깨진다. 기준선으로 되돌린다.
  if [ -n "${FOWN:-}" ] || [ -n "${BOWN:-}" ]; then
    say "소유권 원복: 프론트=${FOWN:-건너뜀}  백엔드=${BOWN:-건너뜀}"
  fi
  chown_back "$FRONT_DIR" "${FOWN:-}"
  chown_back "$BACKEND_DIR/app" "${BOWN:-}"
  # app/ 밖에 새로 떨군 파일들도 같은 소유권으로 맞춘다(백엔드 트리 기준).
  for p in $BK_FILES $BK_DIRS; do
    # ※ `[ -e ] && ...` 로 쓰면 마지막 반복이 거짓일 때 루프가 1 을 반환하고
    #   set -e 가 셸을 죽인다(이 파일의 다른 주석과 같은 이유). 반드시 if 로 쓴다.
    if [ -e "$BACKEND_DIR/$p" ]; then chown_back "$BACKEND_DIR/$p" "${BOWN:-}"; fi
  done

  # ── 적용 후 지문 기록 ────────────────────────────────────────────────────
  # manifest.env 의 FP_* 는 '이 백업이 담고 있는 = 적용 **전**' 상태다.
  # 여기서 적용 **후** 상태를 FP_*_AFTER 로 덧붙인다. 이 두 값이 같으면 그 적용은
  # 아무것도 바꾸지 않았다는 뜻이고(= 백업이 신버전 스냅샷), 롤백이 그런 백업을
  # 골라 장애 원인인 신버전을 다시 배포하는 사고를 막을 수 있는 유일한 근거다.
  # (mval 은 `^FP_APP=` 로 앵커되므로 FP_APP_AFTER 와 섞이지 않는다.)
  if [ -f "$BACKUP_ROOT/$TS/manifest.env" ]; then
    {
      outln "FP_ASSET_AFTER='$(asset_of "$FRONT_DIR")'"
      outln "FP_APP_AFTER='$(tree_hash "$BACKEND_DIR/app")'"
      outln "FP_EXTRA_AFTER='$(extra_hash "$BACKEND_DIR")'"
      outln "FP_MIG_AFTER='$(mig_hash "$BACKEND_DIR")'"
    } >> "$BACKUP_ROOT/$TS/manifest.env"
  fi

  # 적용이 migrations/ 를 실제로 바꿨는지 **계산으로** 말한다(주석이 아니라).
  # [2] 의 mig_compare 는 '패키지가 다른가' 였고, 이것은 '실제로 바뀌었나' 다.
  MIG_NOW="$(mig_hash "$BACKEND_DIR")"
  case "${CUR_MIG:-}${MIG_NOW:-}" in
    *nohasher*) ;;
    *) if [ "${CUR_MIG:-}" = "$MIG_NOW" ]; then
         ok "migrations/ 는 한 바이트도 바뀌지 않았습니다 — 이번 갱신에 스키마 작업이 없습니다"
       else
         warn "migrations/ 가 바뀌었습니다 — 스키마 작업이 필요할 수 있습니다(적용 전 $CUR_MIG → 적용 후 $MIG_NOW)"
         say  "  이 스크립트는 DB 를 자동으로 바꾸지 않습니다. 필요하면 --migrate 를 명시하세요(거부 조건은 --help)."
       fi ;;
  esac
}

# ═══════════════════════════════════════════════════════════════════════════
# [5] 파이썬 의존성 — **신규 항목만** 설치한다
# ═══════════════════════════════════════════════════════════════════════════
do_pydeps() {
  step "파이썬 의존성"

  if [ -z "${PYBIN:-}" ] || [ ! -x "${PYBIN:-}" ]; then
    # 인터프리터를 못 찾으면 설치하지 않는다. 엉뚱한 파이썬에 넣으면
    # '설치했는데도 계속 501' 이 되어 진단이 더 어려워진다.
    # ※ 건너뛰었다는 사실을 [8]·최종 배너까지 끌고 간다(조용한 성공 금지).
    PYDEPS_FAIL=1
    warn "백엔드가 쓰는 파이썬을 특정하지 못했습니다 — 설치를 건너뜁니다"
    say "수동:  tr '\\0' ' ' < /proc/<백엔드PID>/cmdline   # argv[0] 이 그 파이썬이다"
    say "       <그 파이썬> -m pip install 'pycdlib>=1.14'"
    say "또는:  --pybin /경로/venv/bin/python 으로 다시 실행"
    return 0
  fi
  say "대상 인터프리터: $PYBIN"

  # requirements.txt 는 전 항목이 상한 없는 '>=' 다.
  # 여기서 `pip install -r`(특히 -U)을 돌리면 fastapi·sqlalchemy·pydantic·numpy 가
  # 한꺼번에 최신 메이저로 올라간다. 이번 갱신에 필요한 신규 패키지는 극소수이므로
  # **미설치 항목만 골라 그것만** 설치한다(블라스트 반경 최소화).
  MISSING=""; MISSING_NAMES=""
  while IFS= read -r line; do
    case "$line" in ''|'#'*|'-'*) continue ;; esac
    name="$(printf '%s' "$line" | sed 's/[[:space:]]*#.*//; s/\[.*//; s/[<>=!~;].*//; s/[[:space:]]*$//')"
    [ -n "$name" ] || continue
    if ! "$PYBIN" -m pip show "$name" >/dev/null 2>&1; then
      MISSING="$MISSING $(printf '%s' "$line" | sed 's/[[:space:]]*#.*//')"
      MISSING_NAMES="$MISSING_NAMES $name"
    fi
  done < "$BACKEND_DIR/requirements.txt"

  if [ -z "$MISSING" ]; then
    ok "신규 의존성 없음 (전부 설치돼 있음)"
    return 0
  fi
  say "신규 설치 대상:$MISSING"
  # 대상이 requirements 전량이면 인터프리터를 잘못 골랐다는 신호다(정상 서버라면
  # fastapi·uvicorn 이 이미 있다). 계속하면 엉뚱한 파이썬을 오염시킨다.
  CORE_MISS=0
  for n in $MISSING_NAMES; do
    case "$n" in fastapi|uvicorn) CORE_MISS=1 ;; esac   # 부분일치 금지(fastapi-utils 등)
  done
  if [ "$CORE_MISS" = "1" ]; then
    warn "fastapi/uvicorn 까지 '미설치' 로 나옵니다 — 이 파이썬은 백엔드가 쓰는 환경이 아닐 가능성이 큽니다"
    warn "  대상: $PYBIN (prefix=$("$PYBIN" -c 'import sys;print(sys.prefix)' 2>/dev/null || echo '?'))"
    PYDEPS_FAIL=1
    say "설치를 건너뜁니다.  --pybin <백엔드 venv 의 python> 으로 다시 실행하세요"
    return 0
  fi

  # -U / --upgrade 를 절대 붙이지 않는다(위 주석의 이유).
  RC=0
  POUT="$(mktemp)"
  # shellcheck disable=SC2086
  "$PYBIN" -m pip install --no-input $MISSING > "$POUT" 2>&1 || RC=$?
  cat "$POUT"

  if [ "$RC" != "0" ]; then
    PYDEPS_FAIL=1
    warn "pip 설치 실패(exit $RC)"
    # PEP 668(Debian 12 / Ubuntu 24.04+): 시스템 파이썬은 pip 설치를 거부한다.
    # --break-system-packages 를 **자동으로 붙이지 않는다** — OS 패키지 관리자와
    # 충돌해 서버 전체를 망가뜨릴 수 있는 결정은 사람이 해야 한다.
    if grep -q 'externally-managed-environment' "$POUT" 2>/dev/null; then
      echo
      warn "PEP 668 로 보호된 시스템 파이썬입니다(externally-managed-environment)"
      say "  이 서버의 백엔드는 venv 없이 시스템 파이썬으로 도는 것으로 보입니다."
      say "  택일하세요(자동으로 고르지 않습니다):"
      say "   1) 권장 — venv 를 만들어 백엔드를 그 venv 로 기동"
      say "        python3 -m venv $BACKEND_DIR/venv"
      say "        $BACKEND_DIR/venv/bin/pip install -r $BACKEND_DIR/requirements.txt"
      say "        (기동 명령의 python 을 $BACKEND_DIR/venv/bin/python 으로 교체)"
      say "   2) OS 패키지로 설치      apt-get install python3-pycdlib   (있는 배포판에 한함)"
      say "   3) 위험을 감수하고 강제  $PYBIN -m pip install --break-system-packages$MISSING"
      echo
    fi
    say "수동:  $PYBIN -m pip install$MISSING"
    rm -f "$POUT"
    return 0
  fi
  rm -f "$POUT"

  # 'pip 이 exit 0' 과 '실제로 임포트된다' 는 다른 명제다. 반드시 되물어 확인한다.
  STILL=""
  for n in $MISSING_NAMES; do
    if ! "$PYBIN" -m pip show "$n" >/dev/null 2>&1; then STILL="$STILL $n"; fi
  done
  if [ -n "$STILL" ]; then
    PYDEPS_FAIL=1
    warn "pip 은 성공했다는데 여전히 없습니다:$STILL"
    say "  (다른 환경에 설치됐을 수 있습니다 — $PYBIN 을 확인하세요)"
  else
    ok "설치 완료 (설치 후 재확인 통과)"
  fi
}

# ═══════════════════════════════════════════════════════════════════════════
# DB 마이그레이션 — --migrate 를 줬을 때만. **번호 없는 블록**이다.
#   단계 번호를 붙이지 않는 이유: [7]/[8] 이라는 표기가 이 파일 곳곳(재시작 안내문,
#   롤백 안내, 헤더 주석)에 하드코딩돼 있어, 조건부 단계를 끼워 넣으면 그 참조들이
#   플래그 유무에 따라 어긋난다. 단계는 언제나 8개다.
#   실행 순서는 [4]교체 → [5]의존성 → **여기** → [7]재시작 이다.
#   ⚠ 그래서 '구 코드가 신 스키마를 보는 창(window)' 이 원리적으로 존재한다: 파일은
#     이미 교체됐지만 백엔드 프로세스는 [7] 까지 구 코드를 메모리에 들고 있다.
#     지금까지의 리비전이 가산 위주라 그 창이 안전할 뿐이며, 파괴적 리비전(DROP/RENAME)
#     이 생기는 순간 이 순서로는 부족하다 — --migrate 가 절대 기본값이 되면 안 되는
#     두 번째 이유다(첫 번째는 미스탬프 DB 를 고장낸다는 것).
# ═══════════════════════════════════════════════════════════════════════════
do_migrate() {
  echo
  outln "── DB 마이그레이션 (--migrate) ────────────────────────────────────────"

  # 거부를 기능으로 만든다. 아래 어느 갈래든 '아무것도 하지 않음' 이 정답이다.
  case "$DB_VERDICT" in
    behind) ;;   # 유일하게 실행할 수 있는 갈래
    latest)
      ok "미적용 리비전이 없습니다 — 할 일이 없습니다(no-op)"
      say "  (근거: DB 스탬프 $DB_CURRENT = $DB_HEAD_SRC head $DB_HEAD)"
      return 0 ;;
    unstamped)
      MIGRATE_INCOMPLETE=1
      warn "거부: 이 DB 에는 alembic_version 이 없습니다(alembic 이 소유하지 않는 스키마)"
      say  "  지금 upgrade head 를 돌리면 체인의 뿌리부터 재생돼 이미 있는 테이블에서 터집니다."
      say  "  = 도움이 아니라 **정상 서버를 고장내는 동작**이므로, 플래그를 줘도 하지 않습니다."
      say  "  소유권을 alembic 에 넘기려면 **사람이** 스키마를 대조한 뒤 직접 찍으세요:"
      say  "     cd $BACKEND_DIR && ${PYBIN:-<백엔드 파이썬>} -m alembic stamp <대조로 확인한 리비전>"
      say  "  스크립트는 stamp 를 대신 찍지 않습니다 — 그것은 배포 도구가 아니라 사람의 판단입니다."
      return 0 ;;
    multihead)
      MIGRATE_INCOMPLETE=1
      warn "거부: head 가 여러 개입니다(${DB_NOTE:-}) — 사람이 alembic merge 로 정리해야 합니다"
      return 0 ;;
    unknown-rev)
      MIGRATE_INCOMPLETE=1
      warn "거부: DB 리비전 $DB_CURRENT 이 $DB_HEAD_SRC 트리의 migrations/ 에 없습니다"
      say  "  DB 가 패키지보다 신버전(롤백 잔재)이거나 계보가 다릅니다. 자동으로 추측하지 않습니다."
      return 0 ;;
    *)
      MIGRATE_INCOMPLETE=1
      warn "거부: DB 상태를 판정하지 못했습니다(${DB_NOTE:-사유 불명})"
      say  "  '판정 불가' 를 '최신' 으로 읽지 않습니다 — 모르는 상태에서 스키마를 바꾸지 않습니다."
      return 0 ;;
  esac

  say "적용될 리비전 ${DB_PENDING_N}건 (DB=$DB_CURRENT → head=$DB_HEAD, 출처 $DB_HEAD_SRC):"
  printf '%s\n' "$DB_PENDING" | while IFS= read -r r; do say "  · $r"; done

  # ⚠ 이 스크립트의 핵심 불변식(백업 집합 = 쓰기 집합 = 복구 집합)이 **DB 에 대해서만**
  #   깨지는 지점이다. --rollback 은 파일만 되돌린다. 그래서 사람의 명시적 확인을 받는다.
  if [ "${SV_DB_BACKUP_DONE:-0}" != "1" ]; then
    MIGRATE_INCOMPLETE=1
    warn "거부: DB 백업 확인(SV_DB_BACKUP_DONE=1)이 없습니다"
    say  "  --rollback 은 **파일만** 되돌립니다 — 한 번 적용한 마이그레이션은 이 스크립트가 되돌리지 못합니다."
    say  "  DB 를 먼저 백업(pg_dump 등)한 뒤, 그 사실을 명시해 다시 실행하세요:"
    say  "     SV_DB_BACKUP_DONE=1 sudo -E sh $(basename "$0") --apply <패키지> --migrate"
    say  "     (sudo 는 환경변수를 지웁니다 — -E 를 빠뜨리지 마세요)"
    return 0
  fi
  if [ -z "${PYBIN:-}" ] || [ ! -x "${PYBIN:-}" ]; then
    MIGRATE_INCOMPLETE=1
    warn "거부: 백엔드 파이썬을 특정하지 못했습니다(--pybin)"
    return 0
  fi

  # ── 동의 범위 재확인: upgrade 직전에 **지금 트리로** 다시 센다 ──────────────
  # [2] 의 진단은 do_copy([4]) **전** 시점이다. 실제로 도는 `upgrade head`(아래)는
  # 교체가 끝난 설치 트리 = 패키지의 체인을 따라간다. 두 시점이 다르므로, 예고한
  # 목록과 실제 적용분이 어긋날 수 있는 구조적 틈이 남는다(과거에는 '1건' 이라고
  # 동의받고 3건을 적용했다). 되돌릴 수 없는 유일한 행위 앞이므로 **다르면 거부**한다.
  #   ※ head 를 패키지에서 읽도록 고친 뒤에는 정상 경로에서 항상 일치한다. 그래도
  #     남겨 둔다 — 같은 종류의 어긋남이 다시 생기면 여기서 확정적으로 멈춘다.
  RE_HOUT="$( cd "$BACKEND_DIR" && to_run 30 "$PYBIN" -m alembic -c "$BACKEND_DIR/alembic.ini" heads 2>/dev/null )" || RE_HOUT=""
  RE_HEAD="$(printf '%s\n' "$RE_HOUT" | sed -n 's/^\([0-9a-f]\{6,\}\).*/\1/p' | head -1)"
  RE_HEADN="$(printf '%s\n' "$RE_HOUT" | sed -n 's/^\([0-9a-f]\{6,\}\).*/\1/p' | grep -c . || true)"
  RE_RANGE="$( cd "$BACKEND_DIR" && to_run 30 "$PYBIN" -m alembic -c "$BACKEND_DIR/alembic.ini" \
               history -r "$DB_CURRENT:head" 2>/dev/null )" || RE_RANGE=""
  RE_PENDING="$(printf '%s\n' "$RE_RANGE" | sed -n 's/.*-> \([0-9a-f][0-9a-f]*\).*/\1/p' \
                | grep -v "^$DB_CURRENT\$" || true)"
  if [ -z "$RE_HEAD" ] || [ "${RE_HEADN:-1}" -gt 1 ] \
     || [ "$RE_HEAD" != "$DB_HEAD" ] || [ "$RE_PENDING" != "$DB_PENDING" ]; then
    MIGRATE_INCOMPLETE=1
    warn "거부: 교체 후 트리의 마이그레이션 목록이 [2] 에서 예고한 것과 다릅니다"
    say  "  예고: head=$DB_HEAD  ${DB_PENDING_N}건"
    say  "  현재: head=${RE_HEAD:-읽지 못함}(head 개수 ${RE_HEADN:-?})  $(printf '%s' "$RE_PENDING" | grep -c . || true)건"
    say  "  동의받은 범위를 넘는 스키마 변경을 하지 않습니다 — 아무것도 적용하지 않았습니다."
    say  "  현재 상태로 다시 진단하려면:  sudo sh $(basename "$0") --dry-run <패키지>"
    return 0
  fi

  warn "'구 코드가 신 스키마를 보는 창' 이 지금부터 [7] 재시작까지 열립니다"
  say  "  (파일은 이미 교체됐지만 백엔드 프로세스는 아직 구 코드를 메모리에 들고 있습니다)"
  say  "실행: cd $BACKEND_DIR && $PYBIN -m alembic upgrade head"
  MRC=0
  ( cd "$BACKEND_DIR" && to_run 600 "$PYBIN" -m alembic -c "$BACKEND_DIR/alembic.ini" upgrade head ) || MRC=$?
  if [ "$MRC" != "0" ]; then
    MIGRATE_FAIL=1
    warn "alembic upgrade head 실패(exit $MRC)"
    say  "  DB 는 **중간 상태**일 수 있습니다. --rollback 은 이것을 되돌리지 못합니다."
    say  "  백업에서 DB 를 복원할지 여부는 사람이 판단하세요. 스크립트는 더 손대지 않습니다."
    return 0
  fi
  MIGRATE_DONE=1
  ok "alembic upgrade head 완료"

  # 'exit 0' 과 '실제로 스탬프가 올라갔다' 는 다른 명제다 — 되물어 확인한다.
  AOUT="$( cd "$BACKEND_DIR" && to_run 30 "$PYBIN" -m alembic -c "$BACKEND_DIR/alembic.ini" current 2>/dev/null )" || AOUT=""
  AREV="$(printf '%s\n' "$AOUT" | sed -n 's/^\([0-9a-f]\{6,\}\).*/\1/p' | head -1)"
  if [ -n "$AREV" ] && [ "$AREV" = "$DB_HEAD" ]; then
    ok "적용 후 DB 리비전 = $AREV (= $DB_HEAD_SRC head)"
  elif [ -n "$AREV" ]; then
    # ⚠ 이것은 '확인 못 함' 이 아니라 **틀렸다**. 기대한 head 가 아닌 곳에 스탬프가 서
    #   있다는 뜻이고, 되돌릴 수 없는 행위 뒤라 정상 종료가 될 수 있는 상태가 아니다.
    #   예전에는 warn 만 찍고 exit 0 이 나가 '✅ 갱신 완료' 로 덮였다.
    MIGRATE_FAIL=1
    warn "적용 후 리비전이 기대와 다릅니다(읽은 값: $AREV / 기대: $DB_HEAD)"
    say  "  = 예고·동의받은 범위와 실제 DB 상태가 어긋났습니다. 이 실행은 실패로 판정합니다."
    say  "  DB 는 이미 바뀌었습니다 — --rollback 은 이것을 되돌리지 못합니다."
  else
    # 읽지 못한 것은 실패와 다르다(적용은 exit 0 이었다) → '미검증' 으로 따로 말한다.
    MIGRATE_UNVERIFIED=1
    warn "적용 후 리비전을 읽지 못했습니다(기대: $DB_HEAD) — '이상 없음' 이 아니라 '모름' 입니다"
    say  "  확인:  cd $BACKEND_DIR && $PYBIN -m alembic current"
  fi
  return 0
}

# ═══════════════════════════════════════════════════════════════════════════
# [6] nginx 최적화 — patch_nginx.sh 에 위임한다(드롭인 로직을 중복 구현하지 않는다)
#     다만 brotli **모듈 설치**는 patch_nginx.sh 가 하지 않으므로 여기서 먼저 한다.
# ═══════════════════════════════════════════════════════════════════════════

# brotli 능력 판정을 사다리에서 **분리해 단독으로** 수행한다.
# patch_nginx.sh 처럼 gzip 지시어들과 섞어 돌리면 '이미 설정됨(duplicate)' 과
# '모듈 없음(unknown)' 이 같은 메시지로 뭉개진다. 단독 테스트에서는 두 에러가
# 서로 배타적이라 오진이 원천 차단된다.
#   반환: 0=모듈 있음  1=모듈 없음  2=판정 불가
# 탐침 파일 경로를 계산한다(0=구했음, 1=못 구함). brotli_probe 와 '잔재 회수' 가
# **같은 경로**를 봐야 하므로 한 곳에 둔다.
probe_path() {
  PROBE=""
  [ -n "${NGINX:-}" ] || return 1
  CONF="$("$NGINX" -V 2>&1 | tr ' ' '\n' | sed -n 's/^--conf-path=//p' | head -1)"
  [ -n "$CONF" ] && [ -f "$CONF" ] || CONF=/etc/nginx/nginx.conf
  [ -f "$CONF" ] || return 1
  CONFDIR="$(dirname "$CONF")/conf.d"
  [ -d "$CONFDIR" ] || return 1
  PROBE="$CONFDIR/zz-saintview-brotli-probe.conf"
  return 0
}

# 이전 실행이 중단돼 남았을 수 있는 탐침 파일을 선제 회수한다.
# (남아 있으면 모듈 없는 서버에서 nginx -t / reload / **부팅**이 전부 실패한다)
probe_reap_stale() {
  probe_path || return 0
  if [ -f "$PROBE" ]; then
    warn "이전 실행이 남긴 brotli 탐침 파일을 제거합니다: $PROBE"
    warn "  (이 파일이 남아 있으면 모듈 없는 서버는 다음 재부팅에서 nginx 가 뜨지 않습니다)"
    rm -f "$PROBE" 2>/dev/null || warn "  제거 실패 — 직접 지우세요: rm -f $PROBE"
  fi
}

brotli_probe() {
  [ -n "${NGINX:-}" ] || return 2
  probe_path || return 2
  # ⚠ 여기서 쓰는 곳은 **실서버가 실제로 include 하는 경로**다. 파일을 만든 뒤 지우기
  #   전에 프로세스가 죽으면(Ctrl-C, SSH 끊김=HUP, 배포창 타임아웃, OOM killer) 파일이
  #   그대로 남고, brotli 모듈이 없는 서버에서는 `unknown directive "brotli_static"` 로
  #   이후 모든 nginx -t / nginx -s reload 가 실패한다. 실행 중인 nginx 는 계속 정상
  #   서비스하므로 아무도 눈치채지 못하다가 **무관한 재부팅에서 사이트 전체가 죽는다**.
  #   (모듈이 있는 서버에서도 드롭인의 brotli_static 과 겹쳐 duplicate [emerg] 가 된다)
  #   → 파일을 만들기 **전에** 트랩을 걸고, 정상 경로에서 지운 뒤 트랩을 푼다.
  trap 'rm -f "$PROBE"' EXIT
  trap 'rm -f "$PROBE"; exit 130' INT
  trap 'rm -f "$PROBE"; exit 143' TERM
  trap 'rm -f "$PROBE"; exit 129' HUP
  printf 'brotli_static on;\n' > "$PROBE"
  PRC=0; PERR="$("$NGINX" -t 2>&1)" || PRC=$?
  rm -f "$PROBE"
  trap - EXIT INT TERM HUP
  if [ "$PRC" = "0" ]; then return 0; fi
  case "$PERR" in
    *'"brotli_static" directive is duplicate'*) return 0 ;;  # 이미 설정됨 = 모듈은 있다
    *'unknown directive "brotli_static"'*)      return 1 ;;  # 모듈 없음 확정
    *) printf '%s\n' "$PERR"; return 2 ;;                    # 우리와 무관한 기존 설정 오류
  esac
}

brotli_install() {
  # 패키지 이름 주의: `libnginx-mod-http-brotli` 는 **존재하지 않는 이름**이다.
  # 실제로는 -filter(런타임 압축) / -static(.br 서빙) 두 개로 쪼개져 있고,
  # 우리에게 필요한 것은 **-static 하나뿐**이다(filter 는 CPU 만 쓴다).
  ID=""; VER=""
  if [ -r /etc/os-release ]; then
    ID="$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"' | head -1)"
    VER="$(sed -n 's/^VERSION_ID=//p' /etc/os-release | tr -d '"' | head -1)"
    LIKE="$(sed -n 's/^ID_LIKE=//p' /etc/os-release | tr -d '"' | head -1)"
  fi
  say "배포판: ${ID:-unknown} ${VER:-} (like: ${LIKE:-none})"
  case "$ID $LIKE" in
    *debian*|*ubuntu*)
      # Debian 12 = main, Ubuntu 24.04 = universe 에 있다. Ubuntu 22.04(jammy) 에는 **없다**.
      DEBIAN_FRONTEND=noninteractive apt-get update >/dev/null 2>&1 || true
      if apt-cache policy libnginx-mod-http-brotli-static 2>/dev/null | grep -q 'Candidate: [^(]'; then
        DEBIAN_FRONTEND=noninteractive apt-get install -y libnginx-mod-http-brotli-static
        return $?
      fi
      warn "apt 에 libnginx-mod-http-brotli-static 후보가 없습니다"
      return 1 ;;
    *rhel*|*centos*|*rocky*|*almalinux*|*fedora*)
      # RHEL 계열은 EPEL 의 nginx-mod-brotli 하나가 filter+static 을 둘 다 담고 있다.
      dnf install -y epel-release >/dev/null 2>&1 || true
      dnf install -y nginx-mod-brotli
      return $? ;;
    *)
      warn "지원하지 않는 배포판입니다: ${ID:-unknown}"
      return 1 ;;
  esac
}

brotli_manual_help() {
  cat <<'HOWTO'
  ❌ brotli 모듈 없음 — .br 파일이 서버에 있는데도 전송되지 않습니다
     (빌드가 이미 .br 을 만들어 함께 배포했지만, nginx 가 협상을 못 합니다)

     자동 설치가 불가능한 대표 사례: Ubuntu 22.04(jammy).
       · 배포판 저장소(main/universe/backports)에 nginx brotli 모듈이 없다
       · ppa:ondrej/nginx 는 존재하지 않는다(Launchpad 404)
       · nginx.org 공식 저장소도 brotli 모듈을 제공하지 않는다
       · 다른 버전용 .so 반입은 `version 1024000 instead of 1018000` 로 거부된다
     → **설치된 nginx 와 정확히 같은 버전의 소스**로 동적 모듈을 빌드하는 수밖에 없다:

       apt-get install -y build-essential git cmake libpcre3-dev zlib1g-dev libssl-dev
       NGV=$(nginx -v 2>&1 | sed 's#.*nginx/\([0-9.]*\).*#\1#')
       wget https://nginx.org/download/nginx-$NGV.tar.gz && tar xf nginx-$NGV.tar.gz
       git clone --recurse-submodules https://github.com/google/ngx_brotli
       cd nginx-$NGV && ./configure --with-compat --add-dynamic-module=../ngx_brotli && make modules
       cp objs/ngx_http_brotli_static_module.so "$(nginx -V 2>&1 | tr ' ' '\n' \
            | sed -n 's/^--modules-path=//p')/"
       echo 'load_module modules/ngx_http_brotli_static_module.so;' \
            > /etc/nginx/modules-enabled/50-mod-http-brotli-static.conf
       nginx -t && systemctl reload nginx

     ⚠ 운영 서버에 컴파일러를 설치하는 결정은 사람이 해야 하므로 이 스크립트는
       자동 빌드를 하지 않습니다. 또 이후 nginx 를 업그레이드하면 .so 버전 체크에
       걸려 기동에 실패할 수 있으니, nginx 를 올릴 때 모듈도 함께 다시 빌드하세요.
HOWTO
}

do_nginx() {
  step "nginx 전송 최적화"
  if [ "$SKIP_NGINX" = "1" ]; then say "--skip-nginx 지정 — 건너뜁니다"; return 0; fi
  if [ -z "${NGINX:-}" ]; then warn "nginx 를 찾지 못해 건너뜁니다"; return 0; fi

  # 1) 모듈 먼저, 드롭인은 그 다음. 순서를 반대로 하면 모듈이 나중에 깔려도
  #    이미 brotli_static 이 빠진 드롭인이 확정돼 버린다.
  BR_OK=0
  RC=0; brotli_probe || RC=$?
  case "$RC" in
    0) ok "brotli 모듈 있음"; BR_OK=1 ;;
    1) warn "brotli 모듈 없음 — 설치를 시도합니다"
       IRC=0; brotli_install || IRC=$?
       RC2=0; brotli_probe || RC2=$?
       if [ "$RC2" = "0" ]; then ok "brotli 모듈 설치 성공"; BR_OK=1
       else
         echo
         brotli_manual_help
         say "감지: nginx=$("$NGINX" -v 2>&1 | tr -d '\n')  설치시도 exit=$IRC"
         echo
       fi ;;
    *) warn "brotli 능력 판정 불가 — 기존 nginx 설정에 다른 문제가 있을 수 있습니다" ;;
  esac

  # 2) 드롭인은 patch_nginx.sh 에 위임한다(WANT 목록·duplicate 사다리·원복이
  #    이미 거기 있다. 여기서 다시 구현하면 두 곳이 어긋난다).
  PATCH=""
  for c in "$SELF_DIR/patch_nginx.sh" "$PKG/deploy/patch_nginx.sh"; do
    if [ -f "$c" ]; then PATCH="$c"; break; fi
  done
  if [ -n "$PATCH" ]; then
    say "위임: sh $PATCH --apply"
    PRC=0; sh "$PATCH" --apply || PRC=$?
    # patch_nginx.sh 의 종료코드는 `nginx -s reload` 실패(nginx 미기동 등)로도 1 이 된다.
    # 종료코드만 보고 '실패' 라고 쓰면 오보가 되므로, **실제 결과물**로 다시 판정한다.
    DCHK="$(find /etc/nginx -name 'zz-saintview-perf.conf' 2>/dev/null | head -1)"
    if [ -n "$DCHK" ]; then
      if grep -q '^brotli_static' "$DCHK"; then ok "드롭인에 brotli_static 포함 ($DCHK)"
      else warn "드롭인에 brotli_static 이 없습니다 ($DCHK) — .br 이 서빙되지 않습니다"; fi
      if "$NGINX" -t >/dev/null 2>&1; then ok "nginx -t 통과"
      else warn "nginx -t 실패 — 즉시 확인하세요:  nginx -t"; fi
    elif [ "$PRC" != "0" ]; then
      warn "patch_nginx.sh 가 exit $PRC 로 끝났고 드롭인도 없습니다 — 위 출력을 확인하세요"
    fi
  else
    warn "patch_nginx.sh 를 찾지 못했습니다 (찾은 곳: $SELF_DIR/, $PKG/deploy/)"
    say "  → nginx 드롭인(gzip_static/brotli_static)은 적용되지 않았습니다."
    say "     패키지의 deploy/patch_nginx.sh 를 이 스크립트와 같은 폴더에 두고 다시 실행하거나,"
    say "     sudo sh deploy/patch_nginx.sh --apply 를 직접 실행하세요."
  fi

  if [ "$BR_OK" = "0" ]; then
    # 조용히 성공한 척 하지 않는다. 여기서 부분 적용임을 분명히 남긴다.
    warn "부분 적용(gzip 만) — brotli 는 비활성 상태입니다"
  fi

  # 3) 협진 WebSocket 업그레이드 블록 — server 블록에 주입한다(드롭인으로는 불가능).
  ensure_collab_ws
}

# ── 협진 WebSocket location 주입 ────────────────────────────────────────────
# 왜 필요한가(실사고, sv70 2026-08-06): 기존 `location /api/` 는 keep-alive 를 위해
# `proxy_set_header Connection "";` 를 쓰는데, 그 헤더가 WebSocket 업그레이드를 죽인다.
# 결과: REST 는 전부 200 인데 WS 핸드셰이크만 404 — 협진 화면은 뜨는데 메시지 전송·
# 프레즌스·미러가 전부 침묵한다("Message not sent — connection lost").
# 개발(vite ws:true)에서는 멀쩡해서 이 누락은 **운영에서만** 드러난다.
#
# location 은 server 블록 안에만 올 수 있어 http 드롭인(patch_nginx.sh)으로는 못 고친다.
# 그래서 여기서만 예외적으로 server 블록을 편집하되, 이 스크립트의 규약대로
# 백업 → 주입 → nginx -t → 실패 시 원복 을 지킨다. 이미 있으면 아무것도 안 한다(멱등).
ensure_collab_ws() {
  say "협진 WebSocket 경로(/api/collab/ws) 점검"
  # nginx -T = 실제 로드되는 전체 설정. 파일을 직접 grep 하면 include 안 된 사본에 속는다.
  FULL="$("$NGINX" -T 2>/dev/null || true)"
  if [ -z "$FULL" ]; then warn "nginx -T 실패 — WS 블록 점검을 건너뜁니다"; return 0; fi
  if printf '%s' "$FULL" | grep -q 'location /api/collab/ws'; then
    ok "WS 블록 이미 있음"; return 0
  fi
  if ! printf '%s' "$FULL" | grep -q 'location /api/'; then
    warn "location /api/ 를 가진 server 블록이 없습니다 — 프록시 구성이 예상과 다릅니다"
    return 0
  fi
  # `location /api/` 가 실제로 들어 있는 설정 파일을 찾는다(-T 덤프의 파일 마커 사용)
  WSFILE="$(printf '%s' "$FULL" | awk '
    /^# configuration file /{f=$4; sub(/:$/,"",f)}
    /location \/api\/[ {]/{print f; exit}')"
  if [ -z "$WSFILE" ] || [ ! -f "$WSFILE" ]; then
    warn "location /api/ 선언 파일을 특정하지 못했습니다 — 수동 반영 필요(deploy/nginx-viewer.conf 참조)"
    return 0
  fi
  # 그 블록의 proxy_pass 를 그대로 따른다(포트가 기본과 다른 배치 대응). 못 찾으면 8010.
  WSPASS="$(awk '/location \/api\/[ {]/{f=1} f&&/proxy_pass/{print $2; exit}' "$WSFILE" | tr -d ';')"
  [ -n "$WSPASS" ] || WSPASS="http://127.0.0.1:${PORT:-8010}"
  BK="$WSFILE.bak-collabws-$(date +%Y%m%d%H%M%S)"
  cp -p "$WSFILE" "$BK" || { warn "백업 실패 — 주입을 중단합니다"; return 0; }
  # 첫 번째 `location /api/` 바로 앞에 삽입 — 더 구체적인 접두사가 이기므로 순서는 사실
  # 무관하지만, 사람이 읽을 때 의도가 보이는 자리(기존 블록 위)에 둔다.
  awk -v pass="$WSPASS" '
    !done && /location \/api\/[ {]/ {
      print "    # 협진 WebSocket — update_server.sh 가 주입(멱등). 아래 /api/ 의";
      print "    # Connection \"\" 가 업그레이드를 깨므로 별도 블록이 반드시 필요하다.";
      print "    location /api/collab/ws {";
      print "        proxy_pass " pass ";";
      print "        proxy_http_version 1.1;";
      print "        proxy_set_header Upgrade $http_upgrade;";
      print "        proxy_set_header Connection \"upgrade\";";
      print "        proxy_set_header Host $host;";
      print "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;";
      print "        proxy_set_header X-Forwarded-Proto $scheme;";
      print "        proxy_read_timeout 3600s;";
      print "        proxy_send_timeout 3600s;";
      print "        proxy_buffering off;";
      print "    }";
      done=1
    }
    {print}
  ' "$BK" > "$WSFILE" || { cp -p "$BK" "$WSFILE"; warn "주입 실패 — 원복했습니다"; return 0; }
  if "$NGINX" -t >/dev/null 2>&1; then
    ok "WS 블록 주입 ($WSFILE, proxy_pass $WSPASS) — nginx -t 통과"
    if "$NGINX" -s reload >/dev/null 2>&1 || systemctl reload nginx >/dev/null 2>&1; then
      ok "nginx reload 완료"
    else
      warn "reload 실패 — 수동 실행:  nginx -s reload"
    fi
  else
    cp -p "$BK" "$WSFILE"
    warn "nginx -t 실패 — 원복했습니다. 수동 반영 필요(deploy/nginx-viewer.conf 의 WS 블록 참조)"
    "$NGINX" -t 2>&1 | tail -2 || true
  fi
}

# ═══════════════════════════════════════════════════════════════════════════
# [7] 백엔드 재시작 — 발견한 방식대로만. 추측으로 죽이지 않는다.
# ═══════════════════════════════════════════════════════════════════════════
wait_health() {   # $1 = 최대 대기(초)
  W=0
  while [ "$W" -lt "${1:-60}" ]; do
    if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 2; W=$((W + 2))
  done
  return 1
}

# 구 프로세스가 물러났는지를 **포트 해제**로 판정한다(kill -0 은 좀비에도 성공한다).
# 포트를 볼 수단이 아예 없는 환경에서만 PID(좀비 포함)로 폴백한다.
# $1 = 최대 대기(초).  0=해제됨 1=아직 점유
WPF_ELAPSED=0
wait_port_free() {
  WPF_ELAPSED=0
  while :; do
    PB=0; port_busy || PB=$?
    if [ "$PB" = "1" ]; then return 0; fi
    if [ "$PB" = "2" ] && proc_gone "${BPID:-}"; then return 0; fi
    [ "$WPF_ELAPSED" -lt "${1:-30}" ] || return 1
    sleep 1; WPF_ELAPSED=$((WPF_ELAPSED + 1))
  done
}

# 재기동을 실제로 한 번이라도 시도했는지. 메시지를 사실과 맞추는 데 쓴다.
RESTART_TRIED=0

manual_restart_help() {
  # 머리말은 **관측한 사실**로 갈라 쓴다. 포트가 비어 있는데 '구 프로세스가 그대로
  # 돌고 있습니다' 라고 쓰면 운영자를 정반대 진단으로 몰아넣는다(서비스는 이미 중단).
  PBH=0; port_busy || PBH=$?
  if [ "$PBH" = "1" ]; then
    cat <<EOF
  ❌ 백엔드가 **내려가 있습니다** — 포트 $PORT 에 리스너가 없습니다(서비스 중단 중).
     코드는 교체됐고 구 프로세스도 종료됐지만, 새 프로세스가 뜨지 못했습니다.
     ※ 지금 즉시 아래 4) 의 수동 기동을 하거나, 롤백 후 기동하세요.
EOF
  elif [ "$RESTART_TRIED" = "1" ]; then
    cat <<EOF
  ❌ 재기동은 했지만 백엔드가 health 에 응답하지 않습니다(포트 $PORT 는 점유 중).
     새 프로세스가 떴다가 기동 중 실패했거나, 아직 부팅 중일 수 있습니다.
     ※ 먼저 로그를 보세요. 구 코드로 돌아가 있는 상태가 아닙니다.
EOF
  else
    cat <<EOF
  ❌ 백엔드를 자동으로 재시작하지 못했습니다.
     **코드는 이미 교체됐지만 구 프로세스가 그대로 돌고 있습니다**(포트 $PORT 점유 중)
     (uvicorn 에 --reload 가 없으므로 재시작 전에는 신규 라우트가 계속 404 입니다).
EOF
  fi
  cat <<EOF

     서버에서 아래를 순서대로 확인하고 직접 재시작하세요:
       1) 무엇이 $PORT 을 잡고 있나
            ss -lptn 'sport = :$PORT'      # 또는  lsof -nP -iTCP:$PORT -sTCP:LISTEN
       2) 그 PID 가 systemd 서비스인가
            cat /proc/<PID>/cgroup ; systemctl status <PID>
            → 서비스면:  systemctl restart <유닛>
       3) 도커인가
            docker ps --format '{{.Names}} {{.Ports}}' | grep $PORT
            → 컨테이너면:  docker restart <이름>
              ⚠ 소스가 bind mount 가 아니면 restart 로는 코드가 안 바뀝니다(재빌드 필요)
       4) 맨 프로세스면 (cgroup 이 / 또는 /init.scope)
            kill -TERM <PID>        # lifespan shutdown 을 돌게 둔다. -9 를 먼저 쓰지 말 것
            # 포트가 풀릴 때까지 기다린 뒤(즉시 재기동하면 Address already in use)
            cd "$BACKEND_DIR" && setsid nohup <원래 cmdline> >> /var/log/saintview-backend.log 2>&1 &
          ※ **cd 를 반드시 $BACKEND_DIR 로** 해야 합니다. config.py 의 load_dotenv() 가
            CWD 기준으로 .env 를 읽으므로, cwd 가 틀리면 sqlite:///./dev.db 로 조용히
            떨어져 **빈 DB 로 기동**됩니다.
     되돌리려면:  sudo sh $(basename "$0") --rollback $TS
EOF
}

do_restart() {
  step "백엔드 재시작"
  # ⚠⚠ **이 함수 안에서는 errexit(set -e)이 꺼져 있다.**
  #   호출부가 `RRC=0; do_restart || RRC=$?` 형태인데, POSIX 는 `||` 왼쪽 명령에서
  #   errexit 를 무시하도록 규정하고 그 억제가 **함수 본문 전체로 전파된다**(dash·bash
  #   모두 확인). 즉 여기서는 어떤 명령이 실패해도 셸이 멈추지 않는다.
  #   → 되돌릴 수 없는 행위(kill, mv, rm) 앞의 전제조건은 반드시 **손으로** 검사한다.
  if [ "$SKIP_RESTART" = "1" ]; then warn "--skip-restart 지정 — 구 코드가 계속 돕니다"; return 0; fi

  # 런타임 판별은 [2] 에서 이미 했지만, 호출 순서에 의존하지 않도록 여기서 다시 한다
  # (읽기만 하므로 몇 번을 돌려도 안전하다).
  detect_runtime

  if [ -n "$CID" ]; then
    say "백엔드가 도커 컨테이너에서 돕니다 (id=$CID)"
    # ⚠ 이 함수는 errexit 이 꺼져 있다(위 주석) → docker_verdict 는 어떤 경우에도
    #   0 을 반환하고 결과를 변수로만 말한다. 되돌릴 수 없는 행위(restart) 앞의
    #   전제조건은 아래 case 에서 **손으로** 검사한다.
    docker_verdict "$CID"
    case "$DOCKER_VERDICT" in
      bind)
        ok "bind mount 증명됨: $DOCKER_BIND_EVID"
        say "  → 호스트에서 교체한 코드가 컨테이너 안에서도 **같은 파일**입니다."
        say "     그러므로 이 restart 는 systemctl restart 와 의미가 정확히 같습니다."
        say "     (컨테이너 내부에서 그 경로를 실제로 임포트하는지는 호스트에서 증명할 수 없습니다"
        say "      — 그래서 [8] 의 openapi 지문 검증이 최종 판정입니다)"
        RC=0; docker restart "$CID" >/dev/null 2>&1 || RC=$?
        if [ "$RC" != "0" ]; then
          warn "docker restart 실패(exit $RC)"; manual_restart_help; return 1
        fi
        if wait_health 60; then ok "재시작 완료 (docker $CID)"; return 0; fi
        warn "재시작했으나 60초 내 health 응답 없음"
        docker logs --tail 60 "$CID" 2>&1 | tail -60 || true
        return 1 ;;
      image)
        # 이것이 '확정 실패' 다. 이번 갱신은 백엔드에 **무효**이며, restart 는
        # 같은 구 이미지를 다시 띄워 '완료' 라는 거짓 성공만 만든다.
        warn "이 컨테이너에는 백엔드 코드를 덮는 bind mount 가 **없습니다**"
        say  "  근거: $DOCKER_NOTE"
        warn "코드가 이미지 안에 있으므로 **이번 호스트 파일 교체는 백엔드에 무효**입니다"
        say  "     restart 해도 같은 구 이미지가 다시 뜰 뿐이라 재시작하지 않습니다."
        say  "     필요한 조치: 이미지 재빌드 후 재배포(이 저장소에는 백엔드 Dockerfile 이 없습니다 —"
        say  "     운영자가 만든 이미지이므로 그 빌드 절차를 따르세요)."
        say  "     지금은 '프론트·호스트 트리만 신버전' 인 혼합 상태입니다. 되돌리려면:"
        say  "       sudo sh $(basename "$0") --rollback $TS"
        return 1 ;;
      *)
        warn "도커 컨테이너로 보이지만 bind mount 를 증명하지 못했습니다"
        say  "  사유: ${DOCKER_NOTE:-불명}"
        say  "  근거 없이 restart 하지 않습니다 — 코드가 이미지 안이면 '재시작 완료' 가 거짓이 됩니다."
        say  "  확인:  docker inspect -f '{{json .Mounts}}' $CID"
        say  "  반영:  docker restart $CID   (설치 경로가 bind mount 임을 눈으로 확인한 경우에만)"
        manual_restart_help
        return 1 ;;
    esac
  fi

  # ⚠ cgroup 에 컨테이너 흔적은 있는데 docker CID 로 특정하지 못한 경우
  #   (podman / containerd / k8s / lxc). 이 검사는 반드시 **UNIT 분기보다 위**에 있어야
  #   한다: 컨테이너의 cgroup 경로에는 그 컨테이너를 담는 상위 유닛(containerd.service,
  #   user@1000.service …)이 함께 박혀 있어 UNIT 이 비어 있지 않기 때문이다. 아래에
  #   두면 이 가드가 한 번도 실행되지 못한 채 **호스트의 런타임 데몬을 재시작**하고
  #   '✅ 재시작 완료' 라는 거짓 성공이 나간다(detect_runtime 에서 UNIT 을 비우는 것과
  #   합쳐 두 겹으로 막는다 — 어느 한쪽이 무너져도 안전측으로 떨어진다).
  #   또 '맨 프로세스' 분기로 흘려보내도 안 된다: 컨테이너 안 프로세스에 kill -TERM 을
  #   보내는 셈이라 컨테이너가 통째로 죽고 재기동 정책에 따라 **구 이미지로 다시 뜬다**.
  if [ "$RUNTIME_UNCERTAIN" = "1" ]; then
    warn "컨테이너 안에서 도는 것으로 보이지만 런타임을 특정하지 못했습니다(docker 아님)"
    say  "  cgroup: $(printf '%s' "$RUNTIME_CG" | head -1)"
    if [ -n "$RUNTIME_CG_UNIT" ]; then
      say  "  ※ cgroup 에서 '$RUNTIME_CG_UNIT' 이 보이지만 이것은 컨테이너를 **담고 있는**"
      say  "     상위 유닛이지 백엔드의 유닛이 아닙니다 — 재시작 대상으로 쓰지 않습니다."
    fi
    say  "  → 컨테이너 안 프로세스를 죽이면 컨테이너가 통째로 내려가고, 재기동 정책에 따라"
    say  "     구 이미지로 다시 뜰 수 있습니다. 근거 없이 종료 신호를 보내지 않습니다."
    say  "  코드가 이미지 안이라면 이번 갱신은 백엔드에 반영되지 않습니다(이미지 재빌드 필요)."
    manual_restart_help
    return 1
  fi

  if [ -n "$UNIT" ] && command -v systemctl >/dev/null 2>&1; then
    say "systemd 유닛: $UNIT"
    systemctl show -p FragmentPath -p ExecStart -p User -p WorkingDirectory --value "$UNIT" 2>/dev/null || true
    RC=0; systemctl restart "$UNIT" || RC=$?
    if [ "$RC" != "0" ]; then warn "systemctl restart 실패(exit $RC)"; manual_restart_help; return 1; fi
    if wait_health 60; then ok "재시작 완료 ($UNIT)"; return 0; fi
    warn "재시작했으나 60초 내 health 응답 없음"
    journalctl -u "$UNIT" -n 60 --no-pager 2>/dev/null || true
    return 1
  fi

  if [ -n "${BPID:-}" ] && [ -r "/proc/$BPID/cmdline" ]; then
    say "맨 프로세스로 판단 — TERM 후 원래 인자·cwd 로 다시 띄웁니다"
    CMDF="$BACKUP_ROOT/$TS/cmdline.bin"
    # ⚠ 재기동의 **유일한** 근거가 이 파일이다(1105 행의 `xargs -0 < "$CMDF"`).
    #   errexit 이 꺼져 있으므로(위 주석) 이 복사가 실패해도 스크립트는 그대로 진행해
    #   kill -TERM 으로 백엔드를 죽인 뒤, 없는 파일을 xargs 에 먹이려다 재기동에
    #   실패한다 — 백엔드만 내려간 채 끝난다. 죽이기 **전에** 확보를 확인한다.
    if ! mkdir -p "$(dirname "$CMDF")" 2>/dev/null; then
      warn "재기동 명령을 보관할 디렉터리를 만들지 못했습니다: $(dirname "$CMDF")"
      say  "  근거 없이 프로세스를 죽이지 않습니다 — 구 프로세스는 그대로 둡니다."
      manual_restart_help; return 1
    fi
    if ! cp "/proc/$BPID/cmdline" "$CMDF" 2>/dev/null || [ ! -s "$CMDF" ]; then
      warn "원래 기동 명령(cmdline)을 보존하지 못했습니다: /proc/$BPID/cmdline → $CMDF"
      say  "  지금 종료 신호를 보내면 다시 띄울 근거가 사라집니다 — 죽이지 않고 멈춥니다."
      manual_restart_help; return 1
    fi
    # ── 단일 워커 배포 계약 점검 ────────────────────────────────────────────
    # 이 스크립트는 스스로 --workers 를 붙이지 않는다(원래 cmdline 을 그대로 재사용한다).
    # 그러나 **지금 돌고 있는 프로세스**가 다중 워커로 떠 있으면 그대로 다시 뜨고,
    # SAINTVIEW_ENV=prod 면 app/config.py 의 게이트에 걸려 서비스가 뜨지 못한다
    # (게이트 예외는 워커 자식에서 나므로, 마스터를 못 내리면 무한 재기동 루프가 된다).
    # → 죽이기 전에 미리 알린다(원격에서 이유를 모른 채 백엔드를 잃는 일을 막는다).
    # 판정은 확실할 때만: --workers/-w 의 값이 2 이상인 경우로 좁힌다(오탐 금지).
    CMD_TXT="$(tr '\0' ' ' < "$CMDF" 2>/dev/null || true)"
    WK="$(printf '%s' "$CMD_TXT" \
          | sed -n 's/.*[[:space:]]--workers[= ]\{1,\}\([0-9]\{1,\}\).*/\1/p' | tail -1)"
    if [ -z "$WK" ]; then
      WK="$(printf '%s' "$CMD_TXT" | sed -n 's/.*[[:space:]]-w[= ]\{0,\}\([0-9]\{1,\}\).*/\1/p' | tail -1)"
    fi
    case "$WK" in
      ''|*[!0-9]*) ;;
      *) if [ "$WK" -ge 2 ]; then
           warn "현재 기동 명령에 워커 $WK 개가 지정돼 있습니다: $CMD_TXT"
           say  "  이 백엔드는 **단일 워커가 배포 계약**입니다 — 캐시·락·A세션이 프로세스"
           say  "  인메모리라 워커마다 따로 돌아 조용히 깨집니다(A 로그인 랜덤 만료·로그인"
           say  "  잠금 임계값 N배·같은 SOP 중복 다운로드·디코드 캐시 N배로 OOM)."
           say  "  이대로 재기동하면 SAINTVIEW_ENV=prod 에서 게이트에 걸려 **서비스가 뜨지 못합니다**."
           say  "  ⚠ 게이트 예외는 워커 자식에서 나므로, 마스터를 함께 내리지 못하면 '거부'가"
           say  "     아니라 **무한 재기동 루프**가 됩니다(실측 uvicorn 0.34.0: 30초에 8회 재기동,"
           say  "     매 회 앱 전체 재import → CPU 소모·로그 폭주). 포트는 netstat 에 LISTEN 으로"
           say  "     안 보이지만 마스터가 점유해 다른 프로세스는 bind 에 실패합니다."
           say  "     (게이트는 조건이 맞으면 마스터에 SIGTERM 을 보내 루프를 끊습니다 —"
           say  "      그래도 루프가 보이면 pkill -f 'uvicorn.*--workers' 로 마스터를 직접 종료)"
           say  "  조치: --workers 1 로 띄우세요(워커를 늘리려면 캐시·세션을 공유 저장소로"
           say  "        먼저 빼야 합니다 — docs/DEPLOYMENT.md §3-1)."
         fi ;;
    esac
    LOG="${SV_BACKEND_LOG:-/var/log/saintview-backend.log}"
    kill -TERM "$BPID" 2>/dev/null || true

    # 종료 판정을 **포트 해제**로 한다.
    #  · kill -0 은 좀비(Z)에도 성공한다 → 이미 죽은 프로세스를 '살아 있음' 으로 오인해
    #    영원히 대기하다 타임아웃으로 빠져나가고, 그 사이 서비스는 내려가 있다.
    #  · 우리가 실제로 알아야 하는 것은 '새 프로세스가 bind 할 수 있는가' 다.
    TWAIT="${SV_TERM_WAIT:-30}"
    FREED=0
    if wait_port_free "$TWAIT"; then FREED=1; fi

    if [ "$FREED" = "1" ]; then
      say "포트 $PORT 해제 확인 (${WPF_ELAPSED}초)"
    else
      # 여기서 그냥 return 하면 **새 프로세스를 한 번도 띄우지 않은 채** 끝나
      # 백엔드가 죽은 상태로 방치된다(과거 버그). 관측값으로 갈라서 처리한다.
      if proc_gone "$BPID"; then
        warn "${TWAIT}초 경과 — 구 프로세스는 이미 종료됐는데 포트 $PORT 가 다른 것에 잡혀 있습니다"
        say "  확인:  ss -lptn 'sport = :$PORT'"
        manual_restart_help; return 1
      fi
      warn "${TWAIT}초 내에 종료되지 않았습니다 (SSE/스트리밍 정리 중일 수 있습니다)"
      DOKILL=0
      if [ "${SV_FORCE_KILL:-0}" = "1" ]; then
        warn "SV_FORCE_KILL=1 — kill -9 로 강제 종료합니다"
        DOKILL=1
      elif ( : > /dev/tty ) 2>/dev/null; then
        # ⚠ `[ -r /dev/tty ]` 로 판정하면 안 된다. 제어터미널이 없는 비대화 실행
        #   (`ssh server "sudo sh update_server.sh --apply ..."`, cron, CI)에서도
        #   /dev/tty **노드 자체는 존재**해 -r 이 참이 되고, 실제 open 만 ENXIO 로
        #   실패한다. 그러면 셸 원시 에러("cannot create /dev/tty: No such device or
        #   address") 2줄만 뱉고, 정작 필요한 안내(else 분기의 SV_FORCE_KILL 문구)는
        #   끝내 출력되지 않는다.
        #   → **실제로 열어 보고** 성공했을 때만 물어본다. 열기 시도는 서브셸에서 한다:
        #     `exec` 는 특수 내장이라 리다이렉션 실패가 비대화 셸을 통째로 죽인다.
        # 강제 종료는 진행 중인 판독/스트림을 끊는다 → 사람이 결정해야 한다.
        printf '  ❓ kill -9 로 강제 종료할까요? (yes 를 입력하면 진행) : ' > /dev/tty
        ANS=""; read -r ANS < /dev/tty || ANS=""
        if [ "$ANS" = "yes" ]; then DOKILL=1; fi
      else
        say "  (비대화 실행 — 강제 종료를 원하면 SV_FORCE_KILL=1 로 다시 실행하세요)"
      fi
      if [ "$DOKILL" = "1" ]; then
        kill -9 "$BPID" 2>/dev/null || true
        if wait_port_free 15; then FREED=1; fi
      fi
      if [ "$FREED" != "1" ]; then
        warn "포트 $PORT 가 여전히 점유돼 있어 새 프로세스를 띄우지 않습니다"
        say "  (지금 띄우면 Address already in use 로 즉사하고, 구 코드가 계속 서비스합니다)"
        manual_restart_help; return 1
      fi
      say "포트 $PORT 해제 확인 (강제 종료 후)"
    fi

    # 포트가 비었으면 **무조건 한 번은 띄운다**. 여기까지 와서 안 띄우면 서비스 중단이다.
    RESTART_TRIED=1
    RUN_USER="${RUN_USER:-root}"
    # 원래 argv 를 NUL 그대로 xargs 에 먹여 재구성한다(따옴표 재조립 오류 회피).
    if [ "$RUN_USER" = "root" ] || [ "$RUN_USER" = "$(id -un)" ]; then
      ( cd "$BACKEND_DIR" && setsid xargs -0 nohup < "$CMDF" >> "$LOG" 2>&1 & )
    else
      su -s /bin/sh "$RUN_USER" -c "cd '$BACKEND_DIR' && exec setsid xargs -0 nohup" \
         < "$CMDF" >> "$LOG" 2>&1 &
    fi
    if wait_health 60; then ok "재시작 완료 (로그: $LOG)"; return 0; fi
    warn "재기동했으나 60초 내 health 응답 없음 — 로그: $LOG"
    tail -n 40 "$LOG" 2>/dev/null || true
    manual_restart_help
    return 1
  fi

  manual_restart_help
  return 1
}

# ═══════════════════════════════════════════════════════════════════════════
# [8] 검증
# ═══════════════════════════════════════════════════════════════════════════
# '백엔드가 구버전' 을 **검출**하는 장치는 원래부터 있었다(아래 openapi 지문).
# 빠져 있던 것은 검출이 아니라 **귀속**이다 — 왜 구버전인지. 그동안 '재시작 누락 의심'
# 이라고만 찍어 운영자를 엉뚱한 곳으로 보냈다. [7] 의 판정 결과를 여기까지 끌고 와
# 원인을 그대로 말한다.
ATTRIB_DONE=0
attribute_stale() {
  [ "$ATTRIB_DONE" = "0" ] || return 0
  ATTRIB_DONE=1
  case "${DOCKER_VERDICT:-}" in
    image)
      vng "원인 확정: 백엔드 코드가 **도커 이미지 안**에 있습니다 — 호스트 파일 교체는 백엔드에 반영되지 않습니다"
      say "  근거: ${DOCKER_NOTE:-}"
      say "  조치: 이미지 재빌드 후 재배포(또는 설치 경로를 bind mount 로 바꾸기)"
      say "  지금은 '프론트·호스트 트리만 신버전' 인 혼합 상태입니다 — 되돌리기: sudo sh $(basename "$0") --rollback $TS" ;;
    unknown)
      warn "원인 후보: 도커 컨테이너인데 bind mount 를 증명하지 못했습니다(${DOCKER_NOTE:-사유 불명})"
      say  "  코드가 이미지 안이라면 이번 갱신은 백엔드에 무효입니다."
      say  "  확인:  docker inspect -f '{{json .Mounts}}' ${CID:-<컨테이너>}" ;;
    *)
      if [ "$RUNTIME_UNCERTAIN" = "1" ]; then
        warn "원인 후보: 컨테이너로 보이지만 런타임을 특정하지 못해 재시작하지 않았습니다"
      elif [ "$SKIP_RESTART" = "1" ]; then
        say "  원인: --skip-restart 로 재시작을 건너뛰었습니다(구 프로세스가 구 코드를 들고 있습니다)"
      else
        say "  확인 순서: [7] 출력의 재시작 결과 → 포트를 잡고 있는 PID → 그 PID 의 cwd"
      fi ;;
  esac
  return 0
}

verify_backend_local() {
  # 백엔드를 nginx 를 거치지 않고 직접 찌른다 → 프록시 문제와 코드 문제가 섞이지 않는다.
  B="http://127.0.0.1:$PORT"
  code="$(hcode --max-time 10 "$B/api/health")"
  [ "$code" = "200" ] && vok "백엔드 /api/health 200" || vng "백엔드 /api/health = $code"
  # health 가 5xx 인데 미적용 마이그레이션이 있으면 두 사실을 **나란히** 제시한다.
  # (둘을 인과로 단정하지 않는다 — 그 판단은 로그를 본 사람이 한다)
  case "$code" in
    5*) if [ "$DB_VERDICT" = "behind" ]; then
          say "  참고: [2] 진단에서 미적용 마이그레이션 ${DB_PENDING_N}건이 관측됐습니다(DB=$DB_CURRENT → head=$DB_HEAD)"
          say "        기동 실패 로그에 스키마 관련 오류가 있는지 함께 확인하세요."
        fi ;;
  esac

  # 가장 강한 증거: openapi 의 라우트 표 자체. (무인증 공개)
  TMPO="$(mktemp)"
  ocode="$(curl -sS -o "$TMPO" -w '%{http_code}' --max-time 20 "$B/openapi.json" 2>/dev/null || true)"
  if [ "$ocode" = "200" ] && grep -q '"/api/export/manifest"' "$TMPO"; then
    vok "openapi 에 /api/export/manifest 존재 → 신규 코드 반영됨"
  elif [ "$ocode" = "200" ]; then
    vng "openapi 200 이지만 /api/export/manifest 없음 → 백엔드가 여전히 구버전"
    attribute_stale
  else
    warn "openapi.json = $ocode — 상태코드 지문으로만 판정합니다"
  fi
  rm -f "$TMPO"

  # 상태코드 지문. 무인증 GET 은 **401** 이 정답이다(422 아님) —
  # FastAPI 는 sub-dependency(current_user)를 먼저 풀고 거기서 401 이 터지면
  # 필수 Query(study_ids)의 422 검증에 도달하지 않는다.
  # ※ HEAD(curl -I)를 쓰면 405 가 나온다. 반드시 GET.
  mcode="$(hcode --max-time 10 "$B/api/export/manifest")"
  case "$mcode" in
    401) vok "GET /api/export/manifest = 401 (라우트 존재)" ;;
    404) vng "GET /api/export/manifest = 404 → 백엔드가 구버전 코드로 돌고 있습니다"
         attribute_stale ;;
    200) vng "GET /api/export/manifest = 200 → /api 프록시 붕괴(SPA 폴백) 또는 인증 우회" ;;
    *)   vng "GET /api/export/manifest = $mcode (401 기대)" ;;
  esac
  # 대조군: 401 이 전 경로에 뭉텅이로 붙는 구성이 아님을 증명해야 위 401 에 증거력이 생긴다.
  ncode="$(hcode --max-time 10 "$B/api/export/__nope__")"
  [ "$ncode" = "404" ] && vok "대조군(없는 경로)=404 → 401 판정 유효" \
                       || vng "대조군(없는 경로)=$ncode → 위 401 은 증거력이 없습니다"
}

verify_frontend_disk() {
  dep="$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' "$FRONT_DIR/index.html" | sort -u | head -1)"
  if [ "$dep" = "$PKG_ASSET" ]; then vok "배포된 index.html 참조 = $dep"
  else vng "index.html 참조 불일치: 배포=$dep 패키지=$PKG_ASSET"; return; fi
  # index.html 만 올라가고 자산이 누락된 '부분 배포' 를 잡는다(흰 화면의 원인).
  [ -f "$FRONT_DIR/$dep" ] && vok "참조 자산 존재" || vng "참조 자산 없음: $FRONT_DIR/$dep"
  if [ -f "$PKG/frontend/dist/$dep.br" ]; then
    [ -f "$FRONT_DIR/$dep.br" ] && vok "사전압축 .br 함께 배포됨" \
                               || vng ".br 누락 — brotli_static 이 있어도 압축본이 안 나갑니다"
  fi
  if [ -f "$PKG/frontend/dist/$dep.gz" ]; then
    [ -f "$FRONT_DIR/$dep.gz" ] && vok "사전압축 .gz 함께 배포됨" || vng ".gz 누락"
  fi
}

# 원격 진단(로그인 불필요). --check 단독으로도, 갱신 후 마무리로도 쓴다.
do_check() {
  [ -n "$URL" ] || die "--check 에는 주소가 필요합니다 (예: --check https://sv70.cloudcare.life)"
  curl_ok || die "curl 이 필요합니다"
  U="${URL%/}"
  outln "  대상: $U"
  hdr() { curl -sk -o /dev/null -D - --max-time 20 "$@" | tr -d '\r'; }
  # 헤더만 보는 hdr 로는 상태줄(200/403/404)을 알 수 없다 → 코드와 타입을 따로 받는다.
  # 출력 형식: "<http_code> <content_type>"
  hmeta() { curl -sk -o /dev/null -w '%{http_code} %{content_type}' --max-time 20 "$@" 2>/dev/null || true; }

  RMETA="$(hmeta "$U/")"; RCODE="${RMETA%% *}"
  case "$RCODE" in
    200) ;;
    *) vng "루트 $U/ 응답 = ${RCODE:-000} (200 기대) — 사이트가 서빙되지 않습니다"; return ;;
  esac
  ASSET="$(curl -sk --max-time 20 "$U/" | grep -o '/assets/index-[A-Za-z0-9_-]*\.js' | head -1 || true)"
  [ -n "$ASSET" ] || { vng "/assets/index-*.js 를 찾지 못했습니다"; return; }
  outln "  자산: $ASSET"
  if [ -n "${PKG_ASSET:-}" ]; then
    case "$ASSET" in
      */"${PKG_ASSET##*/}") vok "원격 참조 = 패키지 빌드와 일치" ;;
      *) vng "원격 참조가 패키지와 다릅니다(배포 미반영 또는 캐시): $ASSET vs $PKG_ASSET" ;;
    esac
  fi

  # ── 압축 판정보다 **먼저** 자산 응답 자체가 정상인지 단언한다 ─────────────
  # 이것이 없으면 `location /assets/ { try_files $uri =404; }` 가 없는 서버(=이 저장소의
  # gen_prod_conf.py 가 만드는 기본 conf 가 그렇다)에서 assets/ 가 통째로 빠져도
  # /assets/index-XXX.js 가 SPA 폴백(index.html)으로 200 을 주고, 그 HTML 이 gzip/brotli
  # 로 나가므로 gzip·brotli·304 가 전부 ✅ 로 통과한다. 브라우저는 type=module 스크립트에
  # text/html 이 오면 거부하므로 사용자는 전원 흰 화면인데 스크립트는 exit 0 을 준다.
  # 403(소유권·퍼미션 사고)·404 도 같은 이유로 통과했다(에러페이지도 gzip 된다).
  AMETA="$(hmeta -H 'Accept-Encoding: identity' "$U$ASSET")"
  ACODE="${AMETA%% *}"; ACTYPE="${AMETA#* }"
  case "$ACODE" in
    200) ;;
    403) vng "자산 $ASSET = 403 — 파일은 있으나 nginx 가 읽지 못합니다(소유권/퍼미션)"; return ;;
    404) vng "자산 $ASSET = 404 — 자산이 배포되지 않았습니다(index.html 만 올라간 부분 배포)"; return ;;
    *)   vng "자산 $ASSET = ${ACODE:-000} (200 기대)"; return ;;
  esac
  case "$ACTYPE" in
    *javascript*|*ecmascript*) vok "자산 응답 200 / Content-Type=$ACTYPE" ;;
    *)
      vng "자산 자리에 JS 가 아닌 것이 옵니다 (Content-Type=${ACTYPE:-?}) — SPA 폴백입니다(assets 미배포)"
      say "  브라우저는 type=module 스크립트에 text/html 이 오면 실행을 거부합니다 → 전원 흰 화면."
      say "  nginx 에  location /assets/ { try_files \$uri =404; }  를 넣으면 이 상태가 404 로 드러납니다."
      return ;;
  esac

  RAW="$(hdr -H 'Accept-Encoding: identity' "$U$ASSET" | sed -n 's/^[Cc]ontent-[Ll]ength: //p')"
  # 크기 대조 — 폴백 HTML(수 KB)과 실제 번들(수백 KB)은 두 자릿수 차이가 난다.
  # 로컬에 같은 파일이 있으면 바이트 수까지 맞춰 본다(구버전 캐시도 여기서 드러난다).
  LOCAL_ASSET=""
  if   [ -n "${PKG:-}" ]       && [ -f "$PKG/frontend/dist$ASSET" ]; then LOCAL_ASSET="$PKG/frontend/dist$ASSET"
  elif [ -n "${FRONT_DIR:-}" ] && [ -f "$FRONT_DIR$ASSET" ];         then LOCAL_ASSET="$FRONT_DIR$ASSET"
  fi
  if [ -n "$LOCAL_ASSET" ]; then
    LSZ="$(wc -c < "$LOCAL_ASSET" 2>/dev/null | tr -d ' ')"
    if [ -n "${RAW:-}" ] && [ -n "${LSZ:-}" ]; then
      if [ "$RAW" != "$LSZ" ]; then
        vng "자산 크기 불일치: 원격 ${RAW}B / 로컬 ${LSZ}B ($LOCAL_ASSET) — 폴백·구버전 캐시 의심"
      else
        vok "자산 크기 일치 (${RAW}B)"
      fi
    fi
  fi
  GZ="$(hdr  -H 'Accept-Encoding: gzip'     "$U$ASSET")"
  BR="$(hdr  -H 'Accept-Encoding: br'       "$U$ASSET")"
  gzenc="$(printf '%s' "$GZ" | sed -n 's/^[Cc]ontent-[Ee]ncoding: //p')"
  gzlen="$(printf '%s' "$GZ" | sed -n 's/^[Cc]ontent-[Ll]ength: //p')"
  brenc="$(printf '%s' "$BR" | sed -n 's/^[Cc]ontent-[Ee]ncoding: //p')"
  brlen="$(printf '%s' "$BR" | sed -n 's/^[Cc]ontent-[Ll]ength: //p')"
  case "$gzenc" in gzip) vok "gzip 적용됨   ${RAW:-?}B → ${gzlen:-?}B" ;;
                   *)    vng "gzip 미적용   ${RAW:-?}B 를 그대로 전송" ;; esac
  # brotli 는 **성능 항목**이라 배포 성공 여부와 분리해 경고로만 남긴다.
  case "$brenc" in br)   vok "brotli 적용됨 ${RAW:-?}B → ${brlen:-?}B" ;;
                   *)    warn "brotli 미적용 (모듈 미설치 가능 — [6] 출력을 확인하세요)" ;; esac

  # ⚠ 인코딩 변형마다 서빙되는 실체 파일이 다르다(index.js 와 index.js.br 은 별개 파일).
  #   → Last-Modified/ETag 도 다르다. **같은 Accept-Encoding 으로** 되물어야 한다.
  LM="$(printf '%s' "$GZ" | sed -n 's/^[Ll]ast-[Mm]odified: //p')"
  if [ -n "$LM" ]; then
    c="$(hcode -k --max-time 20 -H 'Accept-Encoding: gzip' -H "If-Modified-Since: $LM" "$U$ASSET")"
    [ "$c" = "304" ] && vok "조건부요청 304 동작" || warn "조건부요청 $c (304 미동작)"
  fi

  ec="$(hcode -k --max-time 20 "$U/api/export/manifest")"
  case "$ec" in
    401) vok "원격 /api/export/manifest = 401 (신규 백엔드)" ;;
    404) vng "원격 /api/export/manifest = 404 → 백엔드 구버전" ;;
    *)   vng "원격 /api/export/manifest = $ec" ;;
  esac

  # ── 협진 WebSocket 경로 — REST 가 멀쩡해도 WS 만 따로 죽는 사고가 실제로 났다(sv70) ──
  # 판정 2단: ① REST /api/collab/presence 가 401 이면 백엔드에 협진이 있다.
  #           ② WS 핸드셰이크가 404 면 nginx 가 Upgrade 를 전달하지 않는 것이다
  #              (백엔드는 평범한 GET 을 받아 WS 전용 라우트 미매치 → 404).
  cc="$(hcode -k --max-time 20 "$U/api/collab/presence")"
  ws="$(hcode -k --max-time 20 \
        -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
        -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==' \
        -H 'Sec-WebSocket-Protocol: sv.bearer, probe' "$U/api/collab/ws")"
  case "$cc" in
    401) vok "협진 REST = 401 (백엔드에 협진 있음)" ;;
    404) vng "협진 REST = 404 → 백엔드가 협진 이전 버전입니다" ;;
    *)   warn "협진 REST = $cc (401 기대)" ;;
  esac
  case "$ws" in
    101|403) vok "협진 WS 핸드셰이크 = $ws (nginx 업그레이드 전달 정상)" ;;
    404) vng "협진 WS = 404 → nginx 가 Upgrade 를 전달하지 않습니다 (--apply 가 자동 주입, 또는 deploy/nginx-viewer.conf 의 /api/collab/ws 블록 수동 반영)" ;;
    502|504) vng "협진 WS = $ws → 백엔드가 죽었거나 프록시 대상이 다릅니다" ;;
    *)   warn "협진 WS = ${ws:-000} (101/403 기대)" ;;
  esac
}

# requirements.txt 에 그 패키지가 실제로 들어 있는지(= 이번 배포가 요구하는지) 확인.
req_has() {
  [ -f "$BACKEND_DIR/requirements.txt" ] || return 1
  RH=1
  while IFS= read -r line; do
    case "$line" in ''|'#'*|'-'*) continue ;; esac
    n="$(printf '%s' "$line" | sed 's/[[:space:]]*#.*//; s/\[.*//; s/[<>=!~;].*//; s/[[:space:]]*$//' \
         | tr 'A-Z_' 'a-z-')"
    if [ "$n" = "$1" ]; then RH=0; fi
  done < "$BACKEND_DIR/requirements.txt"
  return "$RH"
}

# [5] 가 '설치 완료' 를 출력했는지와 무관하게, **임포트되는지**를 직접 확인한다.
# 이것이 없으면 pip 이 통째로 실패한 서버에서도 8개 항목이 전부 ✅ 로 나오고
# '갱신 완료 / exit 0' 가 찍힌다(ISO 반출은 501 인 채로).
verify_pydeps() {
  if [ -z "${PYBIN:-}" ] || [ ! -x "${PYBIN:-}" ]; then
    vng "백엔드 파이썬을 특정하지 못해 의존성을 확인할 수 없습니다 (--pybin 으로 지정)"
    return 0
  fi
  # requirements 에 있는 항목 중 '없으면 기능이 죽는' 것을 실제 import 로 확인한다.
  # 패키지명과 모듈명이 다른 경우가 있어 매핑을 명시한다(pkg:module).
  for pair in 'pycdlib:pycdlib' 'qrcode:qrcode'; do
    pkg="${pair%%:*}"; mod="${pair##*:}"
    if ! req_has "$pkg"; then continue; fi
    if "$PYBIN" -c "import $mod" >/dev/null 2>&1; then
      vok "의존성 import 확인: $mod ($PYBIN)"
    else
      case "$pkg" in
        pycdlib) vng "pycdlib 미설치 — ISO 반출이 501 로 응답합니다 ($PYBIN)" ;;
        *)       vng "$pkg 미설치 — 관련 기능이 501/500 로 응답합니다 ($PYBIN)" ;;
      esac
    fi
  done
  if [ "$PYDEPS_FAIL" != "0" ]; then
    vng "[5] 파이썬 의존성 단계가 정상 완료되지 않았습니다 — 위 [5] 출력의 수동 절차를 따르세요"
  fi
}

# curl 부재로 HTTP 검증을 건너뛴 사실을 최종 배너까지 전파한다(조용한 성공 금지).
VERIFY_SKIPPED=0

do_verify() {
  step "검증"
  verify_pydeps
  # ── DB 상태는 **보고하되 판정하지 않는다** ────────────────────────────────
  # '미적용 마이그레이션 존재' 만으로 exit 1 을 주면 안 된다: 이번 갱신이 migrations/ 를
  # 바꾸지 않는 경우 그 미적용분은 배포와 무관한 사실이고, 실패로 찍으면 순수한 오탐이다.
  # 경고와 안내로 남긴다(진단은 무료여야 하고, 무료라는 말은 배포를 막지 않는다는 뜻이다).
  case "$DB_VERDICT" in
    latest)
      # 침묵하지 않는다. 예전에는 이 갈래가 아예 없어서, [2] 가 구 트리 head 로 오판한
      # 'latest' 가 [8] 에서 한 줄도 언급되지 않은 채 '✅ 갱신 완료' 로 덮였다.
      # 무엇과 비교해 '최신' 이라고 말하는지를 항상 근거와 함께 남긴다.
      say "DB: 미적용 마이그레이션 없음 (DB=$DB_CURRENT = $DB_HEAD_SRC head $DB_HEAD)"
      if [ "$MIGRATE_DONE" = "1" ]; then say "  → 이번 실행에서 --migrate 로 적용한 결과입니다."; fi ;;
    behind)
      warn "DB: 미적용 마이그레이션 ${DB_PENDING_N}건 (DB=$DB_CURRENT → $DB_HEAD_SRC head=$DB_HEAD)"
      if [ "$MIGRATE_DONE" = "1" ]; then
        say "  → 이번 실행에서 --migrate 로 적용했습니다(위 블록 참조)."
      else
        say "  → 이번 갱신은 이것을 자동으로 적용하지 않았습니다(기본 동작). 배포 실패가 아닙니다."
        if [ "$MIG_VERDICT" = "same" ]; then
          say "     이번 패키지는 migrations/ 를 바꾸지 않으므로 이 미적용분은 이번 갱신 때문이 아닙니다."
        fi
        say "     적용하려면(위험을 읽은 뒤):  --migrate  (SV_DB_BACKUP_DONE=1 필요)"
      fi ;;
    unstamped)
      warn "DB: alembic_version 이 없는 미스탬프 스키마입니다(init_db() 가 만든 DB)"
      say  "  → 정상 동작입니다. 다만 alembic 으로 스키마를 관리하려면 사람이 stamp 를 찍어야 합니다." ;;
    unknown-rev)
      warn "DB: 리비전 $DB_CURRENT 이 패키지 migrations/ 에 없습니다(롤백 잔재 또는 다른 계보)" ;;
    multihead)
      warn "DB: 패키지의 마이그레이션 head 가 여러 개입니다 — 사람이 머지해야 합니다" ;;
    undetermined)
      warn "DB: 상태를 판정하지 못했습니다(${DB_NOTE:-사유 불명}) — '이상 없음' 이 아니라 '모름' 입니다" ;;
  esac
  # ⚠ 디스크 검증은 curl 이 전혀 필요 없다(grep · [ -f ] 뿐). 그러므로 curl 게이트
  #   **앞**에 둔다. 예전에는 curl 게이트 하나가 이것까지 함께 건너뛰어,
  #   '배포된 index.html 이 패키지와 다름' · '참조 자산 없음' · '.gz/.br 누락' 이라는
  #   확정적 실패를 한 건도 잡지 못한 채 V_FAIL=0 으로 '✅ 갱신 완료 / exit 0' 이 나갔다.
  verify_frontend_disk
  if ! curl_ok; then
    VERIFY_SKIPPED=1
    warn "curl 이 없어 HTTP 검증(백엔드 health·openapi·원격 진단)을 건너뜁니다"
    say  "  → 이 실행은 '검증 미완료' 로 판정합니다(exit 2). 아래를 직접 확인하세요:"
    say  "     wget -qO- http://127.0.0.1:$PORT/api/health   또는 브라우저로 접속"
    return 0
  fi
  verify_backend_local
  if [ -n "$URL" ]; then echo; do_check; fi
}

# ═══════════════════════════════════════════════════════════════════════════
# 롤백
# ═══════════════════════════════════════════════════════════════════════════
list_backups() {   # 최신 → 오래된 순
  ls -1 "$BACKUP_ROOT" 2>/dev/null | grep -E '^[0-9]{14}$' | LC_ALL=C sort -r
}

# manifest 에서 읽은 설치 경로를 **쓰기 전에** 검증한다.
# mval 은 키가 없거나(손편집·옛 manifest) 값 뒤에 공백/탭이 하나만 있어도 조용히 빈
# 문자열을 돌려준다. 빈 값을 그대로 쓰면 이 아래 모든 경로가 '/' 로 뭉개져,
# root 권한으로 `cp -a <백업>/frontend-dist/. /` (dist 를 파일시스템 루트에 쏟음),
# `mv /app /app.pre-rollback.<TS>`, `rm -rf /.app.rollback.<pid>` 를 실행하게 된다.
# $1=라벨(어느 백업인지) — 실패하면 die 로 멈춘다.
validate_install_paths() {
  VP_WHO="${1:-manifest}"
  [ -n "$FRONT_DIR" ]   || die "$VP_WHO 에서 FRONT_DIR 을 읽지 못했습니다(키 없음·값 뒤 공백 등)"
  [ -n "$BACKEND_DIR" ] || die "$VP_WHO 에서 BACKEND_DIR 을 읽지 못했습니다(키 없음·값 뒤 공백 등)"
  case "$FRONT_DIR"   in /?*) ;; *) die "$VP_WHO 의 FRONT_DIR 이 절대경로가 아닙니다: '$FRONT_DIR'" ;; esac
  case "$BACKEND_DIR" in /?*) ;; *) die "$VP_WHO 의 BACKEND_DIR 이 절대경로가 아닙니다: '$BACKEND_DIR'" ;; esac
  if unsafe_target "$FRONT_DIR";   then die "$VP_WHO 의 FRONT_DIR 이 시스템 최상위입니다 — 중단합니다: '$FRONT_DIR'"; fi
  if unsafe_target "$BACKEND_DIR"; then die "$VP_WHO 의 BACKEND_DIR 이 시스템 최상위입니다 — 중단합니다: '$BACKEND_DIR'"; fi
  [ -d "$FRONT_DIR" ]   || die "$VP_WHO 의 FRONT_DIR 이 존재하지 않습니다: $FRONT_DIR"
  [ -d "$BACKEND_DIR" ] || die "$VP_WHO 의 BACKEND_DIR 이 존재하지 않습니다: $BACKEND_DIR"
  [ -f "$FRONT_DIR/index.html" ] \
    || die "$VP_WHO 의 FRONT_DIR 이 dist 처럼 보이지 않습니다(index.html 없음): $FRONT_DIR
     (manifest.env 의 FRONT_DIR 을 바로잡거나 다른 백업을 고르세요)"
  # app/ 이 통째로 없을 수도 있다(과거 사고 복구). 그 경우에도 되돌릴 수 있어야 하므로
  # 백엔드 트리 판정은 세 근거 중 하나로 하고, app/ 부재는 경고로만 알린다.
  if [ ! -f "$BACKEND_DIR/app/main.py" ] && [ ! -f "$BACKEND_DIR/requirements.txt" ] \
     && [ ! -f "$BACKEND_DIR/alembic.ini" ]; then
    die "$VP_WHO 의 BACKEND_DIR 이 백엔드 트리처럼 보이지 않습니다: $BACKEND_DIR
     (app/main.py · requirements.txt · alembic.ini 가 모두 없습니다)"
  fi
  if [ ! -d "$BACKEND_DIR/app" ]; then
    warn "$BACKEND_DIR/app 이 없습니다 — 백업에서 통째로 복구합니다"
  fi
}

do_rollback() {
  outln "== 되돌리기 =="
  # ⚠⚠ **이 함수 안에서는 errexit(set -e)이 꺼져 있다.**
  #   호출부가 `RBRC=0; do_rollback || RBRC=$?` 인데, POSIX 는 `||` 왼쪽 명령에서
  #   errexit 를 무시하도록 규정하고 그 억제가 **함수 본문 전체로 전파된다**
  #   (dash·bash 모두 확인). 아래 어떤 cp/mv 가 실패해도 스크립트는 멈추지 않는다.
  #   → 파괴적인 mv/rm 앞에는 반드시 `|| die` 로 **복사 성공을 손으로 확인**한다.
  #     이 규약을 어기면(예: 백업 복사 실패를 무시한 채 살아 있는 app/ 을 치우면)
  #     backend/app 이 사라져 다음 재시작·리부트에서 ModuleNotFoundError 로 기동
  #     불능이 된다 — 뒤늦은 지문 검증은 '탐지' 일 뿐 방어가 아니다.
  [ "$(id -u)" = "0" ] || die "root 권한이 필요합니다"
  [ -d "$BACKUP_ROOT" ] || die "백업 디렉터리가 없습니다: $BACKUP_ROOT"

  CANDS="$(list_backups)"
  [ -n "$CANDS" ] || die "백업이 하나도 없습니다: $BACKUP_ROOT"

  # 후보 선별용 기준 경로는 가장 최신 백업에서 읽는다(대개 모든 백업이 같은 경로다).
  # ※ '어느 백업에서 읽어도 같다' 고 가정하지 않는다 — --prefix 를 바꿔 재설치한
  #   서버에서는 다르다. 선택된 백업의 경로가 다르면 아래에서 지문을 다시 계산한다.
  NEWEST="$(printf '%s\n' "$CANDS" | head -1)"
  [ -f "$BACKUP_ROOT/$NEWEST/manifest.env" ] || die "백업이 손상됐습니다(manifest.env 없음): $BACKUP_ROOT/$NEWEST"
  FRONT_DIR="$(mval "$BACKUP_ROOT/$NEWEST/manifest.env" FRONT_DIR)"
  BACKEND_DIR="$(mval "$BACKUP_ROOT/$NEWEST/manifest.env" BACKEND_DIR)"
  validate_install_paths "최신 백업 $NEWEST 의 manifest.env"
  NEWEST_FRONT="$FRONT_DIR"; NEWEST_BACKEND="$BACKEND_DIR"

  # 지금 서버에 올라가 있는 것의 지문.
  NOW_ASSET="$(asset_of "$FRONT_DIR")"
  NOW_APP="$(tree_hash "$BACKEND_DIR/app")"
  NOW_EXTRA="$(extra_hash "$BACKEND_DIR")"
  outln "  현재 배포: asset=${NOW_ASSET:-?} app=${NOW_APP} extra=${NOW_EXTRA}"

  # 백업의 부수 트리(BK_DIRS·BK_FILES)가 현재와 다른가.
  # app/ 만 보면 'app/ 은 같은데 migrations/ 만 신버전' 인 트리를 '되돌릴 것 없음' 으로
  # 오판한다 — 그 상태가 바로 이 스크립트가 만들어 낸 혼합 트리다.
  # 0=다름(되돌릴 것 있음) 1=같음 2=판정 불가(옛 포맷 백업이라 근거가 없음)
  extra_differs() {  # $1 = manifest.env
    XB="$(mval "$1" FP_EXTRA)"
    [ "$(mval "$1" BK_FORMAT)" = "2" ] && [ -n "$XB" ] || return 2
    case "$XB$NOW_EXTRA" in *nohasher*) return 2 ;; esac
    [ "$XB" != "$NOW_EXTRA" ] && return 0 || return 1
  }

  if [ -z "$STAMP" ]; then
    # ⚠ '현재와 지문이 다른 가장 최근 백업' 만으로는 부족하다: --apply 를 두 번 하면
    #   두 번째 백업의 내용물은 이미 신버전이라, 구버전으로 되돌린 뒤 한 번 더
    #   --rollback 하면 그 신버전 스냅샷이 뽑혀 **장애 원인인 신버전을 다시 배포**하고도
    #   '✅ 파일 복구 완료 / exit 0' 을 찍는다(앞으로 가는 롤백).
    #   → FP_* == FP_*_AFTER 인 백업(= 아무것도 바꾸지 않은 적용의 스냅샷)은
    #     자동 선택에서 제외한다. 장애 중에 추측으로 앞으로 가지 않는다.
    outln "  후보(최신순):"
    for s in $CANDS; do
      m="$BACKUP_ROOT/$s/manifest.env"
      [ -f "$m" ] || continue
      a="$(mval "$m" FP_ASSET)";        h="$(mval "$m" FP_APP)"
      aa="$(mval "$m" FP_ASSET_AFTER)"; ha="$(mval "$m" FP_APP_AFTER)"
      x="$(mval "$m" FP_EXTRA)";        xa="$(mval "$m" FP_EXTRA_AFTER)"
      RS=0; fp_same "$a" "$h" "$NOW_ASSET" "$NOW_APP" || RS=$?
      XD=2; extra_differs "$m" || XD=$?
      # app/·프론트가 같아도 부수 트리가 다르면 되돌릴 것이 남아 있다.
      if [ "$RS" = "0" ] && [ "$XD" = "0" ]; then RS=1; XONLY=1; else XONLY=0; fi
      NOOP=0
      if [ -n "$ha" ]; then
        NR=0; fp_same "$a" "$h" "$aa" "$ha" || NR=$?
        # 부수 트리가 바뀐 적용은 no-op 이 아니다(app/ 이 그대로여도 migrations 가 갈렸다).
        if [ -n "$xa" ] && [ "$x" != "$xa" ]; then NR=1; fi
        if [ "$NR" = "0" ]; then NOOP=1; fi
      fi
      case "$RS" in
        0) mark="= 현재와 동일(되돌릴 것 없음)" ;;
        2) mark="? 지문 비교 불가" ;;
        *) if [ "$NOOP" = "1" ]; then
             mark="↑ 신버전 스냅샷(아무것도 바꾸지 않은 적용) — 자동 선택 제외"
           elif [ "$XONLY" = "1" ]; then
             mark="→ 되돌릴 수 있음 (app/·프론트는 동일, 부수 트리만 다름)"
           elif [ "$(mval "$m" BK_FORMAT)" != "2" ]; then
             mark="→ 되돌릴 수 있음 (옛 포맷 백업: app/·dist·requirements.txt 만 담김)"
           elif [ -z "$ha" ]; then
             mark="→ 되돌릴 수 있음 (적용 후 지문 없음)"
           else
             mark="→ 되돌릴 수 있음"
           fi ;;
      esac
      outln "    $s  asset=${a:-?}  $mark"
      if [ -z "$STAMP" ] && [ "$RS" != "0" ] && [ "$NOOP" != "1" ]; then STAMP="$s"; fi
    done
    [ -n "$STAMP" ] || die "되돌릴 수 있는 백업이 없습니다.
     (현재 배포와 지문이 같거나, 남은 것이 '신버전 스냅샷' 뿐입니다 — 그것으로 되돌리면
      장애 원인인 신버전을 다시 배포하게 되므로 자동으로 고르지 않습니다.
      정말 그렇게 하려면:  SV_ROLLBACK_FORCE=1 sh $(basename "$0") --rollback <타임스탬프>)"
    outln "  선택: $STAMP  (명시하려면: --rollback <타임스탬프>)"
  fi

  BDIR="$BACKUP_ROOT/$STAMP"
  [ -d "$BDIR" ] || die "그런 백업이 없습니다: $BDIR"
  [ -f "$BDIR/manifest.env" ] || die "백업이 손상됐습니다(manifest.env 없음): $BDIR"
  FRONT_DIR="$(mval "$BDIR/manifest.env" FRONT_DIR)"
  BACKEND_DIR="$(mval "$BDIR/manifest.env" BACKEND_DIR)"
  # ⚠ **실제 복구 대상 백업**의 경로에도 최신 백업과 똑같은 검사를 건다.
  #   예전에는 이 두 줄이 검사 없이 덮어써서, 값이 비면 모든 경로가 '/' 로 뭉개졌다.
  validate_install_paths "백업 $STAMP 의 manifest.env"
  # 백업 내용물도 **파괴적 조작 전에** 확인한다. (errexit 이 꺼져 있으므로 cp 실패는
  #  스스로 멈추지 않는다 — 없는 것을 복사하려다 실패한 뒤 살아 있는 app/ 을 치운다)
  [ -d "$BDIR/frontend-dist" ] || die "백업에 frontend-dist 가 없습니다: $BDIR (이 백업으로는 되돌릴 수 없습니다)"
  [ -d "$BDIR/backend-app" ]   || die "백업에 backend-app 이 없습니다: $BDIR (이 백업으로는 되돌릴 수 없습니다)"
  [ -f "$BDIR/backend-app/main.py" ] || die "백업의 backend-app 이 백엔드 트리처럼 보이지 않습니다(main.py 없음): $BDIR/backend-app"
  [ -f "$BDIR/frontend-dist/index.html" ] || die "백업의 frontend-dist 가 dist 처럼 보이지 않습니다(index.html 없음): $BDIR/frontend-dist"

  # 선택된 백업의 설치 경로가 후보 선별에 쓴 경로와 다르면(--prefix 를 바꿔 재설치한
  # 서버), 지금까지의 '현재 배포 지문' 은 엉뚱한 트리를 본 값이다 → 다시 계산한다.
  if [ "$FRONT_DIR" != "$NEWEST_FRONT" ] || [ "$BACKEND_DIR" != "$NEWEST_BACKEND" ]; then
    warn "백업 $STAMP 의 설치 경로가 최신 백업과 다릅니다 — 지문을 이 경로 기준으로 다시 계산합니다"
    say  "  프론트: $NEWEST_FRONT → $FRONT_DIR"
    say  "  백엔드: $NEWEST_BACKEND → $BACKEND_DIR"
    NOW_ASSET="$(asset_of "$FRONT_DIR")"
    NOW_APP="$(tree_hash "$BACKEND_DIR/app")"
    NOW_EXTRA="$(extra_hash "$BACKEND_DIR")"
    outln "  현재 배포(재계산): asset=${NOW_ASSET:-?} app=${NOW_APP} extra=${NOW_EXTRA}"
  fi

  BK_ASSET="$(mval "$BDIR/manifest.env" FP_ASSET)"
  BK_APP="$(mval "$BDIR/manifest.env" FP_APP)"
  BK_EXTRA="$(mval "$BDIR/manifest.env" FP_EXTRA)"
  BK_FMT="$(mval "$BDIR/manifest.env" BK_FORMAT)"
  R_FOWN="$(mval "$BDIR/manifest.env" FOWN)"
  R_BOWN="$(mval "$BDIR/manifest.env" BOWN)"

  # 이 백업이 부수 트리(migrations/ tools/ alembic.ini .env.example)를 담고 있는가.
  # 옛 포맷(BK_FORMAT 없음)은 담고 있지 않다 → 그 사실을 **끝까지 숨기지 않는다**.
  EXTRA_CAP=0
  if [ "$BK_FMT" = "2" ]; then EXTRA_CAP=1; fi

  # 사용자가 타임스탬프를 직접 준 경우에도 같은 검사를 한다 — '복구 완료' 만 찍히고
  # 실제로는 아무것도 바뀌지 않는 거짓 성공을 만들지 않는다.
  RS=0; fp_same "$BK_ASSET" "$BK_APP" "$NOW_ASSET" "$NOW_APP" || RS=$?
  XD=2; extra_differs "$BDIR/manifest.env" || XD=$?
  if [ "$RS" = "0" ] && [ "$XD" = "0" ]; then
    say "app/ · 프론트는 이미 백업과 같습니다 — 부수 트리($BK_DIRS $BK_FILES)만 되돌립니다"
    RS=1
  fi
  if [ "$RS" = "0" ]; then
    outln "  백업 지문: asset=${BK_ASSET:-?} app=${BK_APP} extra=${BK_EXTRA:-없음}"
    die "되돌릴 것이 없습니다 — 백업 $STAMP 은 지금 배포된 것과 같은 버전입니다.
     (다른 백업을 고르세요:  ls $BACKUP_ROOT)"
  fi
  if [ "$RS" = "2" ]; then
    warn "지문을 비교할 수 없어(해시 도구 없음) 확인 없이 진행합니다"
  fi

  # 사람이 타임스탬프를 직접 준 경우에도 '앞으로 가는 롤백' 은 막는다.
  # (FP_* == FP_*_AFTER = 아무것도 바꾸지 않은 적용의 스냅샷 = 신버전 그 자체)
  BK_ASSET_AFTER="$(mval "$BDIR/manifest.env" FP_ASSET_AFTER)"
  BK_APP_AFTER="$(mval "$BDIR/manifest.env" FP_APP_AFTER)"
  BK_EXTRA_AFTER="$(mval "$BDIR/manifest.env" FP_EXTRA_AFTER)"
  if [ -n "$BK_APP_AFTER" ] && [ "${SV_ROLLBACK_FORCE:-0}" != "1" ]; then
    NR=0; fp_same "$BK_ASSET" "$BK_APP" "$BK_ASSET_AFTER" "$BK_APP_AFTER" || NR=$?
    # 부수 트리가 바뀐 적용은 no-op 이 아니다 — 되돌릴 것이 실제로 있다.
    if [ -n "$BK_EXTRA_AFTER" ] && [ "$BK_EXTRA" != "$BK_EXTRA_AFTER" ]; then NR=1; fi
    if [ "$NR" = "0" ]; then
      die "백업 $STAMP 은 '아무것도 바꾸지 않은 적용' 의 스냅샷입니다(= 패키지와 같은 신버전).
     이것으로 되돌리면 장애 원인인 신버전을 그대로 다시 배포하게 됩니다.
     되돌릴 수 있는 후보 목록:  sh $(basename "$0") --rollback   (인자 없이)
     그래도 강행하려면:  SV_ROLLBACK_FORCE=1 sh $(basename "$0") --rollback $STAMP"
    fi
  fi

  outln "  복구 대상: $STAMP  (asset=${BK_ASSET:-?})"
  outln "    프론트 → $FRONT_DIR"
  if [ "$EXTRA_CAP" = "1" ]; then
    outln "    백엔드 → $BACKEND_DIR/{app, $(echo $BK_FILES $BK_DIRS | tr ' ' ',')}"
  else
    outln "    백엔드 → $BACKEND_DIR/app  (+ requirements.txt)"
    warn "이 백업은 옛 포맷(BK_FORMAT 없음)이라 부수 트리를 담고 있지 않습니다"
    say "  → $BK_DIRS · alembic.ini · .env.example 은 **신버전 그대로 남습니다**"
    say "     롤백 후 'alembic upgrade head' 를 돌리면 구 코드 위에 신 스키마가 적용됩니다."
  fi

  # ── 프론트: 덮어쓰기로 충분하다 ──────────────────────────────────────────
  # 구 파일을 되돌려 놓기만 하면 index.html 이 옛 자산을 가리키게 되고, 새 자산은
  # 남아 있어도 무해하다(콘텐츠 해시 파일명). 지우면 열려 있는 탭이 지연로드 청크를
  # 요청하다 화면이 죽는다.
  # (errexit 이 꺼져 있으므로 실패를 여기서 직접 잡는다 — 프론트가 안 되돌아간 채
  #  백엔드만 되돌리면 '프론트 신버전 + 백엔드 구버전' 혼합 상태가 된다)
  cp -a "$BDIR/frontend-dist/." "$FRONT_DIR/" \
    || die "프론트 복구 실패(복사 오류) — 백엔드는 건드리지 않고 중단합니다: $BDIR/frontend-dist → $FRONT_DIR"

  # ── 백엔드 app/: **정확 교체** ───────────────────────────────────────────
  # 과거에는 여기서도 `cp -a "$BDIR/backend-app/." "$BACKEND_DIR/app/"` 로 덮어쓰기만
  # 했다(additive). 신버전이 **추가**한 모듈은 그대로 남으므로 트리가 '구+신 혼합' 이
  # 되고, 두 가지 실패가 100% 재현된다:
  #   ① 아래 지문 검증은 트리 전체 해시를 백업과 일치시키라고 요구하는데 잔재 때문에
  #      절대 일치할 수 없다 → 파일은 실제로 되돌아갔는데도 매번 '❌ 복구 후 지문이
  #      백업과 다릅니다' + exit 1. 장애 중인 운영자가 '롤백 실패' 로 오판한다.
  #   ② 그 혼합 지문은 어느 백업과도 같지 않으므로, 다시 --rollback 하면 후보 선택이
  #      '신버전 스냅샷' 을 집어 장애 원인인 신버전을 재배포하고 ✅/exit 0 을 찍는다.
  # → 증상(검증 문구)을 무르게 하는 대신 **원인(혼합 상태)** 을 없앤다.
  #   '삭제하지 않는다' 는 정책은 지우는 대신 **옆으로 치워 두는 것**으로 지킨다.
  # ⚠ 아래 mv 두 줄은 되돌릴 수 없다. errexit 이 꺼져 있으므로(함수 첫머리 주석)
  #   **복사가 실제로 성공했는지 손으로 확인한 뒤에만** 살아 있는 app/ 을 치운다.
  #   확인 없이 진행하면(과거 동작) 백업의 backend-app 이 없거나 /var 가 가득 차
  #   cp 가 죽은 경우, app/ 을 옆으로 옮겨 놓고 넣을 것이 없어 **app/ 자체가
  #   사라진다**(다음 재시작·리부트에서 ModuleNotFoundError → 서비스 완전 중단).
  TMPAPP="$BACKEND_DIR/.app.rollback.$$"
  rm -rf "$TMPAPP"
  cp -a "$BDIR/backend-app" "$TMPAPP" \
    || { rm -rf "$TMPAPP"
         die "백업 복사 실패 — 살아 있는 app/ 은 건드리지 않고 중단합니다: $BDIR/backend-app → $TMPAPP"; }
  [ -d "$TMPAPP" ] || die "복사본이 만들어지지 않았습니다 — app/ 은 그대로 둡니다: $TMPAPP"
  # ENOSPC 등으로 '중간까지만' 복사된 트리를 설치하면 잘린 app/ 이 올라간다.
  [ -f "$TMPAPP/main.py" ] \
    || { rm -rf "$TMPAPP"
         die "복사본이 백엔드 트리처럼 보이지 않습니다(main.py 없음) — app/ 은 그대로 둡니다: $TMPAPP"; }
  find "$TMPAPP" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
  chown_back "$TMPAPP" "$R_BOWN"
  PREV_APP="$BACKEND_DIR/app.pre-rollback.$TS"
  rm -rf "$PREV_APP"
  # 같은 파일시스템 안이라 mv 는 rename(2) — 교체 순간에 app/ 이 사라지는 창이 없다.
  # (이 논거는 **넣을 원본이 실제로 존재할 때만** 성립한다 → 위 검사가 그 전제다)
  if [ -d "$BACKEND_DIR/app" ]; then
    mv "$BACKEND_DIR/app" "$PREV_APP" \
      || { rm -rf "$TMPAPP"; die "이전 app/ 을 옮기지 못했습니다 — app/ 은 그대로입니다: $BACKEND_DIR/app"; }
    say "이전 app/ 은 지우지 않고 옮겨 뒀습니다: $PREV_APP"
  fi
  if ! mv "$TMPAPP" "$BACKEND_DIR/app"; then
    # 여기서 실패하면 app/ 이 없는 상태다 → 즉시 원상복구해 서비스 중단을 막는다.
    if [ -d "$PREV_APP" ] && [ ! -d "$BACKEND_DIR/app" ]; then
      mv "$PREV_APP" "$BACKEND_DIR/app" 2>/dev/null || true
    fi
    die "app/ 교체 실패 — 원래 app/ 을 되돌려 놓았습니다: $BACKEND_DIR/app"
  fi

  find "$BACKEND_DIR/app" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true

  # ── 백엔드 부수 트리: app/ 과 **같은 방식**으로 정확 교체 ──────────────────
  # [4] 가 덮어쓴 것을 [3] 이 백업했으므로 여기서 전부 되돌릴 수 있다.
  # 세 가지 경우를 구분한다(이 구분이 없으면 혼합 트리가 남는다):
  #   ① 백업에 있음        → 정확 교체(기존 것은 지우지 않고 옆으로 치운다)
  #   ② 백업에 없음 + ABSENT_* → 백업 당시 **원래 없던** 경로다. 신버전이 새로 떨군
  #      산출물이므로 옆으로 치운다(치우지 않으면 v50 migrations 가 v48 위에 남는다).
  #   ③ 백업에 없음 + 마커도 없음 → 옛 포맷 백업. 근거가 없으므로 **건드리지 않고**
  #      사실대로 보고한다(추측으로 지우지 않는다).
  MOVED=""; EXTRA_LEFT=""
  for d in $BK_DIRS; do
    if [ -d "$BDIR/$d" ]; then
      # app/ 과 **같은 규약**: 복사 성공을 확인하기 전에는 기존 트리를 치우지 않는다.
      TMPX="$BACKEND_DIR/.$d.rollback.$$"
      rm -rf "$TMPX"
      cp -a "$BDIR/$d" "$TMPX" \
        || { rm -rf "$TMPX"; die "백업 복사 실패 — $d 는 건드리지 않고 중단합니다: $BDIR/$d → $TMPX"; }
      [ -d "$TMPX" ] || die "복사본이 만들어지지 않았습니다 — $d 는 그대로 둡니다: $TMPX"
      find "$TMPX" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
      chown_back "$TMPX" "$R_BOWN"
      if [ -d "$BACKEND_DIR/$d" ]; then
        rm -rf "$BACKEND_DIR/$d.pre-rollback.$TS"
        mv "$BACKEND_DIR/$d" "$BACKEND_DIR/$d.pre-rollback.$TS" \
          || { rm -rf "$TMPX"; die "$d 를 옮기지 못했습니다 — $d 는 그대로입니다: $BACKEND_DIR/$d"; }
        MOVED="$MOVED $BACKEND_DIR/$d.pre-rollback.$TS"
      fi
      if ! mv "$TMPX" "$BACKEND_DIR/$d"; then
        if [ -d "$BACKEND_DIR/$d.pre-rollback.$TS" ] && [ ! -e "$BACKEND_DIR/$d" ]; then
          mv "$BACKEND_DIR/$d.pre-rollback.$TS" "$BACKEND_DIR/$d" 2>/dev/null || true
        fi
        die "$d 교체 실패 — 원래 트리를 되돌려 놓았습니다: $BACKEND_DIR/$d"
      fi
    elif [ "$(mval "$BDIR/manifest.env" "ABSENT_$(mkey "$d")")" = "1" ]; then
      if [ -d "$BACKEND_DIR/$d" ]; then
        rm -rf "$BACKEND_DIR/$d.pre-rollback.$TS"
        mv "$BACKEND_DIR/$d" "$BACKEND_DIR/$d.pre-rollback.$TS"
        MOVED="$MOVED $BACKEND_DIR/$d.pre-rollback.$TS"
        say "백업 당시 없던 트리라 치워 뒀습니다: $d → $d.pre-rollback.$TS"
      fi
    elif [ -e "$BACKEND_DIR/$d" ]; then
      EXTRA_LEFT="$EXTRA_LEFT $d"
    fi
  done
  for p in $BK_FILES; do
    if [ -f "$BDIR/$p" ]; then
      cp -a "$BDIR/$p" "$BACKEND_DIR/$p" || die "백업 복사 실패 — 중단합니다: $BDIR/$p → $BACKEND_DIR/$p"
      chown_back "$BACKEND_DIR/$p" "$R_BOWN"
    elif [ "$(mval "$BDIR/manifest.env" "ABSENT_$(mkey "$p")")" = "1" ]; then
      if [ -f "$BACKEND_DIR/$p" ]; then
        rm -f "$BACKEND_DIR/$p.pre-rollback.$TS"
        mv "$BACKEND_DIR/$p" "$BACKEND_DIR/$p.pre-rollback.$TS"
        MOVED="$MOVED $BACKEND_DIR/$p.pre-rollback.$TS"
        say "백업 당시 없던 파일이라 치워 뒀습니다: $p → $p.pre-rollback.$TS"
      fi
    elif [ -e "$BACKEND_DIR/$p" ]; then
      EXTRA_LEFT="$EXTRA_LEFT $p"
    fi
  done

  # 백업본은 root 소유로 만들어졌을 수 있다(cp -a) → 적용 때와 같은 소유권 원복이 필요하다.
  chown_back "$FRONT_DIR" "$R_FOWN"
  chown_back "$BACKEND_DIR/app" "$R_BOWN"

  # 되돌아갔는지 지문으로 확인한다(복사가 조용히 실패하는 경우가 있다).
  # 검증 범위는 **복구 범위와 같아야** 한다. 예전에는 app/*.py 와 index.html 자산만 봤기
  # 때문에, migrations/·tools/·alembic.ini 가 신버전 그대로 남아 있어도 '지문 확인' 을
  # 통과하고 exit 0 을 찍었다 — 거짓 안심의 직접적 원인이었다.
  AF_ASSET="$(asset_of "$FRONT_DIR")"
  AF_APP="$(tree_hash "$BACKEND_DIR/app")"
  AF_EXTRA="$(extra_hash "$BACKEND_DIR")"
  RS2=0; fp_same "$AF_ASSET" "$AF_APP" "$BK_ASSET" "$BK_APP" || RS2=$?
  if [ "$RS2" = "1" ]; then
    outln "  ❌ 복구 후 지문이 백업과 다릅니다: 현재 asset=${AF_ASSET:-?} app=${AF_APP}"
    outln "     기대: asset=${BK_ASSET:-?} app=${BK_APP}"
    outln "     app/ 은 정확 교체되므로 이 값이 어긋나면 복사가 실제로 실패한 것입니다"
    outln "     (직전 app/ 은 여기 있습니다: ${PREV_APP:-없음})"
    exit 1
  fi
  if [ "$EXTRA_CAP" = "1" ] && [ -n "$BK_EXTRA" ]; then
    case "$BK_EXTRA$AF_EXTRA" in
      *nohasher*) warn "해시 도구가 없어 부수 트리 복구를 검증하지 못했습니다" ;;
      *) if [ "$AF_EXTRA" != "$BK_EXTRA" ]; then
           outln "  ❌ 부수 트리($BK_DIRS $BK_FILES)가 백업 상태로 돌아가지 않았습니다"
           outln "     현재 extra=$AF_EXTRA / 기대 extra=$BK_EXTRA"
           outln "     → 백엔드 트리가 '구버전 app/ + 신버전 부수 트리' 혼합 상태일 수 있습니다."
           outln "        alembic upgrade head 를 돌리지 마세요(구 코드 위에 신 스키마가 적용됩니다)."
           exit 1
         fi ;;
    esac
  fi

  # 완료 문구는 **실제로 복구한 범위**만 말한다. 종료코드도 마찬가지다:
  # 부분 복구에 0 을 주면 감싸는 스크립트·운영자가 '완전히 되돌아갔다' 로 읽는다.
  RB_RC=0
  if [ "$EXTRA_CAP" = "1" ] && [ -z "$EXTRA_LEFT" ]; then
    outln "  ✅ 파일 복구 완료 — frontend dist · app/ · $BK_FILES · $BK_DIRS"
    outln "     (지문 확인: asset=${AF_ASSET:-?} app=${AF_APP} extra=${AF_EXTRA})"
  else
    RB_RC=2
    outln "  ℹ 부분 복구 — frontend dist · app/ 은 되돌렸습니다 (지문 확인: asset=${AF_ASSET:-?})"
    if [ "$EXTRA_CAP" != "1" ]; then
      outln "     ⚠ 이 백업은 옛 포맷이라 부수 트리를 담고 있지 않습니다."
      outln "        $BK_DIRS · alembic.ini · .env.example 은 **신버전 그대로입니다**."
    else
      outln "     ⚠ 근거가 없어 손대지 않은 경로:$EXTRA_LEFT (신버전 그대로입니다)"
    fi
    outln "     → 지금 'alembic upgrade head' 를 돌리면 구 코드 위에 신 스키마 리비전이 적용됩니다."
    outln "        마이그레이션까지 되돌리려면 패키지 이전 소스에서 migrations/ 를 직접 복원하세요."
  fi
  echo
  outln "  ⚠ 백엔드를 반드시 재시작하세요(코드만 되돌아갔을 뿐 프로세스는 구 코드를 메모리에 들고 있습니다)"
  outln "     systemctl restart <유닛>   또는   [7] 단계의 수동 절차"
  outln "  · 롤백 직전 app/ 은 지우지 않고 남겨 뒀습니다: ${PREV_APP:-없음}"
  if [ -n "$MOVED" ]; then
    outln "  · 함께 치워 둔 신버전 산출물:$MOVED"
  fi
  outln "     (확인이 끝나면 지우세요:  rm -rf ${PREV_APP:-<경로>}$MOVED)"
  outln "  · 의존성까지 되돌리려면:  $BDIR/pip-freeze.txt 참고 (보통은 pip uninstall pycdlib 한 줄)"
  # 불변식의 유일한 예외를 여기서도 못 박는다. '롤백하면 다 돌아간다' 는 오해가
  # 가장 비싸게 끝나는 곳이 DB 다.
  outln "  · ⚠ **DB 는 되돌리지 않습니다**(이 스크립트는 DB 를 백업하지도 복구하지도 않습니다)."
  outln "       --migrate 로 적용한 마이그레이션이 있었다면 그 스키마는 그대로 남아 있습니다."
  outln "       되돌리려면 적용 전 DB 백업에서 사람이 직접 복원해야 합니다."
  return "$RB_RC"
}

# ═══════════════════════════════════════════════════════════════════════════
# 드라이런
# ═══════════════════════════════════════════════════════════════════════════
do_dryrun() {
  echo
  outln "== 미리보기(아무것도 바꾸지 않습니다) =="
  outln "  패키지     : $PKG"
  outln "  프론트     : $FRONT_DIR   ← dist/assets(.gz/.br 포함) → 루트자산 → index.html 순서로 덮어씀"
  outln "  백엔드     : $BACKEND_DIR ← app/ $BK_FILES $BK_DIRS"
  outln "  롤백 범위  : 위와 **동일**(백업 집합 = 쓰기 집합). 지문도 같은 범위로 검증"
  outln "  백업       : $BACKUP_ROOT/$TS"
  outln "  파이썬     : ${PYBIN:-미발견}  (근거: ${PYBIN_SRC:-없음} / 미설치 항목만 설치, -U 사용 안 함)"
  outln "  소유권     : 프론트=${FOWN:-?}  백엔드app=${BOWN:-?}  (복사 후 이 값으로 원복)"
  outln "  nginx      : ${NGINX:-미발견}  (patch_nginx.sh 위임 + brotli 모듈 자동 설치)"

  # ── 현장의 '체제' 를 아무 위험 없이 학습하는 자리가 바로 dry-run 이다 ──────
  # 재시작 방식(특히 도커 bind mount 여부)과 DB 체제는 apply 에서 처음 알면 늦다.
  # ⚠ 기본값을 '맨 프로세스' 로 두면 안 된다. detect_runtime 은 BPID 가 없으면 즉시
  #   return 하므로 CID·UNIT·RUNTIME_UNCERTAIN 이 모두 비는 **가장 흔한 경우가 바로
  #   PID 미발견**이다(도구 부재·비root·컨테이너 NAT — 위 [2] 가 경고하는 상황).
  #   그때 '맨 프로세스' 라고 쓰면 apply 가 실제로는 재시작을 시도조차 못 하고 수동
  #   안내로 빠지는데도 dry-run 이 '재기동된다' 고 예고하게 된다. apply 가 하지 않을
  #   일을 예고하지 않는다.
  if [ -n "${BPID:-}" ] && [ -r "/proc/$BPID/cmdline" ]; then
    RTDESC="맨 프로세스 → apply 시 TERM 후 원래 인자·cwd 로 재기동"
  elif [ -n "${BPID:-}" ]; then
    RTDESC="판정 불가(cmdline 을 읽지 못함 — root 필요) → apply 시 재시작하지 않고 수동 안내"
  else
    RTDESC="판정 불가(포트 점유 프로세스 미발견) → apply 시 재시작하지 않고 수동 안내"
  fi
  if [ -n "$CID" ]; then
    docker_verdict "$CID"
    case "$DOCKER_VERDICT" in
      bind)  RTDESC="docker $CID — bind mount 증명됨($DOCKER_BIND_EVID) → apply 시 docker restart" ;;
      image) RTDESC="docker $CID — bind mount 없음(${DOCKER_NOTE:-}) → **이번 갱신은 백엔드에 무효**(이미지 재빌드 필요)" ;;
      *)     RTDESC="docker $CID — 판정 불가(${DOCKER_NOTE:-사유 불명}) → apply 시 재시작하지 않고 수동 안내" ;;
    esac
  elif [ "$RUNTIME_UNCERTAIN" = "1" ]; then
    RTDESC="컨테이너로 보이나 docker 로 특정 불가${RUNTIME_CG_UNIT:+ (cgroup 의 '$RUNTIME_CG_UNIT' 는 상위 유닛이라 대상 아님)} → apply 시 죽이지 않고 수동 안내"
  elif [ -n "$UNIT" ]; then
    RTDESC="systemd 유닛 $UNIT → apply 시 systemctl restart"
  fi
  outln "  재시작     : PID=${BPID:-미발견}  /  $RTDESC"

  DBDESC="$DB_VERDICT"
  case "$DB_VERDICT" in
    latest)       DBDESC="최신($DB_CURRENT = $DB_HEAD_SRC head $DB_HEAD) — 할 일 없음" ;;
    behind)       DBDESC="미적용 ${DB_PENDING_N}건 ($DB_CURRENT → $DB_HEAD_SRC head $DB_HEAD)" ;;
    unstamped)    DBDESC="미스탬프(alembic_version 없음 — init_db() 가 만든 DB)" ;;
    unknown-rev)  DBDESC="DB 리비전 $DB_CURRENT 이 $DB_HEAD_SRC 트리의 migrations/ 에 없음(롤백 잔재/다른 계보)" ;;
    multihead)    DBDESC="$DB_HEAD_SRC 트리의 head 가 여러 개(머지 필요)" ;;
    undetermined) DBDESC="판정 불가 — ${DB_NOTE:-사유 불명}" ;;
    *)            DBDESC="진단하지 않음" ;;
  esac
  outln "  DB         : ${DB_KIND:-?}  ${DB_URL_SHOWN:-?}   (비밀번호 마스킹)"
  outln "  DB 스탬프  : $DBDESC   ※ 재시작 전 시점 — 기동 시 init_db() 가 스키마를 또 보정합니다"
  case "$MIG_VERDICT" in
    same)    outln "  migrations : 이 패키지는 migrations/ 를 바꾸지 않습니다(지문 동일) → 스키마 작업 없음" ;;
    changed) outln "  migrations : 이 패키지는 migrations/ 를 바꿉니다(지문 불일치) → 스키마 작업 검토 필요" ;;
    *)       outln "  migrations : 판정 불가(해시 도구 없음)" ;;
  esac
  if [ "$MIGRATE" = "1" ]; then
    case "$DB_VERDICT" in
      behind)
        if [ "${SV_DB_BACKUP_DONE:-0}" = "1" ]; then
          outln "  --migrate  : 실행합니다 — 위 ${DB_PENDING_N}건을 [5] 뒤에 적용"
        else
          outln "  --migrate  : **거부**합니다 — SV_DB_BACKUP_DONE=1 이 없습니다(DB 백업 확인 필요)"
        fi ;;
      latest) outln "  --migrate  : no-op (미적용 없음 — 근거: DB $DB_CURRENT = $DB_HEAD_SRC head $DB_HEAD)" ;;
      *)      outln "  --migrate  : **거부**합니다 — DB 상태가 '$DB_VERDICT' 입니다(자세한 사유는 위 [2] 출력)" ;;
    esac
  else
    outln "  --migrate  : 주지 않았습니다 → DB 는 **아무것도 바꾸지 않습니다**(기본 동작)"
  fi
  echo
  outln "  건드리지 않는 것: backend/.env, dev.db, certs/, deploy/generated/**,"
  outln "                    orthanc-generated.json, scp-policy.env, worklists/*.wl, 도커 볼륨"
  outln "                    **DB 스키마·데이터**(--migrate 를 명시하지 않는 한 읽기만 합니다)"
  outln "  삭제하지 않는 것: 기존 frontend/dist 자산(열려 있는 탭이 구 청크를 요청한다)"
}

# ═══════════════════════════════════════════════════════════════════════════
# 헤더 주석 블록을 그대로 도움말로 쓴다. 줄 번호를 박아 두면 헤더를 고칠 때마다
# 조용히 어긋나므로 `set -eu` 를 종점으로 삼는다.
usage() { sed -n '2,/^set -eu/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

case "$MODE" in
  check)
    outln "== Saintview Viewer Suite — 원격 진단 =="
    do_check
    echo
    if [ "$V_FAIL" -eq 0 ]; then outln "✅ 이상 없음"; else
      outln "❌ 실패 $V_FAIL 건 — 서버에서:  sudo sh $(basename "$0") --apply <패키지>"; exit 1; fi
    ;;

  dryrun)
    outln "== Saintview Viewer Suite — 서버 갱신(미리보기) =="
    precheck; detect_paths; do_dryrun
    ;;

  apply)
    outln "== Saintview Viewer Suite — 서버 갱신 =="
    outln "   시작: $(date '+%Y-%m-%d %H:%M:%S')   타임스탬프: $TS"
    precheck            # [1]
    detect_paths        # [2]
    do_backup           # [3]
    do_copy             # [4]
    do_pydeps           # [5]
    # --migrate 를 준 경우에만 도는 번호 없는 블록. 순서는 교체·의존성 뒤, 재시작 앞이다.
    # (플래그가 없으면 DB 는 **한 바이트도** 건드리지 않는다 — 진단만 이미 끝나 있다)
    if [ "$MIGRATE" = "1" ]; then do_migrate; fi
    do_nginx            # [6]
    # ※ set -eu 아래에서 `f; RC=$?` 는 함수가 0 이 아닌 값을 반환하는 순간 셸이 즉사한다
    #   (dash 에서 확인). 반드시 `RC=0; f || RC=$?` 형태로 써야 뒤 분기가 살아 있다.
    RRC=0; do_restart || RRC=$?   # [7]
    do_verify           # [8]

    echo
    # PYDEPS_FAIL 을 판정에 포함한다. 과거에는 pip 이 통째로 실패해도 '✅ 갱신 완료
    # / exit 0' 가 나와, ISO 반출이 501 인 서버를 정상이라고 보고했다.
    # 마이그레이션을 실제로 적용했다면, 롤백의 한계를 **여기서** 못 박는다.
    # (이 스크립트의 불변식 '백업 집합 = 복구 집합' 이 DB 에 대해서만 깨진 유일한 경우)
    if [ "$MIGRATE_DONE" = "1" ]; then
      outln "⚠  이 실행은 DB 마이그레이션을 적용했습니다 — **--rollback 은 DB 를 되돌리지 못합니다**"
      outln "   (파일만 되돌아갑니다. DB 를 되돌리려면 적용 전 백업에서 복원해야 합니다)"
    fi
    if [ "$V_FAIL" -eq 0 ] && [ "$RRC" = "0" ] && [ "$PYDEPS_FAIL" = "0" ] && [ "$MIGRATE_FAIL" = "0" ]; then
      # 검증을 실제로 다 돌린 경우에만 '완료' 라고 말한다. curl 이 없어 HTTP 검증을
      # 건너뛴 실행에 exit 0 을 주면 '미검증' 이 '정상' 으로 둔갑한다(--skip-restart 와
      # 겹치면 실제로 아무 HTTP 검증도 하지 않은 채 ✅ 가 나갔다).
      # 같은 이유로, --migrate 를 줬는데 거부한 실행도 0 이 아니다: 파일 갱신은 끝났지만
      # **사람이 요청한 작업 하나를 하지 않았다**. 0 을 주면 '했다' 로 읽힌다.
      if [ "$VERIFY_SKIPPED" = "0" ] && [ "$MIGRATE_INCOMPLETE" = "0" ] && [ "$MIGRATE_UNVERIFIED" = "0" ]; then
        outln "✅ 갱신 완료 ($TS)"
        outln "   백업: $BACKUP_ROOT/$TS   (되돌리기: sudo sh $(basename "$0") --rollback $TS)"
        exit 0
      fi
      if [ "$MIGRATE_INCOMPLETE" = "1" ]; then
        outln "⚠  파일 갱신은 끝났으나 **--migrate 로 요청한 마이그레이션을 실행하지 않았습니다**"
        outln "   사유는 위 'DB 마이그레이션' 블록에 있습니다(거부는 이 스크립트의 정상 동작입니다)."
      fi
      if [ "$MIGRATE_UNVERIFIED" = "1" ]; then
        outln "⚠  마이그레이션은 exit 0 이었으나 **적용 후 리비전을 확인하지 못했습니다**"
        outln "   'exit 0' 과 '스탬프가 올라갔다' 는 다른 명제입니다 — 직접 확인하세요:"
        outln "     cd $BACKEND_DIR && ${PYBIN:-<백엔드 파이썬>} -m alembic current"
      fi
      if [ "$VERIFY_SKIPPED" = "1" ]; then
        outln "⚠  갱신은 끝났으나 **검증을 완료하지 못했습니다**(curl 없음) — 정상 여부는 확인되지 않았습니다"
        outln "   확인: 브라우저 접속 / wget -qO- http://127.0.0.1:$PORT/api/health"
      fi
      outln "   백업: $BACKUP_ROOT/$TS   (되돌리기: sudo sh $(basename "$0") --rollback $TS)"
      exit 2
    fi
    outln "❌ 갱신이 완전하지 않습니다 (검증 실패 $V_FAIL 건, 재시작 exit $RRC, 의존성 실패 $PYDEPS_FAIL, 마이그레이션 실패 $MIGRATE_FAIL)"
    echo
    outln "   되돌리려면:"
    outln "     sudo sh $(basename "$0") --rollback $TS"
    outln "   되돌린 뒤에는 백엔드를 반드시 재시작해야 구 코드가 실제로 적용됩니다."
    exit 1
    ;;

  rollback)
    # 종료코드로도 사실을 말한다: 0=쓰기 집합 전부 복구, 2=부분 복구, 1=실패.
    # (부분 복구에 0 을 주면 감싸는 스크립트가 '완전 복구' 로 오독한다)
    RBRC=0; do_rollback || RBRC=$?
    exit "$RBRC" ;;
  *)        usage ;;
esac
