@echo off
REM Starts Ollama, the helper service, n8n and the dashboard, then opens the dashboard.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\start.ps1"
pause
