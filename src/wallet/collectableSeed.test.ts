import { beforeEach, describe, expect, it, vi } from 'vitest'

// The grid is rebuilt from the basket read alone, so a tip the wallet minted to
// itself has to be carried until the read admits it. These cover that carry.

vi.mock('./sentItemGuard', () => ({
  isItemSent: () => false,
  markItemsSent: vi.fn(),
  getSentItemRecord: () => null,
}))

const TXID = 'd4'.repeat(32)
const TIP = `${TXID}.0`

function walletListing(outpoints: string[]) {
  return {
    address: '1HandCashTestAddressAAAAAAAAAAAAAA',
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
})
