RPGmap Map Library
==================

This folder stores real map/scene resources and templates used by RPGmap at runtime.

V1.4.3 default layout:
- index.json                                  Runtime map registry
- northern-song-lanzhou-1104/map.json        Default MapPackage definition
- northern-song-lanzhou-1104/assets/          Map-specific WebP resources
- northern-song-lanzhou-1104/README.txt       Per-map notes

MapPackage content may include:
- map metadata / manifest
- SVG/background layers
- buildings and walls
- destructible objects
- collision / navigation data
- environmental effects
- damaged / destroyed variants
- map-specific assets

Important distinction:
- maps/ describes what a map or scene IS.
- world/ stores what happened to it in the current game World.

Example:
- building geometry, base art and destruction templates belong in maps/.
- current building damage, fire state, destroyed parts and campaign history belong in world/state.json.

Runtime note for Windows packages:
RPGmap.bat starts the PowerShell Runtime, which creates app/maps as a Windows directory junction pointing back to this root maps/ folder. The files are NOT duplicated. The browser therefore reads these real map files while app/ remains replaceable program code.

Future Scene Manager / World Manager work should build on index.json instead of hard-coding map content back into the web bundle.
