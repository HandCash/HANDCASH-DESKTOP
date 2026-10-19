import { bchWallet } from '../wallet/bch/bchWallet'
import { btcWallet } from '../wallet/btc/btcWallet'
import type { CoinChain } from '../wallet/coins/coinChains'
import type { CoinWallet } from '../wallet/coins/coinWallet'
import { dogeWallet } from '../wallet/doge/dogeWallet'
import { ltcWallet } from '../wallet/ltc/ltcWallet'

/** The coin engine of every chain, for views that read or show it synchronously. */
export const COIN_WALLETS: Record<CoinChain, CoinWallet> = { ltc: ltcWallet, bch: bchWallet, btc: btcWallet, doge: dogeWallet }
