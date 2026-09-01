import { P2PKH, PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityEntry } from './appActivity'

const mocks = vi.hoisted(() => ({
  txExistsOnChain: vi.fn(),
  spentStatusOfOutpoint: vi.fn(),
  isCollectableOutpointSpendable: vi.fn(),
  sendCollectable: vi.fn(),
  getBeefForTxidCached: vi.fn(),
  broadcastAtomicBeef: vi.fn(),
  removeActivityById: vi.fn(),
  removeFailedActivity: vi.fn(),
  countFailedActivity: vi.fn(),
  listFailedActivity: vi.fn(),
  releaseUnsignedSpendReservations: vi.fn(),
  counterpartyMaySettle: vi.fn(),
  getProvenOrRawTx: vi.fn(),
  getTxByTxid: vi.fn(),
  keepChangeOfSignedTx: vi.fn(),
  hideSpentOutpoints: vi.fn(),
  getFungible: vi.fn(),
  sendFungible: vi.fn(),
}))

vi.mock('./sentItemGuard', () => ({
  counterpartyMaySettle: mocks.counterpartyMaySettle,
}))

vi.mock('./legacyScan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./legacyScan')>()),
  txExistsOnChain: mocks.txExistsOnChain,
  spentStatusOfOutpoint: mocks.spentStatusOfOutpoint,
}))

vi.mock('./collectables', () => ({
  isCollectableOutpointSpendable: mocks.isCollectableOutpointSpendable,
  sendCollectable: mocks.sendCollectable,
}))

vi.mock('./fungibles', () => ({
  getFungible: mocks.getFungible,
  getCachedFungibles: () => [],
}))

vi.mock('./sendFungible', () => ({
  sendFungible: mocks.sendFungible,
}))

vi.mock('./beefCache', () => ({
  getBeefForTxidCached: mocks.getBeefForTxidCached,
}))

vi.mock('./sendBrc29Payment', () => ({
  broadcastAtomicBeef: mocks.broadcastAtomicBeef,
}))

vi.mock('./txStore', () => ({
  getTxByTxid: mocks.getTxByTxid,
}))

vi.mock('./staleOutputRelease', () => ({
  keepChangeOfSignedTx: mocks.keepChangeOfSignedTx,
  hideSpentOutpoints: mocks.hideSpentOutpoints,
}))

vi.mock('./session', () => ({
  getActiveWallet: () => ({
    chain: 'main',
    wallet: {
      storage: {
        runAsStorageProvider: async <T>(
          fn: (sp: { getProvenOrRawTx: typeof mocks.getProvenOrRawTx }) => Promise<T>,
        ) => fn({ getProvenOrRawTx: mocks.getProvenOrRawTx }),
      },
    },
  }),
}))

vi.mock('./actionReview', () => ({
  releaseUnsignedSpendReservations: mocks.releaseUnsignedSpendReservations,
}))

vi.mock('./appActivity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./appActivity')>()),
  removeActivityById: mocks.removeActivityById,
  removeFailedActivity: mocks.removeFailedActivity,
  countFailedActivity: mocks.countFailedActivity,
  listFailedActivity: mocks.listFailedActivity,
}))

import {
  clearAllFailedSpends,
  clearSpendAttempt,
  countRebroadcastableFailedSpends,
  rebroadcastAllFailedSpends,
  resolveSpendAttemptFate,
  retrySpendAttempt,
} from './spendAttempt'

const TX = 'a'.repeat(64)
const PREV = 'b'.repeat(64)
const OUTPOINT = `${PREV}.0`

function spendTxRaw(prevTxid = PREV, prevVout = 0): number[] {
  const tx = new Transaction()
  tx.addInput({
    sourceTXID: prevTxid,
    sourceOutputIndex: prevVout,
    unlockingScript: new UnlockingScript([]),
    sequence: 0xffffffff,
  })
  tx.addOutput({
    satoshis: 1000,
    lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
  })
  return tx.toBinary()
}

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

