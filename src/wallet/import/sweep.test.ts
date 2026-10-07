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
vi.mock('./itemStore', () => ({ listedImportOutpoints: vi.fn(async () => new Set()) }))
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
