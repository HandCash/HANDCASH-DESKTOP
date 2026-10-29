import type { MarketCoin } from '../bsvMarket'
import { COIN_CHAINS, COIN_INFO, type CoinChain } from '../coins/coinChains'
import { ARC_USDC_DECIMALS } from '../arcUsdc/chain'

/**
 * What a swap moves: BSV, every UTXO coin this wallet holds on its own chain
 * (`coins/coinChains.ts`), and native USDC on Arc. Amounts are always in the
 * smallest unit (satoshis, litoshi, koinu, USDC atoms) as bigint; decimals
 * only at the edges.
 */
export const SWAP_ASSETS = ['bsv', ...COIN_CHAINS, 'arc-usd'] as const
export type SwapAsset = (typeof SWAP_ASSETS)[number] & MarketCoin

/** UTXO legs use Bitcoin-family HTLC scripts; Arc USDC uses an ERC-20 HTLC encoding. */
export const isUtxoSwapAsset = (asset: SwapAsset): asset is Exclude<SwapAsset, 'arc-usd'> => asset !== 'arc-usd'

/** Exolix's coin and network codes for each UTXO chain. */
const EXOLIX: Record<CoinChain, { coin: string; network: string }> = {
  ltc: { coin: 'LTC', network: 'LTC' },
  bch: { coin: 'BCH', network: 'BCH' },
  btc: { coin: 'BTC', network: 'BTC' },
  doge: { coin: 'DOGE', network: 'DOGE' },
}

export const SWAP_ASSET_INFO: Record<
  SwapAsset,
  { ticker: string; label: string; decimals: number; exolix: { coin: string; network: string } }
> = {
  bsv: { ticker: 'BSV', label: 'Bitcoin SV', decimals: 8, exolix: { coin: 'BSV', network: 'BSV' } },
  ...(Object.fromEntries(
    COIN_CHAINS.map((chain) => [
      chain,
      {
        ticker: COIN_INFO[chain].ticker,
        label: COIN_INFO[chain].label,
        decimals: COIN_INFO[chain].decimals,
        exolix: EXOLIX[chain],
      },
    ]),
  ) as Record<CoinChain, { ticker: string; label: string; decimals: number; exolix: { coin: string; network: string } }>),
  'arc-usd': {
    ticker: 'USDC',
    label: 'USDC',
    decimals: ARC_USDC_DECIMALS,
    // Arc is not an Exolix network — direct wallet-to-wallet only for this asset.
    exolix: { coin: 'USDC', network: 'ARC' },
  },
}

export const isSwapAsset = (value: unknown): value is SwapAsset => SWAP_ASSETS.includes(value as SwapAsset)

/** Smallest units as a decimal string, e.g. 12500000n → "0.125". */
export function unitsToDecimal(asset: SwapAsset, units: bigint): string {
  const d = SWAP_ASSET_INFO[asset].decimals
  const scale = 10n ** BigInt(d)
  const sign = units < 0n ? '-' : ''
  const abs = units < 0n ? -units : units
  const frac = (abs % scale).toString().padStart(d, '0').replace(/0+$/, '')
  return `${sign}${abs / scale}${frac ? `.${frac}` : ''}`
}

/** A decimal amount in smallest units, rounded down; null for anything that is not a plain non-negative decimal. */
export function decimalToUnits(asset: SwapAsset, value: number | string): bigint | null {
  const text =
    typeof value === 'number'
      ? Number.isFinite(value) && value >= 0
        ? value.toFixed(SWAP_ASSET_INFO[asset].decimals + 2)
        : ''
      : value.trim()
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text)
  if (!m) return null
  const d = SWAP_ASSET_INFO[asset].decimals
  return BigInt(m[1]!) * 10n ** BigInt(d) + BigInt((m[2] ?? '').slice(0, d).padEnd(d, '0') || '0')
}
