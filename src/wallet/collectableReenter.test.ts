import { beforeEach, describe, expect, it, vi } from 'vitest'
import { groupCollectables } from './collectableGroups'

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

const ORIGIN = `${'bb'.repeat(32)}_0`
const OLD_TIP = `${'aa'.repeat(32)}.0`
const NEW_TIP = `${'cc'.repeat(32)}.1`
const RESOLUTION_KEY = 'handcash.inscriptionResolution.v1'
/** A received tip painted from its receipt; no basket read has listed it yet. */
const SEEDED_TIP = `${'f1'.repeat(32)}.0`
const SEEDED_ORIGIN = `${'f2'.repeat(32)}_0`

const active = {
  identityKey: '02'.repeat(33),
  address: '1HandCashTestAddressAAAAAAAAAAAAAA',
  chain: 'main' as const,
  wallet: {
    listOutputs: vi.fn(async () => ({
      outputs: [
        {
          outpoint: NEW_TIP,
          satoshis: 1,
          tags: [
            'ordinal',
            `origin:${ORIGIN.replace('_0', '.0')}`,
            'name:fox',
            'collection:pixel-foxes',
          ],
          customInstructions: JSON.stringify({
            origin: ORIGIN,
            name: 'Fox #1',
            collectionId: 'pixel-foxes',
            app: 'Zoo',
          }),
        },
        {
          outpoint: `${'dd'.repeat(32)}.0`,
          satoshis: 1,
          tags: [
            'ordinal',
            `origin:${`${'ee'.repeat(32)}_0`.replace('_0', '.0')}`,
            'name:fox2',
            'collection:pixel-foxes',
          ],
          customInstructions: JSON.stringify({
            origin: `${'ee'.repeat(32)}_0`,
            name: 'Fox #2',
            collectionId: 'pixel-foxes',
            app: 'Zoo',
          }),
        },
      ],
    })),
  },
}

vi.mock('./session', () => ({
  getActiveWallet: () => active,
}))

vi.mock('./oneSatGenesisProof', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./oneSatGenesisProof')>()),
  proveGenesisLineage: async ({ tipOutpoint }: { tipOutpoint: string }) => ({
    origin: SEEDED_ORIGIN,
    path: [tipOutpoint.split('.')[0]],
    hops: 1,
  }),
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

describe('re-entered collectables', () => {
  beforeEach(async () => {
    vi.resetModules()
    store.clear()
    store.set(
      RESOLUTION_KEY,
      JSON.stringify({
        [ORIGIN]: {
          origin: ORIGIN,
          name: 'Fox #1',
          app: 'Zoo',
          collectionId: 'pixel-foxes',
          traits: [],
          extras: [],
        },
      }),
    )
    active.wallet.listOutputs.mockClear()
  })

  it('groups re-entered tips by remittance collectionId', async () => {
    const { listCollectables } = await import('./collectables')
    const items = await listCollectables(active)
    const reentered = items.find((item) => item.outpoint === NEW_TIP)
    expect(reentered?.collectionId).toBe('pixel-foxes')
    const { groups, singles, ungrouped } = groupCollectables(items)
    expect(groups.some((g) => g.collectionId === 'pixel-foxes')).toBe(true)
    expect(
      [...singles, ...ungrouped].some((item) => item.outpoint === NEW_TIP),
    ).toBe(false)
  })

  it('seeds image from origin cache while verifying', async () => {
    const { noteIngestedItem, getCachedCollectables } = await import('./collectables')
    noteIngestedItem({
      outpoint: NEW_TIP,
      chain: 'main',
      origin: ORIGIN,
      name: 'Fox #1',
      collectionId: 'pixel-foxes',
    })
    const seeded = getCachedCollectables().find((item) => item.outpoint === NEW_TIP)
    expect(seeded?.collectionId).toBe('pixel-foxes')
    expect(seeded?.imageUrl).toContain(ORIGIN)
    expect(seeded?.imageUrl).not.toContain(NEW_TIP.split('.')[0]!)
  })

  it('never publishes a list without a seeded receipt while it proves its origin', async () => {
    const { listCollectables, noteIngestedItem, subscribeCollectables, verifyItemAuthenticity } =
      await import('./collectables')
    await listCollectables(active)
    noteIngestedItem({ outpoint: SEEDED_TIP, chain: 'main', origin: SEEDED_ORIGIN, name: 'Gift' })
    // A drop the next relist re-adds is the "re-entered announced cards" churn.
    const published: string[][] = []
    const stop = subscribeCollectables((items) => published.push(items.map((item) => item.outpoint)))

    const verdict = await verifyItemAuthenticity(SEEDED_TIP, SEEDED_ORIGIN, active as never)
    await vi.waitFor(() => expect(published.length).toBeGreaterThan(1))
    stop()
    expect(verdict.proven).toBe(true)
    expect(published.filter((list) => !list.includes(SEEDED_TIP))).toEqual([])
  })

  it('keeps a receipt painted before the first basket read through its proof', async () => {
    const { noteIngestedItem, getCachedCollectables, verifyItemAuthenticity } =
      await import('./collectables')
    noteIngestedItem({ outpoint: SEEDED_TIP, chain: 'main', origin: SEEDED_ORIGIN, name: 'Gift' })
    await verifyItemAuthenticity(SEEDED_TIP, SEEDED_ORIGIN, active as never)
    expect(getCachedCollectables().map((item) => item.outpoint)).toEqual([SEEDED_TIP])
  })
})
