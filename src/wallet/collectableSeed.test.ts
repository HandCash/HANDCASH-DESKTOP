import { beforeEach, describe, expect, it, vi } from 'vitest'

// The grid is rebuilt from the basket read alone, so a tip the wallet minted to
// itself has to be carried until the read admits it. These cover that carry.

vi.mock('./sentItemGuard', () => ({
  isItemSent: () => false,
  markItemsSent: vi.fn(),
  getSentItemRecord: () => null,
}))

vi.mock('./legacyScan', () => ({
  scanLegacyAddress: vi.fn(async () => ({ utxos: [] })),
}))

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
}))

const active = vi.hoisted(() => ({ wallet: null as ReturnType<typeof walletListing> | null }))
vi.mock('./session', () => ({
  getActiveWallet: () => active.wallet,
}))

const TXID = 'd4'.repeat(32)
const TIP = `${TXID}.0`

function walletListing(outpoints: string[], identityKey = '02'.repeat(33)) {
  return {
    address: '1HandCashTestAddressAAAAAAAAAAAAAA',
    identityKey,
    chain: 'main' as const,
    wallet: {
      listOutputs: vi.fn(async () => ({
        outputs: outpoints.map((outpoint) => ({
          outpoint,
          satoshis: 1,
          tags: ['ordinal', `origin:${TXID}.0`],
        })),
      })),
    },
  }
}

describe('locally seeded collectables', () => {
  beforeEach(() => {
    durable.clear()
    active.wallet = walletListing([])
    vi.resetModules()
  })

  it('paints a tip the wallet just took custody of', async () => {
    const { noteIngestedItem, getCachedCollectables } = await import(
      './collectables'
    )
    noteIngestedItem({ outpoint: TIP, chain: 'main', name: 'Test Item' })
    expect(getCachedCollectables().map((c) => c.outpoint)).toContain(TIP)
  })

  it('survives a basket read that does not list it yet', async () => {
    const { noteIngestedItem, listCollectables } = await import(
      './collectables'
    )
    noteIngestedItem({ outpoint: TIP, chain: 'main', name: 'Test Item' })
    // The read the send races: the spent tip is gone, the replacement is not
    // filed yet. Rebuilding from this alone is what emptied the card.
    const after = await listCollectables(walletListing([]) as never)
    expect(after.map((c) => c.outpoint)).toContain(TIP)
  })

  it('retires the seed once the basket returns the tip', async () => {
    const { noteIngestedItem, listCollectables } = await import(
      './collectables'
    )
    noteIngestedItem({ outpoint: TIP, chain: 'main', name: 'Test Item' })
    const after = await listCollectables(walletListing([TIP]) as never)
    // One card, not two — the real row replaces the seed rather than joining it.
    expect(after.filter((c) => c.outpoint === TIP)).toHaveLength(1)
  })

  it('survives a renderer restart while Toolbox has not listed it yet', async () => {
    const first = await import('./collectables')
    first.noteIngestedItem({
      outpoint: TIP,
      chain: 'main',
      name: 'Test Item',
    })
    expect(first.getCachedCollectables().map((c) => c.outpoint)).toContain(TIP)

    // A renderer restart used to lose the in-memory seed. The first empty
    // listOutputs read then overwrote the durable card, producing the observed
    // nine-minute blank inventory while Toolbox settled the unmined tx.
    vi.resetModules()
    const restarted = await import('./collectables')
    const after = await restarted.listCollectables(walletListing([]) as never)
    expect(after.map((c) => c.outpoint)).toContain(TIP)
  })

  it('does not restore another identity’s received-item seed', async () => {
    const first = await import('./collectables')
    first.noteIngestedItem({
      outpoint: TIP,
      chain: 'main',
      name: 'Test Item',
    })

    vi.resetModules()
    const restarted = await import('./collectables')
    const otherIdentity = '03'.repeat(33)
    const after = await restarted.listCollectables(
      walletListing([], otherIdentity) as never,
    )
    expect(after.map((c) => c.outpoint)).not.toContain(TIP)
  })

  it('pages older outputs without silently truncating the basket', async () => {
    const newestTxid = 'a1'.repeat(32)
    const oldestTxid = 'b2'.repeat(32)
    const newest = `${newestTxid}.0`
    const oldest = `${oldestTxid}.0`
    const listOutputs = vi.fn(async (args: { offset?: number }) => ({
      totalOutputs: 2,
      outputs:
        args.offset === -1
          ? [{
              outpoint: newest,
              satoshis: 1,
              tags: ['ordinal', `origin:${newest}`],
            }]
          : [{
              outpoint: oldest,
              satoshis: 1,
              tags: ['ordinal', `origin:${oldest}`],
            }],
    }))
    const wallet = {
      address: '1HandCashTestAddressAAAAAAAAAAAAAA',
      identityKey: '02'.repeat(33),
      chain: 'main' as const,
      wallet: { listOutputs },
    }
    const {
      getCollectablePageStatus,
      listCollectables,
      loadMoreCollectables,
    } = await import('./collectables')

    expect((await listCollectables(wallet as never)).map((item) => item.outpoint))
      .toEqual([newest])
    expect(getCollectablePageStatus()).toEqual({
      loadedOutputs: 1,
      totalOutputs: 2,
      hasMore: true,
    })

    const all = await loadMoreCollectables(wallet as never)
    expect(new Set(all.map((item) => item.outpoint))).toEqual(
      new Set([newest, oldest]),
    )
    expect(listOutputs.mock.calls.map(([args]) => args.offset)).toEqual([-1, -2])
    expect(getCollectablePageStatus().hasMore).toBe(false)
  })
})
