import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A BRC-100 wallet never signs with its root key (BRC-42/43), so an output
 * locked to `address(identityKey)` cannot be spent by any BRC-100 wallet but
 * ours. New outputs lock to BRC-29 children (`brc29Keys.ts`). No site writes
 * an identity-address lock; these only recognise old ones. The counts may only shrink.
 */
const ALLOWED: Record<string, number> = {
  // Recognising (and spending) pads and fee coins minted on the identity address before BRC-29.
  'src/wallet/brc29Keys.ts': 1,
  // Read-only: a saved friend or bound handle typed as its old identity address.
  'src/wallet/friends.ts': 2,
}

const PATTERNS = [
  /addressFromIdentityKey\(/g,
  /P2PKH\(\)\.lock\((?:active|args\.active|wallet)\.address\)/g,
  /payTo: (?:active|args\.active)\.address/g,
]

const ROOT = join(__dirname, '..', '..')
const repoPath = (path: string): string => relative(ROOT, path).split(sep).join('/')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

function census(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const path of sources(join(ROOT, 'src'))) {
    const text = readFileSync(path, 'utf8')
    const hits = PATTERNS.reduce((n, re) => n + (text.match(re)?.length ?? 0), 0)
    if (hits > 0) out[repoPath(path)] = hits
  }
  // The definition is not a use.
  if (out['src/wallet/friends.ts']) out['src/wallet/friends.ts'] -= 1
  if (out['src/wallet/friends.ts'] === 0) delete out['src/wallet/friends.ts']
  return out
}

describe('identity-address locks', () => {
  it('adds no new identity-address lock and keeps the allowlist tight', () => {
    expect(census()).toEqual(ALLOWED)
  })

  it('never writes p color keys', () => {
    const writers = sources(join(ROOT, 'src'))
      .filter((p) => /legacyColorPublicKey\(/.test(readFileSync(p, 'utf8')))
      .map(repoPath)
    expect(writers).toEqual([])
  })
})
