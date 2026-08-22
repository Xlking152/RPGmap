@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title RPGmap Launcher

where node >nul 2>nul || (
  echo [ERROR] Node.js not found. Install Node 20.19+ or 22.12+ first.
  pause
  exit /b 1
)

node "%~dp0launcher.mjs" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] RPGmap launcher exited with code %EXIT_CODE%.
  pause
)

exit /b %EXIT_CODE%
