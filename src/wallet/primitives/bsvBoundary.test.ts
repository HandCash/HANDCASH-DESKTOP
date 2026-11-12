import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// Open BSV licence boundary: Open BSV code may only be used for BSV.
// Non-BSV coin modules must use the MIT noble primitives (src/wallet/primitives).
// The SDK leaves the fence once the installed release is Apache-2.0 (ts-stack 4760b26d);
// wallet-engine stays fenced while it carries pre-2026 Open BSV v4 Toolbox code.
// See docs/bsva-apache-relicense.md and docs/licensing-launch-blockers.md (L1).
// Not legal clearance: it only keeps the code boundary from drifting.

const WALLET = join(__dirname, '..')
const NON_BSV_DIRS = ['arcUsdc', 'bch', 'btc', 'coins', 'doge', 'ltc', 'primitives', 'swap']
// Source files that are legitimately BSV (the BSV leg of a swap).
const ALLOWED = new Set(['swap/legChains.ts'])
const SDK_LICENSE: string = JSON.parse(
  readFileSync(join(WALLET, '../../node_modules/@bsv/sdk/package.json'), 'utf8'),
).license
const SDK_FENCED = SDK_LICENSE !== 'Apache-2.0'
const RESTRICTED = new RegExp(
  String.raw`(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:` +
    (SDK_FENCED ? String.raw`@bsv\/sdk|` : '') +
    String.raw`[^'"]*wallet-engine[^'"]*)['"]`,
)

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sources(p)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
  })
}

describe('BSV SDK import boundary', () => {
  it('keeps @bsv/sdk and wallet-engine out of non-BSV coin modules', () => {
    const offenders = NON_BSV_DIRS.flatMap((d) => sources(join(WALLET, d)))
      .map((p) => relative(WALLET, p).split(sep).join('/'))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => RESTRICTED.test(readFileSync(join(WALLET, rel), 'utf8')))
    expect(offenders).toEqual([])
  })

  it.runIf(SDK_FENCED)('allowlist entries still exist and still need the exception', () => {
    for (const rel of ALLOWED) {
      expect(RESTRICTED.test(readFileSync(join(WALLET, rel), 'utf8'))).toBe(true)
    }
  })
})
