@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title RPGmap Internet Setup

echo ============================================================
echo  RPGmap Internet Test - cloudflared setup
echo ============================================================
echo.

rem 1. Prefer a portable cloudflared.exe placed beside RPGmap.
if exist "%~dp0cloudflared.exe" (
  echo [OK] Found local cloudflared.exe.
  "%~dp0cloudflared.exe" --version
  if not errorlevel 1 exit /b 0
  echo [WARN] Local cloudflared.exe exists but could not run.
)

rem 2. Accept an existing system installation (for example Winget/MSI).
where cloudflared.exe >nul 2>nul
if not errorlevel 1 (
  echo [OK] Found cloudflared.exe in PATH.
  cloudflared.exe --version
  if not errorlevel 1 exit /b 0
)

set "URL=https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
set "TARGET=%~dp0cloudflared.exe"
set "TEMPFILE=%~dp0cloudflared.exe.download"
set "DOWNLOAD_OK="

del /q "%TEMPFILE%" >nul 2>nul

rem 3. Try curl first when available.
where curl.exe >nul 2>nul
if not errorlevel 1 (
  echo [INFO] Trying GitHub Release download with curl...
  curl.exe -L --fail --retry 2 --connect-timeout 15 --output "%TEMPFILE%" "%URL%"
  if not errorlevel 1 if exist "%TEMPFILE%" set "DOWNLOAD_OK=1"
)

rem 4. If curl failed, retry independently with PowerShell.
if not defined DOWNLOAD_OK (
  del /q "%TEMPFILE%" >nul 2>nul
  echo [INFO] curl download failed or was unavailable. Trying PowerShell...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; try { Invoke-WebRequest -UseBasicParsing -Uri '%URL%' -OutFile '%TEMPFILE%' -TimeoutSec 60; exit 0 } catch { Write-Host $_.Exception.Message; exit 1 }"
  if not errorlevel 1 if exist "%TEMPFILE%" set "DOWNLOAD_OK=1"
)

if defined DOWNLOAD_OK (
  move /y "%TEMPFILE%" "%TARGET%" >nul
  if errorlevel 1 (
    echo [ERROR] Download succeeded but cloudflared.exe could not be installed.
    pause
    exit /b 1
  )
  "%TARGET%" --version
  if errorlevel 1 (
    echo [ERROR] Downloaded cloudflared.exe could not run.
    pause
    exit /b 1
  )
  echo.
  echo [OK] Internet tunnel helper is ready.
  exit /b 0
)

rem 5. GitHub Release may be blocked or unstable on some networks.
rem    Try Windows Package Manager as another installation route.
where winget.exe >nul 2>nul
if not errorlevel 1 (
  echo.
  echo [INFO] Direct download failed. Trying Winget package Cloudflare.cloudflared...
  winget install --id Cloudflare.cloudflared --exact --accept-package-agreements --accept-source-agreements
  where cloudflared.exe >nul 2>nul
  if not errorlevel 1 (
    echo [OK] cloudflared was installed through Winget.
    cloudflared.exe --version
    exit /b 0
  )
)

echo.
echo [ERROR] cloudflared download/install failed.
echo.
echo This usually means GitHub Release Assets are unreachable from the current network.
echo Manual fix:
echo   1. Open the official Cloudflare Tunnel Downloads page.
echo   2. Download Windows 64-bit Executable.
echo   3. Rename it to cloudflared.exe.
echo   4. Put cloudflared.exe in this folder:
echo      %~dp0
echo   5. Run start-rpgmap-internet.bat again.
echo.
echo You can also install it separately with:
echo   winget install --id Cloudflare.cloudflared --exact
echo.
pause
exit /b 1
