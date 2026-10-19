import type { SwapAsset } from './assets'
import { fetchExolixQuote, type ExolixQuote, type ExolixRefusal } from './exolix'
import { routeSwap, type SwapRequest, type SwapRouting } from './routing'

/**
 * One quote: the direct offers for the pair and Exolix's price, ranked.
 * Exolix failing leaves the direct offers; no route at all is a named
 * refusal, never a guess.
 */

export type SwapQuoteRefusal =
  | { kind: 'bad-request'; detail: string }
  | { kind: 'no-route'; exolix: ExolixRefusal | null }

export type SwapQuote = SwapRouting & { request: SwapRequest; exolix: ExolixQuote | null; exolixRefusal: ExolixRefusal | null; quotedAt: number }

export type SwapQuoteDeps = {
  /** Signed offers someone hosts for makers giving `give` for `get`, each verified here, never trusted, and what the book says is filled of each. */
  listOffers(pair: { give: SwapAsset; get: SwapAsset }): Promise<unknown[] | { offers: unknown[]; filled: ReadonlyMap<string, bigint> }>
  fetchExolix?: typeof fetchExolixQuote
  now?: () => number
  /** This wallet's identity key: its own offers are never routed to itself. */
  self?: string
}

/** Signed direct offers for a pair, from the market engine's offer book; routing verifies each again. */
export async function listSwapOffers(pair: { give: SwapAsset; get: SwapAsset }): Promise<{ offers: unknown[]; filled: ReadonlyMap<string, bigint> }> {
  const { browseSwapOfferBook } = await import('./offerBook')
  return browseSwapOfferBook(pair)
}

/** How long a quote is good for before it must be asked again (Exolix holds a fixed rate about this long). */
export const SWAP_QUOTE_TTL_MS = 60_000

export async function quoteSwap(req: SwapRequest, deps: SwapQuoteDeps): Promise<{ ok: true; quote: SwapQuote } | { ok: false; refusal: SwapQuoteRefusal }> {
  if (req.from === req.to) return { ok: false, refusal: { kind: 'bad-request', detail: 'pick two different coins' } }
  if (req.pay <= 0n) return { ok: false, refusal: { kind: 'bad-request', detail: 'enter an amount' } }
  const now = deps.now ?? Date.now
  const [listed, exolix] = await Promise.all([
    deps.listOffers({ give: req.to, get: req.from }).catch((err: unknown) => {
      console.warn(`[swap] offers unavailable — ${err instanceof Error ? err.message : String(err)}`)
      return [] as unknown[]
    }),
    (deps.fetchExolix ?? fetchExolixQuote)(req, { now }),
  ])
  const { offers, filled } = Array.isArray(listed) ? { offers: listed, filled: undefined } : listed
  const quotedAt = now()
  const routing = routeSwap(req, offers, exolix.ok ? exolix.quote : null, { now: quotedAt, ...(deps.self ? { self: deps.self } : {}), ...(filled ? { filled } : {}) })
  const exolixRefusal = exolix.ok ? null : exolix.refusal
  if (routing.skipped.length) console.info(`[swap] skipped ${routing.skipped.length} offers (${[...new Set(routing.skipped.map((s) => s.reason))].join(', ')})`)
  if (!routing.chosen) return { ok: false, refusal: { kind: 'no-route', exolix: exolixRefusal } }
  return { ok: true, quote: { ...routing, request: req, exolix: exolix.ok ? exolix.quote : null, exolixRefusal, quotedAt } }
}
