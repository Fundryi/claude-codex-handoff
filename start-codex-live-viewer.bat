@echo off
title Codex Live Viewer
where node >nul 2>&1
if errorlevel 1 ( echo [X] Node.js not found on PATH. Install Node 18+ and retry. & pause & exit /b 1 )
if "%CODEX_VIEWER_PORT%"=="" ( set "CODEX_VIEWER_PORT=8377" )
start "" http://localhost:%CODEX_VIEWER_PORT%
node "%~dp0codex-live-viewer.js"
pause
