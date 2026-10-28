import {
  formatUsd,
  isFxRateLimited,
  noteFxRateLimited,
  refreshUsdPerBsv,
} from '../wallet/fx'
import { storageRegistry } from '../storage/registry'
import type { CoinChain } from './coins/coinChains'

const TOTAL_SUPPLY = 21_000_000
const CACHE_TTL_MS = 5 * 60_000
const OFFICIAL_URL = 'https://bsvblockchain.org/'

/**
 * Coins the ticker can price: BSV, every native UTXO coin (BRC-213), and Arc USD
 * (Circle USDC on Arc — crypto, not fiat).
 */
export type MarketCoin = 'bsv' | CoinChain | 'arc-usd'

/** Stablecoin tickers that are not BRC-213 UTXO chains. */
export const STABLE_MARKET_COINS = ['arc-usd'] as const
export type StableMarketCoin = (typeof STABLE_MARKET_COINS)[number]

export const isStableMarketCoin = (value: unknown): value is StableMarketCoin =>
  STABLE_MARKET_COINS.includes(value as StableMarketCoin)

const COINS: Record<MarketCoin, { gecko: string | null; cacheKey: string; totalSupply: number }> = {
  bsv: { gecko: 'bitcoin-cash-sv', cacheKey: storageRegistry.bsvMarket.key, totalSupply: TOTAL_SUPPLY },
  ltc: { gecko: 'litecoin', cacheKey: storageRegistry.ltcMarket.key, totalSupply: 84_000_000 },
  bch: { gecko: 'bitcoin-cash', cacheKey: storageRegistry.bchMarket.key, totalSupply: TOTAL_SUPPLY },
  btc: { gecko: 'bitcoin', cacheKey: storageRegistry.btcMarket.key, totalSupply: TOTAL_SUPPLY },
  // Dogecoin has no cap.
  doge: { gecko: 'dogecoin', cacheKey: storageRegistry.dogeMarket.key, totalSupply: 0 },
  // Arc USD: dollar-pegged; no CoinGecko id required — refresh returns a $1 peg.
  'arc-usd': { gecko: null, cacheKey: 'handcash.brc100.arcUsdMarket', totalSupply: 0 },
}

export type BsvChartRange = '24h' | '7d' | '30d'

export const BSV_CHART_RANGES: BsvChartRange[] = ['24h', '7d', '30d']

export const BSV_CHART_RANGE_LABEL: Record<BsvChartRange, string> = {
  '24h': '24h',
  '7d': '7D',
  '30d': '1M',
}

export type BsvSparklines = Record<BsvChartRange, number[]>

export type BsvMarketStats = {
  priceUsd: number
  change24hPct: number | null
  change7dPct: number | null
  change30dPct: number | null
  totalSupply: number
  minedSupply: number
  sparklines: BsvSparklines
  /** @deprecated prefer sparklines['24h'] — kept for older cache readers */
  sparkline: number[]
  fetchedAt: number
}

type Listener = () => void

const listeners = new Set<Listener>()
const memory: Partial<Record<MarketCoin, BsvMarketStats>> = {}

const EMPTY_SPARKLINES: BsvSparklines = {
  '24h': [],
  '7d': [],
  '30d': [],
}

function downsample(values: number[], maxPoints = 64): number[] {
  if (values.length <= maxPoints) return values
  const step = Math.ceil(values.length / maxPoints)
  return values.filter((_, i) => i % step === 0)
}

function sliceSparkline(
  prices: Array<[number, number]>,
  windowMs: number,
): number[] {
  if (prices.length === 0) return []
  const end = prices[prices.length - 1]![0]
  const start = end - windowMs
  const sliced = prices
    .filter(([ts]) => ts >= start)
    .map(([, price]) => price)
    .filter((n) => Number.isFinite(n))
  return downsample(sliced.length >= 2 ? sliced : prices.map(([, p]) => p).filter(Number.isFinite))
}

function pctFromSeries(values: number[]): number | null {
  if (values.length < 2) return null
  const first = values[0]!
  const last = values[values.length - 1]!
  if (!(first > 0) || !Number.isFinite(last)) return null
  return ((last - first) / first) * 100
}

