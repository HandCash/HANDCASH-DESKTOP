import { appDisplayName, normalizeAppHost } from './appIdentity'
import { durableGetItem, durableSetItem } from './durableStorage'
import { isGhostTxSuppressed, rememberGhostTx } from './ghostTxSuppress'

const STORAGE_KEY = 'handcash.brc100.appActivity'

/** Money moves plus non-tx wallet actions (connect, deny, add friend, …). */
export type ActivityKind = 'spent' | 'earned' | 'event'

/**
 * In-flight ingest / authenticity. Absent = settled (legacy rows).
 * `failed` is terminal: the send never reached a txid and the row keeps the reason.
 */
export type ActivityStatus = 'pending' | 'complete' | 'failed'

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

/** Structured data required to retry the exact same spend without guessing. */
export type ActivityRetry =
  | {
      kind: 'send-collectable'
      outpoint: string
      toAddress: string
      recipientIdentityKey?: string
      friendLabel?: string
    }
  | {
      kind: 'send-token'
      tokenId: string
      amount: string
      toAddress: string
      recipientIdentityKey?: string
      friendLabel?: string
    }
  | {
      kind: 'send-bsv'
      toAddress: string
      satoshis: number
      recipientIdentityKey?: string
      friendLabel?: string
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
  /** Links an in-flight outbound send until a txid lands. */
  pendingId?: string
  /** Why a `failed` row failed — shown in Activity so a dead send is never silent. */
  failureReason?: string
  /** Present only when the original action can be reconstructed safely. */
  retry?: ActivityRetry
  /** Irreversible asset destruction economics (not a send/payment). */
  burn?: ActivityBurn
}

export type ActivityBurn = {
  asset: 'bsv21' | '1sat'
  destroyedAmount: string
  recoveredSatoshis?: number
  feeSatoshis?: number
}

/** Keeps stored reasons short enough that one row cannot bloat history. */
const MAX_FAILURE_REASON = 240

export function normalizeFailureReason(reason: unknown): string | undefined {
  if (typeof reason !== 'string') return undefined
  const trimmed = reason.replace(/\s+/g, ' ').trim()
  if (!trimmed) return undefined
  return trimmed.length > MAX_FAILURE_REASON
    ? `${trimmed.slice(0, MAX_FAILURE_REASON - 1)}…`
    : trimmed
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
          row.status === 'pending'
            ? 'pending'
            : row.status === 'failed'
            ? 'failed'
            : undefined
        const pendingId =
          typeof row.pendingId === 'string' && row.pendingId.trim()
            ? row.pendingId.trim()
            : undefined
        const failureReason =
          status === 'failed'
            ? normalizeFailureReason(row.failureReason)
            : undefined
        const retry = normalizeActivityRetry(row.retry)
        return {
          ...row,
          item: item ?? undefined,
          status,
          ...(pendingId ? { pendingId } : {}),
          ...(failureReason ? { failureReason } : { failureReason: undefined }),
          ...(retry ? { retry } : { retry: undefined }),
        }
      })
    parsedRaw = raw
    parsedEntries = entries
    return entries
  } catch {
    return []
  }
}

