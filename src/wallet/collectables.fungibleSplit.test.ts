import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FungibleToken } from './token/types'

const fungibles = vi.hoisted(() => ({ cached: [] as FungibleToken[] }))
vi.mock('./token', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./token')>()),
  getCachedFungibles: () => fungibles.cached,
}))

vi.mock('./session', () => ({ getActiveWallet: () => null }))

const TXID_A = 'a'.repeat(64)
const TXID_B = 'b'.repeat(64)
const TXID_C = 'c'.repeat(64)
const DEPLOY = 'd'.repeat(64)

function token(partial: Partial<FungibleToken>): FungibleToken {
  return {
    tokenId: `${DEPLOY}_0`,
    sym: 'FOX',
    amt: '3',
    dec: 0,
    utxoCount: 3,
    outpoint: `${TXID_A}.0`,
    spendKind: 'plain',
    ...partial,
  }
}

describe('collectableIsFungible — Tokens shelf claims every held tip', () => {
  beforeEach(() => {
    fungibles.cached = []
    vi.resetModules()
  })

  it('claims tips beyond the representative one (tipOutpoints, heldTips) and every member deploy id', async () => {
    const { collectableIsFungible } = await import('./collectables')
    fungibles.cached = [
      token({
        tipOutpoints: [`${TXID_A}.0`, `${TXID_B}.1`],
        heldTips: [
          { outpoint: `${TXID_C}_2`, tokenId: `${DEPLOY}_0`, amt: '1', op: 'transfer', dec: 0, satoshis: 1 },
        ],
        tokenIds: [`${DEPLOY}_0`, `${'e'.repeat(64)}_0`],
      }),
    ]

    expect(collectableIsFungible({ outpoint: `${TXID_A}.0` })).toBe(true)
    // Previously painted as NFTs: the second and third one-sat tips.
    expect(collectableIsFungible({ outpoint: `${TXID_B}.1` })).toBe(true)
    expect(collectableIsFungible({ outpoint: `${TXID_C}.2` })).toBe(true)
    // Origin-matched deploy ids, including non-representative members.
    expect(collectableIsFungible({ outpoint: `${'f'.repeat(64)}.0`, origin: `${'e'.repeat(64)}_0` })).toBe(true)
    // A real one-sat item stays an item.
    expect(collectableIsFungible({ outpoint: `${'9'.repeat(64)}.0`, origin: `${'9'.repeat(64)}_0` })).toBe(false)
  })

  it('classifies by BSV-21 mime even before the fungibles cache hydrates', async () => {
    const { collectableIsFungible } = await import('./collectables')
    expect(
      collectableIsFungible({ outpoint: `${TXID_A}.0`, mimeType: 'application/bsv-20' }),
    ).toBe(true)
    expect(collectableIsFungible({ outpoint: `${TXID_A}.0`, mimeType: 'image/png' })).toBe(false)
  })

  it('re-indexes when the cache array is replaced', async () => {
    const { collectableIsFungible } = await import('./collectables')
    expect(collectableIsFungible({ outpoint: `${TXID_B}.1` })).toBe(false)
    fungibles.cached = [token({ tipOutpoints: [`${TXID_A}.0`, `${TXID_B}.1`] })]
    expect(collectableIsFungible({ outpoint: `${TXID_B}.1` })).toBe(true)
  })
})
