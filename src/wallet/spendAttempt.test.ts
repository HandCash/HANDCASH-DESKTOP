import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityEntry } from './appActivity'

const mocks = vi.hoisted(() => ({
  txExistsOnChain: vi.fn(),
  isCollectableOutpointSpendable: vi.fn(),
  sendCollectable: vi.fn(),
  getBeefForTxidCached: vi.fn(),
  broadcastAtomicBeef: vi.fn(),
  removeActivityById: vi.fn(),
  removeFailedActivity: vi.fn(),
  countFailedActivity: vi.fn(),
  repairFailedSpendState: vi.fn(),
  counterpartyMaySettle: vi.fn(),
}))

vi.mock('./sentItemGuard', () => ({
  counterpartyMaySettle: mocks.counterpartyMaySettle,
}))

vi.mock('./legacyScan', () => ({
  txExistsOnChain: mocks.txExistsOnChain,
}))

vi.mock('./collectables', () => ({
  isCollectableOutpointSpendable: mocks.isCollectableOutpointSpendable,
  sendCollectable: mocks.sendCollectable,
}))

vi.mock('./beefCache', () => ({
  getBeefForTxidCached: mocks.getBeefForTxidCached,
}))

vi.mock('./sendBrc29Payment', () => ({
  broadcastAtomicBeef: mocks.broadcastAtomicBeef,
}))

vi.mock('./session', () => ({
  getActiveWallet: () => ({ chain: 'main' }),
}))

vi.mock('./actionReview', () => ({
  repairFailedSpendState: mocks.repairFailedSpendState,
}))

vi.mock('./appActivity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./appActivity')>()),
  removeActivityById: mocks.removeActivityById,
  removeFailedActivity: mocks.removeFailedActivity,
  countFailedActivity: mocks.countFailedActivity,
}))

import {
  clearAllFailedSpends,
  clearSpendAttempt,
  resolveSpendAttemptFate,
  retrySpendAttempt,
} from './spendAttempt'

const TX = 'a'.repeat(64)
const OUTPOINT = `${'b'.repeat(64)}.0`

function itemAttempt(partial: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: 'attempt',
    origin: 'handcash',
    kind: 'spent',
    sats: 1,
    at: Date.now() - 60 * 60_000,
    method: 'send-collectable',
    txid: TX,
    item: { name: 'Fox', origin: OUTPOINT.replace('.', '_'), outpoint: OUTPOINT },
    retry: { kind: 'send-collectable', outpoint: OUTPOINT, toAddress: '1recipient' },
    ...partial,
  }
}

function paymentAttempt(partial: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: 'payment',
    origin: 'handcash',
    kind: 'spent',
    sats: 1200,
    at: Date.now(),
    method: 'send',
    status: 'failed',
    failureReason: 'Broadcast refused',
    retry: { kind: 'send-bsv', toAddress: '1payee', satoshis: 1200 },
    ...partial,
  }
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.repairFailedSpendState.mockResolvedValue({
    failedTxs: 0,
    reviewLog: '',
    quarantined: 0,
    healed: 0,
  })
  mocks.removeActivityById.mockReturnValue(true)
  mocks.removeFailedActivity.mockReturnValue(0)
  mocks.countFailedActivity.mockReturnValue(0)
  mocks.counterpartyMaySettle.mockReturnValue(false)
})

