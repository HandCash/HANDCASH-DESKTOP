import { beforeEach, describe, expect, it, vi } from 'vitest'

const reclaimSealedInputsNeverSpent = vi.fn(async () => 0)
const promotePendingLocalChangeOutputs = vi.fn(async () => 0)
const restoreLiveSpendableOutputs = vi.fn(async () => 0)
const rehideInputsOfLiveLocalTxs = vi.fn(async () => undefined)
const sweepChangeScripts = vi.fn(async () => ({
  scanned: 0,
  healed: 0,
  quarantined: 0,
  refused: 0,
}))
const bumpBalanceAfterHeal = vi.fn()

vi.mock('./changeScriptFate', () => ({
  sweepChangeScripts: (opts?: { fromChain?: boolean }) => sweepChangeScripts(opts),
}))

vi.mock('./session', () => ({
  bumpBalanceAfterHeal: () => bumpBalanceAfterHeal(),
}))

vi.mock('./staleOutputRelease', () => ({
  reclaimSealedInputsNeverSpent: (opts?: { forSpendChain?: boolean }) =>
    reclaimSealedInputsNeverSpent(opts),
  promotePendingLocalChangeOutputs: (opts?: { forSpendChain?: boolean }) =>
    promotePendingLocalChangeOutputs(opts),
  restoreLiveSpendableOutputs: (opts?: unknown) => restoreLiveSpendableOutputs(opts),
  rehideInputsOfLiveLocalTxs: () => rehideInputsOfLiveLocalTxs(),
}))

vi.mock('./diagnosticLog', () => ({
  logDiag: vi.fn(),
}))

describe('runChangeHeal', () => {
  beforeEach(() => {
    reclaimSealedInputsNeverSpent.mockClear()
    promotePendingLocalChangeOutputs.mockClear()
    restoreLiveSpendableOutputs.mockClear()
    rehideInputsOfLiveLocalTxs.mockClear()
    sweepChangeScripts.mockClear()
    bumpBalanceAfterHeal.mockClear()
    sweepChangeScripts.mockResolvedValue({
      scanned: 0,
      healed: 0,
      quarantined: 0,
      refused: 0,
    })
  })

  it('spendGate reclaims, promotes, and restores locally without script sweep', async () => {
    promotePendingLocalChangeOutputs.mockResolvedValueOnce(3)
    restoreLiveSpendableOutputs.mockResolvedValueOnce(2)

    const { runChangeHeal } = await import('./chainedChangeHeal')
    const stats = await runChangeHeal({ path: 'spendGate' })

    expect(stats).toEqual({
      restored: 2,
      scriptsLocal: 0,
      scriptsChain: 0,
      pendingPromoted: 3,
      reclaimed: 0,
    })
    expect(reclaimSealedInputsNeverSpent).toHaveBeenCalledWith({ forSpendChain: true })
    expect(promotePendingLocalChangeOutputs).toHaveBeenCalledWith({ forSpendChain: true })
    expect(restoreLiveSpendableOutputs).toHaveBeenCalledWith({ forSpendChain: true })
    expect(sweepChangeScripts).not.toHaveBeenCalled()
    expect(bumpBalanceAfterHeal).toHaveBeenCalledOnce()
  })

  it('chainMaintenance runs chain script sweep then promote and restore', async () => {
    sweepChangeScripts.mockResolvedValueOnce({
      scanned: 4,
      healed: 2,
      quarantined: 0,
      refused: 0,
    })
    promotePendingLocalChangeOutputs.mockResolvedValueOnce(1)
    restoreLiveSpendableOutputs.mockResolvedValueOnce(5)

    const { runChangeHeal } = await import('./chainedChangeHeal')
    const stats = await runChangeHeal({ path: 'chainMaintenance' })

    expect(stats.scriptsChain).toBe(2)
    expect(stats.pendingPromoted).toBe(1)
    expect(stats.restored).toBe(5)
    expect(sweepChangeScripts).toHaveBeenCalledWith({ fromChain: true })
    expect(rehideInputsOfLiveLocalTxs).toHaveBeenCalledOnce()
  })

  it('chainingScriptHeal tries local sweep before chain fetch', async () => {
    sweepChangeScripts
      .mockResolvedValueOnce({
        scanned: 1,
        healed: 1,
        quarantined: 0,
        refused: 0,
      })
    promotePendingLocalChangeOutputs.mockResolvedValueOnce(1)
    restoreLiveSpendableOutputs.mockResolvedValueOnce(1)

    const { runChangeHeal } = await import('./chainedChangeHeal')
    const stats = await runChangeHeal({ path: 'chainingScriptHeal' })

    expect(stats.scriptsLocal).toBe(1)
    expect(stats.scriptsChain).toBe(0)
    expect(sweepChangeScripts).toHaveBeenCalledWith({ fromChain: false })
    expect(sweepChangeScripts).not.toHaveBeenCalledWith({ fromChain: true })
  })

  it('displayBackground promotes pending change without restore sweep', async () => {
    promotePendingLocalChangeOutputs.mockResolvedValueOnce(2)

    const { runChangeHeal } = await import('./chainedChangeHeal')
    const stats = await runChangeHeal({ path: 'displayBackground' })

    expect(stats.pendingPromoted).toBe(2)
    expect(restoreLiveSpendableOutputs).not.toHaveBeenCalled()
    expect(sweepChangeScripts).not.toHaveBeenCalled()
  })
})

describe('runExclusiveBurn', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('holds spend priority before FIFO acquire', async () => {
    const order: string[] = []
    const requestSpendPriority = vi.fn(() => {
      order.push('priority')
      return () => {
        order.push('release-priority')
      }
    })
    const runExclusiveSpendCoordinated = vi.fn(async (fn: () => Promise<string>) => {
      order.push('fifo')
      return fn()
    })

    vi.doMock('./walletCoordinator', () => ({
      requestSpendPriority: (reason: string) => requestSpendPriority(reason),
      runExclusiveSpend: runExclusiveSpendCoordinated,
    }))
    vi.doMock('./chainedChangeHeal', () => ({
      runChangeHeal: vi.fn(async () => ({
        restored: 0,
        scriptsLocal: 0,
        scriptsChain: 0,
        pendingPromoted: 0,
        reclaimed: 0,
      })),
    }))
    vi.doMock('./spendLease', () => ({
      acquireSpendLease: async () => async () => undefined,
    }))

    const { runExclusiveBurn } = await import('./spendGuard')
    await expect(runExclusiveBurn('burn-collectable', async () => 'ok')).resolves.toBe('ok')
    expect(order).toEqual(['priority', 'fifo', 'release-priority'])
    expect(requestSpendPriority).toHaveBeenCalledWith('burn-collectable')
  })
})
