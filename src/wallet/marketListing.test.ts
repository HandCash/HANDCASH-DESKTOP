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
    const first = encodeMarketOffer(fields)
    expect(first).toBe(
      '11315341542d4d41524b45542d4f46464552013101304230323739626536363765663964636262616335356130363239356365383730623037303239626663646232646365323864393539663238313562313666383137393822314267475a3974634e34726d394b427a446e374b7072517a3837535a323653414d4803313031423032633630343766393434316564376436643330343534303665393563303763643835633737386534623863656633636137616261633039623935633730396565352131634d68323238485443697753385a7361616b48384138777a65314a52355a735003353030013540616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261620333323101320d3139303030303030303030303020636463646364636463646364636463646364636463646364636463646364636401312468747470733a2f2f73656c6c65722e6578616d706c652f76312f6d657373616765626f78757575757575757575757575757575757576a914751e76e8199196d454941c45d1b3a323f1433bd688ac',
    )
    expect(encodeMarketOffer(fields)).toBe(first)
    expect(parseMarketOffer(first)).toEqual(fields)
    expect(Script.fromHex(first).chunks).toHaveLength(39)
  })

  it('rejects token field, cleanup, fee, and canonical encoding tampering', () => {
    const fields = fixture()
    expect(() =>
      encodeMarketOffer({ ...fields, exactFeeSats: 6 }),
    ).toThrow(/exact fee/i)
    const script = Script.fromHex(encodeMarketOffer(fields))
    script.setChunkOpCode(17, 0x76)
    expect(() => parseMarketOffer(script.toHex())).toThrow()
    const canonical = encodeMarketOffer(fields)
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
