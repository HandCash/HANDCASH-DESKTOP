/**
 * When does a cached card that the basket keeps omitting stop being ours?
 *
 * A single short basket page proves nothing: recompose, mobile sync and a
 * reserved input during a send all return fewer rows than the wallet holds.
 * The list therefore keeps every cached card the page omits. Without a second
 * rule that keep is forever — one stale card makes every later read "short",
 * so the guard fires on each of them and the card never leaves.
 *
 * The converging rule: a card omitted from several consecutive *complete*
 * basket reads spread over enough wall-clock time is retired. Complete means
 * the wallet returned everything it has in one page — not a truncated page,
 * not an empty one. A card the address scan still lists is never retired here;
 * that is a misfiled tip for heal, not a spent one.
 */
export type BasketAbsence = {
  /** Consecutive complete reads that omitted the card. */
  misses: number
  /** When the first of those reads happened. */
  since: number
}

export const BASKET_ABSENCE_MIN_READS = 3
export const BASKET_ABSENCE_MIN_MS = 5 * 60_000

/** A first page shorter than the limit but not empty is the whole basket. */
export function isCompleteBasketPage(args: {
  offset: number
  pageLength: number
  pageLimit: number
}): boolean {
  return args.offset === 0 && args.pageLength > 0 && args.pageLength < args.pageLimit
}

export function judgeBasketAbsence(
  prev: BasketAbsence | null,
  now: number,
): { next: BasketAbsence; retire: boolean } {
  const next: BasketAbsence = prev
    ? { misses: prev.misses + 1, since: prev.since }
    : { misses: 1, since: now }
  const retire =
    next.misses >= BASKET_ABSENCE_MIN_READS && now - next.since >= BASKET_ABSENCE_MIN_MS
  return { next, retire }
}
