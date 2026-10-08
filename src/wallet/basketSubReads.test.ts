import { describe, expect, it, vi } from 'vitest'

const spend = vi.hoisted(() => ({ waiting: 0 }))
vi.mock('./walletCoordinator', () => ({
  spendNeedsStorage: () => spend.waiting > 0,
  shouldYieldChainIngestToSpend: () => false,
}))

import { listOutputsInSlices } from './basketSubReads'

/** Newest-first basket of `n` rows, honouring the toolbox's negative offsets. */
function basket(n: number) {
  const rows = Array.from({ length: n }, (_, i) => ({ outpoint: `row${n - 1 - i}` }))
  const calls: Array<{ limit: number; offset: number }> = []
  const listOutputs = vi.fn(async (args: { limit: number; offset: number }) => {
    calls.push({ limit: args.limit, offset: args.offset })
    const skip = args.offset < 0 ? -args.offset - 1 : args.offset
    const outputs = rows.slice(skip, skip + args.limit)
    return { outputs, totalOutputs: outputs.length === args.limit ? n : outputs.length }
  })
  return { listOutputs, calls, rows }
}

describe('listOutputsInSlices', () => {
  it('reads one page as newest-first slices in order', async () => {
    const { listOutputs, calls, rows } = basket(250)
    const read = await listOutputsInSlices(listOutputs, { limit: 1000, offset: -1 }, { subRows: 100 })
    expect(read.outputs).toEqual(rows)
    expect(calls).toEqual([
      { limit: 100, offset: -1 },
      { limit: 100, offset: -101 },
      { limit: 100, offset: -201 },
    ])
    expect(read.slices).toBe(3)
  })

  it('stops at the page limit and reports the last full slice total', async () => {
    const { listOutputs, calls } = basket(1500)
    const read = await listOutputsInSlices(listOutputs, { limit: 300, offset: -1001 }, { subRows: 100 })
    expect(read.outputs).toHaveLength(300)
    expect(read.outputs[0]).toEqual({ outpoint: 'row499' })
    expect(calls.map((c) => c.offset)).toEqual([-1001, -1101, -1201])
    expect(read.totalOutputs).toBe(1500)
  })

  it('lets a waiting send take the lock between slices', async () => {
    vi.useFakeTimers()
    const { listOutputs, calls } = basket(200)
    listOutputs.mockImplementationOnce(async (args) => {
      calls.push({ limit: args.limit, offset: args.offset })
      spend.waiting = 1
      setTimeout(() => {
        spend.waiting = 0
      }, 600)
      return { outputs: Array.from({ length: 100 }, (_, i) => ({ outpoint: `n${i}` })), totalOutputs: 200 }
    })
    const pending = listOutputsInSlices(listOutputs, { limit: 1000, offset: -1 }, { subRows: 100 })
    await vi.advanceTimersByTimeAsync(300)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    const read = await pending
    expect(calls.length).toBeGreaterThan(1)
    expect(read.yieldedMs).toBeGreaterThanOrEqual(600)
    vi.useRealTimers()
  })
})
