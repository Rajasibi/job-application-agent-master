@echo off
REM Opens the dashboard (starts the agent first if it is not running).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\setup\start.ps1"
