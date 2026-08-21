#!/usr/bin/env node
/**
 * Block `git push` unless package.json semver is newer than the latest remote tag.
 *
 * Only this repository is in scope. Pushes from an unrelated checkout — an
 * upstream fork under /tmp, another clone — have no Desktop version to bump, so
 * they are allowed through. The push target is resolved from a leading `cd` in
 * the command when present, because the shell's reported cwd stays at the
 * workspace root even when the command moves elsewhere first.
 */
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function allow() {
  process.stdout.write(JSON.stringify({ permission: 'allow' }))
  process.exit(0)
}

function deny() {
  process.stdout.write(
    JSON.stringify({
      permission: 'deny',
      user_message:
        'Push blocked: bump the Desktop version first (npm run version:push).',
      agent_message:
        'Every push to master must include a new package.json semver. Run npm run version:push (or version:patch then push tag).',
    }),
  )
  process.exit(0)
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => (raw += chunk))
    process.stdin.on('end', () => resolve(raw))
  })
}

/** First `cd <dir>` in the command, honouring quotes. */
function firstCdTarget(command) {
  const match = command.match(
    /(?:^|[;&|]\s*)cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/,
  )
  if (!match) return null
  return match[1] ?? match[2] ?? match[3] ?? null
}

function repoRoot(dir) {
  try {
    const top = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return top ? realpathSync(top) : null
  } catch {
    return null
  }
}

const raw = await readStdin()

let command = ''
let cwd = ''
try {
  const payload = JSON.parse(raw)
  command = String(payload.command ?? '')
  cwd = String(payload.cwd ?? '')
} catch {
  // An unparseable payload tells us nothing about the target; stay out of the way.
  allow()
}

if (!/git\s+push/.test(command)) allow()

const cdTarget = firstCdTarget(command)
const base = cwd || ROOT
const target = cdTarget
  ? path.resolve(base, cdTarget)
  : base

const targetRoot = repoRoot(target)
let thisRoot = null
try {
  thisRoot = realpathSync(ROOT)
} catch {
  thisRoot = ROOT
}

// Another repository's release rules are not ours to enforce.
if (targetRoot === null || targetRoot !== thisRoot) allow()

try {
  execFileSync('node', [path.join(ROOT, 'scripts/require-version-bump.mjs')], {
    cwd: ROOT,
    stdio: 'ignore',
  })
} catch {
  deny()
}

allow()
