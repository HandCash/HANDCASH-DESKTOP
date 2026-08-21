import { PrivateKey, Script } from '@bsv/sdk'
import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { marketListingMachine, mayAbortMarketListing } from '../machines/marketListingMachine'
import {
  calculateMarketSettlement,
  isMarketListingOrigin,
} from './marketListing'
import {
  chooseMarketCancelPath,
  chooseMarketListingPath,
} from './marketListingPath'
import {
  encodeMarketOffer,
  MARKET_OFFER_MAGIC,
  parseMarketOffer,
  type MarketOfferFields,
} from './marketOverlayProtocol'

function fixture(): MarketOfferFields {
  const seller = PrivateKey.fromHex('1'.padStart(64, '0')).toPublicKey()
  const fee = PrivateKey.fromHex('2'.padStart(64, '0')).toPublicKey()
  return {
    magic: MARKET_OFFER_MAGIC,
    version: 1,
    itemVout: 0,
    sellerIdentityKey: seller.toString(),
    payTo: seller.toAddress('mainnet'),
    grossPriceSats: 101,
    feeIdentityKey: fee.toString(),
    feePayTo: fee.toAddress('mainnet'),
    feeBasisPoints: 500,
    exactFeeSats: 5,
    provenanceHash: 'ab'.repeat(32),
    provenanceSize: 321,
    provenanceVersion: 2,
    expiresAt: 1_900_000_000_000,
    nonce: 'cd'.repeat(16),
    depositSats: 1,
    messagebox: 'https://seller.example/v1/messagebox',
  }
}

describe('BRC-48 one-sat market offer', () => {
  it('has an exact deterministic PushDrop vector and round-trips every field', () => {
    const fields = fixture()
    const sellerKey = PrivateKey.fromHex('1'.padStart(64, '0'))
    const first = encodeMarketOffer(fields, sellerKey)
    expect(encodeMarketOffer(fields, sellerKey)).toBe(first)
    expect(parseMarketOffer(first)).toEqual(fields)
    expect(Script.fromHex(first).chunks).toHaveLength(32)
  })

  it('rejects token field, cleanup, fee, and canonical encoding tampering', () => {
    const fields = fixture()
    const sellerKey = PrivateKey.fromHex('1'.padStart(64, '0'))
    expect(() =>
      encodeMarketOffer({ ...fields, exactFeeSats: 6 }, sellerKey),
    ).toThrow(/exact fee/i)
    const script = Script.fromHex(encodeMarketOffer(fields, sellerKey))
    script.setChunkOpCode(31, 0x76)
    expect(() => parseMarketOffer(script.toHex())).toThrow()
    const canonical = encodeMarketOffer(fields, sellerKey)
    const magicHex = Buffer.from(MARKET_OFFER_MAGIC).toString('hex')
    const tampered = canonical.replace(
      magicHex,
      `${'00'.repeat(MARKET_OFFER_MAGIC.length - 1)}01`,
    )
    expect(() => parseMarketOffer(tampered)).toThrow(/protocol/i)
  })

  it('classifies list and cancel paths without fallback', () => {
    expect(
      chooseMarketListingPath({
        itemOutpoint: `${'ab'.repeat(32)}_0`,
        satoshis: 1,
        ordinal: true,
        provenanceProven: true,
        termsValid: true,
      }),
    ).toMatchObject({ path: 'createOffer' })
    expect(
      chooseMarketListingPath({
        itemOutpoint: 'x',
        satoshis: 1,
        ordinal: false,
        provenanceProven: true,
        termsValid: true,
      }),
    ).toEqual({ path: 'refuse', reason: 'not-ordinal' })
    expect(
      chooseMarketCancelPath({
        offerOutpoint: 'offer',
        held: false,
        valid: true,
        active: true,
      }),
    ).toEqual({ path: 'refuse', reason: 'offer-not-held' })
  })

  it('allows abort only before signing and routes unknown signing to recovery', () => {
    const actor = createActor(marketListingMachine).start()
    actor.send({
      type: 'LIST',
      path: { path: 'createOffer', itemOutpoint: 'item' },
    })
    actor.send({ type: 'STAGED', reference: 'ref' })
    expect(mayAbortMarketListing(actor.getSnapshot())).toBe(true)
    actor.send({ type: 'SIGNED_UNKNOWN' })
    expect(mayAbortMarketListing(actor.getSnapshot())).toBe(false)
    actor.send({ type: 'FAIL', error: 'lost receipt' })
    expect(actor.getSnapshot().matches('recovery')).toBe(true)
  })

  it('refunds the one-sat offer deposit to seller and pins market origins', () => {
    expect(calculateMarketSettlement(101)).toEqual({
      priceSats: 101,
      sellerSats: 97,
      feeSats: 5,
    })
    expect(isMarketListingOrigin('brc-cloud.bcryderman.workers.dev')).toBe(true)
    expect(isMarketListingOrigin('evil.workers.dev')).toBe(false)
  })
})
