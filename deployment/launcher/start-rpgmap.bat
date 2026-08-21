@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title RPGmap Launcher

where node.exe >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js was not found.
  echo RPGmap requires Node.js 20.19+ or 22.12+.
  echo Install Node.js, then run this launcher again.
  echo.
  pause
  exit /b 1
)

set "RPGMAP_ROOT=%CD%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $node=(Get-Command node.exe).Source; $script=Join-Path $env:RPGMAP_ROOT 'launcher\launcher.mjs'; Start-Process -FilePath $node -ArgumentList @($script) -WorkingDirectory $env:RPGMAP_ROOT -WindowStyle Hidden"
if errorlevel 1 (
  echo.
  echo [ERROR] RPGmap Launcher could not be started.
  echo You can try manually:
  echo   node launcher\launcher.mjs
  echo.
  pause
  exit /b 1
)

exit /b 0
