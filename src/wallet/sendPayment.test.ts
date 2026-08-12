import { describe, expect, it, vi, beforeEach } from 'vitest'

type CreateActionArgs = { options?: { acceptDelayedBroadcast?: boolean } }

const createAction = vi.fn(async (_args: CreateActionArgs) => ({
  txid: 'a'.repeat(64),
  sendWithResults: [{ txid: 'a'.repeat(64), status: 'unproven' }],
}))
const prepareSpendHeal = vi.fn(async (_sats?: number) => 100_000)

vi.mock('./session', () => ({
  getActiveWallet: () => ({
    chain: 'main',
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
}))

const ADDRESS = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'

describe('sendSatsToAddress', () => {
  beforeEach(() => {
    createAction.mockClear()
  })

  it('uses delayed createAction and rejects failed sendWith results', async () => {
    // Undelayed mode throws WERR_REVIEW_ACTIONS on prior ghost doubleSpends
    // ("require review"). Delayed returns; we refuse success unless sendWith is clean.
    const { sendSatsToAddress } = await import('./sendPayment')
    await sendSatsToAddress({ to: ADDRESS, satoshis: 1_000 })

    expect(createAction).toHaveBeenCalledTimes(1)
    const args = createAction.mock.calls[0]?.[0]
    expect(args?.options?.acceptDelayedBroadcast).toBe(true)
  })
})
