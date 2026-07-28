@echo off
rem Saintview backend restart/stop - invoked by server-control API via Task Scheduler.
rem Scheduler-owned process: survives even when the backend (caller) dies.
rem Usage: server_restart.bat [restart|stop]  (target PID read from restart.pid)
set MODE=%1
if "%MODE%"=="" set MODE=restart

ping -n 3 127.0.0.1 >nul
if not exist "%~dp0restart.pid" goto skipkill
for /f %%p in ('type "%~dp0restart.pid"') do taskkill /f /pid %%p >nul 2>&1
del "%~dp0restart.pid" >nul 2>&1
:skipkill
if /i "%MODE%"=="stop" exit /b 0

ping -n 2 127.0.0.1 >nul
rem DB env: nothing to scrape here. config.py does load_dotenv() and reads backend/.env,
rem which is the single source for SAINTVIEW_DATABASE_URL. (The old block read
rem ..\start_saintview.bat - a main-product file that does not exist in this suite;
rem findstr just printed "Cannot open ..." with ERRORLEVEL=1 on every restart.)
cd /d %~dp0
rem Port: the suite backend is 8010 EVERYWHERE - start_viewer_suite.bat, nginx-viewer.conf
rem proxy_pass, deploy/update_server.sh, frontend/vite.config.ts proxy, backend/.env.example.
rem 8000 is the MAIN product (SaintviewPACSai). Reviving on 8000 killed the 8010 listener and
rem left every access path (vite proxy / nginx) pointing at a dead port - the admin console
rem said "reconnecting shortly" but the web never came back without a manual restart on the
rem server PC. Optional %2 overrides for non-default deployments.
set PORT=%2
if "%PORT%"=="" set PORT=8010
start "Saintview Backend" /min py -3.11 -m uvicorn app.main:app --port %PORT% --log-level warning
exit /b 0
