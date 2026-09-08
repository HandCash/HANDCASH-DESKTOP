import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
  },
}))

const recordTransactionStage = vi.fn()
vi.mock('./transactionTelemetry', () => ({
  activeTransactionTrace: () => ({
    traceId: 'trace-test',
    requestId: 'request-test',
    flow: 'brc29',
  }),
  recordTransactionStage: (...args: unknown[]) => recordTransactionStage(...args),
}))

beforeEach(() => {
  store.clear()
  recordTransactionStage.mockClear()
})

describe('pending miner outbox', () => {
  it('persists Atomic BEEF before provider submission and deduplicates by txid', async () => {
    const { enqueuePendingMinerSubmit, pendingMinerOutboxDepth } = await import(
      './pendingMinerOutbox'
    )
    const txid = 'ab'.repeat(32)
    expect(enqueuePendingMinerSubmit(txid, [1, 2, 3])).toBe(true)
    expect(enqueuePendingMinerSubmit(txid, [4, 5, 6])).toBe(true)
    expect(pendingMinerOutboxDepth()).toBe(1)

    const rows = JSON.parse(
      store.get('handcash.wallet.pendingMinerOutbox.v1') || '[]',
    ) as Array<{ atomic: number[]; traceId?: string }>
    expect(rows[0]?.atomic).toEqual([1, 2, 3])
    expect(rows[0]?.traceId).toBe('trace-test')
    expect(recordTransactionStage).toHaveBeenCalledWith(
      'propagation_queued',
      expect.objectContaining({ txid }),
    )
  })

  it('rejects invalid transaction bodies without persistence', async () => {
    const { enqueuePendingMinerSubmit, pendingMinerOutboxDepth } = await import(
      './pendingMinerOutbox'
    )
    expect(enqueuePendingMinerSubmit('bad', [1])).toBe(false)
    expect(enqueuePendingMinerSubmit('ab'.repeat(32), [256])).toBe(false)
    expect(pendingMinerOutboxDepth()).toBe(0)
  })
})
