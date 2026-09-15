/**
 * Submit signed Atomic BEEF to miners after createAction.
 *
 * A signed tx is a spendable promise — UI success should not block on miner ACK.
 * Only hard missing-inputs / double-spend responses roll back the seal.
 */
import { Beef } from '@bsv/sdk'
import { getActiveWallet, type ActiveWallet } from './session'
import {
  formatPostBeefFailure,
  isInvalidBeefTransport,
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
  postBeefResultsArcadeAccepted,
  postBeefResultsArcadeHardReject,
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
import { normalizeTxid } from './txid'

export type MinerSubmitResult = {
  /** At least one miner reported mempool accept / already-known. */
  confirmed: boolean
  /** Signed tx was handed to miners (or transport failed after hand-off). */
  submitted: boolean
  summary?: PostBeefSummary
}

type SubmitTelemetry = {
  traceId?: string
  requestId?: string
  flow?: TransactionFlow
  retryCount?: number
  txid: string
}

type ArcadeHardRejectError = Error & { code: 'ARCADE_HARD_REJECT' }

function arcadeHardRejectError(summary: PostBeefSummary): ArcadeHardRejectError {
  const hard = new Error(formatPostBeefFailure(summary)) as ArcadeHardRejectError
  hard.code = 'ARCADE_HARD_REJECT'
  return hard
}

type AncestryIncompleteError = Error & { code: 'BEEF_ANCESTRY_INCOMPLETE' }

function ancestryIncompleteError(summary: PostBeefSummary): AncestryIncompleteError {
  const err = new Error(
    formatPostBeefFailure(summary, { ancestryIncomplete: true }),
  ) as AncestryIncompleteError
  err.code = 'BEEF_ANCESTRY_INCOMPLETE'
  return err
}

/**
 * MissingInputs on a BEEF we could not complete is a delivery defect, not proof
 * that an input left the wallet. Fail closed on the real reason so the tip stays
 * spendable and the caller can retry once the parent lands.
 */
async function failIfAncestryIncomplete(args: {
  id: string
  atomic: number[]
  active: ActiveWallet
  summary: PostBeefSummary
  telemetry: SubmitTelemetry
  ancestryComplete: boolean
}): Promise<void> {
  const { id, atomic, active, summary, telemetry } = args
  if (args.ancestryComplete || !summary.missingInputs) return
  if (await signedTxSpendConflictIsProven({ txid: id, atomic, chain: active.chain })) {
    return
  }
  console.warn(
    '[minerSubmit] MissingInputs on incomplete BEEF — no input proven spent',
    id.slice(0, 12),
    summary.detail,
  )
  removePendingMinerSubmit(id)
  recordTransactionStage('hard_rejected', {
    ...telemetry,
    blockerCode: 'beef_ancestry_incomplete',
  })
  await rememberGhostTxQuiet(id)
  await releaseSealedInputsOfUnsentTx(id, atomic)
  throw ancestryIncompleteError(summary)
}

async function rememberGhostTxQuiet(txid: string): Promise<void> {
  try {
    const { rememberGhostTx } = await import('./ghostTxSuppress')
    rememberGhostTx(txid)
  } catch {
    /* optional */
  }
}

async function dropLocalSpendForArcadeReject(
  id: string,
  atomic: number[],
  telemetry: SubmitTelemetry,
  summary: PostBeefSummary,
): Promise<never> {
  console.warn(
    '[minerSubmit] Arcade hard-reject — dropping local spend',
    id.slice(0, 12),
    summary.detail,
  )
  removePendingMinerSubmit(id)
  recordTransactionStage('hard_rejected', {
    ...telemetry,
    blockerCode: summary.missingInputs ? 'arcade_missing_inputs' : 'arcade_reject',
  })
  await rememberGhostTxQuiet(id)
  await releaseSealedInputsOfUnsentTx(id, atomic)
  throw arcadeHardRejectError(summary)
}

async function applyArcadePostBeef(
  id: string,
  atomic: number[],
  rawResults: PostBeefServiceResult[],
  summary: PostBeefSummary,
  telemetry: SubmitTelemetry,
  active: ActiveWallet,
  ancestryComplete: boolean,
): Promise<PostBeefSummary> {
  const arcadeOk = postBeefResultsArcadeAccepted(rawResults)
  const arcadeHardReject = postBeefResultsArcadeHardReject(rawResults)
  // Pin ONLY on Arcade success — pinning on mere contact made missing-inputs
  // holds keep phantom pendingChange after an invalid-UTXO reject.
  if (arcadeOk) {
    rememberArcadeSubmitContact(id)
    console.info('[minerSubmit] Arcade accepted — tx pinned', id.slice(0, 12))
    void restoreOnChainLocalTx(id).catch((err) => {
      console.warn('[minerSubmit] post-Arcade restore skipped', id.slice(0, 12), err)
    })
    return summary.accepted ? summary : { ...summary, accepted: true }
  }
  if (arcadeHardReject) {
    await failIfAncestryIncomplete({
      id,
      atomic,
      active,
      summary,
      telemetry,
      ancestryComplete,
    })
    await dropLocalSpendForArcadeReject(id, atomic, telemetry, summary)
  }
  if (postBeefResultsHitArcade(rawResults)) {
    console.info('[minerSubmit] Arcade contacted (no accept/reject yet)', id.slice(0, 12))
  }
  return summary
}

async function resolveMinerConflict(args: {
  id: string
  atomic: number[]
  active: ActiveWallet
  summary: PostBeefSummary
  telemetry: SubmitTelemetry
}): Promise<MinerSubmitResult> {
  const { id, atomic, active, summary, telemetry } = args
  const arcadePinned = txHadArcadeSubmitContact(id)
  const conflictReal = arcadePinned
    ? await signedTxSpendConflictIsProven({
        txid: id,
        atomic,
        chain: active.chain,
      })
    : await (await import('./postBeefResult')).postBeefConflictIsReal({
        txid: id,
        atomic,
        chain: active.chain,
      })

  if (!conflictReal) {
    if (arcadePinned) {
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
  removePendingMinerSubmit(id)
  recordTransactionStage('hard_rejected', {
    ...telemetry,
    blockerCode: summary.doubleSpend ? 'provider_double_spend' : 'provider_missing_inputs',
  })
  if (onChain === true) {
    console.warn('[minerSubmit] hard reject — tx on chain, sealing inputs', id.slice(0, 12), summary.detail)
    await onAlreadySpentSend({ txid: id, atomic })
    throw new Error(formatPostBeefFailure(summary))
  }
  console.warn(
    '[minerSubmit] hard reject — releasing seal (tx not on chain)',
    id.slice(0, 12),
    summary.detail,
  )
  await releaseSealedInputsOfUnsentTx(id, atomic)
  throw new Error(formatPostBeefFailure(summary))
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
  const id = normalizeTxid(txid)
  if (!id || !atomic.length) {
    throw new Error(
      'Payment was signed but no transaction body was returned — try Send again.',
    )
  }
  if (!opts?.fromOutbox) enqueuePendingMinerSubmit(id, atomic)
  const trace = activeTransactionTrace()
  const telemetry: SubmitTelemetry = {
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

  let beefBytes = atomic
  // Miners answer MissingInputs both for a spent input and for a BEEF whose
  // ancestry we failed to supply. Settle which one we are looking at before
  // posting: an already-complete BEEF costs nothing, and an incomplete one must
  // be hydrated properly rather than posted to earn a guaranteed false verdict.
  let ancestryComplete = false
  try {
    const { classifyBeefAncestryGap, hydrateInputBeef } = await import('./beefCache')
    const gap = classifyBeefAncestryGap(atomic)
    if (gap === 'none') {
      ancestryComplete = true
    } else if (gap === 'unconfirmed-parents') {
      // A proof for a parent we just broadcast cannot exist yet. Post now and let
      // BEEF-aware services take the chain — do not spend fetch timeouts on it.
      console.info(
        '[minerSubmit] unconfirmed parent in BEEF — posting without hydrate',
        id.slice(0, 12),
      )
    } else {
      const shaped = await Promise.race([
        hydrateInputBeef(active, Beef.fromBinary(atomic)),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 8_000)),
      ])
      if (shaped?.length) {
        beefBytes = shaped
        ancestryComplete = true
      } else {
        console.warn(
          '[minerSubmit] posting with incomplete ancestry — MissingInputs will not count as spent',
          id.slice(0, 12),
        )
      }
    }
  } catch (err) {
    console.warn('[minerSubmit] ancestor hydrate skipped', id.slice(0, 12), err)
  }

  let summary: PostBeefSummary
  let rawResults: PostBeefServiceResult[] | undefined
  try {
    const results = await active.services.postBeef(Beef.fromBinary(beefBytes), [id])
    rawResults = results as PostBeefServiceResult[]
    summary = summarizePostBeef(rawResults)
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

  if (rawResults) {
    summary = await applyArcadePostBeef(
      id,
      atomic,
      rawResults,
      summary,
      telemetry,
      active,
      ancestryComplete,
    )
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
    if (!txHadArcadeSubmitContact(id)) {
      void restoreOnChainLocalTx(id).catch(() => {
        /* background */
      })
    }
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
    await failIfAncestryIncomplete({
      id,
      atomic,
      active,
      summary,
      telemetry,
      ancestryComplete,
    })
    return resolveMinerConflict({ id, atomic, active, summary, telemetry })
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
  const txid = normalizeTxid(args.txid)
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
