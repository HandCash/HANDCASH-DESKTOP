import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportItemsResult } from './items'
import type { SweepProgress } from './sweep'

const op = (n: number) => `${n.toString(16).padStart(64, '0')}_0`
const LISTED = Array.from({ length: 150 }, (_, i) => op(i + 1))

const { importItems } = vi.hoisted(() => ({ importItems: vi.fn() }))

vi.mock('../walletRuntime', () => ({
  getWalletRuntime: () => ({ instance: { identityKey: '02'.padEnd(66, 'a'), chain: 'main' } }),
}))
vi.mock('../appLog', () => ({ appendAppLog: vi.fn() }))
vi.mock('../walletJobs', () => ({
  beginWalletJob: () => ({ id: 'job:1', progress: vi.fn(), finish: vi.fn(), stop: vi.fn(), fail: vi.fn() }),
}))
vi.mock('../phraseSweep', () => ({
  clearPhraseItemMigrateCursor: vi.fn(),
  peekPhraseItemMigrateCursor: vi.fn(() => null),
  refreshAfterPhraseItemMigrate: vi.fn(async () => undefined),
  scanAddressAny: vi.fn(),
  sweepPhraseFunding: vi.fn(),
}))
vi.mock('./importSource', () => ({ keyDeriverFor: () => ({ privateKeyAt: vi.fn() }) }))
vi.mock('./itemStore', () => ({ listedImportOutpoints: vi.fn(async () => new Set(LISTED)) }))
vi.mock('./items', () => ({
  clearImportItems: vi.fn(async () => undefined),
  importItems,
  syncImportItems: vi.fn(async () => ({ complete: true })),
}))
vi.mock('./tokenSweep', () => ({ sweepTokensFromAddress: vi.fn() }))
vi.mock('./store', () => ({
  loadImportedSources: vi.fn(async () => [
    {
      id: 'src1',
      kind: 'handcash',
      secret: {},
      scan: {
        holdings: [
          {
            address: '1Item',
            path: 'm/0/1',
            label: 'Item address',
            wallets: '',
            uncompressed: false,
            cashSats: 0,
            cashCount: 0,
            dustCount: 0,
            itemCount: 150,
            tokens: [],
          },
        ],
      },
    },
  ]),
  updateImportedSource: vi.fn(async () => undefined),
}))

const moved = (outpoints: string[]): ImportItemsResult => ({
  results: outpoints.map((outpoint) => ({ outpoint, result: { kind: 'moved', txid: 'f'.repeat(64) } })),
  stopped: null,
})

describe('sweepImportedSource progress', () => {
  beforeEach(() => {
    importItems.mockReset()
  })

  it('counts items as each transaction lands, and reports the batch in flight', async () => {
    importItems.mockImplementation(
      async ({ outpoints, onLanded }: { outpoints: string[]; onLanded: (o: string[]) => void }) => {
        onLanded([...outpoints.slice(0, 25), op(9_999)])
        return moved(outpoints)
      },
    )
    const { sweepImportedSource } = await import('./sweep')
    const progress: SweepProgress[] = []

    const summary = await sweepImportedSource({ sourceId: 'src1', onProgress: (p) => progress.push(p) })

    expect(summary.items).toBe(150)
    const moving = progress.filter((p) => p.message.startsWith('Moving collectables'))
    expect(moving.map(({ done, total, batch }) => ({ done, total, batch }))).toEqual([
      { done: 0, total: 150, batch: { done: 0, total: 100 } },
      { done: 25, total: 150, batch: { done: 25, total: 100 } },
      { done: 100, total: 150, batch: { done: 0, total: 50 } },
      { done: 125, total: 150, batch: { done: 25, total: 50 } },
    ])
    expect(moving[1]!.message).toBe('Moving collectables… 25 of 150 · batch 25 of 100')
  })
})
