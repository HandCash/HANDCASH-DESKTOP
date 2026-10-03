/**
 * Is one basket page the whole basket?
 *
 * The item list is a projection of basket `1sat`; a card it omits leaves the
 * list and goes to the holdings reconcile, which asks the chain. That is only
 * sound when the page is everything the wallet has: the first page, shorter
 * than the limit. An empty first page is a complete answer too — the read
 * only counts while no region is rewriting the database.
 */
export function isCompleteBasketPage(args: {
  offset: number
  pageLength: number
  pageLimit: number
}): boolean {
  return args.offset === 0 && args.pageLength < args.pageLimit
}
