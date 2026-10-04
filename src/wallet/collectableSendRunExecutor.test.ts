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

  const selection = (count: number) =>
    Array.from({ length: count }, (_, index) => `${'c'.repeat(64)}.${index}`)

  it('sends any selection as one atomic transaction', async () => {
    mocks.sendCollectables.mockResolvedValueOnce({ txid: 'a'.repeat(64) })
    mocks.pinBroadcastLocalTx.mockResolvedValue(true)

    const { sendCollectablesRun } = await import('./collectableSendRunExecutor')
    const result = await sendCollectablesRun({
      outpoints: selection(120),
      toAddress: '1recipient',
    })

    expect(mocks.sendCollectables).toHaveBeenCalledTimes(1)
    expect(mocks.sendCollectables.mock.calls[0]![0].outpoints).toEqual(selection(120))
    expect(result.sent).toEqual([{ txid: 'a'.repeat(64), outpoints: selection(120) }])
  })

  it('splits on an item conflict and pins each half before spending the next', async () => {
    vi.useFakeTimers()
    try {
      mocks.sendCollectables
        .mockRejectedValueOnce(new Error('input already spent'))
        .mockResolvedValueOnce({ txid: 'a'.repeat(64) })
        .mockResolvedValueOnce({ txid: 'b'.repeat(64) })
      mocks.pinBroadcastLocalTx
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true)

      const { sendCollectablesRun } = await import('./collectableSendRunExecutor')
      const promise = sendCollectablesRun({
        outpoints: selection(10),
        toAddress: '1recipient',
      })

      await vi.advanceTimersByTimeAsync(249)
      expect(mocks.sendCollectables).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(501)

      const result = await promise
      expect(mocks.sendCollectables).toHaveBeenCalledTimes(3)
      expect(result.sent.flatMap((leg) => leg.outpoints)).toEqual(selection(10))
    } finally {
      vi.useRealTimers()
    }
  })
})
