#!/bin/sh
# Saintview Viewer Suite — nginx 전송 최적화 패치 (자립 스크립트)
#
# 이 파일 하나만 서버에 복사해서 실행하면 된다(저장소 체크아웃 불필요).
#
# 무엇을 하나
#   · **사전 압축본(.gz/.br) 서빙을 켠다.** 빌드가 이미 만들어 두므로 런타임 CPU 0 으로
#     전송량만 줄어든다. 실측(sv70): 850,757B → gzip 232,233B → brotli 약 171KB.
#   · 이미 적용된 항목은 **건드리지 않는다**(같은 값으로 덮어써도 무해하도록 설계).
#   · 캐시(Cache-Control)는 손대지 않는다 — server 블록에서 이미 설정돼 있으면 중복 지정이
#     오히려 충돌을 만든다. 미설정이면 --check 가 알려 주고, 그때만 수동으로 넣는다.
#
# 안전장치
#   · 기존 파일 백업 → 문법검사(nginx -t) → 실패 시 **자동 원복**
#   · 되돌리기는 파일 하나 삭제(--rollback)
#   · server 블록을 **일절 편집하지 않는다**(http 컨텍스트 드롭인 한 장뿐)
#
# 사용법
#   원격 진단(아무 PC 에서나, 서버 접속 불필요):
#       sh patch_nginx.sh --check https://sv70.cloudcare.life
#   적용(서버에서, root 권한):
#       sudo sh patch_nginx.sh --apply [https://확인용주소]
#   미리보기 / 되돌리기:
#       sh patch_nginx.sh --dry-run
#       sudo sh patch_nginx.sh --rollback
set -eu

DROPIN_NAME="zz-saintview-perf.conf"
MODE=""
URL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --check)    MODE=check;    URL="${2:-}"; [ -n "$URL" ] && shift ;;
    --apply)    MODE=apply;    URL="${2:-}"; case "$URL" in -*|"") URL="" ;; *) shift ;; esac ;;
    --rollback) MODE=rollback ;;
    --dry-run)  MODE=dryrun ;;
    -h|--help)  MODE=help ;;
    *)          echo "알 수 없는 인자: $1"; MODE=help ;;
  esac
  shift
done
[ -n "$MODE" ] || MODE=help

# ── 원격 진단 — HTTP 헤더만으로 현 상태를 판정한다(서버 로그인 불필요) ──────
do_check() {
  [ -n "$URL" ] || { echo "✗ --check 에는 주소가 필요합니다 (예: --check https://호스트)"; exit 1; }
  command -v curl >/dev/null || { echo "✗ curl 이 필요합니다"; exit 1; }
  U="${URL%/}"
  echo "대상: $U"
  ASSET=$(curl -sk --max-time 20 "$U/" | grep -o '/assets/index-[A-Za-z0-9_-]*\.js' | head -1 || true)
  [ -n "$ASSET" ] || { echo "✗ /assets/index-*.js 를 찾지 못했습니다 (주소·배포 확인)"; exit 1; }
  echo "자산: $ASSET"; echo

  hdr() { curl -sk -o /dev/null -D - --max-time 20 "$@" | tr -d '\r'; }
  RAW=$(hdr -H 'Accept-Encoding: identity' "$U$ASSET" | sed -n 's/^[Cc]ontent-[Ll]ength: //p')
  GZ=$(hdr  -H 'Accept-Encoding: gzip'     "$U$ASSET")
  BR=$(hdr  -H 'Accept-Encoding: br'       "$U$ASSET")
  IDX=$(hdr "$U/")

  gzenc=$(printf '%s' "$GZ" | sed -n 's/^[Cc]ontent-[Ee]ncoding: //p')
  gzlen=$(printf '%s' "$GZ" | sed -n 's/^[Cc]ontent-[Ll]ength: //p')
  brenc=$(printf '%s' "$BR" | sed -n 's/^[Cc]ontent-[Ee]ncoding: //p')
  brlen=$(printf '%s' "$BR" | sed -n 's/^[Cc]ontent-[Ll]ength: //p')
  cc=$(printf   '%s' "$GZ" | sed -n 's/^[Cc]ache-[Cc]ontrol: //p')
  icc=$(printf  '%s' "$IDX" | sed -n 's/^[Cc]ache-[Cc]ontrol: //p')

  ng=0
  case "$gzenc" in gzip) echo "✅ gzip        적용됨   ${RAW:-?}B → ${gzlen:-?}B" ;;
                   *)    echo "❌ gzip        미적용   ${RAW:-?}B 를 그대로 전송"; ng=1 ;; esac
  case "$brenc" in br)   echo "✅ brotli      적용됨   ${RAW:-?}B → ${brlen:-?}B" ;;
                   *)    echo "❌ brotli      미적용   (빌드가 만든 .br 을 쓰지 않는 중 — gzip 대비 약 25% 더 작음)"; ng=1 ;; esac
  case "$cc" in    *max-age=*) echo "✅ 자산 캐시   $cc" ;;
                   *)    echo "❌ 자산 캐시   없음 — 재방문마다 재검증"; ng=1 ;; esac
  case "$icc" in   *no-cache*|*no-store*) echo "✅ index.html  $icc" ;;
                   "")   echo "⚠  index.html  캐시 지시 없음 — 새 배포 인식이 늦을 수 있음" ;;
                   *)    echo "⚠  index.html  $icc (no-cache 권장)" ;; esac

  # ⚠ gzip_static 은 index-*.js.gz 를 서빙하므로 **변형마다 Last-Modified 가 다르다**.
  #   gzip 응답에서 얻은 값으로 무압축 변형에 물어보면 항상 200 이 나와 오진이 된다.
  #   반드시 **같은 Accept-Encoding** 으로 되물어야 한다.
  LM=$(printf '%s' "$GZ" | sed -n 's/^[Ll]ast-[Mm]odified: //p')
  if [ -n "$LM" ]; then
    code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 20              -H 'Accept-Encoding: gzip' -H "If-Modified-Since: $LM" "$U$ASSET")
    [ "$code" = "304" ] && echo "✅ 조건부요청  304 동작" || echo "⚠  조건부요청  $code (304 미동작)"
  fi
  echo
  [ "$ng" = "0" ] && echo "→ 전송 설정은 모두 적용돼 있습니다." \
                  || echo "→ 서버에서:  sudo sh $(basename "$0") --apply $U"
}

