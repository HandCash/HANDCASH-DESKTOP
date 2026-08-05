/**
 * Durable + in-flight guards for legacy P2PKH → managed-change sweeps.
 * Same outpoint must never be funded twice (race or indexer lag).
 */
import { durableGetItem, durableSetItem } from './durableStorage'

const STORAGE_KEY = 'handcash.brc100.importedLegacyOutpoints.v1'
const MAX_ENTRIES = 2000

/** Outpoints currently mid-import on this process. */
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

export function isLegacyOutpointKnown(outpoint: string): boolean {
  const op = outpoint.trim().toLowerCase()
  if (!op) return false
  if (inFlight.has(op)) return true
  return readImported().has(op)
}

/** Drop outpoints already imported or currently importing. */
export function filterNewLegacyOutpoints(outpoints: string[]): string[] {
  const known = readImported()
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

export function markLegacyImported(outpoints: string[]): void {
  if (outpoints.length === 0) return
  const known = readImported()
  for (const raw of outpoints) {
    const op = raw.trim().toLowerCase()
    if (!op) continue
    known.add(op)
    inFlight.delete(op)
  }
  writeImported(known)
}

/** Undo a durable mark — used when an “imported” out is still unspent on-chain. */
export function forgetLegacyImported(outpoints: string[]): void {
  if (outpoints.length === 0) return
  const known = readImported()
  let changed = false
  for (const raw of outpoints) {
    const op = raw.trim().toLowerCase()
    if (!op || !known.has(op)) continue
    known.delete(op)
    inFlight.delete(op)
    changed = true
  }
  if (changed) writeImported(known)
}

/**
 * If we previously blacklisted an outpoint but the address scan still shows it
 * unspent with funding sats, clear the mark so import can retry.
 */
export function reclaimStillUnspentLegacyOutpoints(
  utxos: Array<{ outpoint: string; satoshis: number }>,
): string[] {
  const known = readImported()
  const reclaimed: string[] = []
  for (const u of utxos) {
    if (!(u.satoshis > 1)) continue
    const op = u.outpoint.trim().toLowerCase()
    if (!op || !known.has(op) || inFlight.has(op)) continue
    reclaimed.push(op)
  }
  if (reclaimed.length > 0) {
    forgetLegacyImported(reclaimed)
    console.info(
      `[legacy] reclaimed ${reclaimed.length} still-unspent outpoint(s) previously marked imported`,
    )
  }
  return reclaimed
}

export function releaseLegacyImport(outpoints: string[]): void {
  for (const raw of outpoints) {
    inFlight.delete(raw.trim().toLowerCase())
  }
}
