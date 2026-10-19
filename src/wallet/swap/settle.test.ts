import { PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { toHex } from '../ltc/litecoin'
import { signSwapOffer, type SignedSwapOffer } from './offer'
import {
  ACCEPT_WAIT_MS,
  agreedTerms,
  checkTake,
  feeLegOf,
  judgeTakeRoom,
  legOutputs,
  nextSettleStep,
  offerRemaining,
  offerRoom,
  parseSettleMessage,
  proposeTerms,
  secretHash,
  settleKeyOf,
  swapFee,
  swapLegs,
  swapSecret,
  swapSettlePub,
  swapWindows,
  takeFits,
  takerLockSeenBy,
  takerLockTooLate,
  takerTotals,
  type AgreedTerms,
  type LegFacts,
  type SettleFacts,
  type SwapTerms,
} from './settle'
import type { SwapAsset } from './assets'

const makerRoot = PrivateKey.fromString('a1'.repeat(32), 'hex')
const takerRoot = PrivateKey.fromString('b2'.repeat(32), 'hex')
const maker = makerRoot.toPublicKey().toString()
const taker = takerRoot.toPublicKey().toString()
const now = 1_790_000_000_000
const swapId = '0f'.repeat(16)

function offer(give: SwapAsset, get: SwapAsset, want = 1_000_000_000n, price = { give: '50000000', get: '100000000' }, minGet = want): SignedSwapOffer {
  return signSwapOffer(
    { v: 1, maker, give, get, price, minGet: minGet.toString(), maxGet: want.toString(), createdAt: now - 60_000, expiresAt: now + 3_600_000, nonce: 'aa'.repeat(32) },
    makerRoot,
  )
}

function take(o: SignedSwapOffer, pay = BigInt(o.maxGet)): SwapTerms {
  const r = proposeTerms(o, pay, { identityKey: taker, root: takerRoot }, { now, swapId })
  if (!r.ok) throw new Error(r.reason)
  return r.terms
}

const agreed = (t: SwapTerms): AgreedTerms => agreedTerms(t)!
const H = 3600
/** The same take as a v1 wallet made it: the maker's key from its accept, short windows, BSV refunds pre-signed. */
function asV1(t: SwapTerms): SwapTerms {
  const { makerPub: _derived, ...rest } = t
  const s = Math.floor(t.takenAt / 1000)
  return { ...rest, v: 1, t1: s + 36 * H, t2: s + 12 * H }
}

describe('swap fee', () => {
  it('rides the BSV leg when there is one, else the maker leg', () => {
    expect(feeLegOf({ give: 'ltc', get: 'bsv' })).toBe('taker')
    expect(feeLegOf({ give: 'bsv', get: 'ltc' })).toBe('maker')
    expect(feeLegOf({ give: 'doge', get: 'btc' })).toBe('maker')
  })

  it('is 0.5% of the fee leg, none below ten claim transactions', () => {
    expect(swapFee({ give: 'ltc', get: 'bsv' }, 1_000_000n, 1n)).toEqual({ leg: 'taker', amount: '5000' })
    expect(swapFee({ give: 'ltc', get: 'bsv' }, 100_000n, 1n)).toBeNull()
    expect(swapFee({ give: 'bsv', get: 'btc' }, 1n, 4_000_000n)).toEqual({ leg: 'maker', amount: '20000' })
  })

  it('the taker bears it on either leg', () => {
    expect(takerTotals({ pay: '1000000', receive: '500', fee: { leg: 'taker', amount: '5000' } })).toEqual({ pays: 1_005_000n, receives: 500n, fee: 5000n })
    expect(takerTotals({ pay: '1000', receive: '4000000', fee: { leg: 'maker', amount: '20000' } })).toEqual({ pays: 1000n, receives: 3_980_000n, fee: 20_000n })
  })
})

describe('take', () => {
  it('the maker accepts exactly what the taker proposed', () => {
    const t = take(offer('ltc', 'bsv'))
    expect(t.receive).toBe('500000000')
    expect(t.fee).toEqual({ leg: 'taker', amount: '5000000' })
    expect(t.hash).toBe(secretHash(swapSecret(takerRoot, swapId)))
    expect(checkTake(JSON.parse(JSON.stringify(t)), maker, now + 1000)).toEqual({ ok: true, terms: t })
    expect(checkTake(t, maker, now + 1000, makerRoot)).toEqual({ ok: true, terms: t })
  })

  it("the taker derives the maker's swap key itself; only that maker holds its private half", () => {
    const t = take(offer('ltc', 'bsv'))
    expect(t.v).toBe(2)
    expect(settleKeyOf(makerRoot, t, 'maker').toPublicKey().toString()).toBe(t.makerPub)
    expect(settleKeyOf(takerRoot, t, 'taker').toPublicKey().toString()).toBe(t.takerPub)
    expect(t.makerPub).not.toBe(swapSettlePub(makerRoot, swapId))
    const forged = { ...t, makerPub: swapSettlePub(takerRoot, '1e'.repeat(16)) }
    expect(checkTake(forged, maker, now, makerRoot)).toEqual({ ok: false, reason: 'wrong-key' })
  })

  it('a maker that was away judges a v2 take as of when it was made', () => {
    const t = take(offer('ltc', 'bsv'))
    const w = swapWindows(2)
    // The offer expired an hour after the take; the maker comes back a day later and still honours it.
    expect(checkTake(t, maker, now + 24 * 3600_000, makerRoot)).toEqual({ ok: true, terms: t })
    expect(checkTake(t, maker, (t.t2 - w.makerFundBeforeT2) * 1000, makerRoot)).toEqual({ ok: false, reason: 'stale' })
    expect(checkTake(t, maker, now - 10 * 60_000, makerRoot)).toEqual({ ok: false, reason: 'stale' })
    const early = take(offer('ltc', 'bsv'))
    const before = { ...early, takenAt: now - 2 * 60_000, t1: Math.floor((now - 2 * 60_000) / 1000) + w.takerLock, t2: Math.floor((now - 2 * 60_000) / 1000) + w.makerLock }
    expect(checkTake(before, maker, now, makerRoot)).toMatchObject({ ok: true })
    const beforeOffer = { ...before, takenAt: now - 2 * 3600_000, t1: Math.floor((now - 2 * 3600_000) / 1000) + w.takerLock, t2: Math.floor((now - 2 * 3600_000) / 1000) + w.makerLock }
    expect(checkTake(beforeOffer, maker, now, makerRoot)).toEqual({ ok: false, reason: 'offer' })
  })

  it('a v1 take still has to be made just now', () => {
    const t = asV1(take(offer('ltc', 'bsv')))
    expect(checkTake(t, maker, now + 1000)).toEqual({ ok: true, terms: t })
    expect(checkTake(t, maker, now + 10 * 60_000)).toEqual({ ok: false, reason: 'stale' })
  })

  it("a lock from a block long after the take means the take was backdated", () => {
    const t = take(offer('ltc', 'bsv'))
    const s = Math.floor(now / 1000)
    expect(takerLockTooLate(t, undefined)).toBe(false)
    expect(takerLockTooLate(t, s + 2 * H)).toBe(false)
    expect(takerLockTooLate(t, s + 3 * H)).toBe(false)
    expect(takerLockTooLate(t, s + 3 * H + 1)).toBe(true)
    expect(takerLockTooLate(asV1(t), s + 30 * H)).toBe(false)
  })

  it('refuses a take that changes the price, the fee, the lock times or the offer', () => {
    const t = take(offer('ltc', 'bsv'))
    expect(checkTake({ ...t, receive: '600000000' }, maker, now)).toEqual({ ok: false, reason: 'wrong-receive' })
    expect(checkTake({ ...t, fee: null }, maker, now)).toEqual({ ok: false, reason: 'wrong-fee' })
    expect(checkTake({ ...t, t2: t.t2 + 3600 }, maker, now)).toEqual({ ok: false, reason: 'wrong-times' })
    expect(checkTake({ ...t, offer: { ...t.offer, price: { give: '60000000', get: '100000000' } } }, maker, now)).toEqual({ ok: false, reason: 'offer' })
    expect(checkTake(t, taker, now)).toEqual({ ok: false, reason: 'offer' })
    expect(checkTake({ ...t, pay: '5' }, maker, now)).toEqual({ ok: false, reason: 'out-of-bounds' })
    expect(checkTake({ ...t, hash: 'zz' }, maker, now)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('a taker never takes its own offer', () => {
    const o = offer('ltc', 'bsv')
    expect(proposeTerms(o, BigInt(o.maxGet), { identityKey: maker, root: makerRoot }, { now })).toEqual({ ok: false, reason: 'own-offer' })
  })

  it('the secret survives a restore: it is derived, not stored', () => {
    expect(toHex(swapSecret(takerRoot, swapId))).toBe(toHex(swapSecret(PrivateKey.fromString('b2'.repeat(32), 'hex'), swapId)))
    expect(toHex(swapSecret(takerRoot, swapId))).not.toBe(toHex(swapSecret(takerRoot, '1e'.repeat(16))))
  })
})

describe('partial fills', () => {
  const o = offer('ltc', 'bsv', 1_000_000_000n, undefined, 200_000_000n)
  const record = (pay: bigint, outcome?: 'swapped' | 'expired' | 'declined' | 'refunded') => ({ terms: take(o, pay), ...(outcome ? { outcome } : {}) })

  it('a taker pays any part between the smallest take and what is left', () => {
    expect(take(o, 300_000_000n).receive).toBe('150000000')
    expect(proposeTerms(o, 100_000_000n, { identityKey: taker, root: takerRoot }, { now })).toEqual({ ok: false, reason: 'out-of-bounds' })
    expect(offerRoom(o)).toEqual({ min: 200_000_000n, max: 1_000_000_000n })
    expect(offerRoom(o, 700_000_000n)).toEqual({ min: 200_000_000n, max: 300_000_000n })
    expect(offerRoom(o, 900_000_000n)).toBeNull()
  })

  it('the maker takes on takes in turn until no take fits, and honours a v2 take made before a withdrawal', () => {
    const own = { offer: o, state: 'open' as const }
    expect(judgeTakeRoom(undefined, [], take(o, 300_000_000n))).toEqual({ ok: false, reason: 'offer-unknown' })
    expect(judgeTakeRoom(own, [record(400_000_000n)], take(o, 300_000_000n))).toEqual({ ok: true, left: 300_000_000n, usedUp: false })
    expect(judgeTakeRoom(own, [record(400_000_000n), record(500_000_000n)], take(o, 200_000_000n))).toEqual({ ok: false, reason: 'offer-filled' })
    expect(judgeTakeRoom(own, [record(400_000_000n), record(400_000_000n)], take(o, 200_000_000n))).toEqual({ ok: true, left: 0n, usedUp: true })
    const t = take(o, 300_000_000n)
    expect(judgeTakeRoom({ ...own, state: 'cancelled', cancelledAt: t.takenAt + 1 }, [], t)).toMatchObject({ ok: true })
    expect(judgeTakeRoom({ ...own, state: 'cancelled', cancelledAt: t.takenAt }, [], t)).toEqual({ ok: false, reason: 'offer-cancelled' })
    expect(judgeTakeRoom({ ...own, state: 'taken' }, [], asV1(t))).toEqual({ ok: false, reason: 'offer-taken' })
    expect(judgeTakeRoom(own, [], asV1(t))).toEqual({ ok: true, left: 700_000_000n, usedUp: true })
  })

  it('takes the maker took on use the offer up; declined and expired ones give their room back', () => {
    const takes = [record(400_000_000n, 'swapped'), record(300_000_000n), record(200_000_000n, 'expired'), record(200_000_000n, 'declined')]
    expect(offerRemaining(o, takes)).toBe(300_000_000n)
    expect(offerRemaining(o, [...takes, record(300_000_000n, 'refunded')])).toBe(0n)
    expect(takeFits(o, 300_000_000n, 300_000_000n)).toBe(true)
    expect(takeFits(o, 300_000_000n, 300_000_001n)).toBe(false)
    expect(takeFits(o, 300_000_000n, 199_999_999n)).toBe(false)
  })
})

describe('legs', () => {
  it('the taker locks pay (and the fee) on the wanted chain for T1, the maker the rest on the given chain for T2', () => {
    const t = take(offer('ltc', 'bsv'))
    const legs = swapLegs(t)
    expect(legs.taker).toMatchObject({ chain: 'bsv', amount: 1_000_000_000n, fee: 5_000_000n, locktime: t.t1 })
    expect(legs.maker).toMatchObject({ chain: 'ltc', amount: 500_000_000n, fee: 0n, locktime: t.t2 })
    expect(t.t1 - t.t2).toBe(24 * 3600)
    expect(t.t2 - Math.floor(now / 1000)).toBe(48 * 3600)
  })

  it('a v2 BSV lock names no co-signer; a v1 one names the payee', () => {
    const t = take(offer('ltc', 'bsv'))
    const v2 = legOutputs(agreed(t), 'taker').main.script
    const v1 = legOutputs({ ...asV1(t), makerPub: t.makerPub! }, 'taker').main.script
    expect(toHex(v1)).toContain(t.takerPub)
    expect(toHex(v1)).toContain(t.makerPub)
    expect(toHex(v2)).not.toContain(t.takerPub + 'ad')
    expect(v2.length).toBeGreaterThan(v1.length)
  })

  it('locks the fee to HandCash with the same secret, refundable to its payer', () => {
    const t = agreed(take(offer('bsv', 'ltc')))
    const own = legOutputs(t, 'maker')
    expect(own.fee).not.toBeNull()
    expect(own.main.address).toBeNull()
    expect(own.main.amount + own.fee!.amount).toBe(BigInt(t.receive))
    expect(toHex(own.fee!.script)).toContain(t.hash)
    expect(toHex(own.fee!.script)).toContain('03a7844691b951beb4261441a53e5248fba582babb72ce189e8b21e8dfe8442487')
    const theirs = legOutputs(t, 'taker')
    expect(theirs.fee).toBeNull()
    expect(theirs.main.address).toMatch(/^ltc1q/)
  })
})

describe('settle messages', () => {
  it('keeps well-formed messages and drops the rest', () => {
    expect(parseSettleMessage(JSON.stringify({ t: 'accept', swapId, makerPub: maker }))).toEqual({ t: 'accept', swapId, makerPub: maker })
    expect(parseSettleMessage({ t: 'funded', swapId, leg: 'taker', txid: 'ab'.repeat(32), main: 0, fee: 1 })).toMatchObject({ t: 'funded', fee: 1 })
    expect(parseSettleMessage({ t: 'funded', swapId, leg: 'other', txid: 'ab'.repeat(32), main: 0 })).toBeNull()
    expect(parseSettleMessage({ t: 'secret', swapId, secret: 'ab' })).toBeNull()
    expect(parseSettleMessage({ t: 'accept', swapId: 'nope', makerPub: maker })).toBeNull()
    expect(parseSettleMessage('{not json')).toBeNull()
  })
})

describe('next step', () => {
  const t2 = take(offer('ltc', 'bsv'))
  const t = asV1(t2)
  const w1 = swapWindows(1)
  const leg = (o: Partial<LegFacts> = {}): LegFacts => ({ funded: false, buried: false, claimed: false, refunded: false, ...o })
  const facts = (o: Partial<SettleFacts>): SettleFacts => ({
    role: 'taker',
    now,
    accepted: true,
    declined: false,
    secretKnown: true,
    own: leg(),
    peer: leg(),
    ownOnBsv: true,
    // The chain's clock agrees with the device's unless a case says otherwise.
    peerChainTime: Math.floor((o.now ?? now) / 1000),
    ...o,
  })
  const at = (unixS: number) => unixS * 1000

  it('taker: waits for accept, then has its BSV refund pre-signed, then funds', () => {
    expect(nextSettleStep(t, facts({ accepted: false }))).toEqual({ kind: 'wait', for: 'accept' })
    expect(nextSettleStep(t, facts({ accepted: false, now: now + ACCEPT_WAIT_MS + 1 }))).toEqual({ kind: 'done', outcome: 'expired' })
    expect(nextSettleStep(t, facts({ declined: true, accepted: false }))).toEqual({ kind: 'done', outcome: 'declined' })
    expect(nextSettleStep(t, facts({}))).toEqual({ kind: 'request-presign' })
    expect(nextSettleStep(t, facts({ own: leg({ presigned: true }) }))).toEqual({ kind: 'fund' })
    expect(nextSettleStep(t, facts({ own: leg({ presigned: true }), now: now + 2 * 3600_000 }))).toEqual({ kind: 'done', outcome: 'expired' })
  })

  it('taker: claims only a buried maker lock, and only with time left before T2', () => {
    const own = leg({ funded: true, presigned: true })
    expect(nextSettleStep(t, facts({ own }))).toMatchObject({ kind: 'wait', for: 'peer-funding' })
    expect(nextSettleStep(t, facts({ own, peer: leg({ funded: true }) }))).toMatchObject({ kind: 'wait', for: 'peer-burial' })
    expect(nextSettleStep(t, facts({ own, peer: leg({ funded: true, buried: true }) }))).toEqual({ kind: 'claim' })
    const late = at(t.t2 - w1.takerClaimBeforeT2)
    expect(nextSettleStep(t, facts({ own, peer: leg({ funded: true, buried: true }), now: late }))).toEqual({ kind: 'wait', for: 'locktime', until: at(t.t1) })
    expect(nextSettleStep(t, facts({ own, now: at(t.t1) }))).toEqual({ kind: 'refund' })
    expect(nextSettleStep(t, facts({ own: { ...own, refunded: true }, now: at(t.t1) }))).toEqual({ kind: 'done', outcome: 'refunded' })
  })

  it("taker: claims only while the chain's clock, as well as the device's, is before the deadline", () => {
    const own = leg({ funded: true, presigned: true })
    const peer = leg({ funded: true, buried: true })
    const claimBy = t.t2 - w1.takerClaimBeforeT2
    // A device clock running slow: the chain's latest block is already past the deadline.
    expect(nextSettleStep(t, facts({ own, peer, peerChainTime: claimBy }))).toEqual({ kind: 'wait', for: 'locktime', until: at(t.t1) })
    expect(nextSettleStep(t, facts({ own, peer, peerChainTime: claimBy - 1 }))).toEqual({ kind: 'claim' })
    // A chain view running behind cannot stretch the deadline past the device's clock either.
    expect(nextSettleStep(t, facts({ own, peer, now: at(claimBy), peerChainTime: claimBy - 3600 }))).toEqual({ kind: 'wait', for: 'locktime', until: at(t.t1) })
    // No chain clock to read: wait for one rather than claim on the device's word alone.
    expect(nextSettleStep(t, facts({ own, peer, peerChainTime: undefined }))).toEqual({ kind: 'wait', for: 'chain-time', until: at(claimBy) })
  })

  it('a claimed swap is done, unless HandCash left its fee unclaimed past the lock', () => {
    const peer = leg({ funded: true, buried: true, claimed: true })
    expect(nextSettleStep(t, facts({ own: leg({ funded: true }), peer }))).toEqual({ kind: 'done', outcome: 'swapped' })
    expect(nextSettleStep(t, facts({ own: leg({ funded: true, feeUnspent: true }), peer }))).toMatchObject({ kind: 'wait', for: 'locktime' })
    expect(nextSettleStep(t, facts({ own: leg({ funded: true, feeUnspent: true }), peer, now: at(t.t1) }))).toEqual({ kind: 'refund-fee' })
  })

  it('a lock proven never on chain ends the swap: no refund to wait for, no claim against an unpaid peer', () => {
    const own = leg({ funded: true, presigned: true, unsent: true })
    expect(nextSettleStep(t, facts({ own }))).toEqual({ kind: 'done', outcome: 'unsent' })
    expect(nextSettleStep(t, facts({ own, peer: leg({ funded: true, buried: true }) }))).toEqual({ kind: 'done', outcome: 'unsent' })
    expect(nextSettleStep(t, facts({ own, declined: true, now: at(t.t1) }))).toEqual({ kind: 'done', outcome: 'unsent' })
    expect(nextSettleStep(t, facts({ own: leg({ unsent: true }) }))).toEqual({ kind: 'request-presign' })
  })

  it('a lock that may already be signed is resolved before a decline or an expiry closes the swap over it', () => {
    const m = (o: Partial<SettleFacts>) => facts({ role: 'maker', secretKnown: false, ownOnBsv: false, ...o })
    const started = leg({ started: true })
    expect(nextSettleStep(t2, m({ own: started, declined: true }))).toEqual({ kind: 'fund' })
    expect(nextSettleStep(t2, m({ own: started, now: at(t2.t2) }))).toEqual({ kind: 'fund' })
    expect(nextSettleStep(t2, m({ declined: true }))).toEqual({ kind: 'done', outcome: 'declined' })
  })

  it('maker: funds only after the taker lock is buried, and not too close to T2', () => {
    const m = (o: Partial<SettleFacts>) => facts({ role: 'maker', secretKnown: false, ownOnBsv: false, ...o })
    const seenBy = takerLockSeenBy(t) * 1000
    expect(nextSettleStep(t, m({}))).toEqual({ kind: 'wait', for: 'peer-funding', until: seenBy })
    // The taker stops trying at an hour; a lock signed at its last minute may be announced (or mined) later, so the maker waits until it no longer counts.
    expect(nextSettleStep(t, m({ now: now + 3600_000 + 60_000 }))).toMatchObject({ kind: 'wait', for: 'peer-funding' })
    expect(nextSettleStep(t, m({ now: seenBy }))).toMatchObject({ kind: 'wait', for: 'peer-funding' })
    expect(nextSettleStep(t, m({ now: seenBy + 1000 }))).toEqual({ kind: 'done', outcome: 'expired' })
    expect(takerLockTooLate({ ...t, v: 2 } as typeof t, takerLockSeenBy(t))).toBe(false)
    expect(takerLockTooLate({ ...t, v: 2 } as typeof t, takerLockSeenBy(t) + 1)).toBe(true)
    expect(nextSettleStep(t, m({ peer: leg({ funded: true }) }))).toMatchObject({ kind: 'wait', for: 'peer-burial' })
    expect(nextSettleStep(t, m({ peer: leg({ funded: true, buried: true }) }))).toEqual({ kind: 'fund' })
    expect(nextSettleStep(t, m({ peer: leg({ funded: true, buried: true }), now: at(t.t2 - w1.makerFundBeforeT2) }))).toEqual({ kind: 'done', outcome: 'expired' })
  })

  it('v2 taker: locks at once without an accept or any pre-signature', () => {
    expect(nextSettleStep(t2, facts({ accepted: false }))).toEqual({ kind: 'fund' })
    expect(nextSettleStep(t2, facts({ accepted: false, now: now + 2 * 3600_000 }))).toEqual({ kind: 'done', outcome: 'expired' })
    const own = leg({ funded: true })
    expect(nextSettleStep(t2, facts({ accepted: false, own }))).toEqual({ kind: 'wait', for: 'peer-funding', until: at(t2.t2 - swapWindows(2).makerFundBeforeT2) })
    // Declined after it locked: nothing to wait for but T1.
    expect(nextSettleStep(t2, facts({ declined: true, own }))).toEqual({ kind: 'wait', for: 'locktime', until: at(t2.t1) })
    expect(nextSettleStep(t2, facts({ declined: true, own, peer: leg({ funded: true, buried: true }) }))).toEqual({ kind: 'claim' })
  })

  it('v2 maker: funds a BSV leg without asking for anything, a day after the take', () => {
    const offerBsv = take(offer('bsv', 'ltc'))
    const m = (o: Partial<SettleFacts>) => facts({ role: 'maker', secretKnown: false, ownOnBsv: true, ...o })
    expect(nextSettleStep(offerBsv, m({ peer: leg({ funded: true, buried: true }), now: now + 24 * 3600_000 }))).toEqual({ kind: 'fund' })
    expect(nextSettleStep(offerBsv, m({ peer: leg({ funded: true, buried: true }), now: at(offerBsv.t2 - swapWindows(2).makerFundBeforeT2) }))).toEqual({ kind: 'done', outcome: 'expired' })
  })

  it('maker: claims once the secret is out, refunds at T2 if it never is', () => {
    const m = (o: Partial<SettleFacts>) => facts({ role: 'maker', ownOnBsv: false, own: leg({ funded: true }), peer: leg({ funded: true, buried: true }), ...o })
    expect(nextSettleStep(t, m({ secretKnown: false }))).toMatchObject({ kind: 'wait', for: 'secret' })
    expect(nextSettleStep(t, m({ secretKnown: true }))).toEqual({ kind: 'claim' })
    expect(nextSettleStep(t, m({ secretKnown: true, now: at(t.t1 + 60) }))).toEqual({ kind: 'claim' })
    expect(nextSettleStep(t, m({ secretKnown: true, peer: leg({ funded: true, refunded: true }) }))).toEqual({ kind: 'done', outcome: 'missed' })
    expect(nextSettleStep(t, m({ secretKnown: false, now: at(t.t2) }))).toEqual({ kind: 'refund' })
  })
})