function normalizeActivityRetry(value: unknown): ActivityRetry | undefined {
  if (!value || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  const toAddress = typeof row.toAddress === 'string' ? row.toAddress.trim() : ''
  if (!toAddress) return undefined
  const recipientIdentityKey =
    typeof row.recipientIdentityKey === 'string' && row.recipientIdentityKey.trim()
      ? row.recipientIdentityKey.trim()
      : undefined
  const friendLabel =
    typeof row.friendLabel === 'string' && row.friendLabel.trim()
      ? row.friendLabel.trim().slice(0, 80)
      : undefined
  if (row.kind === 'send-collectable') {
    const outpoint = typeof row.outpoint === 'string' ? row.outpoint.trim() : ''
    if (!outpoint) return undefined
    return {
      kind: 'send-collectable',
      outpoint,
      toAddress,
      ...(recipientIdentityKey ? { recipientIdentityKey } : {}),
      ...(friendLabel ? { friendLabel } : {}),
    }
  }
  if (row.kind === 'send-token') {
    const tokenId = typeof row.tokenId === 'string' ? row.tokenId.trim() : ''
    const amount = typeof row.amount === 'string' ? row.amount.trim() : ''
    if (!tokenId || !amount) return undefined
    return {
      kind: 'send-token',
      tokenId,
      amount,
      toAddress,
      ...(recipientIdentityKey ? { recipientIdentityKey } : {}),
      ...(friendLabel ? { friendLabel } : {}),
    }
  }
  if (row.kind === 'send-bsv') {
    const satoshis =
      typeof row.satoshis === 'number' && Number.isFinite(row.satoshis)
        ? Math.trunc(row.satoshis)
        : 0
    if (satoshis <= 0) return undefined
    return {
      kind: 'send-bsv',
      toAddress,
      satoshis,
      ...(recipientIdentityKey ? { recipientIdentityKey } : {}),
      ...(friendLabel ? { friendLabel } : {}),
    }
  }
  return undefined
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

function activityRowIsItem(row: {
  item?: ActivityItem
  method: string
}): boolean {
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
    if (e.status === 'pending' || e.status === 'failed') return false
    if (opts?.item != null && activityRowIsItem(e) !== opts.item) return false
    return true
  })
}

export function isPendingActivity(entry: ActivityEntry): boolean {
  return entry.status === 'pending'
}

export function isFailedActivity(entry: ActivityEntry): boolean {
  return entry.status === 'failed'
}

