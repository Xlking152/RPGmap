#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
command -v node >/dev/null 2>&1 || { echo "Node.js 20.19+ or 22.12+ is required." >&2; exit 1; }
[ -f "$ROOT/public/index.html" ] || { echo "public/index.html is missing. Download the complete GitHub Release package again." >&2; exit 1; }
URL="http://127.0.0.1:${PORT:-30000}"
if command -v xdg-open >/dev/null 2>&1; then (sleep 1; xdg-open "$URL" >/dev/null 2>&1 || true) &
elif command -v open >/dev/null 2>&1; then (sleep 1; open "$URL" >/dev/null 2>&1 || true) & fi
exec node "$ROOT/server.mjs"
