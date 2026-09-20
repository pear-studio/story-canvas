@echo off
setlocal
cd /d "%~dp0"
call npm --prefix app run comfy:start
set "COMFY_EXIT_CODE=%errorlevel%"
if not "%COMFY_EXIT_CODE%"=="0" goto failed
echo.
echo [OK] ComfyUI is ready. Closing this window will not stop it.
goto finish

:failed
echo.
echo [FAILED] ComfyUI could not be started or verified. Exit code: %COMFY_EXIT_CODE%
echo See the error above. No existing process was stopped.

:finish
echo.
pause
exit /b %COMFY_EXIT_CODE%
