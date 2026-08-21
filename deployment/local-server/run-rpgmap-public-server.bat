@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title RPGmap Internet Server

set "RPGMAP_PUBLIC=1"
set "RPGMAP_JOIN_CODE=%~1"
set "RPGMAP_GM_SECRET=%~2"
set "RPGMAP_PLAYER_WRITE=1"

echo ============================================================
echo  RPGmap Internet Multiplayer Server

echo  PUBLIC MODE: ON

echo  Player Join Code: %RPGMAP_JOIN_CODE%
echo  GM Secret:        %RPGMAP_GM_SECRET%
echo ============================================================
echo.
node "%~dp0server.mjs"

echo.
echo [INFO] RPGmap Internet Server stopped.
pause
