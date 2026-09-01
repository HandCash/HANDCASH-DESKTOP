/**
 * BSV-21 token market display helpers — listing price in inventory and local
 * price history for charts (activity + active listing authorizations).
 */
import type { ActivityEntry } from './appActivity'
import { normalizeTokenId } from './bsv21'
import type { FungibleToken } from './bsv21'
import {
  getMarketListingAuthorization,
  listMarketListingAuthorizations,
  type MarketListingAuthorization,
  type MarketListingState,
} from './marketListing'

export type FungibleMarketListingView = {
  priceSats: number
  listAmt?: number
  state: MarketListingState
  listedOutpoint: string
}

export type TokenMarketPricePoint = {
  at: number
  priceSats: number
}

function normalizeOrigin(tokenId: string): string {
  return normalizeTokenId(tokenId) ?? tokenId.trim().toLowerCase()
}

function isLiveListingState(state: MarketListingState | undefined): boolean {
  return state === 'active' || state === 'reserved'
}

function authToView(auth: MarketListingAuthorization): FungibleMarketListingView {
  return {
    priceSats: auth.priceSats,
    listAmt: auth.listing?.amt,
    state: auth.state,
    listedOutpoint: auth.outpoint,
  }
}

/** Active BRC-48 listing for a held BSV-21 token (checks held outpoints first). */
export function findActiveBsv21ListingForToken(args: {
  tokenId: string
  heldOutpoints?: string[]
}): FungibleMarketListingView | null {
  const origin = normalizeOrigin(args.tokenId)
  const held = new Set(
    (args.heldOutpoints ?? [])
      .map((op) => op.trim().toLowerCase().replace('_', '.'))
      .filter(Boolean),
  )

  for (const outpoint of held) {
    const auth = getMarketListingAuthorization({ outpoint })
    if (!auth || !isLiveListingState(auth.state)) continue
    if (auth.listing?.assetType !== 'bsv21') continue
    if (auth.origin !== origin && auth.listing.origin !== origin) continue
    return authToView(auth)
  }

  return null
}

export function marketListingViewForToken(
  token: FungibleToken,
): FungibleMarketListingView | null {
  return findActiveBsv21ListingForToken({
    tokenId: token.tokenId,
    heldOutpoints: [token.outpoint],
  })
}

function priceSatsFromListingNote(note: string | undefined): number | null {
  if (!note) return null
  const match = /for ([\d,]+) sats/i.exec(note)
  if (!match?.[1]) return null
  const n = Number(match[1].replace(/,/g, ''))
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null
}

/** Local listing prices for a token origin — feeds the market sparkline. */
export function tokenMarketPriceHistory(
  tokenId: string,
  activity: ActivityEntry[],
): TokenMarketPricePoint[] {
  const origin = normalizeOrigin(tokenId)
  const points: TokenMarketPricePoint[] = []

  for (const entry of activity) {
    if (entry.method !== 'market-list') continue
    const entryOrigin = entry.item?.tokenId
      ? normalizeOrigin(entry.item.tokenId)
      : entry.item?.origin
        ? normalizeOrigin(entry.item.origin)
        : null
    if (entryOrigin !== origin) continue
    const priceSats = priceSatsFromListingNote(entry.note)
    if (priceSats == null) continue
    points.push({ at: entry.at, priceSats })
  }

  return points.sort((a, b) => a.at - b.at)
}

export function attachMarketListingToToken(
  token: FungibleToken,
): FungibleToken {
  const listing = marketListingViewForToken(token)
  if (!listing) {
    if (!token.marketListing) return token
    const { marketListing: _drop, ...rest } = token
    return rest
  }
  return { ...token, marketListing: {
    priceSats: listing.priceSats,
    listAmt: listing.listAmt,
    state: listing.state as 'active' | 'reserved',
    listedOutpoint: listing.listedOutpoint,
  } }
}

export type TokenMarketListingRow = {
  tokenId: string
  sym: string
  iconUrl?: string
  dec: number
  listing: FungibleMarketListingView
}

/** Active/reserved BSV-21 listings on this device — stacked market browse cards. */
export function listActiveBsv21MarketListings(
  tokens: FungibleToken[],
): TokenMarketListingRow[] {
  const byOrigin = new Map<string, FungibleToken>()
  for (const token of tokens) {
    byOrigin.set(normalizeOrigin(token.tokenId), token)
  }

  const seen = new Set<string>()
  const rows: TokenMarketListingRow[] = []

  for (const auth of listMarketListingAuthorizations()) {
    if (!isLiveListingState(auth.state)) continue
    if (auth.listing?.assetType !== 'bsv21') continue
    const origin = normalizeOrigin(auth.origin || auth.listing.origin || '')
    if (!origin || seen.has(origin)) continue
    const token = byOrigin.get(origin)
    if (!token) continue
    seen.add(origin)
    rows.push({
      tokenId: token.tokenId,
      sym: token.sym,
      iconUrl: token.iconUrl,
      dec: token.dec,
      listing: authToView(auth),
    })
  }

  for (const token of tokens) {
    const listing = token.marketListing
    if (!listing || !isLiveListingState(listing.state)) continue
    const origin = normalizeOrigin(token.tokenId)
    if (seen.has(origin)) continue
    seen.add(origin)
    rows.push({
      tokenId: token.tokenId,
      sym: token.sym,
      iconUrl: token.iconUrl,
      dec: token.dec,
      listing,
    })
  }

  return rows.sort((a, b) => b.listing.priceSats - a.listing.priceSats)
}
