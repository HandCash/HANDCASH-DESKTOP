import { type DisplayCurrency } from './displayCurrency'
import { DEFAULT_BRC_CLOUD_BASE_URL } from './walletConfig'
import { formatBsvSignificant } from './session'

const CACHE_KEY = 'handcash.brc100.bsvUsd'
const CACHE_TTL_MS = 5 * 60_000
const RATE_BACKOFF_MS = 15 * 60_000
let rateBackoffUntil = 0

export function noteFxRateLimited(): void {
  rateBackoffUntil = Date.now() + RATE_BACKOFF_MS
}

export function isFxRateLimited(): boolean {
  return Date.now() < rateBackoffUntil
}

type RateCache = {
  usdPerBsv: number
  fetchedAt: number
}

let memory: RateCache | null = null
const listeners = new Set<(rate: number | null) => void>()

function readCache(): RateCache | null {
  if (memory && Date.now() - memory.fetchedAt < CACHE_TTL_MS) return memory
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as RateCache
    if (
      typeof parsed.usdPerBsv === 'number' &&
      parsed.usdPerBsv > 0 &&
      typeof parsed.fetchedAt === 'number'
    ) {
      memory = parsed
      return parsed
    }
  } catch {
    // ignore
  }
  return null
}

function writeCache(usdPerBsv: number): void {
  memory = { usdPerBsv, fetchedAt: Date.now() }
  localStorage.setItem(CACHE_KEY, JSON.stringify(memory))
  for (const cb of listeners) cb(usdPerBsv)
}

async function fetchFromCoinGecko(): Promise<number> {
  const tryDirect = async (): Promise<number> => {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash-sv&vs_currencies=usd',
    )
    if (res.status === 429) {
      noteFxRateLimited()
      throw new Error('coingecko 429')
    }
    if (!res.ok) throw new Error(`coingecko ${res.status}`)
    const data = (await res.json()) as { 'bitcoin-cash-sv'?: { usd?: number } }
    const rate = data['bitcoin-cash-sv']?.usd
    if (typeof rate !== 'number' || !(rate > 0)) throw new Error('bad coingecko rate')
    return rate
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
        const data = (await res.json()) as { usdPerBsv?: number }
        if (typeof data.usdPerBsv === 'number' && data.usdPerBsv > 0) return data.usdPerBsv
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
    const rate = await fetchFromCoinGecko()
    writeCache(rate)
    return rate
  } catch (err) {
    console.warn('[fx] CoinGecko rate failed', err)
  }
  return cached?.usdPerBsv ?? null
}

export function satsToUsd(sats: number, usdPerBsv: number | null = getCachedUsdPerBsv()): number {
  if (!usdPerBsv || !Number.isFinite(sats)) return 0
  return (Math.max(0, sats) / 1e8) * usdPerBsv
}

/** Convert a typed display amount (USD or BSV) into satoshis. */
export function amountToSats(
  amount: string | number,
  currency: DisplayCurrency,
  usdPerBsv: number | null = getCachedUsdPerBsv(),
): number {
  const n = typeof amount === 'number' ? amount : Number(String(amount).trim())
  if (!Number.isFinite(n) || n <= 0) return 0
  if (currency === 'bsv') return Math.round(n * 1e8)
  if (usdPerBsv == null || !(usdPerBsv > 0)) return 0
  return Math.round((n / usdPerBsv) * 1e8)
}

/** Format a typed primary amount for confirm/success copy. */
export function formatTypedAmount(amount: string, currency: DisplayCurrency): string {
  const n = Number(String(amount).trim())
  if (!Number.isFinite(n) || n < 0) return currency === 'usd' ? '$0' : '0 BSV'
  if (currency === 'usd') {
    return n.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 4,
    })
  }
  return `${n} BSV`
}

export function formatUsd(
  amount: number,
  opts?: { compact?: boolean; signed?: boolean },
): string {
  const safe = Number.isFinite(amount) ? amount : 0
  const abs = Math.abs(safe)
  // A positive value must never be rendered as "$0.00". Tips routinely carry
  // one or a few satoshis, so cent precision erases the entire meaning of the
  // card. Compact affects large numbers only; small values earn enough decimal
  // places to preserve their first significant digit.
  const digits =
    abs === 0 || abs >= 0.01
      ? 2
      : abs >= 0.0001
        ? 4
        : abs >= 0.000001
          ? 6
          : 8
  const body = abs.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits > 2 ? 2 : digits,
    maximumFractionDigits: digits,
  })
  if (!opts?.signed || safe === 0) return body
  return safe > 0 ? `+${body}` : `-${body.replace('$', '')}`
}

export function formatUsdFromSats(
  sats: number,
  usdPerBsv: number | null = getCachedUsdPerBsv(),
  opts?: { compact?: boolean; signed?: boolean },
): string {
  if (usdPerBsv == null) return '—'
  return formatUsd(satsToUsd(sats, usdPerBsv), opts)
}

/** Primary amount according to display-currency preference. */
export function formatPrimaryFromSats(
  sats: number,
  currency: DisplayCurrency,
  usdPerBsv: number | null = getCachedUsdPerBsv(),
  opts?: { compact?: boolean; signed?: boolean },
): string {
  // Outside the hero balance, BSV uses 5 significant figures.
  if (currency === 'bsv') return formatBsvSignificant(sats, 5)
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
