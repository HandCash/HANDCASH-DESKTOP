/**
 * The optimistic "Sending…" / "Listing…" row shown at the top of a feed while a
 * spend is in flight and its durable Activity row has not landed yet.
 *
 * Every feed must reach the same verdict from the same progress state. Deciding
 * from "does this list contain any pending spend" made the answer depend on how
 * many rows the feed happened to load, so Recent activity and Activity could
 * disagree about the same send.
 */
import { WALLET_ACTIVITY_ORIGIN, type ActivityEntry, type ActivityItem } from './appActivity'
import { getCachedCollectables } from './collectables'
import type { PaymentProgress } from './paymentProgress'

export const LIVE_OUTBOUND_ID = 'live-outbound-send'

/** Same window the stuck-payment watchdog uses before a Sending… row is dead. */
const LIVE_OUTBOUND_STALE_MS = 90_000

function dottedOutpoint(outpoint: string | null | undefined): string | null {
  const trimmed = outpoint?.trim()
  return trimmed ? trimmed.toLowerCase().replace(/_/g, '.') : null
}

function liveItem(outpoint: string): ActivityItem {
  const dotted = dottedOutpoint(outpoint) || outpoint
  const held = getCachedCollectables().find(
    (c) =>
      c.outpoint.trim().toLowerCase().replace(/_/g, '.') === dotted,
  )
  return {
    name: held?.name?.trim() || 'Collectable',
    origin: held?.origin || dotted.replace('.', '_'),
    outpoint: dotted,
    ...(held?.imageUrl ? { imageUrl: held.imageUrl } : {}),
    ...(held?.app ? { app: held.app } : {}),
  }
}

function marketMethod(progress: PaymentProgress): 'market-list' | 'market-cancel' | 'purchaseMarketListing' | null {
  const label = (progress.label || '').replace(/…/g, '').trim()
  if (/^list/i.test(label)) return 'market-list'
  if (/^cancel/i.test(label)) return 'market-cancel'
  if (/^buy/i.test(label)) return 'purchaseMarketListing'
  return null
}

/**
 * App-bridge createAction/signAction progress is for the status pill only.
 * Painting it into Activity as Signed/Approving made mint and bounce rows
 * stick after the real mint/payment row had already landed.
 */
function isAppBridgeProgress(progress: PaymentProgress): boolean {
  const label = (progress.label || '').replace(/…/g, '').trim()
  return /^working$/i.test(label)
}

export function liveOutboundActivityEntry(
  progress: PaymentProgress,
  now = Date.now(),
): ActivityEntry {
  const outpoint = dottedOutpoint(progress.outpoint)
  const market = marketMethod(progress)
  const item = outpoint ? liveItem(outpoint) : undefined
  if (market) {
    const verb =
      market === 'market-list' ? 'Listing' : market === 'market-cancel' ? 'Cancelling' : 'Buying'
    return {
      id: LIVE_OUTBOUND_ID,
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'event',
      sats: 0,
      at: now,
      method: market,
      note: item?.name && item.name !== 'Collectable' ? `${verb} ${item.name}…` : `${verb}…`,
      status: 'pending',
      pendingId: LIVE_OUTBOUND_ID,
      ...(item ? { item } : {}),
    }
  }
  return {
    id: LIVE_OUTBOUND_ID,
    origin: WALLET_ACTIVITY_ORIGIN,
    kind: 'spent',
    sats: 0,
    at: now,
    method: outpoint ? 'send-collectable' : 'send',
    note: 'Sending…',
    status: 'pending',
    pendingId: LIVE_OUTBOUND_ID,
    ...(item ? { item } : {}),
  }
}

/**
 * Has the durable row for *this* send already landed? An item send is matched by
 * outpoint; a coin send by the absence of one. Stale pending rows never count —
 * they are leftovers, not this attempt.
 */
function hasDurableRowForSend(
  entries: ActivityEntry[],
  progress: PaymentProgress,
  now: number,
): boolean {
  const sending = dottedOutpoint(progress.outpoint)
  const market = marketMethod(progress)
  return entries.some((e) => {
    if (e.id === LIVE_OUTBOUND_ID) return false
    if (now - e.at >= LIVE_OUTBOUND_STALE_MS) return false
    if (market) {
      return e.method === market && (sending ? dottedOutpoint(e.item?.outpoint) === sending || dottedOutpoint(e.item?.origin) === sending : true)
    }
    if (e.status !== 'pending' || e.kind !== 'spent') return false
    const op = dottedOutpoint(e.item?.outpoint)
    return sending ? op === sending : !op
  })
}

/**
 * A completed durable row created during this progress run is the terminal
 * projection of the same operation. This identity boundary prevents a stale
 * global progress snapshot from painting a second zero-sat "Sending…" row
 * above a send that has already settled.
 */
function hasSettledRowForSend(
  entries: ActivityEntry[],
  progress: PaymentProgress,
): boolean {
  if (progress.startedAt == null) return false
  const sending = dottedOutpoint(progress.outpoint)
  const startedAt = progress.startedAt
  return entries.some((entry) => {
    if (entry.status === 'pending' || entry.status === 'failed' || !entry.txid) {
      return false
    }
    // App mint / issuance settles as earned rows. Matching only spent sends
    // left the Approving projection on screen after Minted had already landed.
    if (
      !sending &&
      entry.kind === 'earned' &&
      entry.at >= startedAt &&
      (entry.method === 'mint-token' ||
        entry.method === 'mint-collectable' ||
        entry.method === 'createAction' ||
        entry.method === 'internalizeAction')
    ) {
      return true
    }
    if (entry.kind !== 'spent') return false
    const outpoint = dottedOutpoint(entry.item?.outpoint)
    // Item identity is exact and survives activity-row merges that deliberately
    // retain the row's original timestamp. Coin sends have no equivalent key,
    // so keep their time boundary to avoid matching an earlier payment.
    if (sending) return outpoint === sending
    if (outpoint) return false
    if (entry.at < startedAt) return false
    return true
  })
}

export function mergeLiveOutbound(
  entries: ActivityEntry[],
  progress: PaymentProgress,
  now = Date.now(),
): ActivityEntry[] {
  const withoutLive = entries.filter((e) => e.id !== LIVE_OUTBOUND_ID)
  // `finishing` runs after the send settled its own durable row — post-send
  // bookkeeping must not resurrect a Sending… row on top of it.
  if (progress.phase === 'idle' || progress.phase === 'finishing') {
    return withoutLive
  }
  // Bridge createAction uses the pill only — never a Signed/Approving Activity row.
  if (isAppBridgeProgress(progress)) return withoutLive
  if (hasSettledRowForSend(withoutLive, progress)) return withoutLive
  if (hasDurableRowForSend(withoutLive, progress, now)) return withoutLive
  return [liveOutboundActivityEntry(progress, now), ...withoutLive]
}
