@echo off
setlocal

cd /d "%~dp0"

set "WORKBENCH_MODE=%~1"
if not defined WORKBENCH_MODE set "WORKBENCH_MODE=dev"
if /i not "%WORKBENCH_MODE%"=="dev" if /i not "%WORKBENCH_MODE%"=="production" (
  echo Usage: start-workbench.bat [dev^|production]
  pause
  exit /b 1
)
if /i "%WORKBENCH_MODE%"=="dev" set "WORKBENCH_MODE=dev"
if /i "%WORKBENCH_MODE%"=="production" set "WORKBENCH_MODE=production"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 22.13 or newer.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo npm was not found. Check that Node.js is installed and on PATH.
  pause
  exit /b 1
)

if not exist "app\node_modules" (
  echo Installing app dependencies...
  call npm --prefix "%~dp0app" ci
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

if not exist "Config\local.json" (
  echo Initializing local config...
  call npm --prefix "%~dp0app" run setup
  if errorlevel 1 (
    echo Local config initialization failed.
    pause
    exit /b 1
  )
)

if /i "%WORKBENCH_MODE%"=="production" (
  echo Building StoryCanvas for production...
  call npm --prefix "%~dp0app" run build
  if errorlevel 1 (
    echo Build failed. The existing workbench has not been stopped.
    pause
    exit /b 1
  )
)

echo Starting StoryCanvas in %WORKBENCH_MODE% mode...
echo Keep this window open while the workbench is running.
echo Replacing the existing workbench interrupts its active tasks.
node "%~dp0app\scripts\start-workbench.mjs" %WORKBENCH_MODE% --replace
set "WORKBENCH_STATUS=%errorlevel%"

echo Workbench stopped. Exit code: %WORKBENCH_STATUS%
pause
exit /b %WORKBENCH_STATUS%
