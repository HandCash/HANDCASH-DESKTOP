import { describe, expect, it, vi } from 'vitest'
import { createActor } from 'xstate'
import { LockingScript, P2PKH, PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk'
import { buildBsv21ValueLock } from './token'
import {
  chooseDirectOfferBuyPath,
  chooseDirectOfferCancelPath,
  chooseDirectOfferCollectPath,
  chooseDirectOfferListPath,
  DIRECT_OFFER_LEGACY_BASKET,
  DIRECT_OFFER_PROTOCOL,
  DIRECT_OFFER_VERSION,
  parseDirectOffer,
  type DirectOffer,
} from './directOfferPath'
import { sellerUnlockValid, unlockSighashByte } from './offerSeal'
import { SELLER_SIGHASH_BYTE, type OfferWant } from './offerTerms'
import { mayAbortOffer, offerMachine } from '../machines/offerMachine'

const durable = new Map<string, string>()

vi.mock('./session', () => ({
  getActiveWallet: () => null,
  bumpBalanceAfterHeal: () => {},
}))
vi.mock('./accountLocalKeys', () => ({ accountLocalKey: (key: string) => `acct:${key}` }))
vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => durable.get(key) ?? null,
  durableSetItem: (key: string, value: string) => void durable.set(key, value),
}))

const { signDirectOfferLot, directOfferPriceOutput, listDirectOffers } = await import('./directOffer')

const giveTokenId = `${'ab'.repeat(32)}_0`
const wantTokenId = `${'cd'.repeat(32)}_1`
const seller = PrivateKey.fromRandom()
const sellerAddress = seller.toAddress()
const buyer = PrivateKey.fromRandom()

function listingTx(amount = 40n): Transaction {
  const tx = new Transaction()
  tx.addInput({
    sourceTXID: 'ee'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript(),
    sequence: 0xffffffff,
  })
  tx.addOutput({
    satoshis: 1,
    lockingScript: LockingScript.fromHex(
      buildBsv21ValueLock({ layout: 'brc162', tokenId: giveTokenId, amount, address: sellerAddress }),
    ),
  })
  return tx
}

/** The buyer's transaction: lot at input 0, price at output 0, then anything. */
function purchaseTx(lotTx: Transaction, price: { lockingScript: string; satoshis: number }, extras = true) {
  const tx = new Transaction()
  tx.addInput({
    sourceTXID: String(lotTx.id('hex')),
    sourceOutputIndex: 0,
    sourceTransaction: lotTx,
    sequence: 0xffffffff,
  })
  if (extras) {
    tx.addInput({
      sourceTXID: 'ff'.repeat(32),
      sourceOutputIndex: 2,
      unlockingScript: new UnlockingScript(),
      sequence: 0xffffffff,
    })
  }
  tx.addOutput({ satoshis: price.satoshis, lockingScript: LockingScript.fromHex(price.lockingScript) })
  tx.addOutput({
    satoshis: 1,
    lockingScript: LockingScript.fromHex(
      buildBsv21ValueLock({ layout: 'brc162', tokenId: giveTokenId, amount: 40n, address: buyer.toAddress() }),
    ),
  })
  if (extras) tx.addOutput({ satoshis: 900, lockingScript: new P2PKH().lock(buyer.toAddress()) })
  return tx
}

async function signed(want: OfferWant) {
  const lotTx = listingTx()
  const sellerUnlockingScript = await signDirectOfferLot({
    listingTx: lotTx,
    lotVout: 0,
    want,
    payTo: sellerAddress,
    privateKey: seller,
  })
  return { lotTx, sellerUnlockingScript }
}

function valid(tx: Transaction, lotTx: Transaction, unlockingScript: string): boolean {
  return sellerUnlockValid({
    tx,
    vin: 0,
    sourceSatoshis: 1,
    lockingScript: lotTx.outputs[0]!.lockingScript.toHex(),
    unlockingScript,
  })
}

function offerFixture(overrides: Partial<DirectOffer> = {}): DirectOffer {
  return {
    protocol: DIRECT_OFFER_PROTOCOL,
    v: DIRECT_OFFER_VERSION,
    offerId: `${'aa'.repeat(32)}.0`,
    seller: seller.toPublicKey().toString(),
    payTo: sellerAddress,
    give: { tokenId: giveTokenId, amount: '40', dec: 0, lockingScript: 'ab' },
    want: { kind: 'sats', sats: 5_000 },
    sellerUnlockingScript: '47' + '30'.padEnd(140, '0') + 'c3' + '21' + '02'.padEnd(66, '0'),
    beefB64: 'AA==',
    createdAt: 1,
    ...overrides,
  }
}

