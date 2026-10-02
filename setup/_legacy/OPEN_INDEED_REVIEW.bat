@echo off
setlocal
set "BASE=%~dp0.."
set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
set /p "JOB_URL=Paste the Indeed job URL to review: "
if not defined JOB_URL exit /b 1
"%NODE%" "%BASE%\playwright\indeed_review.js" --url "%JOB_URL%"
endlocal
