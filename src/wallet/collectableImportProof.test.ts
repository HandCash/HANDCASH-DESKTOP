import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Packet D (docs/migration-remediation-plan.md): imported items enter BRC-150
// verification on their own, survive a restart and an offline walk, and only a
// complete lineage proof marks them proven — indexer and tag hints never do.

const durable = vi.hoisted(() => new Map<string, string>())
vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => durable.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    durable.set(key, value)
    return true
  },
  durableRemoveItem: (key: string) => {
    durable.delete(key)
  },
  durableForgetCached: () => {},
}))

vi.mock('./sentItemGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sentItemGuard')>()),
  isItemSent: () => false,
  markItemsSent: vi.fn(),
  getSentItemRecord: () => null,
}))

const beef = vi.hoisted(() => ({
  local: true,
  getLocalBeefForTxid: vi.fn(),
  getBeefForTxidCached: vi.fn(),
}))
vi.mock('./beefCache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./beefCache')>()),
  getLocalBeefForTxid: (...args: unknown[]) => beef.getLocalBeefForTxid(...args),
  getBeefForTxidCached: (...args: unknown[]) => beef.getBeefForTxidCached(...args),
}))

type Outcome = 'proven' | 'invalid' | 'unavailable' | 'aborted' | 'hang'
const walks = vi.hoisted(() => ({
  tips: [] as string[],
  outcome: (_tip: string): Outcome => 'invalid',
}))
vi.mock('./oneSatGenesisProof', async (importOriginal) => {
  const { Beef } = await import('@bsv/sdk')
  return {
    ...(await importOriginal<typeof import('./oneSatGenesisProof')>()),
    proveGenesisLineage: () => new Promise<never>(() => {}),
    walkGenesisLineage: async (args: { tipOutpoint: string; getBeef: (txid: string) => Promise<unknown> }) => {
      walks.tips.push(args.tipOutpoint)
      // Snapshot before yielding: a simulated restart must not change the old
      // process's hanging walk into a successful write to shared durable storage.
      const outcome = walks.outcome(args.tipOutpoint)
      await args.getBeef(args.tipOutpoint.slice(0, 64))
      if (outcome === 'hang') return new Promise<never>(() => {})
      if (outcome === 'invalid') return { kind: 'invalid' as const, reason: 'missing ancestor', hops: 2 }
      if (outcome === 'unavailable') return { kind: 'unavailable' as const, reason: 'offline', hops: 1 }
      if (outcome === 'aborted') return { kind: 'aborted' as const, reason: 'stopped', hops: 0 }
      const origin = args.tipOutpoint.replace('.', '_')
      return { kind: 'proven' as const, proof: { origin, path: [origin], hops: 0, beef: new Beef() } }
    },
  }
})

const indexer = vi.hoisted(() => ({ hint: null as null | { origin: string; name: string } }))
vi.mock('./oneSatImport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./oneSatImport')>()),
  resolveInscriptionPreferringOrigin: async () =>
    indexer.hint ? { ...indexer.hint, traits: [], extras: [] } : null,
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

const TIPS = Array.from({ length: 4 }, (_, i) => `${String(i + 21).padStart(2, '0').repeat(32)}.0`)
const HINT_ORIGIN = `${'ee'.repeat(32)}_0`

const basket = vi.hoisted(() => ({ outputs: [] as { outpoint: string; tags: string[] }[] }))
const active = {
  identityKey: '02'.repeat(33),
  address: '1HandCashTestAddressAAAAAAAAAAAAAA',
  chain: 'main' as const,
  wallet: {
    listOutputs: vi.fn(async (args: { basket?: string; includeTags?: boolean; limit?: number; offset?: number }) => {
      if (args.basket !== '1sat' || !args.includeTags) return { outputs: [] }
      const start = Math.max(0, -(args.offset ?? -1) - 1)
      const limit = Math.max(1, args.limit ?? basket.outputs.length)
      return {
        totalOutputs: basket.outputs.length,
        outputs: basket.outputs.slice(start, start + limit).map((o) => ({ ...o, satoshis: 1 })),
      }
    }),
  },
}

vi.mock('./session', () => ({
  getActiveWallet: () => active,
}))

const listed = (outpoint: string, origin = outpoint) => ({
  outpoint,
  tags: ['ordinal', `origin:${origin}`, `name:item ${outpoint.slice(0, 4)}`],
})