describe('direct offer seller signature', () => {
  it('signs SINGLE|ANYONECANPAY', async () => {
    const { sellerUnlockingScript } = await signed({ kind: 'sats', sats: 5_000 })
    expect(unlockSighashByte(sellerUnlockingScript)).toBe(SELLER_SIGHASH_BYTE)
  })

  it('unlocks a purchase that pays output 0 exactly, whatever else the buyer adds', async () => {
    const want: OfferWant = { kind: 'sats', sats: 5_000 }
    const { lotTx, sellerUnlockingScript } = await signed(want)
    const out = directOfferPriceOutput({ want, payTo: sellerAddress })
    expect(valid(purchaseTx(lotTx, out), lotTx, sellerUnlockingScript)).toBe(true)
    expect(valid(purchaseTx(lotTx, out, false), lotTx, sellerUnlockingScript)).toBe(true)
  })

  it('refuses a purchase that underpays or redirects output 0', async () => {
    const want: OfferWant = { kind: 'sats', sats: 5_000 }
    const { lotTx, sellerUnlockingScript } = await signed(want)
    const out = directOfferPriceOutput({ want, payTo: sellerAddress })
    expect(valid(purchaseTx(lotTx, { ...out, satoshis: 4_999 }), lotTx, sellerUnlockingScript)).toBe(false)
    const thief = directOfferPriceOutput({ want, payTo: buyer.toAddress() })
    expect(valid(purchaseTx(lotTx, thief), lotTx, sellerUnlockingScript)).toBe(false)
  })

  it('binds a token price to the exact id, amount and seller address', async () => {
    const want: OfferWant = { kind: 'token', tokenId: wantTokenId, amount: '7', layout: 'brc162' }
    const { lotTx, sellerUnlockingScript } = await signed(want)
    const out = directOfferPriceOutput({ want, payTo: sellerAddress })
    expect(valid(purchaseTx(lotTx, out), lotTx, sellerUnlockingScript)).toBe(true)
    const short = directOfferPriceOutput({ want: { ...want, amount: '6' }, payTo: sellerAddress })
    expect(valid(purchaseTx(lotTx, short), lotTx, sellerUnlockingScript)).toBe(false)
    const otherId = directOfferPriceOutput({
      want: { ...want, tokenId: `${'ef'.repeat(32)}_0` },
      payTo: sellerAddress,
    })
    expect(valid(purchaseTx(lotTx, otherId), lotTx, sellerUnlockingScript)).toBe(false)
  })

  it('does not unlock a different lot', async () => {
    const want: OfferWant = { kind: 'sats', sats: 5_000 }
    const { lotTx, sellerUnlockingScript } = await signed(want)
    const otherLot = listingTx(41n)
    const out = directOfferPriceOutput({ want, payTo: sellerAddress })
    expect(valid(purchaseTx(otherLot, out), otherLot, sellerUnlockingScript)).toBe(false)
    expect(valid(purchaseTx(lotTx, out), lotTx, sellerUnlockingScript)).toBe(true)
  })
})

describe('direct offer paths', () => {
  it('names every list refusal', () => {
    const want = { kind: 'sats', sats: 10 }
    expect(chooseDirectOfferListPath({ tokenId: 'x', amount: 1, want, cosigned: false })).toMatchObject({
      path: 'refuse',
      reason: 'invalid-offer',
    })
    expect(chooseDirectOfferListPath({ tokenId: giveTokenId, amount: 0, want, cosigned: false })).toMatchObject({
      reason: 'bad-amount',
    })
    expect(
      chooseDirectOfferListPath({
        tokenId: giveTokenId,
        amount: 5,
        want: { kind: 'token', tokenId: giveTokenId, amount: '1' },
        cosigned: false,
      }),
    ).toMatchObject({ reason: 'same-token' })
    expect(chooseDirectOfferListPath({ tokenId: giveTokenId, amount: 5, want, cosigned: true })).toMatchObject({
      reason: 'cosigned-token',
    })
    expect(
      chooseDirectOfferListPath({ tokenId: giveTokenId, amount: 5, want, cosigned: false, countersignedWant: true }),
    ).toMatchObject({ path: 'refuse', reason: 'countersigned-want' })
    expect(
      chooseDirectOfferListPath({ tokenId: giveTokenId, amount: 5, want, cosigned: false, countersignedGive: true }),
    ).toMatchObject({ path: 'list', lot: 'countersigned', amount: 5n })
    expect(chooseDirectOfferListPath({ tokenId: giveTokenId, amount: 5, want, cosigned: false })).toMatchObject({
      path: 'list',
      lot: 'brc162',
      amount: 5n,
      want: { kind: 'sats', sats: 10 },
    })
  })

  it('buys only a parsed offer with a bound signature, and knows a self-purchase', () => {
    const offer = offerFixture()
    expect(parseDirectOffer(offer)?.offerId).toBe(offer.offerId)
    expect(chooseDirectOfferBuyPath({ offer: { ...offer, v: 0 }, buyerIdentityKey: 'x' })).toMatchObject({
      reason: 'invalid-offer',
    })
    expect(
      chooseDirectOfferBuyPath({
        offer: { ...offer, sellerUnlockingScript: offer.sellerUnlockingScript.replace('c321', '4121') },
        buyerIdentityKey: 'x',
      }),
    ).toMatchObject({ reason: 'unbound-signature' })
    expect(chooseDirectOfferBuyPath({ offer, buyerIdentityKey: buyer.toPublicKey().toString() })).toMatchObject({
      path: 'buy',
      settle: 'peerCollect',
    })
    expect(chooseDirectOfferBuyPath({ offer, buyerIdentityKey: offer.seller.toUpperCase() })).toMatchObject({
      settle: 'selfCollect',
    })
  })

  it('collects and cancels only as the seller, from the right state', () => {
    const offer = offerFixture()
    const me = offer.seller
    const txid = 'bb'.repeat(32)
    expect(chooseDirectOfferCollectPath({ offer, state: 'sold', sellerIdentityKey: 'x', txid })).toMatchObject({
      reason: 'not-seller',
    })
    expect(chooseDirectOfferCollectPath({ offer, state: 'listed', sellerIdentityKey: me, txid: '' })).toMatchObject({
      reason: 'offer-not-sold',
    })
    expect(chooseDirectOfferCollectPath({ offer, state: 'collected', sellerIdentityKey: me, txid })).toMatchObject({
      reason: 'offer-not-listed',
    })
    expect(chooseDirectOfferCollectPath({ offer, state: 'sold', sellerIdentityKey: me, txid })).toMatchObject({
      path: 'collect',
      proceeds: 'sats',
    })
    expect(
      chooseDirectOfferCancelPath({ offer, state: 'listed', sellerIdentityKey: me, spent: 'spent' }),
    ).toMatchObject({ reason: 'offer-already-sold' })
    expect(
      chooseDirectOfferCancelPath({ offer, state: 'sold', sellerIdentityKey: me, spent: null }),
    ).toMatchObject({ reason: 'offer-not-listed' })
    expect(
      chooseDirectOfferCancelPath({ offer, state: 'listed', sellerIdentityKey: me, spent: 'unknown' }),
    ).toMatchObject({ path: 'cancel' })
  })
})

