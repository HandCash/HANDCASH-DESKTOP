import { appDisplayName, normalizeAppHost } from './appIdentity'
import { durableGetItem, durableSetItem } from './durableStorage'

const STORAGE_KEY = 'handcash.brc100.appActivity'

export type ActivityKind = 'spent' | 'earned'

/** Collectable / NFT remittance attached to an activity row. */
export type ActivityItem = {
  name: string
  origin: string
  outpoint?: string
  imageUrl?: string
  app?: string
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
}

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

function readAll(): ActivityEntry[] {
  try {
    const raw = durableGetItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (e): e is ActivityEntry =>
          !!e &&
          typeof e === 'object' &&
          typeof (e as ActivityEntry).origin === 'string' &&
          typeof (e as ActivityEntry).sats === 'number' &&
          typeof (e as ActivityEntry).at === 'number' &&
          ((e as ActivityEntry).kind === 'spent' || (e as ActivityEntry).kind === 'earned'),
      )
      .map((e) => {
        const item = normalizeActivityItem((e as ActivityEntry).item)
        return item ? { ...e, item } : { ...e, item: undefined }
      })
  } catch {
    return []
  }
}

function writeAll(entries: ActivityEntry[]): void {
  // Cap history so storage stays small.
  const trimmed = entries.slice(-2000)
  durableSetItem(STORAGE_KEY, JSON.stringify(trimmed))
  for (const cb of listeners) cb()
}

/** True if we already logged this on-chain (or local) txid. */
export function hasActivityTxid(txid: string | undefined | null): boolean {
  const key = txid?.trim().toLowerCase()
  if (!key) return false
  return readAll().some((e) => e.txid?.toLowerCase() === key)
}

export function subscribeAppActivity(cb: ActivityListener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function recordAppActivity(args: {
  origin: string | undefined
  kind: ActivityKind
  sats: number
  method: string
  note?: string
  txid?: string
  item?: ActivityItem
}): void {
  const sats = Math.max(0, Math.trunc(args.sats))
  const item = normalizeActivityItem(args.item)
  // Item transfers are meaningful even when the tip is only 1 satoshi — never drop them
  // because the money amount is dust.
  if (sats <= 0 && !item) return
  const origin = normalizeAppHost(args.origin)
  const entries = readAll()
  entries.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    origin,
    kind: args.kind,
    sats,
    at: Date.now(),
    method: args.method,
    note: args.note,
    txid: args.txid?.trim() || undefined,
    ...(item ? { item } : {}),
  })
  writeAll(entries)
}

function normalizeActivityItem(raw: ActivityItem | undefined): ActivityItem | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const origin = typeof raw.origin === 'string' ? raw.origin.trim() : ''
  if (!name || !origin) return undefined
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
  }
}

/** True when this row is a collectable transfer (not a BSV payment). */
export function isItemActivity(entry: ActivityEntry): boolean {
  return Boolean(entry.item) || entry.method === 'send-collectable' || /collectable|1sat|ordinal/i.test(entry.method)
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

/** Human title for an activity row (payment or collectable). */
export function activityEntryTitle(entry: ActivityEntry): string {
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
    return entry.kind === 'spent' ? 'Sent' : 'Received'
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
  return readAll()
}

/** Merge remote activity into local history (idempotent by id / txid). */
export function mergeActivityEntries(incoming: ActivityEntry[]): number {
  const local = readAll()
  const byId = new Map(local.map((e) => [e.id, e]))
  const byTx = new Map(
    local.filter((e) => e.txid).map((e) => [e.txid!.toLowerCase(), e]),
  )
  let added = 0
  for (const entry of incoming) {
    if (!entry?.id) continue
    if (byId.has(entry.id)) continue
    if (entry.txid && byTx.has(entry.txid.toLowerCase())) continue
    byId.set(entry.id, entry)
    if (entry.txid) byTx.set(entry.txid.toLowerCase(), entry)
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
