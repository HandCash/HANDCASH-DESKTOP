import type { CallDirection, CallOutcome } from '../../machines/callMachine'
import { storageRegistry } from '../../storage/registry'
import { accountLocalKey } from '../accountLocalKeys'
import { durableGetItem, durableSetItem } from '../durableStorage'

/** Missed and finished calls on this account, newest first, for Activity. */
export type CallRecord = {
  id: string
  /** Identity keys of everyone else on the call. */
  peers: string[]
  direction: CallDirection
  outcome: CallOutcome
  video: boolean
  startedAt: number
  connectedAt: number | null
  endedAt: number
}

const MAX_RECORDS = 200
const listeners = new Set<(records: readonly CallRecord[]) => void>()

function storageKey(): string {
  return accountLocalKey(storageRegistry.callHistory.key)
}

function isRecord(v: unknown): v is CallRecord {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.id === 'string' &&
    Array.isArray(r.peers) &&
    r.peers.every((p) => typeof p === 'string') &&
    (r.direction === 'in' || r.direction === 'out') &&
    typeof r.outcome === 'string' &&
    typeof r.startedAt === 'number' &&
    typeof r.endedAt === 'number'
  )
}

export function listCallRecords(): CallRecord[] {
  try {
    const raw = durableGetItem(storageKey())
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter(isRecord).map((r) => ({ ...r, video: r.video === true, connectedAt: r.connectedAt ?? null })) : []
  } catch {
    return []
  }
}

/** Record a call once; a second write for the same id replaces the first. */
export function recordCall(record: CallRecord): void {
  const rest = listCallRecords().filter((r) => r.id !== record.id)
  const next = [record, ...rest].sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_RECORDS)
  durableSetItem(storageKey(), JSON.stringify(next))
  for (const listener of listeners) listener(next)
}

export function subscribeCallRecords(listener: (records: readonly CallRecord[]) => void): () => void {
  listeners.add(listener)
  listener(listCallRecords())
  return () => {
    listeners.delete(listener)
  }
}

/** Re-read after an account switch. */
export function rebindCallRecords(): void {
  const records = listCallRecords()
  for (const listener of listeners) listener(records)
}

export function callDurationText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

/** One line for an Activity row: what happened, in the user's terms. */
export function callOutcomeText(r: Pick<CallRecord, 'direction' | 'outcome' | 'video' | 'connectedAt' | 'endedAt'>): string {
  const kind = r.video ? 'video call' : 'call'
  switch (r.outcome) {
    case 'finished':
      return `${r.direction === 'in' ? 'Incoming' : 'Outgoing'} ${kind} · ${callDurationText(r.endedAt - (r.connectedAt ?? r.endedAt))}`
    case 'missed':
      return `Missed ${kind}`
    case 'declined':
      return r.direction === 'in' ? `Declined ${kind}` : `${kind[0]!.toUpperCase()}${kind.slice(1)} declined`
    case 'no-answer':
      return 'No answer'
    case 'busy':
      return 'Busy on another call'
    case 'unreachable':
      return 'Couldn’t reach them: they need HandCash open'
    case 'cancelled':
      return r.direction === 'in' ? `Missed ${kind}` : `Cancelled ${kind}`
    case 'failed':
      return 'Call dropped: the connection failed'
  }
}