/** Short label for a failed Activity row. Long why stays in details storage. */
export function compactFailureLabel(reason: string | undefined | null): string {
  const raw = (reason ?? '').replace(/\s+/g, ' ').trim()
  if (!raw) return 'Send failed'
  if (/already spent|doublespend|double spend|missing.?input|mempool-conflict|competing/i.test(raw)) {
    return 'Already spent'
  }
  if (/timed? ?out|never confirmed|stopped hearing/i.test(raw)) return 'Timed out'
  if (/unreachable|no network|connection|service error|fetch failed/i.test(raw)) {
    return 'No network'
  }
  if (/not iterable|locking script|missing script/i.test(raw)) return 'Missing script'
  if (/broadcast failed|not accepted|rejected|not sent/i.test(raw)) return 'Not sent'
  const first = raw.split(/[.(—–]/)[0]!.trim()
  return first.length > 28 ? `${first.slice(0, 27)}…` : first || 'Send failed'
}

/** Reason stored on a failed row — never blank once a row is failed. */
export function activityFailureReason(entry: ActivityEntry): string | null {
  if (entry.status !== 'failed') return null
  return entry.failureReason?.trim() || 'Send failed'
}

/** Compact subtitle for the Activity feed. */
export function activityFailureLabel(entry: ActivityEntry): string | null {
  if (entry.status !== 'failed') return null
  return compactFailureLabel(entry.failureReason)
}

/** True if we already logged a collectable receive/send for this tip outpoint. */
export function hasActivityItemOutpoint(
  outpoint: string | undefined | null,
): boolean {
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
    pendingId?: string
  },
): number {
  const pendingId = args.pendingId?.trim()
  if (pendingId) {
    const byPending = entries.findIndex(
      (e) => e.pendingId === pendingId && e.kind === args.kind,
    )
    if (byPending >= 0) return byPending
    // New pendingId must not collapse onto a prior settled spend of the same tip
    // (failed broadcast / chain-ingest restore). Only refresh an in-flight pending
    // row for this outpoint; otherwise insert a fresh Sending… row.
    const outpoint = args.item?.outpoint?.trim().toLowerCase().replace('_', '.')
    if (outpoint) {
      const byPendingOp = entries.findIndex((e) => {
        if (e.kind !== args.kind || e.status !== 'pending') return false
        const op = e.item?.outpoint?.trim().toLowerCase().replace('_', '.')
        return op === outpoint
      })
      if (byPendingOp >= 0) return byPendingOp
    }
    return -1
  }
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
  pendingId?: string
  failureReason?: string
  retry?: ActivityRetry
  burn?: ActivityBurn
}): void {
  const sats = Math.max(0, Math.trunc(args.sats))
  const item = normalizeActivityItem(args.item)
  const isEvent = args.kind === 'event'
  const pending = args.status === 'pending'
  const failed = args.status === 'failed'
  // Item transfers are meaningful even when the tip is only 1 satoshi — never drop them
  // because the money amount is dust. Events (connect, friend, …) may be zero-sats.
  // Pending BSV receives may not know sats yet — still show Verifying… in Activity.
  // Pending outbound sends (sats > 0 or item) must show before a txid exists.
  // A failed send must survive even with no amount — it is the only trace left.
  if (sats <= 0 && !item && !isEvent && !pending && !failed) return
  if (isEvent && !(args.note?.trim() || args.method.trim())) return
  const origin = normalizeAppHost(args.origin)
  const txid = args.txid?.trim() || undefined
  const pendingId = args.pendingId?.trim() || undefined
  const entries = [...readAll()]
  const idx = findActivityMatchIndex(entries, {
    kind: args.kind,
    txid,
    item: item ?? args.item,
    method: args.method,
    pendingId,
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
    const nextPendingId =
      nextStatus === 'pending' || nextStatus === 'failed'
        ? pendingId || prev.pendingId
        : undefined
    // A confirmed txid clears an earlier failure; otherwise keep the reason.
    const nextFailureReason =
      nextStatus === 'failed'
        ? normalizeFailureReason(args.failureReason) ?? prev.failureReason
        : undefined
    const nextRetry = normalizeActivityRetry(args.retry) ?? prev.retry
    entries[idx] = {
      ...prev,
      origin: origin || prev.origin,
      sats: isEvent ? 0 : sats > 0 ? sats : prev.sats,
      method: args.method || prev.method,
      note: args.note ?? prev.note,
      txid: txid || prev.txid,
      ...(nextItem ? { item: nextItem } : {}),
      ...(nextStatus === 'pending' || nextStatus === 'failed'
        ? { status: nextStatus }
        : { status: undefined }),
      ...(nextPendingId
        ? { pendingId: nextPendingId }
        : { pendingId: undefined }),
      ...(nextFailureReason
        ? { failureReason: nextFailureReason }
        : { failureReason: undefined }),
      ...(nextRetry ? { retry: nextRetry } : { retry: undefined }),
      ...(args.burn || prev.burn ? { burn: args.burn ?? prev.burn } : {}),
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
      ...(failed ? { status: 'failed' as const } : {}),
      ...(failed
        ? { failureReason: normalizeFailureReason(args.failureReason) }
        : {}),
      ...((pending || failed) && pendingId ? { pendingId } : {}),
      ...(normalizeActivityRetry(args.retry)
        ? { retry: normalizeActivityRetry(args.retry) }
        : {}),
      ...(args.burn ? { burn: args.burn } : {}),
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
  token?: {
    tokenId: string
    amount: string
    sym: string
    dec: number
    icon?: string
  }
}): void {
  const txid = args.txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid)) return
  if (isGhostTxSuppressed(txid)) return
  if (args.item) {
    const name = args.token?.sym?.trim() || args.itemName?.trim() || 'Collectable'
    const origin =
      args.token?.tokenId?.trim() ||
      args.itemOrigin?.trim() ||
      `${txid}_0`
    const outpoint = args.outpoint?.trim() || `${txid}.0`
    upsertAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'earned',
      sats: 1,
      method: args.token ? 'receive-token' : 'receive-collectable',
      note: args.token
        ? `Receiving ${formatActivityTokenAmt(args.token.amount, args.token.dec)} ${name}`
        : `Received ${name}`,
      txid,
      status: 'pending',
      item: {
        name,
        origin,
        outpoint,
        ...(args.token
          ? {
              tokenId: args.token.tokenId,
              amt: args.token.amount,
              dec: args.token.dec,
              ...(args.token.icon ? { icon: args.token.icon } : {}),
            }
          : {}),
      },
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
  token?: {
    tokenId: string
    amount: string
    sym: string
    dec: number
    icon?: string
  }
}): void {
  const txid = args.txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid)) return
  if (args.item) {
    const name = args.token?.sym?.trim() || args.itemName?.trim() || 'Collectable'
    const origin =
      args.token?.tokenId?.trim() ||
      args.itemOrigin?.trim() ||
      `${txid}_0`
    const outpoint = args.outpoint?.trim() || `${txid}.0`
    upsertAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'earned',
      sats: 1,
      method: args.token ? 'receive-token' : 'receive-collectable',
      note: args.token
        ? `Received ${formatActivityTokenAmt(args.token.amount, args.token.dec)} ${name}`
        : `Received ${name}`,
      txid,
      status: 'complete',
      item: {
        name,
        origin,
        outpoint,
        ...(args.token
          ? {
              tokenId: args.token.tokenId,
              amt: args.token.amount,
              dec: args.token.dec,
              ...(args.token.icon ? { icon: args.token.icon } : {}),
            }
          : {}),
      },
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

/** Activity row the moment an outbound send starts — survives Back / navigate away. */
export function noteOutboundSendPending(args: {
  pendingId: string
  sats: number
  to: string
  friendLabel?: string | null
  recipientIdentityKey?: string | null
  item?: ActivityItem
}): void {
  const pendingId = args.pendingId.trim()
  if (!pendingId) return
  const recipient = args.friendLabel?.trim()
    ? `${args.friendLabel.trim()} (${args.to.trim()})`
    : args.to.trim()
  if (args.item) {
    const isToken = Boolean(args.item.tokenId)
    const name = args.item.name?.trim() || (isToken ? 'Token' : 'Collectable')
    const qty =
      isToken && args.item.amt
        ? formatActivityTokenAmt(args.item.amt, args.item.dec ?? 0)
        : null
    upsertAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'spent',
      sats: Math.max(1, Math.trunc(args.sats) || 1),
      method: isToken ? 'send-token' : 'send-collectable',
      note: qty
        ? `Sending ${qty} ${name} to ${recipient}`
        : `Sending ${name} to ${recipient}`,
      status: 'pending',
      pendingId,
      item: args.item,
      retry: isToken
        ? {
            kind: 'send-token',
            tokenId: args.item.tokenId!,
            amount: args.item.amt ?? '0',
            toAddress: args.to,
            ...(args.recipientIdentityKey
              ? { recipientIdentityKey: args.recipientIdentityKey }
              : {}),
            ...(args.friendLabel ? { friendLabel: args.friendLabel } : {}),
          }
        : {
            kind: 'send-collectable',
            outpoint: args.item.outpoint ?? '',
            toAddress: args.to,
            ...(args.recipientIdentityKey
              ? { recipientIdentityKey: args.recipientIdentityKey }
              : {}),
            ...(args.friendLabel ? { friendLabel: args.friendLabel } : {}),
          },
    })
    return
  }
  upsertAppActivity({
    origin: WALLET_ACTIVITY_ORIGIN,
    kind: 'spent',
    sats: Math.max(0, Math.trunc(args.sats)),
    method: 'send',
    note: `Sending to ${recipient}`,
    status: 'pending',
    pendingId,
    retry: bsvRetry(args),
  })
}

