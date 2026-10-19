import { PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { toHex } from '../ltc/litecoin'
import { signSwapOffer, type SignedSwapOffer } from './offer'
import {
  ACCEPT_WAIT_MS,
  checkTake,
  feeLegOf,
  legOutputs,
  MAKER_FUND_BEFORE_T2_S,
  nextSettleStep,
  parseSettleMessage,
  proposeTerms,
  secretHash,
  swapFee,
  swapLegs,
  swapSecret,
  swapSettlePub,
  takerTotals,
  TAKER_CLAIM_BEFORE_T2_S,
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

function offer(give: SwapAsset, get: SwapAsset, want = 1_000_000_000n, price = { give: '50000000', get: '100000000' }): SignedSwapOffer {
  return signSwapOffer(
    { v: 1, maker, give, get, price, minGet: want.toString(), maxGet: want.toString(), createdAt: now - 60_000, expiresAt: now + 3_600_000, nonce: 'aa'.repeat(32) },
    makerRoot,
  )
}

function take(o: SignedSwapOffer, pay = BigInt(o.maxGet)): SwapTerms {
  const r = proposeTerms(o, pay, { identityKey: taker, root: takerRoot }, { now, swapId })
  if (!r.ok) throw new Error(r.reason)
  return r.terms
}

const agreed = (t: SwapTerms): AgreedTerms => ({ ...t, makerPub: swapSettlePub(makerRoot, t.swapId) })

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
  })

  it('refuses a take that changes the price, the fee, the lock times or the offer', () => {
    const t = take(offer('ltc', 'bsv'))
    expect(checkTake({ ...t, receive: '600000000' }, maker, now)).toEqual({ ok: false, reason: 'wrong-receive' })
    expect(checkTake({ ...t, fee: null }, maker, now)).toEqual({ ok: false, reason: 'wrong-fee' })
    expect(checkTake({ ...t, t2: t.t2 + 3600 }, maker, now)).toEqual({ ok: false, reason: 'wrong-times' })
    expect(checkTake({ ...t, offer: { ...t.offer, price: { give: '60000000', get: '100000000' } } }, maker, now)).toEqual({ ok: false, reason: 'offer' })
    expect(checkTake(t, taker, now)).toEqual({ ok: false, reason: 'offer' })
    expect(checkTake(t, maker, now + 10 * 60_000)).toEqual({ ok: false, reason: 'stale' })
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

describe('legs', () => {
  it('the taker locks pay (and the fee) on the wanted chain for T1, the maker the rest on the given chain for T2', () => {
    const t = take(offer('ltc', 'bsv'))
    const legs = swapLegs(t)
    expect(legs.taker).toMatchObject({ chain: 'bsv', amount: 1_000_000_000n, fee: 5_000_000n, locktime: t.t1 })
    expect(legs.maker).toMatchObject({ chain: 'ltc', amount: 500_000_000n, fee: 0n, locktime: t.t2 })
    expect(t.t1 - t.t2).toBe(24 * 3600)
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
  const t = take(offer('ltc', 'bsv'))
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
    const late = at(t.t2 - TAKER_CLAIM_BEFORE_T2_S)
    expect(nextSettleStep(t, facts({ own, peer: leg({ funded: true, buried: true }), now: late }))).toEqual({ kind: 'wait', for: 'locktime', until: at(t.t1) })
    expect(nextSettleStep(t, facts({ own, now: at(t.t1) }))).toEqual({ kind: 'refund' })
    expect(nextSettleStep(t, facts({ own: { ...own, refunded: true }, now: at(t.t1) }))).toEqual({ kind: 'done', outcome: 'refunded' })
  })

  it('a claimed swap is done, unless HandCash left its fee unclaimed past the lock', () => {
    const peer = leg({ funded: true, buried: true, claimed: true })
    expect(nextSettleStep(t, facts({ own: leg({ funded: true }), peer }))).toEqual({ kind: 'done', outcome: 'swapped' })
    expect(nextSettleStep(t, facts({ own: leg({ funded: true, feeUnspent: true }), peer }))).toMatchObject({ kind: 'wait', for: 'locktime' })
    expect(nextSettleStep(t, facts({ own: leg({ funded: true, feeUnspent: true }), peer, now: at(t.t1) }))).toEqual({ kind: 'refund-fee' })
  })

  it('maker: funds only after the taker lock is buried, and not too close to T2', () => {
    const m = (o: Partial<SettleFacts>) => facts({ role: 'maker', secretKnown: false, ownOnBsv: false, ...o })
    expect(nextSettleStep(t, m({}))).toEqual({ kind: 'wait', for: 'peer-funding' })
    expect(nextSettleStep(t, m({ now: now + 2 * 3600_000 }))).toEqual({ kind: 'done', outcome: 'expired' })
    expect(nextSettleStep(t, m({ peer: leg({ funded: true }) }))).toMatchObject({ kind: 'wait', for: 'peer-burial' })
    expect(nextSettleStep(t, m({ peer: leg({ funded: true, buried: true }) }))).toEqual({ kind: 'fund' })
    expect(nextSettleStep(t, m({ peer: leg({ funded: true, buried: true }), now: at(t.t2 - MAKER_FUND_BEFORE_T2_S) }))).toEqual({ kind: 'done', outcome: 'expired' })
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
