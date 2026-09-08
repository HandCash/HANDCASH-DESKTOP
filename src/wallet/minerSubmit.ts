/**
 * Submit signed Atomic BEEF to miners after createAction.
 *
 * A signed tx is a spendable promise — UI success should not block on miner ACK.
 * Only hard missing-inputs / double-spend responses roll back the seal.
 */
import { Beef } from '@bsv/sdk'
import { getActiveWallet } from './session'
import {
  formatPostBeefFailure,
  summarizePostBeef,
  type PostBeefSummary,
  type PostBeefServiceResult,
} from './postBeefResult'
import {
  onAlreadySpentSend,
  releaseSealedInputsOfUnsentTx,
  restoreOnChainLocalTx,
} from './staleOutputRelease'
import {
  postBeefResultsHitArcade,
  rememberArcadeSubmitContact,
  signedTxSpendConflictIsProven,
  txHadArcadeSubmitContact,
} from './arcadeSubmitGuard'
import {
  enqueuePendingMinerSubmit,
  removePendingMinerSubmit,
} from './pendingMinerOutbox'
import {
  activeTransactionTrace,
  recordTransactionStage,
  type TransactionFlow,
} from './transactionTelemetry'

export type MinerSubmitResult = {
  /** At least one miner reported mempool accept / already-known. */
  confirmed: boolean
  /** Signed tx was handed to miners (or transport failed after hand-off). */
  submitted: boolean
  summary?: PostBeefSummary
}

function isInvalidBeefTransport(msg: string): boolean {
  return /4022206465|4022206466|beef|mergeRawTx|invalid/i.test(msg)
}

/**
 * Hand signed BEEF to miners. Returns optimistic `submitted` on transport silence.
 * Throws only on invalid BEEF body or provable missing-inputs / double-spend.
 */