describe('resolveSpendAttemptFate — items', () => {
  it('refuses retry once the attempted transaction is on-chain', async () => {
    mocks.txExistsOnChain.mockResolvedValue(true)

    await expect(resolveSpendAttemptFate(itemAttempt(), 'main')).resolves.toEqual({
      kind: 'confirmed',
    })
    expect(mocks.isCollectableOutpointSpendable).not.toHaveBeenCalled()
  })

  it('fails closed and blocks clearing when confirmation cannot be checked', async () => {
    mocks.txExistsOnChain.mockResolvedValue(null)

    const fate = await resolveSpendAttemptFate(itemAttempt(), 'main')
    expect(fate).toMatchObject({
      kind: 'refuse',
      reason: 'statusUnknown',
      mayClear: false,
    })
    expect(mocks.isCollectableOutpointSpendable).not.toHaveBeenCalled()
  })

  it('allows retry only when the original item output is spendable', async () => {
    mocks.txExistsOnChain.mockResolvedValue(false)
    mocks.isCollectableOutpointSpendable.mockResolvedValue(true)

    await expect(
      resolveSpendAttemptFate(itemAttempt(), 'main'),
    ).resolves.toMatchObject({
      kind: 'retry',
      action: 'rebroadcast',
      retry: { outpoint: OUTPOINT, toAddress: '1recipient' },
    })
  })

  it('explains why a spent or missing original output cannot be retried', async () => {
    mocks.txExistsOnChain.mockResolvedValue(false)
    mocks.isCollectableOutpointSpendable.mockResolvedValue(false)

    const fate = await resolveSpendAttemptFate(itemAttempt(), 'main')
    expect(fate).toMatchObject({
      kind: 'refuse',
      reason: 'sourceNotSpendable',
      mayClear: true,
    })
  })

  it('rebroadcasts the original signed BEEF instead of creating a double spend', async () => {
    mocks.txExistsOnChain.mockResolvedValue(false)
    mocks.isCollectableOutpointSpendable.mockResolvedValue(true)
    mocks.getBeefForTxidCached.mockResolvedValue({
      toBinaryAtomic: () => [1, 2, 3],
    })
    mocks.broadcastAtomicBeef.mockResolvedValue(true)

    await expect(retrySpendAttempt(itemAttempt(), 'main')).resolves.toEqual({
      kind: 'rebroadcasted',
      txid: TX,
    })
    expect(mocks.sendCollectable).not.toHaveBeenCalled()
  })

  it('recreates only an attempt that failed before producing a txid', async () => {
    mocks.isCollectableOutpointSpendable.mockResolvedValue(true)
    mocks.sendCollectable.mockResolvedValue({ txid: 'c'.repeat(64) })

    await expect(
      retrySpendAttempt(itemAttempt({ txid: undefined, status: 'failed' }), 'main'),
    ).resolves.toEqual({ kind: 'recreated', txid: 'c'.repeat(64) })
    expect(mocks.broadcastAtomicBeef).not.toHaveBeenCalled()
  })
})

describe('isSpendAttempt', () => {
  it('leaves a freshly broadcast payment alone until its grace window passes', async () => {
    const fresh = paymentAttempt({ status: 'complete', txid: TX, at: Date.now() })

    await expect(resolveSpendAttemptFate(fresh, 'main')).resolves.toEqual({
      kind: 'notAttempt',
    })
    expect(mocks.txExistsOnChain).not.toHaveBeenCalled()
  })
})

describe('resolveSpendAttemptFate — payments', () => {
  it('offers a failed coin payment back to the Send screen rather than re-spending', async () => {
    const fate = await resolveSpendAttemptFate(paymentAttempt(), 'main')

    expect(fate).toMatchObject({
      kind: 'retry',
      action: 'reopenPayment',
      mayClear: true,
    })
    expect(mocks.txExistsOnChain).not.toHaveBeenCalled()
    expect(mocks.isCollectableOutpointSpendable).not.toHaveBeenCalled()
  })

  it('never silently re-spends coins on retry', async () => {
    await expect(retrySpendAttempt(paymentAttempt(), 'main')).resolves.toEqual({
      kind: 'reopenPayment',
      toAddress: '1payee',
      satoshis: 1200,
    })
    expect(mocks.sendCollectable).not.toHaveBeenCalled()
    expect(mocks.broadcastAtomicBeef).not.toHaveBeenCalled()
  })

  it('still allows clearing a legacy payment row with no saved recipient', async () => {
    const fate = await resolveSpendAttemptFate(
      paymentAttempt({ retry: undefined }),
      'main',
    )

    expect(fate).toMatchObject({
      kind: 'refuse',
      reason: 'missingRetryDetails',
      mayClear: true,
    })
  })
})

