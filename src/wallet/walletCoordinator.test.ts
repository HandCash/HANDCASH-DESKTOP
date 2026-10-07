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
  describeForegroundSpendPriorityHolds,
  SpendRegionAbandonedError,
  SPEND_REGION_ABANDONED,
  rebindWalletCoordinatorForRuntime,
  waitForChainIngestIdle,
  waitForForegroundSpendIdle,
} from './walletCoordinator'

describe('walletCoordinator guards', () => {
  it('rejects nested chain ingest without active spend', () => {
    expect(canBeginChainIngest(initialWalletCoordinatorContext, false)).toBe(true)
    expect(canBeginChainIngest(initialWalletCoordinatorContext, true)).toBe(false)
  })

  it('allows spend while chain ingest is discovering funds', () => {
    const busy = { ...initialWalletCoordinatorContext, chainIngestDepth: 1 }
    expect(canBeginSpend(busy)).toBe(true)
  })

  it('still rejects spend during history replica or recompose', () => {
    expect(
      canBeginSpend({ ...initialWalletCoordinatorContext, historyReplicaDepth: 1 }),
    ).toBe(false)
    expect(
      canBeginSpend({ ...initialWalletCoordinatorContext, recomposeDepth: 1 }),
    ).toBe(false)
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

  it('holds an account switch fence only until foreground spend bookkeeping ends', async () => {
    let releaseSpend!: () => void
    let started!: () => void
    const hold = new Promise<void>((resolve) => {
      releaseSpend = resolve
    })
    const active = new Promise<void>((resolve) => {
      started = resolve
    })
    const spend = runExclusiveSpend(
      async () => {
        started()
        await hold
      },
    )
    await active
    let switched = false
    const fence = waitForForegroundSpendIdle().then(() => {
      switched = true
    })

    await Promise.resolve()
    expect(switched).toBe(false)
    releaseSpend()
    await spend
    await fence
    expect(switched).toBe(true)
  })

  it('drains a chain-ingest occupant before an account switch completes', async () => {
    let releaseHeal!: () => void
    let started!: () => void
    const hold = new Promise<void>((resolve) => {
      releaseHeal = resolve
    })
    const active = new Promise<void>((resolve) => {
      started = resolve
    })
    const heal = runChainIngest(async () => {
      started()
      await hold
    })
    await active

    let drained: boolean | null = null
    const fence = waitForChainIngestIdle(5_000).then((idle) => {
      drained = idle
    })
    await Promise.resolve()
    expect(drained).toBeNull()

    releaseHeal()
    await heal
    await fence
    expect(drained).toBe(true)
  })

  it('gives up on a chain-ingest occupant that never releases, and says so', async () => {
    vi.useFakeTimers()
    let releaseStuck!: () => void
    const stuck = new Promise<void>((resolve) => {
      releaseStuck = resolve
    })
    let started!: () => void
    const active = new Promise<void>((resolve) => {
      started = resolve
    })
    const occupant = runChainIngest(async () => {
      started()
      await stuck
    })
    try {
      await active
      const fence = waitForChainIngestIdle(50)
      await vi.advanceTimersByTimeAsync(60)
      expect(await fence).toBe(false)
    } finally {
      releaseStuck()
      await occupant
      vi.useRealTimers()
    }
  })

  it('fences queued work when the wallet runtime changes', async () => {
    let releaseFirst!: () => void
    let markStarted!: () => void
    const hold = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const first = runChainIngest(async () => {
      markStarted()
      await hold
    })
    await started
    const stale = runChainIngest(async () => 'stale')

    rebindWalletCoordinatorForRuntime()
    const fresh = runChainIngest(async () => 'fresh')
    releaseFirst()

    await expect(stale).rejects.toMatchObject({ name: 'AbortError' })
    await expect(fresh).resolves.toBe('fresh')
    await first
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
    })

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
    })

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
    })

    await Promise.resolve()
    expect(shouldYieldChainIngestToSpend()).toBe(true)
    releaseSpend()
    await spend
    expect(shouldYieldChainIngestToSpend()).toBe(false)
  })

  it('notifies onSpendRegion after FIFO acquire and before the spend body', async () => {
    const order: string[] = []
    await runExclusiveSpend(
      async () => {
        order.push('fn')
      },
      () => {
        order.push('acquired')
      },
    )
    expect(order).toEqual(['acquired', 'fn'])
  })

  it('frees the region when a hung spend is aborted, so the next payment runs', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const abort = new AbortController()

    // A toolbox call that never settles — the shape of a lost IDB transaction.
    const hung = runExclusiveSpend(() => new Promise<string>(() => {}), undefined, {
      abandonSignal: abort.signal,
    })
    await Promise.resolve()
    abort.abort('Send timed out')

    await expect(hung).rejects.toBeInstanceOf(SpendRegionAbandonedError)
    await expect(runExclusiveSpend(async () => 'next-tx')).resolves.toBe('next-tx')
    expect(getWalletCoordinatorSnapshot().spend).toBe('idle')
    expect(getSpendPriorityDepth()).toBe(0)
  })

  it('gives up on a spend that never reports back at all', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      runExclusiveSpend(() => new Promise<string>(() => {}), undefined, {
        ceilingMs: 1_000,
      }),
    ).rejects.toMatchObject({
      code: 'SPEND_REGION_ABANDONED',
      abandonCause: 'ceiling',
    })
  })

  it('names the cause so the next spend knows to heal first', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const abort = new AbortController()
    abort.abort('Send timed out')

    await expect(
      runExclusiveSpend(
        () => new Promise<string>(() => {}),
        undefined,
        { abandonSignal: abort.signal },
      ),
    ).rejects.toMatchObject({
      code: SPEND_REGION_ABANDONED,
      abandonCause: 'aborted',
    })
  })

  it('does not let an abandoned spend reject after the fact', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let failLate!: (err: Error) => void
    const abort = new AbortController()

    const hung = runExclusiveSpend(
      () =>
        new Promise<string>((_, reject) => {
          failLate = reject
        }),
      undefined,
      { abandonSignal: abort.signal },
    )
    await Promise.resolve()
    abort.abort('Send timed out')
    await expect(hung).rejects.toBeInstanceOf(SpendRegionAbandonedError)

    failLate(new Error('createAction failed after we stopped waiting'))
    await Promise.resolve()
    expect(warn).toHaveBeenCalledWith(
      '[coordinator] abandoned spend failed late',
      'createAction failed after we stopped waiting',
    )
  })

  it('hands the abandoned work to the caller, which may still broadcast', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let postLate!: (txid: string) => void
    const abort = new AbortController()

    const hung = runExclusiveSpend(
      () =>
        new Promise<string>((resolve) => {
          postLate = resolve
        }),
      undefined,
      { abandonSignal: abort.signal },
    )
    await Promise.resolve()
    abort.abort('Send timed out')
    const err = (await hung.catch((e: unknown) => e)) as SpendRegionAbandonedError
    expect(err).toBeInstanceOf(SpendRegionAbandonedError)

    postLate('ab'.repeat(32))
    await expect(err.late).resolves.toBe('ab'.repeat(32))
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

  it('keeps background holds out of the foreground list while ingest still yields to both', async () => {
    let finish: (() => void) | undefined
    const bundle = runExclusiveSpend(() => new Promise<void>((resolve) => { finish = resolve }), undefined, {
      lane: 'background',
    })
    expect(shouldYieldChainIngestToSpend()).toBe(true)
    expect(describeForegroundSpendPriorityHolds()).toEqual([])
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const releasePrompt = requestSpendPriority('permission-prompt')
    expect(describeForegroundSpendPriorityHolds().map((h) => h.split(' ')[0])).toEqual(['permission-prompt'])
    releasePrompt()
    finish!()
    await bundle
    expect(shouldYieldChainIngestToSpend()).toBe(false)
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

  it('defers nested recompose history when a permission prompt is waiting', async () => {
    const {
      HistoryDeferredForSpendError,
      runHistoryReplica,
      runRecompose,
    } = await import('./walletCoordinator')
    await runRecompose(async () => {
      requestSpendPriority('permission-prompt')
      await expect(runHistoryReplica(async () => 'backed-up')).rejects.toBeInstanceOf(
        HistoryDeferredForSpendError,
      )
      releaseSpendPriority()
      return 'ok'
    })
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
    })

    releaseChain()
    await Promise.all([chain, spend, history])

    expect(order).toEqual(
      expect.arrayContaining(['chain-start', 'chain-end', 'spend', 'HistoryDeferredForSpendError']),
    )
    expect(order.filter((x) => x === 'history')).toHaveLength(0)
    expect(order.filter((x) => x === 'spend')).toHaveLength(1)
  })

  it('starts a spend while chain ingest is still held', async () => {
    let releaseChain!: () => void
    const chainHold = new Promise<void>((resolve) => {
      releaseChain = resolve
    })
    const order: string[] = []
    const chain = runChainIngest(async () => {
      order.push('chain-start')
      await chainHold
      order.push('chain-end')
    })
    await Promise.resolve()

    const spend = runExclusiveSpend(async () => {
      order.push('spend')
      return 'tx'
    })

    await expect(spend).resolves.toBe('tx')
    expect(order).toEqual(['chain-start', 'spend'])
    releaseChain()
    await chain
    expect(order).toEqual(['chain-start', 'spend', 'chain-end'])
  })
})
