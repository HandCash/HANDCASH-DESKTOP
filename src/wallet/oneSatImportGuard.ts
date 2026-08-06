/**
 * Durable + in-flight guards for 1sat basket internalization.
 * Same outpoint must never be imported twice (migration ↔ chain sync race).
 *
 * Failed imports get a short backoff so a bad latch cannot re-fetch BEEF and
 * block the UI on every Dashboard poll.
 */
import { durableGetItem, durableSetItem } from './durableStorage'

const STORAGE_KEY = 'handcash.brc100.importedOneSatOutpoints.v1'
const FAIL_KEY = 'handcash.brc100.failedOneSatOutpoints.v1'
const MAX_ENTRIES = 4000
/** Do not retry a failed internalization until this elapses. */
const FAIL_BACKOFF_MS = 5 * 60_000

const inFlight = new Set<string>()

function readImported(): Set<string> {
  try {
    const raw = durableGetItem(STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(
      parsed.filter((x): x is string => typeof x === 'string' && x.includes('.')),
    )
  } catch {
    return new Set()
  }
}

function writeImported(set: Set<string>): void {
  const list = [...set].slice(-MAX_ENTRIES)
  durableSetItem(STORAGE_KEY, JSON.stringify(list))
}

function readFailures(): Map<string, number> {
  const map = new Map<string, number>()
  try {
    const raw = durableGetItem(FAIL_KEY)
    if (!raw) return map
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return map
    for (const [op, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === 'number' && op.includes('.')) map.set(op, at)
    }
  } catch {
    // Corrupt blob must not stop imports.
  }
  return map
}

function writeFailures(map: Map<string, number>): void {
  const now = Date.now()
  const kept = [...map.entries()]
    .filter(([, at]) => now - at < FAIL_BACKOFF_MS * 4)
    .slice(-MAX_ENTRIES)
  durableSetItem(FAIL_KEY, JSON.stringify(Object.fromEntries(kept)))
}

function norm(outpoint: string): string {
  return outpoint.trim().toLowerCase().replace(/_(\d+)$/, '.$1')
}

function isBackingOff(op: string, failures: Map<string, number>): boolean {
  const at = failures.get(op)
  if (at == null) return false
  return Date.now() - at < FAIL_BACKOFF_MS
}

export function isOneSatOutpointKnown(outpoint: string): boolean {
  const op = norm(outpoint)
  if (!op) return false
  if (inFlight.has(op)) return true
  return readImported().has(op)
}

export function filterNewOneSatOutpoints(outpoints: string[]): string[] {
  const known = readImported()
  const failures = readFailures()
  const seen = new Set<string>()
  const next: string[] = []
  for (const raw of outpoints) {
    const op = norm(raw)
    if (!op || seen.has(op) || known.has(op) || inFlight.has(op)) continue
    if (isBackingOff(op, failures)) continue
    seen.add(op)
    next.push(op)
  }
  return next
}

export function beginOneSatImport(outpoints: string[]): string[] {
  const allowed = filterNewOneSatOutpoints(outpoints)
  for (const op of allowed) inFlight.add(op)
  return allowed
}

export function markOneSatImported(outpoints: string[]): void {
  if (outpoints.length === 0) return
  const known = readImported()
  const failures = readFailures()
  let failuresChanged = false
  for (const raw of outpoints) {
    const op = norm(raw)
    if (!op) continue
    known.add(op)
    inFlight.delete(op)
    if (failures.delete(op)) failuresChanged = true
  }
  writeImported(known)
  if (failuresChanged) writeFailures(failures)
}

export function releaseOneSatImport(outpoints: string[]): void {
  for (const raw of outpoints) {
    inFlight.delete(norm(raw))
  }
}

/** Record a failed import so the next few polls skip the expensive BEEF path. */
export function markOneSatImportFailed(outpoints: string[]): void {
  if (outpoints.length === 0) return
  const failures = readFailures()
  const now = Date.now()
  for (const raw of outpoints) {
    const op = norm(raw)
    if (!op) continue
    inFlight.delete(op)
    failures.set(op, now)
  }
  writeFailures(failures)
}

/** Test hook. */
export function resetOneSatImportGuardForTests(): void {
  inFlight.clear()
}
