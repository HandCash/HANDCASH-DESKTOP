import { setup } from 'xstate'
import type { MarketCoin } from '../wallet/bsvMarket'
import { isCompactShell } from '../wallet/isCompactShell'
import { openTickerCoins } from '../wallet/navStore'
import { setTickerCoin } from '../wallet/tickerCoin'

/**
 * The market ticker and its coin selector. On Desktop the selector replaces
 * the ticker inside the side column; a compact shell has no side column, so
 * CHOOSE opens the selector in the main section and the ticker stays put.
 */
export const tickerMachine = setup({
  types: {
    events: {} as { type: 'CHOOSE' } | { type: 'PICK'; coin: MarketCoin } | { type: 'CLOSE' },
  },
  guards: {
    choosesInPlace: () => !isCompactShell(),
  },
  actions: {
    openInMain: () => openTickerCoins(),
    pick: (_, coin: MarketCoin) => setTickerCoin(coin),
  },
}).createMachine({
  id: 'ticker',
  initial: 'market',
  states: {
    market: {
      on: {
        CHOOSE: [{ guard: 'choosesInPlace', target: 'choosing' }, { actions: 'openInMain' }],
      },
    },
    choosing: {
      on: {
        PICK: { target: 'market', actions: { type: 'pick', params: ({ event }) => event.coin } },
        CLOSE: 'market',
      },
    },
  },
})
