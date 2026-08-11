#!/usr/bin/env bash
# Build a packaged Mac app and launch it (updater + IndexedDB paths match production).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "launch-mac.sh is for macOS. On Linux use: npm run launch" >&2
  exit 1
fi

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) APP_DIR="release/mac-arm64" ;;
  x86_64) APP_DIR="release/mac" ;;
  *)
    echo "Unsupported arch: $ARCH" >&2
    exit 1
    ;;
esac

APP="$APP_DIR/HandCash.app"

echo "==> Building renderer + electron…"
npm run build

echo "==> Packaging Mac .app ($ARCH)…"
# Skip code-sign discovery for local launch reliability
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir --publish never

if [[ ! -d "$APP" ]]; then
  # electron-builder layout can vary by version — search once
  APP="$(find release -maxdepth 3 -type d -name 'HandCash.app' | head -n 1 || true)"
fi

if [[ -z "${APP:-}" || ! -d "$APP" ]]; then
  echo "HandCash.app not found under release/" >&2
  exit 1
fi

# electron-builder --mac dir often skips embedding app-update.yml on arm64
UPDATE_YML="$APP/Contents/Resources/app-update.yml"
if [[ ! -f "$UPDATE_YML" ]]; then
  echo "==> Writing app-update.yml (missing from dir package)…"
  cp "$ROOT/build/app-update.yml" "$UPDATE_YML"
fi

echo "==> Quitting any running HandCash…"
osascript -e 'tell application "HandCash" to quit' 2>/dev/null || true
pkill -f 'HandCash.app/Contents/MacOS/HandCash' 2>/dev/null || true
sleep 1

# Free BRC-100 bridge ports and the localhost UI port if a previous instance
# (or /Applications/HandCash.app) left them open — otherwise Chromium can load
# a stale UI on ::1:5173 while this build thinks it owns the origin.
for port in 2121 3321 5173; do
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      # shellcheck disable=SC2086
      kill $pids 2>/dev/null || true
    fi
  fi
done
sleep 1

VERSION="$(node -p "require('./package.json').version")"
echo "==> Launching $APP (v${VERSION})"
# Prefer this build over a stale Dock /Applications copy on the same ports.
if [[ -d /Applications/HandCash.app ]]; then
  echo "    Note: quit /Applications/HandCash.app if the Dock still opens the old install."
fi
open -n "$APP" --args "$@"
echo "Launched v${VERSION}. Confirm Settings shows this version before minting."
