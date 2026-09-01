#!/usr/bin/env bash
# Keep upstream Babbage / BSV Desktop clones current for API reference — not vendored.
set -euo pipefail

ROOT="${HOME}/reference"
mkdir -p "$ROOT"

clone_or_pull() {
  local dir="$1"
  local url="$2"
  if [[ -d "$dir/.git" ]]; then
    echo "→ pull $(basename "$dir")"
    git -C "$dir" pull --ff-only
  else
    echo "→ clone $(basename "$dir") into $dir"
    git clone "$url" "$dir"
  fi
  git -C "$dir" log -1 --oneline
}

clone_or_pull "$ROOT/babbage-sdk" "https://github.com/bitcoin-sv/ts-sdk.git"
clone_or_pull "$ROOT/bsv-desktop" "https://github.com/bitcoin-sv/wallet-desktop.git"

echo ""
echo "Reference repos updated under $ROOT"
echo "HandCash pins: @bsv/sdk $(node -p "require('./package.json').dependencies['@bsv/sdk']" 2>/dev/null || echo '?')"
echo "               @bsv/wallet-toolbox-client $(node -p "require('./package.json').dependencies['@bsv/wallet-toolbox-client']" 2>/dev/null || echo '?')"
