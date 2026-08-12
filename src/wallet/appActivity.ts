import { appDisplayName, normalizeAppHost } from './appIdentity'
import { durableGetItem, durableSetItem } from './durableStorage'

const STORAGE_KEY = 'handcash.brc100.appActivity'

/** Money moves plus non-tx wallet actions (connect, deny, add friend, …). */
export type ActivityKind = 'spent' | 'earned' | 'event'

/** In-flight ingest / authenticity. Absent = settled (legacy rows). */
export type ActivityStatus = 'pending' | 'complete'

/** Collectable / NFT / fungible remittance attached to an activity row. */
export type ActivityItem = {
  name: string
  /** NFT origin, or BSV-21 token id when {@link tokenId} is set. */
  origin: string
  outpoint?: string
  imageUrl?: string
  app?: string
  /** When set, this row is a BSV-21 fungible tip (not a 1Sat collectable). */
  tokenId?: string
  /** Integer token units (BSV-21 `amt`); formatted with {@link dec}. */
  amt?: string
  /** Deploy decimals for {@link amt} (0–18). */
  dec?: number
  /** BSV-21 icon inscription outpoint (`txid_vout`) when known. */
  icon?: string
}

export type ActivityEntry = {
  id: string
  origin: string
  kind: ActivityKind
  sats: number
  at: number
  method: string
  note?: string
  txid?: string
  /** Present when this row is an item transfer, not a BSV payment. */
  item?: ActivityItem
  /** Receiving / verifying — Activity shows the row before internalize finishes. */
  status?: ActivityStatus
}

const ACTIVITY_KINDS = new Set<ActivityKind>(['spent', 'earned', 'event'])

export type AppMoneySummary = {
  spent24h: number
  earned24h: number
  spentAll: number
  earnedAll: number
}

/** Origin used for in-wallet Send / Receive (not a connected app). */
export const WALLET_ACTIVITY_ORIGIN = 'handcash'

type ActivityListener = () => void

const listeners = new Set<ActivityListener>()
const DAY_MS = 24 * 60 * 60_000

/**
 * Last parse, keyed by the exact stored string.
 *
 * History runs to 2000 rows and nearly every read here scans the whole list, so
 * re-parsing per call showed up as UI stall. Callers must treat the result as
 * read-only — it is shared.
 */
let parsedRaw: string | null = null
let parsedEntries: ActivityEntry[] = []

function readAll(): ActivityEntry[] {
  try {
    const raw = durableGetItem(STORAGE_KEY)
    if (!raw) return []
    if (raw === parsedRaw) return parsedEntries
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const entries = parsed
      .filter((e): e is ActivityEntry => {
        if (!e || typeof e !== 'object') return false
        const row = e as ActivityEntry
        return (
          typeof row.origin === 'string' &&
          typeof row.sats === 'number' &&
          typeof row.at === 'number' &&
          ACTIVITY_KINDS.has(row.kind) &&
          typeof row.method === 'string'
        )
      })
      .map((e): ActivityEntry => {
        const row = e as ActivityEntry
        const item = normalizeActivityItem(row.item)
        const status: ActivityStatus | undefined =
          row.status === 'pending' ? 'pending' : undefined
        return {
          ...row,
          item: item ?? undefined,
          status,
        }
      })
    parsedRaw = raw
    parsedEntries = entries
    return entries
  } catch {
    return []
  }
}

/** Bumps on every write — activity feed caches must not serve a pre-write snapshot. */
let writeGeneration = 0

/** Monotonic generation for feed cache invalidation (remount-safe). */
export function getActivityWriteGeneration(): number {
  return writeGeneration
}

function writeAll(entries: ActivityEntry[]): void {
  // Cap history so storage stays small.
  const trimmed = entries.slice(-2000)
  writeGeneration += 1
  durableSetItem(STORAGE_KEY, JSON.stringify(trimmed))
  for (const cb of listeners) cb()
}

function activityRowIsItem(
  row: { item?: ActivityItem; method: string },
): boolean {
  return Boolean(row.item) || /collectable|token|1sat|ordinal/i.test(row.method)
}

