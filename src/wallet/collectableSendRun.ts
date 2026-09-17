/**
 * Bulk item send: one selection becomes a sequence of atomic transactions.
 *
 * `sendCollectables` is atomic and capped at `MAX_ITEMS_PER_ONE_SAT_TX` — every
 * extra input is another sighash to sign and another BEEF ancestor to carry, so
 * a 700-item selection cannot be one transaction. A run splits the selection
 * into legs of that size and sends them in order.
 *
 * Two things make the loop reliable rather than 28 chances to lose the wallet:
 *
 * 1. **A leg is still atomic.** Each leg either signs completely or transfers
 *    nothing, so a partial run is a set of whole transactions, never a
 *    half-moved leg.
 * 2. **Failure is classified, never retried blindly.** A wallet-wide fault
 *    (locked, offline, out of fee money) stops the run at the current leg — the
 *    remaining legs would fail the same way. A leg-specific rejection halves
 *    the leg and retries down to singles (the migrate-bundle rule), so one
 *    unspendable tip cannot strand the other 699.
 *
 * The plan is a value, so the caller can say how many transactions a selection
 * costs before anyone signs anything.
 */
import {
  MAX_ITEMS_PER_ONE_SAT_TX,
  normalizeCollectableBatchOutpoints,
} from './collectableBatch'

/** One transaction's worth of tips within a run. */
export type CollectableSendLeg = {
  /** 1-based position, for "transaction 3 of 28" progress. */
  index: number
  outpoints: string[]
}

export type CollectableSendRunPlan =
  | { kind: 'refuse'; reason: 'empty' }
  /** One leg means one ordinary atomic send; several means a run. */
  | { kind: 'legs'; legs: CollectableSendLeg[]; itemCount: number }

/** Split a selection into atomic legs, preserving selection order. */
export function planCollectableSendRun(
  outpoints: string[],
  perTx = MAX_ITEMS_PER_ONE_SAT_TX,
): CollectableSendRunPlan {
  const normalized = normalizeCollectableBatchOutpoints(outpoints)
  if (normalized.length === 0) return { kind: 'refuse', reason: 'empty' }
  const size = Math.max(1, Math.min(Math.floor(perTx), MAX_ITEMS_PER_ONE_SAT_TX))
  const legs: CollectableSendLeg[] = []
  for (let at = 0; at < normalized.length; at += size) {
    legs.push({ index: legs.length + 1, outpoints: normalized.slice(at, at + size) })
  }
  return { kind: 'legs', legs, itemCount: normalized.length }
}

/**
 * Does this failure belong to the wallet or to the leg?
 *
 * `wallet` stops the run: no amount of splitting funds an unfunded wallet or
 * unlocks a locked one. `leg` is worth halving, because the rejection is about
 * one of the tips we cannot name from the error alone.
 */
export type SendRunFailureScope = 'wallet' | 'leg'

const WALLET_WIDE_FAILURES = [
  'wallet locked',
  'wallet is locked',
  'no wallet',
  'offline',
  'no network',
  'not enough',
  'insufficient',
  'invalid recipient',
  'select at least one',
  'cancelled',
  'canceled',
]

export function classifySendRunFailure(reason: unknown): SendRunFailureScope {
  const message = (reason instanceof Error ? reason.message : String(reason ?? ''))
    .toLowerCase()
  return WALLET_WIDE_FAILURES.some((needle) => message.includes(needle))
    ? 'wallet'
    : 'leg'
}

export type CollectableSendRunResult = {
  /** Transactions that signed, in the order they were sent. */
  sent: Array<{ txid: string; outpoints: string[] }>
  /** Tips that refused even as a single send. */
  failed: Array<{ outpoints: string[]; reason: string }>
  /** Set when a wallet-wide fault ended the run early. */
  stopped: 'wallet' | null
  lastError: string | null
}

export function collectableSendRunItemCount(
  result: CollectableSendRunResult,
): { sent: number; failed: number } {
  return {
    sent: result.sent.reduce((total, leg) => total + leg.outpoints.length, 0),
    failed: result.failed.reduce((total, leg) => total + leg.outpoints.length, 0),
  }
}

/** One sentence a toast can show without the reader counting legs. */
export function summarizeCollectableSendRun(
  result: CollectableSendRunResult,
): string {
  const { sent, failed } = collectableSendRunItemCount(result)
  const txCount = result.sent.length
  const head =
    sent > 0
      ? `Sent ${sent} collectable${sent === 1 ? '' : 's'} in ${txCount} transaction${
          txCount === 1 ? '' : 's'
        }.`
      : 'No collectables were sent.'
  if (result.stopped === 'wallet') {
    return `${head} Stopped with ${failed} left: ${result.lastError ?? 'wallet cannot continue'}`
  }
  if (failed > 0) {
    return `${head} ${failed} could not be sent: ${result.lastError ?? 'rejected'}`
  }
  return head
}
