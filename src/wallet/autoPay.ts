import { normalizeAppHost } from './appIdentity'
import { getSpentSatsSince } from './appActivity'
import { getCachedUsdPerBsv, satsToUsd } from './fx'

const STORAGE_KEY = 'handcash.brc100.autoPay'

export const DEFAULT_AUTO_PAY_MAX_USD = 10
export const DEFAULT_AUTO_PAY_WINDOW_HOURS = 24

export type AutoPaySettings = {
  enabled: boolean
  maxUsd: number
  windowHours: number
  updatedAt: number
}

type Store = Record<string, AutoPaySettings>

type Listener = () => void

const listeners = new Set<Listener>()

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
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
          ? value.windowHours
          : DEFAULT_AUTO_PAY_WINDOW_HOURS
      out[normalizeAppHost(origin)] = {
        enabled: !!value.enabled,
        maxUsd,
        windowHours,
        updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
      }
    }
    return out
  } catch {
    return {}
  }
}

function writeStore(store: Store): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  for (const cb of listeners) cb()
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
      ? Math.round(settings.windowHours)
      : DEFAULT_AUTO_PAY_WINDOW_HOURS
  store[key] = {
    enabled: true,
    maxUsd,
    windowHours,
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

  // Signing completes a prior payment flow — allow when auto-pay is on.
  if (method === 'signAction') return true
  if (method !== 'createAction') return false

  const sats = typeof amountSats === 'number' ? Math.max(0, amountSats) : 0
  if (sats <= 0) return false

  const rate = getCachedUsdPerBsv()
  if (!rate) return false

  const paymentUsd = satsToUsd(sats, rate)
  if (paymentUsd > settings.maxUsd) return false

  const windowMs = settings.windowHours * 60 * 60_000
  const spentSats = getSpentSatsSince(origin, Date.now() - windowMs)
  const spentUsd = satsToUsd(spentSats, rate)
  return spentUsd + paymentUsd <= settings.maxUsd
}
