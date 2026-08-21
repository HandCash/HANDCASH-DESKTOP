#!/bin/sh
# Locate a Node runtime for require-version-on-push.mjs.
#
# Cursor runs hooks in a non-interactive shell with a minimal PATH, so neither
# nvm nor Homebrew has been sourced and a bare `node` exits 127. A fail-closed
# hook that cannot start blocks every push, so the search happens here and the
# guard itself stays in the .mjs.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return
  fi
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return
    fi
  done
  # nvm keeps versioned installs only; prefer the newest.
  for candidate in $(ls -1d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -Vr); do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return
    fi
  done
}

NODE="$(find_node)"

if [ -z "$NODE" ]; then
  # The version guard cannot be evaluated, so the push does not get a pass.
  printf '%s' '{"permission":"deny","user_message":"Push blocked: no Node runtime found to check the Desktop version.","agent_message":"require-version-on-push.sh could not find node. Install Node or add it to PATH, then push again."}'
  exit 0
fi

exec "$NODE" "$ROOT/.cursor/hooks/require-version-on-push.mjs"
