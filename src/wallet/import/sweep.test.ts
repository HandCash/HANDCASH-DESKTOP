import { describe, expect, it, vi } from 'vitest'

let releaseLoad!: () => void
const loadImportedSources = vi.fn(
  () =>
    new Promise<unknown[]>((resolve) => {
      releaseLoad = () => resolve([{ id: 'src', kind: 'phrase', secret: {}, scan: { at: 1, holdings: [] } }])
    }),
)
const job = { finish: vi.fn(), stop: vi.fn(), fail: vi.fn(), progress: vi.fn(), id: 'job' }

vi.mock('../walletRuntime', () => ({ getWalletRuntime: () => ({ instance: { identityKey: '02aa', chain: 'main' } }) }))
vi.mock('../appLog', () => ({ appendAppLog: vi.fn() }))
vi.mock('../walletJobs', () => ({ beginWalletJob: vi.fn(() => job) }))
vi.mock('../phraseSweep', () => ({
  clearPhraseItemMigrateCursor: vi.fn(),
  peekPhraseItemMigrateCursor: vi.fn(() => null),
  refreshAfterPhraseItemMigrate: vi.fn(),
  scanAddressAny: vi.fn(),
  sweepPhraseFunding: vi.fn(),
}))
vi.mock('./holdings', () => ({
  addHeld: vi.fn((held: unknown) => held),
  totalHoldings: vi.fn(() => ({ held: {} })),
}))
vi.mock('./importSource', () => ({ keyDeriverFor: vi.fn(() => ({})) }))
vi.mock('./itemStore', () => ({
  listedImportOutpoints: vi.fn(async () => new Set()),
  readImportListMeta: vi.fn(async () => ({ scanAt: 0, complete: false, pagedAddresses: [], nextSeq: 0 })),
}))
vi.mock('./items', () => ({
  clearImportItems: vi.fn(async () => undefined),
  importItems: vi.fn(),
  prefetchImportItems: vi.fn(),
  syncImportItems: vi.fn(),
}))
vi.mock('./tokenSweep', () => ({ sweepTokensFromAddress: vi.fn() }))
vi.mock('./store', () => ({
  loadImportedSources: () => loadImportedSources(),
  updateImportedSource: vi.fn(async () => undefined),
}))

describe('sweepImportedSource', () => {
  it('joins the sweep already running for a source instead of starting a second', async () => {
    const { sweepImportedSource } = await import('./sweep')
    const first = sweepImportedSource({ sourceId: 'src' })
    const second = sweepImportedSource({ sourceId: 'src' })
    releaseLoad()
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(loadImportedSources).toHaveBeenCalledTimes(1)
    expect(job.finish).toHaveBeenCalledTimes(1)
  })

  it('starts fresh once the previous sweep finished', async () => {
    const { sweepImportedSource } = await import('./sweep')
    loadImportedSources.mockClear()
    const next = sweepImportedSource({ sourceId: 'src' })
    await Promise.resolve()
    releaseLoad()
    await next
    expect(loadImportedSources).toHaveBeenCalledTimes(1)
  })
})

describe('sweep item list', () => {
  const itemSource = {
    id: 'items-src',
    kind: 'handcash',
    secret: {},
    scan: { at: 5, holdings: [{ address: 'a1', path: 'm/0', itemCount: 1, cashCount: 0, tokens: [] }] },
  }

  async function setup(opts: { syncedAgoMs: number | null; stopped?: 'busy' | null }) {
    const store = await import('./itemStore')
    const items = await import('./items')
    loadImportedSources.mockImplementation(async () => [itemSource])
    vi.mocked(store.readImportListMeta).mockResolvedValue({
      sourceId: itemSource.id,
      scanAt: 5,
      complete: true,
      pagedAddresses: [],
      nextSeq: 1,
      ...(opts.syncedAgoMs == null ? {} : { syncedAt: Date.now() - opts.syncedAgoMs }),
    })
    vi.mocked(store.listedImportOutpoints).mockResolvedValue(new Set(['o1']))
    vi.mocked(items.syncImportItems).mockReset().mockResolvedValue({ complete: true, total: 1 })
    vi.mocked(items.clearImportItems).mockClear()
    vi.mocked(items.importItems).mockResolvedValue({
      results: [{ outpoint: 'o1', result: opts.stopped ? { kind: 'deferred' } : { kind: 'moved' } }],
      stopped: opts.stopped ?? null,
    } as unknown as Awaited<ReturnType<typeof items.importItems>>)
    return items
  }

  it('moves from a list this scan synced minutes ago instead of listing again', async () => {
    const items = await setup({ syncedAgoMs: 60_000 })
    const { sweepImportedSource } = await import('./sweep')
    const summary = await sweepImportedSource({ sourceId: itemSource.id })
    expect(items.syncImportItems).not.toHaveBeenCalled()
    expect(summary.items).toBe(1)
    expect(items.clearImportItems).toHaveBeenCalledOnce()
  })

  it('lists again once the saved list is stale', async () => {
    const items = await setup({ syncedAgoMs: 2 * 60 * 60_000 })
    const { sweepImportedSource } = await import('./sweep')
    await sweepImportedSource({ sourceId: itemSource.id })
    expect(items.syncImportItems).toHaveBeenCalledOnce()
  })

  it('keeps the list when the sweep pauses so the resume does not list again', async () => {
    const items = await setup({ syncedAgoMs: 60_000, stopped: 'busy' })
    const { sweepImportedSource } = await import('./sweep')
    await sweepImportedSource({ sourceId: itemSource.id })
    expect(items.clearImportItems).not.toHaveBeenCalled()
  })
})
