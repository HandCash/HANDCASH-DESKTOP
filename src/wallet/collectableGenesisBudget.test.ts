import { beforeEach, describe, expect, it, vi } from 'vitest'

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

const walks = vi.hoisted(() => ({ tips: [] as string[], prove: false }))
vi.mock('./oneSatGenesisProof', async (importOriginal) => {
  const { Beef } = await import('@bsv/sdk')
  return {
    ...(await importOriginal<typeof import('./oneSatGenesisProof')>()),
    proveGenesisLineage: () => new Promise<never>(() => {}),
    walkGenesisLineage: async (args: { tipOutpoint: string; getBeef: (txid: string) => Promise<unknown> }) => {
      walks.tips.push(args.tipOutpoint)
      await args.getBeef(args.tipOutpoint.slice(0, 64))
      if (!walks.prove) return { kind: 'invalid' as const, reason: 'test lineage', hops: 1 }
      const origin = args.tipOutpoint.replace('.', '_')
      return { kind: 'proven' as const, proof: { origin, path: [origin], hops: 0, beef: new Beef() } }
    },
  }
})

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

const TIPS = Array.from({ length: 12 }, (_, i) => `${String(i + 1).padStart(2, '0').repeat(32)}.0`)

const active = {
  identityKey: '02'.repeat(33),
  address: '1HandCashTestAddressAAAAAAAAAAAAAA',
  chain: 'main' as const,
  wallet: {
    listOutputs: vi.fn(async (args: { basket?: string; includeTags?: boolean }) => {
      if (args.basket !== '1sat' || !args.includeTags) return { outputs: [] }
      return {
        outputs: TIPS.map((outpoint) => ({
          outpoint,
          satoshis: 1,
          tags: ['ordinal', `origin:${outpoint}`, `name:item ${outpoint.slice(0, 4)}`],
        })),
      }
    }),
  },
}

vi.mock('./session', () => ({
  getActiveWallet: () => active,
}))

beforeEach(() => {
  vi.resetModules()
  durable.clear()
  walks.tips.length = 0
  walks.prove = false
  beef.getLocalBeefForTxid.mockReset()
  beef.getBeefForTxidCached.mockReset()
  beef.getLocalBeefForTxid.mockImplementation(async () => (beef.local ? { local: true } : null))
  beef.getBeefForTxidCached.mockImplementation(async () => ({ fetched: true }))
})

async function settledWalks(): Promise<number> {
  let seen = -1
  await vi.waitFor(
    async () => {
      const now = walks.tips.length
      const stable = now === seen
      seen = now
      if (!stable || now === 0) throw new Error('still walking')
    },
    { timeout: 4_000, interval: 150 },
  )
  return seen
}

describe('the background lineage walk budget', () => {
  it('walks every imported tip whose lineage is already on this device', async () => {
    beef.local = true
    const { listCollectables } = await import('./collectables')
    await listCollectables(active)

    expect(await settledWalks()).toBe(TIPS.length)
    expect(beef.getBeefForTxidCached).not.toHaveBeenCalled()
  })

  it('repaints the grid once per burst of proofs, not once per proof', async () => {
    beef.local = true
    walks.prove = true
    const { listCollectables, subscribeCollectables, getCachedCollectables } = await import('./collectables')
    await listCollectables(active)
    let paints = 0
    const stop = subscribeCollectables(() => {
      paints++
    })

    expect(await settledWalks()).toBe(TIPS.length)
    await vi.waitFor(() => expect(getCachedCollectables().every((c) => c.proven)).toBe(true), { timeout: 4_000 })
    stop()
    // Twelve proofs painted fourteen times when each repainted on its own.
    expect(paints).toBeLessThanOrEqual(4)
  })

  it('still rate-limits walks that fetch from the network', async () => {
    beef.local = false
    const { listCollectables } = await import('./collectables')
    await listCollectables(active)

    expect(await settledWalks()).toBe(8)
    expect(beef.getBeefForTxidCached).toHaveBeenCalledTimes(8)
  })
})
