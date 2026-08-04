#!/usr/bin/env node
/**
 * Fail if package.json version is not strictly newer than the latest remote tag (v*).
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

try {
  execSync('git fetch --tags --quiet', { cwd: root, stdio: 'ignore' })
} catch {
  /* offline */
}

let remoteTag = ''
try {
  remoteTag = execSync(
    'git describe --tags --abbrev=0 origin/main 2>/dev/null || git describe --tags --abbrev=0',
    { cwd: root, encoding: 'utf8' },
  ).trim()
} catch {
  remoteTag = ''
}

const localP = parse(local)
if (!localP) {
  console.error(`Invalid package.json version: ${local}`)
  process.exit(1)
}

if (!remoteTag) {
  console.log(`No remote tag yet — allowing push of v${local}`)
  process.exit(0)
}

const remoteP = parse(remoteTag)
if (!remoteP) {
  console.log(`Unparsed remote tag ${remoteTag} — allowing push`)
  process.exit(0)
}

if (!gt(localP, remoteP)) {
  console.error(`
Refusing push: aeon-ui-engine ${local} is not newer than remote tag ${remoteTag}.

  npm run version:push
`)
  process.exit(1)
}

console.log(`Version OK: ${local} > ${remoteTag.replace(/^v/, '')}`)
