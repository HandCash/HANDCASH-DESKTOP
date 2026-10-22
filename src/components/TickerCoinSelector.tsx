import { useEffect, useReducer } from 'react'
import { ListRow } from '@aeon-ui/react'
import { stateToAttr } from '@aeon-ui/core'
import { bsvLogoDefault } from '../assets/brand/bsvLogos'
import { DeferredImage } from './DeferredImage'
import { BitcoinCashIcon, BitcoinIcon, DogecoinIcon, LitecoinIcon } from './icons'
import {
  formatPct,
  formatPriceUsd,
  getCachedBsvMarket,
  refreshMarketBoard,
  subscribeBsvMarket,
  type MarketCoin,
} from '../wallet/bsvMarket'
import { TICKER_COINS } from '../wallet/tickerCoin'
import { useHeldCoins } from '../features/heldCoins'
import { useShownMarketCoins } from '../features/acceptedCoins'
import { coinUsd } from '../wallet/heldValue'
import { COIN_INFO, formatCoinShort, type CoinChain } from '../wallet/coins/coinChains'
import { formatBsvSignificant } from '../wallet/session'
import { formatUsd, formatUsdFromSats } from '../wallet/fx'

/** What the wallet holds of `coin`, short, with its value at the ticker's quote; null when none. */
export function heldIn(
  coin: MarketCoin,
  heldBsvSats: number | null,
  heldCoins: Record<CoinChain, bigint>,
  priceUsd: number | null,
): { amount: string; usd: string | null } | null {
  if (coin === 'bsv') {
    if (!heldBsvSats) return null
    return {
      amount: formatBsvSignificant(heldBsvSats, 4),
      usd: priceUsd == null ? null : formatUsdFromSats(heldBsvSats, priceUsd),
    }
  }
  const units = heldCoins[coin]
  if (units === 0n) return null
  const usd = coinUsd(coin, units, priceUsd)
  return { amount: `${formatCoinShort(coin, units)} ${COIN_INFO[coin].ticker}`, usd: usd == null ? null : formatUsd(usd) }
}

const COIN_MARKS = { ltc: LitecoinIcon, bch: BitcoinCashIcon, btc: BitcoinIcon, doge: DogecoinIcon } as const

export function TickerCoinMark({ coin, size }: { coin: MarketCoin; size: number }) {
  if (coin !== 'bsv') {
    const Mark = COIN_MARKS[coin]
    return <Mark size={size} />
  }
  return (
    <DeferredImage src={bsvLogoDefault} width={size} height={size} skeletonRadius={size / 4} draggable={false} />
  )
}

/** Every coin the ticker can show, priced from the cache; picking one is the caller's event. */
export function TickerCoinSelector({
  selected,
  heldBsvSats,
  onPick,
}: {
  selected: MarketCoin
  heldBsvSats: number | null
  onPick: (coin: MarketCoin) => void
}) {
  const heldCoins = useHeldCoins()
  const coins = useShownMarketCoins()
  const [, priced] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const unsub = subscribeBsvMarket(priced)
    void refreshMarketBoard()
    return unsub
  }, [])

  return (
    <div data-aeon-scope="ticker-coins">
      <ul data-aeon-part="list" role="listbox" aria-label="Show in ticker">
        {coins.map((coin) => {
          const stats = getCachedBsvMarket(coin)
          const held = heldIn(coin, heldBsvSats, heldCoins, stats?.priceUsd ?? null)
          return (
            <li key={coin}>
              <ListRow.Root
                role="option"
                aria-selected={coin === selected}
                data-aeon-part="coin"
                data-aeon-state={stateToAttr(coin === selected ? 'selected' : 'idle')}
                onClick={() => onPick(coin)}
              >
                <ListRow.Leading aria-hidden>
                  <TickerCoinMark coin={coin} size={32} />
                </ListRow.Leading>
                <span data-aeon-part="copy">
                  <ListRow.Label>{TICKER_COINS[coin].name}</ListRow.Label>
                  <ListRow.Description>
                    {stats ? `${formatPriceUsd(stats.priceUsd)} · ${formatPct(stats.change24hPct)} 24h` : 'Price unavailable'}
                  </ListRow.Description>
                </span>
                {held ? (
                  <span data-aeon-part="held" aria-label={`You hold ${held.amount}`}>
                    <span data-aeon-part="held-amount">{held.amount}</span>
                    {held.usd ? <span data-aeon-part="held-usd">{held.usd}</span> : null}
                  </span>
                ) : (
                  <span data-aeon-part="held">
                    <span data-aeon-part="held-amount">{TICKER_COINS[coin].sym}</span>
                  </span>
                )}
              </ListRow.Root>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
