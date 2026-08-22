RPGmap portable map data folder
================================

This folder is the only default writable data root for a packaged RPGmap map/campaign.

Generated files:
- world.json   Shared World snapshot and revision
- users.json   Persistent Player Users, default Actor, Ownership and credential hashes

Subfolders:
- uploads/     Map/campaign uploaded assets
- backups/     Future/local backup output

To back up or move the campaign, copy this whole map/ folder together with the RPGmap package.
RPGmap does not need AppData or another hidden user-data directory for World/User persistence.

Legacy migration:
If map/world.json or map/users.json is missing, RPGmap can import an older in-place layout from:
- data/worlds/default/world.json
- data/worlds/default/access.json
The old files are left untouched after migration.
