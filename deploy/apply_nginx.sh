#!/bin/sh
# Saintview Viewer Suite — nginx 압축·캐시 적용 (Linux/유닉스 nginx)
#
# 왜 필요한가: 실서버 점검에서 nginx gzip 이 꺼져 있어 index-*.js **823KB 를 무압축 그대로**
# 보내고 있었다(gzip 220KB / brotli 171KB). 앱이 뜨기까지가 그만큼 늦어진다.
#
# 이 스크립트는 **기존 server 블록을 건드리지 않는다.** http 컨텍스트 드롭인 한 장만 넣는다
# (conf.d/*.conf 는 표준 nginx.conf 에서 http 안에 include 된다). 그래서 되돌리기도 쉽다:
#   sudo rm /etc/nginx/conf.d/zz-saintview-gzip.conf && sudo nginx -s reload
#
# 실행:  sudo sh deploy/apply_nginx.sh [확인용 URL]
#   예)  sudo sh deploy/apply_nginx.sh https://sv70.cloudcare.life
set -eu

DROPIN_NAME="zz-saintview-gzip.conf"
CHECK_URL="${1:-}"

# ── 1. nginx 와 conf.d 찾기 ──────────────────────────────────────────────
NGINX="$(command -v nginx || true)"
[ -n "$NGINX" ] || { echo "✗ nginx 를 찾을 수 없습니다 (PATH 확인)"; exit 1; }

# nginx -V 의 --conf-path 에서 실제 nginx.conf 위치를 얻는다(배포판마다 다름)
CONF="$("$NGINX" -V 2>&1 | tr ' ' '\n' | sed -n 's/^--conf-path=//p' | head -1)"
[ -n "$CONF" ] && [ -f "$CONF" ] || CONF=/etc/nginx/nginx.conf
[ -f "$CONF" ] || { echo "✗ nginx.conf 를 찾을 수 없습니다: $CONF"; exit 1; }
CONFDIR="$(dirname "$CONF")/conf.d"

if ! grep -qE '^[[:space:]]*include[^;]*conf\.d/\*\.conf' "$CONF"; then
  echo "✗ $CONF 가 conf.d/*.conf 를 include 하지 않습니다."
  echo "  → http { } 안에 다음 줄을 추가한 뒤 다시 실행하세요:  include $CONFDIR/*.conf;"
  exit 1
fi
mkdir -p "$CONFDIR"
DROPIN="$CONFDIR/$DROPIN_NAME"

# ── 2. gzip_static 지원 여부 ────────────────────────────────────────────
# 빌드가 .gz 를 미리 만들어 두므로, 지원되면 **런타임 CPU 0** 으로 압축본이 나간다.
if "$NGINX" -V 2>&1 | grep -q -- '--with-http_gzip_static_module'; then
  STATIC_LINE="gzip_static on;"
  echo "· gzip_static 지원됨 — 사전 압축본(.gz)을 그대로 서빙합니다"
else
  STATIC_LINE="# gzip_static 미지원 빌드 — 런타임 gzip 만 사용"
  echo "· gzip_static 미지원 — 런타임 gzip 으로 진행합니다(효과는 동일, CPU 약간 사용)"
fi

# ── 3. 드롭인 작성 ──────────────────────────────────────────────────────
[ -f "$DROPIN" ] && cp "$DROPIN" "$DROPIN.bak.$(date +%Y%m%d%H%M%S)"
cat > "$DROPIN" <<EOF
# Saintview Viewer Suite — 전송 압축 (http 컨텍스트 드롭인, server 블록 무수정)
# 되돌리기: 이 파일을 지우고 nginx -s reload
$STATIC_LINE
gzip on;
gzip_vary on;
gzip_comp_level 6;
gzip_min_length 1024;
gzip_proxied any;
gzip_types
    application/javascript text/javascript application/json
    text/css text/plain image/svg+xml application/manifest+json;
EOF
echo "· 작성: $DROPIN"

# ── 4. 문법 검사 → 실패 시 자동 원복 ────────────────────────────────────
if ! "$NGINX" -t; then
  echo "✗ nginx -t 실패 — 드롭인을 제거하고 원상복구합니다"
  rm -f "$DROPIN"
  "$NGINX" -t && echo "  (원복 완료: 기존 설정은 정상입니다)"
  exit 1
fi
"$NGINX" -s reload
echo "✓ nginx reload 완료"

# ── 5. 검증 ─────────────────────────────────────────────────────────────
if [ -n "$CHECK_URL" ]; then
  ASSET="$(curl -sk "$CHECK_URL/" | grep -o '/assets/index-[A-Za-z0-9_-]*\.js' | head -1 || true)"
  if [ -n "$ASSET" ]; then
    echo "· 확인 대상: $CHECK_URL$ASSET"
    ENC="$(curl -sk -o /dev/null -D - -H 'Accept-Encoding: gzip' "$CHECK_URL$ASSET" \
           | tr -d '\r' | sed -n 's/^[Cc]ontent-[Ee]ncoding: //p')"
    if [ -n "$ENC" ]; then
      echo "✓ 압축 적용됨 (content-encoding: $ENC)"
    else
      echo "✗ 아직 무압축입니다 — 이 서버가 정말 그 응답을 내는지(앞단 프록시/CDN 여부) 확인하세요"
    fi
  else
    echo "· 확인용 자산을 찾지 못했습니다(URL 확인)"
  fi
fi

# ── 6. 남은 한 가지: 자산 캐시 ──────────────────────────────────────────
# add_header 는 하위 컨텍스트에서 재정의되면 상위 것이 **통째로 무시**된다.
# 대상 server 블록이 이미 add_header(X-Frame-Options 등)를 쓰고 있으면 http 레벨로는 안 먹는다.
# 그래서 이 부분만 server 블록에 직접 넣어야 한다(자산 파일명에 콘텐츠 해시가 있어 영구 캐시가 안전).
cat <<'EOF'

────────────────────────────────────────────────────────────────
남은 1단계 — 자산 캐시(선택, 재방문 속도)
해당 사이트의 server { } 블록 안에 아래를 추가하고 nginx -s reload:

    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }
    location = /index.html {
        add_header Cache-Control "no-cache, must-revalidate";
    }

※ 전체 예시는 deploy/nginx-viewer.conf 참조.
────────────────────────────────────────────────────────────────
EOF
