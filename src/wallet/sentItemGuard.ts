/**
 * Outpoints a send just spent (or filed as outbound remittance), hidden from
 * inventory until the chain agrees.
 *
 * Soft-latch `createAction` puts the recipient tip in *this* wallet's `1sat`
 * basket for remittance metadata. That tip is not ownership — mark it sent on
 * outbound transfers so post-send list (which often runs with a cleared address
 * scan cache) cannot toast "Item received" on the sender.
 *
 * `relinquishOutput` usually throws right after a send — `createAction` already
 * marked the tip spent — and `listOutputs` keeps returning it until a spendable
 * review runs, which is throttled and paused after legacy sweeps. Without this
 * guard the optimistic cache prune is undone by the very next list, so a sent
 * collectable looks like it never left the sender's wallet.
 *
 * Keyed by outpoint, which can never legitimately be ours again once spent, so
 * receiving the same ordinal back (a new outpoint) still shows up. Entries
 * expire in case the send never confirmed and the item really is still ours.
 */
import { durableGetItem, durableSetItem } from './durableStorage'

const STORAGE_KEY = 'handcash.collectables.sentOutpoints.v1'
const MAX_ENTRIES = 500

/** A send that never landed has to give the item back rather than hide it forever. */
export const SENT_HIDE_MS = 24 * 60 * 60_000

export type SentItemRecord = {
  at: number
  /** Sending transaction, for log correlation. */
  txid?: string
}

/**
 * Last parse, keyed by the exact stored string. `listCollectables` asks about
 * every output it lists, so this must not re-parse per item. Shared — mutators
 * copy before writing.
 */
let cachedRaw: string | null = null
let cachedRecords = new Map<string, SentItemRecord>()

function readSent(): Map<string, SentItemRecord> {
  const records = new Map<string, SentItemRecord>()
  try {
    const raw = durableGetItem(STORAGE_KEY)
    if (!raw) return records
    if (raw === cachedRaw) return cachedRecords
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return records
    for (const [op, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!op.includes('.')) continue
      const row = (value ?? {}) as { at?: unknown; txid?: unknown }
      const at = typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : 0
      records.set(op, {
        at,
        txid: typeof row.txid === 'string' && row.txid.trim() ? row.txid.trim() : undefined,
      })
    }
    cachedRaw = raw
    cachedRecords = records
  } catch {
    /* no usable state */
  }
  return records
}

function writeSent(records: Map<string, SentItemRecord>): void {
  const now = Date.now()
  const live = [...records.entries()]
    .filter(([, r]) => now - r.at < SENT_HIDE_MS)
    .sort((a, b) => a[1].at - b[1].at)
    .slice(-MAX_ENTRIES)
  durableSetItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(live)))
}

function key(outpoint: string): string {
  return outpoint.trim().toLowerCase().replace('_', '.')
}

/** Hide outpoints a send just spent. Call only once the send has a txid. */
export function markItemsSent(
  outpoints: Array<string | { outpoint: string; txid?: string }>,
): void {
  if (outpoints.length === 0) return
  const records = new Map(readSent())
  const at = Date.now()
  let marked = 0
  for (const raw of outpoints) {
    const entry = typeof raw === 'string' ? { outpoint: raw } : raw
    const op = key(entry.outpoint)
    if (!op) continue
    records.set(op, entry.txid ? { at, txid: entry.txid.trim().toLowerCase() } : { at })
    marked += 1
  }
  if (marked > 0) writeSent(records)
}

export function isItemSent(outpoint: string, now = Date.now()): boolean {
  const op = key(outpoint)
  if (!op) return false
  const record = readSent().get(op)
  if (!record) return false
  return now - record.at < SENT_HIDE_MS
}

/** Un-hide — for a send that turned out not to have spent these after all. */
export function forgetItemsSent(outpoints: string[]): void {
  if (outpoints.length === 0) return
  const records = new Map(readSent())
  let changed = false
  for (const raw of outpoints) {
    if (records.delete(key(raw))) changed = true
  }
  if (changed) writeSent(records)
}

/**
 * Drop hide marks whose recorded spend txid is proven absent from the chain
 * (ghost delayed-broadcast / failed post). Returns the outpoints restored.
 *
 * Also strips Activity "Sent" / Verifying rows for those txids and suppresses
 * tip-hint re-pins — otherwise the feed keeps a Sent link that 404s on WoC
 * while a later successful transfer (different txid) already moved the tip.
 *
 * Abandon markers (`abandon:…`) are left alone — those are intentional hides.
 */
export async function healGhostSentItems(
  chain: import('./vault').Chain,
  existsOnChain: (
    txid: string,
    chain: import('./vault').Chain,
  ) => Promise<boolean | null>,
): Promise<string[]> {
  const records = readSent()
  const byTx = new Map<string, string[]>()
  for (const [op, rec] of records) {
    const tx = rec.txid?.trim().toLowerCase() ?? ''
    if (!tx || tx.startsWith('abandon:')) continue
    if (!/^[0-9a-f]{64}$/.test(tx)) continue
    const list = byTx.get(tx) ?? []
    list.push(op)
    byTx.set(tx, list)
  }
  if (byTx.size === 0) return []

  const healed: string[] = []
  const ghostTxids: string[] = []
  for (const [txid, ops] of byTx) {
    if ((await existsOnChain(txid, chain)) !== false) continue
    forgetItemsSent(ops)
    healed.push(...ops)
    ghostTxids.push(txid)
  }
  if (ghostTxids.length > 0) {
    try {
      const { rememberGhostTx } = await import('./ghostTxSuppress')
      const { removeActivityForTxids } = await import('./appActivity')
      for (const txid of ghostTxids) rememberGhostTx(txid)
      removeActivityForTxids(ghostTxids)
    } catch (err) {
      console.warn('[sent-item-guard] activity ghost cleanup skipped', err)
    }
  }
  return healed
}

/** Test-only */
export function resetSentItemsForTests(): void {
  durableSetItem(STORAGE_KEY, '{}')
}
