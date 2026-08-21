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

set "RPGMAP_PUBLIC=1"
set "RPGMAP_JOIN_CODE=!JOIN_CODE!"
set "RPGMAP_GM_SECRET=!GM_SECRET!"
set "RPGMAP_PLAYER_WRITE=1"

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

rem Launch Node directly in a new cmd window. Environment variables above
rem are inherited by the child process. This avoids nested BAT quoting issues
rem when RPGmap lives under a path containing spaces or non-ASCII characters.
start "RPGmap Internet Server" /D "%~dp0" cmd.exe /D /K node server.mjs

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
echo [INFO] Tunnel transport: HTTP/2 over TCP compatibility mode.
echo.
echo ============================================================
echo  Look below for a URL like:
echo  https://xxxx-xxxx.trycloudflare.com
echo  Send that URL and Join Code !JOIN_CODE! to remote Players.
echo ============================================================
echo.

rem Force HTTP/2/TCP instead of QUIC/UDP. This is more reliable on networks
rem using VPN/TUN/proxy software, campus networks, and restrictive firewalls.
"!CLOUDFLARED_EXE!" tunnel --no-autoupdate --url http://127.0.0.1:30000 --protocol http2

echo.
echo [INFO] Internet Tunnel stopped.
echo The RPGmap Server may still be running in its separate window.
pause
