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
} from './staleOutputRelease'
import {
  postBeefResultsHitArcade,
  rememberArcadeSubmitContact,
  signedTxSpendConflictIsProven,
  txHadArcadeSubmitContact,
} from './arcadeSubmitGuard'

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
): Promise<MinerSubmitResult> {
  const id = txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id) || !atomic.length) {
    throw new Error(
      'Payment was signed but no transaction body was returned — try Send again.',
    )
  }
  const active = getActiveWallet()
  if (!active?.services?.postBeef) {
    console.info('[minerSubmit] offline — treating signed tx as submitted', id.slice(0, 12))
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
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[minerSubmit] postBeef transport failed — treating as submitted', id.slice(0, 12), msg)
    if (isInvalidBeefTransport(msg)) {
      await releaseSealedInputsOfUnsentTx(id, atomic)
      throw new Error(
        'Payment was signed but the transaction body is invalid — try Send again.',
      )
    }
    return { confirmed: false, submitted: true }
  }

  if (summary.accepted) {
    return { confirmed: true, submitted: true, summary }
  }
  // Pure transport / endpoint failures are not proof of a spent input.
  if (summary.serviceOnlyErrors) {
    console.info(
      '[minerSubmit] no miner ack — signed tx treated as submitted',
      id.slice(0, 12),
      summary.detail,
    )
    return { confirmed: false, submitted: true, summary }
  }
  if (summary.missingInputs) {
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
      console.info(
        '[minerSubmit] ghost missing-inputs — releasing seal, treating as submitted',
        id.slice(0, 12),
        summary.detail,
      )
      // Do not hide inputs: the signed body may still land. Keep seal only when
      // we are optimistic; release when explorers prove the tx never spent them.
      // Here conflict is unproven after hard reject noise — keep submitted so
      // callers can retry broadcast, but do not call onAlreadySpentSend.
      return { confirmed: false, submitted: true, summary }
    }
    console.warn('[minerSubmit] hard reject', id.slice(0, 12), summary.detail)
    await onAlreadySpentSend({ txid: id, atomic })
    throw new Error(formatPostBeefFailure(summary))
  }
  if (summary.doubleSpend) {
    const { postBeefConflictIsReal } = await import('./postBeefResult')
    const conflictReal = txHadArcadeSubmitContact(id)
      ? await signedTxSpendConflictIsProven({
          txid: id,
          atomic,
          chain: active.chain,
        })
      : await postBeefConflictIsReal({
          txid: id,
          atomic,
          chain: active.chain,
        })
    if (!conflictReal) {
      console.info(
        '[minerSubmit] ghost doubleSpend — signed tx treated as submitted',
        id.slice(0, 12),
        summary.detail,
      )
      return { confirmed: false, submitted: true, summary }
    }
    console.warn('[minerSubmit] hard reject', id.slice(0, 12), summary.detail)
    await onAlreadySpentSend({ txid: id, atomic })
    throw new Error(formatPostBeefFailure(summary))
  }

  console.info(
    '[minerSubmit] no miner ack — signed tx treated as submitted',
    id.slice(0, 12),
    summary.detail,
  )
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
  if (!noteOutboundSendBroadcastFailed(args)) return
  const label = compactFailureLabel(args.reason)
  toastError('Send issue', label)
}
