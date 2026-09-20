@echo off
setlocal
cd /d "%~dp0"
set "COMFY_TARGET="
for /f "delims=" %%I in ('node app/scripts/comfy-runtime-cli.mjs target') do set "COMFY_TARGET=%%I"
if not defined COMFY_TARGET (
  echo Failed to resolve the local ComfyUI target.
  set "COMFY_EXIT_CODE=1"
  goto finish
)

tailscale serve --bg --tcp=8188 %COMFY_TARGET%
set "COMFY_EXIT_CODE=%errorlevel%"
if not "%COMFY_EXIT_CODE%"=="0" goto failed
echo.
echo [OK] Tailscale Serve is configured. ComfyUI was not started.
echo This mapping persists. Configure again only when the target changes.
goto finish

:failed
echo.
echo [FAILED] Tailscale Serve configuration failed. See the error above.
echo Run this configuration script as administrator.

:finish
echo.
pause
exit /b %COMFY_EXIT_CODE%
