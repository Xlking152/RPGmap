@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title RPGmap Internet Server

if not exist "%~dp0world" mkdir "%~dp0world"
if not exist "%~dp0world\uploads" mkdir "%~dp0world\uploads"
if not exist "%~dp0world\backups" mkdir "%~dp0world\backups"
if not exist "%~dp0maps" mkdir "%~dp0maps"

set "RPGMAP_PUBLIC_DIR=%~dp0app"
set "RPGMAP_WORLD_DIR=%~dp0world"
set "RPGMAP_MAPS_DIR=%~dp0maps"
set "RPGMAP_PUBLIC=1"
set "RPGMAP_JOIN_CODE=%~1"
set "RPGMAP_GM_SECRET=%~2"
set "RPGMAP_PLAYER_WRITE=1"

echo ============================================================
echo  RPGmap Internet Multiplayer Server

echo  PUBLIC MODE: ON

echo  Player Join Code: %RPGMAP_JOIN_CODE%
echo  GM Secret:        %RPGMAP_GM_SECRET%
echo  World Data:       %RPGMAP_WORLD_DIR%
echo  Map Library:      %RPGMAP_MAPS_DIR%
echo ============================================================
echo.
node "%~dp0server.mjs"

echo.
echo [INFO] RPGmap Internet Server stopped.
pause
