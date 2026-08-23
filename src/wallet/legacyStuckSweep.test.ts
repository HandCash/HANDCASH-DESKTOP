import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (k: string) => store.get(k) ?? null,
  durableSetItem: (k: string, v: string) => {
    store.set(k, v)
  },
}))

const txExistsOnChain = vi.fn()
vi.mock('./legacyScan', () => ({
  txExistsOnChain: (...args: unknown[]) => txExistsOnChain(...args),
}))

const OP = 'a'.repeat(64) + '.0'
const TX = 'b'.repeat(64)

describe('retryableStuckSweeps', () => {
  beforeEach(() => {
    store.clear()
    txExistsOnChain.mockReset()
    vi.resetModules()
  })

  it('retries marks with no recorded sweep txid when still on the address scan', async () => {
    store.set(
      'handcash.brc100.importedLegacyOutpoints.v2',
      JSON.stringify({
        [OP]: { at: 0 },
      }),
    )

    const { retryableStuckSweeps } = await import('./legacyStuckSweep')
    const retryable = await retryableStuckSweeps([{ outpoint: OP }], 'main')

    expect(retryable).toEqual([OP])
    expect(txExistsOnChain).not.toHaveBeenCalled()
  })

  it('retries only when a recorded sweep tx is provably missing from chain', async () => {
    store.set(
      'handcash.brc100.importedLegacyOutpoints.v2',
      JSON.stringify({
        [OP]: { at: Date.now() - 20 * 60_000, txid: TX },
      }),
    )
    txExistsOnChain.mockResolvedValue(false)

    const { retryableStuckSweeps } = await import('./legacyStuckSweep')
    const retryable = await retryableStuckSweeps([{ outpoint: OP }], 'main')

    expect(retryable).toEqual([OP])
    expect(txExistsOnChain).toHaveBeenCalledWith(TX, 'main')
  })

  it('does not retry when the recorded sweep tx is still on chain', async () => {
    store.set(
      'handcash.brc100.importedLegacyOutpoints.v2',
      JSON.stringify({
        [OP]: { at: Date.now() - 20 * 60_000, txid: TX },
      }),
    )
    txExistsOnChain.mockResolvedValue(true)

    const { retryableStuckSweeps } = await import('./legacyStuckSweep')
    const retryable = await retryableStuckSweeps([{ outpoint: OP }], 'main')

    expect(retryable).toEqual([])
  })
})
