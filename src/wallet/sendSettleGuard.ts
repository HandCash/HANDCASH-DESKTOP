/**
 * Protects change created by a send we just broadcast.
 *
 * `reviewSpendableOutputs(all, release)` asks the network about every output the
 * wallet holds and marks anything that does not answer `isUtxo === true` as
 * `spendable: false` — permanently. The toolbox collapses "definitely spent",
 * "not indexed yet", and "provider errored" into that same `false`, so a change
 * output from a transaction the indexer has not caught up on gets written off as
 * dead and the balance silently drops to zero.
 *
 * A send is therefore a window in which releasing is unsafe. Record the
 * broadcast, and hold the release until the chain has had time to see it.
 * Durable, so relaunching mid-window does not drop the protection.
 */
import { durableGetItem, durableSetItem } from './durableStorage'

const STORAGE_KEY = 'handcash.send.lastBroadcast.v1'

/**
 * How long after a broadcast to keep change safe.
 *
 * Only delays cleanup of genuinely spent outputs, so err long — losing the
 * change costs the user money, whereas a stale row costs nothing.
 */
export const SEND_SETTLE_MS = 10 * 60_000

export type SendBroadcastRecord = {
  at: number
  txid?: string
}

function readRecord(): SendBroadcastRecord | null {
  try {
    const raw = durableGetItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const row = parsed as { at?: unknown; txid?: unknown }
    if (typeof row.at !== 'number' || !Number.isFinite(row.at)) return null
    return {
      at: row.at,
      txid: typeof row.txid === 'string' && row.txid.trim() ? row.txid.trim() : undefined,
    }
  } catch {
    return null
  }
}

/** Call once a send has a txid — payment or collectable. */
export function noteSendBroadcast(txid?: string): void {
  const record: SendBroadcastRecord = {
    at: Date.now(),
    ...(txid?.trim() ? { txid: txid.trim().toLowerCase() } : {}),
  }
  durableSetItem(STORAGE_KEY, JSON.stringify(record))
}

/** True while a recent send could still be missing from the indexer. */
export function isSendSettleGraceActive(now = Date.now()): boolean {
  const record = readRecord()
  if (!record) return false
  // A clock that moved backwards must not pin the guard open forever.
  if (record.at > now) return false
  return now - record.at < SEND_SETTLE_MS
}

/** Test-only */
export function resetSendSettleGuardForTests(): void {
  durableSetItem(STORAGE_KEY, '')
}
