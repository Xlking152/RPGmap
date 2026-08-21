@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title RPGmap Internet Multiplayer

where node >nul 2>nul || (
  echo [ERROR] Node.js not found. Install Node 20.19+ or 22.12+ first.
  pause
  exit /b 1
)

if not exist "%~dp0app\index.html" (
  echo [ERROR] app\index.html is missing. Use a complete Multiplayer test/release package.
  pause
  exit /b 1
)

if not exist "%~dp0internet-launcher.mjs" (
  echo [ERROR] internet-launcher.mjs is missing. Use a complete Multiplayer test/release package.
  pause
  exit /b 1
)

if not exist "%~dp0map" mkdir "%~dp0map"
if not exist "%~dp0map\uploads" mkdir "%~dp0map\uploads"
if not exist "%~dp0map\backups" mkdir "%~dp0map\backups"
set "RPGMAP_PUBLIC_DIR=%~dp0app"
set "RPGMAP_MAP_DIR=%~dp0map"

set "CLOUDFLARED_EXE="
if exist "%~dp0cloudflared.exe" set "CLOUDFLARED_EXE=%~dp0cloudflared.exe"
if not defined CLOUDFLARED_EXE (
  for /f "delims=" %%I in ('where cloudflared.exe 2^>nul') do if not defined CLOUDFLARED_EXE set "CLOUDFLARED_EXE=%%I"
)

if not defined CLOUDFLARED_EXE (
  echo [INFO] cloudflared is not available yet.
  echo [INFO] Running setup-cloudflared.bat ...
  call "%~dp0setup-cloudflared.bat"
  if exist "%~dp0cloudflared.exe" set "CLOUDFLARED_EXE=%~dp0cloudflared.exe"
  if not defined CLOUDFLARED_EXE (
    for /f "delims=" %%I in ('where cloudflared.exe 2^>nul') do if not defined CLOUDFLARED_EXE set "CLOUDFLARED_EXE=%%I"
  )
)

if not defined CLOUDFLARED_EXE (
  echo [ERROR] cloudflared is still unavailable.
  echo See setup-cloudflared.bat output or place cloudflared.exe beside this BAT.
  pause
  exit /b 1
)

echo [OK] Using cloudflared: !CLOUDFLARED_EXE!
"!CLOUDFLARED_EXE!" --version
if errorlevel 1 (
  echo [ERROR] cloudflared exists but could not run.
  pause
  exit /b 1
)

set "RPGMAP_CLOUDFLARED_EXE=!CLOUDFLARED_EXE!"
set "RPGMAP_PLAYER_WRITE=1"

echo.
echo [INFO] Starting integrated Internet Multiplayer flow...
echo [INFO] Program files: app\
echo [INFO] Map/User data: map\
echo [INFO] The launcher will create the Quick Tunnel first, attach its
echo        public URL to RPGmap Server, then open the public page.
echo.

node "%~dp0internet-launcher.mjs"
set "EXIT_CODE=!ERRORLEVEL!"

echo.
if not "!EXIT_CODE!"=="0" echo [ERROR] RPGmap Internet Multiplayer exited with code !EXIT_CODE!.
if "!EXIT_CODE!"=="0" echo [INFO] RPGmap Internet Multiplayer stopped.
pause
exit /b !EXIT_CODE!
