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

/**
 * Who was going to broadcast this send. A 404 means opposite things per path:
 * we failed, or the payee simply has not broadcast yet.
 */
export type SentItemSettle = 'senderBroadcast' | 'peerDeliver'

/**
 * A send we broadcast ourselves should be findable in seconds, so a 404 past
 * this window is a real ghost. A `peerDeliver` settle is broadcast by the
 * **payee** — they may be offline for hours — so treating an early 404 as a
 * ghost hands the item back to the sender while the transfer is still in
 * flight, and (before this grace existed) deleted the only Activity record of
 * it. Past this window the payee has almost certainly dropped it; the blunt
 * {@link SENT_HIDE_MS} expiry would return the tip a few hours later anyway.
 */
export const SENDER_GHOST_GRACE_MS = 2 * 60_000
export const PEER_DELIVER_GHOST_GRACE_MS = 12 * 60 * 60_000

export type SentItemRecord = {
  at: number
  /** Sending transaction, for log correlation. */
  txid?: string
  /** Broadcaster for this send. Legacy rows read as `senderBroadcast`. */
  settle: SentItemSettle
}

/** Explicit fate for one hidden send, so a 404 never silently un-hides. */
export type GhostHealFate =
  | { kind: 'keep'; reason: 'onChain' | 'inconclusive' | 'withinGrace' }
  | {
      kind: 'restore'
      reason: 'senderNeverBroadcast' | 'peerNeverBroadcast'
      /**
       * Only a send we were supposed to broadcast leaves a row worth deleting.
       * A peerDeliver row is the sender's only record that the tip left, so it
       * survives the restore.
       */
      dropActivity: boolean
    }

