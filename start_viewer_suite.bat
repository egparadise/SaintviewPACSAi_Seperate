@echo off
rem Saintview Viewer Suite 원클릭 실행 — docker(DB/Orthanc/OHIF) + 백엔드(:8010) + 뷰어(:5180, HTTPS)
rem 이 파일은 UTF-8 + CRLF 로 저장한다(chcp 65001 전제).
chcp 65001 >nul
setlocal EnableExtensions
cd /d %~dp0
title Saintview Viewer Suite 실행

rem ── 0. HTTPS 인증서(없으면 자동 생성) — 뷰어는 HTTPS 전용(원격 모니터 감지 secure context) ──
if exist "frontend\certs\dev.key" if exist "frontend\certs\dev.crt" goto certs_ok
echo [0/4] HTTPS 인증서 자동 생성(frontend\certs\dev.key/crt)...
if not exist "frontend\certs" mkdir "frontend\certs"
set "OPENSSL=openssl"
where openssl >nul 2>&1
if errorlevel 1 set "OPENSSL=%ProgramFiles%\Git\usr\bin\openssl.exe"
"%OPENSSL%" req -x509 -newkey rsa:2048 -nodes -keyout frontend\certs\dev.key -out frontend\certs\dev.crt -days 3650 -subj "/CN=svviewer-dev" -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" >nul 2>&1
if exist "frontend\certs\dev.key" if exist "frontend\certs\dev.crt" goto certs_ok
echo    [!] 인증서 생성 실패 - openssl 설치 후 재실행하세요.
pause
exit /b 1
:certs_ok

rem ── 0-1. 백엔드 .env 없으면 예시 복사 ──
if not exist "backend\.env" copy /y "backend\.env.example" "backend\.env" >nul

echo [1/4] Docker(DB:5434 / Orthanc:8043·4243 / OHIF:3001) 확인...
docker info >nul 2>&1
if not errorlevel 1 goto docker_ready
echo    Docker Desktop이 꺼져 있어 자동 시작합니다(최대 120초 대기)...
if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" (
  start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
) else (
  echo    [!] Docker Desktop 설치 경로를 찾지 못했습니다 - 수동 실행 후 다시 시도하세요.
)
set /a _dtry=0
:wait_docker
docker info >nul 2>&1
if not errorlevel 1 goto docker_ready
set /a _dtry+=1
if %_dtry% geq 60 (
  echo    [!] Docker 대기 초과 - DB/Orthanc 없이 계속합니다.
  goto docker_skip
)
ping -n 3 127.0.0.1 >nul
goto wait_docker
:docker_ready
docker compose -f deploy\docker-compose.yml up -d
:docker_skip

echo [2/4] 백엔드 API(:8010) 확인...
curl -s -o NUL -m 2 http://localhost:8010/api/health >nul 2>&1
if not errorlevel 1 (
  echo    이미 실행 중 - 건너뜁니다.
) else (
  start "SVViewer Backend (8010)" /min cmd /c "cd /d %~dp0backend && py -3.11 -m uvicorn app.main:app --port 8010 --log-level warning"
)

echo [3/4] 뷰어 프론트(:5180, HTTPS 전용) 확인...
netstat -an | findstr /c:":5180 " | findstr /c:"LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo    :5180 이미 실행 중 - 건너뜁니다.
  goto front_started
)
rem ⚡ 기본은 프로덕션 빌드 서빙(preview) — 뷰어 창 열기 속도의 핵심.
rem    dev 모드는 새 창마다 비압축 모듈 수십 개(6.8MB)를 내려받아 창 열기가 느리다
rem    (실측: dev 6.8MB/53요청 vs 프로덕션 0.7MB/3요청). 소스 수정 즉시 반영이 필요한
rem    개발 중에는  start_viewer_suite.bat dev  로 실행하면 기존 dev 모드로 뜬다.
if /I "%~1"=="dev" (
  echo    [개발 모드] vite dev 로 기동합니다 - 창 열기가 느릴 수 있습니다.
  start "SVViewer Front (5180 dev)" /min cmd /c "cd /d %~dp0frontend && npm run dev -- --host 0.0.0.0 --port 5180 --strictPort > %TEMP%\svviewer_5180.log 2>&1"
  goto front_started
)
echo    프로덕션 빌드 생성 중(최초/소스 변경 시 수십 초)...
pushd "%~dp0frontend"
call npm run build > %TEMP%\svviewer_build.log 2>&1
if errorlevel 1 (
  echo    [!] 빌드 실패 - dev 모드로 대체합니다. 로그: %TEMP%\svviewer_build.log
  popd
  start "SVViewer Front (5180 dev)" /min cmd /c "cd /d %~dp0frontend && npm run dev -- --host 0.0.0.0 --port 5180 --strictPort > %TEMP%\svviewer_5180.log 2>&1"
  goto front_started
)
popd
start "SVViewer Front (5180)" /min cmd /c "cd /d %~dp0frontend && npm run preview -- --host 0.0.0.0 --port 5180 --strictPort > %TEMP%\svviewer_5180.log 2>&1"
:front_started

echo [4/4] 뷰어 응답 대기(최대 90초)...
set /a _try=0
:wait_front
curl -sk -o NUL -m 2 https://localhost:5180 >nul 2>&1
if not errorlevel 1 goto open_front
set /a _try+=1
if %_try% geq 90 goto front_fail
ping -n 2 127.0.0.1 >nul
goto wait_front

:front_fail
echo    [!] 뷰어가 응답하지 않습니다 - 로그: %TEMP%\svviewer_5180.log
echo        (최초 실행이면 frontend 에서 npm install 이 필요할 수 있습니다)

:open_front
echo.
echo   Saintview Viewer Suite : https://localhost:5180  (admin / admin1234)
echo   OHIF(Advance View)     : http://localhost:3001
echo   Orthanc                : http://localhost:8043  ·  DICOM C-STORE 포트 4243 (AET SVVIEWER)
echo   API                    : http://localhost:8010/api/health
echo   ※ 자체서명 인증서 - 최초 접속 시 브라우저 경고는 [고급]-[계속]으로 1회 통과
echo.
start "" https://localhost:5180
exit /b 0
