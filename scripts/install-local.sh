#!/usr/bin/env bash
# Package the Linux build and install it over the local copy the desktop
# launcher (~/.local/share/applications/handcash.desktop) starts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DEST="${HANDCASH_INSTALL_DIR:-$HOME/Applications/handcash/HandCash}"

echo "==> Packaging…"
npm run package:linux

SRC="$(find release -maxdepth 2 -type d -name HandCash -path 'release/linux-*' | head -n 1)"
if [[ -z "$SRC" || ! -x "$SRC/HandCash" ]]; then
  echo "packaged HandCash not found under release/linux-*" >&2
  exit 1
fi

# Stop a running copy so files are not replaced under it.
pkill -f "$DEST/" 2>/dev/null || true
sleep 1

mkdir -p "$DEST"
rsync -a --delete "$SRC"/ "$DEST"/
echo "==> Installed $(node -p "require('./package.json').version") to $DEST"
