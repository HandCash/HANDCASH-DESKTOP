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

/** 1.3.573 recorded direct offers as token swaps; those rows read as today's names. */
const RENAMED_METHODS: Record<string, string> = {
  'token-swap-offer': 'direct-offer-list',
  'token-swap-cancel': 'direct-offer-cancel',
  'token-swap': 'direct-offer-buy',
  'token-swap-proceeds': 'direct-offer-sale',
}

export function canonicalActivityMethod(method: string): string {
  return RENAMED_METHODS[method] ?? method
}

/**
 * Offer actions, recorded as events or as transfers that are not plain sends.
 * A direct offer is a listing that is not published to the market: the same
 * list / cancel / sale / purchase, so it gets the same marks.
 */
const ACTION_MARKS: Record<string, ActivityActionMark> = {
  'market-list': 'list',
  'market-cancel': 'cancel',
  'market-sale': 'sale',
  'market-sale-proceeds': 'sale',
  'market-purchase': 'purchase',
  'market-purchase-receive': 'purchase',
  'direct-offer-list': 'list',
  'direct-offer-cancel': 'cancel',
  'direct-offer-buy': 'purchase',
  'direct-offer-sale': 'sale',
}

/** Null when the row records no wallet action — a connect, a friend, a heal. */
export function activityActionMark(entry: ActivityEntry): ActivityActionMark | null {
  const named = ACTION_MARKS[canonicalActivityMethod(entry.method)]
  // Listings and cancels are written as wallet events, yet each is
  // an action the user took. Every other event has no action to mark.
  if (!named && isEventActivity(entry)) return null
  if (isFailedActivity(entry)) return 'failed'
  if (named) return named
  if (isBurnActivity(entry)) return 'burn'
  if (isMintTokenActivity(entry) || isMintCollectableActivity(entry)) return 'mint'
  return entry.kind === 'spent' ? 'send' : 'receive'
}
