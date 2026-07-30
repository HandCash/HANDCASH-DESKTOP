#!/usr/bin/env node
/**
 * Bump package.json version (semver) and keep release docs in sync.
 *
 *   node scripts/bump-version.mjs patch|minor|major [--no-commit] [--sync-market]
 *   node scripts/bump-version.mjs --sync-market   # only update items-market defaults
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = path.join(root, 'package.json')
const changelogPath = path.join(root, 'CHANGELOG.md')
const versionTsPath = path.join(root, 'src/version.ts')
const marketDownloads = path.resolve(
  root,
  '../items-market/src/lib/desktopDownloads.ts',
)

const args = process.argv.slice(2)
const syncOnly = args.includes('--sync-market') && !['patch', 'minor', 'major'].some((a) => args.includes(a))
const doSyncMarket = args.includes('--sync-market')
const noCommit = args.includes('--no-commit')
const bump = args.find((a) => a === 'patch' || a === 'minor' || a === 'major')

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?$/.exec(v.trim())
  if (!m) throw new Error(`Invalid semver: ${v}`)
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

function format({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`
}

function bumpSemver(v, kind) {
  const s = parseSemver(v)
  if (kind === 'major') return format({ major: s.major + 1, minor: 0, patch: 0 })
  if (kind === 'minor') return format({ major: s.major, minor: s.minor + 1, patch: 0 })
  return format({ major: s.major, minor: s.minor, patch: s.patch + 1 })
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

function syncMarket(version) {
  if (!fs.existsSync(marketDownloads)) {
    console.warn(`items-market downloads file not found (skip): ${marketDownloads}`)
    return false
  }
  let src = fs.readFileSync(marketDownloads, 'utf8')
  const next = src.replace(
    /const VERSION = process\.env\.NEXT_PUBLIC_DESKTOP_VERSION \|\| '[^']+'/,
    `const VERSION = process.env.NEXT_PUBLIC_DESKTOP_VERSION || '${version}'`,
  )
  if (next === src) {
    console.warn('items-market VERSION line not updated (pattern mismatch)')
    return false
  }
  fs.writeFileSync(marketDownloads, next)
  console.log(`Synced items-market default VERSION → ${version}`)
  return true
}

function prependChangelog(version) {
  const header = `# Changelog\n\n`
  const entry = `## [${version}] - ${today()}\n\n### Changed\n\n- Describe this release.\n\n`
  if (!fs.existsSync(changelogPath)) {
    fs.writeFileSync(changelogPath, header + entry)
    return
  }
  const existing = fs.readFileSync(changelogPath, 'utf8')
  if (existing.includes(`## [${version}]`)) return
  if (existing.startsWith('# Changelog')) {
    fs.writeFileSync(
      changelogPath,
      existing.replace('# Changelog\n\n', `# Changelog\n\n${entry}`),
    )
  } else {
    fs.writeFileSync(changelogPath, header + entry + existing)
  }
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))

if (syncOnly) {
  syncMarket(pkg.version)
  process.exit(0)
}

if (!bump) {
  console.error('Usage: bump-version.mjs patch|minor|major [--no-commit] [--sync-market]')
  process.exit(1)
}

const prev = pkg.version
const next = bumpSemver(prev, bump)
pkg.version = next
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
prependChangelog(next)
console.log(`version ${prev} → ${next}`)

if (doSyncMarket) syncMarket(next)

if (!noCommit) {
  const files = ['package.json', 'CHANGELOG.md']
  if (doSyncMarket && fs.existsSync(marketDownloads)) {
    // market lives in another repo — only remind
    console.log('Note: commit items-market VERSION change in that repo separately.')
  }
  execSync(`git add package.json CHANGELOG.md`, { cwd: root, stdio: 'inherit' })
  execSync(`git commit -m "Release v${next}"`, { cwd: root, stdio: 'inherit' })
  execSync(`git tag v${next}`, { cwd: root, stdio: 'inherit' })
  console.log(`Tagged v${next}. Push with: git push && git push origin v${next}`)
}
