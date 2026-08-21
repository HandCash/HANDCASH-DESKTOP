import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canBeginChainIngest,
  canBeginSpend,
  initialWalletCoordinatorContext,
} from './walletCoordinatorMachine'
import {
  getWalletCoordinatorSnapshot,
  resetWalletCoordinatorForTests,
  runChainIngest,
  runChainIngestDuringSpend,
  runExclusiveSpend,
  runHistoryReplica,
  runRecompose,
  requestSpendPriority,
  releaseSpendPriority,
  shouldYieldChainIngestToSpend,
  getSpendPriorityDepth,
  describeSpendPriorityHolds,
} from './walletCoordinator'

describe('walletCoordinator guards', () => {
  it('rejects nested chain ingest without active spend', () => {
    expect(canBeginChainIngest(initialWalletCoordinatorContext, false)).toBe(true)
    expect(canBeginChainIngest(initialWalletCoordinatorContext, true)).toBe(false)
  })

  it('rejects spend while chain ingest is active', () => {
    const busy = { ...initialWalletCoordinatorContext, chainIngestDepth: 1 }
    expect(canBeginSpend(busy)).toBe(false)
  })
})

describe('walletCoordinator runtime', () => {
  beforeEach(() => {
    resetWalletCoordinatorForTests()
  })

  it('serializes overlapping chain ingest calls', async () => {
    const order: string[] = []
    let releaseFirst!: () => void
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = runChainIngest(async () => {
      order.push('a-start')
      await firstHold
      order.push('a-end')
      return 1
    })
    await Promise.resolve()
    const second = runChainIngest(async () => {
      order.push('b')
      return 2
    })

    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['a-start', 'a-end', 'b'])
    expect(getWalletCoordinatorSnapshot().chainIngest).toBe('idle')
  })

  it('blocks external chain ingest during spend', async () => {
    const order: string[] = []
    let releaseSpend!: () => void
    const spendHold = new Promise<void>((resolve) => {
      releaseSpend = resolve
    })

    const spend = runExclusiveSpend(async () => {
      order.push('spend-start')
      await spendHold
      order.push('spend-end')
      return 'tx'
    }, async () => async () => undefined)

    await Promise.resolve()
    const refresh = runChainIngest(async () => {
      order.push('refresh')
      return null
    })
    order.push('refresh-queued')

    releaseSpend()
    await Promise.all([spend, refresh])

    expect(order).toEqual(['refresh-queued', 'spend-start', 'spend-end', 'refresh'])
  })

  it('blocks external chain ingest during wallet recompose', async () => {
    const order: string[] = []
    let releaseRecompose!: () => void
    const hold = new Promise<void>((resolve) => {
      releaseRecompose = resolve
    })

    const recompose = runRecompose(async () => {
      order.push('recompose-start')
      await hold
      order.push('recompose-end')
    })
    await Promise.resolve()
    const refresh = runChainIngest(async () => {
      order.push('refresh')
    })
    order.push('refresh-queued')

    releaseRecompose()
    await Promise.all([recompose, refresh])
    expect(order).toEqual([
      'refresh-queued',
      'recompose-start',
      'recompose-end',
      'refresh',
    ])
  })

  it('allows nested chain ingest during spend heal', async () => {
    const order: string[] = []

    await runExclusiveSpend(async () => {
      order.push('spend')
      await runChainIngestDuringSpend(async () => {
        order.push('heal')
      })
      order.push('done')
    }, async () => async () => undefined)

    expect(order).toEqual(['spend', 'heal', 'done'])
    expect(getWalletCoordinatorSnapshot()).toEqual({
      chainIngest: 'idle',
      spend: 'idle',
      historyReplica: 'idle',
      recompose: 'idle',
    })
  })

  it('throws when nested chain ingest is requested without a spend session', () => {
    expect(() => runChainIngestDuringSpend(async () => 'x')).toThrow(
      /active spend session/i,
    )
  })

  it('marks spend priority while a send is queued or running', async () => {
    expect(shouldYieldChainIngestToSpend()).toBe(false)
    let releaseSpend!: () => void
    const hold = new Promise<void>((resolve) => {
      releaseSpend = resolve
    })

    const spend = runExclusiveSpend(async () => {
      expect(shouldYieldChainIngestToSpend()).toBe(true)
      await hold
    }, async () => async () => undefined)

    await Promise.resolve()
    expect(shouldYieldChainIngestToSpend()).toBe(true)
    releaseSpend()
    await spend
    expect(shouldYieldChainIngestToSpend()).toBe(false)
  })

  it('notifies onSpendRegion after FIFO acquire and before the lease', async () => {
    const order: string[] = []
    await runExclusiveSpend(
      async () => {
        order.push('fn')
      },
      async () => {
        order.push('lease')
        return async () => {
          order.push('release-lease')
        }
      },
      () => {
        order.push('acquired')
      },
    )
    expect(order).toEqual(['acquired', 'lease', 'fn', 'release-lease'])
  })

  it('tracks explicit requestSpendPriority independently of the FIFO', () => {
    expect(shouldYieldChainIngestToSpend()).toBe(false)
    requestSpendPriority()
    expect(shouldYieldChainIngestToSpend()).toBe(true)
    releaseSpendPriority()
    expect(shouldYieldChainIngestToSpend()).toBe(false)
  })

  it('releases only its own hold, and does so once', () => {
    const releaseA = requestSpendPriority('a')
    requestSpendPriority('b')
    expect(getSpendPriorityDepth()).toBe(2)

    releaseA()
    releaseA()

    expect(describeSpendPriorityHolds().map((h) => h.split(' ')[0])).toEqual(['b'])
  })

  it('expires a leaked hold instead of disabling item ingest forever', () => {
    vi.useFakeTimers()
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      requestSpendPriority('permission-prompt')
      expect(shouldYieldChainIngestToSpend()).toBe(true)

      vi.advanceTimersByTime(91_000)

      expect(shouldYieldChainIngestToSpend()).toBe(false)
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('permission-prompt'),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a hold alive while its work reports in, and still expires a dead one', async () => {
    const { leaseSpendPriority } = await import('./walletCoordinator')
    vi.useFakeTimers()
    try {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const lease = leaseSpendPriority('runExclusiveSpend')

      // A mint that waits on proofs for an unmined genesis outlives the expiry.
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(30_000)
        lease.touch()
      }
      expect(shouldYieldChainIngestToSpend()).toBe(true)

      // Stop reporting in and the hold lapses, as a leaked one must.
      vi.advanceTimersByTime(91_000)
      expect(shouldYieldChainIngestToSpend()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports how long a spend has really been held, not since its last heartbeat', async () => {
    const { leaseSpendPriority } = await import('./walletCoordinator')
    vi.useFakeTimers()
    try {
      const lease = leaseSpendPriority('runExclusiveSpend')
      vi.advanceTimersByTime(60_000)
      lease.touch()
      expect(describeSpendPriorityHolds()[0]).toBe('runExclusiveSpend (60s)')
    } finally {
      vi.useRealTimers()
    }
  })

  it('names the holder so a stall can be attributed', () => {
    requestSpendPriority('runExclusiveSpend')
    expect(describeSpendPriorityHolds()[0]).toMatch(/^runExclusiveSpend \(\d+s\)$/)
  })

  it('defers historyReplica when spend priority is raised', async () => {
    const { HistoryDeferredForSpendError, runHistoryReplica } = await import(
      './walletCoordinator'
    )
    requestSpendPriority()
    await expect(runHistoryReplica(async () => 'backed-up')).rejects.toBeInstanceOf(
      HistoryDeferredForSpendError,
    )
    releaseSpendPriority()
  })

  it('runs a starved historyReplica without yielding to a queued spend', async () => {
    const { runHistoryReplica } = await import('./walletCoordinator')
    requestSpendPriority('runExclusiveSpend')
    await expect(runHistoryReplica(async () => 'backed-up', 'starved')).resolves.toBe(
      'backed-up',
    )
    releaseSpendPriority()
  })

  it('lets spend acquire ahead of a waiting historyReplica (per-region queues)', async () => {
    const order: string[] = []
    let releaseChain!: () => void
    const chainHold = new Promise<void>((resolve) => {
      releaseChain = resolve
    })

    const chain = runChainIngest(async () => {
      order.push('chain-start')
      await chainHold
      order.push('chain-end')
    })
    await Promise.resolve()

    // History waits on the machine (chain busy) without occupying a shared FIFO.
    const history = runHistoryReplica(async () => {
      order.push('history')
      return 'ok'
    }).catch((err: unknown) => {
      order.push(err instanceof Error ? err.name : 'history-err')
    })

    await Promise.resolve()
    const spend = runExclusiveSpend(async () => {
      order.push('spend')
      return 'tx'
    }, async () => async () => undefined)

    releaseChain()
    await Promise.all([chain, spend, history])

    expect(order).toEqual(
      expect.arrayContaining(['chain-start', 'chain-end', 'spend', 'HistoryDeferredForSpendError']),
    )
    expect(order.filter((x) => x === 'history')).toHaveLength(0)
    expect(order.filter((x) => x === 'spend')).toHaveLength(1)
  })
})
