import { describe, expect, it } from 'vitest'
import { createLogScrubber as createMainScrubber } from '../../electron/logPrivacy'
import { createLogScrubber, type LogKey } from './logPrivacy'

const KEY: LogKey = Array.from({ length: 32 }, (_, i) => i * 7 + 3)
const OTHER: LogKey = Array.from({ length: 32 }, (_, i) => 255 - i)

const TXID = '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b'
const IDENTITY = '02a1633cafcc01ebfb6d78e39f687a1f0995c62fc95f51ead10a02ee0be551b5dc'
const ADDRESS = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
const BEEF_B64 = 'AQC+7wH+AAAAAAABAQAAAAAAAAAA/////01UaGUgVGltZXMgMDMvSmFuLzIwMDkgQ2hhbmNlbGxvcg=='

const CORPUS = [
  `[activity] new spent/brc29 -12500 sat ${TXID.slice(0, 12)}… — settled`,
  `[beef] local-lookup done 12ms — cache ${TXID.slice(0, 8)}`,
  `[chat] delivered to ${IDENTITY} via box`,
  `[send] paying $alice.smith 0.25 BSV ($12.34) txid=${TXID}`,
  `[peer] {"sender":"bob","counterparty":"carol"} outpoint=${TXID}.0`,
  `[legacy] scan ${ADDRESS} beef=${BEEF_B64}`,
  `[written-off] reconcile done 40ms — restored=2 sats=9100 hidden=1 hiddenSats=546`,
  `[collectables] page returned=10 load=29ms hydrate=7163ms done 7192ms`,
  `[1sat] identify pass: probed 4, 1 sat each, 0 sat placeholder, paymail alice@handcash.io`,
  `raw ${'ab01'.repeat(60)}`,
]

describe('log privacy scrubber', () => {
  const scrub = createLogScrubber(KEY)

  it('turns txids and keys into same-length pseudonyms that keep their prefixes', () => {
    const full = scrub(`txid=${TXID}`).slice('txid='.length)
    const prefix = scrub(`seen ${TXID.slice(0, 12)}…`).slice('seen '.length, 'seen '.length + 12)
    expect(full).toMatch(/^[0-9a-f]{64}$/)
    expect(full).not.toBe(TXID)
    expect(full.startsWith(prefix)).toBe(true)
    expect(scrub(TXID)).toBe(full)
    expect(createLogScrubber(OTHER)(TXID)).not.toBe(full)
    const key = scrub(IDENTITY)
    expect(key).toHaveLength(66)
    expect(key).not.toContain(IDENTITY.slice(2, 14))
  })

  it('never lets identities, addresses, blobs or amounts through', () => {
    const out = CORPUS.map(scrub).join('\n')
    for (const leak of [
      TXID.slice(0, 8), IDENTITY.slice(0, 10), ADDRESS, BEEF_B64.slice(0, 20), 'ab01ab01ab01',
      'alice', 'bob', 'carol', 'handcash.io', '12500', '0.25', '12.34', '9100', '546',
    ]) {
      expect(out).not.toContain(leak)
    }
    expect(out).toContain('-[amt] sat')
    expect(out).toContain('[amt] BSV ($[amt])')
    expect(out).toContain('sats=[amt] hidden=1 hiddenSats=[amt]')
    expect(out).toContain('[address]')
    expect(out).toContain('[blob]')
    expect(out).toContain('[hex]')
    expect(out).toMatch(/\$h-[0-9a-f]{6} /)
    expect(out).toMatch(/"sender":"id-[0-9a-f]{6}","counterparty":"id-[0-9a-f]{6}"/)
    expect(out).toMatch(/p-[0-9a-f]{6}@paymail/)
  })

  it('keeps timings, counts, zero and one-sat wording for triage', () => {
    expect(scrub(CORPUS[7]!)).toBe(CORPUS[7])
    expect(scrub('[1sat] identify pass: probed 4, 1 sat each, 0 sat placeholder')).toBe(
      '[1sat] identify pass: probed 4, 1 sat each, 0 sat placeholder',
    )
    expect(scrub('[activity] new spent/approve 0 sat no-txid — x')).toBe('[activity] new spent/approve 0 sat no-txid — x')
    expect(scrub('1 BSV')).toBe('[amt] BSV')
  })

  it('a second pass leaks nothing and stays consistent', () => {
    const once = CORPUS.map(scrub)
    const twice = once.map(scrub)
    expect(twice).toEqual(CORPUS.map(scrub).map(scrub))
    expect(twice.join('\n')).not.toContain('alice')
    expect(twice.join('\n')).toContain('[amt]')
  })

  it('the Electron main-process copy scrubs identically', () => {
    const main = createMainScrubber(KEY)
    expect(CORPUS.map(main)).toEqual(CORPUS.map(scrub))
  })
})
