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
const theirs = PrivateKey.fromRandom().toAddress()
const OUR_LOCK = new P2PKH().lock(ours).toHex()
const THEIR_LOCK = new P2PKH().lock(theirs).toHex()

const HELD = `${'aa'.repeat(32)}.0`
const IMPORTED = `${'cc'.repeat(32)}.1`

function row(outpoint: string, name: string, lockingScript?: string) {
  const origin = `${outpoint.slice(0, 64)}.0`
  return { outpoint, satoshis: 1, tags: ['ordinal', `origin:${origin}`, `name:${name}`], lockingScript }
}

type Listed = { outputs: ReturnType<typeof row>[] }
const answers: Array<() => Promise<Listed>> = []

type FoundRow = { basketId: number; spendable: boolean; customInstructions: string | null }
const storageRows = new Map<string, FoundRow[]>()
const findOutputs = vi.fn(async ({ partial }: { partial: { txid: string; vout: number } }) =>
  storageRows.get(`${partial.txid}.${partial.vout}`) ?? [],
)
const storage = {
  runAsStorageProvider: async <T>(fn: (sp: unknown) => Promise<T>): Promise<T> =>
    fn({
      findUserByIdentityKey: async () => ({ userId: 7 }),
      findOutputBaskets: async () => [{ basketId: 3 }],
      findOutputs,
    }),
}

const active = {
  identityKey: '02'.repeat(33),
  address: ours,
  chain: 'main' as const,
  wallet: {
    storage: undefined as typeof storage | undefined,
    listOutputs: vi.fn(async (args: { basket?: string; includeTags?: boolean; tags?: string[] }) => {
      if (args.basket !== '1sat') return { outputs: [] }
      if (args.tags) return { outputs: [] }
      if (!args.includeTags) return { outputs: [] }
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
  answers.length = 0
  storageRows.clear()
  findOutputs.mockClear()
  active.wallet.storage = undefined
  active.wallet.listOutputs.mockClear()
})

describe('a Collect read under contention', () => {
  it('paints a slice’s new cards before the whole page answers', async () => {
    const { listCollectables, getCachedCollectables } = await import('./collectables')
    answers.push(async () => ({ outputs: [row(HELD, 'held', OUR_LOCK)] }))
    await listCollectables(active)
    expect(getCachedCollectables().map((c) => c.outpoint)).toEqual([HELD])

    const foreign = Array.from({ length: 98 }, (_, i) =>
      row(`${String(i).padStart(64, 'e')}.0`, `foreign-${i}`, THEIR_LOCK),
    )
    answers.push(async () => ({
      outputs: [row(IMPORTED, 'imported', OUR_LOCK), row(HELD, 'held', OUR_LOCK), ...foreign],
    }))
    let finish!: (listed: Listed) => void
    answers.push(() => new Promise<Listed>((resolve) => (finish = resolve)))
    const reading = listCollectables(active)

    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await vi.waitFor(() =>
      expect(getCachedCollectables().map((c) => c.outpoint).sort()).toEqual([HELD, IMPORTED].sort()),
    )

    finish({ outputs: [] })
    await reading
  })
})

describe('verifying one held item', () => {
  it('reads its row by outpoint, not by a tag query over the basket', async () => {
    const { verifyItemAuthenticity } = await import('./collectables')
    active.wallet.storage = storage
    storageRows.set(IMPORTED, [{ basketId: 9, spendable: true, customInstructions: null }])

    const result = await verifyItemAuthenticity(IMPORTED, `${IMPORTED.slice(0, 64)}_0`, active)

    expect(result.reason).toBe('Collectable output not found')
    expect(findOutputs).toHaveBeenCalledWith({
      partial: { userId: 7, txid: IMPORTED.slice(0, 64), vout: 1 },
      noScript: true,
    })
    const tagQueries = active.wallet.listOutputs.mock.calls.filter(([args]) => args.tags)
    expect(tagQueries).toHaveLength(0)
  })

  it('falls back to the tag query when storage cannot read by outpoint', async () => {
    const { verifyItemAuthenticity } = await import('./collectables')

    const result = await verifyItemAuthenticity(IMPORTED, `${IMPORTED.slice(0, 64)}_0`, active)

    expect(result.reason).toBe('Collectable output not found')
    const tagQueries = active.wallet.listOutputs.mock.calls.filter(([args]) => args.tags)
    expect(tagQueries).toHaveLength(1)
  })
})
