import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('./audit-license-evidence.mjs', import.meta.url))

test('inventory retains nested grants and separates lock versions from installed evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handcash-license-test-'))
  try {
    execFileSync('git', ['init', '--quiet', root])
    execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture'], { stdio: 'pipe' })
    const dir = path.join(root, 'node_modules/example')
    fs.mkdirSync(path.join(dir, 'LICENSES'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '2.0.0' }))
    fs.writeFileSync(path.join(dir, 'LICENSES', 'historical.txt'), 'historical grant')
    fs.writeFileSync(path.join(dir, 'LICENSES', '.hidden'), 'must not be inventoried')
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: {
      'node_modules/example': { version: '1.0.0', license: 'SEE LICENSES' },
      'node_modules/missing': { version: '1.0.0' },
    } }))
    const result = JSON.parse(execFileSync(process.execPath, [script, root], { encoding: 'utf8' }))
    const [installed, missing] = result.checkouts[0].packages
    assert.equal(installed.version, '1.0.0')
    assert.equal(installed.installedVersion, '2.0.0')
    assert.deepEqual(installed.evidenceIssues, ['installed-version-mismatch'])
    assert.deepEqual(installed.notices.map(n => n.name), ['LICENSES/historical.txt'])
    assert.match(installed.notices[0].sha256, /^[a-f0-9]{64}$/)
    assert.ok(missing.evidenceIssues.includes('package-directory-missing'))
    assert.ok(missing.evidenceIssues.includes('installed-version-unverified'))
    assert.match(result.scope, /not a shipped SBOM or legal clearance/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
