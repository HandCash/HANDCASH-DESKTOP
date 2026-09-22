/**
 * One transaction is one Activity record.
 *
 * A market listing writes the listing event *and* the held item that replaced the
 * tip; a purchase writes the money leg and the received item; a sale writes the
 * sold item and its proceeds. Rendered raw, each of those reads as two unrelated
 * rows for a single thing that happened. Compose them instead: the record keeps
 * the subject that names it, the money leg that prices it, and the other distinct
 * assets it moved.
 *
 * A batch send is one thing too. Electing one of five foxes as the subject and
 * listing the rest underneath reads as a single fox with footnotes, so a record
 * that moved several collectables also carries an {@link ActivityBatch}: how many
 * moved, and the series they share when they share one. The row then names the
 * batch ("Sent 5 Pixel Foxes") instead of one arbitrary member.
 *
 * Nothing is dropped from the store: folded entries stay individually addressable
 * through `entries`, so detail panels, seen-marking, and filters still see them.
 */
import {
  activityEntryKey,
  isBurnActivity,
  isEventActivity,
  isFailedActivity,
  type ActivityEntry,
} from './appActivity'

export type ActivityRecord = {
  key: string
  /** Entry that names the record: identity, icon, badge, detail target. */
  subject: ActivityEntry
  /** Money leg of the same transaction when the subject is not itself the money. */
  money: ActivityEntry | null
  /** Additional distinct assets moved by the same transaction. */
  assets: ActivityEntry[]
  /** Set when this record moved more than one distinct collectable. */
  batch: ActivityBatch | null
  /** Everything folded here, subject first. */
  entries: ActivityEntry[]
}

/**
 * A record that moved several collectables at once.
 *
 * `label` is the series every member agrees on, already plural, so the row can
 * say what the batch *is*. Members from different series have no shared name, and
 * naming one of them would be a lie about the other four — the row falls back to
 * the generic noun instead.
 */
export type ActivityBatch = {
  count: number
  label: string | null
}

const MARKET_SUBJECT_METHODS = new Set([
  'market-sale',
  'market-list',
  'market-cancel',
  'market-purchase-receive',
])

const MARKET_METHODS = new Set([
  ...MARKET_SUBJECT_METHODS,
  'market-purchase',
  'market-sale-proceeds',
])

function normalizeInscriptionKey(value: string): string {
  return value.trim().toLowerCase().replace(/\.(\d+)$/, '_$1')
}

function isPendingItemPlaceholder(entry: ActivityEntry): boolean {
  const origin = (entry.item?.origin ?? '').trim().toLowerCase()
  return origin.endsWith('_pending')
}

/**
 * How far a leg may fold into the other legs of its transaction.
 *
 * A market transaction is one deal with legs on both sides — coins out, item in,
 * change back — so all of it belongs in one record. An ordinary transaction is
 * not: paying yourself moves coins out *and* brings coins in, and those are two
 * facts about your wallet. Folding by transaction alone hid one of them behind
 * the other, which is why a self-send rendered as a single row.
 */
export type ActivityFold =
  | { kind: 'solo' }
  /** Every leg of one market transaction, whichever way its value moved. */
  | { kind: 'transaction'; key: string }
  /** Legs of one transaction that move value the same way. */
  | { kind: 'direction'; key: string }
  /**
   * Legs of one in-flight multi-item send, before a txid exists to fold by.
   * Sending 25 foxes is one thing happening, not 25 things.
   */
  | { kind: 'sendGroup'; key: string }

function txidOf(entry: ActivityEntry): string | null {
  const txid = (entry.txid ?? '').trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(txid) ? txid : null
}

/** Which way this leg moved value — an event moves none. */
function directionOf(entry: ActivityEntry): 'in' | 'out' | 'event' {
  if (entry.kind === 'earned') return 'in'
  if (entry.kind === 'spent') return 'out'
  return 'event'
}

/** Transactions that carry a market leg, and so fold across directions. */
function marketTransactions(entries: readonly ActivityEntry[]): Set<string> {
  const keys = new Set<string>()
  for (const entry of entries) {
    if (isFailedActivity(entry) || !MARKET_METHODS.has(entry.method)) continue
    const txid = txidOf(entry)
    if (txid) keys.add(`${entry.origin}|${txid}`)
  }
  return keys
}

