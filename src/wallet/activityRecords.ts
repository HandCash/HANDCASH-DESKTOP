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

function assetIdentity(entry: ActivityEntry): string | null {
  const item = entry.item
  if (!item) return null
  const point = (item.outpoint ?? '').trim().toLowerCase()
  const origin = (item.origin ?? '').trim().toLowerCase()
  const tokenId = (item.tokenId ?? '').trim().toLowerCase()
  return tokenId || origin || point || null
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
  const txid = txidOf(entry)
  if (!txid) return { kind: 'solo' }
  // A failed leg must stay its own row: it is cleared and retried on its own.
  if (isFailedActivity(entry)) return { kind: 'solo' }
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
  return Boolean(entry.item && !entry.item.tokenId)
}

function chooseActivityBatch(
  members: readonly ActivityEntry[],
): ActivityBatch | null {
  const items = members.filter(isCollectableAsset)
  if (items.length < 2) return null
  const series = new Set(items.map((entry) => seriesOf(entry) ?? ''))
  const shared = series.size === 1 ? [...series][0]! : ''
  return { count: items.length, label: shared ? pluralOf(shared) : null }
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
  const seen = new Set([assetIdentity(entry)])
  const siblings: ActivityEntry[] = []
  for (const candidate of siblingsOf(entry, entries)) {
    if (!isCollectableAsset(candidate)) continue
    const asset = assetIdentity(candidate)
    if (!asset || seen.has(asset)) continue
    seen.add(asset)
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
    const subjectAsset = assetIdentity(subject)
    const seen = new Set(subjectAsset ? [subjectAsset] : [])
    const assets: ActivityEntry[] = []
    for (const entry of rest) {
      const asset = assetIdentity(entry)
      // A second row for the asset already named by the subject is the duplicate
      // this composition exists to remove (listing event + its held item).
      if (!asset || seen.has(asset)) continue
      seen.add(asset)
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
