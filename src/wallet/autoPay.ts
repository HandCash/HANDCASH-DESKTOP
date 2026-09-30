import { storageRegistry } from '../storage/registry'
/**
 * Auto-pay — user opt-in silent createAction within limits.
 *
 * Source of truth for the user limit is `maxUsd` (UX). We also cache
 * `maxSats` from the last known FX rate so enforcement can continue when
 * the rate is temporarily missing. BRC spendingAuthorization (monthly sats)
 * still takes precedence when granted.
 */
import { normalizeAppHost } from './appIdentity'
import { getSpentSatsSince } from './appActivity'
import { getCachedUsdPerBsv, satsToUsd } from './fx'
import { durableGetItem, durableSetItem } from './durableStorage.js'
import { accountLocalKey } from './accountLocalKeys'
import {
  getSpendingAuthorizationGrant,
  startOfUtcMonth,
} from './spendingAuthorization'

const STORAGE_KEY = storageRegistry.autoPay.key
const RESERVATION_KEY = storageRegistry.autoPayReservations.key
type ReservedPayment = { id: string; origin: string; sats: number; at: number; txid?: string }
export type AutoPayReservation = { key: string; id: string }

function readReservations(key = accountLocalKey(RESERVATION_KEY)): ReservedPayment[] | null {
  try {
    const raw = durableGetItem(key)
    if (!raw) return []
    const rows: unknown = JSON.parse(raw)
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row.id !== 'string' ||
      typeof row.origin !== 'string' || !Number.isSafeInteger(row.sats) || row.sats <= 0 ||
      !Number.isFinite(row.at))) return null
    return rows
  } catch { return null }
}

/** Reserve before consent is returned. Failed/uncertain calls remain charged
 * until the spending window expires; an explicit approval can still proceed.
 * Reservations survive process death and are never timed out while signing.
 */
export function reserveAutoPayPayment(origin: string | undefined, amountSats: number): AutoPayReservation | null {
  if (!canAutoProcessPayment(origin, 'createAction', amountSats)) return null
  return reserveApprovedPayment(origin, amountSats)
}

/** Record explicit approvals too: Activity compaction must not reset the budget. */
export function reserveApprovedPayment(origin: string | undefined, amountSats: number): AutoPayReservation | null {
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) return null
  const key = accountLocalKey(RESERVATION_KEY)
  const rows = readReservations(key)
  if (!rows) return null
  const kept = rows.filter(row => row.at >= Date.now() - 90 * 24 * 60 * 60_000)
  if (kept.length >= 4096) return null
  const id = crypto.randomUUID()
  kept.push({ id, origin: normalizeAppHost(origin), sats: Math.trunc(amountSats), at: Date.now() })
  if (!durableSetItem(key, JSON.stringify(kept))) return null
  return { key, id }
}

export function settleAutoPayReservation(reservation: AutoPayReservation, txid: string | null | undefined): void {
  if (!txid || !/^[0-9a-f]{64}$/i.test(txid)) return
  const rows = readReservations(reservation.key)
  const row = rows?.find(entry => entry.id === reservation.id)
  if (!rows || !row) return
  row.txid = txid
  // A failed write conservatively leaves the original reservation in force.
  durableSetItem(reservation.key, JSON.stringify(rows))
}

function chargedSats(origin: string | undefined, since: number): number | null {
  const rows = readReservations()
  if (!rows) return null
  const own = rows.filter(row => row.origin === normalizeAppHost(origin) && row.at >= since)
  const recorded = new Set(own.flatMap(row => row.txid ? [row.txid] : []))
  return own.reduce((total, row) => total + row.sats, 0) + getSpentSatsSince(origin, since, recorded)
}

export const DEFAULT_AUTO_PAY_MAX_USD = 10
export const DEFAULT_AUTO_PAY_WINDOW_HOURS = 24

export type AutoPaySettings = {
  enabled: boolean
  maxUsd: number
  windowHours: number
  /** Last FX snapshot of maxUsd — used when the live rate is unavailable. */
  maxSats?: number
  updatedAt: number
}

/** Choice passed from permission UI into setAutoPaySettings. */
export type AutoPayChoice = {
  enabled: boolean
  maxUsd: number
  windowHours: number
}

type Store = Record<string, AutoPaySettings>

type Listener = () => void

const listeners = new Set<Listener>()

function usdToSats(usd: number, usdPerBsv: number): number {
  if (!(usd > 0) || !(usdPerBsv > 0)) return 0
  return Math.round((usd / usdPerBsv) * 1e8)
}

