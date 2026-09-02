import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  formatReviewActionsError,
  isReservedActionBatchError,
  isReviewActionsError,
  releaseUnsignedSpendReservations,
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

const findExpiredActionBatches = vi.fn(async () => [])
const abortActionBatch = vi.fn(async () => ({ aborted: true }))
const findProvenTxReqs = vi.fn(async () => [])
const updateProvenTxReq = vi.fn(async () => {})
const txExistsOnChain = vi.fn(async () => null as boolean | null)

const {
  abortAction,
  listNoSendActions,
} = vi.hoisted(() => ({
  abortAction: vi.fn(async () => ({ aborted: true })),
  listNoSendActions: vi.fn(async (_args?: unknown, abort = false) => ({
    totalActions: abort ? 0 : 2,
    actions: abort
      ? []
      : [{ reference: 'keep-me' }, { reference: 'stale' }],
  })),
}))

vi.mock('./session', () => ({
  getActiveWallet: () => ({
    chain: 'main',
    wallet: {
      listNoSendActions,
      abortAction,
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
            findExpiredActionBatches,
            findProvenTxReqs,
            updateProvenTxReq,
          }),
        abortActionBatch,
      },
    },
  }),
}))

vi.mock('./marketSettlement', () => ({
  protectedMarketActionReferences: () => new Set(['keep-me']),
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

vi.mock('./legacyScan', () => ({
  txExistsOnChain: (...args: unknown[]) => txExistsOnChain(...args),
}))
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

  it('formats doubleSpend as already spent', () => {
    expect(
      formatReviewActionsError({
        reviewActionResults: [{ status: 'doubleSpend', competingTxs: ['aa'] }],
        sendWithResults: [{ status: 'failed' }],
      }),
    ).toBe('Already spent')
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
    expect(message).toBe('Missing script')
    expect(message).not.toMatch(/already spent/i)
  })

  it('still reports a real double-spend as already spent', () => {
    expect(
      formatReviewActionsError(
        Object.assign(new Error('review required'), {
          reviewActionResults: [{ status: 'doubleSpend' }],
        }),
      ),
    ).toBe('Already spent')
  })

  it('releaseUnsignedSpendReservations fails abandoned txs and reviews status without sweeping', async () => {
    findProvenTxReqs.mockResolvedValueOnce([])
    const r = await releaseUnsignedSpendReservations()
    expect(r.failedTxs).toBe(1)
    expect(updateTransactionStatus).toHaveBeenCalledWith('failed', 7)
    expect(reviewStatus).toHaveBeenCalled()
    expect(sweepChangeScripts).not.toHaveBeenCalled()
  })

  it('clears ghost doubleSpend reqs when the tx never reached the chain', async () => {
    const txid = 'cc'.repeat(32)
    findProvenTxReqs.mockResolvedValueOnce([{ provenTxReqId: 285, txid, status: 'doubleSpend' }])
    txExistsOnChain.mockResolvedValueOnce(false)
    const { releaseGhostDoubleSpendReqs } = await import('./actionReview')
    await expect(releaseGhostDoubleSpendReqs()).resolves.toBe(1)
    expect(updateProvenTxReq).toHaveBeenCalledWith([285], { status: 'invalid' })
  })

  it('repairFailedSpendState includes change-script sweep', async () => {
    const r = await repairFailedSpendState()
    expect(r.failedTxs).toBe(1)
    expect(r.quarantined).toBe(1)
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

  it('does not abort a live market nosend reference', async () => {
    abortAction.mockClear()
    listNoSendActions.mockClear()
    const { releaseStuckNosends } = await import('./actionReview')
    await releaseStuckNosends()
    expect(listNoSendActions).toHaveBeenCalledWith({ labels: [], limit: 100 }, false)
    expect(abortAction).toHaveBeenCalledWith({ reference: 'stale' })
    expect(abortAction).not.toHaveBeenCalledWith({ reference: 'keep-me' })
  })
})
