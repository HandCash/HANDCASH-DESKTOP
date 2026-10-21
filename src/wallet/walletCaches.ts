import { createChartCache } from '@aeon-ui/primitives'
import { getActiveWallet } from './session'
import { listBntAssets, type BntAssetSummary } from './bnt/wallet'
import { browseSwapOfferBook, withOwnTakes, type OfferBookPage } from './swap/offerBook'
import { ownTakenOf } from './swap/settleRunner'

/** The open account on its network, which every wallet cache entry is keyed by. */
export function openWalletCacheKey(): string {
  const active = getActiveWallet()
  return active ? `${active.identityKey}:${active.chain}` : 'locked'
}

/** Loads only for the account still open, so one account's data is never filed under another's key. */
function forOpenWallet<T>(load: () => Promise<T>) {
  return async (key: string): Promise<T> => {
    if (key === 'locked' || openWalletCacheKey() !== key) throw new Error('Wallet locked')
    return load()
  }
}

const walletTags = (key: string) => [`wallet:${key}`]

/**
 * BNT holdings beside 1Sat items. Reading them parses every BNT output, so a
 * revisit is served from here; activity (issue, send, receive) invalidates it.
 * A backed token never leaves its issuer, and Litecoin is held natively, so
 * one here is a retired wLTC record, not value.
 */
export const bntHoldingsCache = createChartCache<BntAssetSummary[]>({
  id: 'bnt-holdings',
  load: forOpenWallet(async () => (await listBntAssets()).assets.filter((a) => !a.backedBy)),
  ttl: 5 * 60_000,
  tags: walletTags,
  maxEntries: 8,
})

/** The swap offer book, every offer verified, with this account's own takes. Cancelling or taking invalidates it. */
export const swapOfferBookCache = createChartCache<OfferBookPage>({
  id: 'swap-offer-book',
  load: forOpenWallet(async () => withOwnTakes(await browseSwapOfferBook(), ownTakenOf())),
  ttl: 60_000,
  tags: walletTags,
  maxEntries: 8,
})

export function clearWalletCaches(): void {
  bntHoldingsCache.clear()
  swapOfferBookCache.clear()
}

if (typeof document !== 'undefined') document.addEventListener('handcash:wallet-locked', clearWalletCaches)
