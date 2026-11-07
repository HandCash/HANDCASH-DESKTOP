import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

// Evidence only: lock entries are candidates, not proof of inclusion in a binary.
const roots = process.argv.slice(2)
if (!roots.length) throw new Error('Pass Desktop and Mobile checkout paths')
const hash = data => crypto.createHash('sha256').update(data).digest('hex')
// Keep nested license trees: top-level hashes alone miss historical grants.
// Never traverse symlinks or unrelated package contents (including .env files).
const collectNotices = (dir, prefix = '') => {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) return []
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (!prefix && !/^(licen[cs]e|notice|copying|third.party)/i.test(entry.name)) return []
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) return collectNotices(file, name)
    return entry.isFile() ? [{ name, sha256: hash(fs.readFileSync(file)) }] : []
  })
}
const result = roots.map(root => {
  const lockBytes = fs.readFileSync(path.join(root, 'package-lock.json'))
  const lock = JSON.parse(lockBytes)
  const packages = Object.entries(lock.packages ?? {}).map(([location, value]) => {
    const dir = path.join(root, location)
    const notices = collectNotices(dir)
    const manifestPath = path.join(dir, 'package.json')
    const installedVersion = fs.existsSync(manifestPath)
      ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version ?? null : null
    const evidenceIssues = []
    if (!fs.existsSync(dir)) evidenceIssues.push('package-directory-missing')
    if (!installedVersion) evidenceIssues.push('installed-version-unverified')
    else if (value.version && installedVersion !== value.version) evidenceIssues.push('installed-version-mismatch')
    if (!notices.length) evidenceIssues.push('no-notice-files-found')
    // These are evidence gaps, not automatic findings of license violation.
    return { location, version: value.version ?? null, installedVersion, evidenceIssues, license: value.license ?? null,
      dev: Boolean(value.dev), optional: Boolean(value.optional), link: Boolean(value.link),
      resolved: value.resolved ?? null, integrity: value.integrity ?? null, notices }
  })
  return { root, commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    lockSha256: hash(lockBytes), packages }
})
process.stdout.write(JSON.stringify({ scope: 'Checkout lock candidates; not a shipped SBOM or legal clearance', checkouts: result }, null, 2) + '\n')
