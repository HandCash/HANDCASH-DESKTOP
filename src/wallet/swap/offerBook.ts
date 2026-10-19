import { PrivateKey, Utils } from '@bsv/sdk'
import { DEFAULT_BRC_CLOUD_BASE_URL, PUBLIC_BRC_CLOUD_ORIGIN } from '../walletConfig'
import { SWAP_ASSET_INFO, type SwapAsset } from './assets'
import { DIRECT_CLAIM_COST } from './fee'
import { MAX_OFFER_TTL_MS, signSwapOffer, signSwapOfferCancel, signSwapOfferFilled, verifySwapOffer, type SignedSwapOffer, type SwapOffer } from './offer'

/**
 * The offer book: signed swap offers hosted by the market engine
 * (`BRC-CLOUD /v1/market/swap-offers`). The host only stores and lists; every
 * offer is re-verified here, and a hosted offer moves nothing. Publishing
 * signs a standing price; no coin leaves the wallet until a taker settles
 * with the maker wallet to wallet.
 */

const REQUEST_TIMEOUT_MS = 15_000
const PRICE_SCALE = 100_000_000n

/** What a maker is about to sign: everything but the nonce, times and signature. */
export type SwapOfferDraft = {
  give: SwapAsset
  get: SwapAsset
  /** Units of `give` paid for the whole offer. */
  pay: bigint
  /** Units of `get` asked for the whole offer. */
  want: bigint
  /** The smallest take, in units of `get`: `want` for an offer taken whole, `partWant` for one filled in parts. */
  minWant: bigint
  /** The smallest part this offer could be filled in; `want` when it is too small to split. */
  partWant: bigint
  price: { give: string; get: string }
}

/** A part-fillable offer's smallest take is a tenth of it, and never so small that its claim eats a tenth of what it pays. */
const PART_SHARE = 10n

export type DraftRefusal = 'same-coin' | 'no-amount' | 'no-price' | 'over-balance'

/**
 * An offer to give `pay` of `from` for `to` at the market rate. Whole by
 * default: a taker takes all of it or none, so a maker who could not reach
 * Exolix's minimum is not split into smaller pieces it cannot settle either.
 * With `partial`, takers may each fill a part of it, down to a tenth.
 */
export function draftOfferAtMarket(
  args: { from: SwapAsset; to: SwapAsset; pay: bigint; held: bigint | null; partial?: boolean },
  usd: (asset: SwapAsset) => number | null,
): { ok: true; draft: SwapOfferDraft } | { ok: false; reason: DraftRefusal } {
  const { from, to, pay, held } = args
  if (from === to) return { ok: false, reason: 'same-coin' }
  if (pay <= 0n) return { ok: false, reason: 'no-amount' }
  if (held !== null && pay > held) return { ok: false, reason: 'over-balance' }
  const usdFrom = usd(from)
  const usdTo = usd(to)
  if (!usdFrom || !usdTo || !Number.isFinite(usdFrom) || !Number.isFinite(usdTo) || usdFrom <= 0 || usdTo <= 0) return { ok: false, reason: 'no-price' }
  const decimals = SWAP_ASSET_INFO[from].decimals - SWAP_ASSET_INFO[to].decimals
  const perUnit = (usdTo / usdFrom) * 10 ** decimals * Number(PRICE_SCALE)
  if (!Number.isFinite(perUnit) || perUnit < 1 || perUnit > 1e18) return { ok: false, reason: 'no-price' }
  const priceGive = BigInt(Math.floor(perUnit))
  const want = (pay * PRICE_SCALE) / priceGive
  if (want <= 0n) return { ok: false, reason: 'no-amount' }
  const smallestUseful = (PART_SHARE * DIRECT_CLAIM_COST[from] * PRICE_SCALE + priceGive - 1n) / priceGive
  const part = want / PART_SHARE > smallestUseful ? want / PART_SHARE : smallestUseful
  const partWant = part < want ? part : want
  return { ok: true, draft: { give: from, get: to, pay, want, minWant: args.partial ? partWant : want, partWant, price: { give: priceGive.toString(), get: PRICE_SCALE.toString() } } }
}

export function swapOfferBookUrl(path = ''): string {
  const base = (DEFAULT_BRC_CLOUD_BASE_URL.trim() || PUBLIC_BRC_CLOUD_ORIGIN).replace(/\/+$/, '')
  return `${base}/v1/market/swap-offers${path}`
}

export type OfferBookDeps = {
  fetch?: typeof fetch
  now?: () => number
}

function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined
}

