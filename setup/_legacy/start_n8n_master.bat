@echo off
echo n8n automation startup is disabled in manual-review mode.
exit /b 1
REM ============================================
REM Master boot script (v6 - final, with helper service)
REM Called by SoulInMotion-n8n scheduled task at every boot.
REM
REM Boot sequence:
REM 1. Kill orphan n8n on 5678 + helper on 9999
REM 2. Activate Job Agent workflows in SQLite (idempotent)
REM 3. Start helper service on port 9999
REM 4. Start n8n on port 5678 with sandbox bypass env vars
REM ============================================

setlocal enabledelayedexpansion

set BASE=C:\Users\Dev\Desktop\Job Agents\job-agent
set LOGDIR=%BASE%\setup\logs
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set LOGFILE=%LOGDIR%\n8n_startup.log

REM n8n env overrides (Function nodes need fs/path; legacy runner avoids sandbox)
set NODE_FUNCTION_ALLOW_BUILTIN=*
set NODE_FUNCTION_ALLOW_EXTERNAL=*
set N8N_RUNNERS_ENABLED=false

echo. >> "%LOGFILE%"
echo ================================================ >> "%LOGFILE%"
echo Boot at %date% %time% >> "%LOGFILE%"
echo ================================================ >> "%LOGFILE%"

REM Step 1: Kill any orphan processes on our ports
echo [%date% %time%] Step 1: Free ports 5678 + 9999... >> "%LOGFILE%"
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5678" ^| findstr "LISTENING"') do (
    echo [%date% %time%] Killing n8n PID %%a >> "%LOGFILE%"
    taskkill /F /PID %%a >> "%LOGFILE%" 2>&1
    powershell -NoProfile -Command "wmic process where ProcessId=%%a delete" >> "%LOGFILE%" 2>&1
)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":9999" ^| findstr "LISTENING"') do (
    echo [%date% %time%] Killing helper PID %%a >> "%LOGFILE%"
    powershell -NoProfile -Command "wmic process where ProcessId=%%a delete" >> "%LOGFILE%" 2>&1
)
timeout /t 3 /nobreak >nul

REM Step 2: Activate workflows in SQLite (idempotent — safe to re-run)
echo [%date% %time%] Step 2: Activate workflows... >> "%LOGFILE%"
python "%BASE%\setup\activate_workflows.py" >> "%LOGFILE%" 2>&1

REM Step 3: Start helper service
echo [%date% %time%] Step 3: Start helper service on 9999... >> "%LOGFILE%"
start "" /MIN cmd /c "node ""%BASE%\helper-service\server.js"" >> ""%LOGDIR%\helper.log"" 2>&1"

REM Step 4: Start n8n
echo [%date% %time%] Step 4: Start n8n on 5678... >> "%LOGFILE%"
start "" /MIN cmd /c "set NODE_FUNCTION_ALLOW_BUILTIN=*&& set NODE_FUNCTION_ALLOW_EXTERNAL=*&& set N8N_RUNNERS_ENABLED=false&& n8n start >> ""%LOGDIR%\n8n_runtime.log"" 2>&1"

REM Step 5: Wait up to 30s for both ports
set /a counter=0
:waitloop
timeout /t 2 /nobreak >nul
netstat -an | findstr ":5678" | findstr "LISTENING" >nul
if !errorlevel!==0 (
    netstat -an | findstr ":9999" | findstr "LISTENING" >nul
    if !errorlevel!==0 goto :ready
)
set /a counter+=1
if !counter! geq 15 goto :failed
goto :waitloop

:ready
echo [%date% %time%] SUCCESS - n8n on 5678 + helper on 9999 >> "%LOGFILE%"
endlocal
exit /b 0

:failed
echo [%date% %time%] FAILED - one or both services did not bind in 30s >> "%LOGFILE%"
endlocal
exit /b 1