# ── 서버에서 적용 ──────────────────────────────────────────────────────────
find_nginx() {
  NGINX="$(command -v nginx || true)"
  [ -n "$NGINX" ] || { echo "✗ nginx 를 찾을 수 없습니다 (PATH 확인)"; exit 1; }
  CONF="$("$NGINX" -V 2>&1 | tr ' ' '\n' | sed -n 's/^--conf-path=//p' | head -1)"
  [ -n "$CONF" ] && [ -f "$CONF" ] || CONF=/etc/nginx/nginx.conf
  [ -f "$CONF" ] || { echo "✗ nginx.conf 를 찾을 수 없습니다: $CONF"; exit 1; }
  CONFDIR="$(dirname "$CONF")/conf.d"
  DROPIN="$CONFDIR/$DROPIN_NAME"
}

build_dropin() {
  # 모듈이 없는데 지시어를 쓰면 nginx 가 기동 자체를 거부한다 → 있을 때만 넣는다
  V="$("$NGINX" -V 2>&1)"
  GZS="# gzip_static 미지원 빌드"
  BRS="# ngx_brotli 미설치 — 설치하면 gzip 대비 약 25% 더 작아진다"
  case "$V" in *--with-http_gzip_static_module*) GZS="gzip_static on;" ;; esac
  case "$V" in *brotli*) BRS="brotli_static on;
brotli off;          # 런타임 압축은 CPU 를 쓴다 — 빌드가 만든 .br 만 서빙" ;; esac
  cat <<EOF
# Saintview Viewer Suite — 전송 최적화 (http 컨텍스트 드롭인)
# 생성: $(date '+%Y-%m-%d %H:%M:%S')
# server 블록은 건드리지 않는다. 되돌리기: 이 파일 삭제 후 nginx -s reload
#
# 빌드가 산출물 옆에 .gz/.br 을 미리 만들어 두므로, static 지시어만 켜면
# **런타임 CPU 0** 으로 압축본이 나간다.
$GZS
$BRS

gzip on;
gzip_vary on;
gzip_comp_level 6;
gzip_min_length 1024;
gzip_proxied any;
gzip_types
    application/javascript text/javascript application/json
    text/css text/plain image/svg+xml application/manifest+json;
EOF
}

do_apply() {
  find_nginx
  grep -qE '^[[:space:]]*include[^;]*conf\.d/\*\.conf' "$CONF" || {
    echo "✗ $CONF 가 conf.d/*.conf 를 include 하지 않습니다."
    echo "  → http { } 안에 다음 줄을 추가한 뒤 다시 실행하세요:  include $CONFDIR/*.conf;"
    exit 1; }
  mkdir -p "$CONFDIR"
  BAK=""
  if [ -f "$DROPIN" ]; then BAK="$DROPIN.bak.$(date +%Y%m%d%H%M%S)"; cp "$DROPIN" "$BAK"; fi
  build_dropin > "$DROPIN"
  echo "· 작성: $DROPIN"
  if ! "$NGINX" -t; then
    echo "✗ nginx -t 실패 — 원복합니다"
    if [ -n "$BAK" ]; then mv "$BAK" "$DROPIN"; else rm -f "$DROPIN"; fi
    "$NGINX" -t >/dev/null 2>&1 && echo "  (원복 완료: 기존 설정 정상)"
    exit 1
  fi
  "$NGINX" -s reload
  echo "✓ nginx reload 완료"
  [ -n "$BAK" ] && rm -f "$BAK" || true
  if [ -n "$URL" ]; then echo; do_check; fi
}

do_rollback() {
  find_nginx
  [ -f "$DROPIN" ] || { echo "· 적용된 패치가 없습니다: $DROPIN"; exit 0; }
  rm -f "$DROPIN"
  if "$NGINX" -t; then "$NGINX" -s reload; echo "✓ 패치 제거·reload 완료"; else
    echo "✗ 제거 후 nginx -t 실패 — 기존 설정에 다른 문제가 있습니다"; exit 1; fi
}

case "$MODE" in
  check)    do_check ;;
  apply)    do_apply ;;
  rollback) do_rollback ;;
  dryrun)   find_nginx; echo "# → $DROPIN 에 아래 내용을 씁니다"; echo; build_dropin ;;
  *) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
