/**
 * The native coins this wallet holds (BRC-213 bindings), as presentation and
 * the bridge name them. Lightweight on purpose: no keys, no engine, so prompts
 * and views can import it without loading a chain.
 */

export const COIN_CHAINS = ['ltc', 'bch', 'btc', 'doge'] as const
export type CoinChain = (typeof COIN_CHAINS)[number]

export type CoinInfo = {
  label: string
  ticker: string
  decimals: number
  /** Blocks a received coin is buried under on the wallet's own header chain before it is spent; each binding's proof depth. */
  confirmations: number
  /** The chain's target block interval; only ever used for a labelled estimate. */
  blockMinutes: number
  /** The address forms a payee may give, as a placeholder hint. */
  addressHint: string
  url: string
}

export const COIN_INFO: Record<CoinChain, CoinInfo> = {
  ltc: { label: 'Litecoin', ticker: 'LTC', decimals: 8, confirmations: 6, blockMinutes: 2.5, addressHint: 'ltc1… or L…', url: 'https://litecoin.org/' },
  bch: { label: 'Bitcoin Cash', ticker: 'BCH', decimals: 8, confirmations: 6, blockMinutes: 10, addressHint: 'bitcoincash:q…', url: 'https://bitcoincash.org/' },
  btc: { label: 'Bitcoin', ticker: 'BTC', decimals: 8, confirmations: 3, blockMinutes: 10, addressHint: 'bc1… or 3…', url: 'https://bitcoin.org/' },
  doge: { label: 'Dogecoin', ticker: 'DOGE', decimals: 8, confirmations: 20, blockMinutes: 1, addressHint: 'D… or A…', url: 'https://dogecoin.com/' },
}

export const isCoinChain = (value: unknown): value is CoinChain => COIN_CHAINS.includes(value as CoinChain)

/** The approval prompt's title for a payment on `chain`. */
export const coinApprovalTitle = (chain: CoinChain): string => `Approve ${COIN_INFO[chain].label} payment`

/** The chain a prompt title names, for copy that has only the title. */
export const coinChainOfApprovalTitle = (title: string | undefined): CoinChain | null =>
  COIN_CHAINS.find((chain) => coinApprovalTitle(chain) === title) ?? null

/** `units` of the smallest unit as a decimal string, trailing zeros dropped. */
/** At most four significant digits, for summaries where exact units don't matter. */
export function formatCoinShort(chain: CoinChain, units: bigint): string {
  return (Number(units) / 10 ** COIN_INFO[chain].decimals).toLocaleString('en-US', {
    maximumSignificantDigits: 4,
    useGrouping: false,
  })
}

export function formatCoin(chain: CoinChain, units: bigint): string {
  const scale = 10n ** BigInt(COIN_INFO[chain].decimals)
  const whole = units / scale
  const frac = (units % scale).toString().padStart(COIN_INFO[chain].decimals, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}
