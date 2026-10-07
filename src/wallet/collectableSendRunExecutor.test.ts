import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sendCollectables: vi.fn(),
  awaitChainedLegFunding: vi.fn(),
}))

vi.mock('./collectables', () => ({
  sendCollectables: mocks.sendCollectables,
}))

vi.mock('./signedSendLifecycle', () => ({
  awaitChainedLegFunding: mocks.awaitChainedLegFunding,
}))

vi.mock('./yieldToUi', () => ({ yieldToUi: async () => {} }))

describe('sendCollectablesRun', () => {
  beforeEach(() => {
    mocks.sendCollectables.mockReset()
    mocks.awaitChainedLegFunding.mockReset()
  })

  const selection = (count: number) =>
    Array.from({ length: count }, (_, index) => `${'c'.repeat(64)}.${index}`)

  it('sends any selection as one atomic transaction', async () => {
    mocks.sendCollectables.mockResolvedValueOnce({ txid: 'a'.repeat(64) })
    mocks.awaitChainedLegFunding.mockResolvedValue(true)

    const { sendCollectablesRun } = await import('./collectableSendRunExecutor')
    const result = await sendCollectablesRun({
      outpoints: selection(120),
      toAddress: '1recipient',
    })

    expect(mocks.sendCollectables).toHaveBeenCalledTimes(1)
    expect(mocks.sendCollectables.mock.calls[0]![0].outpoints).toEqual(selection(120))
    expect(result.sent).toEqual([{ txid: 'a'.repeat(64), outpoints: selection(120) }])
    expect(mocks.awaitChainedLegFunding).not.toHaveBeenCalled()
  })

  it('splits on an item conflict and waits for each half to fund the next', async () => {
    let fundFirst!: (funded: boolean) => void
    mocks.sendCollectables
      .mockRejectedValueOnce(new Error('input already spent'))
      .mockResolvedValueOnce({ txid: 'a'.repeat(64) })
      .mockResolvedValueOnce({ txid: 'b'.repeat(64) })
    mocks.awaitChainedLegFunding
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { fundFirst = resolve }))
      .mockResolvedValue(true)

    const { sendCollectablesRun } = await import('./collectableSendRunExecutor')
    const promise = sendCollectablesRun({
      outpoints: selection(10),
      toAddress: '1recipient',
    })

    await vi.waitFor(() => expect(mocks.awaitChainedLegFunding).toHaveBeenCalledWith('a'.repeat(64)))
    expect(mocks.sendCollectables).toHaveBeenCalledTimes(2)
    fundFirst(true)

    const result = await promise
    expect(mocks.sendCollectables).toHaveBeenCalledTimes(3)
    expect(result.sent.flatMap((leg) => leg.outpoints)).toEqual(selection(10))
  })

  it('leaves the rest untouched when the network never takes a leg', async () => {
    mocks.sendCollectables
      .mockRejectedValueOnce(new Error('input already spent'))
      .mockResolvedValueOnce({ txid: 'a'.repeat(64) })
    mocks.awaitChainedLegFunding.mockResolvedValue(false)

    const { sendCollectablesRun } = await import('./collectableSendRunExecutor')
    const result = await sendCollectablesRun({ outpoints: selection(10), toAddress: '1recipient' })

    expect(mocks.sendCollectables).toHaveBeenCalledTimes(2)
    expect(result.sent).toEqual([{ txid: 'a'.repeat(64), outpoints: selection(5) }])
    expect(result.failed).toEqual([{ outpoints: selection(10).slice(5), reason: expect.stringMatching(/network has not taken it yet/) }])
    expect(result.stopped).toBe('fault')
  })
})
