#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

npm run build
npx electron-builder --linux dir

fuser -k 2121/tcp 3321/tcp 2>/dev/null || true
sleep 1

exec env -u ELECTRON_RUN_AS_NODE ./release/linux-unpacked/HandCash --no-sandbox "$@"