export function ghostHealFate(args: {
  settle: SentItemSettle
  ageMs: number
  onChain: boolean | null
}): GhostHealFate {
  if (args.onChain !== false) {
    return {
      kind: 'keep',
      reason: args.onChain === true ? 'onChain' : 'inconclusive',
    }
  }
  const peer = args.settle === 'peerDeliver'
  const grace = peer ? PEER_DELIVER_GHOST_GRACE_MS : SENDER_GHOST_GRACE_MS
  if (args.ageMs < grace) return { kind: 'keep', reason: 'withinGrace' }
  return peer
    ? { kind: 'restore', reason: 'peerNeverBroadcast', dropActivity: false }
    : { kind: 'restore', reason: 'senderNeverBroadcast', dropActivity: true }
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
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return records
    for (const [op, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (!op.includes('.')) continue
      const row = (value ?? {}) as {
        at?: unknown
        txid?: unknown
        settle?: unknown
      }
      const at =
        typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : 0
      records.set(op, {
        at,
        txid:
          typeof row.txid === 'string' && row.txid.trim()
            ? row.txid.trim()
            : undefined,
        settle:
          row.settle === 'peerDeliver' ? 'peerDeliver' : 'senderBroadcast',
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
  outpoints: Array<
    string | { outpoint: string; txid?: string; settle?: SentItemSettle }
  >,
): void {
  if (outpoints.length === 0) return
  const records = new Map(readSent())
  const at = Date.now()
  let marked = 0
  for (const raw of outpoints) {
    const entry = typeof raw === 'string' ? { outpoint: raw } : raw
    const op = key(entry.outpoint)
    if (!op) continue
    const settle: SentItemSettle = entry.settle ?? 'senderBroadcast'
    records.set(
      op,
      entry.txid
        ? { at, txid: entry.txid.trim().toLowerCase(), settle }
        : { at, settle },
    )
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

/**
 * Tips the holder deliberately forgot, kept forever.
 *
 * {@link SENT_HIDE_MS} expiry is right for a send — an item that never left has
 * to come back rather than vanish. Abandon is the opposite intent: the holder
 * chose to drop a tip that is still live on our address (a covenant lock we
 * cannot spend). Until the import guard learned to heal orphans, the durable
 * "already imported" mark made that stick by accident; now that Refresh
 * re-claims live-on-address orphans, abandon needs a record of its own or the
 * tip walks back in a day later.
 */
const ABANDONED_KEY = 'handcash.collectables.abandonedOutpoints.v1'
const MAX_ABANDONED = 2000

function readAbandoned(): Set<string> {
  try {
    const raw = durableGetItem(ABANDONED_KEY)
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

export function markItemAbandoned(outpoint: string): void {
  const op = key(outpoint)
  if (!op) return
  const abandoned = readAbandoned()
  if (abandoned.has(op)) return
  abandoned.add(op)
  durableSetItem(
    ABANDONED_KEY,
    JSON.stringify([...abandoned].slice(-MAX_ABANDONED)),
  )
}

export function isItemAbandoned(outpoint: string): boolean {
  const op = key(outpoint)
  if (!op) return false
  return readAbandoned().has(op)
}

/**
 * What this wallet recorded when it sent the tip — who was going to broadcast,
 * and when. Callers deciding whether a stalled send may be retried or cleared
 * need the settle path: a `peerDeliver` transfer is the payee's to broadcast, so
 * it is legitimately absent from the chain long after a sender-broadcast one
 * would be a ghost.
 */
export function getSentItemRecord(outpoint: string): SentItemRecord | null {
  const op = key(outpoint)
  if (!op) return null
  return readSent().get(op) ?? null
}

/**
 * True while the counterparty could still put this transfer on chain.
 *
 * Mirrors {@link ghostHealFate}'s grace windows so the two never disagree —
 * offering "clear" on a transfer that the ghost healer is still patiently
 * waiting on is how a sender deletes the only record of an item that later
 * lands in the recipient's wallet.
 */
export function counterpartyMaySettle(
  outpoint: string,
  now = Date.now(),
): boolean {
  const record = getSentItemRecord(outpoint)
  if (!record) return false
  const grace =
    record.settle === 'peerDeliver'
      ? PEER_DELIVER_GHOST_GRACE_MS
      : SENDER_GHOST_GRACE_MS
  return now - record.at < grace
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
 * *and* past the grace window for who was supposed to broadcast it. Returns
 * the outpoints restored.
 *
 * A sender-broadcast ghost also loses its Activity "Sent" / Verifying rows and
 * gets tip-hint re-pins suppressed — otherwise the feed keeps a Sent link that
 * 404s on WoC while a later successful transfer (different txid) already moved
 * the tip. A `peerDeliver` restore keeps its rows: the tip left this basket and
 * the row is the only local record of the transfer.
 *
 * Abandon markers (`abandon:…`) are left alone — those are intentional hides.
 */
export async function healGhostSentItems(
  chain: import('./vault').Chain,
  existsOnChain: (
    txid: string,
    chain: import('./vault').Chain,
  ) => Promise<boolean | null>,
  now = Date.now(),
): Promise<string[]> {
  const records = readSent()
  const byTx = new Map<
    string,
    { ops: string[]; at: number; settle: SentItemSettle }
  >()
  for (const [op, rec] of records) {
    const tx = rec.txid?.trim().toLowerCase() ?? ''
    if (!tx || tx.startsWith('abandon:')) continue
    if (!/^[0-9a-f]{64}$/.test(tx)) continue
    const group = byTx.get(tx)
    if (!group) {
      byTx.set(tx, { ops: [op], at: rec.at, settle: rec.settle })
      continue
    }
    group.ops.push(op)
    // Newest mark and the more patient settle both bias toward waiting.
    group.at = Math.max(group.at, rec.at)
    if (rec.settle === 'peerDeliver') group.settle = 'peerDeliver'
  }
  if (byTx.size === 0) return []

  const healed: string[] = []
  const ghostTxids: string[] = []
  for (const [txid, group] of byTx) {
    const fate = ghostHealFate({
      settle: group.settle,
      ageMs: now - group.at,
      onChain: await existsOnChain(txid, chain),
    })
    if (fate.kind === 'keep') continue
    console.info(
      `[sent-item-guard] restore ${group.ops.length} tip(s) reason=${fate.reason} txid=${txid}`,
    )
    forgetItemsSent(group.ops)
    healed.push(...group.ops)
    if (fate.dropActivity) ghostTxids.push(txid)
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
