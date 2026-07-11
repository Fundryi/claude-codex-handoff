@echo off
title Codex Live Viewer
where node >nul 2>&1
if errorlevel 1 ( echo [X] Node.js not found on PATH. Install Node 18+ and retry. & pause & exit /b 1 )
if "%CODEX_VIEWER_PORT%"=="" ( set "CODEX_VIEWER_PORT=8377" )

if /i "%~1"=="tray" (
  start "" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0codex-viewer-tray.ps1"
  exit /b
)

echo [i] Viewer runs while this window is open. Close it (or Ctrl+C) to stop.
echo [i] Tray mode instead: codex-viewer.bat tray
start "" http://localhost:%CODEX_VIEWER_PORT%
node "%~dp0codex-live-viewer.js" serve
pause
