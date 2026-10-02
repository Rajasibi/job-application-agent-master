@echo off
REM RIGHT-CLICK THIS FILE > "Run as administrator"
REM Kills the orphaned n8n process holding port 5678 and restarts cleanly.

echo.
echo ============================================
echo   Killing orphaned n8n on port 5678
echo ============================================
echo.

for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5678" ^| findstr "LISTENING"') do (
    echo Killing PID %%a ...
    taskkill /F /PID %%a
)

timeout /t 3 /nobreak >nul

netstat -aon | findstr ":5678" | findstr "LISTENING" >nul
if %errorlevel%==0 (
    echo.
    echo FAILED: Port 5678 is still in use.
    pause
    exit /b 1
)

echo.
echo Port 5678 is FREE. Starting n8n in a new window...
echo.

start "n8n" cmd /k "n8n start"

timeout /t 5 /nobreak >nul

echo.
echo ============================================
echo   n8n restarted. Workflows now active.
echo ============================================
echo.
echo You can close this window.
pause
