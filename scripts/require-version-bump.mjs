#!/usr/bin/env node
/**
 * Fail if package.json version is not strictly newer than the latest remote tag (v*).
 * Used by pre-push and Cursor shell hooks so every push to master ships a new semver.
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const local = pkg.version

function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v).replace(/^v/, ''))
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function gt(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true
    if (a[i] < b[i]) return false
  }
  return false
}

// Ask the remote what tags it has. `git describe` reads the local tag database,
// so the tag this push is about to create would count as already published and
// block the `git push origin vX.Y.Z` half of a release.
function latestRemoteTag() {
  let out = ''
  try {
    out = execSync("git ls-remote --tags origin 'v*'", { cwd: root, encoding: 'utf8' })
  } catch {
    return null // offline: cannot prove a newer tag exists
  }
  let best = ''
  let bestP = null
  for (const line of out.split('\n')) {
    const name = line.split('refs/tags/')[1]
    if (!name || name.endsWith('^{}')) continue
    const p = parse(name)
    if (!p) continue
    if (!bestP || gt(p, bestP)) {
      bestP = p
      best = name.trim()
    }
  }
  return best
}

const remoteTag = latestRemoteTag()

const localP = parse(local)
if (!localP) {
  console.error(`Invalid package.json version: ${local}`)
  process.exit(1)
}

if (remoteTag === null) {
  console.log(`Cannot reach origin — allowing push of v${local}`)
  process.exit(0)
}

if (!remoteTag) {
  console.log(`No remote tag yet — allowing push of v${local}`)
  process.exit(0)
}

const remoteP = parse(remoteTag)

if (!gt(localP, remoteP)) {
  console.error(`
Refusing push: package.json version ${local} is not newer than remote tag ${remoteTag}.

Bump first, then push:
  npm run version:patch   # or version:minor / version:major
  git push && git push origin v${localP[0]}.${localP[1]}.${localP[2] + 1}

Or one-shot:
  npm run version:push
`)
  process.exit(1)
}

console.log(`Version OK: ${local} > ${remoteTag.replace(/^v/, '')}`)
