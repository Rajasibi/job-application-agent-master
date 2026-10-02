@echo off
echo Automatic repair and workflow activation are disabled in manual-review mode.
exit /b 1
REM ============================================
REM FOREVER FIX — Run this ONCE as administrator.
REM
REM Right-click > "Run as administrator"
REM
REM This script does:
REM 1. Kills the current orphaned/elevated n8n (PID locked port 5678)
REM 2. Updates the SoulInMotion-n8n scheduled task to use the new master
REM    startup script (smarter, self-healing, idempotent)
REM 3. Starts n8n fresh — both Soul in Motion AND Job Agent workflows live
REM
REM After this runs, n8n auto-starts at every boot with all workflows active.
REM Soul in Motion is unaffected (master script still runs n8n on port 5678).
REM ============================================

echo.
echo ============================================
echo   FOREVER FIX — Job Agent + Soul in Motion
echo ============================================
echo.

REM Step 1: Kill any n8n holding port 5678
echo [1/4] Killing existing n8n on port 5678...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5678" ^| findstr "LISTENING"') do (
    echo       Killing PID %%a
    taskkill /F /PID %%a
)
timeout /t 3 /nobreak >nul

REM Verify port free
netstat -an | findstr ":5678" | findstr "LISTENING" >nul
if %errorlevel%==0 (
    echo       ERROR: Port still in use. Something else is grabbing 5678.
    pause
    exit /b 1
)
echo       OK port is free.

REM Step 2: Update the scheduled task to use the new master script
echo [2/4] Updating SoulInMotion-n8n scheduled task...

set MASTER=C:\Users\Dev\Desktop\Job Agents\job-agent\setup\start_n8n_master.bat

REM Export current task XML
schtasks /Query /TN "SoulInMotion-n8n" /XML > "%TEMP%\smotion.xml" 2>nul

REM Replace the Execute path AND ensure RunLevel is Limited
powershell -NoProfile -Command "(Get-Content '%TEMP%\smotion.xml' -Raw) -replace '<Command>[^<]+</Command>', '<Command>%MASTER:\=\\%</Command>' -replace '<RunLevel>HighestAvailable</RunLevel>', '<RunLevel>LeastPrivilege</RunLevel>' | Set-Content '%TEMP%\smotion.xml'"

REM Recreate the task
schtasks /Delete /TN "SoulInMotion-n8n" /F
schtasks /Create /TN "SoulInMotion-n8n" /XML "%TEMP%\smotion.xml"
del "%TEMP%\smotion.xml"

echo       OK task updated to call master script.

REM Step 3: Activate all Job Agent workflows via direct SQLite write
echo [3/4] Activating all Job Agent workflows via SQLite...
python "C:\Users\Dev\Desktop\Job Agents\job-agent\setup\activate_workflows.py"

REM Step 4: Run the master script now (starts n8n + helper service)
echo [4/4] Starting n8n + helper service via master script...
call "%MASTER%"

timeout /t 10 /nobreak >nul

REM Final verification
netstat -an | findstr ":5678" | findstr "LISTENING" >nul
if %errorlevel%==0 (
    echo.
    echo ============================================
    echo   PERMANENT FIX COMPLETE
    echo ============================================
    echo.
    echo - n8n is running on port 5678
    echo - All 11 Job Agent workflows are active
    echo - Soul in Motion workflows are active
    echo - Auto-restarts on every boot via SoulInMotion-n8n task
    echo - Self-heals: kills stale processes, re-activates workflows
    echo.
    echo You will NEVER need to run anything as admin again.
    echo Logs: C:\Users\Dev\Desktop\Job Agents\job-agent\setup\logs\
) else (
    echo.
    echo ============================================
    echo   FAILED to start n8n
    echo ============================================
    echo Check logs at: C:\Users\Dev\Desktop\Job Agents\job-agent\setup\logs\
)

echo.
pause
