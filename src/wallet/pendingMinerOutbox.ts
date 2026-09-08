/**
 * Durable Atomic-BEEF propagation queue.
 *
 * Signing is the optimistic UI boundary; this queue survives process exit until
 * a provider acknowledges the transaction or returns a proven hard rejection.
 */
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

function load(): PendingMinerSubmit[] {
  try {
    const parsed = JSON.parse(durableGetItem(KEY) || '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return (parsed as PendingMinerSubmit[]).filter(
      (row) =>
        /^[0-9a-f]{64}$/i.test(row?.txid || '') &&
        Array.isArray(row.atomic) &&
        row.atomic.length > 0,
    )
  } catch {
    return []
  }
}

function save(rows: PendingMinerSubmit[]): void {
  durableSetItem(KEY, JSON.stringify(rows.slice(-MAX_ROWS)))
}

export function enqueuePendingMinerSubmit(txid: string, atomic: number[]): boolean {
  const id = txid.trim().toLowerCase()
  if (
    !/^[0-9a-f]{64}$/.test(id) ||
    atomic.length === 0 ||
    atomic.length > MAX_ATOMIC_BYTES ||
    !atomic.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
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

function backoffMs(attempt: number): number {
  return Math.min(15 * 60_000, 2_000 * 2 ** Math.min(9, attempt))
}

export async function flushPendingMinerOutbox(): Promise<number> {
  const now = Date.now()
  const rows = load()
  if (rows.length === 0) return 0
  const keep: PendingMinerSubmit[] = []
  let accepted = 0
  const { submitAtomicBeefToMiners, reportLateMinerSubmitFailure } = await import(
    './minerSubmit'
  )

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
      if (result.confirmed) {
        accepted += 1
        continue
      }
    } catch (error) {
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
