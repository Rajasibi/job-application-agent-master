@echo off
echo Scheduled startup task installation is disabled in manual-review mode.
exit /b 1
REM RUN AS ADMINISTRATOR (right-click > Run as administrator)
REM Replaces the SoulInMotion-n8n scheduled task with one that boots BOTH:
REM   - Soul in Motion's n8n (still works)
REM   - Job Agent helper service + workflow activation
REM
REM This is the permanent fix for "after reboot, nothing works".

echo.
echo ============================================
echo   Installing boot task for Job Agent + Soul
echo ============================================
echo.

set "BASE=C:\Users\Dev\Desktop\Job Agents\job-agent"

REM Delete old SoulInMotion-n8n task (if exists) - it only ran n8n with no env vars
schtasks /Query /TN "SoulInMotion-n8n" >nul 2>&1
if %errorlevel%==0 (
    echo Removing old SoulInMotion-n8n task...
    schtasks /Delete /TN "SoulInMotion-n8n" /F >nul 2>&1
)

REM Delete our task if it exists (for re-installs)
schtasks /Delete /TN "JobAgent-Boot" /F >nul 2>&1

REM Create the new task that runs at user login
echo Creating JobAgent-Boot scheduled task...
schtasks /Create /TN "JobAgent-Boot" ^
    /TR "\"%BASE%\setup\boot_everything.bat\"" ^
    /SC ONLOGON ^
    /RL LIMITED ^
    /F

if errorlevel 1 (
    echo.
    echo ERROR: Could not create scheduled task.
    echo Try running this BAT as administrator.
    pause
    exit /b 1
)

echo.
echo Task created. Triggering it now...
schtasks /Run /TN "JobAgent-Boot"

echo.
echo ============================================
echo   DONE
echo ============================================
echo.
echo Job Agent will now auto-start at every login.
echo Boot log: %BASE%\setup\logs\boot.log
echo.
echo Next steps:
echo   1. Wait 30 seconds for services to come up
echo   2. Open dashboard\OPEN_DASHBOARD.bat to verify
echo.
pause
