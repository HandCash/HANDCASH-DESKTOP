import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../appLog', () => ({ appendAppLog: vi.fn(), setStallContextProvider: vi.fn() }))
let betweenSlices: (() => Promise<void>) | null = null
vi.mock('../yieldToUi', () => ({
  yieldToUi: async () => { await betweenSlices?.() },
  uiBudgetExpired: () => false,
}))
import { readIndexedOutpoints } from './handcashUtxoSet'
import { __resetImportItemStoreForTests, countImportItems, saveImportItems, type StoredImportItem } from './itemStore'

const SIZE = 10_000
const outputs = Array.from({ length: SIZE }, (_, i) => `${i.toString(16).padStart(64, '0')}_0`)
beforeEach(async () => {
  betweenSlices = null
  await __resetImportItemStoreForTests()
})

describe('synthetic migration benchmark (no wallet or network)', () => {
  it('bounds four network lanes and ordered 100-row callbacks on 10,000 outputs', async () => {
    vi.useFakeTimers()
    try {
      let live = 0
      let peak = 0
      let saved = 0
      let largest = 0
      const start = Date.now()
      const running = readIndexedOutpoints({
        chain: 'main', outpoints: outputs,
        fetchImpl: async () => {
          peak = Math.max(peak, ++live)
          await new Promise((resolve) => setTimeout(resolve, 100))
          live--
          return new Response('[]')
        },
        onChunk: (answers) => {
          largest = Math.max(largest, answers.size)
          expect([...answers.keys()]).toEqual(outputs.slice(saved, saved + answers.size))
          saved += answers.size
        },
      })
      await vi.runAllTimersAsync()
      expect(await running).toMatchObject({ silent: SIZE, failed: 0, stopped: false })
      expect({ peak, largest, saved, elapsed: Date.now() - start }).toEqual({ peak: 4, largest: 100, saved: SIZE, elapsed: 2500 })
      // Serial baseline: 100 requests × 100ms = 10,000ms, no server CPU or jitter.
      console.info('migration network benchmark', { outputs: SIZE, latencyMs: 100, serialModelMs: 10_000, fourLaneMs: Date.now() - start, peak, largest })
    } finally { vi.useRealTimers() }
  })

  it('commits 100-row slices and admits a competing writer between every slice', async () => {
    const rows: StoredImportItem[] = outputs.map((outpoint) => ({
      outpoint, address: 'synthetic', origin: outpoint, media: outpoint,
      name: null, mimeType: null, app: null, collectionId: null, signer: null,
    }))
    let probes = 0
    let maxWaitMs = 0
    const before = process.memoryUsage().heapUsed
    const start = performance.now()
    betweenSlices = async () => {
      const entered = performance.now()
      // Same IndexedDB stores: would wait behind any still-open write tx.
      await saveImportItems('competing-writer', [rows[probes]!])
      maxWaitMs = Math.max(maxWaitMs, performance.now() - entered)
      probes++
    }
    expect(await saveImportItems('large-fixture', rows)).toHaveLength(SIZE)
    expect(probes).toBe(100)
    expect(await countImportItems('large-fixture')).toBe(SIZE)
    expect(await countImportItems('competing-writer')).toBe(100)
    console.info('migration storage benchmark', {
      outputs: SIZE, slice: 100, competingWrites: probes, maxWaitMs,
      elapsedMs: performance.now() - start, heapDeltaBytes: process.memoryUsage().heapUsed - before,
      toolboxLock: 'not acquired by import item store',
    })
  }, 30_000)
})
