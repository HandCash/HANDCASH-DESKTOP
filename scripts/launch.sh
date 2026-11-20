#!/usr/bin/env bash
# Build the packaged thin Linux native shell and launch it (production layout + IndexedDB origin).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "On macOS use: npm run launch:mac" >&2
  exit 1
fi

ARCH="$(uname -m)"
case "$ARCH" in
  aarch64|arm64) OUT_ARCH="arm64" ;;
  *) OUT_ARCH="x64" ;;
esac

APP_DIR="release/linux-${OUT_ARCH}/HandCash"
BIN="$APP_DIR/HandCash"

echo "==> Packaging Linux thin native shell (${OUT_ARCH})…"
npm run package:linux

if [[ ! -x "$BIN" ]]; then
  echo "HandCash launcher not found at $BIN" >&2
  exit 1
fi

echo "==> Freeing BRC-100 bridge and UI ports…"
for port in 2121 3321 5173; do
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" 2>/dev/null || true
  elif command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      # shellcheck disable=SC2086
      kill $pids 2>/dev/null || true
    fi
  fi
done
sleep 1

VERSION="$(node -p "require('./package.json').version")"
echo "==> Launching $BIN (v${VERSION})"
exec "$BIN" "$@"
