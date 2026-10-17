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
  burn: 'Burn',
  mint: 'Mint',
  send: 'Send',
  receive: 'Receive',
}

/**
 * Offer actions, recorded as events or as transfers that are not plain sends.
 * A direct offer (`token-swap-*`) is a listing that is not published to the
 * market: the same list / cancel / sale / purchase, so it gets the same marks.
 */
const ACTION_MARKS: Record<string, ActivityActionMark> = {
  'market-list': 'list',
  'market-cancel': 'cancel',
  'market-sale': 'sale',
  'market-sale-proceeds': 'sale',
  'market-purchase': 'purchase',
  'market-purchase-receive': 'purchase',
  'token-swap-offer': 'list',
  'token-swap-cancel': 'cancel',
  'token-swap': 'purchase',
  'token-swap-proceeds': 'sale',
}

/** Null when the row records no wallet action — a connect, a friend, a heal. */
export function activityActionMark(entry: ActivityEntry): ActivityActionMark | null {
  const named = ACTION_MARKS[entry.method]
  // Listings and cancels are written as wallet events, yet each is
  // an action the user took. Every other event has no action to mark.
  if (!named && isEventActivity(entry)) return null
  if (isFailedActivity(entry)) return 'failed'
  if (named) return named
  if (isBurnActivity(entry)) return 'burn'
  if (isMintTokenActivity(entry) || isMintCollectableActivity(entry)) return 'mint'
  return entry.kind === 'spent' ? 'send' : 'receive'
}
