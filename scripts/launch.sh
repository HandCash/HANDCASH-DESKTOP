#!/usr/bin/env bash
# Build a packaged Linux app and launch it (updater + IndexedDB paths match production).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "On macOS use: npm run launch:mac" >&2
  exit 1
fi

APP_DIR="release/linux-unpacked"
BIN="$APP_DIR/HandCash"

echo "==> Building renderer + electron…"
npm run build

echo "==> Packaging Linux dir…"
npx electron-builder --linux dir --publish never

if [[ ! -x "$BIN" ]]; then
  BIN="$(find release -maxdepth 3 -type f -name HandCash -perm -111 | head -n 1 || true)"
fi

if [[ -z "${BIN:-}" || ! -x "$BIN" ]]; then
  echo "HandCash binary not found under release/" >&2
  exit 1
fi

APP_DIR="$(cd "$(dirname "$BIN")" && pwd)"

# electron-builder --linux dir often omits app-update.yml
UPDATE_YML="$APP_DIR/resources/app-update.yml"
if [[ ! -f "$UPDATE_YML" ]]; then
  echo "==> Writing app-update.yml (missing from dir package)…"
  mkdir -p "$(dirname "$UPDATE_YML")"
  cp "$ROOT/build/app-update.yml" "$UPDATE_YML"
fi

echo "==> Freeing BRC-100 bridge ports…"
for port in 2121 3321; do
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

echo "==> Launching $BIN"
exec env -u ELECTRON_RUN_AS_NODE "$BIN" --no-sandbox "$@"