async function failure(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null
  return typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`
}

const randomNonce = () => Utils.toHex(Array.from(crypto.getRandomValues(new Uint8Array(32))))

/** Sign `draft` as the identity `rootKeyHex` and post it to the offer book; resolves to the signed offer. */
export async function publishSwapOffer(
  draft: SwapOfferDraft,
  maker: { rootKeyHex: string; messagebox?: string },
  deps: OfferBookDeps = {},
): Promise<SignedSwapOffer> {
  const root = PrivateKey.fromHex(maker.rootKeyHex)
  const createdAt = (deps.now ?? Date.now)()
  const offer: SwapOffer = {
    v: 1,
    maker: root.toPublicKey().toString(),
    give: draft.give,
    get: draft.get,
    price: draft.price,
    minGet: draft.minWant.toString(),
    maxGet: draft.want.toString(),
    createdAt,
    expiresAt: createdAt + MAX_OFFER_TTL_MS,
    nonce: randomNonce(),
    ...(maker.messagebox ? { messagebox: maker.messagebox } : {}),
  }
  const signed = signSwapOffer(offer, root)
  const res = await (deps.fetch ?? fetch)(swapOfferBookUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offer: signed }),
    signal: timeoutSignal(),
  })
  if (!res.ok) throw new Error(`offer book refused the offer: ${await failure(res)}`)
  console.info(`[swap] published offer ${signed.nonce.slice(0, 12)} ${draft.give}→${draft.get}`)
  return signed
}

export type OfferBookPage = {
  offers: SignedSwapOffer[]
  /** What each maker reports taken on of its part-fillable offers, by nonce: advice, signed by the maker. */
  filled: ReadonlyMap<string, bigint>
}

/**
 * The page as this wallet sees it: an offer counts as filled by at least what
 * its own open takes hold, which the maker has not reported yet (and may never
 * report while it is offline).
 */
export function withOwnTakes(page: OfferBookPage, own: ReadonlyMap<string, bigint>): OfferBookPage {
  if (own.size === 0) return page
  const filled = new Map(page.filled)
  for (const [nonce, taken] of own) if (taken > (filled.get(nonce) ?? 0n)) filled.set(nonce, taken)
  return { ...page, filled }
}

/** Every standing offer the book holds, each verified here; anything that fails is dropped and counted. */
export async function browseSwapOffers(filter: { give?: SwapAsset; get?: SwapAsset; maker?: string } = {}, deps: OfferBookDeps = {}): Promise<SignedSwapOffer[]> {
  return (await browseSwapOfferBook(filter, deps)).offers
}

/** The standing offers and what the book says is filled of each. */
export async function browseSwapOfferBook(
  filter: { give?: SwapAsset; get?: SwapAsset; maker?: string } = {},
  deps: OfferBookDeps = {},
): Promise<OfferBookPage> {
  const query = new URLSearchParams({ limit: '100' })
  for (const [k, v] of Object.entries(filter)) if (v) query.set(k, v)
  const res = await (deps.fetch ?? fetch)(swapOfferBookUrl(`?${query}`), { headers: { Accept: 'application/json' }, cache: 'no-store', signal: timeoutSignal() })
  if (!res.ok) throw new Error(`offer book unavailable: ${await failure(res)}`)
  const body = (await res.json().catch(() => null)) as { offers?: unknown; filled?: unknown } | null
  const now = (deps.now ?? Date.now)()
  const offers: SignedSwapOffer[] = []
  let dropped = 0
  for (const value of Array.isArray(body?.offers) ? body.offers : []) {
    const checked = verifySwapOffer(value, now)
    if (checked.ok) offers.push(checked.offer)
    else dropped++
  }
  if (dropped) console.warn(`[swap] dropped ${dropped} offers that failed verification`)
  const filled = new Map<string, bigint>()
  const reported = body?.filled && typeof body.filled === 'object' ? (body.filled as Record<string, unknown>) : {}
  for (const offer of offers) {
    const units = reported[offer.nonce]
    if (typeof units === 'string' && /^[1-9]\d{0,17}$/.test(units)) filled.set(offer.nonce, BigInt(units))
  }
  return { offers: offers.sort((a, b) => b.createdAt - a.createdAt), filled }
}

/** Tell the book how much of this identity's offer `nonce` is taken on. */
export async function reportSwapOfferFilled(nonce: string, filled: bigint, maker: { rootKeyHex: string }, deps: OfferBookDeps = {}): Promise<void> {
  const sig = signSwapOfferFilled(nonce, filled, PrivateKey.fromHex(maker.rootKeyHex))
  const res = await (deps.fetch ?? fetch)(swapOfferBookUrl(`/${nonce}/filled`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filled: filled.toString(), sig }),
    signal: timeoutSignal(),
  })
  if (!res.ok) throw new Error(`offer book refused the fill report: ${await failure(res)}`)
}

/** Withdraw this identity's offer `nonce` from the book. */
export async function cancelSwapOffer(nonce: string, maker: { rootKeyHex: string }, deps: OfferBookDeps = {}): Promise<void> {
  const sig = signSwapOfferCancel(nonce, PrivateKey.fromHex(maker.rootKeyHex))
  const res = await (deps.fetch ?? fetch)(swapOfferBookUrl(`/${nonce}/cancel`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sig }),
    signal: timeoutSignal(),
  })
  if (!res.ok) throw new Error(`offer book refused the cancel: ${await failure(res)}`)
  console.info(`[swap] cancelled offer ${nonce.slice(0, 12)}`)
}