/** True if we already logged this on-chain (or local) txid. */
export function hasActivityTxid(
  txid: string | undefined | null,
  kind?: ActivityKind,
): boolean {
  const key = txid?.trim().toLowerCase()
  if (!key) return false
  return readAll().some(
    (e) => e.txid?.toLowerCase() === key && (kind == null || e.kind === kind),
  )
}

/** True when a receive/send for this txid has finished ingest (not just verifying). */
export function hasSettledActivityTxid(
  txid: string | undefined | null,
  kind?: ActivityKind,
  opts?: { item?: boolean },
): boolean {
  const key = txid?.trim().toLowerCase()
  if (!key) return false
  return readAll().some((e) => {
    if (e.txid?.toLowerCase() !== key) return false
    if (kind != null && e.kind !== kind) return false
    if (e.status === 'pending') return false
    if (opts?.item != null && activityRowIsItem(e) !== opts.item) return false
    return true
  })
}

export function isPendingActivity(entry: ActivityEntry): boolean {
  return entry.status === 'pending'
}

/** True if we already logged a collectable receive/send for this tip outpoint. */
export function hasActivityItemOutpoint(outpoint: string | undefined | null): boolean {
  const key = outpoint?.trim().toLowerCase().replace('_', '.')
  if (!key) return false
  return readAll().some((e) => {
    const op = e.item?.outpoint?.trim().toLowerCase().replace('_', '.')
    return op === key
  })
}

/** True when this tip outpoint already has a settled activity row. */
export function hasSettledActivityItemOutpoint(
  outpoint: string | undefined | null,
): boolean {
  const key = outpoint?.trim().toLowerCase().replace('_', '.')
  if (!key) return false
  return readAll().some((e) => {
    const op = e.item?.outpoint?.trim().toLowerCase().replace('_', '.')
    return op === key && e.status !== 'pending'
  })
}

