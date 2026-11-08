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

# Verify SHA256 checksum of the packaged zip
ZIP_PATH="$(find release -maxdepth 1 -type f -name 'HandCash-*-linux.zip' | head -n 1)"
if [[ -n "$ZIP_PATH" && -f "$ZIP_PATH" ]]; then
  CHECKSUM_PATH="${ZIP_PATH}.sha256"
  if [[ -f "$CHECKSUM_PATH" ]]; then
    echo "==> Verifying checksum…"
    EXPECTED_HASH="$(cut -d' ' -f1 "$CHECKSUM_PATH")"
    ACTUAL_HASH="$(sha256sum "$ZIP_PATH" | cut -d' ' -f1)"
    if [[ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]]; then
      echo "Checksum verification failed!" >&2
      echo "Expected: $EXPECTED_HASH" >&2
      echo "Actual:   $ACTUAL_HASH" >&2
      exit 1
    fi
    echo "==> Checksum verified"
  else
    echo "Warning: No checksum file found at $CHECKSUM_PATH" >&2
  fi
else
  echo "Warning: No packaged zip found for checksum verification" >&2
fi

# Stop a running copy so files are not replaced under it.
pkill -f "$DEST/" 2>/dev/null || true
sleep 1

mkdir -p "$DEST"
rsync -a --delete "$SRC"/ "$DEST"/
echo "==> Installed $(node -p "require('./package.json').version") to $DEST"
