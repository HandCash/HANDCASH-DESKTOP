import { describe, expect, it } from 'vitest'
import { BigNumber, ECDSA, KeyDeriver, PrivateKey, Signature, Utils } from '@bsv/sdk'
import { fillOffer, MAX_OFFER_TTL_MS, offerRoom, SWAP_OFFER_PROTOCOL, swapOfferCancelDigest, swapOfferFilledDigest, type SignedSwapOffer } from './offer'
import { browseSwapOfferBook, browseSwapOffers, cancelSwapOffer, draftOfferAtMarket, publishSwapOffer, reportSwapOfferFilled } from './offerBook'

const NOW = 1_800_000_000_000
const root = PrivateKey.fromRandom()
const usd = (prices: Record<string, number>) => (asset: string) => prices[asset] ?? null

/** Just enough of the host: stores what it is posted, lists it back, honours cancels and maker-signed fill reports. */
function book() {
  const offers = new Map<string, SignedSwapOffer>()
  const filled = new Map<string, string>()
  const calls: string[] = []
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
    const cancel = /\/swap-offers\/([0-9a-f]{64})\/cancel$/.exec(url.pathname)
    if (cancel) {
      const { sig } = JSON.parse(String(init?.body)) as { sig: string }
      const nonce = cancel[1]!
      const pub = new KeyDeriver(new PrivateKey(1)).derivePublicKey(SWAP_OFFER_PROTOCOL, nonce, offers.get(nonce)!.maker)
      if (!ECDSA.verify(new BigNumber(swapOfferCancelDigest(nonce)), Signature.fromDER(Utils.toArray(sig, 'hex')), pub)) return new Response('{"error":"cancel-signature"}', { status: 401 })
      offers.delete(nonce)
      return Response.json({ status: 'success' })
    }
    const fill = /\/swap-offers\/([0-9a-f]{64})\/filled$/.exec(url.pathname)
    if (fill) {
      const body = JSON.parse(String(init?.body)) as { filled: string; sig: string }
      const nonce = fill[1]!
      const pub = new KeyDeriver(new PrivateKey(1)).derivePublicKey(SWAP_OFFER_PROTOCOL, nonce, offers.get(nonce)!.maker)
      if (!ECDSA.verify(new BigNumber(swapOfferFilledDigest(nonce, BigInt(body.filled))), Signature.fromDER(Utils.toArray(body.sig, 'hex')), pub)) return new Response('{"error":"bad-signature"}', { status: 401 })
      filled.set(nonce, body.filled)
      return Response.json({ status: 'success' })
    }
    if (init?.method === 'POST') {
      const { offer } = JSON.parse(String(init.body)) as { offer: SignedSwapOffer }
      offers.set(offer.nonce, offer)
      return Response.json({ status: 'success', nonce: offer.nonce }, { status: 201 })
    }
    return Response.json({ offers: [...offers.values(), { v: 1, maker: 'forged' }], filled: { ...Object.fromEntries(filled), ['ff'.repeat(32)]: '5' } })
  }) as typeof fetch
  return { offers, calls, fetch: fake }
}

describe('draftOfferAtMarket', () => {
  it('asks the market value of what it gives, whole', () => {
    // 1 LTC = $70, 1 BSV = $35: 0.5 LTC is worth 1 BSV.
    const res = draftOfferAtMarket({ from: 'ltc', to: 'bsv', pay: 50_000_000n, held: 60_000_000n }, usd({ ltc: 70, bsv: 35 }))
    expect(res).toEqual({ ok: true, draft: { give: 'ltc', get: 'bsv', pay: 50_000_000n, want: 100_000_000n, minWant: 100_000_000n, partWant: 10_000_000n, price: { give: '50000000', get: '100000000' } } })
  })

  it('a part-fillable offer takes a tenth at least, never a part whose claim would eat a tenth of it', () => {
    const big = draftOfferAtMarket({ from: 'ltc', to: 'bsv', pay: 50_000_000n, held: null, partial: true }, usd({ ltc: 70, bsv: 35 }))
    expect(big.ok && big.draft.minWant).toBe(10_000_000n)
    // Ten LTC claims (10 000 litoshi) are worth 20 000 satoshis here: no part may be smaller.
    const floor = draftOfferAtMarket({ from: 'ltc', to: 'bsv', pay: 15_000n, held: null, partial: true }, usd({ ltc: 70, bsv: 35 }))
    expect(floor.ok && floor.draft.minWant).toBe(20_000n)
    const tiny = draftOfferAtMarket({ from: 'ltc', to: 'bsv', pay: 5_000n, held: null, partial: true }, usd({ ltc: 70, bsv: 35 }))
    expect(tiny.ok && tiny.draft.minWant).toBe(10_000n)
  })

  it('refuses what it cannot price or the wallet cannot cover', () => {
    expect(draftOfferAtMarket({ from: 'ltc', to: 'bsv', pay: 1n, held: null }, usd({ ltc: 70 }))).toEqual({ ok: false, reason: 'no-price' })
    expect(draftOfferAtMarket({ from: 'ltc', to: 'bsv', pay: 2n, held: 1n }, usd({ ltc: 70, bsv: 35 }))).toEqual({ ok: false, reason: 'over-balance' })
    expect(draftOfferAtMarket({ from: 'ltc', to: 'ltc', pay: 1n, held: null }, usd({ ltc: 70 }))).toEqual({ ok: false, reason: 'same-coin' })
    expect(draftOfferAtMarket({ from: 'ltc', to: 'bsv', pay: 0n, held: null }, usd({ ltc: 70, bsv: 35 }))).toEqual({ ok: false, reason: 'no-amount' })
  })
})

