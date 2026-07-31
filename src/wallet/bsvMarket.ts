import {
  formatUsd,
  refreshUsdPerBsv,
} from '../wallet/fx'

const TOTAL_SUPPLY = 21_000_000
const CACHE_KEY = 'handcash.brc100.bsvMarket'
const CACHE_TTL_MS = 5 * 60_000
const OFFICIAL_URL = 'https://bsvblockchain.org/'

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
let memory: BsvMarketStats | null = null

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

function readCache(): BsvMarketStats | null {
  if (memory && Date.now() - memory.fetchedAt < CACHE_TTL_MS) return memory
  try {
    const raw = localStorage.getItem(CACHE_KEY)
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
        totalSupply: typeof parsed.totalSupply === 'number' ? parsed.totalSupply : TOTAL_SUPPLY,
        minedSupply:
          typeof parsed.minedSupply === 'number' ? parsed.minedSupply : TOTAL_SUPPLY,
        sparklines,
        sparkline: sparklines['24h'],
        fetchedAt: typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0,
      }
      memory = stats
      return stats
    }
  } catch {
    // ignore
  }
  return null
}

function writeCache(stats: BsvMarketStats): void {
  memory = stats
  localStorage.setItem(CACHE_KEY, JSON.stringify(stats))
  for (const cb of listeners) cb()
}

export function getCachedBsvMarket(): BsvMarketStats | null {
  return readCache()
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
    if (!res.ok) return null
    const text = await res.text()
    const n = Number.parseFloat(text)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

async function fetchCoinGecko(): Promise<{
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
        'https://api.coingecko.com/api/v3/coins/bitcoin-cash-sv?localization=false&tickers=false&community_data=false&developer_data=false&price_change_percentage=24h,7d,30d',
      ),
      // 30d hourly series — slice into 24h / 7d / 1M for matching sparklines
      fetch(
        'https://api.coingecko.com/api/v3/coins/bitcoin-cash-sv/market_chart?vs_currency=usd&days=30',
      ),
    ])
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

export async function refreshBsvMarket(force = false): Promise<BsvMarketStats | null> {
  const cached = readCache()
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached

  const [gecko, minedWoc, priceFallback] = await Promise.all([
    fetchCoinGecko(),
    fetchMinedSupply(),
    refreshUsdPerBsv(force),
  ])

  const priceUsd = gecko?.priceUsd ?? priceFallback ?? cached?.priceUsd
  if (priceUsd == null || !(priceUsd > 0)) return cached

  const sparklines = gecko?.sparklines ?? cached?.sparklines ?? EMPTY_SPARKLINES
  const stats: BsvMarketStats = {
    priceUsd,
    change24hPct: gecko?.change24hPct ?? cached?.change24hPct ?? null,
    change7dPct: gecko?.change7dPct ?? cached?.change7dPct ?? null,
    change30dPct: gecko?.change30dPct ?? cached?.change30dPct ?? null,
    totalSupply: TOTAL_SUPPLY,
    minedSupply: gecko?.minedSupply ?? minedWoc ?? cached?.minedSupply ?? TOTAL_SUPPLY,
    sparklines,
    sparkline: sparklines['24h'].length ? sparklines['24h'] : (cached?.sparkline ?? []),
    fetchedAt: Date.now(),
  }
  writeCache(stats)
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
