import { beforeEach, describe, expect, it, vi } from 'vitest'

// Item detail must paint verified badges from durable storage without waiting
// on indexer or re-walking BRC-150 for tips already proven.

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

const TIP = `${'aa'.repeat(32)}.0`
const ORIGIN = `${'bb'.repeat(32)}_0`
const LIST_CACHE_KEY = 'handcash.collectables.list.v1'
const PROVEN_KEY = 'handcash.collectables.proven.v2'

const active = {
  identityKey: '02'.repeat(33),
  address: '1HandCashTestAddressAAAAAAAAAAAAAA',
  chain: 'main' as const,
  wallet: {
    listOutputs: vi.fn(async () => ({
      outputs: [
        {
          outpoint: TIP,
          satoshis: 1,
          tags: ['ordinal', `origin:${ORIGIN.replace('_0', '.0')}`, 'name:Pixel'],
        },
      ],
    })),
  },
}

vi.mock('./session', () => ({
  getActiveWallet: () => active,
}))

const resolveInscriptionPreferringOrigin = vi.fn(
  () =>
    new Promise<never>(() => {
      /* never resolves — detail must not await this */
    }),
)

vi.mock('./oneSatImport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./oneSatImport')>()
  return {
    ...actual,
    resolveInscriptionPreferringOrigin: (...args: unknown[]) =>
      resolveInscriptionPreferringOrigin(...args),
    walkInscription: vi.fn(async () => null),
  }
})

describe('getCollectable detail fast path', () => {
  beforeEach(() => {
    vi.resetModules()
    store.clear()
    resolveInscriptionPreferringOrigin.mockClear()
    active.wallet.listOutputs.mockResolvedValue({
      outputs: [
        {
          outpoint: TIP,
          satoshis: 1,
          tags: ['ordinal', `origin:${ORIGIN.replace('_0', '.0')}`, 'name:Pixel'],
        },
      ],
    })
    store.set(
      LIST_CACHE_KEY,
      JSON.stringify({
        at: Date.now(),
        identityKey: active.identityKey,
        items: [
          {
            outpoint: TIP,
            origin: ORIGIN,
            name: 'Pixel',
            imageUrl: '',
            satoshis: 1,
            traits: [{ name: 'Color', value: 'Blue' }],
            extras: [],
            proven: false,
            authenticity: 'unproven',
          },
        ],
      }),
    )
    store.set(
      PROVEN_KEY,
      JSON.stringify({
        [TIP]: {
          tier: 'brc150',
          origin: ORIGIN,
          path: [TIP, ORIGIN.replace('_', '.')],
          verifiedAt: Date.now(),
        },
      }),
    )
  })

  it('returns immediately with a verified badge from durable proven cache', async () => {
    const { getCollectable } = await import('./collectables')
    const started = Date.now()
    const item = await getCollectable(TIP, active as never)
    expect(Date.now() - started).toBeLessThan(500)
    expect(item?.authenticity).toBe('brc150')
    expect(item?.proven).toBe(true)
    expect(resolveInscriptionPreferringOrigin).not.toHaveBeenCalled()
  })
})
