import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  formatReviewActionsError,
  isReservedActionBatchError,
  isReviewActionsError,
  repairFailedSpendState,
  sendWithHasFailure,
} from './actionReview'

const updateTransactionStatus = vi.fn(async () => {})
const reviewStatus = vi.fn(async () => ({ log: 'ok' }))
const validateOutputScript = vi.fn(async () => {})
const updateOutput = vi.fn(async () => {})
const findTransactions = vi.fn(async () => [
  { transactionId: 7, status: 'unsigned' },
])
const findOutputs = vi.fn(async () => [
  { outputId: 11, change: true, spendable: true, lockingScript: undefined },
  { outputId: 12, change: true, spendable: true, lockingScript: '76a914' },
])

vi.mock('./session', () => ({
  getActiveWallet: () => ({
    chain: 'main',
    wallet: {
      listNoSendActions: async () => ({ totalActions: 0, actions: [] }),
      actionBatch: { abort: async () => false },
      storage: {
        runAsStorageProvider: async <T>(fn: (sp: unknown) => Promise<T>) =>
          fn({
            findTransactions,
            updateTransactionStatus,
            reviewStatus,
            findOutputs,
            validateOutputScript,
            updateOutput,
          }),
      },
    },
  }),
}))

const sweepChangeScripts = vi.fn(async (_args?: unknown) => ({
  scanned: 2,
  healed: 0,
  quarantined: 1,
  refused: 1,
}))
vi.mock('./changeScriptFate', () => ({
  sweepChangeScripts: (args?: unknown) => sweepChangeScripts(args),
}))

vi.mock('./legacyScan', () => ({ txExistsOnChain: async () => null }))
vi.mock('./sentItemGuard', () => ({ healGhostSentItems: async () => [] }))
vi.mock('./oneSatImportGuard', () => ({ forgetOneSatImported: () => {} }))

describe('actionReview', () => {
  beforeEach(() => {
    updateTransactionStatus.mockClear()
    reviewStatus.mockClear()
    validateOutputScript.mockClear()
    updateOutput.mockClear()
    findTransactions.mockClear()
    findOutputs.mockClear()
  })

  it('detects leftover action-batch reservations', () => {
    expect(
      isReservedActionBatchError(
        new Error(
          'The inputs parameter must be outputs not reserved by an active action batch',
        ),
      ),
    ).toBe(true)
    expect(isReservedActionBatchError(new Error('network down'))).toBe(false)
  })

  it('detects WERR_REVIEW_ACTIONS by name and shape', () => {
    expect(
      isReviewActionsError({
        name: 'WERR_REVIEW_ACTIONS',
        message: 'Undelayed createAction or signAction results require review.',
        reviewActionResults: [{ status: 'doubleSpend' }],
      }),
    ).toBe(true)
    expect(isReviewActionsError(new Error('network down'))).toBe(false)
  })

  it('formats doubleSpend as a retry hint', () => {
    expect(
      formatReviewActionsError({
        reviewActionResults: [{ status: 'doubleSpend', competingTxs: ['aa'] }],
        sendWithResults: [{ status: 'failed' }],
      }),
    ).toMatch(/previous failed send/i)
  })

  it('flags failed sendWith rows', () => {
    expect(sendWithHasFailure([{ status: 'unproven' }])).toBe(false)
    expect(sendWithHasFailure([{ status: 'doubleSpend' }])).toBe(true)
    expect(sendWithHasFailure([])).toBe(false)
  })

  it('names a missing locking script instead of blaming a previous send', () => {
    const message = formatReviewActionsError(
      new Error('undefined is not iterable (cannot read property Symbol(Symbol.iterator))'),
    )
    expect(message).toMatch(/locking script/i)
    expect(message).not.toMatch(/previous failed send/i)
  })

  it('still reports a real double-spend as a blocking previous send', () => {
    expect(
      formatReviewActionsError(
        Object.assign(new Error('review required'), {
          reviewActionResults: [{ status: 'doubleSpend' }],
        }),
      ),
    ).toMatch(/previous failed send/i)
  })

  it('repairFailedSpendState fails abandoned txs, reviews status, sweeps change scripts', async () => {
    const r = await repairFailedSpendState()
    expect(r.failedTxs).toBe(1)
    expect(updateTransactionStatus).toHaveBeenCalledWith('failed', 7)
    expect(reviewStatus).toHaveBeenCalled()
    expect(r.quarantined).toBe(1    )
    expect(sweepChangeScripts).toHaveBeenCalled()
  })

  it('releaseStuckNosends does not sweep change or reviewStatus on the send button', async () => {
    const { releaseStuckNosends } = await import('./actionReview')
    sweepChangeScripts.mockClear()
    reviewStatus.mockClear()
    await releaseStuckNosends()
    expect(sweepChangeScripts).not.toHaveBeenCalled()
    expect(reviewStatus).not.toHaveBeenCalled()
  })
})
