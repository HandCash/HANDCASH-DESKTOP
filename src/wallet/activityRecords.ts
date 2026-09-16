/**
 * One transaction is one Activity record.
 *
 * A market listing writes the listing event *and* the held item that replaced the
 * tip; a purchase writes the money leg and the received item; a sale writes the
 * sold item and its proceeds. Rendered raw, each of those reads as two unrelated
 * rows for a single thing that happened. Compose them instead: the record keeps
 * the subject that names it, the money leg that prices it, and one row per
 * additional distinct asset — a multi-asset transaction stays multi-row inside a
 * single record rather than fragmenting into unrelated buttons.
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
  /** Everything folded here, subject first. */
  entries: ActivityEntry[]
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
  const marketKeys = marketTransactions(entries)
  const key = foldKeyOf(chooseActivityFold(entry, marketKeys))
  if (!key || isMoneyLeg(entry)) return null
  return pickMoneyLeg(
    entries.filter(
      (candidate) =>
        candidate.id !== entry.id &&
        foldKeyOf(chooseActivityFold(candidate, marketKeys)) === key,
    ),
  )
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
      entries: [subject, ...rest],
    }
  })
}
