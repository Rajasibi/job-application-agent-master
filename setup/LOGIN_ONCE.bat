@echo off
REM One-time login for Naukri, Indeed and foundit.
REM You type your password into each website yourself; only the session is saved,
REM locally, to playwright\<site>_auth.json. Re-run when a site logs you out.
setlocal
cd /d "%~dp0.."
set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE_EXE%" (
  set "NODE_EXE="
  for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
)
if not defined NODE_EXE (
  echo ERROR: Node.js was not found. Install Node.js or add node.exe to PATH.
  pause
  exit /b 1
)
set "PATH=%ProgramFiles%\nodejs;%APPDATA%\npm;%PATH%"
if not exist "playwright\save_auth.js" (
  echo ERROR: playwright\save_auth.js was not found.
  pause
  exit /b 1
)

echo.
echo ============================================
echo   One-time login (Naukri, Indeed, foundit)
echo ============================================
echo A browser opens for each site. Log in, then come back here and press Enter.
echo Type "skip" instead to skip a site.
echo.

call :login naukri || goto failed
call :login indeed || goto failed
call :login foundit || goto failed

echo.
echo Done. Saved sessions:
dir /b playwright\*_auth.json 2>nul
echo.
echo Next: open the dashboard and click "Retry all login failures".
pause
endlocal
exit /b 0

:login
echo.
echo === %1 ===
"%NODE_EXE%" playwright\save_auth.js %1
exit /b %errorlevel%

:failed
echo.
echo ERROR: Login setup stopped because a site login script failed.
echo No claim of successful setup is made. Fix the error above and run this file again.
pause
endlocal
exit /b 1
