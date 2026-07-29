import {
  formatUsd,
  refreshUsdPerBsv,
} from '../wallet/fx'

const TOTAL_SUPPLY = 21_000_000
const CACHE_KEY = 'handcash.brc100.bsvMarket'
const CACHE_TTL_MS = 5 * 60_000
const OFFICIAL_URL = 'https://bsvblockchain.org/'

export type BsvMarketStats = {
  priceUsd: number
  change24hPct: number | null
  change7dPct: number | null
  totalSupply: number
  minedSupply: number
  sparkline: number[]
  fetchedAt: number
}

type Listener = () => void

const listeners = new Set<Listener>()
let memory: BsvMarketStats | null = null

function readCache(): BsvMarketStats | null {
  if (memory && Date.now() - memory.fetchedAt < CACHE_TTL_MS) return memory
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as BsvMarketStats
    if (typeof parsed.priceUsd === 'number' && parsed.priceUsd > 0) {
      memory = parsed
      return parsed
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
  minedSupply: number | null
  sparkline: number[]
} | null> {
  try {
    const [coinRes, chartRes] = await Promise.all([
      fetch(
        'https://api.coingecko.com/api/v3/coins/bitcoin-cash-sv?localization=false&tickers=false&community_data=false&developer_data=false',
      ),
      fetch(
        'https://api.coingecko.com/api/v3/coins/bitcoin-cash-sv/market_chart?vs_currency=usd&days=7',
      ),
    ])
    if (!coinRes.ok) return null
    const coin = (await coinRes.json()) as {
      market_data?: {
        current_price?: { usd?: number }
        price_change_percentage_24h?: number
        price_change_percentage_7d?: number
        circulating_supply?: number
      }
    }
    const md = coin.market_data
    const priceUsd = md?.current_price?.usd
    if (typeof priceUsd !== 'number' || !(priceUsd > 0)) return null

    let sparkline: number[] = []
    if (chartRes.ok) {
      const chart = (await chartRes.json()) as { prices?: Array<[number, number]> }
      sparkline = (chart.prices ?? []).map((p) => p[1]).filter((n) => Number.isFinite(n))
      // Downsample for a clean sparkline.
      if (sparkline.length > 64) {
        const step = Math.ceil(sparkline.length / 64)
        sparkline = sparkline.filter((_, i) => i % step === 0)
      }
    }

    return {
      priceUsd,
      change24hPct:
        typeof md?.price_change_percentage_24h === 'number' ? md.price_change_percentage_24h : null,
      change7dPct:
        typeof md?.price_change_percentage_7d === 'number' ? md.price_change_percentage_7d : null,
      minedSupply:
        typeof md?.circulating_supply === 'number' && md.circulating_supply > 0
          ? md.circulating_supply
          : null,
      sparkline,
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

  const stats: BsvMarketStats = {
    priceUsd,
    change24hPct: gecko?.change24hPct ?? cached?.change24hPct ?? null,
    change7dPct: gecko?.change7dPct ?? cached?.change7dPct ?? null,
    totalSupply: TOTAL_SUPPLY,
    minedSupply: gecko?.minedSupply ?? minedWoc ?? cached?.minedSupply ?? TOTAL_SUPPLY,
    sparkline: gecko?.sparkline?.length ? gecko.sparkline : (cached?.sparkline ?? []),
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
