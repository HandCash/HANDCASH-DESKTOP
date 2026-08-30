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
let recomposeActive = false

vi.mock('./walletCoordinator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./walletCoordinator')>()),
  isRecomposeCoordinatorActive: () => recomposeActive,
}))

const active = {
  identityKey: IDENTITY,
  address: '1HandCashTestAddressAAAAAAAAAAAAAA',
  chain: 'main' as const,
  wallet: {
    listOutputs: vi.fn(async () => ({
      outputs: [{ outpoint: TIP, satoshis: 1, tags: ['ordinal', `origin:${TIP}`, 'name:Test Item'] }],
    })),
  },
}

vi.mock('./session', () => ({
  getActiveWallet: () => active,
}))

function itemRow(outpoint: string, name: string) {
  return {
    outpoint,
    origin: outpoint.replace('.', '_'),
    name,
    imageUrl: '',
    satoshis: 1,
    traits: [] as [],
    extras: [] as [],
    proven: false,
    authenticity: 'unproven' as const,
  }
}

function seedDurableList(identityKey: string | null, items = [itemRow(TIP, 'Test Item')]) {
  store.set(
    LIST_CACHE_KEY,
    JSON.stringify({
      at: Date.now(),
      identityKey,
      items,
    }),
  )
}

describe('collectables across a cold open', () => {
  beforeEach(() => {
    vi.resetModules()
    store.clear()
    recomposeActive = false
    active.wallet.listOutputs.mockResolvedValue({
      outputs: [{ outpoint: TIP, satoshis: 1, tags: ['ordinal', `origin:${TIP}`, 'name:Test Item'] }],
    })
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

  it('does not replace durable cards with a temporary empty recompose store', async () => {
    seedDurableList(IDENTITY)
    recomposeActive = true
    active.wallet.listOutputs.mockResolvedValueOnce({
      outputs: [],
      totalOutputs: 0,
    })
    const { listCollectables, getCachedCollectables } = await import('./collectables')

    await listCollectables(active as never)

    expect(getCachedCollectables().map((c) => c.outpoint)).toEqual([TIP])
    expect(JSON.parse(store.get(LIST_CACHE_KEY)!).items).toHaveLength(1)
  })

  it('paints new 1sat tips listed during recompose instead of hiding them', async () => {
    seedDurableList(IDENTITY)
    recomposeActive = true
    const extra = `${'d2'.repeat(32)}.0`
    active.wallet.listOutputs.mockResolvedValueOnce({
      outputs: [
        { outpoint: TIP, satoshis: 1, tags: ['ordinal', `origin:${TIP}`, 'name:Test Item'] },
        { outpoint: extra, satoshis: 1, tags: ['ordinal', 'name:Pixel'] },
      ],
      totalOutputs: 2,
    })
    const { listCollectables, getCachedCollectables } = await import('./collectables')

    await listCollectables(active as never)

    const ops = getCachedCollectables().map((c) => c.outpoint)
    expect(ops).toEqual(expect.arrayContaining([TIP, extra]))
    expect(ops).toHaveLength(2)
  })

  it('allows the explicit post-replace relist to confirm a real empty inventory', async () => {
    seedDurableList(IDENTITY)
    recomposeActive = true
    active.wallet.listOutputs.mockResolvedValueOnce({
      outputs: [],
      totalOutputs: 0,
    })
    const {
      relistCollectablesAfterLocalStateReplace,
      getCachedCollectables,
    } = await import('./collectables')

    await relistCollectablesAfterLocalStateReplace()

    expect(getCachedCollectables()).toEqual([])
    expect(JSON.parse(store.get(LIST_CACHE_KEY)!).items).toEqual([])
  })

  it('keeps N cached items when listOutputs returns 0 during sync', async () => {
    const n = 7
    const rows = Array.from({ length: n }, (_, i) => {
      const tx = i.toString(16).padStart(2, '0').repeat(32)
      return itemRow(`${tx}.${i}`, `Card ${i + 1}`)
    })
    seedDurableList(IDENTITY, rows)
    recomposeActive = false
    active.wallet.listOutputs.mockResolvedValueOnce({
      outputs: [],
      totalOutputs: 0,
    })
    const { listCollectables, getCachedCollectables } = await import('./collectables')

    await listCollectables(active as never)

    expect(getCachedCollectables()).toHaveLength(n)
    expect(getCachedCollectables().map((c) => c.name)).toEqual(rows.map((r) => r.name))
    expect(JSON.parse(store.get(LIST_CACHE_KEY)!).items).toHaveLength(n)
  })

  it('merges a new outpoint from a short sync page without dropping the rest', async () => {
    const extra = `${'ab'.repeat(32)}.0`
    seedDurableList(IDENTITY, [
      itemRow(TIP, 'Test Item'),
      itemRow(`${'cd'.repeat(32)}.0`, 'Kept Card'),
    ])
    recomposeActive = false
    active.wallet.listOutputs.mockResolvedValueOnce({
      outputs: [
        { outpoint: extra, satoshis: 1, tags: ['ordinal', 'name:New Arrival'] },
      ],
      totalOutputs: 1,
    })
    const { listCollectables, getCachedCollectables } = await import('./collectables')

    await listCollectables(active as never)

    const ops = getCachedCollectables().map((c) => c.outpoint)
    expect(ops).toEqual(expect.arrayContaining([TIP, `${'cd'.repeat(32)}.0`, extra]))
    expect(ops).toHaveLength(3)
  })

  it('keeps a named card when the sync page omits remittance names', async () => {
    seedDurableList(IDENTITY)
    recomposeActive = false
    active.wallet.listOutputs.mockResolvedValueOnce({
      outputs: [{ outpoint: TIP, satoshis: 1, tags: ['ordinal', `origin:${TIP}`] }],
      totalOutputs: 1,
    })
    const { listCollectables, getCachedCollectables } = await import('./collectables')

    await listCollectables(active as never)

    expect(getCachedCollectables()).toHaveLength(1)
    expect(getCachedCollectables()[0]?.name).toBe('Test Item')
  })

  it('does not paint leftover 1sat-ft origins as collectables', async () => {
    const ftOrigin = `${'ee'.repeat(32)}_0`
    const ftTip = `${'ff'.repeat(32)}.1`
    const leftover = await import('./onesatFtLeftover')
    leftover.rememberOnesatFtLeftover({
      origin: ftOrigin,
      amt: 69,
      outpoint: ftTip.replace('.', '_'),
      ci: JSON.stringify({ p: '1sat-ft', origin: ftOrigin, amt: '69' }),
      sym: 'OLD',
      supply: 'locked',
      maxSupply: 100,
    })
    active.wallet.listOutputs.mockResolvedValueOnce({
      outputs: [
        { outpoint: TIP, satoshis: 1, tags: ['ordinal', `origin:${TIP}`, 'name:Test Item'] },
        {
          outpoint: ftTip,
          satoshis: 1,
          tags: ['ordinal', `origin:${ftOrigin.replace('_0', '.0')}`],
        },
      ],
      totalOutputs: 2,
    })
    const { listCollectables, getCachedCollectables } = await import('./collectables')
    await listCollectables(active as never)
    expect(getCachedCollectables().map((c) => c.outpoint)).toEqual([TIP])
  })

  it('drops hashed origin-only cards from the durable list', async () => {
    store.set(
      LIST_CACHE_KEY,
      JSON.stringify({
        at: Date.now(),
        identityKey: IDENTITY,
        items: [
          {
            outpoint: TIP,
            origin: TIP.replace('.', '_'),
            name: 'c1c1c1c1…_0',
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
    const { getCachedCollectables } = await import('./collectables')
    expect(getCachedCollectables()).toEqual([])
  })
})
