@echo off
title Codex Live Viewer
where node >nul 2>&1
if errorlevel 1 ( echo [X] Node.js not found on PATH. Install Node 18+ and retry. & pause & exit /b 1 )
if "%~1"=="" (
  node "%~dp0codex-live-viewer.js" start
  pause
) else (
  node "%~dp0codex-live-viewer.js" %*
)
