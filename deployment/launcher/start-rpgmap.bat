@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title RPGmap Launcher Runtime

set "RPGMAP_ROOT=%CD%"
set "NODE_EXE="
set "LAUNCHER_SCRIPT=%RPGMAP_ROOT%\launcher\launcher.mjs"
set "STARTUP_LOG=%RPGMAP_ROOT%\launcher-startup.log"

if exist "%RPGMAP_ROOT%\tools\node\node.exe" set "NODE_EXE=%RPGMAP_ROOT%\tools\node\node.exe"
if not defined NODE_EXE if exist "%RPGMAP_ROOT%\node.exe" set "NODE_EXE=%RPGMAP_ROOT%\node.exe"
if not defined NODE_EXE (
  where node.exe >nul 2>nul
  if not errorlevel 1 set "NODE_EXE=node.exe"
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

echo ============================================================
echo  RPGmap Launcher Runtime
echo ============================================================
echo  The GM Control Center will open in your browser.
echo  Keep this window open while using RPGmap.
echo  You can minimize this window.
echo  Startup info: launcher-startup.log
echo ============================================================
echo.

"%NODE_EXE%" "%LAUNCHER_SCRIPT%"
set "RPGMAP_EXIT=%ERRORLEVEL%"

if not "%RPGMAP_EXIT%"=="0" (
  echo.
  echo [ERROR] RPGmap Launcher stopped unexpectedly. Exit code: %RPGMAP_EXIT%
  echo You can also run manually:
  echo   node launcher\launcher.mjs
  echo.
  pause
)

exit /b %RPGMAP_EXIT%
