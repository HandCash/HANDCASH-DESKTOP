/**
 * BRC-112 — Balance basket prefix for listOutputs.
 * @see https://bsv.brc.dev/wallet/0112.md
 *
 * Wallet Toolbox already implements this (rewrites `balance <basket>` + balance tag).
 */

/** Canonical BRC-112 basket string for a balance query. */
export function balanceBasket(targetBasket: string): string {
  const name = targetBasket.trim()
  if (!name) throw new Error('Basket name required')
  if (name.startsWith('balance ')) return name
  return `balance ${name}`
}

export const BALANCE_DEFAULT_BASKET = balanceBasket('default')
