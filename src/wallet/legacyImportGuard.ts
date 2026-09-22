/**
 * Durable + in-flight guards for legacy P2PKH → managed-change sweeps.
 * Same outpoint must never be funded twice (race or indexer lag).
 *
 * A second sweep of one outpoint is not a harmless retry: both transactions
 * spend the same legacy input, so at most one can confirm, and the managed
 * change the loser recorded is unspendable forever. Marks are therefore durable
 * and carry the sweep txid and time. Once marked, an outpoint stays marked —
 * an address scan that still lists it as unspent is indexer lag, not a lost
 * sweep, and reclaiming it would reopen the double-deposit hole.
 */
import { durableGetItem, durableSetItem } from './durableStorage'
import { accountLocalKey } from './accountLocalKeys'
import { storageRegistry } from '../storage/registry'

const STORAGE_KEY_BASE = storageRegistry.importedLegacyOutpoints.key
/** v1 kept a bare outpoint array with no sweep time. */
const LEGACY_STORAGE_KEY_BASE = storageRegistry.importedLegacyOutpointsLegacy.key
function storageKey(): string {
  return accountLocalKey(STORAGE_KEY_BASE)
}

function legacyStorageKey(): string {
  return accountLocalKey(LEGACY_STORAGE_KEY_BASE)
}

const MAX_ENTRIES = 2000

/** Skip spendable review briefly after a successful sweep while indexers catch up. */
const IMPORT_GRACE_MS = 120_000

/**
 * How long a mark must stand before a stuck sweep may be reconsidered.
 *
 * Long enough that our own broadcast has had every chance to appear, because the
 * only thing worse than an unswept deposit is sweeping it twice.
 */
export const SWEEP_RETRY_MS = 15 * 60_000

export type LegacySweepRecord = {
  /** When the sweep was marked imported. 0 for v1 marks of unknown age. */
  at: number
  /** Sweep transaction, when the funding call reported one. */
  txid?: string
}

/** Outpoints currently mid-import on this process. */
const inFlight = new Set<string>()
let lastSuccessfulLegacyImportAt = 0

/**
 * Parsed marks, keyed by the raw blobs they came from.
 *
 * `isLegacyOutpointKnown` is asked once per address UTXO during classify, so on
 * a wallet with hundreds of outs an unmemoized parse per call dominated the
 * ingest pass. Both storage versions feed the signature because the v1 blob is
 * a fallback, and a write to either must invalidate.
 *
 * Read-only: mutators clone before calling `writeRecords`.
 */
let cachedSig: string | null = null
let cachedRecords = new Map<string, LegacySweepRecord>()

function readRecords(): Map<string, LegacySweepRecord> {
  const sig = `${durableGetItem(storageKey()) ?? ''}\u0000${
    durableGetItem(legacyStorageKey()) ?? ''
  }`
  if (sig === cachedSig) return cachedRecords
  const parsed = parseRecords()
  cachedSig = sig
  cachedRecords = parsed
  return parsed
}

function parseRecords(): Map<string, LegacySweepRecord> {
  const records = new Map<string, LegacySweepRecord>()
  try {
    const raw = durableGetItem(storageKey())
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [op, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (!op.includes('.')) continue
          const row = (value ?? {}) as { at?: unknown; txid?: unknown }
          records.set(op, {
            at: typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : 0,
            txid: typeof row.txid === 'string' && row.txid.trim() ? row.txid.trim() : undefined,
          })
        }
        return records
      }
    }
  } catch {
    /* fall through to v1 */
  }

  try {
    const raw = durableGetItem(legacyStorageKey())
    if (!raw) return records
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return records
    for (const op of parsed) {
      if (typeof op === 'string' && op.includes('.')) records.set(op, { at: 0 })
    }
  } catch {
    /* no usable state */
  }
  return records
}

function writeRecords(records: Map<string, LegacySweepRecord>): void {
  const trimmed = [...records.entries()]
    .sort((a, b) => a[1].at - b[1].at)
    .slice(-MAX_ENTRIES)
  durableSetItem(storageKey(), JSON.stringify(Object.fromEntries(trimmed)))
}

