/**
 * Which wallet job wrote each item transaction.
 *
 * A job's Activity rows carry its id and fold into one record. Stored rows are
 * trimmed to fit storage, and the ledger then shows those transactions bare —
 * one "Migrate 25 ordinals" row each. This index outlives the trim, so the
 * projection can still fold them under the job that wrote them.
 */
import { storageRegistry } from '../storage/registry'
import { accountLocalKey } from './accountLocalKeys'
import { durableGetItem, durableSetItem } from './durableStorage'

const KEY_BASE = storageRegistry.activityJobTxids.key
/** 15,000 items at 25 per transaction; older runs fall back to their descriptions. */
const MAX_TXIDS = 600

const TXID = /^[0-9a-f]{64}$/

/** txid → job id, oldest first. */
type Index = Map<string, string>

let cache: { key: string; index: Index } | null = null
let generation = 0

/** Changes whenever the index may answer {@link jobOfTxid} differently. */
export function jobIndexGeneration(): number {
  return generation
}

function storageKey(): string | null {
  try {
    return accountLocalKey(KEY_BASE)
  } catch {
    return null
  }
}

function load(): Index {
  const key = storageKey()
  if (!key) return new Map()
  if (cache?.key === key) return cache.index
  const index: Index = new Map()
  try {
    const parsed = JSON.parse(durableGetItem(key) ?? '{}') as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [job, txids] of Object.entries(parsed)) {
        if (!Array.isArray(txids)) continue
        for (const txid of txids) if (typeof txid === 'string' && TXID.test(txid)) index.set(txid, job)
      }
    }
  } catch {
    // A corrupt index costs the fold of trimmed rows, nothing else.
  }
  cache = { key, index }
  generation += 1
  return index
}

function persist(key: string, index: Index): void {
  const byJob: Record<string, string[]> = {}
  for (const [txid, job] of index) (byJob[job] ??= []).push(txid)
  try {
    durableSetItem(key, JSON.stringify(byJob))
  } catch {
    // Best effort; the stored rows still carry the job id.
  }
}

/** Remember that `jobId` wrote these transactions. */
export function noteJobTxids(jobId: string, txids: readonly string[]): void {
  const key = storageKey()
  if (!key || !jobId) return
  const index = load()
  let changed = false
  for (const raw of txids) {
    const txid = raw.trim().toLowerCase()
    if (!TXID.test(txid) || index.get(txid) === jobId) continue
    index.delete(txid)
    index.set(txid, jobId)
    changed = true
  }
  if (!changed) return
  generation += 1
  for (const txid of index.keys()) {
    if (index.size <= MAX_TXIDS) break
    index.delete(txid)
  }
  persist(key, index)
}

export function jobOfTxid(txid: string | undefined): string | null {
  if (!txid) return null
  return load().get(txid.trim().toLowerCase()) ?? null
}

/** The description of a transaction that migrates imported tips into this wallet. */
export function itemMigrateTxDescription(count: number, firstOutpoint: string): string {
  return count === 1 ? `Migrate ordinal ${firstOutpoint.slice(0, 18)}…` : `Migrate ${count} ordinals from phrase`
}

const ITEM_MIGRATE_TX = /^Migrate (?:ordinal \S+…|\d+ ordinals from phrase)$/

/** True for every description {@link itemMigrateTxDescription} has written. */
export function isItemMigrateTxDescription(text: string | undefined): boolean {
  return ITEM_MIGRATE_TX.test(text?.trim() ?? '')
}

export function resetActivityJobIndexForTests(): void {
  cache = null
  generation += 1
}
