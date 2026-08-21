@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "RPGMAP_RUNTIME=%~dp0launcher\rpgmap-runtime.ps1"

if not exist "%RPGMAP_RUNTIME%" (
  echo.
  echo [ERROR] launcher\rpgmap-runtime.ps1 was not found.
  echo Please fully extract the RPGmap ZIP before starting it.
  echo.
  pause
  exit /b 2
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%RPGMAP_RUNTIME%"
set "RPGMAP_EXIT=%ERRORLEVEL%"

if not "%RPGMAP_EXIT%"=="0" (
  echo.
  echo RPGmap Runtime exited with code %RPGMAP_EXIT%.
  pause
)

exit /b %RPGMAP_EXIT%
