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
import { accountLocalKey } from './accountLocalKeys'
import { durableGetItem, durableSetItem } from './durableStorage'
import {
  signedTxSpendConflictIsProven,
  txHadArcadeSubmitContact,
} from './arcadeSubmitGuard'

/**
 * Scoped per vault account. These marks say what *this* account did with an
 * outpoint — sent it, burned it, abandoned it — and every one of them hides
 * the outpoint from inventory. Shared across accounts they crossed the wires
 * of a same-device transfer: account A sending to account B recorded B's tip
 * as "sent", so B's own basket read filtered out the tip it had just received
 * and the card could never paint.
 */
const STORAGE_KEY_BASE = 'handcash.collectables.sentOutpoints.v1'
const MAX_ENTRIES = 500
const CONSUMED_KEY_BASE = 'handcash.collectables.consumedOutpoints.v1'
const MAX_CONSUMED = 2000

function storageKey(): string {
  return accountLocalKey(STORAGE_KEY_BASE)
}

function consumedKey(): string {
  return accountLocalKey(CONSUMED_KEY_BASE)
}

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
    const raw = durableGetItem(storageKey())
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
  durableSetItem(storageKey(), JSON.stringify(Object.fromEntries(live)))
}

function key(outpoint: string): string {
  return outpoint.trim().toLowerCase().replace('_', '.')
}

let cachedConsumedRaw: string | null = null
let cachedConsumed = new Set<string>()

function readConsumed(): Set<string> {
  try {
    const raw = durableGetItem(consumedKey())
    if (!raw) return new Set()
    if (raw === cachedConsumedRaw) return cachedConsumed
    const parsed = JSON.parse(raw) as unknown
    const consumed = new Set(
      Array.isArray(parsed)
        ? parsed
            .filter((value): value is string => typeof value === 'string')
            .map(key)
            .filter(Boolean)
        : [],
    )
    cachedConsumedRaw = raw
    cachedConsumed = consumed
    return consumed
  } catch {
    return new Set()
  }
}

/** Permanently suppress tips destroyed by a confirmed wallet burn. */
export function markItemsConsumed(outpoints: string[]): void {
  if (outpoints.length === 0) return
  const consumed = new Set(readConsumed())
  let changed = false
  for (const outpoint of outpoints) {
    const op = key(outpoint)
    if (op && !consumed.has(op)) {
      consumed.add(op)
      changed = true
    }
  }
  if (!changed) return
  durableSetItem(
    consumedKey(),
    JSON.stringify([...consumed].slice(-MAX_CONSUMED)),
  )
}

export function isItemConsumed(outpoint: string): boolean {
  const op = key(outpoint)
  return Boolean(op) && readConsumed().has(op)
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
  const spent: string[] = []
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
    spent.push(op)
  }
  if (spent.length === 0) return
  writeSent(records)
  void import('./marketListing')
    .then(({ invalidateMarketListingsForSpentOutpoints }) => {
      invalidateMarketListingsForSpentOutpoints(spent)
    })
    .catch(() => {
      /* listing module optional at boot */
    })
}

export function isItemSent(outpoint: string, now = Date.now()): boolean {
  if (isItemConsumed(outpoint)) return true
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
const ABANDONED_KEY_BASE = 'handcash.collectables.abandonedOutpoints.v1'
const MAX_ABANDONED = 2000

function abandonedKey(): string {
  return accountLocalKey(ABANDONED_KEY_BASE)
}

let cachedAbandonedRaw: string | null = null
let cachedAbandoned = new Set<string>()

/** Read-only — `isItemAbandoned` runs per outpoint inside list loops. */
function readAbandoned(): Set<string> {
  try {
    const raw = durableGetItem(abandonedKey())
    if (!raw) return new Set()
    if (raw === cachedAbandonedRaw) return cachedAbandoned
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    const set = new Set(
      parsed.filter((x): x is string => typeof x === 'string' && x.includes('.')),
    )
    cachedAbandonedRaw = raw
    cachedAbandoned = set
    return set
  } catch {
    return new Set()
  }
}

export function markItemAbandoned(outpoint: string): void {
  const op = key(outpoint)
  if (!op) return
  const abandoned = new Set(readAbandoned())
  if (abandoned.has(op)) return
  abandoned.add(op)
  durableSetItem(
    abandonedKey(),
    JSON.stringify([...abandoned].slice(-MAX_ABANDONED)),
  )
}

export function isItemAbandoned(outpoint: string): boolean {
  const op = key(outpoint)
  if (!op) return false
  return readAbandoned().has(op)
}

/**
 * What this wallet recorded when it sent the tip. New sends are always
 * `senderBroadcast`; `peerDeliver` remains only for rows written by older
 * builds whose payee-first grace must be preserved during migration.
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
 * Drop hide marks only when the recorded spend has a proven competing input
 * spend and is past the settle grace. Returns the outpoints restored.
 *
 * A sender-broadcast conflict also loses its Activity "Sent" / Verifying rows.
 * A `peerDeliver` restore keeps its rows: the tip left this basket and the row
 * is the only local record of the transfer.
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
    const onChain = await existsOnChain(txid, chain)
    const fate = ghostHealFate({
      settle: group.settle,
      ageMs: now - group.at,
      onChain,
    })
    if (fate.kind === 'keep') continue
    // Absence is latency. Return the tip only when another transaction
    // conclusively consumed one of this cheque's inputs.
    if (
      !(await signedTxSpendConflictIsProven({
        txid,
        chain,
        knownOnChain: onChain,
      }))
    ) {
      continue
    }
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
      const droppable = ghostTxids.filter((txid) => !txHadArcadeSubmitContact(txid))
      for (const txid of droppable) rememberGhostTx(txid)
      removeActivityForTxids(droppable)
    } catch (err) {
      console.warn('[sent-item-guard] activity ghost cleanup skipped', err)
    }
  }
  return healed
}

/** Swap the hide marks to the active vault account. */
export function rebindSentItemGuardForAccount(): void {
  cachedRaw = null
  cachedRecords = new Map()
  cachedConsumedRaw = null
  cachedConsumed = new Set()
  cachedAbandonedRaw = null
  cachedAbandoned = new Set()
}

/** Test-only */
export function resetSentItemsForTests(): void {
  durableSetItem(storageKey(), '{}')
  durableSetItem(consumedKey(), '[]')
  rebindSentItemGuardForAccount()
}
