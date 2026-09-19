/**
 * Durable Atomic-BEEF propagation queue.
 *
 * Signing is the optimistic UI boundary; this queue survives process exit until
 * a provider acknowledges the transaction or returns a proven hard rejection.
 */
import { Beef } from '@bsv/sdk'
import { classifyBeefAncestryGap } from './beefCache'
import { durableGetItem, durableSetItem } from './durableStorage'
import {
  activeTransactionTrace,
  recordTransactionStage,
  type TransactionFlow,
} from './transactionTelemetry'

const KEY = 'handcash.wallet.pendingMinerOutbox.v1'
const MAX_ROWS = 25
const MAX_ATOMIC_BYTES = 2 * 1024 * 1024
const MAX_ATTEMPTS = 40

export type PendingMinerSubmit = {
  txid: string
  atomic: number[]
  createdAt: number
  attempts: number
  nextAttemptAt: number
  traceId?: string
  requestId?: string
  flow?: TransactionFlow
}

export type PendingMinerBodyVerdict =
  | { kind: 'refuse'; reason: 'invalid-shape' | 'malformed-beef' | 'subject-body-missing' }
  | { kind: 'recoverable-ancestry' }
  | { kind: 'spv-ready' }

/**
 * One verdict for the durable boundary:
 *
 * - refuse: no retry can turn these bytes into this signed transaction
 * - recoverable-ancestry: subject is signed; parent bodies may still be hydrated
 * - spv-ready: subject and required ancestry are already self-contained
 */
export function classifyPendingMinerBody(
  txid: string,
  atomic: number[],
): PendingMinerBodyVerdict {
  const id = txid.trim().toLowerCase()
  if (
    !/^[0-9a-f]{64}$/.test(id) ||
    atomic.length === 0 ||
    atomic.length > MAX_ATOMIC_BYTES ||
    !atomic.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    return { kind: 'refuse', reason: 'invalid-shape' }
  }
  try {
    const found = Beef.fromBinary(atomic).findTxid(id)
    if (!found?.tx || found.isTxidOnly) {
      return { kind: 'refuse', reason: 'subject-body-missing' }
    }
  } catch {
    return { kind: 'refuse', reason: 'malformed-beef' }
  }
  return classifyBeefAncestryGap(atomic) === 'missing-bodies'
    ? { kind: 'recoverable-ancestry' }
    : { kind: 'spv-ready' }
}

function load(): PendingMinerSubmit[] {
  try {
    const parsed = JSON.parse(durableGetItem(KEY) || '[]') as unknown
    if (!Array.isArray(parsed)) return []
    const candidates = (parsed as PendingMinerSubmit[]).filter(
      (row) =>
        /^[0-9a-f]{64}$/i.test(row?.txid || '') &&
        Array.isArray(row.atomic) &&
        row.atomic.length > 0,
    )
    const rows = candidates.filter(
      (row) => classifyPendingMinerBody(row.txid, row.atomic).kind !== 'refuse',
    )
    // Clean up rows written by older builds that only checked byte ranges.
    if (rows.length !== candidates.length) {
      durableSetItem(KEY, JSON.stringify(rows.slice(-MAX_ROWS)))
    }
    return rows
  } catch {
    return []
  }
}

function save(rows: PendingMinerSubmit[]): void {
  durableSetItem(KEY, JSON.stringify(rows.slice(-MAX_ROWS)))
}

export function enqueuePendingMinerSubmit(txid: string, atomic: number[]): boolean {
  const id = txid.trim().toLowerCase()
  const verdict = classifyPendingMinerBody(id, atomic)
  if (verdict.kind === 'refuse') {
    console.warn(
      '[minerOutbox] refusing durable body',
      id.slice(0, 12),
      verdict.reason,
    )
    return false
  }
  const rows = load()
  if (rows.some((row) => row.txid === id)) return true
  const trace = activeTransactionTrace()
  rows.push({
    txid: id,
    atomic: [...atomic],
    createdAt: Date.now(),
    attempts: 0,
    nextAttemptAt: Date.now(),
    traceId: trace?.traceId,
    requestId: trace?.requestId,
    flow: trace?.flow,
  })
  save(rows)
  recordTransactionStage('propagation_queued', {
    flow: trace?.flow,
    traceId: trace?.traceId,
    requestId: trace?.requestId,
    txid: id,
  })
  return true
}

export function removePendingMinerSubmit(txid: string): void {
  const id = txid.trim().toLowerCase()
  save(load().filter((row) => row.txid !== id))
}

/**
 * Replace a queued body with a more complete one.
 *
 * The row is stored before ancestry is merged so a crash cannot lose the
 * cheque. Without this the queue would keep re-posting the thinner body for
 * every remaining attempt and discard the ancestry each retry rebuilt.
 */
export function updatePendingMinerSubmitBody(
  txid: string,
  atomic: number[],
): boolean {
  const id = txid.trim().toLowerCase()
  if (classifyPendingMinerBody(id, atomic).kind === 'refuse') return false
  const rows = load()
  const row = rows.find((r) => r.txid === id)
  if (!row) return false
  row.atomic = [...atomic]
  save(rows)
  return true
}

function backoffMs(attempt: number): number {
  return Math.min(15 * 60_000, 2_000 * 2 ** Math.min(9, attempt))
}

export async function flushPendingMinerOutbox(): Promise<number> {
  const now = Date.now()
  const rows = load()
  if (rows.length === 0) return 0
  const keep: PendingMinerSubmit[] = []
  let accepted = 0
  const {
    submitAtomicBeefToMiners,
    minerSubmitKeepOutbox,
    reportLateMinerSubmitFailure,
  } = await import('./minerSubmit')

  for (const row of rows) {
    if (row.nextAttemptAt > now) {
      keep.push(row)
      continue
    }
    const attempt = row.attempts + 1
    recordTransactionStage('provider_attempt', {
      flow: row.flow,
      traceId: row.traceId,
      requestId: row.requestId,
      retryCount: attempt,
      queueWaitMs: Math.max(0, now - row.createdAt),
      txid: row.txid,
    })
    try {
      const result = await submitAtomicBeefToMiners(row.txid, row.atomic, {
        fromOutbox: true,
        traceId: row.traceId,
        requestId: row.requestId,
        flow: row.flow,
        retryCount: attempt,
      })
      if (!minerSubmitKeepOutbox(result)) {
        accepted += 1
        continue
      }
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code ?? '')
          : ''
      // Incomplete ancestry is not a spent input. Keep the cheque and retry
      // once the parent bodies can ride with the subject.
      if (code === 'BEEF_ANCESTRY_INCOMPLETE' && attempt < MAX_ATTEMPTS) {
        keep.push({
          ...row,
          attempts: attempt,
          nextAttemptAt: Date.now() + backoffMs(attempt),
        })
        continue
      }
      await reportLateMinerSubmitFailure({
        txid: row.txid,
        reason: error,
      })
      continue
    }
    if (attempt >= MAX_ATTEMPTS) {
      recordTransactionStage('retry_exhausted', {
        flow: row.flow,
        traceId: row.traceId,
        requestId: row.requestId,
        retryCount: attempt,
        blockerCode: 'provider_retry_exhausted',
        txid: row.txid,
      })
      continue
    }
    keep.push({
      ...row,
      attempts: attempt,
      nextAttemptAt: Date.now() + backoffMs(attempt),
    })
  }
  save(keep)
  return accepted
}

export function pendingMinerOutboxDepth(): number {
  return load().length
}

export function __resetPendingMinerOutboxForTests(): void {
  save([])
}
