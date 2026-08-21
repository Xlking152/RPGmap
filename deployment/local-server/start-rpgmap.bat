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

if not exist "%~dp0world" mkdir "%~dp0world"
if not exist "%~dp0world\uploads" mkdir "%~dp0world\uploads"
if not exist "%~dp0world\backups" mkdir "%~dp0world\backups"
if not exist "%~dp0maps" mkdir "%~dp0maps"

set "RPGMAP_PUBLIC_DIR=%~dp0app"
set "RPGMAP_WORLD_DIR=%~dp0world"
set "RPGMAP_MAPS_DIR=%~dp0maps"

echo ============================================================
echo  RPGmap Local Server
echo ============================================================
echo  Local      : http://127.0.0.1:30000
echo  World Data : %RPGMAP_WORLD_DIR%
echo  Map Library: %RPGMAP_MAPS_DIR%
echo ============================================================
echo.
start "" "http://127.0.0.1:30000"
node "%~dp0server.mjs"

if errorlevel 1 (
  echo.
  echo [ERROR] RPGmap server stopped unexpectedly.
  pause
)
