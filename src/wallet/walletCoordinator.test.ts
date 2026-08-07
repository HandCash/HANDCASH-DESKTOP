import { beforeEach, describe, expect, it } from 'vitest'
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
  requestSpendPriority,
  releaseSpendPriority,
  shouldYieldChainIngestToSpend,
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

  it('tracks explicit requestSpendPriority independently of the FIFO', () => {
    expect(shouldYieldChainIngestToSpend()).toBe(false)
    requestSpendPriority()
    expect(shouldYieldChainIngestToSpend()).toBe(true)
    releaseSpendPriority()
    expect(shouldYieldChainIngestToSpend()).toBe(false)
  })
})