export async function submitAtomicBeefToMiners(
  txid: string,
  atomic: number[],
  opts?: {
    fromOutbox?: boolean
    traceId?: string
    requestId?: string
    flow?: TransactionFlow
    retryCount?: number
  },
): Promise<MinerSubmitResult> {
  const id = txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id) || !atomic.length) {
    throw new Error(
      'Payment was signed but no transaction body was returned — try Send again.',
    )
  }
  if (!opts?.fromOutbox) enqueuePendingMinerSubmit(id, atomic)
  const trace = activeTransactionTrace()
  const telemetry = {
    traceId: opts?.traceId ?? trace?.traceId,
    requestId: opts?.requestId ?? trace?.requestId,
    flow: opts?.flow ?? trace?.flow,
    retryCount: opts?.retryCount,
    txid: id,
  }
  recordTransactionStage('provider_attempt', telemetry)
  const active = getActiveWallet()
  if (!active?.services?.postBeef) {
    console.info('[minerSubmit] offline — treating signed tx as submitted', id.slice(0, 12))
    recordTransactionStage('propagation_queued', {
      ...telemetry,
      blockerCode: 'provider_offline',
    })
    return { confirmed: false, submitted: true }
  }

  let summary: PostBeefSummary | undefined
  let rawResults: PostBeefServiceResult[] | undefined
  try {
    const results = await active.services.postBeef(Beef.fromBinary(atomic), [id])
    rawResults = results as PostBeefServiceResult[]
    summary = summarizePostBeef(rawResults)
    if (postBeefResultsHitArcade(rawResults)) {
      rememberArcadeSubmitContact(id)
      console.info('[minerSubmit] Arcade contacted — tx pinned', id.slice(0, 12))
      // Item/BRC-29 `noSend` rows stay `unsent` until processAction. Promote so
      // heal cannot reclaim sealed inputs while explorers lag.
      await restoreOnChainLocalTx(id)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[minerSubmit] postBeef transport failed — treating as submitted', id.slice(0, 12), msg)
    if (isInvalidBeefTransport(msg)) {
      removePendingMinerSubmit(id)
      recordTransactionStage('hard_rejected', {
        ...telemetry,
        blockerCode: 'invalid_beef',
      })
      await releaseSealedInputsOfUnsentTx(id, atomic)
      throw new Error(
        'Payment was signed but the transaction body is invalid — try Send again.',
      )
    }
    recordTransactionStage('propagation_queued', {
      ...telemetry,
      blockerCode: 'provider_transport',
    })
    return { confirmed: false, submitted: true }
  }

  if (summary.accepted) {
    removePendingMinerSubmit(id)
    recordTransactionStage('provider_accepted', telemetry)
    if (
      telemetry.flow !== 'brc29' &&
      telemetry.flow !== 'item_transfer' &&
      telemetry.flow !== 'token_transfer'
    ) {
      recordTransactionStage('completed', telemetry)
    }
    if (!txHadArcadeSubmitContact(id)) await restoreOnChainLocalTx(id)
    return { confirmed: true, submitted: true, summary }
  }
  // Pure transport / endpoint failures are not proof of a spent input.
  if (summary.serviceOnlyErrors) {
    console.info(
      '[minerSubmit] no miner ack — signed tx treated as submitted',
      id.slice(0, 12),
      summary.detail,
    )
    recordTransactionStage('propagation_queued', {
      ...telemetry,
      blockerCode: 'provider_service_error',
    })
    return { confirmed: false, submitted: true, summary }
  }
  if (summary.missingInputs || summary.doubleSpend) {
    const conflictReal = await (async () => {
      if (txHadArcadeSubmitContact(id)) {
        return signedTxSpendConflictIsProven({
          txid: id,
          atomic,
          chain: active.chain,
        })
      }
      const { postBeefConflictIsReal } = await import('./postBeefResult')
      return postBeefConflictIsReal({
        txid: id,
        atomic,
        chain: active.chain,
      })
    })()
    if (!conflictReal) {
      if (txHadArcadeSubmitContact(id)) {
        console.info(
          `[minerSubmit] ghost ${summary.missingInputs ? 'missing-inputs' : 'doubleSpend'} — Arcade pin holds seal`,
          id.slice(0, 12),
          summary.detail,
        )
        return { confirmed: false, submitted: true, summary }
      }
      console.info(
        `[minerSubmit] ghost ${summary.missingInputs ? 'missing-inputs' : 'doubleSpend'} — releasing seal`,
        id.slice(0, 12),
        summary.detail,
      )
      await releaseSealedInputsOfUnsentTx(id, atomic)
      // Still "submitted" for optimistic send UX; callers that need a hard ACK
      // (consolidate) must check confirmed / catch their own release.
      return { confirmed: false, submitted: true, summary }
    }

    // Proven conflict — but only hide if OUR tx actually landed. Otherwise
    // miner noise emptied a phone wallet (119 sealed → spendable=0).
    const { txExistsOnChain } = await import('./legacyScan')
    const onChain = await txExistsOnChain(id, active.chain).catch(() => null)
    if (onChain === true) {
      removePendingMinerSubmit(id)
      recordTransactionStage('hard_rejected', {
        ...telemetry,
        blockerCode: summary.doubleSpend
          ? 'provider_double_spend'
          : 'provider_missing_inputs',
      })
      console.warn('[minerSubmit] hard reject — tx on chain, sealing inputs', id.slice(0, 12), summary.detail)
      await onAlreadySpentSend({ txid: id, atomic })
      throw new Error(formatPostBeefFailure(summary))
    }
    removePendingMinerSubmit(id)
    recordTransactionStage('hard_rejected', {
      ...telemetry,
      blockerCode: summary.doubleSpend
        ? 'provider_double_spend'
        : 'provider_missing_inputs',
    })
    console.warn(
      '[minerSubmit] hard reject — releasing seal (tx not on chain)',
      id.slice(0, 12),
      summary.detail,
    )
    await releaseSealedInputsOfUnsentTx(id, atomic)
    throw new Error(formatPostBeefFailure(summary))
  }

  console.info(
    '[minerSubmit] no miner ack — signed tx treated as submitted',
    id.slice(0, 12),
    summary.detail,
  )
  recordTransactionStage('propagation_queued', {
    ...telemetry,
    blockerCode: 'provider_no_ack',
  })
  return { confirmed: false, submitted: true, summary }
}

/** Surface a hard miner reject after optimistic send success. */
export async function reportLateMinerSubmitFailure(args: {
  pendingId?: string
  txid?: string
  reason: unknown
}): Promise<void> {
  const txid = args.txid?.trim().toLowerCase()
  if (txid && txHadArcadeSubmitContact(txid)) {
    const active = getActiveWallet()
    if (active) {
      const proven = await signedTxSpendConflictIsProven({
        txid,
        chain: active.chain,
      })
      if (!proven) {
        console.info(
          '[minerSubmit] late failure ignored — Arcade submit still in flight',
          txid.slice(0, 12),
        )
        return
      }
    }
  }
  const { noteOutboundSendBroadcastFailed, compactFailureLabel } = await import(
    './appActivity'
  )
  const { toastError } = await import('./toast')
  if (txid) {
    const { getTxByTxid, markTxFailed } = await import('./txStore')
    const record = getTxByTxid(txid)
    if (record && record.status !== 'FAILED_REJECTED') {
      markTxFailed(record.id, 'ARC_REJECTED', compactFailureLabel(args.reason))
    }
  }
  if (!noteOutboundSendBroadcastFailed(args)) return
  const label = compactFailureLabel(args.reason)
  toastError('Send issue', label)
}
