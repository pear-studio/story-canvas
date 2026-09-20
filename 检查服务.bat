@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
node app/scripts/service-status-cli.mjs
set "SERVICE_STATUS=%errorlevel%"
echo.
pause
exit /b %SERVICE_STATUS%
