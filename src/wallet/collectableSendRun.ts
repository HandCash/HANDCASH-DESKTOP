/**
 * Bulk item send: one selection becomes a sequence of atomic transactions.
 *
 * `sendCollectables` is atomic and capped at `MAX_ITEMS_PER_ONE_SAT_TX` — every
 * extra input is another sighash to sign and another BEEF ancestor to carry, so
 * a large selection cannot be one transaction. A run splits the selection into
 * measured UI-safe legs and sends them in order.
 *
 * Two things make the loop reliable rather than 28 chances to lose the wallet:
 *
 * 1. **A leg is still atomic.** Each leg either signs completely or transfers
 *    nothing, so a partial run is a set of whole transactions, never a
 *    half-moved leg.
 * 2. **Failure is classified, never retried blindly.** Only a recognized
 *    item-local conflict may halve a leg and retry down to singles. Wallet,
 *    network, timeout, ancestry and unknown faults stop the run once — an
 *    unknown error must never multiply itself into a retry storm.
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
export type SendRunFailureDecision =
  | { action: 'split'; reason: 'itemConflict' }
  | {
      action: 'stop'
      reason: 'wallet' | 'network' | 'ancestry' | 'unknown'
    }

const WALLET_FAILURES = [
  'wallet locked',
  'wallet is locked',
  'no wallet',
  'not enough',
  'insufficient',
  'invalid recipient',
  'select at least one',
  'cancelled',
  'canceled',
]

const NETWORK_FAILURES = [
  'offline',
  'no network',
  'network',
  'fetch failed',
  'timed out',
  'timeout',
  'status 429',
  'status 500',
  'status 502',
  'status 503',
  'status 504',
]

const ANCESTRY_FAILURES = [
  'ancestry incomplete',
  'ancestry_incomplete',
  'beef_ancestry_incomplete',
  'without create transaction',
  'missing source transaction',
]

const ITEM_CONFLICTS = [
  'collectable is no longer in this wallet',
  'collectable is no longer unspent',
  'collectable utxo is not a 1-sat ordinal',
  'is no longer spendable',
  'input already spent',
  'already-spent input',
  'already spent input',
  'double spend',
  'doublespend',
  'txn-mempool-conflict',
  'bad-txns-inputs-missingorspent',
]

export function classifySendRunFailure(
  reason: unknown,
): SendRunFailureDecision {
  const message = (reason instanceof Error ? reason.message : String(reason ?? ''))
    .toLowerCase()
  if (WALLET_FAILURES.some((needle) => message.includes(needle))) {
    return { action: 'stop', reason: 'wallet' }
  }
  if (NETWORK_FAILURES.some((needle) => message.includes(needle))) {
    return { action: 'stop', reason: 'network' }
  }
  if (ANCESTRY_FAILURES.some((needle) => message.includes(needle))) {
    return { action: 'stop', reason: 'ancestry' }
  }
  if (ITEM_CONFLICTS.some((needle) => message.includes(needle))) {
    return { action: 'split', reason: 'itemConflict' }
  }
  // Fail closed. The old default was `leg`, which turned one unfamiliar error
  // into 2, 4, 8… attempts and one permanent failed Activity row per attempt.
  return { action: 'stop', reason: 'unknown' }
}

/** Intermediate multi-tip failures are implementation detail, not Activity. */
export function failedSendAttemptActivity(
  itemCount: number,
): 'discard' | 'record' {
  return itemCount > 1 ? 'discard' : 'record'
}

export type CollectableSendRunResult = {
  /** Transactions that signed, in the order they were sent. */
  sent: Array<{ txid: string; outpoints: string[] }>
  /** Tips that refused even as a single send. */
  failed: Array<{ outpoints: string[]; reason: string }>
  /** Set when a non-item-local fault ended the run early. */
  stopped: 'fault' | null
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
  if (result.stopped === 'fault') {
    return `${head} Stopped with ${failed} left: ${result.lastError ?? 'run cannot continue'}`
  }
  if (failed > 0) {
    return `${head} ${failed} could not be sent: ${result.lastError ?? 'rejected'}`
  }
  return head
}
