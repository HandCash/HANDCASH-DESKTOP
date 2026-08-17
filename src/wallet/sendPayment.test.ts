import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Beef } from '@bsv/sdk'

type CreateActionArgs = { options?: { acceptDelayedBroadcast?: boolean } }

const createAction = vi.fn(async (_args: CreateActionArgs) => ({
  txid: 'a'.repeat(64),
  tx: [1, 2, 3],
  sendWithResults: [{ txid: 'a'.repeat(64), status: 'unproven' }],
}))
const prepareSpendHeal = vi.fn(async (_sats?: number) => 100_000)
const postBeef = vi.fn(async () => [
  { status: 'success', txidResults: [{ status: 'success' }] },
])

const durable = new Map<string, string>()
vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => durable.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    durable.set(key, value)
    return true
  },
}))

vi.mock('./session', () => ({
  getActiveWallet: () => ({
    chain: 'main',
    services: { postBeef },
    wallet: { createAction: (args: CreateActionArgs) => createAction(args) },
  }),
  fetchBalanceSats: async () => 90_000,
}))

vi.mock('./spendGuard', () => ({
  runExclusiveSpend: <T>(fn: () => Promise<T>) => fn(),
  prepareSpendHeal: (sats?: number) => prepareSpendHeal(sats),
  assertSendableBalance: async () => 100_000,
  refreshSpendableBalance: async () => 100_000,
}))

vi.mock('./paymentPolicy', () => ({ assertOnlineForPayment: () => {} }))
vi.mock('./deviceSync', () => ({ scheduleHistoryBackupPush: () => {} }))
vi.mock('./appActivity', () => ({
  hasActivityTxid: () => false,
  hasSettledActivityTxid: () => false,
  recordAppActivity: () => {},
  upsertAppActivity: () => {},
  noteInboundReceivePending: () => {},
  noteInboundReceiveComplete: () => {},
  noteOutboundSendPending: () => {},
  noteOutboundSendComplete: () => {},
  clearOutboundSendPending: () => {},
  failOutboundSendPending: () => {},
  WALLET_ACTIVITY_ORIGIN: 'wallet',
  extractSatsFromArgs: () => 0,
}))
vi.mock('./pendingSend', () => ({
  beginPendingSend: () => ({ id: 'p1' }),
  completePendingSend: () => {},
  clearPendingSend: () => {},
}))
vi.mock('./staleOutputRelease', () => ({
  isAlreadySpentInputError: () => false,
  releaseStaleSpendableOutputs: async () => {},
  releaseThenRestoreStaleOutputs: async () => {},
  restoreLiveSpendableOutputs: async () => 0,
  sealLocalSpendChange: async () => {},
}))
vi.mock('./friends', () => ({
  resolvePaymentRecipient: async (to: string) => to,
}))
vi.mock('./actionReview', () => ({
  releaseStuckNosends: async () => {},
  sendWithHasFailure: () => false,
  isReviewActionsError: () => false,
  isIteratorCrashError: () => false,
  formatReviewActionsError: () => 'review',
  recoverFromReviewActions: async () => {},
}))
vi.mock('./spvFinality', () => ({
  verifyBumpFinality: async () => ({ ok: false, reason: 'unknown' }),
}))

const ADDRESS = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'

describe('sendSatsToAddress', () => {
  beforeEach(() => {
    durable.clear()
    createAction.mockClear()
    postBeef.mockClear()
    vi.spyOn(Beef, 'fromBinary').mockReturnValue(new Beef())
  })

  it('uses delayed createAction and confirms with postBeef before success', async () => {
    // Undelayed mode throws WERR_REVIEW_ACTIONS on prior ghost doubleSpends
    // ("require review"). Delayed returns; we refuse success unless sendWith is clean
    // and postBeef accepts the signed tx.
    const { sendSatsToAddress } = await import('./sendPayment')
    await sendSatsToAddress({ to: ADDRESS, satoshis: 1_000 })

    expect(createAction).toHaveBeenCalledTimes(1)
    const args = createAction.mock.calls[0]?.[0]
    expect(args?.options?.acceptDelayedBroadcast).toBe(true)
    expect(postBeef).toHaveBeenCalled()
  })
})