function normalizeSparklines(raw: unknown, legacy?: number[]): BsvSparklines {
  const base = { ...EMPTY_SPARKLINES }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    for (const key of BSV_CHART_RANGES) {
      const list = o[key]
      if (Array.isArray(list)) {
        base[key] = list.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
      }
    }
  }
  if (!base['24h'].length && legacy?.length) base['24h'] = legacy
  if (!base['7d'].length && legacy?.length) base['7d'] = legacy
  if (!base['30d'].length && legacy?.length) base['30d'] = legacy
  return base
}

function readCache(coin: MarketCoin): BsvMarketStats | null {
  const held = memory[coin]
  if (held && Date.now() - held.fetchedAt < CACHE_TTL_MS) return held
  try {
    const raw = localStorage.getItem(COINS[coin].cacheKey)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<BsvMarketStats> & {
      sparkline?: number[]
      sparklines?: unknown
    }
    if (typeof parsed.priceUsd === 'number' && parsed.priceUsd > 0) {
      const sparklines = normalizeSparklines(parsed.sparklines, parsed.sparkline)
      const stats: BsvMarketStats = {
        priceUsd: parsed.priceUsd,
        change24hPct: typeof parsed.change24hPct === 'number' ? parsed.change24hPct : null,
        change7dPct: typeof parsed.change7dPct === 'number' ? parsed.change7dPct : null,
        change30dPct: typeof parsed.change30dPct === 'number' ? parsed.change30dPct : null,
        totalSupply: typeof parsed.totalSupply === 'number' ? parsed.totalSupply : COINS[coin].totalSupply,
        minedSupply:
          typeof parsed.minedSupply === 'number' ? parsed.minedSupply : COINS[coin].totalSupply,
        sparklines,
        sparkline: sparklines['24h'],
        fetchedAt: typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0,
      }
      memory[coin] = stats
      return stats
    }
  } catch {
    // ignore
  }
  return null
}

function writeCache(coin: MarketCoin, stats: BsvMarketStats): void {
  memory[coin] = stats
  localStorage.setItem(COINS[coin].cacheKey, JSON.stringify(stats))
  for (const cb of listeners) cb()
}

export function getCachedBsvMarket(coin: MarketCoin = 'bsv'): BsvMarketStats | null {
  return readCache(coin)
}

