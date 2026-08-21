@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title RPGmap Internet Setup

echo ============================================================
echo  RPGmap Internet Test - cloudflared setup

echo  This downloads the official Windows amd64 cloudflared binary

echo  from the Cloudflare GitHub release page.
echo ============================================================
echo.

if exist "%~dp0cloudflared.exe" (
  echo [OK] cloudflared.exe already exists.
  "%~dp0cloudflared.exe" --version
  pause
  exit /b 0
)

set "URL=https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
set "TARGET=%~dp0cloudflared.exe"
set "TEMPFILE=%~dp0cloudflared.exe.download"

echo [INFO] Downloading cloudflared...

where curl.exe >nul 2>nul
if not errorlevel 1 (
  curl.exe -L --fail --retry 2 --output "%TEMPFILE%" "%URL%"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing -Uri '%URL%' -OutFile '%TEMPFILE%'"
)

if errorlevel 1 (
  echo.
  echo [ERROR] cloudflared download failed.
  del /q "%TEMPFILE%" >nul 2>nul
  pause
  exit /b 1
)

move /y "%TEMPFILE%" "%TARGET%" >nul
if errorlevel 1 (
  echo [ERROR] Could not install cloudflared.exe.
  pause
  exit /b 1
)

echo.
"%TARGET%" --version
if errorlevel 1 (
  echo [ERROR] cloudflared.exe could not run.
  pause
  exit /b 1
)

echo.
echo [OK] Internet tunnel helper is ready.
echo Next run: start-rpgmap-internet.bat
pause
