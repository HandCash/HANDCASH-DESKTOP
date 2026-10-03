import { beforeEach, describe, expect, it, vi } from 'vitest'

// A cold open must paint last session's items. Recompose used to empty the
// durable list cache, so the next boot started at zero and Collect showed
// "Looking for collectables…" on a wallet that already held tips.

// Partial: only the reads this cold open pins. Spreading the real module keeps a
// new guard export from surfacing as an unhandled rejection mid-list.
vi.mock('./sentItemGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sentItemGuard')>()),
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
/** A send or sync holding a coordinator region. */
let walletBusy = false

vi.mock('./walletCoordinator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./walletCoordinator')>()
  return {
    ...actual,
    isRecomposeCoordinatorActive: () => recomposeActive,
    walletRegionsIdle: () => !recomposeActive && !walletBusy && actual.walletRegionsIdle(),
    walletRegionsIdleSince: (generation: number) =>
      !recomposeActive && !walletBusy && actual.walletRegionsIdleSince(generation),
  }
})

const reportHoldings = vi.fn()
vi.mock('./holdingsReconcile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./holdingsReconcile')>()),
  reportHoldings: (...args: unknown[]) => reportHoldings(...args),
}))

function filedDepartures(): string[] {
  return reportHoldings.mock.calls.flatMap(
    ([report]) => (report as { leftBasket?: Array<{ outpoint: string }> }).leftBasket?.map((l) => l.outpoint) ?? [],
  )
}

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