describe('direct offer records', () => {
  it('reads a 1.3.573 token-swap record once, keeping its lot in the old basket', () => {
    durable.clear()
    const offer = offerFixture()
    durable.set(
      'acct:handcash.tokenSwap.offers.v1',
      JSON.stringify([
        {
          offer: {
            ...offer,
            protocol: 'handcash-token-swap',
            seller: undefined,
            sellerUnlockingScript: undefined,
            maker: offer.seller,
            makerUnlockingScript: offer.sellerUnlockingScript,
          },
          role: 'maker',
          state: 'open',
          updatedAt: 5,
        },
        { offer: { protocol: 'nonsense' }, role: 'maker', state: 'open', updatedAt: 6 },
      ]),
    )
    const [record, ...rest] = listDirectOffers().offers
    expect(rest).toEqual([])
    expect(record).toMatchObject({
      role: 'seller',
      state: 'listed',
      basket: DIRECT_OFFER_LEGACY_BASKET,
      offer: { protocol: DIRECT_OFFER_PROTOCOL, seller: offer.seller, offerId: offer.offerId },
    })
    expect(JSON.parse(durable.get('acct:handcash.market.directOffers.v1')!)).toHaveLength(1)
    durable.delete('acct:handcash.tokenSwap.offers.v1')
    expect(listDirectOffers().offers).toHaveLength(1)
  })
})

describe('offerMachine on the direct venue', () => {
  it('fails a refused path without staging', () => {
    const actor = createActor(offerMachine).start()
    actor.send({
      type: 'LIST',
      venue: 'direct',
      path: { path: 'refuse', reason: 'same-token', message: 'x' },
    })
    expect(actor.getSnapshot().value).toBe('failed')
    expect(actor.getSnapshot().context).toMatchObject({ venue: 'direct', error: 'same-token' })
  })

  it('collects without staging a transaction', () => {
    const actor = createActor(offerMachine).start()
    actor.send({
      type: 'COLLECT',
      venue: 'direct',
      path: { path: 'collect', proceeds: 'token', offerId: 'a.0', txid: 'b'.repeat(64) },
    })
    expect(actor.getSnapshot().value).toBe('collecting')
    actor.send({ type: 'COLLECTED' })
    expect(actor.getSnapshot().value).toBe('committed')
  })

  it('stops allowing abort once the cheque is broadcast', () => {
    const actor = createActor(offerMachine).start()
    actor.send({
      type: 'BUY',
      venue: 'direct',
      path: { path: 'buy', settle: 'peerCollect', offer: offerFixture() },
    })
    actor.send({ type: 'STAGED', reference: 'r' })
    expect(mayAbortOffer(actor.getSnapshot())).toBe(true)
    actor.send({ type: 'SIGNED_UNKNOWN' })
    expect(mayAbortOffer(actor.getSnapshot())).toBe(true)
    actor.send({ type: 'BROADCASTED', txid: 'c'.repeat(64) })
    expect(mayAbortOffer(actor.getSnapshot())).toBe(false)
    actor.send({ type: 'COMMITTED' })
    expect(actor.getSnapshot().value).toBe('committed')
  })
})