/** Recipient + amount a payment row needs to be retried or explained after it dies. */
function bsvRetry(args: {
  sats: number
  to: string
  friendLabel?: string | null
  recipientIdentityKey?: string | null
}): ActivityRetry | undefined {
  const satoshis = Math.max(0, Math.trunc(args.sats))
  const toAddress = args.to.trim()
  if (satoshis <= 0 || !toAddress) return undefined
  return {
    kind: 'send-bsv',
    toAddress,
    satoshis,
    ...(args.recipientIdentityKey
      ? { recipientIdentityKey: args.recipientIdentityKey }
      : {}),
    ...(args.friendLabel ? { friendLabel: args.friendLabel } : {}),
  }
}

/** Promote a Sending… row to Settled after broadcast accepts. */
export function noteOutboundSendComplete(args: {
  pendingId: string
  txid: string
  sats: number
  to: string
  friendLabel?: string | null
  recipientIdentityKey?: string | null
  item?: ActivityItem
}): void {
  const pendingId = args.pendingId.trim()
  const txid = args.txid.trim().toLowerCase()
  if (!pendingId) return
  if (!/^[0-9a-f]{64}$/.test(txid) && !txid.startsWith('local-')) return
  const recipient = args.friendLabel?.trim()
    ? `${args.friendLabel.trim()} (${args.to.trim()})`
    : args.to.trim()
  if (args.item) {
    const isToken = Boolean(args.item.tokenId)
    const name = args.item.name?.trim() || (isToken ? 'Token' : 'Collectable')
    const qty =
      isToken && args.item.amt
        ? formatActivityTokenAmt(args.item.amt, args.item.dec ?? 0)
        : null
    upsertAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'spent',
      sats: Math.max(1, Math.trunc(args.sats) || 1),
      method: isToken ? 'send-token' : 'send-collectable',
      note: qty
        ? `Sent ${qty} ${name} to ${recipient}`
        : `Sent ${name} to ${recipient}`,
      txid,
      status: 'complete',
      pendingId,
      item: args.item,
      retry: isToken
        ? {
            kind: 'send-token',
            tokenId: args.item.tokenId!,
            amount: args.item.amt ?? '0',
            toAddress: args.to,
            ...(args.recipientIdentityKey
              ? { recipientIdentityKey: args.recipientIdentityKey }
              : {}),
            ...(args.friendLabel ? { friendLabel: args.friendLabel } : {}),
          }
        : {
            kind: 'send-collectable',
            outpoint: args.item.outpoint ?? '',
            toAddress: args.to,
            ...(args.recipientIdentityKey
              ? { recipientIdentityKey: args.recipientIdentityKey }
              : {}),
            ...(args.friendLabel ? { friendLabel: args.friendLabel } : {}),
          },
    })
    return
  }
  upsertAppActivity({
    origin: WALLET_ACTIVITY_ORIGIN,
    kind: 'spent',
    sats: Math.max(0, Math.trunc(args.sats)),
    method: 'send',
    note: `Sent to ${recipient}`,
    txid,
    status: 'complete',
    pendingId,
    retry: bsvRetry(args),
  })
}

