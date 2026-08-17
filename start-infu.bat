@echo off
rem ============================================
rem  InFu Desktop launcher (Windows)
rem  Prioritizes packaged desktop app (release\win-unpacked\InFu.exe);
rem  falls back to source dev mode (electron + built-in agent server).
rem ============================================
chcp 65001 >nul 2>&1
cd /d "%~dp0"

rem ---- cleanup leftover instances ----
taskkill /F /IM InFu.exe >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":4317" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%p >nul 2>&1
)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":9222" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%p >nul 2>&1
)

rem ---- 1) packaged desktop app: launch directly ----
if exist "%~dp0packages\desktop\release\win-unpacked\InFu.exe" (
  echo [InFu] Launching packaged desktop version...
  start "" "%~dp0packages\desktop\release\win-unpacked\InFu.exe"
  exit /b 0
)

rem ---- 2) source dev mode ----
if not exist node_modules (
  echo [InFu] Installing dependencies, please wait...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [InFu] npm install failed. Please run "npm install" manually.
    pause
    exit /b 1
  )
)

rem ---- first run: config wizard ----
if not exist "%USERPROFILE%\.infu\config.json" (
  echo [InFu] First run: creating config template...
  call npm run infu -- --setup
)
findstr /C:"apiKey" "%USERPROFILE%\.infu\config.json" >nul 2>&1
if errorlevel 1 (
  echo [InFu] No API key configured yet. Opening config wizard...
  call npm run config
)

rem ---- build and launch desktop app ----
echo [InFu] Building desktop app...
call npm run build -w @infu/shared
call npm run build -w @infu/agent
call npm run build -w @infu/web
call npm run build -w @infu/desktop
if errorlevel 1 (
  echo [InFu] Build failed. Please check errors above.
  pause
  exit /b 1
)

echo [InFu] Starting desktop app...
echo [InFu] Closing this window stops everything.
call npx electron packages/desktop
pause
