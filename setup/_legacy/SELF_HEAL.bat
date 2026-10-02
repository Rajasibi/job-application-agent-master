@echo off
echo Automatic repair and restart are disabled in manual-review mode.
exit /b 1
REM ============================================
REM  ONE-CLICK SELF-HEAL
REM  Double-click whenever the system seems broken.
REM  Detects + fixes everything automatically.
REM ============================================

setlocal EnableDelayedExpansion

set "BASE=C:\Users\Dev\Desktop\Job Agents\job-agent"
set "LOGDIR=%BASE%\setup\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "HEAL_LOG=%LOGDIR%\self_heal.log"

cd /d "%BASE%"

echo.
echo ============================================
echo   JOB AGENT - SELF HEAL
echo ============================================
echo.
echo This will automatically diagnose and fix everything.
echo It takes about 60 seconds. Just wait until you see DONE.
echo.

echo [%date% %time%] === SELF HEAL START === >> "%HEAL_LOG%"

REM === STEP 1: Stop everything ===
echo [1/8] Stopping existing services...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5678" ^| findstr "LISTENING" 2^>nul') do (
    taskkill /F /PID %%a >nul 2>&1
    powershell -NoProfile -Command "Stop-Process -Id %%a -Force -ErrorAction SilentlyContinue" >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":9999" ^| findstr "LISTENING" 2^>nul') do (
    taskkill /F /PID %%a >nul 2>&1
    powershell -NoProfile -Command "Stop-Process -Id %%a -Force -ErrorAction SilentlyContinue" >nul 2>&1
)
timeout /t 3 /nobreak >nul

REM === STEP 2: Check Ollama (start if not running) ===
echo [2/8] Checking Ollama...
curl -s --max-time 2 http://127.0.0.1:11434/api/tags >nul 2>&1
if errorlevel 1 (
    echo       Ollama down. Starting...
    start "" /MIN cmd /c "ollama serve"
    timeout /t 5 /nobreak >nul
)

REM === STEP 3: Verify Playwright Chromium installed ===
echo [3/8] Verifying Playwright Chromium...
if not exist "C:\Users\Dev\AppData\Local\ms-playwright\chromium-1217\chrome-win64\chrome.exe" (
    echo       Chromium missing. Installing...
    cd playwright
    call npx playwright install chromium >> "%HEAL_LOG%" 2>&1
    cd ..
)

REM === STEP 4: Verify playwright-extra + stealth installed ===
echo [4/8] Verifying stealth plugin...
if not exist "%BASE%\playwright\node_modules\playwright-extra" (
    echo       Stealth plugin missing. Installing...
    cd playwright
    call npm install playwright-extra puppeteer-extra-plugin-stealth >> "%HEAL_LOG%" 2>&1
    cd ..
)

REM === STEP 5: Activate all workflows in SQLite ===
echo [5/8] Activating workflows in n8n DB...
python "%BASE%\setup\activate_workflows.py" >> "%HEAL_LOG%" 2>&1

REM === STEP 6: Start helper service ===
echo [6/8] Starting helper service (port 9999)...
powershell -NoProfile -Command "Start-Process -FilePath 'node.exe' -ArgumentList '\"%BASE%\helper-service\server.cjs\"' -WindowStyle Hidden -RedirectStandardOutput '%LOGDIR%\helper-out.log' -RedirectStandardError '%LOGDIR%\helper-err.log'" >nul 2>&1
timeout /t 3 /nobreak >nul

REM === STEP 7: Start n8n with proper env vars ===
echo [7/9] Starting n8n with sandbox bypass (port 5678)...
powershell -NoProfile -Command "$env:NODE_FUNCTION_ALLOW_BUILTIN='*'; $env:NODE_FUNCTION_ALLOW_EXTERNAL='*'; $env:N8N_RUNNERS_ENABLED='false'; Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','n8n start' -WindowStyle Hidden -RedirectStandardOutput '%LOGDIR%\n8n-out.log' -RedirectStandardError '%LOGDIR%\n8n-err.log'" >nul 2>&1

REM === STEP 8: Start dashboard HTTP server ===
echo [8/9] Starting dashboard server (port 8765)...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8765" ^| findstr "LISTENING" 2^>nul') do (
    powershell -NoProfile -Command "Stop-Process -Id %%a -Force -ErrorAction SilentlyContinue" >nul 2>&1
)
timeout /t 2 /nobreak >nul
powershell -NoProfile -Command "Start-Process -FilePath 'node.exe' -ArgumentList '\"%BASE%\dashboard\server.cjs\"' -WindowStyle Hidden -RedirectStandardOutput '%LOGDIR%\dashboard.log' -RedirectStandardError '%LOGDIR%\dashboard-err.log'" >nul 2>&1

REM === STEP 9: Wait for all ports ===
echo [9/9] Waiting for services to come up...
set /a counter=0
:waitloop
timeout /t 2 /nobreak >nul
set "n8n_up=0"
set "helper_up=0"
set "dash_up=0"
netstat -an | findstr ":5678" | findstr "LISTENING" >nul 2>&1 && set "n8n_up=1"
netstat -an | findstr ":9999" | findstr "LISTENING" >nul 2>&1 && set "helper_up=1"
netstat -an | findstr ":8765" | findstr "LISTENING" >nul 2>&1 && set "dash_up=1"
if !n8n_up!==1 if !helper_up!==1 if !dash_up!==1 goto :ready
set /a counter+=1
if !counter! geq 25 goto :failed
goto :waitloop

:ready
echo.
echo ============================================
echo   DONE - All systems live
echo ============================================
echo.
echo Status:
echo   n8n        : http://localhost:5678   RUNNING
echo   Helper     : http://127.0.0.1:9999   RUNNING
echo   Ollama     : http://127.0.0.1:11434  RUNNING
echo   Dashboard  : http://127.0.0.1:8765/dashboard/local.html  RUNNING
echo.
echo Opening dashboard in your browser...
start "" "http://127.0.0.1:8765/dashboard/local.html"
echo.
echo The agent will scrape on its schedule (every 4-6 hours).
echo.
echo [%date% %time%] === SELF HEAL SUCCESS === >> "%HEAL_LOG%"
timeout /t 3 /nobreak >nul
endlocal
exit /b 0

:failed
echo.
echo ============================================
echo   PARTIAL FAILURE
echo ============================================
echo n8n   listening: !n8n_up!  (1=yes)
echo helper listening: !helper_up!  (1=yes)
echo.
echo Check the log file at:
echo %HEAL_LOG%
echo.
echo Run this script AS ADMINISTRATOR if it keeps failing.
echo [%date% %time%] === SELF HEAL FAILED === >> "%HEAL_LOG%"
pause
endlocal
exit /b 1
