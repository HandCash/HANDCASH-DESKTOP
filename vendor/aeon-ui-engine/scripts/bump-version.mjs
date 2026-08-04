#!/usr/bin/env node
/**
 * Bump aeon-ui-engine semver, changelog, tag, optionally push + npm publish.
 *
 *   node scripts/bump-version.mjs patch|minor|major [--push] [--publish] [--no-commit]
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = path.join(root, 'package.json')
const changelogPath = path.join(root, 'CHANGELOG.md')

const args = process.argv.slice(2)
const bump = args.find((a) => a === 'patch' || a === 'minor' || a === 'major')
const noCommit = args.includes('--no-commit')
const doPush = args.includes('--push')
const doPublish = args.includes('--publish')

if (!bump) {
  console.error('Usage: bump-version.mjs patch|minor|major [--push] [--publish] [--no-commit]')
  process.exit(1)
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
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

function prependChangelog(version) {
  const entry = `## [${version}] - ${today()}\n\n### Changed\n\n- Describe this release.\n\n`
  if (!fs.existsSync(changelogPath)) {
    fs.writeFileSync(changelogPath, `# Changelog\n\n${entry}`)
    return
  }
  const existing = fs.readFileSync(changelogPath, 'utf8')
  if (existing.includes(`## [${version}]`)) return
  if (existing.startsWith('# Changelog')) {
    fs.writeFileSync(changelogPath, existing.replace('# Changelog\n\n', `# Changelog\n\n${entry}`))
  } else {
    fs.writeFileSync(changelogPath, `# Changelog\n\n${entry}${existing}`)
  }
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const prev = pkg.version
const next = bumpSemver(prev, bump)
pkg.version = next
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
prependChangelog(next)
console.log(`aeon-ui-engine ${prev} → ${next}`)

if (!noCommit) {
  execSync('git add package.json CHANGELOG.md', { cwd: root, stdio: 'inherit' })
  execSync(`git commit -m "Release aeon-ui-engine v${next}"`, { cwd: root, stdio: 'inherit' })
  try {
    execSync(`git tag v${next}`, { cwd: root, stdio: 'inherit' })
  } catch {
    console.warn(`Tag v${next} already exists`)
  }
}

if (doPush) {
  execSync('git push origin HEAD', { cwd: root, stdio: 'inherit' })
  execSync(`git push origin v${next}`, { cwd: root, stdio: 'inherit' })
}

if (doPublish) {
  execSync('npm publish --access public', { cwd: root, stdio: 'inherit' })
}

if (!doPush) {
  console.log(`Tagged v${next}. Push: git push && git push origin v${next}`)
  console.log('Or: npm run version:push')
}