/**
 * Drop a Sending… row when the send is abandoned with nothing to report
 * (user cancel / superseded). A send that *failed* must use
 * {@link failOutboundSendPending} so Activity keeps the reason.
 */
export function clearOutboundSendPending(pendingId: string): void {
  const id = pendingId.trim()
  if (!id) return
  const prev = readAll()
  const entries = prev.filter(
    (e) =>
      !(e.pendingId === id && e.status === 'pending' && e.kind === 'spent'),
  )
  if (entries.length !== prev.length) writeAll(entries)
}

/**
 * Turn a Sending… row into a terminal failed row carrying why it failed.
 * Keeps the amount, recipient and item so Activity can explain the dead send
 * instead of silently dropping it.
 */
export function failOutboundSendPending(args: {
  pendingId: string
  reason: string
}): boolean {
  const id = args.pendingId.trim()
  if (!id) return false
  const reason = normalizeFailureReason(args.reason) ?? 'Send failed'
  const prev = readAll()
  let changed = false
  const entries = prev.map((e) => {
    if (e.pendingId !== id || e.kind !== 'spent') return e
    // A row that already reached a txid settled — never rewrite it as failed.
    if (e.status !== 'pending') return e
    changed = true
    const name = e.item?.name?.trim()
    return {
      ...e,
      status: 'failed' as const,
      failureReason: reason,
      note: name ? `${name} was not sent` : 'Payment was not sent',
    }
  })
  if (changed) writeAll(entries)
  return changed
}