export function chooseActivityFold(
  entry: ActivityEntry,
  marketKeys: ReadonlySet<string>,
): ActivityFold {
  // Failed send legs are cleared and retried independently. A grouped burn is
  // one atomic transaction attempt with no per-NFT retry, so its members must
  // remain one truthful failed record rather than exploding into N rows.
  if (isFailedActivity(entry)) {
    const group = (entry.sendGroupId ?? '').trim()
    return isBurnActivity(entry) && group
      ? { kind: 'sendGroup', key: `${entry.origin}|send-group:${group}` }
      : { kind: 'solo' }
  }
  const txid = txidOf(entry)
  if (!txid) {
    // No txid yet — the send group is the transaction's identity in flight.
    const group = (entry.sendGroupId ?? '').trim()
    return group
      ? { kind: 'sendGroup', key: `${entry.origin}|send-group:${group}` }
      : { kind: 'solo' }
  }
  const key = `${entry.origin}|${txid}`
  if (marketKeys.has(key)) return { kind: 'transaction', key }
  return { kind: 'direction', key: `${key}|${directionOf(entry)}` }
}

function foldKeyOf(fold: ActivityFold): string | null {
  return fold.kind === 'solo' ? null : fold.key
}

/** Edition marker at the end of a mint name: `#8413557`, ` 12`, `_003`. */
const EDITION_SUFFIX = /[\s._\-–—]*#?\d[\d,]*$/

/** "Pixel Foxes #8413557" → "Pixel Foxes": editions differ, the series does not. */
function seriesOf(entry: ActivityEntry): string | null {
  const name = entry.item?.name?.trim()
  if (!name) return null
  return name.replace(EDITION_SUFFIX, '').trim() || null
}

/** A batch is always more than one, so the series is always spoken plural. */
function pluralOf(series: string): string {
  if (/s$/i.test(series)) return series
  if (/(x|z|ch|sh)$/i.test(series)) return `${series}es`
  if (/[^aeiou]y$/i.test(series)) return `${series.slice(0, -1)}ies`
  return `${series}s`
}

/** Collectables only: a BSV-21 row already states its own quantity. */
function isCollectableAsset(entry: ActivityEntry): boolean {
  if (!entry.item || entry.item.tokenId) return false
  // `${txid}_pending` is the same receive/send as the settled inscription, not a
  // second fox — counting it made almost every item row wear a batch "2".
  if (isPendingItemPlaceholder(entry)) return false
  return true
}

/** Batch count/label from members as they should be named on screen. */
export function activityBatchOf(
  members: readonly ActivityEntry[],
): ActivityBatch | null {
  return chooseActivityBatch(members)
}

/** Every key a leg states for its asset: token id, genesis origin, outpoint. */
function assetKeys(entry: ActivityEntry): string[] {
  const item = entry.item
  if (!item) return []
  const keys: string[] = []
  const tokenId = (item.tokenId ?? '').trim().toLowerCase()
  if (tokenId) keys.push(`token:${tokenId}`)
  const origin = (item.origin ?? '').trim()
  if (origin && !origin.toLowerCase().endsWith('_pending')) {
    keys.push(`origin:${normalizeInscriptionKey(origin)}`)
  }
  const point = (item.outpoint ?? '').trim()
  if (point) keys.push(`point:${normalizeInscriptionKey(point)}`)
  return keys
}

/**
 * How many collectables these legs actually name.
 *
 * One collectable reaches a record under more than one key: a listing names the
 * genesis origin and the outpoint the listing created, while the held row for the
 * same fox may only know one of the two. Counting legs made a single listed item
 * wear a batch "2", so legs are grouped by every key they share and counted once
 * per group. Distinct items share no key, so a real batch still counts in full.
 */
function distinctAssetGroups(items: readonly ActivityEntry[]): number {
  const groups: Set<string>[] = []
  for (const entry of items) {
    const keys = assetKeys(entry)
    if (keys.length === 0) {
      groups.push(new Set())
      continue
    }
    const merged = new Set(keys)
    for (let i = groups.length - 1; i >= 0; i -= 1) {
      if (keys.some((key) => groups[i]!.has(key))) {
        for (const key of groups[i]!) merged.add(key)
        groups.splice(i, 1)
      }
    }
    groups.push(merged)
  }
  return groups.length
}

function chooseActivityBatch(
  members: readonly ActivityEntry[],
): ActivityBatch | null {
  const items = members.filter(isCollectableAsset)
  const count = distinctAssetGroups(items)
  if (count < 2) return null
  const series = new Set(items.map((entry) => seriesOf(entry) ?? ''))
  const shared = series.size === 1 ? [...series][0]! : ''
  return { count, label: shared ? pluralOf(shared) : null }
}

/** How a batched record names itself: "5 Pixel Foxes", "3 collectables". */
export function activityBatchName(batch: ActivityBatch): string {
  return `${batch.count.toLocaleString()} ${batch.label ?? 'collectables'}`
}

function subjectRank(entry: ActivityEntry): number {
  if (MARKET_SUBJECT_METHODS.has(entry.method)) return 0
  if (entry.item) return 1
  if (MARKET_METHODS.has(entry.method)) return 2
  if (!isEventActivity(entry)) return 3
  return 4
}

/** The row that carries the value of a market record (price paid, proceeds in). */
function isMoneyLeg(entry: ActivityEntry): boolean {
  return !entry.item && !isEventActivity(entry) && entry.sats > 0
}

