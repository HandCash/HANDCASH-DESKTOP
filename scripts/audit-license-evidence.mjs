import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

// Evidence only: lock entries are candidates, not proof of inclusion in a binary.
const roots = process.argv.slice(2)
if (!roots.length) throw new Error('Pass Desktop and Mobile checkout paths')
const hash = data => crypto.createHash('sha256').update(data).digest('hex')
const result = roots.map(root => {
  const lockBytes = fs.readFileSync(path.join(root, 'package-lock.json'))
  const lock = JSON.parse(lockBytes)
  const packages = Object.entries(lock.packages ?? {}).map(([location, value]) => {
    const dir = path.join(root, location)
    const notices = []
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir).sort()) {
        if (!/^(licen[cs]e|notice|copying|third.party)/i.test(name)) continue
        const file = path.join(dir, name)
        if (fs.statSync(file).isFile()) notices.push({ name, sha256: hash(fs.readFileSync(file)) })
      }
    }
    return { location, version: value.version ?? null, license: value.license ?? null,
      dev: Boolean(value.dev), optional: Boolean(value.optional), link: Boolean(value.link),
      resolved: value.resolved ?? null, integrity: value.integrity ?? null, notices }
  })
  return { root, commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    lockSha256: hash(lockBytes), packages }
})
process.stdout.write(JSON.stringify({ scope: 'Checkout lock candidates; not a shipped SBOM or legal clearance', checkouts: result }, null, 2) + '\n')