function normalizeActivityOutpoint(outpoint: string): string {
  return outpoint
    .trim()
    .toLowerCase()
    .replace(/_(\d+)$/, '.$1')
}

/** Drop a Verifying… receive when ingest fails before the tip is held. */
export function clearInboundReceivePending(txid: string): void {
  const id = txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id)) return
  const prev = readAll()
  const entries = prev.filter(
    (e) =>
      !(
        e.txid?.toLowerCase() === id &&
        e.status === 'pending' &&
        e.kind === 'earned'
      ),
  )
  if (entries.length !== prev.length) writeAll(entries)
}

/**
 * Drop Verifying… receives older than `maxAgeMs` that never internalized.
 * Stops Activity from spinning forever after a failed soft-latch ingest.
 */
export function expireStaleInboundPending(
  maxAgeMs = 120_000,
  now = Date.now(),
): number {
  const prev = readAll()
  const entries = prev.filter((e) => {
    if (e.status !== 'pending' || e.kind !== 'earned') return true
    return now - e.at < maxAgeMs
  })
  const removed = prev.length - entries.length
  if (removed > 0) writeAll(entries)
  return removed
}

/**
 * Mark Sending… rows older than `maxAgeMs` as failed when they never reached a
 * txid / complete. Matches the payment-progress stuck watchdog so Activity
 * cannot spin forever — and, unlike the old prune, says what happened.
 */
export function expireStaleOutboundPending(
  maxAgeMs = 90_000,
  now = Date.now(),
): number {
  const prev = readAll()
  let expired = 0
  const entries = prev.map((e) => {
    if (e.status !== 'pending' || e.kind !== 'spent') return e
    if (now - e.at < maxAgeMs) return e
    expired += 1
    const name = e.item?.name?.trim()
    return {
      ...e,
      status: 'failed' as const,
      failureReason: 'Timed out',
      note: name ? `${name} was not sent` : 'Payment was not sent',
    }
  })
  if (expired > 0) writeAll(entries)
  return expired
}

/** Drop every Activity row for these txids (ghost send / 404 prune). */
export function removeActivityForTxids(txids: string[]): number {
  const missing = new Set(
    txids
      .map((t) => t.trim().toLowerCase())
      .filter((t) => /^[0-9a-f]{64}$/.test(t)),
  )
  if (missing.size === 0) return 0
  const prev = readAll()
  const next = prev.filter((e) => {
    const txid = e.txid?.toLowerCase()
    return !txid || !missing.has(txid)
  })
  const removed = prev.length - next.length
  if (removed > 0) writeAll(next)
  return removed
}

/** Delete one local Activity attempt. This never mutates or cancels a transaction. */
export function removeActivityById(id: string): boolean {
  const key = id.trim()
  if (!key) return false
  const prev = readAll()
  const next = prev.filter((entry) => entry.id !== key)
  if (next.length === prev.length) return false
  writeAll(next)
  return true
}

/**
 * How many failed send rows are in local history right now.
 *
 * `keep` excludes rows from the count — same predicate shape as
 * {@link removeFailedActivity}. Bulk clear still re-checks signed rows on
 * chain: a live send whose inputs are unspent is not removed even if it was
 * counted here.
 */
export function countFailedActivity(
  keep?: (entry: ActivityEntry) => boolean,
): number {
  return readAll().reduce(
    (n, e) => (e.status === 'failed' && !keep?.(e) ? n + 1 : n),
    0,
  )
}

/** Failed send rows currently in Activity, in store order. */
export function listFailedActivity(): ActivityEntry[] {
  return readAll().filter((e) => e.status === 'failed')
}

