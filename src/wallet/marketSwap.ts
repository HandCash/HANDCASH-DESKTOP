/**
 * HandCash market swap helpers — currencies from items-market `/api/exolix/currencies`,
 * Desktop flow at `/wallet/swap` (BRC-100 + ChangeNOW).
 */
import { DEFAULT_MARKET_BASE_URL } from './walletConfig'

export type MarketSwapCurrency = {
  code: string
  name: string
  icon?: string
  eta: string
}

/** Prefer these when the catalog is large; only codes present in the API are kept. */
export const POPULAR_SWAP_CODES = [
  'BTC',
  'ETH',
  'USDT',
  'USDC',
  'LTC',
  'SOL',
  'XRP',
  'DOGE',
  'BNB',
  'TRX',
] as const

export const SWAP_ETA = '~10–60 min'
export const NATIVE_BSV_ETA = 'Instant'

const cache: { at: number; list: MarketSwapCurrency[] } = { at: 0, list: [] }
const CACHE_MS = 10 * 60 * 1000

function marketOrigin(): string {
  return DEFAULT_MARKET_BASE_URL.replace(/\/+$/, '')
}

export function buildSwapUrl(opts: {
  direction: 'buy' | 'sell'
  coin: string
}): string {
  const code = opts.coin.trim().toUpperCase()
  const url = new URL(`${marketOrigin()}/wallet/swap`)
  url.searchParams.set('direction', opts.direction)
  if (opts.direction === 'buy') url.searchParams.set('from', code)
  else url.searchParams.set('to', code)
  return url.toString()
}

/** Buy BSV with another asset (Receive / Add money). */
export function buildBuyBsvSwapUrl(fromCoin?: string): string {
  if (fromCoin?.trim()) return buildSwapUrl({ direction: 'buy', coin: fromCoin })
  return `${marketOrigin()}/wallet/swap`
}

/** Sell BSV for another asset (Send destination). */
export function buildSellBsvSwapUrl(toCoin: string): string {
  return buildSwapUrl({ direction: 'sell', coin: toCoin })
}

export async function fetchSwapCurrencies(options?: {
  signal?: AbortSignal
  limit?: number
}): Promise<MarketSwapCurrency[]> {
  const now = Date.now()
  if (cache.list.length > 0 && now - cache.at < CACHE_MS) {
    return options?.limit ? cache.list.slice(0, options.limit) : cache.list
  }

  const res = await fetch(`${marketOrigin()}/api/exolix/currencies?page=1&size=100`, {
    signal: options?.signal,
    cache: 'no-store',
  })
  const json = (await res.json()) as
    | { data?: Array<{ code?: string; name?: string; icon?: string }>; error?: string }
    | Array<{ code?: string; name?: string; icon?: string }>
  if (!res.ok) {
    const err =
      json && !Array.isArray(json) && typeof json.error === 'string'
        ? json.error
        : `Failed to load currencies (${res.status})`
    throw new Error(err)
  }

  const raw = Array.isArray(json) ? json : (json.data ?? [])
  const byCode = new Map<string, MarketSwapCurrency>()
  for (const row of raw) {
    const code = (row.code ?? '').trim().toUpperCase()
    if (!code || code === 'BSV' || code === 'MNEE') continue
    if (byCode.has(code)) continue
    byCode.set(code, {
      code,
      name: (row.name ?? code).trim() || code,
      icon: row.icon || undefined,
      eta: SWAP_ETA,
    })
  }

  const popular: MarketSwapCurrency[] = []
  for (const code of POPULAR_SWAP_CODES) {
    const hit = byCode.get(code)
    if (hit) {
      popular.push(hit)
      byCode.delete(code)
    }
  }
  const rest = [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code))
  cache.list = [...popular, ...rest]
  cache.at = now
  return options?.limit ? cache.list.slice(0, options.limit) : cache.list
}

export function openMarketSwap(url: string): void {
  void window.handcash?.openExternal?.(url)
}
