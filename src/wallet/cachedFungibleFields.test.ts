import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
  durableRemoveItem: (key: string) => {
    store.delete(key)
    return true
  },
}))

vi.mock('./sentItemGuard', () => ({
  isItemSent: () => false,
  markItemsConsumed: vi.fn(),
}))

const CACHE_KEY = 'handcash.tokens.list.v1'
const KING_ORIGIN =
  '9c385c416f708fad7627db3dc2ab4f8b28acca7062dfb2dfe56db20e5f961ac4_0'

/** Exactly what a build before the BSV-21 rename wrote for a held 162 tip. */
function preRenameCacheRow() {
  return {
    tokenId: KING_ORIGIN,
    sym: 'KING',
    amt: '100',
    dec: 0,
    utxoCount: 1,
    outpoint: `${'aa'.repeat(32)}_1`,
    spendKind: 'plain' as const,
    colourSupply: 'locked' as const,
    colourMaxSupply: 69420,
    colourProvenanceOk: true,
  }
}

describe('cached fungible field migration', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('reads pre-rename colour fields under the current names', async () => {
    const { migrateCachedFungibleFields } = await import('./token/list')
    expect(migrateCachedFungibleFields(preRenameCacheRow())).toMatchObject({
      tokenId: KING_ORIGIN,
      binarySupply: 'locked',
      encoding: 'brc162',
      maxSupply: 69420,
      provenanceOk: true,
    })
    expect(migrateCachedFungibleFields(preRenameCacheRow())).not.toHaveProperty(
      'colourSupply',
    )
  })

  it('leaves current rows alone and never downgrades a live value', async () => {
    const { migrateCachedFungibleFields } = await import('./token/list')
    const current = {
      ...preRenameCacheRow(),
      binarySupply: 'open' as const,
      maxSupply: 1,
      provenanceOk: false,
    }
    expect(migrateCachedFungibleFields(current)).toMatchObject({
      binarySupply: 'open',
      maxSupply: 1,
      provenanceOk: false,
    })
  })

  it('paints an upgraded install as sendable BSV-21, not burn-only legacy', async () => {
    store.set(
      CACHE_KEY,
      JSON.stringify({ at: Date.now(), items: [preRenameCacheRow()] }),
    )
    const { getCachedFungibles } = await import('./token/list')
    const [token] = getCachedFungibles()
    // `binarySupply` is the gate Collect uses for Send vs "Legacy BSV-21 — burn only".
    expect(token?.binarySupply).toBe('locked')
    expect(token?.encoding).toBe('brc162')
    expect(token?.maxSupply).toBe(69420)
  })

  it('does not call an unclassified old cache row legacy', async () => {
    const { classifyFungibleEncoding } = await import('./token/types')
    expect(
      classifyFungibleEncoding({
        binarySupply: undefined,
        encoding: undefined,
      }),
    ).toEqual({ kind: 'unknown' })
    expect(
      classifyFungibleEncoding({
        binarySupply: undefined,
        encoding: 'legacy-json',
      }),
    ).toEqual({ kind: 'legacy-json' })
  })
})
