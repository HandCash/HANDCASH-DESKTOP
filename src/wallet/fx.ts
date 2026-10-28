import { storageRegistry } from '../storage/registry'
import { type DisplayCurrency } from './displayCurrency'
import {
  FIAT_CODES,
  getFiatCurrency,
  getFiatOption,
  type FiatCode,
} from './fiatCurrency'
import { DEFAULT_BRC_CLOUD_BASE_URL } from './walletConfig'
import { formatBsvSignificant } from './session'

const CACHE_KEY = storageRegistry.bsvUsd.key
const CACHE_TTL_MS = 5 * 60_000
const RATE_BACKOFF_MS = 15 * 60_000
const VS = FIAT_CODES.join(',')

let rateBackoffUntil = 0

export function noteFxRateLimited(): void {
  rateBackoffUntil = Date.now() + RATE_BACKOFF_MS
}

export function isFxRateLimited(): boolean {
  return Date.now() < rateBackoffUntil
}

type RateCache = {
  /** Fiat units per 1 BSV, keyed by fiat code. `usd` is always present when valid. */
  perBsv: Partial<Record<FiatCode, number>>
  /** Legacy mirror of perBsv.usd for older cache readers. */
  usdPerBsv: number
  fetchedAt: number
}

let memory: RateCache | null = null
const listeners = new Set<(rate: number | null) => void>()

function asPositive(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null
}

function readCache(): RateCache | null {
  if (memory && Date.now() - memory.fetchedAt < CACHE_TTL_MS) return memory
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<RateCache>
    const usd =
      asPositive(parsed.usdPerBsv) ??
      asPositive(parsed.perBsv?.usd)
    if (!usd || typeof parsed.fetchedAt !== 'number') return null
    const perBsv: Partial<Record<FiatCode, number>> = { ...(parsed.perBsv ?? {}), usd }
    memory = { perBsv, usdPerBsv: usd, fetchedAt: parsed.fetchedAt }
    return memory
  } catch {
    return null
  }
}

function writeCache(perBsv: Partial<Record<FiatCode, number>>): void {
  const usd = asPositive(perBsv.usd)
  if (!usd) return
  memory = { perBsv: { ...perBsv, usd }, usdPerBsv: usd, fetchedAt: Date.now() }
  localStorage.setItem(CACHE_KEY, JSON.stringify(memory))
  for (const cb of listeners) cb(usd)
}

function parseCoinGeckoRow(row: Record<string, unknown> | undefined): Partial<Record<FiatCode, number>> {
  const out: Partial<Record<FiatCode, number>> = {}
  if (!row) return out
  for (const code of FIAT_CODES) {
    const n = asPositive(row[code])
    if (n != null) out[code] = n
  }
  return out
}

