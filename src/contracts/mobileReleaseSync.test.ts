import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const script = path.resolve(__dirname, '../../scripts/release-mobile.mjs')
const root = path.resolve(__dirname, '../..')
const sha = 'a'.repeat(40)

async function load() {
  // A file URL: Windows absolute paths ("D:\...") are not valid import specifiers.
  return (await import(/* @vite-ignore */ pathToFileURL(script).href)) as {
    nextMobileVersion(v: string): string
    syncProblems(i: { desktopVersion: string; walletUiVersion: string; desktopSha?: string; pin: unknown }): string[]
    pinMobile(dir: string, i: { desktopVersion: string; sha: string }): string
    checkMobile(dir: string, desktopSha?: string): string[]
  }
}

describe('Desktop ↔ Mobile release sync', () => {
  it('Desktop package.json, src/version.ts and wallet-ui agree', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    const ui = JSON.parse(fs.readFileSync(path.join(root, 'packages/wallet-ui/package.json'), 'utf8'))
    const ts = fs.readFileSync(path.join(root, 'src/version.ts'), 'utf8')
    expect(ts).toContain(`PACKAGED_VERSION = '${pkg.version}'`)
    expect(ui.version).toBe(pkg.version)
  })

  it('bumps the Mobile patch version', async () => {
    const m = await load()
    expect(m.nextMobileVersion('0.1.774')).toBe('0.1.775')
    expect(() => m.nextMobileVersion('nope')).toThrow()
  })

  it('reports drift and accepts a matching pin', async () => {
    const m = await load()
    const ok = { desktopVersion: '1.3.656', walletUiVersion: '1.3.656', pin: { gitSha: sha, version: '1.3.656' } }
    expect(m.syncProblems(ok)).toEqual([])
    expect(m.syncProblems({ ...ok, pin: { gitSha: sha, version: '1.3.655' } })).toHaveLength(1)
    expect(m.syncProblems({ ...ok, pin: { gitSha: 'abc', version: '1.3.656' } })).toHaveLength(1)
    expect(m.syncProblems({ ...ok, pin: null }).length).toBeGreaterThan(0)
  })

  it('pins a Mobile checkout to this Desktop version', async () => {
    const m = await load()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-'))
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'm', version: '0.1.1' }))
    const desktopVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
    expect(m.checkMobile(dir).length).toBeGreaterThan(0)
    expect(m.pinMobile(dir, { desktopVersion, sha })).toBe('0.1.2')
    expect(m.checkMobile(dir, sha)).toEqual([])
    expect(m.checkMobile(dir, 'b'.repeat(40))).toEqual([
      `Mobile pin commit ${sha} != Desktop ${'b'.repeat(40)}`,
    ])
    // Default CLI checks compare the source, not just its version label.
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    expect(m.checkMobile(dir).length).toBeGreaterThan(0)
    m.pinMobile(dir, { desktopVersion, sha: head })
    expect(m.checkMobile(dir)).toEqual([])
  })

  it('CLI fails loudly without a Mobile checkout', () => {
    expect(() =>
      execFileSync('node', [script, '--mobile-dir', '/nonexistent-mobile'], { stdio: 'pipe' }),
    ).toThrow()
  })
})
