@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title RPGmap Internet Multiplayer

where node >nul 2>nul || (
  echo [ERROR] Node.js not found. Install Node 20.19+ or 22.12+ first.
  pause
  exit /b 1
)

if not exist "%~dp0public\index.html" (
  echo [ERROR] public\index.html is missing. Use a complete Multiplayer test/release package.
  pause
  exit /b 1
)

if not exist "%~dp0cloudflared.exe" (
  echo [INFO] cloudflared.exe is not installed yet.
  echo [INFO] Running setup-cloudflared.bat ...
  call "%~dp0setup-cloudflared.bat"
  if errorlevel 1 exit /b 1
)

for /f %%I in ('node -e "console.log(require('node:crypto').randomInt(100000,1000000))"') do set "JOIN_CODE=%%I"
for /f %%I in ('node -e "console.log(require('node:crypto').randomBytes(8).toString('hex').toUpperCase())"') do set "GM_SECRET=%%I"

if not defined JOIN_CODE (
  echo [ERROR] Could not generate Player Join Code.
  pause
  exit /b 1
)
if not defined GM_SECRET (
  echo [ERROR] Could not generate GM Secret.
  pause
  exit /b 1
)

echo ============================================================
echo  RPGmap Internet Multiplayer Test

echo  Player Join Code: !JOIN_CODE!
echo  GM Secret:        !GM_SECRET!
echo ============================================================
echo.
echo [IMPORTANT]
echo  Share with Players: the HTTPS trycloudflare.com URL + Join Code.
echo  DO NOT share the GM Secret with Players.
echo.
echo  The GM browser should use:
echo    Role      : GM

echo    GM Secret : !GM_SECRET!
echo.

start "RPGmap Internet Server" "%~dp0run-rpgmap-public-server.bat" "!JOIN_CODE!" "!GM_SECRET!"

set "READY="
for /l %%N in (1,1,20) do (
  if not defined READY (
    powershell -NoProfile -Command "try { $r=Invoke-RestMethod -TimeoutSec 1 http://127.0.0.1:30000/api/health; if ($r.status -eq 'ok') { exit 0 } } catch {}; exit 1" >nul 2>nul
    if not errorlevel 1 set "READY=1"
    if not defined READY timeout /t 1 /nobreak >nul
  )
)

if not defined READY (
  echo [ERROR] RPGmap Server did not become ready on port 30000.
  echo Check the separate RPGmap Internet Server window.
  pause
  exit /b 1
)

start "" "http://127.0.0.1:30000"

echo [OK] RPGmap Server is ready.
echo [INFO] Starting Cloudflare Quick Tunnel...
echo.
echo ============================================================
echo  Look below for a URL like:
echo  https://xxxx-xxxx.trycloudflare.com

echo  Send that URL and Join Code !JOIN_CODE! to remote Players.
echo ============================================================
echo.

"%~dp0cloudflared.exe" tunnel --no-autoupdate --url http://127.0.0.1:30000

echo.
echo [INFO] Internet Tunnel stopped.
echo The RPGmap Server may still be running in its separate window.
pause
