#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
command -v node >/dev/null 2>&1 || { echo "Node.js 20.19+ or 22.12+ is required." >&2; exit 1; }
[ -f "$ROOT/app/index.html" ] || { echo "app/index.html is missing. Download the complete GitHub Release package again." >&2; exit 1; }
[ -f "$ROOT/local-launcher.mjs" ] || { echo "local-launcher.mjs is missing. Download the complete GitHub Release package again." >&2; exit 1; }
[ -f "$ROOT/launcher-guard.mjs" ] || { echo "launcher-guard.mjs is missing. Download the complete GitHub Release package again." >&2; exit 1; }
mkdir -p "$ROOT/map/uploads" "$ROOT/map/backups"
export RPGMAP_PUBLIC_DIR="$ROOT/app"
export RPGMAP_MAP_DIR="$ROOT/map"
export RPGMAP_PUBLIC=0
unset RPGMAP_PUBLIC_URL RPGMAP_JOIN_CODE RPGMAP_GM_SECRET 2>/dev/null || true
exec node "$ROOT/local-launcher.mjs"
