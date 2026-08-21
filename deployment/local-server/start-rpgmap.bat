@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title RPGmap Local Server

where node >nul 2>nul || (
  echo [ERROR] Node.js not found. Install Node 20.19+ or 22.12+ first.
  pause
  exit /b 1
)

if not exist "%~dp0public\index.html" (
  echo [ERROR] public\index.html is missing. Download the complete GitHub Release package again.
  pause
  exit /b 1
)

echo ============================================================
echo  RPGmap Local Server
echo ============================================================
echo  Local:   http://127.0.0.1:30000
echo ============================================================
echo.
start "" "http://127.0.0.1:30000"
node "%~dp0server.mjs"

if errorlevel 1 (
  echo.
  echo [ERROR] RPGmap server stopped unexpectedly.
  pause
)
