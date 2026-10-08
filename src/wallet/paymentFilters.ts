import { appDisplayName, normalizeAppHost } from './appIdentity'
import {
  listRecentActivity,
  WALLET_ACTIVITY_ORIGIN,
  type ActivityEntry,
  type ActivityKind,
} from './appActivity'
import { actionTimeLabelsForWindow } from './brc114'
import { listConnectedApps } from './permissions'

export type PaymentKindFilter = 'all' | ActivityKind
export type PaymentTimeFilter = 'all' | '24h' | '7d' | '30d'
export type PaymentStatusFilter = 'all' | 'failed' | 'success'

/** `all` = entire wallet activity; otherwise a connected/history app origin. */
export type PaymentOriginFilter = 'all' | string

export type PaymentFilters = {
  kind: PaymentKindFilter
  time: PaymentTimeFilter
  origin: PaymentOriginFilter
  status: PaymentStatusFilter
}

export const DEFAULT_PAYMENT_FILTERS: PaymentFilters = {
  kind: 'all',
  time: 'all',
  origin: 'all',
  status: 'all',
}

const TIME_MS: Record<Exclude<PaymentTimeFilter, 'all'>, number> = {
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
}

export function paymentTimeCutoff(time: PaymentTimeFilter, now = Date.now()): number | null {
  if (time === 'all') return null
  return now - TIME_MS[time]
}

/** BRC-114 control labels matching a PaymentTimeFilter window (empty when `all`). */
export function brc114LabelsForPaymentTime(
  time: PaymentTimeFilter,
  now = Date.now(),
): string[] {
  if (time === 'all') return []
  return actionTimeLabelsForWindow(TIME_MS[time], now)
}

export function matchesPaymentFilters(
  entry: ActivityEntry,
  filters: PaymentFilters,
  now = Date.now(),
): boolean {
  if (filters.kind !== 'all' && entry.kind !== filters.kind) return false

  if (filters.origin !== 'all') {
    const key = normalizeAppHost(filters.origin)
    if (normalizeAppHost(entry.origin) !== key) return false
  }

  const cutoff = paymentTimeCutoff(filters.time, now)
  if (cutoff != null && entry.at < cutoff) return false

  if (filters.status === 'failed') {
    if (entry.status !== 'failed') return false
  } else if (filters.status === 'success') {
    if (entry.status === 'failed') return false
  }

  return true
}

export function filterPaymentActivity(
  entries: ActivityEntry[],
  filters: PaymentFilters,
  now = Date.now(),
): ActivityEntry[] {
  return entries.filter((e) => matchesPaymentFilters(e, filters, now))
}

export type PaymentOriginOption = {
  id: PaymentOriginFilter
  label: string
}

/**
 * Apps inside this wallet (connected + seen in activity).
 * "All" means the whole wallet — apps are filters within it, not peers of the wallet.
 */
export function listPaymentOriginOptions(limit = 200): PaymentOriginOption[] {
  const seen = new Set<string>()
  const apps: PaymentOriginOption[] = []

  for (const entry of listRecentActivity(limit)) {
    const origin = normalizeAppHost(entry.origin)
    if (origin === WALLET_ACTIVITY_ORIGIN || seen.has(origin)) continue
    seen.add(origin)
    apps.push({ id: origin, label: appDisplayName(origin) })
  }

  for (const app of listConnectedApps()) {
    const origin = normalizeAppHost(app.origin)
    if (origin === WALLET_ACTIVITY_ORIGIN || seen.has(origin)) continue
    seen.add(origin)
    apps.push({ id: origin, label: app.name?.trim() || appDisplayName(origin) })
  }

  apps.sort((a, b) => a.label.localeCompare(b.label))

  return [
    { id: 'all', label: 'Everything' },
    { id: WALLET_ACTIVITY_ORIGIN, label: 'Wallet coins' },
    ...apps,
  ]
}