describe('a transfer the recipient can still settle', () => {
  it('offers neither retry nor clear while the payee may still broadcast', async () => {
    mocks.counterpartyMaySettle.mockReturnValue(true)
    mocks.txExistsOnChain.mockResolvedValue(false)

    const fate = await resolveSpendAttemptFate(
      itemAttempt({ status: 'failed' }),
      'main',
    )
    expect(fate).toMatchObject({
      kind: 'refuse',
      reason: 'counterpartyMaySettle',
      mayClear: false,
      mayReleaseFunds: true,
    })
    // Classifying must not even reach the chain or spendability probes.
    expect(mocks.txExistsOnChain).not.toHaveBeenCalled()
    expect(mocks.isCollectableOutpointSpendable).not.toHaveBeenCalled()
  })

  it('refuses to delete the sender’s only record of it', async () => {
    mocks.counterpartyMaySettle.mockReturnValue(true)

    await expect(clearSpendAttempt(itemAttempt({ status: 'failed' }))).rejects.toThrow(
      /can still broadcast/i,
    )
    expect(mocks.removeActivityById).not.toHaveBeenCalled()
  })

  it('refuses to re-send it, so the wallet cannot race a live transfer', async () => {
    mocks.counterpartyMaySettle.mockReturnValue(true)
    mocks.isCollectableOutpointSpendable.mockResolvedValue(true)

    await expect(
      retrySpendAttempt(itemAttempt({ txid: undefined, status: 'failed' }), 'main'),
    ).rejects.toThrow(/can still broadcast/i)
    expect(mocks.sendCollectable).not.toHaveBeenCalled()
    expect(mocks.broadcastAtomicBeef).not.toHaveBeenCalled()
  })

  it('does not gate a coin payment, which has no payee-broadcast path', async () => {
    mocks.counterpartyMaySettle.mockReturnValue(true)
    mocks.txExistsOnChain.mockResolvedValue(false)

    await expect(
      resolveSpendAttemptFate(paymentAttempt(), 'main'),
    ).resolves.toMatchObject({ kind: 'retry', action: 'reopenPayment' })
  })
})

describe('clearSpendAttempt', () => {
  it('releases local spend reservations before removing the row', async () => {
    const order: string[] = []
    mocks.repairFailedSpendState.mockImplementation(async () => {
      order.push('repair')
      return { failedTxs: 1, reviewLog: '', quarantined: 0, healed: 0 }
    })
    mocks.removeActivityById.mockImplementation(() => {
      order.push('remove')
      return true
    })

    await expect(clearSpendAttempt(paymentAttempt())).resolves.toEqual({
      removed: true,
    })
    expect(order).toEqual(['repair', 'remove'])
  })

  it('still removes the row when the local repair throws', async () => {
    mocks.repairFailedSpendState.mockRejectedValue(new Error('storage locked'))

    await expect(clearSpendAttempt(itemAttempt())).resolves.toEqual({
      removed: true,
    })
    expect(mocks.removeActivityById).toHaveBeenCalledWith('attempt')
  })
})

describe('clearAllFailedSpends', () => {
  it('repairs local reservations once, then drops every failed row', async () => {
    mocks.countFailedActivity.mockReturnValue(5)
    mocks.removeFailedActivity.mockReturnValue(5)

    await expect(clearAllFailedSpends()).resolves.toEqual({
      removed: 5,
      kept: 0,
    })
    expect(mocks.repairFailedSpendState).toHaveBeenCalledTimes(1)
    expect(mocks.removeFailedActivity).toHaveBeenCalledTimes(1)
    expect(mocks.removeActivityById).not.toHaveBeenCalled()
  })

  it('clears the backlog even when the repair throws', async () => {
    mocks.repairFailedSpendState.mockRejectedValue(new Error('storage locked'))
    mocks.countFailedActivity.mockReturnValue(3)
    mocks.removeFailedActivity.mockReturnValue(3)

    await expect(clearAllFailedSpends()).resolves.toEqual({
      removed: 3,
      kept: 0,
    })
  })

  it('keeps back rows the recipient can still broadcast, and reports them', async () => {
    mocks.countFailedActivity.mockReturnValue(4)
    mocks.removeFailedActivity.mockReturnValue(3)

    await expect(clearAllFailedSpends()).resolves.toEqual({
      removed: 3,
      kept: 1,
    })
    // The predicate is what protects them — a bulk clear must not pass none.
    expect(mocks.removeFailedActivity).toHaveBeenCalledWith(expect.any(Function))
  })

  it('never reports a negative backlog when repair settles rows mid-clear', async () => {
    mocks.countFailedActivity.mockReturnValue(0)
    mocks.removeFailedActivity.mockReturnValue(2)

    await expect(clearAllFailedSpends()).resolves.toEqual({
      removed: 2,
      kept: 0,
    })
  })
})
