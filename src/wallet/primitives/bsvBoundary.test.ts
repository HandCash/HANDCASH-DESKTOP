import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// Open BSV licence boundary: the BSV SDK / wallet-engine may only be used for BSV.
// Non-BSV coin modules must use the MIT noble primitives (src/wallet/primitives).
// See docs/licensing-launch-blockers.md (L1) and docs/restricted-component-replacement.md.
// Not legal clearance: it only keeps the code boundary from drifting.

const WALLET = join(__dirname, '..')
const NON_BSV_DIRS = ['arcUsdc', 'bch', 'btc', 'coins', 'doge', 'ltc', 'primitives', 'swap']
// Source files that are legitimately BSV (the BSV leg of a swap).
const ALLOWED = new Set(['swap/legChains.ts'])
const RESTRICTED = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:@bsv\/sdk|[^'"]*wallet-engine[^'"]*)['"]/

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

  it('allowlist entries still exist and still need the exception', () => {
    for (const rel of ALLOWED) {
      expect(RESTRICTED.test(readFileSync(join(WALLET, rel), 'utf8'))).toBe(true)
    }
  })
})