function readStore(): Store {
  try {
    const raw = durableGetItem(accountLocalKey(STORAGE_KEY))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Store = {}
    for (const [origin, value] of Object.entries(parsed as Store)) {
      if (!value || typeof value !== 'object') continue
      const maxUsd =
        typeof value.maxUsd === 'number' && value.maxUsd > 0
          ? value.maxUsd
          : DEFAULT_AUTO_PAY_MAX_USD
      const windowHours =
        typeof value.windowHours === 'number' && value.windowHours > 0
          ? Math.max(1, Math.min(744, Math.trunc(value.windowHours)))
          : DEFAULT_AUTO_PAY_WINDOW_HOURS
      const maxSats =
        typeof value.maxSats === 'number' &&
        Number.isFinite(value.maxSats) &&
        value.maxSats > 0
          ? Math.trunc(value.maxSats)
          : undefined
      out[normalizeAppHost(origin)] = {
        enabled: !!value.enabled,
        maxUsd,
        windowHours,
        maxSats,
        updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
      }
    }
    return out
  } catch {
    return {}
  }
}

function writeStore(store: Store): void {
  durableSetItem(accountLocalKey(STORAGE_KEY), JSON.stringify(store))
  for (const cb of listeners) cb()
}

/** Persist a refreshed maxSats without bumping updatedAt / notifying if unchanged. */
function persistMaxSatsSnapshot(originKey: string, maxSats: number): void {
  if (!(maxSats > 0)) return
  const store = readStore()
  const row = store[originKey]
  if (!row?.enabled) return
  if (row.maxSats === maxSats) return
  store[originKey] = { ...row, maxSats }
  writeStore(store)
}

export function subscribeAutoPay(cb: Listener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function getAutoPaySettings(origin: string | undefined): AutoPaySettings | null {
  const key = normalizeAppHost(origin)
  return readStore()[key] ?? null
}

export function setAutoPaySettings(
  origin: string | undefined,
  settings: { enabled: boolean; maxUsd?: number; windowHours?: number },
): void {
  const key = normalizeAppHost(origin)
  const store = readStore()
  if (!settings.enabled) {
    delete store[key]
    writeStore(store)
    return
  }
  const maxUsd =
    typeof settings.maxUsd === 'number' && Number.isFinite(settings.maxUsd) && settings.maxUsd > 0
      ? Math.round(settings.maxUsd * 100) / 100
      : DEFAULT_AUTO_PAY_MAX_USD
  const windowHours =
    typeof settings.windowHours === 'number' &&
    Number.isFinite(settings.windowHours) &&
    settings.windowHours > 0
      ? Math.min(744, Math.max(1, Math.round(settings.windowHours)))
      : DEFAULT_AUTO_PAY_WINDOW_HOURS
  const rate = getCachedUsdPerBsv()
  const prior = store[key]
  const maxSats =
    rate && rate > 0
      ? usdToSats(maxUsd, rate)
      : prior?.maxUsd === maxUsd && prior.maxSats && prior.maxSats > 0
        ? prior.maxSats
        : undefined
  store[key] = {
    enabled: true,
    maxUsd,
    windowHours,
    maxSats: maxSats && maxSats > 0 ? maxSats : undefined,
    updatedAt: Date.now(),
  }
  writeStore(store)
}

export function clearAutoPaySettings(origin?: string): void {
  if (!origin) {
    writeStore({})
    return
  }
  const store = readStore()
  delete store[normalizeAppHost(origin)]
  writeStore(store)
}

/** Whether this payment can skip the approve dialog. */
export function canAutoProcessPayment(
  origin: string | undefined,
  method: string,
  amountSats?: number,
): boolean {
  const settings = getAutoPaySettings(origin)
  if (!settings?.enabled) return false

  // A signAction must authorize its exact prepared action. Merely enabling
  // Auto-pay is not authority to sign an arbitrary reference/spend payload.
  if (method !== 'createAction') return false

  const sats = typeof amountSats === 'number' ? Math.max(0, amountSats) : 0
  if (sats <= 0) return false

  // BRC spendingAuthorization grant (monthly sats) takes precedence when present.
  const grant = getSpendingAuthorizationGrant(origin)
  if (grant) {
    const charged = chargedSats(origin, startOfUtcMonth())
    return charged != null && charged + sats <= grant.amountSats
  }

  const windowMs = settings.windowHours * 60 * 60_000
  const spentSats = chargedSats(origin, Date.now() - windowMs)
  if (spentSats == null) return false
  const rate = getCachedUsdPerBsv()

  if (rate && rate > 0) {
    const maxSats = usdToSats(settings.maxUsd, rate)
    persistMaxSatsSnapshot(normalizeAppHost(origin), maxSats)

    const paymentUsd = satsToUsd(sats, rate)
    if (paymentUsd > settings.maxUsd) return false
    const spentUsd = satsToUsd(spentSats, rate)
    return spentUsd + paymentUsd <= settings.maxUsd
  }

  // No live FX — fall back to the last cached sat budget for this dollar intent.
  const maxSats = settings.maxSats
  if (!maxSats || !(maxSats > 0)) return false
  if (sats > maxSats) return false
  return spentSats + sats <= maxSats
}