export function isLegacyOutpointKnown(outpoint: string): boolean {
  const op = outpoint.trim().toLowerCase()
  if (!op) return false
  if (inFlight.has(op)) return true
  return readRecords().has(op)
}

/** Drop outpoints already imported or currently importing. */
export function filterNewLegacyOutpoints(outpoints: string[]): string[] {
  const known = readRecords()
  const seen = new Set<string>()
  const next: string[] = []
  for (const raw of outpoints) {
    const op = raw.trim().toLowerCase()
    if (!op || seen.has(op) || known.has(op) || inFlight.has(op)) continue
    seen.add(op)
    next.push(op)
  }
  return next
}

export function beginLegacyImport(outpoints: string[]): string[] {
  const allowed = filterNewLegacyOutpoints(outpoints)
  for (const op of allowed) inFlight.add(op)
  return allowed
}

export function markLegacyImported(
  outpoints: Array<string | { outpoint: string; txid?: string }>,
): void {
  if (outpoints.length === 0) return
  const known = new Map(readRecords())
  const at = Date.now()
  let marked = 0
  for (const raw of outpoints) {
    const entry = typeof raw === 'string' ? { outpoint: raw } : raw
    const op = entry.outpoint.trim().toLowerCase()
    if (!op) continue
    const txid = entry.txid?.trim().toLowerCase() || known.get(op)?.txid
    known.set(op, txid ? { at, txid } : { at })
    inFlight.delete(op)
    marked += 1
  }
  if (marked === 0) return
  writeRecords(known)
  noteLegacyImportSuccess(marked)
}

/** Sweep record for an outpoint, when one was stored. */
export function legacySweepRecord(outpoint: string): LegacySweepRecord | null {
  const op = outpoint.trim().toLowerCase()
  if (!op) return null
  return readRecords().get(op) ?? null
}

/** Record a successful legacy sweep — pauses aggressive review while indexers catch up. */
export function noteLegacyImportSuccess(count: number): void {
  if (count > 0) lastSuccessfulLegacyImportAt = Date.now()
}

export function isLegacyImportGraceActive(): boolean {
  const now = Date.now()
  if (lastSuccessfulLegacyImportAt > 0 && now - lastSuccessfulLegacyImportAt < IMPORT_GRACE_MS) {
    return true
  }
  // A reload must not drop the grace — the sweep is still just as fresh.
  for (const record of readRecords().values()) {
    if (record.at > 0 && now - record.at < IMPORT_GRACE_MS) return true
  }
  return false
}

/** A mark old enough to be genuinely stuck rather than merely fresh. */
export function legacySweepRetryEligible(outpoint: string, now = Date.now()): boolean {
  const record = legacySweepRecord(outpoint)
  if (!record) return true
  return now - record.at >= SWEEP_RETRY_MS
}

/**
 * Undo a durable mark, for an "imported" out that is still unspent on chain.
 *
 * The sweep is queued through the toolbox in delayed mode, so a reported success
 * means the transaction was accepted locally — not that it reached a miner. When
 * it never does, the mark is the only thing standing between the user and their
 * coins, and nothing else in the wallet can clear it.
 */
export function forgetLegacyImported(outpoints: string[]): void {
  if (outpoints.length === 0) return
  const known = new Map(readRecords())
  let changed = false
  for (const raw of outpoints) {
    const op = raw.trim().toLowerCase()
    if (!op || !known.has(op)) continue
    known.delete(op)
    inFlight.delete(op)
    changed = true
  }
  if (changed) writeRecords(known)
}

export function releaseLegacyImport(outpoints: string[]): void {
  for (const raw of outpoints) {
    inFlight.delete(raw.trim().toLowerCase())
  }
}

/** Test-only */
export function resetLegacyImportGraceForTests(): void {
  lastSuccessfulLegacyImportAt = 0
  inFlight.clear()
}

export function rebindLegacyImportGuardForAccount(): void {
  inFlight.clear()
  lastSuccessfulLegacyImportAt = 0
  cachedSig = null
  cachedRecords = new Map()
}
