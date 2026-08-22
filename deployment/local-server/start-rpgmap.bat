@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title RPGmap Local / LAN Server

where node >nul 2>nul || (
  echo [ERROR] Node.js not found. Install Node 20.19+ or 22.12+ first.
  pause
  exit /b 1
)

if not exist "%~dp0app\index.html" (
  echo [ERROR] app\index.html is missing. Download the complete GitHub Release package again.
  pause
  exit /b 1
)

if not exist "%~dp0local-launcher.mjs" (
  echo [ERROR] local-launcher.mjs is missing. Download the complete GitHub Release package again.
  pause
  exit /b 1
)

if not exist "%~dp0launcher-guard.mjs" (
  echo [ERROR] launcher-guard.mjs is missing. Download the complete GitHub Release package again.
  pause
  exit /b 1
)

if not exist "%~dp0map" mkdir "%~dp0map"
if not exist "%~dp0map\uploads" mkdir "%~dp0map\uploads"
if not exist "%~dp0map\backups" mkdir "%~dp0map\backups"

set "RPGMAP_PUBLIC_DIR=%~dp0app"
set "RPGMAP_MAP_DIR=%~dp0map"
set "RPGMAP_PUBLIC=0"
set "RPGMAP_PUBLIC_URL="
set "RPGMAP_JOIN_CODE="
set "RPGMAP_GM_SECRET="

echo [INFO] Local/LAN mode is mutually exclusive with Internet mode.
echo [INFO] The browser will open only after the Server health check passes.
echo.
node "%~dp0local-launcher.mjs"

if errorlevel 1 (
  echo.
  echo [ERROR] RPGmap Local/LAN launcher stopped with an error.
  pause
)
