@echo off
setlocal

cd /d "%~dp0"

where tailscale >nul 2>&1
if errorlevel 1 (
  echo Tailscale was not found. Install Tailscale and make sure it is on PATH.
  pause
  exit /b 1
)

tailscale status >nul 2>&1
if errorlevel 1 (
  echo Tailscale is not connected. Sign in and connect this device first.
  pause
  exit /b 1
)

set "WORKBENCH_TARGET="
for /f "delims=" %%I in ('node app/scripts/workbench-runtime-cli.mjs target') do set "WORKBENCH_TARGET=%%I"
if not defined WORKBENCH_TARGET (
  echo Failed to resolve the local workbench target. Check the local config.
  pause
  exit /b 1
)

echo Publishing StoryCanvas to this tailnet...
tailscale serve --bg %WORKBENCH_TARGET%
if errorlevel 1 (
  echo Tailscale Serve setup failed.
  echo Run this configuration script as administrator.
  pause
  exit /b 1
)

echo.
tailscale serve status
set "WORKBENCH_STATUS=%errorlevel%"
if not "%WORKBENCH_STATUS%"=="0" (
  echo Failed to read the published address. See the error above.
  pause
  exit /b %WORKBENCH_STATUS%
)
echo [OK] Tailscale Serve is configured. The workbench was not started.
echo This mapping persists. Configure again only when the target changes.
echo.

pause
exit /b 0