function tokenAttempt(partial: Partial<ActivityEntry> = {}): ActivityEntry {
  const tokenId = `${'c'.repeat(64)}_0`
  return {
    id: 'token-attempt',
    origin: 'handcash',
    kind: 'spent',
    sats: 1,
    at: Date.now() - 60 * 60_000,
    method: 'send-token',
    status: 'failed',
    failureReason: 'Delivery failed',
    item: {
      name: 'TST',
      origin: tokenId,
      tokenId,
      amt: '25',
      dec: 0,
      outpoint: OUTPOINT,
    },
    retry: {
      kind: 'send-token',
      tokenId,
      amount: '25',
      toAddress: '1recipient',
    },
    ...partial,
  }
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.releaseUnsignedSpendReservations.mockResolvedValue({
    failedTxs: 0,
    reviewLog: '',
    batchesAborted: 0,
  })
  mocks.removeActivityById.mockReturnValue(true)
  mocks.removeFailedActivity.mockReturnValue(0)
  mocks.countFailedActivity.mockReturnValue(0)
  mocks.listFailedActivity.mockReturnValue([])
  mocks.counterpartyMaySettle.mockReturnValue(false)
  mocks.getProvenOrRawTx.mockResolvedValue(undefined)
  mocks.getTxByTxid.mockReturnValue(null)
  mocks.spentStatusOfOutpoint.mockResolvedValue('unknown')
  mocks.isCollectableOutpointSpendable.mockResolvedValue(true)
  mocks.keepChangeOfSignedTx.mockResolvedValue(0)
  mocks.hideSpentOutpoints.mockResolvedValue(0)
  mocks.getFungible.mockReturnValue({
    tokenId: `${'c'.repeat(64)}_0`,
    sym: 'TST',
    amt: '100',
    dec: 0,
    utxoCount: 1,
    outpoint: OUTPOINT,
    spendKind: 'plain',
  })
  mocks.sendFungible.mockResolvedValue({ txid: TX })
})

