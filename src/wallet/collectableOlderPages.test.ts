import { P2PKH, PrivateKey } from '@bsv/sdk'
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
  },
  durableForgetCached: () => {},
}))

vi.mock('./sentItemGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sentItemGuard')>()),
  isItemSent: () => false,
  markItemsSent: vi.fn(),
  getSentItemRecord: () => null,
}))

const ours = PrivateKey.fromRandom().toAddress()
const OUR_LOCK = new P2PKH().lock(ours).toHex()

function row(i: number) {
  const txid = i.toString(16).padStart(64, '0')
  return {
    outpoint: `${txid}.0`,
    satoshis: 1,
    tags: ['ordinal', `origin:${txid}.0`, `name:item-${i}`],
    lockingScript: OUR_LOCK,
  }
}

/** Newest first, as a negative-offset `listOutputs` answers. */
let basket: ReturnType<typeof row>[] = []

const active = {
  identityKey: '02'.repeat(33),
  address: ours,
  chain: 'main' as const,
  wallet: {
    listOutputs: vi.fn(async (args: { basket?: string; includeTags?: boolean; tags?: string[]; limit?: number; offset?: number }) => {
      if (args.basket !== '1sat' || args.tags || !args.includeTags) return { outputs: [] }
      const offset = args.offset ?? 0
      const at = offset < 0 ? -offset - 1 : offset
      return { outputs: basket.slice(at, at + (args.limit ?? 10)), totalOutputs: basket.length }
    }),
  },
}

vi.mock('./session', () => ({
  getActiveWallet: () => active,
}))

vi.mock('./legacyScan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./legacyScan')>()),
  scanLegacyAddress: async () => ({
    address: ours,
    chain: 'main' as const,
    sats: 0,
    utxos: [],
    source: 'bitails' as const,
  }),
}))

beforeEach(() => {
  vi.resetModules()
  store.clear()
  active.wallet.listOutputs.mockClear()
  basket = Array.from({ length: 2_500 }, (_, i) => row(2_500 - i))
})

describe('Collect reads every page of a basket that fits', () => {
  it('loads the older pages in the background after the newest one', async () => {
    const { listCollectables, getCachedCollectables, getCollectablePageStatus } = await import('./collectables')

    await listCollectables(active)

    await vi.waitFor(() => expect(getCachedCollectables()).toHaveLength(2_500), { timeout: 20_000 })
    expect(getCollectablePageStatus()).toMatchObject({ loadedOutputs: 2_500, totalOutputs: 2_500, hasMore: false })
  }, 30_000)

  it('still pages when the grid already held more cards than one page', async () => {
    const { listCollectables, getCachedCollectables, getCollectablePageStatus, noteIngestedItems } =
      await import('./collectables')
    const newestPage = basket.slice(0, 1_000)
    basket = newestPage
    await listCollectables(active)
    expect(getCachedCollectables()).toHaveLength(1_000)

    // An import leg paints its cards before any read lists them, so the grid
    // is ahead of the newest page when the basket is next read.
    const painted = Array.from({ length: 24 }, (_, i) => row(10_000 + i))
    noteIngestedItems(painted.map((p) => ({ outpoint: p.outpoint, chain: 'main' as const, origin: `${p.outpoint.slice(0, 64)}_0` })))
    const older = Array.from({ length: 1_476 }, (_, i) => row(5_000 + i))
    basket = [...painted, ...newestPage, ...older]

    await listCollectables(active)

    await vi.waitFor(() => {
      const shown = new Set(getCachedCollectables().map((c) => c.outpoint))
      expect(basket.filter((listed) => !shown.has(listed.outpoint))).toEqual([])
    }, { timeout: 20_000 })
    expect(getCollectablePageStatus().hasMore).toBe(false)
  }, 30_000)
})