/**
 * Drop failed send rows in one write, minus anything `keep` protects.
 *
 * Most failed rows are local-only bookkeeping — unsigned attempts never bound
 * coins to a signed transaction. A signed send is only safe to drop once its
 * inputs are already spent on chain; callers exclude live ones via `keep`.
 * Local reservation repair is the caller's job (see `clearSpendAttempt`); this
 * only edits the history list. Returns how many rows were removed.
 */
export function removeFailedActivity(
  keep?: (entry: ActivityEntry) => boolean,
): number {
  const prev = readAll()
  const next = prev.filter((entry) => entry.status !== 'failed' || keep?.(entry))
  const removed = prev.length - next.length
  if (removed > 0) writeAll(next)
  return removed
}

/**
 * Remove Activity rows whose txid is confirmed missing on-chain (404).
 * Pending BSV Verifying…/Sending… are included — tip-hint polls otherwise
 * re-pin them forever when the inbox message is never ACKed.
 * Settled rows need a longer grace so mempool txs are not pruned early.
 *
 * Item rows are excluded at every status. A `peerDeliver` settle is broadcast by
 * the **payee**, so a 404 means they have not broadcast yet — not that the
 * transfer never happened. The tip has already left the basket by then, so
 * deleting the row destroys the only record of the send and the details panel
 * falls back to "Transaction not found".
 */
export async function pruneMissingOnChainActivity(
  chain: import('./vault').Chain,
  exists: (
    txid: string,
    chain: import('./vault').Chain,
  ) => Promise<boolean | null>,
  opts?: { minAgeMs?: number; pendingMinAgeMs?: number; limit?: number },
): Promise<number> {
  const settledMinAgeMs = opts?.minAgeMs ?? 10 * 60_000
  const pendingMinAgeMs = opts?.pendingMinAgeMs ?? 60_000
  const limit = opts?.limit ?? 40
  const now = Date.now()
  const prev = readAll()
  const candidates = prev
    .filter((e) => {
      if (!e.txid || !/^[0-9a-f]{64}$/i.test(e.txid)) return false
      if (activityRowIsItem(e)) return false
      const age = now - e.at
      if (e.status === 'pending') return age >= pendingMinAgeMs
      if (age < settledMinAgeMs) return false
      return e.kind === 'spent' || e.kind === 'earned'
    })
    .slice(0, limit)

  if (candidates.length === 0) return 0

  const missing = new Set<string>()
  for (const row of candidates) {
    const txid = row.txid!.toLowerCase()
    if (missing.has(txid)) continue
    if (isGhostTxSuppressed(txid)) {
      missing.add(txid)
      continue
    }
    try {
      const onChain = await exists(txid, chain)
      if (onChain === false) {
        rememberGhostTx(txid)
        missing.add(txid)
      }
    } catch {
      // inconclusive — keep
    }
  }
  if (missing.size === 0) return 0

  const next = prev.filter((e) => {
    const txid = e.txid?.toLowerCase()
    if (!txid || !missing.has(txid)) return true
    return false
  })
  const removed = prev.length - next.length
  if (removed > 0) writeAll(next)
  return removed
}

/**
 * Activity "Verifying…" must match inventory. When a tip is already held
 * (and especially when authenticity has settled), clear stale pending rows
 * so UI is not a second conflicting state.
 *
 * @returns how many rows were settled.
 */
export function reconcilePendingActivityWithHeldItems(
  held: Array<{
    outpoint: string
    proven?: boolean
    name?: string
    origin?: string
  }>,
): number {
  if (!held.length) return 0
  const byOutpoint = new Map(
    held
      .map((h) => {
        const op = normalizeActivityOutpoint(h.outpoint)
        return op ? ([op, h] as const) : null
      })
      .filter(
        (row): row is readonly [string, (typeof held)[number]] => row != null,
      ),
  )
  if (byOutpoint.size === 0) return 0

  const entries = [...readAll()]
  let changed = 0
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    if (entry.status !== 'pending' || entry.kind !== 'earned') continue
    const op = entry.item?.outpoint
      ? normalizeActivityOutpoint(entry.item.outpoint)
      : ''
    if (!op) continue
    const item = byOutpoint.get(op)
    if (!item) continue
    // Owned in inventory ⇒ ingest finished. Pending was only for pre-paint.
    entries[i] = {
      ...entry,
      status: undefined,
      item: {
        name: item.name?.trim() || entry.item?.name || 'Collectable',
        origin:
          item.origin?.trim() ||
          entry.item?.origin ||
          `${op.replace('.', '_')}`,
        outpoint: op,
        ...(entry.item?.imageUrl ? { imageUrl: entry.item.imageUrl } : {}),
        ...(entry.item?.app ? { app: entry.item.app } : {}),
      },
    }
    changed += 1
  }
  if (changed > 0) writeAll(entries)
  return changed
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

