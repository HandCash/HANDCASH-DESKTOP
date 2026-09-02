/**
 * Durable heal checkpoint — overlap window so we never drop a txid mid-flight.
 * Mirrors consolidateChange cooldown pattern: silent auto passes, manual can force.
 */
import { durableGetItem, durableSetItem } from './durableStorage'

const CHECKPOINT_KEY = 'handcash.utxoHeal.checkpoint.v1'
const MAX_STORED_TXIDS = 256

/** Settings checkmark + skip full pass when clean within this window. */
export const HEAL_CHECKPOINT_OVERLAP_MS = 6 * 60 * 60_000

/** Minimum gap between silent auto checkpoint passes. */
export const HEAL_AUTO_COOLDOWN_MS = 3 * 60_000

export type UtxoHealCheckpointSource = 'manual' | 'auto' | 'send-cleanup'

export type UtxoHealCheckpoint = {
  at: number
  txids: string[]
  recoveredSats: number
  pendingChangeAfter: number
  source: UtxoHealCheckpointSource
}

let lastAutoAttemptAt = 0

export function __resetHealCheckpointForTests(): void {
  lastAutoAttemptAt = 0
  durableSetItem(CHECKPOINT_KEY, '')
}

export function readHealCheckpoint(): UtxoHealCheckpoint | null {
  try {
    const raw = durableGetItem(CHECKPOINT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as UtxoHealCheckpoint
    if (!parsed || typeof parsed.at !== 'number' || !Array.isArray(parsed.txids)) {
      return null
    }
    return {
      at: parsed.at,
      txids: parsed.txids.filter(
        (t): t is string => typeof t === 'string' && /^[0-9a-f]{64}$/.test(t),
      ),
      recoveredSats: Math.max(0, Math.trunc(Number(parsed.recoveredSats) || 0)),
      pendingChangeAfter: Math.max(0, Math.trunc(Number(parsed.pendingChangeAfter) || 0)),
      source: parsed.source ?? 'auto',
    }
  } catch {
    return null
  }
}

export function writeHealCheckpoint(next: UtxoHealCheckpoint): void {
  const txids = [...new Set(next.txids.map((t) => t.toLowerCase()))].slice(
    -MAX_STORED_TXIDS,
  )
  durableSetItem(
    CHECKPOINT_KEY,
    JSON.stringify({
      ...next,
      txids,
    }),
  )
}

export function healCheckpointAgeMs(now = Date.now()): number | null {
  const cp = readHealCheckpoint()
  if (!cp) return null
  return Math.max(0, now - cp.at)
}

/** True when a recent pass reported clean balance (overlap window). */
export function healCheckpointFresh(
  now = Date.now(),
  overlapMs = HEAL_CHECKPOINT_OVERLAP_MS,
): boolean {
  const cp = readHealCheckpoint()
  if (!cp) return false
  if (now - cp.at > overlapMs) return false
  return cp.pendingChangeAfter <= 0
}

export function mergeTxidsWithCheckpoint(current: Set<string>): Set<string> {
  const merged = new Set(current)
  for (const txid of readHealCheckpoint()?.txids ?? []) {
    merged.add(txid.toLowerCase())
  }
  return merged
}

export function txidsMissingFromCheckpoint(current: Set<string>): string[] {
  const prev = new Set(
    (readHealCheckpoint()?.txids ?? []).map((t) => t.toLowerCase()),
  )
  return [...current].filter((t) => !prev.has(t.toLowerCase()))
}

export function canRunAutoHealCheckpoint(now = Date.now()): boolean {
  return now - lastAutoAttemptAt >= HEAL_AUTO_COOLDOWN_MS
}

export function markAutoHealAttempt(now = Date.now()): void {
  lastAutoAttemptAt = now
}