beforeEach(() => {
  vi.resetModules()
  durable.clear()
  walks.tips.length = 0
  walks.outcome = () => 'invalid'
  indexer.hint = null
  basket.outputs = []
  beef.local = true
  beef.getLocalBeefForTxid.mockReset()
  beef.getBeefForTxidCached.mockReset()
  beef.getLocalBeefForTxid.mockImplementation(async () => (beef.local ? { local: true } : null))
  beef.getBeefForTxidCached.mockImplementation(async () => ({ fetched: true }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** A fresh module graph over the same durable storage: an app restart. */
async function restart() {
  vi.resetModules()
  return {
    collectables: await import('./collectables'),
    cache: await import('./provenCache'),
  }
}

describe('imported item proof verification (packet D)', () => {
  beforeAll(async () => {
    await import('./collectables')
  }, 60_000)

  it('drains a receipt batch without per-card Toolbox remittance reads', async () => {
    walks.outcome = () => 'invalid'
    const collectables = await import('./collectables')
    active.wallet.listOutputs.mockClear()
    collectables.noteIngestedItems(TIPS.map((outpoint) => ({ outpoint, chain: 'main' as const })))
    await vi.waitFor(() => expect(new Set(walks.tips)).toEqual(new Set(TIPS)), { timeout: 4_000 })
    expect(active.wallet.listOutputs).not.toHaveBeenCalled()
    expect(collectables.getCachedCollectables().every((item) => !item.proven)).toBe(true)
  })

  it('walks import receipts again after a restart that cut their walk short', async () => {
    walks.outcome = () => 'hang'
    const first = await import('./collectables')
    first.noteIngestedItems(TIPS.map((outpoint) => ({ outpoint, chain: 'main' as const, name: 'Imported' })))
    await vi.waitFor(() => expect(walks.tips.length).toBeGreaterThan(0))
    expect(first.getCachedCollectables().some((c) => c.proven)).toBe(false)

    walks.tips.length = 0
    walks.outcome = () => 'proven'
    const { collectables, cache } = await restart()
    // Basket has not caught up: only the persisted receipts know these tips.
    await collectables.listCollectables(active)

    await vi.waitFor(() => expect(new Set(walks.tips)).toEqual(new Set(TIPS)), { timeout: 4_000 })
    await vi.waitFor(
      () => {
        const items = collectables.getCachedCollectables()
        expect(items.map((c) => c.outpoint).sort()).toEqual([...TIPS].sort())
        expect(items.every((c) => c.proven && c.authenticity === 'brc150')).toBe(true)
      },
      { timeout: 4_000 },
    )
    for (const tip of TIPS) expect(cache.getProvenVerdict(tip)?.tier).toBe('brc150')
  })

  it('retries an offline walk after the transient window, across a restart, and only then proves it', async () => {
    beef.local = false
    walks.outcome = () => 'unavailable'
    basket.outputs = [listed(TIPS[0])]
    const first = await import('./collectables')
    const firstCache = await import('./provenCache')
    await first.listCollectables(active)

    await vi.waitFor(() => expect(firstCache.getGenesisFailure(TIPS[0])?.kind).toBe('unavailable'), { timeout: 4_000 })
    expect(first.getCachedCollectables().every((c) => !c.proven)).toBe(true)
    expect(firstCache.getProvenVerdict(TIPS[0])).toBeFalsy()

    // Inside the hour: a relaunch must not hammer the network again.
    walks.tips.length = 0
    let early = await restart()
    await early.collectables.listCollectables(active)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(walks.tips).toEqual([])
    expect(early.cache.shouldAttemptGenesis(TIPS[0])).toBe(false)

    // Back online an hour later.
    const realNow = Date.now.bind(Date)
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 61 * 60_000)
    walks.outcome = () => 'proven'
    early = await restart()
    expect(early.cache.shouldAttemptGenesis(TIPS[0])).toBe(true)
    await early.collectables.listCollectables(active)

    await vi.waitFor(() => expect(walks.tips).toContain(TIPS[0]), { timeout: 4_000 })
    await vi.waitFor(
      () => expect(early.collectables.getCachedCollectables().find((c) => c.outpoint === TIPS[0])?.proven).toBe(true),
      { timeout: 4_000 },
    )
    expect(early.cache.getProvenVerdict(TIPS[0])?.tier).toBe('brc150')
    expect(early.cache.getGenesisFailure(TIPS[0])).toBeFalsy()
  })

  it('keeps an item with incomplete ancestry unproven even when its tag and the indexer name an origin', async () => {
    walks.outcome = () => 'invalid'
    indexer.hint = { origin: HINT_ORIGIN, name: 'Indexer says genuine' }
    basket.outputs = [listed(TIPS[1], HINT_ORIGIN.replace('_', '.'))]
    const { listCollectables, getCachedCollectables } = await import('./collectables')
    const cache = await import('./provenCache')
    await listCollectables(active)

    await vi.waitFor(() => expect(cache.getGenesisFailure(TIPS[1])?.kind).toBe('invalid'), { timeout: 4_000 })
    // Let the indexer lookup land too; it may enrich the card but never prove it.
    await new Promise((resolve) => setTimeout(resolve, 400))
    const item = getCachedCollectables().find((c) => c.outpoint === TIPS[1])
    expect(item).toBeTruthy()
    expect(item?.proven).toBe(false)
    expect(item?.authenticity).not.toBe('brc150')
    expect(cache.getProvenVerdict(TIPS[1])).toBeFalsy()
    // Invalid is a verdict about the item: wait the full day before walking again.
    expect(cache.shouldAttemptGenesis(TIPS[1])).toBe(false)
  })

  it('does not pin an aborted walk, so the item is walked again', async () => {
    walks.outcome = () => 'aborted'
    basket.outputs = [listed(TIPS[2])]
    const { listCollectables, getCachedCollectables } = await import('./collectables')
    const cache = await import('./provenCache')
    await listCollectables(active)

    await vi.waitFor(() => expect(cache.getGenesisFailure(TIPS[2])?.kind).toBe('aborted'), { timeout: 4_000 })
    expect(cache.shouldAttemptGenesis(TIPS[2])).toBe(true)
    expect(getCachedCollectables().every((c) => !c.proven)).toBe(true)
    expect(cache.getProvenVerdict(TIPS[2])).toBeFalsy()
  })
})
