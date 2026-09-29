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
 * own once the user has approved it — a request still waiting on the prompt
 * is not activity — and that row keeps the action's phase until the durable
 * row claims it; a row with no live action reads its settlement from the
 * chain record.
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
  // A live phase describes the wallet's work before a transaction exists. Once
  // signed, the transaction is the fact: the row reads its standing from the
  // record (sent · unconfirmed · confirmed · failed), and whatever the wallet
  // still does afterwards — hand-off, sealing, notifying — is not the row's
  // story. Arcade rejecting it later repaints the row through the record.
  //
  // A live row has no record to read. Its synthesized entry is not a chain
  // fact, so it keeps the action's phase from signing through settling; the
  // moment the durable row lands it takes over. Reading the synthesized entry
  // as a record flashed "Unconfirmed" between the txid and the write.
  const liveRow = entry.id.startsWith(LIVE_ROW_PREFIX)
  if (live && isStage(live.face) && (!live.txid || liveRow)) return live.face
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
 * A live action the feed shows as its own row while nothing durable claims it.
 * Not while approving: a request the user has not accepted is a prompt, not
 * activity — denying it must leave no trace. Not once settled: the durable row
 * is the record, and if none was written there was nothing to show.
 */
export function liveActionIsFeedRow(action: LiveAction): boolean {
  return action.face !== 'approving' && action.face !== 'settled'
}

/** Feed = durable rows + one row per approved live action nobody has recorded yet. */
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
  const orphans = live.filter((action) => !claimed.has(action.id) && liveActionIsFeedRow(action))
  if (orphans.length === 0) return durable
  return [...orphans.map(liveActionEntry), ...durable]
}
