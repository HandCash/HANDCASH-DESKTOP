import { SWAP_ACTIVITY_PREFIX, WALLET_ACTIVITY_ORIGIN, type ActivityEntry, type ActivitySwap } from '../appActivity'
import { SWAP_ASSET_INFO } from './assets'
import type { SwapView } from './swapView'

/**
 * Swaps in Activity: one record per swap, whichever route it took.
 *
 * A swap moves coins in several transactions — a deposit and Exolix's payout,
 * or a lock, a claim and maybe a refund — on two chains. Shown raw those read
 * as unrelated sends and receives, and a swap still waiting on its
 * counterparty shows nothing at all. Each swap gets a row of its own that
 * names it and says where it stands, and every transaction of it folds under
 * that row (`sendGroupId` = the swap), the same way a wallet job folds its legs.
 */

export const swapGroupOf = (view: Pick<SwapView, 'id'>): string => `${SWAP_ACTIVITY_PREFIX}${view.id}`

export const isSwapGroup = (group: string | undefined): boolean => !!group?.startsWith(SWAP_ACTIVITY_PREFIX)

const VERB: Record<SwapView['tone'], string> = { done: 'Swapped', moving: 'Swapping', returned: 'Swap', stopped: 'Swap' }

/** "Swapping BSV for LTC" — Activity names an action by its verb, not by a status pill. */
export function swapActivityTitle(view: Pick<SwapView, 'tone' | 'from' | 'to'>): string {
  return `${VERB[view.tone]} ${SWAP_ASSET_INFO[view.from].ticker} for ${SWAP_ASSET_INFO[view.to].ticker}`
}

function swapEntry(view: SwapView): ActivityEntry {
  const swap: ActivitySwap = {
    id: view.id,
    route: view.route,
    from: view.from,
    to: view.to,
    state: view.state,
    tone: view.tone,
    title: swapActivityTitle(view),
    status: view.status,
    receive: view.receive.toString(),
  }
  return {
    id: swapGroupOf(view),
    origin: WALLET_ACTIVITY_ORIGIN,
    kind: 'event',
    sats: 0,
    at: view.createdAt,
    method: 'swap',
    note: view.status,
    sendGroupId: swapGroupOf(view),
    swap,
  }
}

/**
 * `entries` (newest first) with each swap's row in its place and every
 * transaction of a swap folded under it. `onlyWithLegs`: a filtered feed shows
 * a swap only when one of its transactions passed the filter.
 */
export function foldSwapActivity(
  entries: readonly ActivityEntry[],
  views: readonly SwapView[],
  opts: { onlyWithLegs?: boolean } = {},
): ActivityEntry[] {
  if (views.length === 0) return entries as ActivityEntry[]
  const groupOfTxid = new Map<string, string>()
  for (const view of views) for (const leg of view.legs) groupOfTxid.set(leg.txid, swapGroupOf(view))
  const withLegs = new Set<string>()
  const tagged = entries.map((entry) => {
    const group = entry.txid ? groupOfTxid.get(entry.txid.toLowerCase()) : undefined
    if (!group) return entry
    withLegs.add(group)
    return entry.sendGroupId === group ? entry : { ...entry, sendGroupId: group }
  })
  const rows = views
    .filter((view) => !opts.onlyWithLegs || withLegs.has(swapGroupOf(view)))
    .map(swapEntry)
    .sort((a, b) => b.at - a.at)
  if (rows.length === 0) return tagged
  const out: ActivityEntry[] = []
  let next = 0
  for (const entry of tagged) {
    while (next < rows.length && rows[next]!.at >= entry.at) out.push(rows[next++]!)
    out.push(entry)
  }
  while (next < rows.length) out.push(rows[next++]!)
  return out
}
