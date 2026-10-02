@echo off
echo Automatic boot is disabled. Use playwright\OPEN_INDEED_REVIEW.bat for manual Indeed review only.
exit /b 1
REM ============================================
REM Single boot entrypoint - runs at every login via JobAgent-Boot task.
REM Starts ALL 4 services: helper(9999) + n8n(5678) + dashboard(8765) + activates workflows.
REM ============================================

setlocal EnableDelayedExpansion

set "BASE=C:\Users\Dev\Desktop\Job Agents\job-agent"
set "LOGDIR=%BASE%\setup\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "LOGFILE=%LOGDIR%\boot.log"

echo. >> "%LOGFILE%"
echo ================================================ >> "%LOGFILE%"
echo Boot started at %date% %time% >> "%LOGFILE%"
echo ================================================ >> "%LOGFILE%"

REM === Step 1: Kill any orphans on our 3 ports ===
echo [%date% %time%] [1/6] Cleaning ports 5678 / 9999 / 8765... >> "%LOGFILE%"
for %%P in (5678 9999 8765) do (
    for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":%%P" ^| findstr "LISTENING" 2^>nul') do (
        taskkill /F /PID %%a >> "%LOGFILE%" 2>&1
        powershell -NoProfile -Command "Stop-Process -Id %%a -Force -ErrorAction SilentlyContinue" >> "%LOGFILE%" 2>&1
    )
)
timeout /t 3 /nobreak >nul

REM === Step 2: Activate workflows in SQLite ===
echo [%date% %time%] [2/6] Activating workflows... >> "%LOGFILE%"
python "%BASE%\setup\activate_workflows.py" >> "%LOGFILE%" 2>&1

REM === Step 3: Start helper service (port 9999) ===
echo [%date% %time%] [3/6] Starting helper service... >> "%LOGFILE%"
powershell -NoProfile -Command "Start-Process -FilePath 'node.exe' -ArgumentList '\"%BASE%\helper-service\server.js\"' -WindowStyle Hidden -RedirectStandardOutput '%LOGDIR%\helper-out.log' -RedirectStandardError '%LOGDIR%\helper-err.log'" >> "%LOGFILE%" 2>&1

REM === Step 4: Start n8n with env vars (port 5678) ===
echo [%date% %time%] [4/6] Starting n8n... >> "%LOGFILE%"
powershell -NoProfile -Command "$env:NODE_FUNCTION_ALLOW_BUILTIN='*'; $env:NODE_FUNCTION_ALLOW_EXTERNAL='*'; $env:N8N_RUNNERS_ENABLED='false'; Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','n8n start' -WindowStyle Hidden -RedirectStandardOutput '%LOGDIR%\n8n-out.log' -RedirectStandardError '%LOGDIR%\n8n-err.log'" >> "%LOGFILE%" 2>&1

REM === Step 5: Start dashboard HTTP server (port 8765) ===
echo [%date% %time%] [5/6] Starting dashboard server... >> "%LOGFILE%"
powershell -NoProfile -Command "Start-Process -FilePath 'python.exe' -ArgumentList '-m','http.server','8765' -WorkingDirectory '%BASE%' -WindowStyle Hidden -RedirectStandardOutput '%LOGDIR%\dashboard.log' -RedirectStandardError '%LOGDIR%\dashboard-err.log'" >> "%LOGFILE%" 2>&1

REM === Step 6: Wait for all 3 ports to bind ===
echo [%date% %time%] [6/6] Waiting for services... >> "%LOGFILE%"
set /a counter=0
:waitloop
timeout /t 2 /nobreak >nul
set "n8n_up=0"
set "helper_up=0"
set "dash_up=0"
netstat -an | findstr ":5678" | findstr "LISTENING" >nul && set "n8n_up=1"
netstat -an | findstr ":9999" | findstr "LISTENING" >nul && set "helper_up=1"
netstat -an | findstr ":8765" | findstr "LISTENING" >nul && set "dash_up=1"
if !n8n_up!==1 if !helper_up!==1 if !dash_up!==1 goto :ready
set /a counter+=1
if !counter! geq 25 goto :failed
goto :waitloop

:ready
echo [%date% %time%] SUCCESS - all services up >> "%LOGFILE%"
echo [%date% %time%] Dashboard: http://127.0.0.1:8765/dashboard/local.html >> "%LOGFILE%"
endlocal
exit /b 0

:failed
echo [%date% %time%] PARTIAL - n8n=!n8n_up! helper=!helper_up! dash=!dash_up! >> "%LOGFILE%"
endlocal
exit /b 1
