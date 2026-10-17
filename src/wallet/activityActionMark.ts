/**
 * The action an Activity row records, as one name per action.
 *
 * Listing, cancelling a listing, selling, and buying are four different things
 * that happen to a collectable, so each one gets its own mark — and the UI owes
 * every mark its own glyph. Sharing a glyph between two actions (a sale drawn as
 * a listing) makes the feed lie about what happened.
 */
import {
  isBurnActivity,
  isEventActivity,
  isFailedActivity,
  isMintCollectableActivity,
  isMintTokenActivity,
  type ActivityEntry,
} from './appActivity'

export type ActivityActionMark =
  | 'failed'
  | 'list'
  | 'cancel'
  | 'sale'
  | 'purchase'
  | 'freeze'
  | 'release'
  | 'swap'
  | 'burn'
  | 'mint'
  | 'send'
  | 'receive'

export const ACTION_MARK_LABEL: Record<ActivityActionMark, string> = {
  failed: 'Failed',
  list: 'Listing',
  cancel: 'Cancel listing',
  sale: 'Sold',
  purchase: 'Purchase',
  freeze: 'Frozen',
  release: 'Released',
  swap: 'Swap',
  burn: 'Burn',
  mint: 'Mint',
  send: 'Send',
  receive: 'Receive',
}

/**
 * Wallet actions recorded as events or as transfers that are not plain sends.
 * A swap offer freezes an exact lot in escrow (basket `token-swap-offers`) until
 * it is taken or cancelled; cancelling releases it back to the balance.
 */
const ACTION_MARKS: Record<string, ActivityActionMark> = {
  'market-list': 'list',
  'market-cancel': 'cancel',
  'market-sale': 'sale',
  'market-sale-proceeds': 'sale',
  'market-purchase': 'purchase',
  'market-purchase-receive': 'purchase',
  'token-swap-offer': 'freeze',
  'token-swap-cancel': 'release',
  'token-swap': 'swap',
  'token-swap-proceeds': 'swap',
}

/** Null when the row records no wallet action — a connect, a friend, a heal. */
export function activityActionMark(entry: ActivityEntry): ActivityActionMark | null {
  const named = ACTION_MARKS[entry.method]
  // Listings, cancels and swap escrows are written as wallet events, yet each is
  // an action the user took. Every other event has no action to mark.
  if (!named && isEventActivity(entry)) return null
  if (isFailedActivity(entry)) return 'failed'
  if (named) return named
  if (isBurnActivity(entry)) return 'burn'
  if (isMintTokenActivity(entry) || isMintCollectableActivity(entry)) return 'mint'
  return entry.kind === 'spent' ? 'send' : 'receive'
}
