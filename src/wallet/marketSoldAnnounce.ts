/**
 * De-list a sold offer from the market overlay.
 *
 * Cancel already clears the catalog because the cancel spend reaches BRC-22
 * `/submit`, where the overlay classifies it and drops the coin. A settlement
 * had no such path, so a bought listing stayed `status='active'` and kept
 * showing in the catalog. This module submits the settlement BEEF with the
 * buyer context `classifyLifecycle` requires to mark the offer `settled`.
 *
 * Convenience layer only: the sale is already on chain, so every failure here
 * is logged and swallowed. Never gate a purchase on it.
 */

import { PUBLIC_BRC_CLOUD_ORIGIN } from './walletConfig'
import {
  chooseMarketSoldAnnouncePath,
  type MarketSoldAnnouncePath,
} from './marketSettlementPath'

/** Overlay topic for 1Sat market listings. Independent of BRC-230 catalog packs. */
const MARKET_OVERLAY_TOPIC = 'tm_1sat_market'

/**
 * The overlay re-serializes the context and refuses any other byte encoding
 * (`non-canonical-context`). Buyer context is flat and string-valued, so
 * sorted keys with default JSON escaping is exactly its deterministic form.
 */
export function canonicalSoldContext(context: Record<string, string>): string {
  const keys = Object.keys(context).sort()
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(context[key])}`)
    .join(',')}}`
}

/** BRC-22 off-chain framing: VarInt(BEEF length) || BEEF || canonical context. */
export function encodeSoldSubmission(
  beef: number[],
  context: Record<string, string>,
): Uint8Array {
  const beefBytes = Uint8Array.from(beef)
  const contextBytes = new TextEncoder().encode(canonicalSoldContext(context))
  const length = beefBytes.length
  const prefix =
    length < 0xfd
      ? Uint8Array.of(length)
      : length <= 0xffff
        ? Uint8Array.of(0xfd, length & 0xff, (length >>> 8) & 0xff)
        : Uint8Array.of(
            0xfe,
            length & 0xff,
            (length >>> 8) & 0xff,
            (length >>> 16) & 0xff,
            (length >>> 24) & 0xff,
          )
  const framed = new Uint8Array(
    prefix.length + beefBytes.length + contextBytes.length,
  )
  framed.set(prefix)
  framed.set(beefBytes, prefix.length)
  framed.set(contextBytes, prefix.length + beefBytes.length)
  return framed
}

export type MarketSoldAnnounceResult =
  | { announced: true; kind: string | null }
  | { announced: false; reason: string }

/**
 * POST the settlement to the overlay so the offer leaves the active catalog.
 * `409` means another party already de-listed it — treat that as success.
 */
export async function announceMarketSold(
  args: {
    settlementBeef: number[]
    buyerIdentityKey: string
    /** Wallet payment address used by settlement output 0. */
    buyerAddress?: string
    overlayBaseUrl?: string
    topic?: string
  },
  fetchImpl: typeof fetch = fetch,
): Promise<MarketSoldAnnounceResult> {
  const path = chooseMarketSoldAnnouncePath({
    host: args.overlayBaseUrl ?? PUBLIC_BRC_CLOUD_ORIGIN,
    topic: args.topic ?? MARKET_OVERLAY_TOPIC,
    buyerIdentityKey: args.buyerIdentityKey,
    settlementBeefBytes: args.settlementBeef.length,
  })
  if (path.announce === 'skip') {
    console.info(`[market-sold] announce skipped — ${path.reason}`)
    return { announced: false, reason: path.reason }
  }
  return submitSoldAnnounce(
    path,
    args.settlementBeef,
    args.buyerAddress,
    fetchImpl,
  )
}

/**
 * De-list a sold offer on the overlay so other clients stop seeing it.
 * `409` means another party already de-listed it — treat that as success.
 */
export function clearSoldListingFromMarket(args: {
  settlementBeef: number[]
  buyerIdentityKey: string
  buyerAddress?: string
  /** Item + offer outpoints of the listing that just settled. */
  listingOutpoints: string[]
}): void {
  void args.listingOutpoints
  void announceMarketSold({
    settlementBeef: args.settlementBeef,
    buyerIdentityKey: args.buyerIdentityKey,
    buyerAddress: args.buyerAddress,
  })
}

async function submitSoldAnnounce(
  path: Extract<MarketSoldAnnouncePath, { announce: 'overlaySubmit' }>,
  settlementBeef: number[],
  buyerAddress: string | undefined,
  fetchImpl: typeof fetch,
): Promise<MarketSoldAnnounceResult> {
  const body = encodeSoldSubmission(settlementBeef, {
    buyerIdentityKey: path.buyerIdentityKey,
    ...(buyerAddress?.trim() ? { buyerAddress: buyerAddress.trim() } : {}),
  })
  try {
    const res = await fetchImpl(`${path.host}/submit`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/octet-stream',
        'X-Topics': JSON.stringify([path.topic]),
        'x-includes-off-chain-values': 'true',
      },
      body: body.slice().buffer as ArrayBuffer,
    })
    const payload = (await res.json().catch(() => null)) as {
      error?: unknown
      kind?: unknown
    } | null
    if (res.status === 409) {
      console.info('[market-sold] overlay already de-listed this offer')
      return { announced: true, kind: null }
    }
    if (!res.ok) {
      const reason = String(payload?.error ?? `submit-failed-${res.status}`)
      console.warn(`[market-sold] overlay refused the sold announce — ${reason}`)
      return { announced: false, reason }
    }
    const kind = typeof payload?.kind === 'string' ? payload.kind : null
    console.info(`[market-sold] listing de-listed from overlay (${kind ?? 'ok'})`)
    return { announced: true, kind }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.warn(`[market-sold] overlay announce failed — ${reason}`)
    return { announced: false, reason }
  }
}
