import { describe, expect, it, vi } from 'vitest'
import { createActor, fromPromise, waitFor } from 'xstate'
import { BigNumber, ECDSA, KeyDeriver, PrivateKey, Utils } from '@bsv/sdk'
import { swapMachine } from '../../machines/swapMachine'
import { swapOffersMachine } from '../../machines/swapOffersMachine'
import { decimalToUnits, unitsToDecimal } from './assets'
import { fetchExolixQuote, type ExolixQuote } from './exolix'
import { fillOffer, MAX_OFFER_TTL_MS, signSwapOffer, swapOfferDigest, verifySwapOffer, type SwapOffer } from './offer'
import { DIRECT_CLAIM_COST, interceptPrice, routeSwap } from './routing'
import { quoteSwap, SWAP_QUOTE_TTL_MS } from './quote'
import { createExolixExchange, isBsvAddress, readSwapRecords, refreshSwapRecords, SwapRefusal } from './exolixSwap'
import { runSwap, type SwapWallet } from './runSwap'

const NOW = 1_800_000_000_000
const maker = PrivateKey.fromRandom()
const taker = PrivateKey.fromRandom()

function offer(over: Partial<SwapOffer> = {}, key = maker): SwapOffer {
  return {
    v: 1,
    maker: key.toPublicKey().toString(),
    give: 'bsv',
    get: 'ltc',
    // 3.5 BSV per LTC
    price: { give: '350000000', get: '100000000' },
    minGet: '1000000',
    maxGet: '1000000000',
    createdAt: NOW - 1_000,
    expiresAt: NOW + 3_600_000,
    nonce: Utils.toHex(PrivateKey.fromRandom().toArray()).padStart(64, '0'),
    ...over,
  }
}

function exolix(receive: bigint, over: Partial<ExolixQuote> = {}): ExolixQuote {
  return { from: 'ltc', to: 'bsv', pay: 100_000_000n, receive, min: 1_000_000n, max: 10_000_000_000n, fixed: true, fetchedAt: NOW, ...over }
}

describe('swap amounts', () => {
  it('converts between smallest units and decimals, rounding down', () => {
    expect(unitsToDecimal('ltc', 12_500_000n)).toBe('0.125')
    expect(unitsToDecimal('bsv', 300_000_000n)).toBe('3')
    expect(decimalToUnits('bsv', 3.24283075)).toBe(324_283_075n)
    expect(decimalToUnits('bch', '0.123456789')).toBe(12_345_678n)
    expect(decimalToUnits('bch', '-1')).toBeNull()
  })
})

describe('Exolix quote', () => {
  const respond = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }))

  it('reads a fixed-rate quote in smallest units', async () => {
    const fetch = respond(200, { fromAmount: 1, toAmount: 3.24283075, rate: 3.24283075, message: null, minAmount: 0.05, maxAmount: 100 })
    const res = await fetchExolixQuote({ from: 'ltc', to: 'bsv', pay: 100_000_000n }, { fetch, now: () => NOW })
    expect(res).toEqual({ ok: true, quote: exolix(324_283_075n, { min: 5_000_000n, max: 10_000_000_000n }) })
    const url = new URL(fetch.mock.calls[0]![0] as unknown as string)
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ coinFrom: 'LTC', coinTo: 'BSV', amount: '1', rateType: 'fixed' })
  })

  it('names the minimum when the amount is below it', async () => {
    const fetch = respond(422, { fromAmount: 0.01, toAmount: 0, message: 'Amount to exchange is below the possible min amount', minAmount: 0.05, maxAmount: 100 })
    expect(await fetchExolixQuote({ from: 'ltc', to: 'bsv', pay: 1_000_000n }, { fetch })).toEqual({ ok: false, refusal: { kind: 'below-min', min: 5_000_000n } })
  })

  it('is unavailable on a server error or a network failure', async () => {
    expect(await fetchExolixQuote({ from: 'ltc', to: 'bsv', pay: 1n }, { fetch: respond(503, {}) })).toEqual({ ok: false, refusal: { kind: 'unavailable', detail: 'Exolix 503' } })
    const down = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(await fetchExolixQuote({ from: 'ltc', to: 'bsv', pay: 1n }, { fetch: down })).toEqual({ ok: false, refusal: { kind: 'unavailable', detail: 'offline' } })
  })
})