vi.mock('./legacyScan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./legacyScan')>()),
  scanLegacyAddress: async () => ({
    address: '1HandCashTestAddressAAAAAAAAAAAAAA',
    chain: 'main' as const,
    sats: 0,
    utxos: [],
    source: 'bitails' as const,
  }),
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
    walletBusy = false
    reportHoldings.mockClear()
    active.wallet.listOutputs.mockReset()
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

  it('defers a read while a send holds the wallet, so a reserved input cannot shrink the list', async () => {
    const tips = Array.from({ length: 7 }, (_, index) => ({
      ...itemRow(`${(index + 1).toString(16).padStart(2, '0').repeat(32)}.0`, `Item ${index + 1}`),
    }))
    seedDurableList(IDENTITY, tips)
    walletBusy = true
    active.wallet.listOutputs.mockClear()
    const { listCollectables, getCachedCollectables } = await import('./collectables')

    await listCollectables(active as never)

    expect(active.wallet.listOutputs).not.toHaveBeenCalled()
    expect(getCachedCollectables()).toHaveLength(7)
    expect(reportHoldings).not.toHaveBeenCalled()
  })

  it('defers reads during recompose and paints new tips from the post-replace relist', async () => {
    seedDurableList(IDENTITY)
    recomposeActive = true
    const extra = `${'d2'.repeat(32)}.0`
    active.wallet.listOutputs.mockResolvedValue({
      outputs: [
        { outpoint: TIP, satoshis: 1, tags: ['ordinal', `origin:${TIP}`, 'name:Test Item'] },
        { outpoint: extra, satoshis: 1, tags: ['ordinal', `origin:${extra}`, 'name:Pixel'] },
      ],
      totalOutputs: 2,
    })
    const { listCollectables, relistCollectablesAfterLocalStateReplace, getCachedCollectables } =
      await import('./collectables')

    await listCollectables(active as never)
    expect(getCachedCollectables().map((c) => c.outpoint)).toEqual([TIP])

    recomposeActive = false
    await relistCollectablesAfterLocalStateReplace()
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
    walletBusy = true
    active.wallet.listOutputs.mockResolvedValueOnce({
      outputs: [],
      totalOutputs: 0,
    })
    const { listCollectables, getCachedCollectables } = await import('./collectables')

    await listCollectables(active as never)

    expect(reportHoldings).not.toHaveBeenCalled()
    expect(getCachedCollectables()).toHaveLength(n)
    expect(getCachedCollectables().map((c) => c.name)).toEqual(rows.map((r) => r.name))
    expect(JSON.parse(store.get(LIST_CACHE_KEY)!).items).toHaveLength(n)
  })

  it('projects a complete idle read exactly, filing every card it no longer lists', async () => {
    const extra = `${'ab'.repeat(32)}.0`
    const gone = `${'cd'.repeat(32)}.0`
    seedDurableList(IDENTITY, [itemRow(TIP, 'Test Item'), itemRow(gone, 'Gone Card')])
    active.wallet.listOutputs.mockResolvedValueOnce({
      outputs: [{ outpoint: extra, satoshis: 1, tags: ['ordinal', `origin:${extra}`, 'name:New Arrival'] }],
      totalOutputs: 1,
    })
    const { listCollectables, getCachedCollectables } = await import('./collectables')

    await listCollectables(active as never)

    expect(getCachedCollectables().map((c) => c.outpoint)).toEqual([extra])
    expect(JSON.parse(store.get(LIST_CACHE_KEY)!).items).toHaveLength(1)
    // Nothing leaves silently: the chain is asked about each one.
    expect(filedDepartures().sort()).toEqual([TIP, gone].sort())
  })

  it('keeps every card when a send began and ended inside the read', async () => {
    seedDurableList(IDENTITY, [itemRow(TIP, 'Test Item'), itemRow(`${'ef'.repeat(32)}.0`, 'Reserved')])
    const { leaseSpendPriority } = await import('./walletCoordinator')
    active.wallet.listOutputs.mockImplementationOnce(async () => {
      leaseSpendPriority('test-send').release()
      return {
        outputs: [{ outpoint: TIP, satoshis: 1, tags: ['ordinal', `origin:${TIP}`, 'name:Test Item'] }],
        totalOutputs: 1,
      }
    })
    const { listCollectables, getCachedCollectables } = await import('./collectables')

    await listCollectables(active as never)

    expect(getCachedCollectables()).toHaveLength(2)
    expect(reportHoldings).not.toHaveBeenCalled()
  })

  it('files an empty idle read too, so a wrongly emptied basket is restored from the chain', async () => {
    seedDurableList(IDENTITY, [itemRow(TIP, 'Test Item'), itemRow(`${'ef'.repeat(32)}.0`, 'Kept')])
    active.wallet.listOutputs.mockResolvedValueOnce({ outputs: [], totalOutputs: 0 })
    const { listCollectables, getCachedCollectables } = await import('./collectables')

    await listCollectables(active as never)

    expect(getCachedCollectables()).toEqual([])
    expect(filedDepartures()).toHaveLength(2)
  })

  it('keeps a card the address scan still lists, and still files it', async () => {
    const onAddress = `${'ef'.repeat(32)}.0`
    seedDurableList(IDENTITY, [itemRow(TIP, 'Test Item'), itemRow(onAddress, 'On Address')])
    active.wallet.listOutputs.mockResolvedValue({
      outputs: [{ outpoint: TIP, satoshis: 1, tags: ['ordinal', `origin:${TIP}`, 'name:Test Item'] }],
      totalOutputs: 1,
    })
    const { listCollectables, getCachedCollectables, rememberLiveOneSatOutpoints } = await import(
      './collectables'
    )
    rememberLiveOneSatOutpoints([{ outpoint: onAddress, satoshis: 1 }], IDENTITY)

    await listCollectables(active as never)

    expect(getCachedCollectables().map((c) => c.outpoint)).toEqual(
      expect.arrayContaining([TIP, onAddress]),
    )
    expect(filedDepartures()).toEqual([onAddress])
  })

  it('runs a read deferred by chain ingest once the wallet goes idle', async () => {
    seedDurableList(IDENTITY)
    recomposeActive = false
    const { runChainIngest } = await import('./walletCoordinator')
    const { listCollectables } = await import('./collectables')
    active.wallet.listOutputs.mockClear()

    await runChainIngest(async () => {
      // Ingest asks for the list while it still holds the region.
      await listCollectables(active as never)
      expect(active.wallet.listOutputs).not.toHaveBeenCalled()
    })

    // Region released → the one coalesced follow-up reads the basket.
    await vi.waitFor(() => expect(active.wallet.listOutputs).toHaveBeenCalled(), {
      timeout: 5_000,
    })
  }, 15_000)

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

  it('does not replace a timed-out raw basket read with another live read', async () => {
    vi.useFakeTimers()
    try {
      seedDurableList(IDENTITY)
      const stalledWallet = {
        ...active,
        wallet: {
          listOutputs: vi.fn(() => new Promise<never>(() => {})),
        },
      }
      const { listCollectables } = await import('./collectables')

      const first = listCollectables(stalledWallet as never)
      await vi.advanceTimersByTimeAsync(21_000)
      await first
      expect(stalledWallet.wallet.listOutputs).toHaveBeenCalledTimes(1)

      const second = listCollectables(stalledWallet as never)
      await vi.advanceTimersByTimeAsync(21_000)
      await second
      expect(stalledWallet.wallet.listOutputs).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
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
