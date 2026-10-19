import type { SwapAsset } from './assets'
import type { ExolixQuote } from './exolix'
import { DIRECT_CLAIM_COST, lockWithin, swapFee, takerTotals } from './fee'
import { fillOffer, verifySwapOffer, type OfferRefusal, type SignedSwapOffer } from './offer'

/**
 * Which way a swap goes, and at what price.
 *
 * The queue: every direct offer that pays the taker at least what Exolix
 * would comes first, best first, then oldest first among equals; then Exolix;
 * then direct offers worse than Exolix. The first route is the default. So a
 * direct swap is the default whenever one is as good as the backstop, and the
 * taker is never defaulted into a worse price to keep a swap direct.
 *
 * A direct route carries HandCash's 0.5% fee (`fee.ts`): with the fee on the
 * taker's leg, less goes into the offer so the wallet still spends no more
 * than asked; with it on the maker's, it comes off what lands. Ranking is on
 * what lands, so the fee is always counted against Exolix.
 *
 * Direct offers are priced to intercept: halfway between the market rate and
 * Exolix's rate, so the taker gets more than Exolix pays and the maker keeps
 * the other half of Exolix's spread.
 */

export type SwapRequest = { from: SwapAsset; to: SwapAsset; pay: bigint }

export { DIRECT_CLAIM_COST }

export type SwapRoute =
  | {
      kind: 'direct'
      offer: SignedSwapOffer
      /** Leaves this wallet in all: `lock` plus any fee on the taker's leg. */
      pay: bigint
      /** Put into the offer: what the maker is paid. */
      lock: bigint
      /** Paid by the maker's lock, less any fee on the maker's leg. */
      receive: bigint
      /** HandCash's cut, in units of whichever leg carries it; 0n for none. */
      fee: bigint
      /** `receive` less the taker's claim transaction: what lands, compared across routes. */
      net: bigint
    }
  | {
      kind: 'exolix'
      quote: ExolixQuote
      pay: bigint
      receive: bigint
      net: bigint
      /** Exolix holds the coins between the user's deposit and its payout. */
      custodial: true
    }

export type SkippedOffer = { nonce: string; reason: OfferRefusal | 'wrong-pair' | 'out-of-bounds' | 'own-offer' | 'duplicate' }

export type SwapRouting = { routes: SwapRoute[]; chosen: SwapRoute | null; skipped: SkippedOffer[] }

const byBest = (a: SwapRoute, b: SwapRoute) => (b.net > a.net ? 1 : b.net < a.net ? -1 : 0)
const createdAt = (r: SwapRoute) => (r.kind === 'direct' ? r.offer.createdAt : Number.MAX_SAFE_INTEGER)

/** Rank every way to swap `req`: verified direct offers and the Exolix quote, the default first. */
export function routeSwap(
  req: SwapRequest,
  offers: readonly unknown[],
  exolix: ExolixQuote | null,
  opts: { now: number; self?: string; claimCost?: Record<SwapAsset, bigint> },
): SwapRouting {
  const claimCost = opts.claimCost ?? DIRECT_CLAIM_COST
  const skipped: SkippedOffer[] = []
  const seen = new Set<string>()
  const direct: SwapRoute[] = []
  for (const raw of offers) {
    const checked = verifySwapOffer(raw, opts.now)
    const nonce = String((raw as { nonce?: unknown } | null)?.nonce ?? '')
    if (!checked.ok) {
      skipped.push({ nonce, reason: checked.reason })
      continue
    }
    const offer = checked.offer
    if (seen.has(offer.nonce)) {
      skipped.push({ nonce, reason: 'duplicate' })
      continue
    }
    seen.add(offer.nonce)
    if (offer.get !== req.from || offer.give !== req.to) {
      skipped.push({ nonce, reason: 'wrong-pair' })
      continue
    }
    if (opts.self && offer.maker === opts.self) {
      skipped.push({ nonce, reason: 'own-offer' })
      continue
    }
    const lock = lockWithin(offer, req.pay, (pay) => fillOffer(offer, pay))
    const gross = fillOffer(offer, lock)
    const totals = gross === null ? null : takerTotals({ pay: lock.toString(), receive: gross.toString(), fee: swapFee(offer, lock, gross) })
    if (!totals || totals.receives <= claimCost[req.to]) {
      skipped.push({ nonce, reason: 'out-of-bounds' })
      continue
    }
    direct.push({ kind: 'direct', offer, pay: totals.pays, lock, receive: totals.receives, fee: totals.fee, net: totals.receives - claimCost[req.to] })
  }
  const sorted = direct.sort((a, b) => byBest(a, b) || createdAt(a) - createdAt(b))
  const backstop: SwapRoute | null =
    exolix && exolix.from === req.from && exolix.to === req.to && exolix.pay === req.pay
      ? { kind: 'exolix', quote: exolix, pay: req.pay, receive: exolix.receive, net: exolix.receive, custodial: true }
      : null
  const routes = backstop
    ? [...sorted.filter((r) => r.net >= backstop.net), backstop, ...sorted.filter((r) => r.net < backstop.net)]
    : sorted
  return { routes, chosen: routes[0] ?? null, skipped }
}

export type InterceptPrice =
  | { ok: true; price: { give: string; get: string }; fair: number; exolix: number; intercept: number }
  | { ok: false; reason: 'no-price' | 'no-spread' }

const PRICE_SCALE = 100_000_000n

/**
 * The price a maker giving `give` for `get` posts to intercept Exolix:
 * halfway between the market rate and Exolix's rate for the taker's side
 * (`quote` pays `get`, receives `give`). Rates are `give` units per `get`
 * unit; every swap asset has 8 decimals, so unit and coin rates agree.
 * `no-spread` when Exolix already pays at least the market rate (a stale
 * market price, or no spread to share).
 */
export function interceptPrice(
  pair: { give: SwapAsset; get: SwapAsset },
  usd: (asset: SwapAsset) => number | null,
  quote: ExolixQuote,
): InterceptPrice {
  const usdGive = usd(pair.give)
  const usdGet = usd(pair.get)
  if (quote.from !== pair.get || quote.to !== pair.give || !usdGive || !usdGet || !(usdGive > 0) || !(usdGet > 0)) {
    return { ok: false, reason: 'no-price' }
  }
  const fair = usdGet / usdGive
  const exolix = Number(quote.receive) / Number(quote.pay)
  if (!(exolix < fair)) return { ok: false, reason: 'no-spread' }
  const intercept = (fair + exolix) / 2
  const give = BigInt(Math.floor(intercept * Number(PRICE_SCALE)))
  if (give <= 0n) return { ok: false, reason: 'no-price' }
  return { ok: true, price: { give: give.toString(), get: PRICE_SCALE.toString() }, fair, exolix, intercept }
}