export function subscribeAppActivity(cb: ActivityListener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function findActivityMatchIndex(
  entries: ActivityEntry[],
  args: {
    kind: ActivityKind
    txid?: string
    item?: ActivityItem
    method: string
  },
): number {
  const outpoint = args.item?.outpoint?.trim().toLowerCase().replace('_', '.')
  if (outpoint) {
    const byOp = entries.findIndex((e) => {
      const op = e.item?.outpoint?.trim().toLowerCase().replace('_', '.')
      return op === outpoint && e.kind === args.kind
    })
    if (byOp >= 0) return byOp
  }
  const txid = args.txid?.trim().toLowerCase()
  if (!txid) return -1
  const wantItem = activityRowIsItem(args)
  return entries.findIndex((e) => {
    if (e.kind !== args.kind) return false
    if (e.txid?.toLowerCase() !== txid) return false
    return activityRowIsItem(e) === wantItem
  })
}

export function recordAppActivity(args: {
  origin: string | undefined
  kind: ActivityKind
  sats: number
  method: string
  note?: string
  txid?: string
  item?: ActivityItem
  status?: ActivityStatus
}): void {
  upsertAppActivity(args)
}

/**
 * Insert or update a money/item row. Same txid + kind + (item vs BSV) collapses
 * so a verifying receive becomes the settled row instead of a duplicate.
 */
export function upsertAppActivity(args: {
  origin: string | undefined
  kind: ActivityKind
  sats: number
  method: string
  note?: string
  txid?: string
  item?: ActivityItem
  status?: ActivityStatus
}): void {
  const sats = Math.max(0, Math.trunc(args.sats))
  const item = normalizeActivityItem(args.item)
  const isEvent = args.kind === 'event'
  const pending = args.status === 'pending'
  // Item transfers are meaningful even when the tip is only 1 satoshi — never drop them
  // because the money amount is dust. Events (connect, friend, …) may be zero-sats.
  // Pending BSV receives may not know sats yet — still show Verifying… in Activity.
  if (sats <= 0 && !item && !isEvent && !pending) return
  if (isEvent && !(args.note?.trim() || args.method.trim())) return
  const origin = normalizeAppHost(args.origin)
  const txid = args.txid?.trim() || undefined
  const entries = [...readAll()]
  const idx = findActivityMatchIndex(entries, {
    kind: args.kind,
    txid,
    item: item ?? args.item,
    method: args.method,
  })
  if (idx >= 0) {
    const prev = entries[idx]!
    // Never take a settled row back to verifying.
    const nextStatus =
      prev.status !== 'pending' && pending
        ? prev.status
        : args.status === 'complete'
          ? undefined
          : args.status ?? prev.status
    const nextItem = item
      ? prev.item
        ? { ...prev.item, ...item }
        : item
      : prev.item
    entries[idx] = {
      ...prev,
      origin: origin || prev.origin,
      sats: isEvent ? 0 : sats > 0 ? sats : prev.sats,
      method: args.method || prev.method,
      note: args.note ?? prev.note,
      txid: txid || prev.txid,
      ...(nextItem ? { item: nextItem } : {}),
      ...(nextStatus === 'pending' ? { status: 'pending' as const } : { status: undefined }),
    }
    writeAll(entries)
    return
  }
  writeAll([
    ...entries,
    {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      origin,
      kind: args.kind,
      sats: isEvent ? 0 : sats,
      at: Date.now(),
      method: args.method,
      note: args.note,
      txid,
      ...(item ? { item } : {}),
      ...(pending ? { status: 'pending' as const } : {}),
    },
  ])
}

/** Activity row as soon as a peer tip/pay lands — before internalize finishes. */
export function noteInboundReceivePending(args: {
  txid: string
  sats?: number
  item?: boolean
  itemName?: string
  itemOrigin?: string
  outpoint?: string
}): void {
  const txid = args.txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid)) return
  if (args.item) {
    const name = args.itemName?.trim() || 'Collectable'
    const origin = args.itemOrigin?.trim() || `${txid}_0`
    const outpoint = args.outpoint?.trim() || `${txid}.0`
    upsertAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'earned',
      sats: 1,
      method: 'receive-collectable',
      note: `Received ${name}`,
      txid,
      status: 'pending',
      item: { name, origin, outpoint },
    })
    return
  }
  upsertAppActivity({
    origin: WALLET_ACTIVITY_ORIGIN,
    kind: 'earned',
    sats: Math.max(0, Math.trunc(args.sats ?? 0)),
    method: 'receive',
    note: 'Received coins',
    txid,
    status: 'pending',
  })
}

/** Mark a verifying receive as settled (or create the row if ingest skipped pending). */
export function noteInboundReceiveComplete(args: {
  txid: string
  sats?: number
  item?: boolean
  itemName?: string
  itemOrigin?: string
  outpoint?: string
}): void {
  const txid = args.txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid)) return
  if (args.item) {
    const name = args.itemName?.trim() || 'Collectable'
    const origin = args.itemOrigin?.trim() || `${txid}_0`
    const outpoint = args.outpoint?.trim() || `${txid}.0`
    upsertAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'earned',
      sats: 1,
      method: 'receive-collectable',
      note: `Received ${name}`,
      txid,
      status: 'complete',
      item: { name, origin, outpoint },
    })
    return
  }
  upsertAppActivity({
    origin: WALLET_ACTIVITY_ORIGIN,
    kind: 'earned',
    sats: Math.max(0, Math.trunc(args.sats ?? 0)),
    method: 'receive',
    note: 'Received coins',
    txid,
    status: 'complete',
  })
}

/** Non-tx wallet action (permission decision, friend, disconnect, …). */
export function recordWalletEvent(args: {
  origin?: string
  method: string
  note: string
}): void {
  recordAppActivity({
    origin: args.origin ?? WALLET_ACTIVITY_ORIGIN,
    kind: 'event',
    sats: 0,
    method: args.method,
    note: args.note.trim().slice(0, 160),
  })
}

/** True when the row is a permission / friend / other non-money action. */
export function isEventActivity(entry: ActivityEntry): boolean {
  return entry.kind === 'event'
}

