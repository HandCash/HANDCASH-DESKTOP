/**
 * The one token an Activity row projects: which phase the action is in while it
 * runs, or where its transaction stands once it is over.
 *
 *   approving · preparing · signing · broadcasting · settling   (live action)
 *   signed · unconfirmed · confirmed · settled · failed         (durable row)
 *
 * The join between a live action and its durable row is exact — the row's
 * `pendingId` is the action's id, or they share a txid. No matching by time,
 * amount, or method. A live action with no row yet is shown as a row of its
 * own; a row with no live action reads its settlement from the chain record.
 */
import {
  ACTION_STAGE_LABELS,
  ACTION_STAGES,
  type ActionStage,
} from '../../machines/actionLifecycleMachine'
import type { LiveAction } from '../../wallet/actionLifecycle'
import { appDisplayName } from '../../wallet/appIdentity'
import { WALLET_ACTIVITY_ORIGIN, type ActivityEntry } from '../../wallet/appActivity'
import { confirmationsFromHeights, formatSettlementLabel } from '../../wallet/settlementCopy'

export type ActivityRowState =
  | ActionStage
  | 'signed'
  | 'unconfirmed'
  | 'confirmed'
  | 'settled'
  | 'failed'

export const LIVE_ROW_PREFIX = 'live:'

function isStage(face: string): face is ActionStage {
  return (ACTION_STAGES as readonly string[]).includes(face)
}

function normalizeTxid(txid: string | null | undefined): string | null {
  const key = txid?.trim().toLowerCase()
  return key || null
}

/** The live action a durable row belongs to, if one is running. */
export function liveActionForEntry(
  entry: ActivityEntry,
  live: readonly LiveAction[]
): LiveAction | null {
  if (live.length === 0) return null
  if (entry.id.startsWith(LIVE_ROW_PREFIX)) {
    const id = entry.id.slice(LIVE_ROW_PREFIX.length)
    return live.find((action) => action.id === id) ?? null
  }
  const pendingId = entry.pendingId?.trim()
  const txid = normalizeTxid(entry.txid)
  return (
    live.find(
      (action) =>
        (pendingId && action.id === pendingId) || (txid && action.txid === txid)
    ) ?? null
  )
}

export function activityRowState(args: {
  entry: ActivityEntry
  live: LiveAction | null
  chainProof?: 'unconfirmed' | 'headerProven' | null
}): ActivityRowState {
  const { entry, live, chainProof } = args
  if (live && isStage(live.face)) return live.face
  if (entry.status === 'failed') return 'failed'
  if (live?.face === 'failed' && entry.status !== 'complete') return 'failed'
  if (chainProof === 'headerProven') return 'confirmed'
  if (entry.status === 'pending') {
    return normalizeTxid(entry.txid) || chainProof === 'unconfirmed' ? 'unconfirmed' : 'signed'
  }
  return 'settled'
}

/** Words for the state slot; null means the row keeps its timestamp. */
export function activityRowStateLabel(
  state: ActivityRowState,
  heights?: { minedHeight?: number | null; tipHeight?: number | null }
): string | null {
  if (isStage(state)) return ACTION_STAGE_LABELS[state]
  if (state === 'settled') return null
  if (state === 'failed') return 'Failed'
  return formatSettlementLabel({
    phrase: state,
    confirmations: confirmationsFromHeights(heights?.minedHeight, heights?.tipHeight),
  })
}

const ACTION_METHOD_WORDS: Readonly<Record<string, string>> = {
  createAction: 'transaction',
  signAction: 'signature',
  internalizeAction: 'payment',
  createMarketListingAdvert: 'listing',
  createCancelMarketListingAdvert: 'listing cancel',
  purchaseMarketListing: 'purchase',
}

/** What the row is called before a description or txid exists. */
export function liveActionTitle(action: LiveAction): string {
  if (action.description) return action.description
  const origin = action.origin || WALLET_ACTIVITY_ORIGIN
  const who = origin === WALLET_ACTIVITY_ORIGIN ? 'Wallet' : appDisplayName(origin)
  const what = ACTION_METHOD_WORDS[action.method] ?? 'request'
  return `${who} ${what}`
}

/** A row for an action that has no durable row yet — what the user just approved. */
export function liveActionEntry(action: LiveAction): ActivityEntry {
  return {
    id: `${LIVE_ROW_PREFIX}${action.id}`,
    origin: action.origin || WALLET_ACTIVITY_ORIGIN,
    kind: 'spent',
    sats: 0,
    at: action.startedAt,
    method: action.method,
    note: liveActionTitle(action),
    status: action.face === 'failed' ? 'failed' : 'pending',
    pendingId: action.id,
    ...(action.txid ? { txid: action.txid } : {}),
    ...(action.face === 'failed' && action.error ? { failureReason: action.error } : {}),
  }
}

/**
 * Feed = durable rows + one row per live action nobody has recorded yet.
 * Settled actions never add a row: their durable row is the record, and if
 * none was written there was nothing to show.
 */
export function mergeLiveActions(
  entries: readonly ActivityEntry[],
  live: readonly LiveAction[]
): ActivityEntry[] {
  const durable = entries.filter((entry) => !entry.id.startsWith(LIVE_ROW_PREFIX))
  if (live.length === 0) return durable
  const claimed = new Set<string>()
  for (const entry of durable) {
    const action = liveActionForEntry(entry, live)
    if (action) claimed.add(action.id)
  }
  const orphans = live.filter(
    (action) => !claimed.has(action.id) && action.face !== 'settled'
  )
  if (orphans.length === 0) return durable
  return [...orphans.map(liveActionEntry), ...durable]
}
