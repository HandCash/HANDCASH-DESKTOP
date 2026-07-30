#!/usr/bin/env bash
# Block `git push` unless package.json semver is newer than the latest remote tag.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
input="$(cat)"
cmd="$(printf '%s' "$input" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(j.command||'')}catch{process.stdout.write('')}})")"

# Allow pushes of tags / other remotes without blocking unrelated commands
if ! printf '%s' "$cmd" | grep -Eq 'git[[:space:]]+push'; then
  echo '{ "permission": "allow" }'
  exit 0
fi

# version:push / release bumps already ahead of remote — still verify
if ! node "$ROOT/scripts/require-version-bump.mjs"; then
  echo '{
    "permission": "deny",
    "user_message": "Push blocked: bump the Desktop version first (npm run version:push).",
    "agent_message": "Every push to master must include a new package.json semver. Run npm run version:push (or version:patch then push tag)."
  }'
  exit 0
fi

echo '{ "permission": "allow" }'
exit 0
