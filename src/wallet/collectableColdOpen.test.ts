import { beforeEach, describe, expect, it, vi } from 'vitest'

// A cold open must paint last session's items. Recompose used to empty the
// durable list cache, so the next boot started at zero and Collect showed
// "Looking for collectables…" on a wallet that already held tips.

vi.mock('./sentItemGuard', () => ({
  isItemSent: () => false,
  markItemsSent: vi.fn(),
  getSentItemRecord: () => null,
}))

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
  durableRemoveItem: (key: string) => {
    store.delete(key)
  },
  durableForgetCached: () => {},
}))

const IDENTITY = '02'.repeat(33)
const OTHER_IDENTITY = '03'.repeat(33)
const TXID = 'c1'.repeat(32)
const TIP = `${TXID}.0`
const LIST_CACHE_KEY = 'handcash.collectables.list.v1'

const active = {
  identityKey: IDENTITY,
  address: '1HandCashTestAddressAAAAAAAAAAAAAA',
  chain: 'main' as const,
  wallet: {
    listOutputs: vi.fn(async () => ({
      outputs: [{ outpoint: TIP, satoshis: 1, tags: ['ordinal', `origin:${TIP}`] }],
    })),
  },
}

vi.mock('./session', () => ({
  getActiveWallet: () => active,
}))

function seedDurableList(identityKey: string | null) {
  store.set(
    LIST_CACHE_KEY,
    JSON.stringify({
      at: Date.now(),
      identityKey,
      items: [
        {
          outpoint: TIP,
          origin: TIP,
          name: 'Test Item',
          imageUrl: '',
          satoshis: 1,
          traits: [],
          extras: [],
          proven: false,
          authenticity: 'unproven',
        },
      ],
    }),
  )
}

describe('collectables across a cold open', () => {
  beforeEach(() => {
    vi.resetModules()
    store.clear()
  })

  it('paints the durable list before any basket read', async () => {
    seedDurableList(IDENTITY)
    const { getCachedCollectables, areCollectablesHydrated } = await import(
      './collectables'
    )
    expect(getCachedCollectables().map((c) => c.outpoint)).toEqual([TIP])
    expect(areCollectablesHydrated()).toBe(true)
  })

  it('keeps the painted list when recompose rebuilds localState', async () => {
    seedDurableList(IDENTITY)
    const { relistCollectablesAfterLocalStateReplace, getCachedCollectables } =
      await import('./collectables')
    await relistCollectablesAfterLocalStateReplace()
    expect(getCachedCollectables().map((c) => c.outpoint)).toEqual([TIP])
    // The durable copy has to survive too — dropping it emptied the next boot.
    expect(store.get(LIST_CACHE_KEY)).toBeDefined()
  })

  it('drops a list cached for a different identity', async () => {
    seedDurableList(OTHER_IDENTITY)
    const { relistCollectablesAfterLocalStateReplace } = await import(
      './collectables'
    )
    await relistCollectablesAfterLocalStateReplace()
    const raw = store.get(LIST_CACHE_KEY) ?? null
    const identityKey = raw
      ? (JSON.parse(raw) as { identityKey?: string }).identityKey
      : null
    expect(identityKey).toBe(IDENTITY)
  })
})
