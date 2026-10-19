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
import { TICKER_COINS, TICKER_COIN_ORDER } from '../wallet/tickerCoin'

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
export function TickerCoinSelector({ selected, onPick }: { selected: MarketCoin; onPick: (coin: MarketCoin) => void }) {
  const [, priced] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const unsub = subscribeBsvMarket(priced)
    void refreshMarketBoard()
    return unsub
  }, [])

  return (
    <div data-aeon-scope="ticker-coins">
      <ul data-aeon-part="list" role="listbox" aria-label="Show in ticker">
        {TICKER_COIN_ORDER.map((coin) => {
          const stats = getCachedBsvMarket(coin)
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
              </ListRow.Root>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