function normalizeActivityItem(raw: ActivityItem | undefined): ActivityItem | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const origin = typeof raw.origin === 'string' ? raw.origin.trim() : ''
  if (!name || !origin) return undefined
  const amt =
    typeof raw.amt === 'string' && /^\d+$/.test(raw.amt.trim())
      ? raw.amt.trim()
      : undefined
  const decRaw = raw.dec
  const dec =
    typeof decRaw === 'number' &&
    Number.isInteger(decRaw) &&
    decRaw >= 0 &&
    decRaw <= 18
      ? decRaw
      : undefined
  return {
    name: name.slice(0, 80),
    origin,
    ...(typeof raw.outpoint === 'string' && raw.outpoint.trim()
      ? { outpoint: raw.outpoint.trim() }
      : {}),
    ...(typeof raw.imageUrl === 'string' && raw.imageUrl.trim()
      ? { imageUrl: raw.imageUrl.trim() }
      : {}),
    ...(typeof raw.app === 'string' && raw.app.trim() ? { app: raw.app.trim().slice(0, 40) } : {}),
    ...(typeof raw.tokenId === 'string' && raw.tokenId.trim()
      ? { tokenId: raw.tokenId.trim().toLowerCase() }
      : {}),
    ...(amt ? { amt } : {}),
    ...(dec != null ? { dec } : {}),
    ...(typeof raw.icon === 'string' && raw.icon.trim()
      ? { icon: raw.icon.trim().toLowerCase().replace('.', '_') }
      : {}),
  }
}

/** True when this row is a collectable transfer (not a BSV payment). */
/** True when the row is a collectable / ordinal tip transfer. */
export function isItemActivity(entry: ActivityEntry): boolean {
  if (isTokenActivity(entry)) return true
  return (
    Boolean(entry.item) ||
    entry.method === 'send-collectable' ||
    /collectable|1sat|ordinal/i.test(entry.method)
  )
}

/** True when the row is a BSV-21 fungible tip (Collect → Tokens). */
export function isTokenActivity(entry: ActivityEntry): boolean {
  if (entry.item?.tokenId?.trim()) return true
  return (
    entry.method === 'receive-token' ||
    entry.method === 'send-token' ||
    entry.method === 'mint-token' ||
    /bsv-?21|fungible|receive-token|send-token|mint-token/i.test(entry.method)
  )
}

/** True when this row is a token create / issue (not a transfer). */
export function isMintTokenActivity(entry: ActivityEntry): boolean {
  if (entry.method === 'mint-token') return true
  return isTokenActivity(entry) && /\bmint\b/i.test(entry.note ?? '')
}

/**
 * Format BSV-21 integer `amt` with deploy decimals for activity rows.
 * Kept local so appActivity does not import the full fungibles stack.
 */
export function formatActivityTokenAmt(amt: string, dec = 0): string {
  const safeDec = Number.isInteger(dec) && dec >= 0 && dec <= 18 ? dec : 0
  const digits = String(amt).replace(/\D/g, '') || '0'
  if (safeDec === 0) {
    try {
      return BigInt(digits).toLocaleString('en-US')
    } catch {
      return digits
    }
  }
  const padded = digits.padStart(safeDec + 1, '0')
  const whole = padded.slice(0, -safeDec) || '0'
  const frac = padded.slice(-safeDec).replace(/0+$/, '')
  let wholeFmt = whole
  try {
    wholeFmt = BigInt(whole).toLocaleString('en-US')
  } catch {
    // keep raw
  }
  return frac ? `${wholeFmt}.${frac}` : wholeFmt
}

/** Quantity label for a token row, or null when amt was never stored. */
export function activityTokenQuantity(item: ActivityItem | undefined): string | null {
  if (!item?.amt?.trim()) return null
  return formatActivityTokenAmt(item.amt, item.dec ?? 0)
}

/** Right-column amount for token rows (signed quantity). */
export function activityTokenAmountDisplay(entry: ActivityEntry): string {
  const qty = activityTokenQuantity(entry.item)
  if (!qty) {
    if (isMintTokenActivity(entry)) return 'Minted'
    return entry.kind === 'spent' ? 'Sent' : 'Received'
  }
  if (isMintTokenActivity(entry) || entry.kind === 'earned') return `+${qty}`
  return `−${qty}`
}

