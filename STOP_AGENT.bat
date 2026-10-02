@echo off
REM Stops the helper service, n8n and the dashboard started by START_AGENT.bat.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\stop.ps1"
pause
