import { storageRegistry } from '../storage/registry'
/**
 * Durable heal checkpoint — overlap window so we never drop a txid mid-flight.
 * Mirrors consolidateChange cooldown pattern: silent auto passes, manual can force.
 *
 * Every accessor takes the owning account. A heal pass spans dozens of awaits;
 * resolving the key from the ambient scope on each one is how a pass that
 * started on one vault account wrote its skip list into the next (hc-a580a,
 * 2026-09-27). Callers that hold a runtime pass `accountKeyScopeFor(instance)`;
 * the ambient default exists for synchronous UI reads only.
 */
import { durableGetItem, durableSetItem } from './durableStorage'
import {
  accountLocalKey,
  accountLocalKeyFor,
  type BoundAccountKeyScope,
} from './accountLocalKeys'

const CHECKPOINT_KEY = storageRegistry.utxoHealCheckpoint.key
const MAX_STORED_TXIDS = 256

/** Settings checkmark + skip full pass when clean within this window. */
export const HEAL_CHECKPOINT_OVERLAP_MS = 6 * 60 * 60_000

/** Minimum gap between silent auto checkpoint passes. */
export const HEAL_AUTO_COOLDOWN_MS = 3 * 60_000

/** Historical txids processed per auto pass (missing-first). */
export const HEAL_TXID_BATCH_SIZE = 24

export type UtxoHealCheckpointSource = 'manual' | 'auto' | 'send-cleanup'

export type UtxoHealCheckpoint = {
  at: number
  txids: string[]
  recoveredSats: number
  pendingChangeAfter: number
  source: UtxoHealCheckpointSource
}

/** Account the checkpoint belongs to; `undefined` = the ambient bound scope. */
export type HealCheckpointOwner = BoundAccountKeyScope | undefined

function checkpointKey(owner: HealCheckpointOwner): string {
  return owner
    ? accountLocalKeyFor(CHECKPOINT_KEY, owner)
    : accountLocalKey(CHECKPOINT_KEY)
}

let lastAutoAttemptAt = 0

export function __resetHealCheckpointForTests(): void {
  lastAutoAttemptAt = 0
  durableSetItem(accountLocalKey(CHECKPOINT_KEY), '')
}

/** Reset the account-local auto-attempt cooldown when switching vault accounts. */
export function rebindUtxoHealCheckpointForAccount(): void {
  lastAutoAttemptAt = 0
}

export function readHealCheckpoint(
  owner?: HealCheckpointOwner,
): UtxoHealCheckpoint | null {
  try {
    const raw = durableGetItem(checkpointKey(owner))
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

export function writeHealCheckpoint(
  next: UtxoHealCheckpoint,
  owner?: HealCheckpointOwner,
): void {
  const txids = [...new Set(next.txids.map((t) => t.toLowerCase()))].slice(
    -MAX_STORED_TXIDS,
  )
  durableSetItem(
    checkpointKey(owner),
    JSON.stringify({
      ...next,
      txids,
    }),
  )
}

export function healCheckpointAgeMs(
  now = Date.now(),
  owner?: HealCheckpointOwner,
): number | null {
  const cp = readHealCheckpoint(owner)
  if (!cp) return null
  return Math.max(0, now - cp.at)
}

/** True when a recent pass reported clean balance (overlap window). */
export function healCheckpointFresh(
  now = Date.now(),
  overlapMs = HEAL_CHECKPOINT_OVERLAP_MS,
  owner?: HealCheckpointOwner,
): boolean {
  const cp = readHealCheckpoint(owner)
  if (!cp) return false
  if (now - cp.at > overlapMs) return false
  return cp.pendingChangeAfter <= 0
}

export function mergeTxidsWithCheckpoint(
  current: Set<string>,
  owner?: HealCheckpointOwner,
): Set<string> {
  const merged = new Set(current)
  for (const txid of readHealCheckpoint(owner)?.txids ?? []) {
    merged.add(txid.toLowerCase())
  }
  return merged
}

export function txidsMissingFromCheckpoint(
  current: Set<string>,
  owner?: HealCheckpointOwner,
): string[] {
  const prev = new Set(
    (readHealCheckpoint(owner)?.txids ?? []).map((t) => t.toLowerCase()),
  )
  return [...current].filter((t) => !prev.has(t.toLowerCase()))
}

export function canRunAutoHealCheckpoint(now = Date.now()): boolean {
  return now - lastAutoAttemptAt >= HEAL_AUTO_COOLDOWN_MS
}

export function markAutoHealAttempt(now = Date.now()): void {
  lastAutoAttemptAt = now
}

/** Merge newly processed txids into checkpoint without waiting for full pass. */
export function appendHealCheckpointBatch(
  processedTxids: string[],
  partial: {
    pendingChangeAfter: number
    recoveredSats: number
    source: UtxoHealCheckpointSource
  },
  owner?: HealCheckpointOwner,
): void {
  if (processedTxids.length === 0) return
  const prev = readHealCheckpoint(owner)
  const merged = new Set([
    ...(prev?.txids ?? []),
    ...processedTxids.map((t) => t.toLowerCase()),
  ])
  writeHealCheckpoint(
    {
      at: Date.now(),
      txids: [...merged],
      recoveredSats: Math.max(partial.recoveredSats, prev?.recoveredSats ?? 0),
      pendingChangeAfter: partial.pendingChangeAfter,
      source: partial.source,
    },
    owner,
  )
}
