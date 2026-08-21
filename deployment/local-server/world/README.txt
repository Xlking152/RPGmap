RPGmap portable World data folder
=================================

This folder stores mutable state for the current RPGmap game World.

Generated files:
- state.json   Shared World snapshot and revision
- users.json   Persistent Player Users, default Actor, Ownership and credential hashes

Subfolders:
- uploads/     World/campaign uploaded assets
- backups/     Local backup output

Backup rule:
- Back up world/ to preserve the current game/campaign state.
- Program files in app/ can be replaced during upgrades.
- Map templates/resources belong in maps/, not here.

RPGmap does not need AppData or another hidden user-data directory for World/User persistence.

Legacy migration:
If world/state.json or world/users.json is missing, RPGmap can import from V1.4.1:
- map/world.json
- map/users.json
and from older layouts:
- data/worlds/default/world.json
- data/worlds/default/access.json
Legacy files are left untouched after migration.
