RPGmap Map Library
==================

This folder is reserved for real map/scene resources and templates.

Future examples:
- maps/lanzhou/
- maps/inn-01/
- maps/dungeon-01/

A map package may contain:
- map metadata / manifest
- background layers
- buildings and walls
- destructible objects
- collision / navigation data
- environmental effects
- damaged / destroyed variants
- map-specific assets

Important distinction:
- maps/ describes what a map or scene is.
- world/ stores what happened to it in the current game World.

Example: a destructible building template belongs in maps/, while its current HP, burning state and destroyed state belong in world/state.json.