const MARKET_MONEY_METHODS = new Set(['market-purchase', 'market-sale-proceeds'])

/** Price beats any other coin row on the same transaction, change included. */
function moneyRank(entry: ActivityEntry): number {
  return MARKET_MONEY_METHODS.has(entry.method) ? 0 : 1
}

function pickMoneyLeg(entries: readonly ActivityEntry[]): ActivityEntry | null {
  const legs = entries.filter(isMoneyLeg)
  if (legs.length === 0) return null
  return [...legs].sort((a, b) => moneyRank(a) - moneyRank(b))[0]!
}

/**
 * Money leg of the same transaction as `entry` — what a bought item cost, or what
 * a sold item brought in. Detail panels open one entry but should still price the
 * whole record.
 */
export function moneyLegForEntry(
  entry: ActivityEntry,
  entries: readonly ActivityEntry[],
): ActivityEntry | null {
  if (isMoneyLeg(entry)) return null
  return pickMoneyLeg(siblingsOf(entry, entries))
}

/** The other legs folded into the same record as `entry`. */
function siblingsOf(
  entry: ActivityEntry,
  entries: readonly ActivityEntry[],
): ActivityEntry[] {
  const marketKeys = marketTransactions(entries)
  const key = foldKeyOf(chooseActivityFold(entry, marketKeys))
  if (!key) return []
  return entries.filter(
    (candidate) =>
      candidate.id !== entry.id &&
      foldKeyOf(chooseActivityFold(candidate, marketKeys)) === key,
  )
}

/**
 * The other collectables this transaction moved.
 *
 * The feed names a batch by count and series; the individual names belong in the
 * detail view, which opens one member and would otherwise show no trace of the
 * rest.
 */
export function batchSiblingsForEntry(
  entry: ActivityEntry,
  entries: readonly ActivityEntry[],
): ActivityEntry[] {
  if (!isCollectableAsset(entry)) return []
  const seen = new Set(assetKeys(entry))
  const siblings: ActivityEntry[] = []
  for (const candidate of siblingsOf(entry, entries)) {
    if (!isCollectableAsset(candidate)) continue
    const keys = assetKeys(candidate)
    if (keys.length === 0 || keys.some((key) => seen.has(key))) continue
    for (const key of keys) seen.add(key)
    siblings.push(candidate)
  }
  return siblings
}

/** Every independent leg of the transaction this row belongs to. */
export function transactionLegsForEntry(
  entry: ActivityEntry,
  entries: readonly ActivityEntry[],
): ActivityEntry[] {
  const record = composeActivityRecords(entries).find((row) =>
    row.entries.some((leg) => activityEntryKey(leg) === activityEntryKey(entry)),
  )
  return record?.entries ?? [entry]
}

export function composeActivityRecords(
  entries: readonly ActivityEntry[],
): ActivityRecord[] {
  const order: string[] = []
  const buckets = new Map<string, ActivityEntry[]>()
  const marketKeys = marketTransactions(entries)
  for (const entry of entries) {
    const key =
      foldKeyOf(chooseActivityFold(entry, marketKeys)) ??
      `solo|${activityEntryKey(entry)}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(entry)
    else {
      buckets.set(key, [entry])
      order.push(key)
    }
  }
  return order.map((key) => {
    const bucket = buckets.get(key)!
    const subject = [...bucket].sort((a, b) => subjectRank(a) - subjectRank(b))[0]!
    const rest = bucket.filter((entry) => entry !== subject)
    const money = pickMoneyLeg(rest)
    const seen = new Set(assetKeys(subject))
    const assets: ActivityEntry[] = []
    for (const entry of rest) {
      const keys = assetKeys(entry)
      // A second row for the asset already named by the subject is the duplicate
      // this composition exists to remove (listing event + its held item). The
      // two legs need only agree on one key — origin or outpoint — to be one fox.
      if (keys.length === 0 || keys.some((key) => seen.has(key))) continue
      if (isPendingItemPlaceholder(entry)) continue
      for (const key of keys) seen.add(key)
      assets.push(entry)
    }
    return {
      key: activityEntryKey(subject),
      subject,
      money,
      assets,
      batch: chooseActivityBatch([subject, ...assets]),
      entries: [subject, ...rest],
    }
  })
}

/**
 * How far a feed reads before composing. Preview columns must slice *records*,
 * not raw entries — otherwise a 12-fox receive becomes "9 Pixel Foxes" when
 * six newer coin rows already filled a 15-entry cap.
 */
export const ACTIVITY_COMPOSE_WINDOW = 200

export function previewActivityRecords(
  entries: readonly ActivityEntry[],
  maxRecords: number,
): ActivityRecord[] {
  return composeActivityRecords(entries).slice(0, Math.max(0, maxRecords))
}