function normalizeActivityItem(
  raw: ActivityItem | undefined,
): ActivityItem | undefined {
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
    ...(typeof raw.app === 'string' && raw.app.trim()
      ? { app: raw.app.trim().slice(0, 40) }
      : {}),
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

/** True only for irreversible on-chain asset destruction. */
export function isBurnActivity(entry: ActivityEntry): boolean {
  return entry.method === 'burn-token' || entry.method === 'burn-collectable'
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
export function activityTokenQuantity(
  item: ActivityItem | undefined,
): string | null {
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
export function getSpentSatsSince(
  origin: string | undefined,
  sinceMs: number,
): number {
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
  const txid = entry.txid?.trim().toLowerCase()
  // Item / token tips: outpoint is the durable identity (one tx can carry many
  // tips). One tip can still be spent by more than one attempt — a send whose
  // tip came back unspent and was sent again — so the spending txid separates
  // those rows. Attempts that died before signing have no txid to separate them
  // and are local-only, so their row id is both unique and as durable as they
  // get. Without either, React saw duplicate keys and dropped a row.
  const outpoint = entry.item?.outpoint?.trim().toLowerCase().replace('_', '.')
  if (outpoint) return `item:${outpoint}:${kind}:${txid ?? entry.id}`
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
  if (entry.status === 'failed') {
    if (isBurnActivity(entry)) {
      return entry.item?.name ? `${entry.item.name} not burned` : 'Burn failed'
    }
    if (entry.item?.name) return `${entry.item.name} not sent`
    return 'Send failed'
  }
  if (entry.status === 'pending' && entry.kind === 'spent') {
    if (isBurnActivity(entry)) {
      return entry.item?.name ? `Burning ${entry.item.name}…` : 'Burning…'
    }
    if (entry.item?.name) return `Sending ${entry.item.name}…`
    return 'Sending…'
  }
  if (entry.status === 'pending' && entry.kind === 'earned') {
    if (entry.item?.name) return `Receiving ${entry.item.name}…`
    return 'Receiving…'
  }
  if (entry.kind === 'event') {
    return entry.note?.trim() || entry.method || 'Activity'
  }
  if (entry.item?.tokenId || isTokenActivity(entry)) {
    const name = entry.item?.name?.trim() || 'Token'
    const qty = activityTokenQuantity(entry.item)
    const withQty = qty ? `${qty} ${name}` : name
    if (isMintTokenActivity(entry)) return `Minted ${withQty}`
    if (isBurnActivity(entry)) return `Burned ${withQty}`
    if (entry.kind === 'spent' || entry.method === 'send-token') {
      return `Sent ${withQty}`
    }
    return `Received ${withQty}`
  }
  if (entry.item?.name) {
    const name = entry.item.name
    if (isBurnActivity(entry)) return `Burned ${name}`
    if (entry.origin === WALLET_ACTIVITY_ORIGIN) {
      return entry.kind === 'spent' ? `Sent ${name}` : `Received ${name}`
    }
    return (
      entry.note?.trim() ||
      (entry.kind === 'spent' ? `Sent ${name}` : `Received ${name}`)
    )
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
      if (typeof sats === 'number' && Number.isFinite(sats))
        total += Math.max(0, sats)
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
