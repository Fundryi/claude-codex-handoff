@echo off
title Stop Codex Live Viewer
if "%CODEX_VIEWER_PORT%"=="" ( set "CODEX_VIEWER_PORT=8377" )
echo Stopping Codex Live Viewer on port %CODEX_VIEWER_PORT%...
powershell -NoProfile -Command "$c=Get-NetTCPConnection -LocalPort %CODEX_VIEWER_PORT% -State Listen -ErrorAction SilentlyContinue; if($c){ $c | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }; Write-Host '[OK] Viewer stopped.' } else { Write-Host '[i] Viewer was not running.' }"
pause
