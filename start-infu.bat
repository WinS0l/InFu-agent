@echo off
rem ============================================
rem  InFu one-click launcher (Windows)
rem  All services share ONE console window:
rem  closing the window stops EVERYTHING.
rem ============================================
chcp 65001 >nul 2>&1
cd /d "%~dp0"

rem ---- cleanup leftover instances on port 4317 ----
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":4317" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%p >nul 2>&1
)

if not exist node_modules (
  echo [InFu] Installing dependencies, please wait...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [InFu] npm install failed. Please run "npm install" manually.
    pause
    exit /b 1
  )
)

if not exist "%USERPROFILE%\.infu\config.json" (
  echo [InFu] First run: creating config template...
  call npm run infu -- --setup
)

findstr /C:"apiKey" "%USERPROFILE%\.infu\config.json" >nul 2>&1
if errorlevel 1 (
  echo [InFu] No API key configured yet. Opening config wizard...
  call npm run config
)

rem ---- start Web UI in background (SAME console: closes with window) ----
start /b cmd /c "cd /d %~dp0packages\web && npm run dev" >nul 2>&1

rem ---- start agent service in foreground ----
echo [InFu] Starting agent service + Web UI...
echo [InFu] Closing this window stops everything.
echo [InFu] Opening browser at http://localhost:5174 ...
start "" http://localhost:5174
call npm run start
pause
