#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
command -v node >/dev/null 2>&1 || { echo "Node.js 20.19+ or 22.12+ is required." >&2; exit 1; }
[ -f "$ROOT/app/index.html" ] || { echo "app/index.html is missing. Download the complete GitHub Release package again." >&2; exit 1; }
mkdir -p "$ROOT/map/uploads" "$ROOT/map/backups"
export RPGMAP_PUBLIC_DIR="$ROOT/app"
export RPGMAP_MAP_DIR="$ROOT/map"
URL="http://127.0.0.1:${PORT:-30000}"
echo "RPGmap Map Root: $RPGMAP_MAP_DIR"
if command -v xdg-open >/dev/null 2>&1; then (sleep 1; xdg-open "$URL" >/dev/null 2>&1 || true) &
elif command -v open >/dev/null 2>&1; then (sleep 1; open "$URL" >/dev/null 2>&1 || true) & fi
exec node "$ROOT/server.mjs"
