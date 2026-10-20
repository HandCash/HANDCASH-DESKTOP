/**
 * Where the wallet files assets. Token rows carry a `<basket>:<assetId>`
 * filing tag naming their 40-hex compact asset id (draft BRC-255).
 */

export const TOKEN_BASKET = 'bntft'
export const COMPACT_ITEM_BASKET = 'bntnft'
export const IPT_TOKEN_BASKET = 'iptft'
export const IPT_ITEM_BASKET = 'iptnft'
export const ITEM_STORAGE_BASKET = '1sat'

export const TOKEN_BASKETS = [TOKEN_BASKET] as const

/**
 * Baskets earlier builds filed tokens under. Nothing files there now, but rows
 * left behind are still token tips: spending one as cash destroys the token.
 */
const RETIRED_ASSET_BASKETS = ['bsv21', 'p2pft', 'p2pnft', 'csft', 'csnft'] as const

/**
 * Baskets whose rows are assets, never cash. Generic change restore, heal and
 * balance code leaves every one of them alone.
 */
const ASSET_BASKETS = new Set<string>([
  ITEM_STORAGE_BASKET,
  TOKEN_BASKET,
  COMPACT_ITEM_BASKET,
  IPT_TOKEN_BASKET,
  IPT_ITEM_BASKET,
  ...RETIRED_ASSET_BASKETS,
])

function nameOf(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function isTokenFilingBasket(basket: unknown): boolean {
  return nameOf(basket) === TOKEN_BASKET
}

export function isAssetFilingBasket(basket: unknown): boolean {
  return ASSET_BASKETS.has(nameOf(basket))
}

export function isTokenPermissionScheme(scheme: string): boolean {
  return nameOf(scheme) === TOKEN_BASKET
}

/** Asset id from a `bntft:<assetId>` tag. */
export function filingTokenId(tag: string): string | null {
  const prefix = `${TOKEN_BASKET}:`
  if (!tag.trim().toLowerCase().startsWith(prefix)) return null
  return tag.trim().slice(prefix.length).trim().toLowerCase() || null
}

export function tokenIdFromFilingTags(tags: readonly string[] | undefined): string | null {
  for (const tag of tags ?? []) {
    const id = filingTokenId(tag)
    if (id) return id
  }
  return null
}

export function isFilingTag(tag: string): boolean {
  return nameOf(tag) === TOKEN_BASKET || filingTokenId(tag) != null
}
