@echo off
REM RIGHT-CLICK > "Run as administrator" — ONE TIME ONLY.
REM This makes the SoulInMotion-n8n scheduled task start n8n WITHOUT admin elevation.
REM Soul in Motion functionality is unchanged. Only difference: n8n is now manageable
REM from normal user shells (so Job Agent can bounce it without UAC popups).

echo.
echo ============================================
echo   Fixing SoulInMotion-n8n scheduled task
echo ============================================
echo.
echo This changes RunLevel from "Highest" to "Limited".
echo Soul in Motion will keep working exactly as before.
echo.

REM Export current task to XML
schtasks /Query /TN "SoulInMotion-n8n" /XML > "%TEMP%\smotion_task.xml" 2>nul
if errorlevel 1 (
    echo ERROR: Could not export task. Make sure you ran this AS ADMINISTRATOR.
    pause
    exit /b 1
)

REM Replace HighestAvailable with LeastPrivilege using PowerShell
powershell -NoProfile -Command "(Get-Content '%TEMP%\smotion_task.xml') -replace '<RunLevel>HighestAvailable</RunLevel>', '<RunLevel>LeastPrivilege</RunLevel>' | Set-Content '%TEMP%\smotion_task.xml'"

REM Delete old task and create new one with same name
schtasks /Delete /TN "SoulInMotion-n8n" /F
schtasks /Create /TN "SoulInMotion-n8n" /XML "%TEMP%\smotion_task.xml"

if errorlevel 1 (
    echo ERROR: Could not recreate task. Backup at %TEMP%\smotion_task.xml
    pause
    exit /b 1
)

del "%TEMP%\smotion_task.xml"

echo.
echo ============================================
echo   Task fixed!
echo ============================================
echo.
echo Now killing the currently-running elevated n8n...
echo.

for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5678" ^| findstr "LISTENING"') do (
    echo Killing PID %%a ...
    taskkill /F /PID %%a
)

timeout /t 3 /nobreak >nul

echo.
echo Starting n8n fresh as normal user (no admin)...
start "" /MIN cmd /c "n8n start"

timeout /t 5 /nobreak >nul

echo.
echo ============================================
echo   ALL DONE
echo ============================================
echo.
echo - Soul in Motion: still running, will auto-start on every boot
echo - Job Agent: now active and can bounce n8n freely
echo.
echo You will not need this script again.
pause
