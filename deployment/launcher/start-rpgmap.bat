@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title RPGmap Launcher Bootstrap

set "RPGMAP_ROOT=%CD%"
set "NODE_EXE="
set "LAUNCHER_SCRIPT=%RPGMAP_ROOT%\launcher\launcher.mjs"
set "STARTUP_LOG=%RPGMAP_ROOT%\launcher-startup.log"

if exist "%RPGMAP_ROOT%\tools\node\node.exe" set "NODE_EXE=%RPGMAP_ROOT%\tools\node\node.exe"
if not defined NODE_EXE if exist "%RPGMAP_ROOT%\node.exe" set "NODE_EXE=%RPGMAP_ROOT%\node.exe"
if not defined NODE_EXE (
  for /f "delims=" %%I in ('where node.exe 2^>nul') do (
    if not defined NODE_EXE set "NODE_EXE=%%I"
  )
)

if not defined NODE_EXE (
  echo.
  echo [ERROR] Node.js was not found.
  echo RPGmap requires Node.js 20.19+ or 22.12+.
  echo.
  echo Install Node.js, then double-click this BAT again.
  echo.
  pause
  exit /b 1
)

if not exist "%LAUNCHER_SCRIPT%" (
  echo.
  echo [ERROR] launcher\launcher.mjs was not found.
  echo Please fully extract the RPGmap ZIP before starting it.
  echo.
  pause
  exit /b 2
)

> "%STARTUP_LOG%" echo [%date% %time%] RPGmap Launcher bootstrap
>> "%STARTUP_LOG%" echo Node: %NODE_EXE%
>> "%STARTUP_LOG%" echo Script: %LAUNCHER_SCRIPT%

echo Starting RPGmap Launcher...
echo The GM Control Center will open in your browser automatically.

start "RPGmap Launcher Runtime" /min cmd /d /c ""%NODE_EXE%" "%LAUNCHER_SCRIPT%" >> "%STARTUP_LOG%" 2^>^&1"
if errorlevel 1 (
  echo.
  echo [ERROR] RPGmap Launcher could not be started.
  echo See: %STARTUP_LOG%
  echo.
  pause
  exit /b 3
)

timeout /t 2 /nobreak >nul
exit /b 0
