import { durableGetItem, durableSetItem } from './durableStorage'
import {
  listRecentActivity,
  recordAppActivity,
  formatActivityRecipientDisplay,
  WALLET_ACTIVITY_ORIGIN,
} from './appActivity'

const STORAGE_KEY = 'handcash.brc100.pendingSend'

export type PendingSend = {
  id: string
  to: string
  sats: number
  friendLabel: string | null
  startedAt: number
  txid?: string
}

function readPending(): PendingSend[] {
  try {
    const raw = durableGetItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e): e is PendingSend =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as PendingSend).id === 'string' &&
        typeof (e as PendingSend).to === 'string' &&
        typeof (e as PendingSend).sats === 'number' &&
        typeof (e as PendingSend).startedAt === 'number',
    )
  } catch {
    return []
  }
}

function writePending(entries: PendingSend[]): void {
  durableSetItem(STORAGE_KEY, JSON.stringify(entries))
}

/** Call immediately before createAction so a crash mid-broadcast is recoverable. */
export function beginPendingSend(args: {
  to: string
  sats: number
  friendLabel?: string | null
}): PendingSend {
  const entry: PendingSend = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    to: args.to.trim(),
    sats: Math.max(0, Math.trunc(args.sats)),
    friendLabel: args.friendLabel?.trim() || null,
    startedAt: Date.now(),
  }
  writePending([...readPending(), entry])
  return entry
}

export function completePendingSend(id: string, txid?: string): void {
  writePending(
    readPending().map((e) => (e.id === id ? { ...e, txid: txid?.trim() || e.txid } : e)),
  )
}

export function clearPendingSend(id: string): void {
  writePending(readPending().filter((e) => e.id !== id))
}

function activityAlreadyHas(pending: PendingSend): boolean {
  const recent = listRecentActivity(200)
  if (pending.txid) {
    const tx = pending.txid.toLowerCase()
    // Kind-scoped: a self-pay receive shares the txid and must not suppress the send.
    if (recent.some((e) => e.kind === 'spent' && e.txid?.toLowerCase() === tx)) return true
  }
  // Same destination + amount within a short window of the interrupted send.
  const windowMs = 30 * 60_000
  return recent.some(
    (e) =>
      e.origin === WALLET_ACTIVITY_ORIGIN &&
      e.kind === 'spent' &&
      e.sats === pending.sats &&
      Math.abs(e.at - pending.startedAt) < windowMs &&
      (e.note?.includes(pending.to) ?? false),
  )
}

/**
 * After unlock / refresh: turn interrupted sends into activity rows so history
 * matches what the wallet already spent.
 *
 * A send is only real once it has a txid — that is the point the wallet
 * committed. A pending without one never got that far, so it is dropped rather
 * than written into history: a row for money that never moved is worse than no
 * row at all, because the user cannot tell it apart from a real payment.
 *
 * Rows with a txid are recorded as Settled; chain ingest later prunes any that
 * 404 on-chain (`pruneMissingOnChainActivity`).
 */
export function reconcilePendingSends(): number {
  const pending = readPending()
  if (pending.length === 0) return 0
  let recorded = 0
  const keep: PendingSend[] = []
  for (const entry of pending) {
    const ageMs = Date.now() - entry.startedAt
    // Keep very fresh pendings (send may still be in flight).
    if (ageMs < 5_000) {
      keep.push(entry)
      continue
    }
    if (!entry.txid) {
      console.info(
        `[pending-send] discarding ${entry.sats} sat send to ${entry.to} — it never reached a txid`,
      )
      continue
    }
    if (!activityAlreadyHas(entry) && entry.sats > 0) {
      const recipientNote = formatActivityRecipientDisplay({
        friendLabel: entry.friendLabel,
        to: entry.to,
      })
      recordAppActivity({
        origin: WALLET_ACTIVITY_ORIGIN,
        kind: 'spent',
        sats: entry.sats,
        method: 'send',
        note: `Sent to ${recipientNote}`,
        txid: entry.txid,
      })
      recorded += 1
    }
  }
  writePending(keep)
  return recorded
}
