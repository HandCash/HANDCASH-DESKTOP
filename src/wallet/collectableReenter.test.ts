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

vi.mock('./sentItemGuard', () => ({
  isItemSent: () => false,
  markItemsSent: vi.fn(),
  getSentItemRecord: () => null,
}))

const ORIGIN = `${'bb'.repeat(32)}_0`
const OLD_TIP = `${'aa'.repeat(32)}.0`
const NEW_TIP = `${'cc'.repeat(32)}.1`
const RESOLUTION_KEY = 'handcash.inscriptionResolution.v1'

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
    const { groups, loose } = groupCollectables(items)
    expect(groups.some((g) => g.collectionId === 'pixel-foxes')).toBe(true)
    expect(loose.some((item) => item.outpoint === NEW_TIP)).toBe(false)
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
})