/**
 * Breadcrumb / empty-state label for an activity detail.
 * Prefer "Transaction" — reserve "Payment" for explicit BSV payments (app money).
 */
export function activityDetailLabel(
  entry: ActivityEntry,
): 'Payment' | 'Transaction' | 'Activity' {
  if (isEventActivity(entry)) return 'Activity'
  if (isItemActivity(entry)) return 'Transaction'
  if (entry.origin !== WALLET_ACTIVITY_ORIGIN) return 'Payment'
  return 'Transaction'
}

export function clearAppActivity(origin?: string): void {
  if (!origin) {
    writeAll([])
    return
  }
  const key = normalizeAppHost(origin)
  writeAll(readAll().filter((e) => e.origin !== key))
}

export function getAppMoneySummary(origin: string): AppMoneySummary {
  const key = normalizeAppHost(origin)
  const cutoff = Date.now() - DAY_MS
  let spent24h = 0
  let earned24h = 0
  let spentAll = 0
  let earnedAll = 0
  for (const e of readAll()) {
    if (e.origin !== key) continue
    // Collectable tip sats are not BSV payment volume.
    if (isItemActivity(e)) continue
    if (e.kind === 'spent') {
      spentAll += e.sats
      if (e.at >= cutoff) spent24h += e.sats
    } else {
      earnedAll += e.sats
      if (e.at >= cutoff) earned24h += e.sats
    }
  }
  return { spent24h, earned24h, spentAll, earnedAll }
}

/** Latest activity timestamp for an origin (0 if none). */
export function getAppLastActivityAt(origin: string): number {
  const key = normalizeAppHost(origin)
  let latest = 0
  for (const e of readAll()) {
    if (e.origin !== key) continue
    if (e.at > latest) latest = e.at
  }
  return latest
}

/** Total sats moved (spent + earned) for ranking connected apps. */
export function getAppActivityVolume(origin: string): number {
  const money = getAppMoneySummary(origin)
  return money.spentAll + money.earnedAll
}

/** Spent satoshis for an origin since `sinceMs` (inclusive). */
export function getSpentSatsSince(origin: string | undefined, sinceMs: number): number {
  const key = normalizeAppHost(origin)
  let total = 0
  for (const e of readAll()) {
    if (e.origin !== key || e.kind !== 'spent') continue
    if (isItemActivity(e)) continue
    if (e.at >= sinceMs) total += e.sats
  }
  return total
}

/**
 * Stable identity for the event a row describes.
 *
 * `id` is minted from the clock when a row is written, so the same transaction
 * recorded twice — a local write plus a restored history replica, a re-import,
 * a reinstall — carries a different `id` every time. Anything that remembers
 * rows by `id` therefore forgets them, which is why the newest row kept
 * announcing itself as an arrival. What the transaction *is* does not change:
 * its txid, or for an item transfer its tip outpoint.
 */
export function activityEntryKey(entry: ActivityEntry): string {
  const kind = entry.kind
  // Item / token tips: outpoint is the durable identity (one tx can carry many tips).
  const outpoint = entry.item?.outpoint?.trim().toLowerCase().replace('_', '.')
  if (outpoint) return `item:${outpoint}:${kind}`
  const txid = entry.txid?.trim().toLowerCase()
  if (txid) return `tx:${txid}:${kind}`
  if (kind === 'event') {
    return `event:${entry.at}:${entry.method}:${entry.note ?? ''}`
  }
  // Nothing on-chain to key on (a local-only row): the timestamp it was written
  // with is as stable as this row gets.
  return `at:${entry.at}:${kind}:${entry.sats}`
}

