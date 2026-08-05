/**
 * Outpoints a send just spent, hidden from inventory until the chain agrees.
 *
 * `relinquishOutput` usually throws right after a send — `createAction` already
 * marked the tip spent — and `listOutputs` keeps returning it until a spendable
 * review runs, which is throttled and paused after legacy sweeps. Without this
 * guard the optimistic cache prune is undone by the very next list, so a sent
 * collectable looks like it never left the sender's wallet.
 *
 * Keyed by outpoint, which can never legitimately be ours again once spent, so
 * receiving the same ordinal back (a new outpoint) still shows up. Entries
 * expire in case the send never confirmed and the item really is still ours.
 */
import { durableGetItem, durableSetItem } from './durableStorage'

const STORAGE_KEY = 'handcash.collectables.sentOutpoints.v1'
const MAX_ENTRIES = 500

/** A send that never landed has to give the item back rather than hide it forever. */
export const SENT_HIDE_MS = 24 * 60 * 60_000

export type SentItemRecord = {
  at: number
  /** Sending transaction, for log correlation. */
  txid?: string
}

function readSent(): Map<string, SentItemRecord> {
  const records = new Map<string, SentItemRecord>()
  try {
    const raw = durableGetItem(STORAGE_KEY)
    if (!raw) return records
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return records
    for (const [op, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!op.includes('.')) continue
      const row = (value ?? {}) as { at?: unknown; txid?: unknown }
      const at = typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : 0
      records.set(op, {
        at,
        txid: typeof row.txid === 'string' && row.txid.trim() ? row.txid.trim() : undefined,
      })
    }
  } catch {
    /* no usable state */
  }
  return records
}

function writeSent(records: Map<string, SentItemRecord>): void {
  const now = Date.now()
  const live = [...records.entries()]
    .filter(([, r]) => now - r.at < SENT_HIDE_MS)
    .sort((a, b) => a[1].at - b[1].at)
    .slice(-MAX_ENTRIES)
  durableSetItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(live)))
}

function key(outpoint: string): string {
  return outpoint.trim().toLowerCase().replace('_', '.')
}

/** Hide outpoints a send just spent. Call only once the send has a txid. */
export function markItemsSent(
  outpoints: Array<string | { outpoint: string; txid?: string }>,
): void {
  if (outpoints.length === 0) return
  const records = readSent()
  const at = Date.now()
  let marked = 0
  for (const raw of outpoints) {
    const entry = typeof raw === 'string' ? { outpoint: raw } : raw
    const op = key(entry.outpoint)
    if (!op) continue
    records.set(op, entry.txid ? { at, txid: entry.txid.trim().toLowerCase() } : { at })
    marked += 1
  }
  if (marked > 0) writeSent(records)
}

export function isItemSent(outpoint: string, now = Date.now()): boolean {
  const op = key(outpoint)
  if (!op) return false
  const record = readSent().get(op)
  if (!record) return false
  return now - record.at < SENT_HIDE_MS
}

/** Un-hide — for a send that turned out not to have spent these after all. */
export function forgetItemsSent(outpoints: string[]): void {
  if (outpoints.length === 0) return
  const records = readSent()
  let changed = false
  for (const raw of outpoints) {
    if (records.delete(key(raw))) changed = true
  }
  if (changed) writeSent(records)
}

/** Test-only */
export function resetSentItemsForTests(): void {
  durableSetItem(STORAGE_KEY, '{}')
}
