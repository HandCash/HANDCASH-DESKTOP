import { useSyncExternalStore } from 'react'
import { subscribeAppActivity } from './activity'
import { COIN_WALLETS } from './coinWallets'
import { COIN_CHAINS, type CoinChain } from '../wallet/coins/coinChains'
import type { CoinDepositView } from '../wallet/coins/depositPhase'

const NONE: readonly CoinDepositView[] = []

function store(chain: CoinChain) {
  let cached: { key: string; views: CoinDepositView[] } = { key: '[]', views: [] }
  return {
    snapshot(): CoinDepositView[] {
      const views = COIN_WALLETS[chain].readCoinViews()
      const key = JSON.stringify(views)
      if (key !== cached.key) cached = { key, views }
      return cached.views
    },
    subscribe(listener: () => void): () => void {
      COIN_WALLETS[chain].ensureMigrated()
      const coin = COIN_WALLETS[chain].subscribe(listener)
      // An account switch changes whose record is read; activity fires on it.
      const activity = subscribeAppActivity(listener)
      return () => {
        coin()
        activity()
      }
    },
  }
}

const STORES = Object.fromEntries(COIN_CHAINS.map((chain) => [chain, store(chain)])) as Record<CoinChain, ReturnType<typeof store>>
const noneStore = { snapshot: () => NONE, subscribe: () => () => {} }

/** Coins the open account received on `chain`, newest first, re-read whenever the record changes; none without a chain. */
export function useCoinDeposits(chain: CoinChain | null): readonly CoinDepositView[] {
  const s = chain ? STORES[chain] : noneStore
  return useSyncExternalStore(s.subscribe, s.snapshot, s.snapshot)
}

/** The coin `txid` paid this wallet on `chain`, if any. */
export function useCoinDepositByTxid(chain: CoinChain | null, txid: string | undefined): CoinDepositView | null {
  const views = useCoinDeposits(chain)
  if (!txid) return null
  return views.find((v) => v.txid === txid) ?? null
}
