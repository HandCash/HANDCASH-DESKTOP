import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sendCollectables: vi.fn(),
  pinBroadcastLocalTx: vi.fn(),
}))

vi.mock('./collectables', () => ({
  sendCollectables: mocks.sendCollectables,
}))

vi.mock('./staleOutputRelease', () => ({
  pinBroadcastLocalTx: mocks.pinBroadcastLocalTx,
}))

vi.mock('./yieldToUi', () => ({ yieldToUi: async () => {} }))

describe('sendCollectablesRun', () => {
  beforeEach(() => {
    mocks.sendCollectables.mockReset()
    mocks.pinBroadcastLocalTx.mockReset()
  })

  it('waits for each leg change to be pinned before spending the next leg', async () => {
    vi.useFakeTimers()
    try {
      mocks.sendCollectables
        .mockResolvedValueOnce({ txid: 'a'.repeat(64) })
        .mockResolvedValueOnce({ txid: 'b'.repeat(64) })
      mocks.pinBroadcastLocalTx
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true)

      const { sendCollectablesRun } = await import('./collectableSendRunExecutor')
      const promise = sendCollectablesRun({
        outpoints: Array.from({ length: 10 }, (_, index) => `${'c'.repeat(64)}.${index}`),
        toAddress: '1recipient',
      })

      await vi.advanceTimersByTimeAsync(249)
      expect(mocks.sendCollectables).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(501)

      const result = await promise
      expect(mocks.sendCollectables).toHaveBeenCalledTimes(2)
      expect(result.sent.flatMap((leg) => leg.outpoints)).toHaveLength(10)
    } finally {
      vi.useRealTimers()
    }
  })
})
