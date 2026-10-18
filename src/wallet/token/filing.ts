/**
 * Where a P2P-FT output is filed.
 *
 * New outputs use `p2pft`. Outputs already filed under `bsv21` stay readable
 * and move once. The script says which encoding an output is. This module
 * only names the filing.
 */

export const P2PFT_BASKET = 'p2pft' as const

/** Name BRC-163 reserved. Recognized, then moved into {@link P2PFT_BASKET}. */
export const LEGACY_TOKEN_BASKET = 'bsv21' as const

export const TOKEN_FILING_BASKETS = [P2PFT_BASKET, LEGACY_TOKEN_BASKET] as const

/** App permission schemes. `p bsv21` stays valid for grants already issued. */
const TOKEN_PERMISSION_SCHEMES = new Set<string>([LEGACY_TOKEN_BASKET, P2PFT_BASKET])

export function isTokenFilingBasket(basket: unknown): boolean {
  if (typeof basket !== 'string') return false
  const name = basket.trim().toLowerCase()
  return name === P2PFT_BASKET || name === LEGACY_TOKEN_BASKET
}

/**
 * Baskets whose rows are assets, never cash: 1Sat items, open P2P-FT and
 * P2P-NFT (BRC-255), and countersigned tokens and items. Generic change
 * restore, heal and balance code leaves every one of them alone.
 */
const ASSET_FILING_BASKETS = new Set<string>(['1sat', P2PFT_BASKET, LEGACY_TOKEN_BASKET, 'p2pnft', 'csft', 'csnft'])

export function isAssetFilingBasket(basket: unknown): boolean {
  return typeof basket === 'string' && ASSET_FILING_BASKETS.has(basket.trim().toLowerCase())
}

export function isTokenPermissionScheme(scheme: string): boolean {
  return TOKEN_PERMISSION_SCHEMES.has(scheme.trim().toLowerCase())
}

/** Tags written on a new output: the filing name, and `p2pft:<tokenId>`. */
export function filingTags(tokenId: string): string[] {
  return [P2PFT_BASKET, `${P2PFT_BASKET}:${tokenId}`]
}

/** Token id from a `p2pft:<id>` or `bsv21:<id>` tag. */
export function filingTokenId(tag: string): string | null {
  const trimmed = tag.trim()
  const lower = trimmed.toLowerCase()
  for (const name of TOKEN_FILING_BASKETS) {
    const prefix = `${name}:`
    if (!lower.startsWith(prefix)) continue
    const id = trimmed.slice(prefix.length).trim()
    return id || null
  }
  return null
}

export function tokenIdFromFilingTags(tags: readonly string[] | undefined): string | null {
  if (!tags?.length) return null
  for (const tag of tags) {
    const id = filingTokenId(tag)
    if (id) return id
  }
  return null
}

export function isFilingTag(tag: string): boolean {
  const name = tag.trim().toLowerCase()
  if (name === P2PFT_BASKET || name === LEGACY_TOKEN_BASKET) return true
  return filingTokenId(tag) != null
}

/**
 * One row per outpoint. Earlier rows win, so list `p2pft` before `bsv21`
 * and a half-moved output is not counted twice.
 */
export function mergeFilingRows<T>(
  rows: readonly T[],
  outpoint: (row: T) => string | undefined,
): T[] {
  const seen = new Set<string>()
  const merged: T[] = []
  for (const row of rows) {
    const key = outpoint(row)?.trim().toLowerCase()
    if (key) {
      if (seen.has(key)) continue
      seen.add(key)
    }
    merged.push(row)
  }
  return merged
}
