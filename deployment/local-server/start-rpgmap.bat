@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title RPGmap Local Server

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

if not exist "%~dp0map" mkdir "%~dp0map"
if not exist "%~dp0map\uploads" mkdir "%~dp0map\uploads"
if not exist "%~dp0map\backups" mkdir "%~dp0map\backups"

set "RPGMAP_PUBLIC_DIR=%~dp0app"
set "RPGMAP_MAP_DIR=%~dp0map"

echo ============================================================
echo  RPGmap Local Server

echo  Local    : http://127.0.0.1:30000

echo  Map Root : %RPGMAP_MAP_DIR%

echo ============================================================
echo.
start "" "http://127.0.0.1:30000"
node "%~dp0server.mjs"

if errorlevel 1 (
  echo.
  echo [ERROR] RPGmap server stopped unexpectedly.
  pause
)
