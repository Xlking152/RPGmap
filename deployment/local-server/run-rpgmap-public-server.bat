@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title RPGmap Internet Server

if not exist "%~dp0map" mkdir "%~dp0map"
if not exist "%~dp0map\uploads" mkdir "%~dp0map\uploads"
if not exist "%~dp0map\backups" mkdir "%~dp0map\backups"

set "RPGMAP_PUBLIC_DIR=%~dp0app"
set "RPGMAP_MAP_DIR=%~dp0map"
set "RPGMAP_PUBLIC=1"
set "RPGMAP_JOIN_CODE=%~1"
set "RPGMAP_GM_SECRET=%~2"
set "RPGMAP_PLAYER_WRITE=1"

echo ============================================================
echo  RPGmap Internet Multiplayer Server

echo  PUBLIC MODE: ON

echo  Player Join Code: %RPGMAP_JOIN_CODE%
echo  GM Secret:        %RPGMAP_GM_SECRET%
echo  Map Root:         %RPGMAP_MAP_DIR%
echo ============================================================
echo.
node "%~dp0server.mjs"

echo.
echo [INFO] RPGmap Internet Server stopped.
pause
