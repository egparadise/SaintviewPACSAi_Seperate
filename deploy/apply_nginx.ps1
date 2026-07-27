# Saintview Viewer Suite — nginx 압축 적용 (Windows nginx)
#
# 실서버 점검에서 gzip 이 꺼져 있어 index-*.js 823KB 를 무압축 전송하고 있었다
# (gzip 220KB / brotli 171KB). 앱이 뜨기까지가 그만큼 늦어진다.
#
# 기존 server 블록은 건드리지 않는다 — http 컨텍스트 드롭인 한 장만 넣는다.
# 되돌리기: 드롭인 파일 삭제 후 nginx -s reload
#
# 실행:  powershell -ExecutionPolicy Bypass -File deploy\apply_nginx.ps1 -NginxDir C:\nginx [-CheckUrl https://호스트]
param(
    [Parameter(Mandatory = $true)][string]$NginxDir,
    [string]$CheckUrl = ""
)
$ErrorActionPreference = 'Stop'

$exe = Join-Path $NginxDir 'nginx.exe'
$conf = Join-Path $NginxDir 'conf\nginx.conf'
if (-not (Test-Path $exe)) { Write-Host "X nginx.exe 없음: $exe"; exit 1 }
if (-not (Test-Path $conf)) { Write-Host "X nginx.conf 없음: $conf"; exit 1 }

$confDir = Join-Path $NginxDir 'conf\conf.d'
$confText = Get-Content $conf -Raw
if ($confText -notmatch 'include\s+[^;]*conf\.d/\*\.conf') {
    Write-Host "X $conf 가 conf.d/*.conf 를 include 하지 않습니다."
    Write-Host "  -> http { } 안에 다음 줄을 추가한 뒤 다시 실행하세요:  include conf.d/*.conf;"
    exit 1
}
if (-not (Test-Path $confDir)) { New-Item -ItemType Directory -Path $confDir -Force | Out-Null }

# 빌드가 .gz 를 미리 만들어 두므로, 지원되면 런타임 CPU 0 으로 압축본이 나간다
$ver = & $exe -V 2>&1 | Out-String
$staticLine = if ($ver -match 'http_gzip_static_module') {
    Write-Host "- gzip_static 지원됨 - 사전 압축본(.gz)을 그대로 서빙합니다"; 'gzip_static on;'
} else {
    Write-Host "- gzip_static 미지원 - 런타임 gzip 으로 진행합니다"; '# gzip_static 미지원 빌드'
}

$dropin = Join-Path $confDir 'zz-saintview-gzip.conf'
if (Test-Path $dropin) { Copy-Item $dropin "$dropin.bak" -Force }
@"
# Saintview Viewer Suite - 전송 압축 (http 컨텍스트 드롭인, server 블록 무수정)
$staticLine
gzip on;
gzip_vary on;
gzip_comp_level 6;
gzip_min_length 1024;
gzip_proxied any;
gzip_types
    application/javascript text/javascript application/json
    text/css text/plain image/svg+xml application/manifest+json;
"@ | Out-File -FilePath $dropin -Encoding utf8
Write-Host "- 작성: $dropin"

& $exe -t -p $NginxDir
if ($LASTEXITCODE -ne 0) {
    Write-Host "X nginx -t 실패 - 드롭인을 제거하고 원상복구합니다"
    Remove-Item $dropin -Force
    exit 1
}
& $exe -s reload -p $NginxDir
Write-Host "OK nginx reload 완료"

if ($CheckUrl) {
    try {
        $html = (Invoke-WebRequest -Uri "$CheckUrl/" -UseBasicParsing).Content
        $m = [regex]::Match($html, '/assets/index-[A-Za-z0-9_-]+\.js')
        if ($m.Success) {
            $r = Invoke-WebRequest -Uri "$CheckUrl$($m.Value)" -Headers @{ 'Accept-Encoding' = 'gzip' } -UseBasicParsing
            $enc = $r.Headers['Content-Encoding']
            if ($enc) { Write-Host "OK 압축 적용됨 (content-encoding: $enc)" }
            else { Write-Host "X 아직 무압축입니다 - 앞단 프록시/CDN 여부를 확인하세요" }
        }
    } catch { Write-Host "- 검증 요청 실패: $($_.Exception.Message)" }
}

Write-Host ""
Write-Host "----------------------------------------------------------------"
Write-Host "남은 1단계 - 자산 캐시(선택, 재방문 속도)"
Write-Host "해당 사이트의 server { } 블록 안에 아래를 추가하고 nginx -s reload:"
Write-Host ""
Write-Host '    location /assets/ {'
Write-Host '        add_header Cache-Control "public, max-age=31536000, immutable";'
Write-Host '        try_files $uri =404;'
Write-Host '    }'
Write-Host ""
Write-Host "전체 예시는 deploy\nginx-viewer.conf 참조."
Write-Host "----------------------------------------------------------------"
