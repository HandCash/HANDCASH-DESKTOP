import { decimalToUnits, SWAP_ASSET_INFO, unitsToDecimal, type SwapAsset } from './assets'

/**
 * Exolix quotes: the liquidity backstop behind direct swaps, and the price
 * direct offers are set against. The rate endpoint is public and answers
 * browsers, so the wallet asks Exolix itself (no key, no account, no proxy).
 *
 * Exolix is custodial while a swap runs: the user pays its deposit address and
 * waits for its payout. Nothing here creates an exchange; this module only
 * reads what one would pay.
 */

export const EXOLIX_RATE_URL = 'https://exolix.com/api/v2/rate'
const TIMEOUT_MS = 10_000

export type ExolixQuote = {
  from: SwapAsset
  to: SwapAsset
  /** What the user pays, smallest units of `from`. */
  pay: bigint
  /** What Exolix pays out, smallest units of `to`, after its fee and network fee. */
  receive: bigint
  /** Smallest and largest `pay` Exolix takes, smallest units of `from`. */
  min: bigint
  max: bigint
  /** Exolix guarantees `receive` for this quote (fixed rate). */
  fixed: true
  fetchedAt: number
}

export type ExolixRefusal =
  | { kind: 'below-min'; min: bigint }
  | { kind: 'above-max'; max: bigint }
  | { kind: 'unavailable'; detail: string }

type RateBody = { fromAmount?: unknown; toAmount?: unknown; rate?: unknown; message?: unknown; minAmount?: unknown; maxAmount?: unknown }

/**
 * What Exolix pays out for `pay` of `from` in `to`, at a fixed rate: the
 * price a user would get from it right now. A refusal names why Exolix would
 * not take the swap.
 */
export async function fetchExolixQuote(
  req: { from: SwapAsset; to: SwapAsset; pay: bigint },
  opts: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<{ ok: true; quote: ExolixQuote } | { ok: false; refusal: ExolixRefusal }> {
  if (req.from === req.to || req.pay <= 0n) return { ok: false, refusal: { kind: 'unavailable', detail: 'nothing to swap' } }
  const from = SWAP_ASSET_INFO[req.from]
  const to = SWAP_ASSET_INFO[req.to]
  const url = new URL(EXOLIX_RATE_URL)
  url.searchParams.set('coinFrom', from.exolix.coin)
  url.searchParams.set('networkFrom', from.exolix.network)
  url.searchParams.set('coinTo', to.exolix.coin)
  url.searchParams.set('networkTo', to.exolix.network)
  url.searchParams.set('amount', unitsToDecimal(req.from, req.pay))
  url.searchParams.set('rateType', 'fixed')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let body: RateBody
  try {
    const res = await (opts.fetch ?? fetch)(url.toString(), { signal: controller.signal })
    body = (await res.json().catch(() => ({}))) as RateBody
    if (!res.ok && res.status !== 422) return { ok: false, refusal: { kind: 'unavailable', detail: `Exolix ${res.status}` } }
  } catch (err) {
    return { ok: false, refusal: { kind: 'unavailable', detail: err instanceof Error ? err.message : String(err) } }
  } finally {
    clearTimeout(timer)
  }
  const min = typeof body.minAmount === 'number' ? decimalToUnits(req.from, body.minAmount) : null
  const max = typeof body.maxAmount === 'number' ? decimalToUnits(req.from, body.maxAmount) : null
  if (min !== null && req.pay < min) return { ok: false, refusal: { kind: 'below-min', min } }
  if (max !== null && req.pay > max) return { ok: false, refusal: { kind: 'above-max', max } }
  const receive = typeof body.toAmount === 'number' ? decimalToUnits(req.to, body.toAmount) : null
  if (body.message || receive === null || receive <= 0n || min === null || max === null) {
    return { ok: false, refusal: { kind: 'unavailable', detail: typeof body.message === 'string' ? body.message : 'Exolix returned no rate' } }
  }
  return { ok: true, quote: { from: req.from, to: req.to, pay: req.pay, receive, min, max, fixed: true, fetchedAt: (opts.now ?? Date.now)() } }
}