describe('offer book', () => {
  it('publishes a signed whole offer, browses it back verified, and cancels it', async () => {
    const host = book()
    const drafted = draftOfferAtMarket({ from: 'ltc', to: 'bsv', pay: 50_000_000n, held: null }, usd({ ltc: 70, bsv: 35 }))
    if (!drafted.ok) throw new Error(drafted.reason)
    const signed = await publishSwapOffer(drafted.draft, { rootKeyHex: root.toHex(), messagebox: 'https://box.example/v1' }, { fetch: host.fetch, now: () => NOW })
    expect(signed).toMatchObject({ maker: root.toPublicKey().toString(), give: 'ltc', get: 'bsv', minGet: '100000000', maxGet: '100000000', expiresAt: NOW + MAX_OFFER_TTL_MS, messagebox: 'https://box.example/v1' })
    // A taker paying the whole ask receives exactly what the maker put up.
    expect(fillOffer(signed, 100_000_000n)).toBe(50_000_000n)

    const listed = await browseSwapOffers({ give: 'ltc' }, { fetch: host.fetch, now: () => NOW })
    expect(listed).toEqual([signed])
    expect(host.calls).toContain('GET /v1/market/swap-offers?limit=100&give=ltc')

    await cancelSwapOffer(signed.nonce, { rootKeyHex: root.toHex() }, { fetch: host.fetch })
    expect(host.offers.size).toBe(0)
  })

  it('a part-fillable offer: the maker reports what is taken on, and browsing shows what is left', async () => {
    const host = book()
    const drafted = draftOfferAtMarket({ from: 'ltc', to: 'bsv', pay: 50_000_000n, held: null, partial: true }, usd({ ltc: 70, bsv: 35 }))
    if (!drafted.ok) throw new Error(drafted.reason)
    const signed = await publishSwapOffer(drafted.draft, { rootKeyHex: root.toHex() }, { fetch: host.fetch, now: () => NOW })
    expect(signed).toMatchObject({ minGet: '10000000', maxGet: '100000000' })
    await reportSwapOfferFilled(signed.nonce, 60_000_000n, { rootKeyHex: root.toHex() }, { fetch: host.fetch })
    await expect(reportSwapOfferFilled(signed.nonce, 70_000_000n, { rootKeyHex: PrivateKey.fromRandom().toHex() }, { fetch: host.fetch })).rejects.toThrow('bad-signature')
    const page = await browseSwapOfferBook({}, { fetch: host.fetch, now: () => NOW })
    expect(page.offers).toEqual([signed])
    expect([...page.filled]).toEqual([[signed.nonce, 60_000_000n]])
    expect(offerRoom(signed, page.filled.get(signed.nonce))).toEqual({ min: 10_000_000n, max: 40_000_000n })
    expect(fillOffer(signed, 50_000_000n, 60_000_000n)).toBeNull()
  })

  it('surfaces the host refusal by name', async () => {
    const refusing = (async () => new Response('{"error":"too-many-open-offers"}', { status: 409 })) as typeof fetch
    const drafted = draftOfferAtMarket({ from: 'bsv', to: 'ltc', pay: 100_000_000n, held: null }, usd({ ltc: 70, bsv: 35 }))
    if (!drafted.ok) throw new Error(drafted.reason)
    await expect(publishSwapOffer(drafted.draft, { rootKeyHex: root.toHex() }, { fetch: refusing, now: () => NOW })).rejects.toThrow('too-many-open-offers')
  })
})

describe('withOwnTakes', () => {
  it('counts an offer as filled by at least what this wallet\'s own takes hold', async () => {
    const { withOwnTakes } = await import('./offerBook')
    const page = { offers: [], filled: new Map([['a', 5n], ['b', 50n]]) }
    const seen = withOwnTakes(page, new Map([['a', 20n], ['b', 10n], ['c', 7n]]))
    expect([...seen.filled]).toEqual([['a', 20n], ['b', 50n], ['c', 7n]])
    expect(withOwnTakes(page, new Map())).toBe(page)
  })
})