async function fetchFromCoinGecko(): Promise<Partial<Record<FiatCode, number>>> {
  const tryDirect = async (): Promise<Partial<Record<FiatCode, number>>> => {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash-sv&vs_currencies=${VS}`,
    )
    if (res.status === 429) {
      noteFxRateLimited()
      throw new Error('coingecko 429')
    }
    if (!res.ok) throw new Error(`coingecko ${res.status}`)
    const data = (await res.json()) as { 'bitcoin-cash-sv'?: Record<string, unknown> }
    const perBsv = parseCoinGeckoRow(data['bitcoin-cash-sv'])
    if (!asPositive(perBsv.usd)) throw new Error('bad coingecko rate')
    return perBsv
  }

  // Dev uses the Vite proxy to BRC-CLOUD; when that route 502s the browser logs
  // scary noise even though direct CoinGecko works. Prefer direct in dev.
  if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
    return tryDirect()
  }

  const cloudBase =
    DEFAULT_BRC_CLOUD_BASE_URL.replace(/\/+$/, '') ||
    (typeof window !== 'undefined' ? window.location.origin : '')
  if (cloudBase) {
    try {
      const res = await fetch(`${cloudBase}/v1/fx/bsv-usd`, {
        headers: { Accept: 'application/json' },
      })
      if (res.status === 429) {
        noteFxRateLimited()
        throw new Error('coingecko 429')
      }
      if (res.ok) {
        const data = (await res.json()) as {
          usdPerBsv?: number
          perBsv?: Partial<Record<FiatCode, number>>
        }
        if (data.perBsv && asPositive(data.perBsv.usd)) return data.perBsv
        if (asPositive(data.usdPerBsv)) return { usd: data.usdPerBsv }
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'coingecko 429') throw err
      /* fall through to direct fetch (Electron / no proxy) */
    }
  }

  return tryDirect()
}

/** Cached BSV→USD. Returns null until a successful fetch. */
export function getCachedUsdPerBsv(): number | null {
  return readCache()?.usdPerBsv ?? null
}

/** Cached BSV→fiat for a government currency. */
export function getCachedFiatPerBsv(code: FiatCode = getFiatCurrency()): number | null {
  const cache = readCache()
  if (!cache) return null
  return asPositive(cache.perBsv[code]) ?? (code === 'usd' ? cache.usdPerBsv : null)
}

export function subscribeUsdRate(cb: (rate: number | null) => void): () => void {
  listeners.add(cb)
  cb(getCachedUsdPerBsv())
  return () => {
    listeners.delete(cb)
  }
}

export async function refreshUsdPerBsv(force = false): Promise<number | null> {
  const cached = readCache()
  if (isFxRateLimited()) return cached?.usdPerBsv ?? null
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.usdPerBsv
  }
  try {
    const perBsv = await fetchFromCoinGecko()
    writeCache(perBsv)
    return asPositive(perBsv.usd) ?? null
  } catch (err) {
    console.warn('[fx] CoinGecko rate failed', err)
  }
  return cached?.usdPerBsv ?? null
}

export function satsToUsd(sats: number, usdPerBsv: number | null = getCachedUsdPerBsv()): number {
  if (!usdPerBsv || !Number.isFinite(sats)) return 0
  return (Math.max(0, sats) / 1e8) * usdPerBsv
}

export function satsToFiat(
  sats: number,
  code: FiatCode = getFiatCurrency(),
  perBsv: number | null = getCachedFiatPerBsv(code),
): number {
  if (!perBsv || !Number.isFinite(sats)) return 0
  return (Math.max(0, sats) / 1e8) * perBsv
}

/** Convert a USD amount into the preferred fiat using cached cross rates. */
export function usdToPreferredFiat(usdAmount: number): number {
  const code = getFiatCurrency()
  if (code === 'usd') return usdAmount
  const usd = getCachedFiatPerBsv('usd')
  const fiat = getCachedFiatPerBsv(code)
  if (!usd || !fiat) return usdAmount
  return usdAmount * (fiat / usd)
}

/** Convert a typed display amount (preferred fiat or BSV) into satoshis. */
export function amountToSats(
  amount: string | number,
  currency: DisplayCurrency,
  usdPerBsv: number | null = getCachedUsdPerBsv(),
): number {
  const n = typeof amount === 'number' ? amount : Number(String(amount).trim())
  if (!Number.isFinite(n) || n <= 0) return 0
  if (currency === 'bsv') return Math.round(n * 1e8)
  const fiatPerBsv = getCachedFiatPerBsv(getFiatCurrency()) ?? usdPerBsv
  if (fiatPerBsv == null || !(fiatPerBsv > 0)) return 0
  return Math.round((n / fiatPerBsv) * 1e8)
}

/** Format a typed primary amount for confirm/success copy. */
export function formatTypedAmount(amount: string, currency: DisplayCurrency): string {
  const n = Number(String(amount).trim())
  if (!Number.isFinite(n) || n < 0) {
    return currency === 'usd' ? formatFiat(0) : '0 BSV'
  }
  if (currency === 'usd') return formatFiat(n, { alreadyPreferred: true })
  return `${n} BSV`
}

function fiatDigits(abs: number, iso: string): { min: number; max: number } {
  // Yen / won are whole-unit currencies.
  if (iso === 'JPY' || iso === 'KRW') {
    return { min: 0, max: abs >= 1 || abs === 0 ? 0 : 2 }
  }
  const max =
    abs === 0 || abs >= 0.01
      ? 2
      : abs >= 0.0001
        ? 4
        : abs >= 0.000001
          ? 6
          : 8
  return { min: max > 2 ? 2 : max, max }
}

/**
 * Format a money amount for the preferred government currency.
 * By default `amount` is USD (what most call sites already compute); pass
 * `alreadyPreferred` when the number is already in that fiat.
 */
export function formatFiat(
  amount: number,
  opts?: { compact?: boolean; signed?: boolean; alreadyPreferred?: boolean },
): string {
  const fiat = getFiatOption()
  const safe = Number.isFinite(amount) ? amount : 0
  const preferred = opts?.alreadyPreferred ? safe : usdToPreferredFiat(safe)
  const abs = Math.abs(preferred)
  const { min, max } = fiatDigits(abs, fiat.iso)
  const body = abs.toLocaleString(fiat.locale, {
    style: 'currency',
    currency: fiat.iso,
    minimumFractionDigits: min,
    maximumFractionDigits: max,
  })
  if (!opts?.signed || preferred === 0) return body
  return preferred > 0 ? `+${body}` : `-${body.replace(/^\D+/, '')}`
}

/** @deprecated Prefer {@link formatFiat}; kept as the historical name. */
export function formatUsd(
  amount: number,
  opts?: { compact?: boolean; signed?: boolean },
): string {
  return formatFiat(amount, opts)
}

export function formatUsdFromSats(
  sats: number,
  usdPerBsv: number | null = getCachedUsdPerBsv(),
  opts?: { compact?: boolean; signed?: boolean },
): string {
  const code = getFiatCurrency()
  const perBsv = getCachedFiatPerBsv(code) ?? (code === 'usd' ? usdPerBsv : null)
  if (perBsv == null) return '—'
  return formatFiat(satsToFiat(sats, code, perBsv), { ...opts, alreadyPreferred: true })
}

/** Primary amount according to display-currency preference. */
export function formatPrimaryFromSats(
  sats: number,
  currency: DisplayCurrency,
  usdPerBsv: number | null = getCachedUsdPerBsv(),
  opts?: { compact?: boolean; signed?: boolean; significant?: number },
): string {
  // Outside the hero balance, BSV uses 5 significant figures unless a summary asks for fewer.
  if (currency === 'bsv') return formatBsvSignificant(sats, opts?.significant ?? 5)
  return formatUsdFromSats(sats, usdPerBsv, opts)
}

/** Companion amount (the other unit), compact for row chips. */
export function formatSecondaryFromSats(
  sats: number,
  currency: DisplayCurrency,
  usdPerBsv: number | null = getCachedUsdPerBsv(),
): string {
  if (currency === 'usd') return formatBsvSignificant(sats, 5)
  return formatUsdFromSats(sats, usdPerBsv, { compact: true })
}