/** Human title for an activity row (payment, collectable, or event). */
export function activityEntryTitle(entry: ActivityEntry): string {
  if (entry.kind === 'event') {
    return entry.note?.trim() || entry.method || 'Activity'
  }
  if (entry.item?.tokenId || isTokenActivity(entry)) {
    const name = entry.item?.name?.trim() || 'Token'
    const qty = activityTokenQuantity(entry.item)
    const withQty = qty ? `${qty} ${name}` : name
    if (isMintTokenActivity(entry)) return `Minted ${withQty}`
    if (entry.kind === 'spent' || entry.method === 'send-token') {
      return `Sent ${withQty}`
    }
    return `Received ${withQty}`
  }
  if (entry.item?.name) {
    const name = entry.item.name
    if (entry.origin === WALLET_ACTIVITY_ORIGIN) {
      return entry.kind === 'spent' ? `Sent ${name}` : `Received ${name}`
    }
    return entry.note?.trim() || (entry.kind === 'spent' ? `Sent ${name}` : `Received ${name}`)
  }
  if (entry.method === 'send-collectable' && entry.note?.trim()) {
    return entry.note.trim()
  }
  if (entry.origin === WALLET_ACTIVITY_ORIGIN) {
    const note = entry.note?.trim()
    if (note && note !== 'Received' && note !== 'Sent') return note
    return entry.kind === 'spent' ? 'Sent coins' : 'Received coins'
  }
  const name = appDisplayName(entry.origin)
  if (entry.kind === 'spent') return entry.note?.trim() || `Paid ${name}`
  return entry.note?.trim() || `From ${name}`
}

/** Newest-first activity feed for the history panel. */
export function listRecentActivity(limit = 40): ActivityEntry[] {
  const entries = [...readAll()]
  entries.sort((a, b) => b.at - a.at)
  return entries.slice(0, Math.max(1, limit))
}

export function getActivityById(id: string): ActivityEntry | null {
  return readAll().find((e) => e.id === id) ?? null
}

/** Export full local activity (storage-capped) for history backup. */
export function exportAllActivity(): ActivityEntry[] {
  return [...readAll()]
}

/** Merge remote activity into local history (idempotent by id / txid+kind). */
export function mergeActivityEntries(incoming: ActivityEntry[]): number {
  const local = readAll()
  const byId = new Map(local.map((e) => [e.id, e]))
  const byTxKind = new Map(
    local
      .filter((e) => e.txid)
      .map((e) => [`${e.txid!.toLowerCase()}:${e.kind}`, e]),
  )
  let added = 0
  for (const entry of incoming) {
    if (!entry?.id) continue
    if (byId.has(entry.id)) continue
    const txKind =
      entry.txid && ACTIVITY_KINDS.has(entry.kind)
        ? `${entry.txid.toLowerCase()}:${entry.kind}`
        : null
    if (txKind && byTxKind.has(txKind)) continue
    byId.set(entry.id, entry)
    if (txKind) byTxKind.set(txKind, entry)
    added += 1
  }
  writeAll([...byId.values()].sort((a, b) => a.at - b.at))
  return added
}

/** Sum satoshis from common BRC-100 payment payloads. */
export function extractSatsFromArgs(method: string, args: unknown): number {
  if (!args || typeof args !== 'object') return 0
  const body = args as Record<string, unknown>

  if (method === 'createAction' || method === 'internalizeAction') {
    const outputs = Array.isArray(body.outputs) ? body.outputs : []
    let total = 0
    for (const raw of outputs) {
      if (!raw || typeof raw !== 'object') continue
      const sats = (raw as { satoshis?: unknown }).satoshis
      if (typeof sats === 'number' && Number.isFinite(sats)) total += Math.max(0, sats)
    }
    return Math.trunc(total)
  }

  if (typeof body.satoshis === 'number' && Number.isFinite(body.satoshis)) {
    return Math.max(0, Math.trunc(body.satoshis))
  }
  if (typeof body.amount === 'number' && Number.isFinite(body.amount)) {
    // Assume BSV if fractional, sats if large integer.
    const amount = body.amount
    if (amount > 0 && amount < 1000 && !Number.isInteger(amount)) {
      return Math.round(amount * 1e8)
    }
    return Math.max(0, Math.trunc(amount))
  }
  return 0
}
