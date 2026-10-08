import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

const HELD = `${'aa'.repeat(32)}.0`
const IMPORTED = `${'cc'.repeat(32)}.1`

function row(outpoint: string, name: string) {
  const origin = `${outpoint.slice(0, 64)}.0`
  return { outpoint, satoshis: 1, tags: ['ordinal', `origin:${origin}`, `name:${name}`] }
}

type Listed = { outputs: ReturnType<typeof row>[] }
const answers: Array<() => Promise<Listed>> = []

const active = {
  identityKey: '02'.repeat(33),
  address: '1HandCashTestAddressAAAAAAAAAAAAAA',
  chain: 'main' as const,
  wallet: {
    listOutputs: vi.fn(async (args: { basket?: string; includeTags?: boolean }) => {
      if (args.basket !== '1sat' || !args.includeTags) return { outputs: [] }
      const next = answers.shift()
      return next ? next() : { outputs: [] }
    }),
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

describe('a Collect read that outlives its timeout', () => {
  beforeEach(() => {
    vi.resetModules()
    store.clear()
    answers.length = 0
    active.wallet.listOutputs.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('paints the late answer instead of dropping it', async () => {
    const { listCollectables, getCachedCollectables } = await import('./collectables')
    answers.push(async () => ({ outputs: [row(HELD, 'held')] }))
    await listCollectables(active)
    expect(getCachedCollectables().map((c) => c.outpoint)).toEqual([HELD])

    let land!: (listed: Listed) => void
    answers.push(() => new Promise<Listed>((resolve) => (land = resolve)))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const timedOut = listCollectables(active)
    await vi.advanceTimersByTimeAsync(20_000)
    expect((await timedOut).map((c) => c.outpoint)).toEqual([HELD])
    vi.useRealTimers()

    land({ outputs: [row(IMPORTED, 'imported'), row(HELD, 'held')] })
    await vi.waitFor(() =>
      expect(getCachedCollectables().map((c) => c.outpoint).sort()).toEqual([HELD, IMPORTED].sort()),
    )
    // The follow-up used the late answer; it did not walk the basket again.
    expect(answers).toHaveLength(0)
    const basketReads = active.wallet.listOutputs.mock.calls.filter(([args]) => args.basket === '1sat' && args.includeTags)
    expect(basketReads).toHaveLength(2)
  })

  it('reads again when asked while a relist is already reading', async () => {
    const { listCollectables, getCachedCollectables, requestCollectablesRelist } = await import('./collectables')
    answers.push(async () => ({ outputs: [row(HELD, 'held')] }))
    await listCollectables(active)

    let land!: (listed: Listed) => void
    answers.push(() => new Promise<Listed>((resolve) => (land = resolve)))
    answers.push(async () => ({ outputs: [row(IMPORTED, 'imported'), row(HELD, 'held')] }))
    requestCollectablesRelist()
    await vi.waitFor(() => expect(land).toBeTypeOf('function'))
    // An import leg commits while that relist is still reading the old basket.
    requestCollectablesRelist()
    land({ outputs: [row(HELD, 'held')] })
    await vi.waitFor(() =>
      expect(getCachedCollectables().map((c) => c.outpoint).sort()).toEqual([HELD, IMPORTED].sort()),
    )
  })
})
