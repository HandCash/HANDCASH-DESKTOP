/**
 * Durable + in-flight guards for 1sat basket internalization.
 * Same outpoint must never be imported twice (migration ↔ chain sync race).
 */
import { durableGetItem, durableSetItem } from './durableStorage'

const STORAGE_KEY = 'handcash.brc100.importedOneSatOutpoints.v1'
const MAX_ENTRIES = 4000

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

function norm(outpoint: string): string {
  return outpoint.trim().toLowerCase()
}

export function isOneSatOutpointKnown(outpoint: string): boolean {
  const op = norm(outpoint)
  if (!op) return false
  if (inFlight.has(op)) return true
  return readImported().has(op)
}

export function filterNewOneSatOutpoints(outpoints: string[]): string[] {
  const known = readImported()
  const seen = new Set<string>()
  const next: string[] = []
  for (const raw of outpoints) {
    const op = norm(raw)
    if (!op || seen.has(op) || known.has(op) || inFlight.has(op)) continue
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
  for (const raw of outpoints) {
    const op = norm(raw)
    if (!op) continue
    known.add(op)
    inFlight.delete(op)
  }
  writeImported(known)
}

export function releaseOneSatImport(outpoints: string[]): void {
  for (const raw of outpoints) {
    inFlight.delete(norm(raw))
  }
}