describe('swap offers', () => {
  it('verifies an offer signed by its maker', () => {
    const signed = signSwapOffer(offer(), maker)
    expect(verifySwapOffer(signed, NOW)).toEqual({ ok: true, offer: signed })
  })

  it('refuses any change to a signed offer', () => {
    const signed = signSwapOffer(offer(), maker)
    expect(verifySwapOffer({ ...signed, price: { give: '360000000', get: '100000000' } }, NOW)).toEqual({ ok: false, reason: 'signature' })
    expect(verifySwapOffer({ ...signed, maker: taker.toPublicKey().toString() }, NOW)).toEqual({ ok: false, reason: 'signature' })
  })

  it('refuses a signature made under another protocol, so an app with a signing grant cannot forge one', () => {
    const o = offer()
    const appKey = new KeyDeriver(maker).derivePrivateKey([2, 'message signing'], o.nonce, 'anyone')
    const digest = new BigNumber(swapOfferDigest(o))
    const forged = { ...o, sig: Utils.toHex(ECDSA.sign(digest, appKey, true).toDER() as number[]) }
    expect(verifySwapOffer(forged, NOW)).toEqual({ ok: false, reason: 'signature' })
  })

  it('refuses offers that are expired, from the future, standing too long or malformed', () => {
    expect(verifySwapOffer(signSwapOffer(offer({ expiresAt: NOW }), maker), NOW)).toEqual({ ok: false, reason: 'expired' })
    expect(verifySwapOffer(signSwapOffer(offer({ createdAt: NOW + 600_000, expiresAt: NOW + 700_000 }), maker), NOW)).toEqual({ ok: false, reason: 'not-yet-valid' })
    expect(verifySwapOffer(signSwapOffer(offer({ expiresAt: NOW - 1_000 + MAX_OFFER_TTL_MS + 1 }), maker), NOW)).toEqual({ ok: false, reason: 'too-long' })
    expect(verifySwapOffer({ ...signSwapOffer(offer(), maker), get: 'bsv' }, NOW)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifySwapOffer({ ...signSwapOffer(offer(), maker), minGet: '0' }, NOW)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifySwapOffer(null, NOW)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('refuses to sign for another maker', () => {
    expect(() => signSwapOffer(offer({}, taker), maker)).toThrow('another maker')
  })

  it('fills within bounds, rounding down for the taker', () => {
    const o = offer({ price: { give: '1', get: '3' } })
    expect(fillOffer(o, 1_000_000n)).toBe(333_333n)
    expect(fillOffer(o, 999_999n)).toBeNull()
    expect(fillOffer(o, 1_000_000_001n)).toBeNull()
  })
})

describe('swap routing', () => {
  const req = { from: 'ltc' as const, to: 'bsv' as const, pay: 100_000_000n }
  const priced = (give: string, createdAt = NOW - 1_000) => signSwapOffer(offer({ price: { give, get: '100000000' }, createdAt }), maker)

  it('puts direct offers paying at least Exolix first, best then oldest, then Exolix, then worse offers', () => {
    const best = priced('340000000')
    const older = priced('330000000', NOW - 5_000)
    const newer = priced('330000000', NOW - 2_000)
    const worse = priced('320000000')
    const backstop = exolix(324_000_000n)
    const { routes, chosen } = routeSwap(req, [worse, newer, best, older], backstop, { now: NOW })
    expect(routes.map((r) => (r.kind === 'direct' ? r.offer.nonce : 'exolix'))).toEqual([best.nonce, older.nonce, newer.nonce, 'exolix', worse.nonce])
    // 0.5% of the maker's BSV leg comes off what lands.
    expect(chosen).toMatchObject({ kind: 'direct', lock: 100_000_000n, fee: 1_700_000n, receive: 338_300_000n, net: 338_300_000n - DIRECT_CLAIM_COST.bsv })
  })

  it('defaults to Exolix, marked custodial, when no direct offer pays as much', () => {
    const { chosen, routes } = routeSwap(req, [priced('320000000')], exolix(324_000_000n), { now: NOW })
    expect(chosen).toMatchObject({ kind: 'exolix', custodial: true, receive: 324_000_000n })
    expect(routes).toHaveLength(2)
  })

  it('compares what lands: the taker claim transaction counts against a direct offer', () => {
    const tie = priced('324000000')
    const { chosen } = routeSwap(req, [tie], exolix(324_000_000n), { now: NOW })
    expect(chosen?.kind).toBe('exolix')
  })

  it('skips offers it cannot route, naming why', () => {
    const own = signSwapOffer(offer({}, taker), taker)
    const otherPair = signSwapOffer(offer({ give: 'bch' }), maker)
    const small = signSwapOffer(offer({ maxGet: '50000000' }), maker)
    const forged = { ...priced('340000000'), price: { give: '999000000', get: '100000000' } }
    const good = priced('340000000')
    const { routes, skipped } = routeSwap(req, [own, otherPair, small, forged, good, good], null, { now: NOW, self: taker.toPublicKey().toString() })
    expect(routes.map((r) => r.kind)).toEqual(['direct'])
    expect(skipped.map((s) => s.reason)).toEqual(['own-offer', 'wrong-pair', 'out-of-bounds', 'signature', 'duplicate'])
  })

  it('ignores an Exolix quote for another request', () => {
    expect(routeSwap(req, [], exolix(324_000_000n, { pay: 1n }), { now: NOW }).chosen).toBeNull()
  })

  it('prices an offer halfway between the market rate and Exolix', () => {
    const usd = (a: string) => ({ bsv: 20, ltc: 70, bch: 300 })[a] ?? null
    // market 3.5 BSV per LTC, Exolix 3.24: intercept 3.37
    const res = interceptPrice({ give: 'bsv', get: 'ltc' }, usd, exolix(324_000_000n))
    expect(res).toMatchObject({ ok: true, fair: 3.5, exolix: 3.24, price: { give: '337000000', get: '100000000' } })
    const routed = routeSwap(req, [priced(res.ok ? res.price.give : '0')], exolix(324_000_000n), { now: NOW })
    expect(routed.chosen?.kind).toBe('direct')
  })

  it('has no intercept price without a market price or a spread', () => {
    expect(interceptPrice({ give: 'bsv', get: 'ltc' }, () => null, exolix(324_000_000n))).toEqual({ ok: false, reason: 'no-price' })
    expect(interceptPrice({ give: 'bsv', get: 'ltc' }, (a) => (a === 'bsv' ? 20 : 60), exolix(324_000_000n))).toEqual({ ok: false, reason: 'no-spread' })
    expect(interceptPrice({ give: 'bch', get: 'ltc' }, () => 1, exolix(324_000_000n))).toEqual({ ok: false, reason: 'no-price' })
  })
})

describe('swap quote', () => {
  const req = { from: 'ltc' as const, to: 'bsv' as const, pay: 100_000_000n }
  const backstop = vi.fn(async () => ({ ok: true as const, quote: exolix(324_000_000n) }))

  it('refuses a swap of a coin for itself or of nothing', async () => {
    expect(await quoteSwap({ ...req, to: 'ltc' }, { listOffers: async () => [], fetchExolix: backstop })).toEqual({
      ok: false,
      refusal: { kind: 'bad-request', detail: 'pick two different coins' },
    })
    expect(await quoteSwap({ ...req, pay: 0n }, { listOffers: async () => [], fetchExolix: backstop })).toEqual({
      ok: false,
      refusal: { kind: 'bad-request', detail: 'enter an amount' },
    })
  })

  it('asks for the maker side of the pair and ranks every route', async () => {
    const listOffers = vi.fn(async () => [signSwapOffer(offer(), maker)])
    const res = await quoteSwap(req, { listOffers, fetchExolix: backstop, now: () => NOW })
    expect(listOffers).toHaveBeenCalledWith({ give: 'bsv', get: 'ltc' })
    expect(res.ok && res.quote.routes.map((r) => r.kind)).toEqual(['direct', 'exolix'])
  })

  it('keeps the direct offers when Exolix fails, and names no route when nothing covers it', async () => {
    const down = async () => ({ ok: false as const, refusal: { kind: 'below-min' as const, min: 5n } })
    const res = await quoteSwap(req, { listOffers: async () => [signSwapOffer(offer(), maker)], fetchExolix: down, now: () => NOW })
    expect(res.ok && res.quote.chosen?.kind).toBe('direct')
    const none = await quoteSwap(req, {
      listOffers: async () => {
        throw new Error('book offline')
      },
      fetchExolix: down,
      now: () => NOW,
    })
    expect(none).toEqual({ ok: false, refusal: { kind: 'no-route', exolix: { kind: 'below-min', min: 5n } } })
  })
})

const BSV_ADDR = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT'
const LTC_ADDR = 'ltc1qg82tdqtyc6qqnyr4e8l4ug0tzm3qysnhl0ckzy'
const DEPOSIT = 'ltc1qexolixdepositaddressxxxxxxxxxxxxxxxxx'

function exchangeFetch(over: Record<string, unknown> = {}, status = 200) {
  return vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify({ id: 'ex123', amount: 1, amountTo: 3.24, depositAddress: DEPOSIT, withdrawalAddress: BSV_ADDR, status: 'wait', ...over }), { status }),
  )
}

function fakeWallet(over: Partial<SwapWallet> = {}): SwapWallet & { paid: Array<[string, string, bigint]> } {
  const paid: Array<[string, string, bigint]> = []
  return {
    paid,
    ownAddress: async (asset) => (asset === 'bsv' ? BSV_ADDR : LTC_ADDR),
    validAddress: (asset, address) => (asset === 'bsv' ? isBsvAddress(address) : address.startsWith('ltc1')),
    canPay: async () => {},
    pay: async (asset, address, units) => {
      paid.push([asset, address, units])
      return { txid: 'f'.repeat(64), status: 'sent' }
    },
    ...over,
  }
}

const exolixRoute = () => routeSwap({ from: 'ltc', to: 'bsv', pay: 100_000_000n }, [], exolix(324_000_000n), { now: NOW }).chosen!

describe('Exolix exchange', () => {
  const req = { from: 'ltc' as const, to: 'bsv' as const, pay: 100_000_000n, receive: 324_000_000n }
  const own = { withdrawal: BSV_ADDR, refund: LTC_ADDR }
  const validAddress = fakeWallet().validAddress

  it('opens a fixed-rate exchange paying this wallet and refunding to it', async () => {
    const fetch = exchangeFetch()
    const ex = await createExolixExchange(req, own, { fetch, validAddress })
    expect(ex).toMatchObject({ id: 'ex123', pay: 100_000_000n, receive: 324_000_000n, depositAddress: DEPOSIT })
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({ coinFrom: 'LTC', coinTo: 'BSV', amount: '1', withdrawalAddress: BSV_ADDR, refundAddress: LTC_ADDR, rateType: 'fixed' })
  })

  it('refuses an exchange that pays less, asks more, pays elsewhere, or names a bad deposit', async () => {
    const reason = (over: Record<string, unknown>) =>
      createExolixExchange(req, own, { fetch: exchangeFetch(over), validAddress }).then(
        () => 'paid',
        (err: SwapRefusal) => err.reason,
      )
    expect(await reason({ amountTo: 3.2 })).toBe('terms-changed')
    expect(await reason({ amount: 1.1 })).toBe('terms-changed')
    expect(await reason({ withdrawalAddress: '1AttackerAddressxxxxxxxxxxxxxxxxxx' })).toBe('wrong-payout')
    expect(await reason({ depositAddress: BSV_ADDR })).toBe('bad-deposit')
    expect(await reason({ depositAddress: LTC_ADDR })).toBe('bad-deposit')
    expect(await reason({ status: 'weird' })).toBe('unavailable')
  })

  it('names what Exolix refused', async () => {
    const fetch = exchangeFetch({ message: 'Amount to exchange is below the possible min amount' }, 422)
    await expect(createExolixExchange(req, own, { fetch, validAddress })).rejects.toMatchObject({ reason: 'unavailable', message: 'Amount to exchange is below the possible min amount' })
  })

  it('checks BSV mainnet addresses', () => {
    expect(isBsvAddress(BSV_ADDR)).toBe(true)
    expect(isBsvAddress('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn')).toBe(false)
    expect(isBsvAddress(LTC_ADDR)).toBe(false)
  })
})

describe('runSwap', () => {
  it('records the exchange, then pays its deposit from this wallet', async () => {
    const wallet = fakeWallet()
    const started = await runSwap(exolixRoute(), wallet, { fetch: exchangeFetch(), now: () => NOW })
    if (started.via !== 'exolix') throw new Error('expected an Exolix swap')
    const record = started.record
    expect(wallet.paid).toEqual([['ltc', DEPOSIT, 100_000_000n]])
    expect(record).toMatchObject({ id: 'ex123', stage: 'paid', txid: 'f'.repeat(64), payout: BSV_ADDR, status: 'wait' })
    expect(readSwapRecords()[0]).toEqual(record)
  })

  it('pays nothing when the wallet cannot pay or Exolix changed the terms', async () => {
    const poor = fakeWallet({
      canPay: async () => {
        throw new SwapRefusal('insufficient', 'not enough')
      },
    })
    const fetch = exchangeFetch()
    await expect(runSwap(exolixRoute(), poor, { fetch })).rejects.toMatchObject({ reason: 'insufficient' })
    expect(fetch).not.toHaveBeenCalled()
    const wallet = fakeWallet()
    await expect(runSwap(exolixRoute(), wallet, { fetch: exchangeFetch({ amountTo: 3 }) })).rejects.toMatchObject({ reason: 'terms-changed' })
    expect(wallet.paid).toEqual([])
  })

  it('keeps the record when the deposit fails', async () => {
    const wallet = fakeWallet({
      pay: async () => {
        throw new Error('offline')
      },
    })
    await expect(runSwap(exolixRoute(), wallet, { fetch: exchangeFetch({ id: 'ex-fail' }) })).rejects.toThrow('offline')
    expect(readSwapRecords().find((r) => r.id === 'ex-fail')).toMatchObject({ stage: 'pay-failed', error: 'offline' })
  })

  it('takes a direct offer wallet to wallet, never through Exolix', async () => {
    const direct = routeSwap({ from: 'ltc', to: 'bsv', pay: 100_000_000n }, [signSwapOffer(offer(), maker)], null, { now: NOW }).chosen!
    if (direct.kind !== 'direct') throw new Error('expected a direct route')
    const fetch = exchangeFetch()
    const takeOffer = vi.fn(async () => ({ terms: { swapId: 'ab'.repeat(16) } }))
    const started = await runSwap(direct, fakeWallet(), { fetch, takeOffer })
    expect(takeOffer).toHaveBeenCalledWith(direct.offer, direct.lock)
    expect(started).toEqual({ via: 'direct', swapId: 'ab'.repeat(16), from: 'ltc', to: 'bsv', pay: direct.pay, receive: direct.receive })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('a direct route counts the fee: within the budget on the taker leg, off what lands on the maker leg', () => {
    // LTC → BSV: the maker gives BSV, so the fee rides the maker's (BSV) leg.
    const intoBsv = routeSwap({ from: 'ltc', to: 'bsv', pay: 100_000_000n }, [signSwapOffer(offer(), maker)], null, { now: NOW }).chosen!
    if (intoBsv.kind !== 'direct') throw new Error('expected a direct route')
    const gross = fillOffer(intoBsv.offer, intoBsv.lock)!
    expect(intoBsv.lock).toBe(100_000_000n)
    expect(intoBsv.pay).toBe(100_000_000n)
    expect(intoBsv.fee).toBe((gross * 50n) / 10_000n)
    expect(intoBsv.receive).toBe(gross - intoBsv.fee)

    // BSV → LTC: the taker's leg is BSV, so the fee rides it and less goes into the offer.
    const ltcForBsv = signSwapOffer(offer({ give: 'ltc', get: 'bsv', price: { give: '28000000', get: '100000000' }, minGet: '1000000', maxGet: '100000000000' }), maker)
    const outOfBsv = routeSwap({ from: 'bsv', to: 'ltc', pay: 1_000_000_000n }, [ltcForBsv], null, { now: NOW }).chosen!
    if (outOfBsv.kind !== 'direct') throw new Error('expected a direct route')
    expect(outOfBsv.lock).toBe((1_000_000_000n * 10_000n) / 10_050n)
    expect(outOfBsv.fee).toBe((outOfBsv.lock * 50n) / 10_000n)
    expect(outOfBsv.pay).toBe(outOfBsv.lock + outOfBsv.fee)
    expect(outOfBsv.pay <= 1_000_000_000n).toBe(true)
    expect(outOfBsv.receive).toBe(fillOffer(ltcForBsv, outOfBsv.lock))
  })

  it('follows open swaps until Exolix finishes them', async () => {
    await runSwap(exolixRoute(), fakeWallet(), { fetch: exchangeFetch({ id: 'ex-follow' }), now: () => NOW })
    const status = vi.fn(async (url: string) => {
      expect(url.endsWith('/ex-follow') || !url.includes('ex-follow')).toBe(true)
      return new Response(JSON.stringify({ id: url.split('/').pop(), amount: 1, amountTo: 3.24, depositAddress: DEPOSIT, withdrawalAddress: BSV_ADDR, status: 'success' }))
    })
    await refreshSwapRecords({ fetch: status as unknown as typeof fetch, now: () => NOW + 1 })
    expect(readSwapRecords().find((r) => r.id === 'ex-follow')?.status).toBe('success')
    status.mockClear()
    await refreshSwapRecords({ fetch: status as unknown as typeof fetch })
    expect(status.mock.calls.some(([url]) => String(url).endsWith('/ex-follow'))).toBe(false)
  })
})

describe('swapMachine', () => {
  const req = { from: 'ltc' as const, to: 'bsv' as const, pay: 100_000_000n }
  const quoting = fromPromise(async ({ input }: { input: typeof req }) =>
    quoteSwap(input, { listOffers: async () => [signSwapOffer(offer(), maker)], fetchExolix: async () => ({ ok: true, quote: exolix(324_000_000n) }), now: () => NOW }),
  )

  it('quotes, picks a ranked route, and goes stale', async () => {
    vi.useFakeTimers()
    try {
        const actor = createActor(swapMachine.provide({ actors: { quote: quoting } })).start()
      actor.send({ type: 'QUOTE', request: req })
      await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('quoted'))
      expect(actor.getSnapshot().context.picked).toBe(0)
      actor.send({ type: 'PICK', index: 1 })
      expect(actor.getSnapshot().context.picked).toBe(1)
      actor.send({ type: 'PICK', index: 5 })
      expect(actor.getSnapshot().context.picked).toBe(1)
      vi.advanceTimersByTime(SWAP_QUOTE_TTL_MS)
      expect(actor.getSnapshot().value).toBe('stale')
    } finally {
      vi.useRealTimers()
    }
  })

  it('moves coins only on CONFIRM, whichever route is picked', async () => {
    const execute = vi.fn(async () => ({ via: 'exolix', record: { id: 'ex123' } }) as never)
    const actor = createActor(swapMachine.provide({ actors: { quote: quoting, execute: fromPromise(execute) } })).start()
    actor.send({ type: 'QUOTE', request: req })
    await waitFor(actor, (s) => s.matches('quoted'))
    // The default is the direct offer (3.5 > Exolix 3.24): it reviews like any route.
    actor.send({ type: 'REVIEW' })
    expect(actor.getSnapshot().value).toBe('reviewing')
    actor.send({ type: 'BACK' })
    actor.send({ type: 'PICK', index: 1 })
    actor.send({ type: 'REVIEW' })
    expect(actor.getSnapshot().value).toBe('reviewing')
    actor.send({ type: 'BACK' })
    actor.send({ type: 'REVIEW' })
    expect(execute).not.toHaveBeenCalled()
    actor.send({ type: 'CONFIRM' })
    const done = await waitFor(actor, (s) => s.matches('done'))
    expect(execute).toHaveBeenCalledTimes(1)
    expect(done.context.started).toEqual({ via: 'exolix', record: { id: 'ex123' } })
    actor.send({ type: 'RESET' })
    expect(actor.getSnapshot().value).toBe('editing')
  })

  it('names why a swap failed', async () => {
    const execute = fromPromise(async () => {
      throw new SwapRefusal('terms-changed', 'Exolix now pays less. Nothing was paid.')
    })
    const actor = createActor(swapMachine.provide({ actors: { quote: quoting, execute } })).start()
    actor.send({ type: 'QUOTE', request: req })
    await waitFor(actor, (s) => s.matches('quoted'))
    actor.send({ type: 'PICK', index: 1 })
    actor.send({ type: 'REVIEW' })
    actor.send({ type: 'CONFIRM' })
    const failed = await waitFor(actor, (s) => s.matches('failed'))
    expect(failed.context.failure).toEqual({ reason: 'terms-changed', message: 'Exolix now pays less. Nothing was paid.' })
  })

  it('is refused with the named reason', async () => {
    const machine = swapMachine.provide({ actors: { quote: fromPromise(async ({ input }) => quoteSwap(input, { listOffers: async () => [] })) } })
    const actor = createActor(machine).start()
    actor.send({ type: 'QUOTE', request: { ...req, to: 'ltc' } })
    const snap = await waitFor(actor, (s) => s.matches('refused'))
    expect(snap.context.refusal).toEqual({ kind: 'bad-request', detail: 'pick two different coins' })
  })

  it('offers to publish only when no route can take the swap, and publishes only on PUBLISH', async () => {
    const belowMin = fromPromise(async () => ({ ok: false as const, refusal: { kind: 'no-route' as const, exolix: { kind: 'below-min' as const, min: 0.1 } } }))
    const publish = vi.fn(async () => ({ nonce: 'n1' }) as never)
    const failOnce = vi.fn(async () => {
      throw new Error('offer book refused the offer: rate-limited')
    })
    const draft = { give: 'bsv' as const, get: 'ltc' as const, pay: 1_000n, want: 300n, price: { give: '333333333', get: '100000000' } }
    const actor = createActor(swapMachine.provide({ actors: { quote: belowMin, publish: fromPromise(publish) } })).start()
    actor.send({ type: 'QUOTE', request: req })
    await waitFor(actor, (s) => s.matches('refused'))
    actor.send({ type: 'OFFER', draft })
    expect(actor.getSnapshot().value).toBe('offering')
    actor.send({ type: 'BACK' })
    expect(actor.getSnapshot().value).toBe('refused')
    actor.send({ type: 'OFFER', draft })
    expect(publish).not.toHaveBeenCalled()
    actor.send({ type: 'PUBLISH' })
    const done = await waitFor(actor, (s) => s.matches('published'))
    expect(publish).toHaveBeenCalledTimes(1)
    expect(done.context.published).toEqual({ nonce: 'n1' })

    const failing = createActor(swapMachine.provide({ actors: { quote: belowMin, publish: fromPromise(failOnce) } })).start()
    failing.send({ type: 'QUOTE', request: req })
    await waitFor(failing, (s) => s.matches('refused'))
    failing.send({ type: 'OFFER', draft })
    failing.send({ type: 'PUBLISH' })
    const back = await waitFor(failing, (s) => s.matches('offering') && s.context.failure !== null)
    expect(back.context.failure).toEqual({ reason: 'publish-failed', message: 'offer book refused the offer: rate-limited' })
  })

  it('never offers on a bad request', async () => {
    const machine = swapMachine.provide({ actors: { quote: fromPromise(async ({ input }) => quoteSwap(input, { listOffers: async () => [] })) } })
    const actor = createActor(machine).start()
    actor.send({ type: 'QUOTE', request: { ...req, to: 'ltc' } })
    await waitFor(actor, (s) => s.matches('refused'))
    actor.send({ type: 'OFFER', draft: { give: 'ltc', get: 'ltc', pay: 1n, want: 1n, price: { give: '1', get: '1' } } })
    expect(actor.getSnapshot().value).toBe('refused')
  })
})

describe('swapOffersMachine', () => {
  const mine = signSwapOffer(offer(), maker)
  const theirs = signSwapOffer(offer({}, taker), taker)

  it('loads verified offers and cancels only its own', async () => {
    const cancel = vi.fn(async () => undefined)
    let book = [mine, theirs]
    const load = fromPromise(async () => book)
    const actor = createActor(
      swapOffersMachine.provide({ actors: { load, cancel: fromPromise(async ({ input }: { input: string }) => { await cancel(input); book = book.filter((o) => o.nonce !== input) }) } }),
      { input: { self: maker.toPublicKey().toString() } },
    ).start()
    await waitFor(actor, (s) => s.matches('ready'))
    actor.send({ type: 'CANCEL', nonce: theirs.nonce })
    expect(actor.getSnapshot().value).toBe('ready')
    actor.send({ type: 'CANCEL', nonce: mine.nonce })
    expect(actor.getSnapshot().value).toBe('cancelling')
    const after = await waitFor(actor, (s) => s.matches('ready') && s.context.offers.length === 1)
    expect(cancel).toHaveBeenCalledWith(mine.nonce)
    expect(after.context.offers).toEqual([theirs])
  })

  it('takes only someone else\'s offer, and only on CONFIRM after review', async () => {
    const take = vi.fn(async () => undefined)
    const actor = createActor(
      swapOffersMachine.provide({ actors: { load: fromPromise(async () => [mine, theirs]), take: fromPromise(async ({ input }) => take(input)) } }),
      { input: { self: maker.toPublicKey().toString() } },
    ).start()
    await waitFor(actor, (s) => s.matches('ready'))
    actor.send({ type: 'REVIEW', nonce: mine.nonce })
    expect(actor.getSnapshot().value).toBe('ready')
    actor.send({ type: 'REVIEW', nonce: theirs.nonce })
    expect(actor.getSnapshot().value).toBe('reviewing')
    actor.send({ type: 'BACK' })
    expect(actor.getSnapshot().context.taking).toBeNull()
    actor.send({ type: 'REVIEW', nonce: theirs.nonce })
    expect(take).not.toHaveBeenCalled()
    actor.send({ type: 'CONFIRM' })
    await waitFor(actor, (s) => s.matches('taken'))
    expect(take).toHaveBeenCalledExactlyOnceWith(theirs)
  })

  it('returns to review with the reason when the take is refused', async () => {
    const actor = createActor(
      swapOffersMachine.provide({
        actors: {
          load: fromPromise(async () => [theirs]),
          take: fromPromise(async () => {
            throw new Error('Not enough LTC to lock for this swap.')
          }),
        },
      }),
      { input: { self: maker.toPublicKey().toString() } },
    ).start()
    await waitFor(actor, (s) => s.matches('ready'))
    actor.send({ type: 'REVIEW', nonce: theirs.nonce })
    actor.send({ type: 'CONFIRM' })
    const back = await waitFor(actor, (s) => s.matches('reviewing') && !!s.context.failure)
    expect(back.context.failure).toBe('Not enough LTC to lock for this swap.')
  })

  it('fails with the reason and recovers on REFRESH', async () => {
    let up = false
    const load = fromPromise(async () => {
      if (!up) throw new Error('offer book unavailable: HTTP 503')
      return []
    })
    const actor = createActor(swapOffersMachine.provide({ actors: { load } }), { input: { self: null } }).start()
    const failed = await waitFor(actor, (s) => s.matches('failed'))
    expect(failed.context.failure).toBe('offer book unavailable: HTTP 503')
    up = true
    actor.send({ type: 'REFRESH' })
    await waitFor(actor, (s) => s.matches('ready'))
  })
})
