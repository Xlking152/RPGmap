#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
command -v node >/dev/null 2>&1 || { echo "Node.js 20.19+ or 22.12+ is required." >&2; exit 1; }
exec node "$ROOT/launcher.mjs" "${1:-local}"