describe('resolveSpendAttemptFate — tokens', () => {
  it('blocks retry while the peer can still settle', async () => {
    mocks.counterpartyMaySettle.mockReturnValue(true)
    await expect(
      resolveSpendAttemptFate(tokenAttempt(), 'main'),
    ).resolves.toMatchObject({
      kind: 'refuse',
      reason: 'counterpartyMaySettle',
      mayClear: false,
    })
    expect(mocks.counterpartyMaySettle).toHaveBeenCalledWith(
      OUTPOINT,
      expect.any(Number),
    )
  })

  it('recreates only an unsigned token attempt with enough live balance', async () => {
    const entry = tokenAttempt({ txid: undefined })
    await expect(resolveSpendAttemptFate(entry, 'main')).resolves.toMatchObject({
      kind: 'retry',
      action: 'recreateItem',
      retry: { kind: 'send-token' },
    })
    await expect(retrySpendAttempt(entry, 'main')).resolves.toEqual({
      kind: 'recreated',
      txid: TX,
    })
    expect(mocks.sendFungible).toHaveBeenCalledWith({
      tokenId: `${'c'.repeat(64)}_0`,
      amount: '25',
      toAddress: '1recipient',
      recipientIdentityKey: undefined,
      friendLabel: undefined,
    })
  })
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

  it('allows retry only when the original item output is spendable, and never clear while inputs live', async () => {
    mocks.txExistsOnChain.mockResolvedValue(false)
    mocks.isCollectableOutpointSpendable.mockResolvedValue(true)

    await expect(
      resolveSpendAttemptFate(itemAttempt(), 'main'),
    ).resolves.toMatchObject({
      kind: 'retry',
      action: 'rebroadcast',
      retry: { outpoint: OUTPOINT, toAddress: '1recipient' },
      mayClear: false,
    })
  })

  it('lets an unsigned item attempt be cleared when the source is gone', async () => {
    mocks.isCollectableOutpointSpendable.mockResolvedValue(false)

    const fate = await resolveSpendAttemptFate(
      itemAttempt({ txid: undefined, status: 'failed' }),
      'main',
    )
    expect(fate).toMatchObject({
      kind: 'refuse',
      reason: 'sourceNotSpendable',
      mayClear: true,
    })
  })

  it('refuses clear of a signed 404 while inputs cannot be proven spent', async () => {
    mocks.txExistsOnChain.mockResolvedValue(false)
    mocks.isCollectableOutpointSpendable.mockResolvedValue(false)

    const fate = await resolveSpendAttemptFate(itemAttempt(), 'main')
    expect(fate).toMatchObject({
      kind: 'refuse',
      reason: 'sourceNotSpendable',
      mayClear: false,
    })
  })

  it('clears a signed send once every input is spent on chain', async () => {
    mocks.txExistsOnChain.mockResolvedValue(false)
    mocks.getProvenOrRawTx.mockResolvedValue({ rawTx: spendTxRaw() })
    mocks.spentStatusOfOutpoint.mockResolvedValue('spent')

    await expect(resolveSpendAttemptFate(itemAttempt(), 'main')).resolves.toMatchObject({
      kind: 'refuse',
      reason: 'inputsSpent',
      mayClear: true,
    })
    expect(mocks.isCollectableOutpointSpendable).not.toHaveBeenCalled()
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

  it('still allows clearing a legacy unsigned payment row with no saved recipient', async () => {
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

  it('lets a signed 404 payment be cleared when its inputs never left the wallet', async () => {
    mocks.txExistsOnChain.mockResolvedValue(false)
    mocks.getProvenOrRawTx.mockResolvedValue({ rawTx: spendTxRaw() })
    mocks.spentStatusOfOutpoint.mockResolvedValue('unspent')

    const fate = await resolveSpendAttemptFate(
      paymentAttempt({ txid: TX, at: Date.now() - 3 * 60_000 }),
      'main',
    )
    expect(fate).toMatchObject({
      kind: 'retry',
      action: 'reopenPayment',
      mayClear: true,
    })
  })

  it('history-only clears a signed payment once its inputs are spent', async () => {
    mocks.txExistsOnChain.mockResolvedValue(false)
    mocks.getProvenOrRawTx.mockResolvedValue({ rawTx: spendTxRaw() })
    mocks.spentStatusOfOutpoint.mockResolvedValue('spent')

    await expect(
      resolveSpendAttemptFate(paymentAttempt({ txid: TX, at: Date.now() - 3 * 60_000 }), 'main'),
    ).resolves.toMatchObject({
      kind: 'refuse',
      reason: 'inputsSpent',
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
  it('releases local spend reservations before removing an unsigned row', async () => {
    const order: string[] = []
    mocks.releaseUnsignedSpendReservations.mockImplementation(async () => {
      order.push('repair')
      return { failedTxs: 1, reviewLog: '', batchesAborted: 0 }
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

  it('still removes an unsigned row when the local repair throws', async () => {
    mocks.releaseUnsignedSpendReservations.mockRejectedValue(new Error('storage locked'))

    await expect(
      clearSpendAttempt(itemAttempt({ txid: undefined, status: 'failed' })),
    ).resolves.toEqual({
      removed: true,
    })
    expect(mocks.removeActivityById).toHaveBeenCalledWith('attempt')
  })

  it('clears a signed failed send whose inputs are still unspent when the tx never landed', async () => {
    mocks.txExistsOnChain.mockResolvedValue(false)
    mocks.getProvenOrRawTx.mockResolvedValue({ rawTx: spendTxRaw() })
    mocks.spentStatusOfOutpoint.mockResolvedValue('unspent')
    mocks.isCollectableOutpointSpendable.mockResolvedValue(true)

    await expect(clearSpendAttempt(itemAttempt({ status: 'failed' }))).resolves.toEqual({
      removed: true,
    })
    expect(mocks.releaseUnsignedSpendReservations).not.toHaveBeenCalled()
    expect(mocks.keepChangeOfSignedTx).not.toHaveBeenCalled()
    expect(mocks.removeActivityById).toHaveBeenCalledWith('attempt')
  })

  it('drops the history row of a signed send after its inputs are spent, without repair', async () => {
    mocks.txExistsOnChain.mockResolvedValue(false)
    mocks.getProvenOrRawTx.mockResolvedValue({ rawTx: spendTxRaw() })
    mocks.spentStatusOfOutpoint.mockResolvedValue('spent')

    await expect(clearSpendAttempt(itemAttempt({ status: 'failed' }))).resolves.toEqual({
      removed: true,
    })
    expect(mocks.releaseUnsignedSpendReservations).not.toHaveBeenCalled()
    expect(mocks.keepChangeOfSignedTx).toHaveBeenCalledWith(itemAttempt().txid)
    expect(mocks.hideSpentOutpoints).toHaveBeenCalled()
    expect(mocks.removeActivityById).toHaveBeenCalledWith('attempt')
  })
})

describe('clearAllFailedSpends', () => {
  it('repairs local reservations once, then drops unsigned failed rows', async () => {
    mocks.countFailedActivity.mockReturnValue(5)
    mocks.listFailedActivity.mockReturnValue([
      paymentAttempt({ id: 'u1' }),
      paymentAttempt({ id: 'u2' }),
      paymentAttempt({ id: 'u3' }),
      paymentAttempt({ id: 'u4' }),
      paymentAttempt({ id: 'u5' }),
    ])
    mocks.removeFailedActivity.mockReturnValue(5)

    await expect(clearAllFailedSpends()).resolves.toEqual({
      removed: 5,
      kept: 0,
    })
    expect(mocks.releaseUnsignedSpendReservations).toHaveBeenCalledTimes(1)
    expect(mocks.removeFailedActivity).toHaveBeenCalledTimes(1)
    expect(mocks.removeActivityById).not.toHaveBeenCalled()
  })

  it('clears the unsigned backlog even when the repair throws', async () => {
    mocks.releaseUnsignedSpendReservations.mockRejectedValue(new Error('storage locked'))
    mocks.countFailedActivity.mockReturnValue(3)
    mocks.listFailedActivity.mockReturnValue([
      paymentAttempt({ id: 'u1' }),
      paymentAttempt({ id: 'u2' }),
      paymentAttempt({ id: 'u3' }),
    ])
    mocks.removeFailedActivity.mockReturnValue(3)

    await expect(clearAllFailedSpends()).resolves.toEqual({
      removed: 3,
      kept: 0,
    })
  })

  it('keeps back rows the recipient can still broadcast, and reports them', async () => {
    mocks.countFailedActivity.mockReturnValue(4)
    mocks.listFailedActivity.mockReturnValue([
      paymentAttempt({ id: 'u1' }),
      paymentAttempt({ id: 'u2' }),
      paymentAttempt({ id: 'u3' }),
      itemAttempt({ id: 'item', status: 'failed' }),
    ])
    mocks.counterpartyMaySettle.mockImplementation(
      (outpoint: string) => outpoint === OUTPOINT,
    )
    mocks.removeFailedActivity.mockReturnValue(3)

    await expect(clearAllFailedSpends()).resolves.toEqual({
      removed: 3,
      kept: 1,
    })
    expect(mocks.removeFailedActivity).toHaveBeenCalledWith(expect.any(Function))
  })

  it('never reports a negative backlog when repair settles rows mid-clear', async () => {
    mocks.countFailedActivity.mockReturnValue(0)
    mocks.listFailedActivity.mockReturnValue([])
    mocks.removeFailedActivity.mockReturnValue(2)

    await expect(clearAllFailedSpends()).resolves.toEqual({
      removed: 2,
      kept: 0,
    })
    expect(mocks.releaseUnsignedSpendReservations).not.toHaveBeenCalled()
  })

  it('clears a signed failed send whose inputs are still unspent when the tx never landed', async () => {
    mocks.txExistsOnChain.mockResolvedValue(false)
    mocks.getProvenOrRawTx.mockResolvedValue({ rawTx: spendTxRaw() })
    mocks.spentStatusOfOutpoint.mockResolvedValue('unspent')
    mocks.countFailedActivity.mockReturnValue(1)
    mocks.listFailedActivity.mockReturnValue([
      paymentAttempt({ id: 'signed', txid: TX, at: Date.now() - 3 * 60_000 }),
    ])
    mocks.removeFailedActivity.mockReturnValue(1)

    await expect(clearAllFailedSpends()).resolves.toEqual({
      removed: 1,
      kept: 0,
    })
    expect(mocks.releaseUnsignedSpendReservations).not.toHaveBeenCalled()
  })
})

describe('rebroadcastAllFailedSpends', () => {
  beforeEach(() => {
    mocks.txExistsOnChain.mockResolvedValue(false)
    mocks.getProvenOrRawTx.mockResolvedValue({ rawTx: spendTxRaw() })
    mocks.spentStatusOfOutpoint.mockResolvedValue('unspent')
    mocks.isCollectableOutpointSpendable.mockResolvedValue(true)
    mocks.getBeefForTxidCached.mockResolvedValue({
      toBinaryAtomic: () => new Uint8Array([1, 2, 3]),
    })
    mocks.broadcastAtomicBeef.mockResolvedValue(true)
    mocks.counterpartyMaySettle.mockReturnValue(false)
  })

  it('rebroadcasts every signed item failure and skips unsigned coin sends', async () => {
    mocks.listFailedActivity.mockReturnValue([
      itemAttempt({ id: 'item', status: 'failed' }),
      paymentAttempt({ id: 'coin', status: 'failed' }),
    ])

    await expect(rebroadcastAllFailedSpends()).resolves.toEqual({
      rebroadcasted: 1,
      skipped: 1,
      failed: 0,
      errors: [],
    })
    expect(mocks.broadcastAtomicBeef).toHaveBeenCalledTimes(1)
  })

  it('counts only rebroadcastable signed failures', async () => {
    const liveOutpoint = `${'d'.repeat(64)}.0`
    mocks.listFailedActivity.mockReturnValue([
      itemAttempt({ id: 'item', status: 'failed' }),
      paymentAttempt({ id: 'coin', status: 'failed' }),
      itemAttempt({
        id: 'live',
        status: 'failed',
        item: { name: 'Fox', origin: liveOutpoint.replace('.', '_'), outpoint: liveOutpoint },
        retry: { kind: 'send-collectable', outpoint: liveOutpoint, toAddress: '1recipient' },
      }),
    ])
    mocks.counterpartyMaySettle.mockImplementation(
      (outpoint: string) => outpoint === liveOutpoint,
    )

    await expect(countRebroadcastableFailedSpends('main')).resolves.toBe(1)
  })
})