export function subscribeBsvMarket(cb: Listener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function nextBsvChartRange(current: BsvChartRange): BsvChartRange {
  const i = BSV_CHART_RANGES.indexOf(current)
  return BSV_CHART_RANGES[(i + 1) % BSV_CHART_RANGES.length]!
}

export function changePctForRange(
  stats: BsvMarketStats | null,
  range: BsvChartRange,
): number | null {
  if (!stats) return null
  if (range === '24h') return stats.change24hPct
  if (range === '7d') return stats.change7dPct
  return stats.change30dPct
}

export function sparklineForRange(
  stats: BsvMarketStats | null,
  range: BsvChartRange,
): number[] {
  if (!stats) return []
  const series = stats.sparklines?.[range]
  if (series?.length) return series
  return stats.sparkline ?? []
}

export { OFFICIAL_URL, TOTAL_SUPPLY }

async function fetchMinedSupply(): Promise<number | null> {
  try {
    const res = await fetch('https://api.whatsonchain.com/v1/bsv/main/circulatingsupply')
    if (res.status === 429) {
      noteFxRateLimited()
      return null
    }
    if (!res.ok) return null
    const text = await res.text()
    const n = Number.parseFloat(text)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

async function fetchCoinGecko(id: string): Promise<{
  priceUsd: number
  change24hPct: number | null
  change7dPct: number | null
  change30dPct: number | null
  minedSupply: number | null
  sparklines: BsvSparklines
} | null> {
  try {
    const [coinRes, chartRes] = await Promise.all([
      fetch(
        `https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&community_data=false&developer_data=false&price_change_percentage=24h,7d,30d`,
      ),
      // 30d hourly series — slice into 24h / 7d / 1M for matching sparklines
      fetch(
        `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=30`,
      ),
    ])
    if (coinRes.status === 429 || chartRes.status === 429) {
      noteFxRateLimited()
      return null
    }
    if (!coinRes.ok) return null
    const coin = (await coinRes.json()) as {
      market_data?: {
        current_price?: { usd?: number }
        price_change_percentage_24h?: number
        price_change_percentage_7d_in_currency?: number
        price_change_percentage_7d?: number
        price_change_percentage_30d_in_currency?: number
        price_change_percentage_30d?: number
        circulating_supply?: number
      }
    }
    const md = coin.market_data
    const priceUsd = md?.current_price?.usd
    if (typeof priceUsd !== 'number' || !(priceUsd > 0)) return null

    let sparklines: BsvSparklines = { ...EMPTY_SPARKLINES }
    if (chartRes.ok) {
      const chart = (await chartRes.json()) as { prices?: Array<[number, number]> }
      const prices = (chart.prices ?? []).filter(
        (p): p is [number, number] =>
          Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number',
      )
      sparklines = {
        '24h': sliceSparkline(prices, 24 * 60 * 60_000),
        '7d': sliceSparkline(prices, 7 * 24 * 60 * 60_000),
        '30d': downsample(prices.map(([, p]) => p).filter(Number.isFinite)),
      }
    }

    const change24hPct =
      typeof md?.price_change_percentage_24h === 'number'
        ? md.price_change_percentage_24h
        : pctFromSeries(sparklines['24h'])
    const change7dPct =
      typeof md?.price_change_percentage_7d_in_currency === 'number'
        ? md.price_change_percentage_7d_in_currency
        : typeof md?.price_change_percentage_7d === 'number'
          ? md.price_change_percentage_7d
          : pctFromSeries(sparklines['7d'])
    const change30dPct =
      typeof md?.price_change_percentage_30d_in_currency === 'number'
        ? md.price_change_percentage_30d_in_currency
        : typeof md?.price_change_percentage_30d === 'number'
          ? md.price_change_percentage_30d
          : pctFromSeries(sparklines['30d'])

    return {
      priceUsd,
      change24hPct,
      change7dPct,
      change30dPct,
      minedSupply:
        typeof md?.circulating_supply === 'number' && md.circulating_supply > 0
          ? md.circulating_supply
          : null,
      sparklines,
    }
  } catch {
    return null
  }
}

type BoardRow = {
  id?: string
  current_price?: number
  circulating_supply?: number | null
  price_change_percentage_24h_in_currency?: number | null
  price_change_percentage_7d_in_currency?: number | null
  price_change_percentage_30d_in_currency?: number | null
  sparkline_in_7d?: { price?: number[] }
}

const finite = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? n : null)

/** One coin's stats from a `/coins/markets` row, keeping the cached 30-day series the row does not carry. */
export function statsFromBoardRow(coin: MarketCoin, row: BoardRow, cached: BsvMarketStats | null, now: number): BsvMarketStats | null {
  const priceUsd = finite(row.current_price)
  if (priceUsd == null || !(priceUsd > 0)) return null
  const week = (row.sparkline_in_7d?.price ?? []).filter((n) => Number.isFinite(n))
  const sparklines: BsvSparklines = {
    '24h': week.length >= 2 ? downsample(week.slice(-24)) : (cached?.sparklines['24h'] ?? []),
    '7d': week.length >= 2 ? downsample(week) : (cached?.sparklines['7d'] ?? []),
    '30d': cached?.sparklines['30d'] ?? [],
  }
  const supply = finite(row.circulating_supply)
  return {
    priceUsd,
    change24hPct: finite(row.price_change_percentage_24h_in_currency) ?? pctFromSeries(sparklines['24h']),
    change7dPct: finite(row.price_change_percentage_7d_in_currency) ?? pctFromSeries(sparklines['7d']),
    change30dPct: finite(row.price_change_percentage_30d_in_currency) ?? cached?.change30dPct ?? null,
    totalSupply: COINS[coin].totalSupply,
    minedSupply: supply && supply > 0 ? supply : (cached?.minedSupply ?? COINS[coin].totalSupply),
    sparklines,
    sparkline: sparklines['24h'],
    fetchedAt: now,
  }
}

let boardInFlight: Promise<void> | null = null

/**
 * Every coin the ticker can show, priced in one CoinGecko request. The coin
 * list must not fan out one detail request per coin: the free tier refuses
 * the burst and every uncached coin would show no price.
 */
export function refreshMarketBoard(force = false): Promise<void> {
  if (boardInFlight) return boardInFlight
  const all = Object.keys(COINS) as MarketCoin[]
  if (isFxRateLimited()) return Promise.resolve()
  const fresh = (c: MarketCoin) => {
    const s = readCache(c)
    return !!s && Date.now() - s.fetchedAt < CACHE_TTL_MS
  }
  if (!force && all.every(fresh)) return Promise.resolve()
  boardInFlight = (async () => {
    try {
      const ids = all.map((c) => COINS[c].gecko).join(',')
      const res = await fetch(
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&price_change_percentage=24h,7d,30d&sparkline=true`,
      )
      if (res.status === 429) {
        noteFxRateLimited()
        return
      }
      if (!res.ok) return
      const rows = (await res.json()) as BoardRow[]
      if (!Array.isArray(rows)) return
      const now = Date.now()
      for (const coin of all) {
        const row = rows.find((r) => r.id === COINS[coin].gecko)
        const stats = row ? statsFromBoardRow(coin, row, readCache(coin), now) : null
        if (stats) writeCache(coin, stats)
      }
    } catch {
      // keep what is cached
    } finally {
      boardInFlight = null
    }
  })()
  return boardInFlight
}

const inFlight: Partial<Record<MarketCoin, Promise<BsvMarketStats | null>>> = {}

export function refreshBsvMarket(force = false, coin: MarketCoin = 'bsv'): Promise<BsvMarketStats | null> {
  const running = inFlight[coin]
  if (running) return running
  const run = refreshCoin(force, coin).finally(() => {
    delete inFlight[coin]
  })
  inFlight[coin] = run
  return run
}

async function refreshCoin(force: boolean, coin: MarketCoin): Promise<BsvMarketStats | null> {
  const cached = readCache(coin)
  if (isFxRateLimited()) return cached
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached

  // Arc USD: $1 peg — crypto stablecoin, not a government fiat.
  if (coin === 'arc-usd') {
    const flat = cached?.sparklines?.['24h']?.length
      ? cached.sparklines
      : {
          '24h': [1, 1, 1, 1, 1, 1, 1, 1],
          '7d': [1, 1, 1, 1, 1, 1, 1, 1],
          '30d': [1, 1, 1, 1, 1, 1, 1, 1],
        }
    const stats: BsvMarketStats = {
      priceUsd: 1,
      change24hPct: 0,
      change7dPct: 0,
      change30dPct: 0,
      totalSupply: 0,
      minedSupply: 0,
      sparklines: flat,
      sparkline: flat['24h'],
      fetchedAt: Date.now(),
    }
    writeCache(coin, stats)
    return stats
  }

  // WhatsOnChain supply and the wallet's own BSV rate exist for BSV only.
  const bsv = coin === 'bsv'
  const geckoId = COINS[coin].gecko
  const [gecko, minedWoc, priceFallback] = await Promise.all([
    geckoId ? fetchCoinGecko(geckoId) : null,
    bsv ? fetchMinedSupply() : null,
    bsv ? refreshUsdPerBsv(force) : null,
  ])

  const priceUsd = gecko?.priceUsd ?? priceFallback ?? cached?.priceUsd
  if (priceUsd == null || !(priceUsd > 0)) return cached

  const sparklines = gecko?.sparklines ?? cached?.sparklines ?? EMPTY_SPARKLINES
  const stats: BsvMarketStats = {
    priceUsd,
    change24hPct: gecko?.change24hPct ?? cached?.change24hPct ?? null,
    change7dPct: gecko?.change7dPct ?? cached?.change7dPct ?? null,
    change30dPct: gecko?.change30dPct ?? cached?.change30dPct ?? null,
    totalSupply: COINS[coin].totalSupply,
    minedSupply: gecko?.minedSupply ?? minedWoc ?? cached?.minedSupply ?? COINS[coin].totalSupply,
    sparklines,
    sparkline: sparklines['24h'].length ? sparklines['24h'] : (cached?.sparkline ?? []),
    fetchedAt: Date.now(),
  }
  writeCache(coin, stats)
  return stats
}

export function formatPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value).toLocaleString('en-US', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })
  return `${value >= 0 ? '' : '-'}${abs}%`
}

export function formatBsvAmount(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

export function formatPriceUsd(value: number | null): string {
  if (value == null) return '—'
  return formatUsd(value)
}
