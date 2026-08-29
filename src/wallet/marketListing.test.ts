import { PrivateKey, Script } from '@bsv/sdk'
import { createActor } from 'xstate'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { marketListingMachine, mayAbortMarketListing } from '../machines/marketListingMachine'
import {
  assertNoOnesatFtRemittance,
  buildBsv21ListingProof,
  buildMarketHeldRemittance,
  calculateMarketSettlement,
  classifyMarketListingAsset,
  createMarketListingAdvert,
  isMarketListingOrigin,
  MarketListingError,
} from './marketListing'
import { decodeBsv21Binary } from './bsv21Binary'
import { buildBsv21ValueLock } from './bsv21Send'
import { buildColourCustomInstructions } from './colourCoins'
import { buildOnesatFtTransferLockingScript } from './onesatFtInscribe'
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


const listingHarness = vi.hoisted(() => ({
  createAction: vi.fn(async () => {
    throw new Error('stop-after-createAction')
  }),
  listed: null as null | Record<string, unknown>,
  address: '',
  identityKey: '',
}))

vi.mock('./session', () => ({
  getActiveWallet: () => ({
    chain: 'main',
    identityKey: listingHarness.identityKey,
    address: listingHarness.address,
    rootKeyHex: '1'.padStart(64, '0'),
    wallet: {
      listOutputs: async ({ basket }: { basket?: string }) => ({
        outputs: basket === 'bsv21' && listingHarness.listed ? [listingHarness.listed] : [],
      }),
      createAction: listingHarness.createAction,
      abortAction: async () => ({}),
    },
  }),
}))

vi.mock('./beefCache', () => ({
  getBeefForTxidCached: async () => {
    const { Beef } = await import('@bsv/sdk')
    return new Beef()
  },
}))
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


describe('market 162 listing remittance', () => {
  const tokenId = `${'ab'.repeat(32)}_0`
  const tip = `${'cd'.repeat(32)}_3`
  const address = PrivateKey.fromRandom().toAddress()

  it('lists a 162 tip into basket bsv21 with 163 amt/id', () => {
    const lockingScriptHex = buildBsv21ValueLock({
      tokenId,
      amount: 60n,
      address,
    })
    const classified = classifyMarketListingAsset({
      outpoint: tip,
      satoshis: 1,
      lockingScriptHex,
      tags: ['bsv21', `bsv21:${tokenId}`, 'amt:60'],
      customInstructions: JSON.stringify({
        p: 'bsv-20',
        op: 'transfer',
        id: tokenId,
        amt: '60',
      }),
    })
    expect(classified).toMatchObject({
      assetType: 'bsv21',
      tokenId,
      amt: 60,
    })
    const remit = buildMarketHeldRemittance({
      assetType: 'bsv21',
      origin: classified.tokenId!,
      amt: classified.amt,
      extraTags: ['market-held'],
    })
    expect(remit.basket).toBe('bsv21')
    expect(remit.tags).toContain(`bsv21:${tokenId}`)
    expect(remit.tags).toContain('amt:60')
    expect(remit.tags).toContain('market-held')
    const ci = JSON.parse(remit.customInstructions) as {
      p: string
      id: string
      amt: string
    }
    expect(ci.p).toBe('bsv-20')
    expect(ci.id).toBe(tokenId)
    expect(ci.amt).toBe('60')
    expect(remit.customInstructions).not.toMatch(/1sat-ft/)
    expect(() => assertNoOnesatFtRemittance(remit.customInstructions)).not.toThrow()
  })

  it('refuses to create 1sat-ft remittance', () => {
    const leftover = buildColourCustomInstructions({
      origin: tokenId,
      amt: 68862,
    })
    expect(() => assertNoOnesatFtRemittance(leftover)).toThrow(MarketListingError)
    expect(() => assertNoOnesatFtRemittance(leftover)).toThrow(/1sat-ft remittance/i)

    const leftoverScript = buildOnesatFtTransferLockingScript({
      address,
      amt: 68862,
    }).lockingScript
    const classified = classifyMarketListingAsset({
      outpoint: tip,
      satoshis: 1,
      lockingScriptHex: leftoverScript,
      tags: ['1sat-ft'],
      customInstructions: leftover,
    })
    expect(classified.refuse).toBe('1sat-ft')
    expect(classified.assetType).not.toBe('bsv21')
  })

  it('keeps collectable remittance on basket 1sat', () => {
    const remit = buildMarketHeldRemittance({
      assetType: 'ordinal',
      origin: tokenId,
      name: 'Market item',
      extraTags: ['market-held'],
    })
    expect(remit.basket).toBe('1sat')
    expect(remit.tags).toContain('ordinal')
    expect(JSON.parse(remit.customInstructions).p).not.toBe('1sat-ft')
  })
})


describe('162 market list createAction lock', () => {
  const tokenId = `${'ab'.repeat(32)}_0`
  const tip = `${'cd'.repeat(32)}_3`
  const seller = PrivateKey.fromHex('1'.padStart(64, '0'))

  beforeEach(() => {
    listingHarness.createAction.mockClear()
    listingHarness.createAction.mockImplementation(async () => {
      throw new Error('stop-after-createAction')
    })
    listingHarness.listed = null
    listingHarness.address = seller.toAddress()
    listingHarness.identityKey = seller.toPublicKey().toString()
  })

  it('proves a fresh 162 tip from binary + 163 without BRC-150', () => {
    const lockingScriptHex = buildBsv21ValueLock({
      tokenId,
      amount: 60n,
      address: seller.toAddress(),
    })
    const proof = buildBsv21ListingProof({
      outpoint: tip,
      lockingScriptHex,
      customInstructions: JSON.stringify({
        p: 'bsv-20',
        op: 'transfer',
        id: tokenId,
        amt: '60',
      }),
    })
    expect(proof).toMatchObject({
      v: 176,
      tokenId,
      amt: '60',
      role: 'value',
      tip,
    })
  })

  it('createAction held lock for a 162 list is 162, not P2PKH', async () => {
    const lockingScriptHex = buildBsv21ValueLock({
      tokenId,
      amount: 60n,
      address: seller.toAddress(),
    })
    listingHarness.listed = {
      outpoint: tip.replace('_', '.'),
      satoshis: 1,
      lockingScript: lockingScriptHex,
      tags: ['bsv21', `bsv21:${tokenId}`, 'amt:60'],
      customInstructions: JSON.stringify({
        p: 'bsv-20',
        op: 'transfer',
        id: tokenId,
        amt: '60',
      }),
    }
    await expect(
      createMarketListingAdvert({ outpoint: tip, priceSats: 100 }),
    ).rejects.toThrow(/stop-after-createAction/)
    expect(listingHarness.createAction).toHaveBeenCalledTimes(1)
    const args = listingHarness.createAction.mock.calls[0]![0] as {
      outputs: Array<{
        lockingScript: string
        basket?: string
        customInstructions?: string
      }>
    }
    const held = args.outputs[0]!
    const decoded = decodeBsv21Binary(held.lockingScript)
    expect(decoded).toMatchObject({ role: 'value', tokenId, amount: 60n })
    expect(held.lockingScript.startsWith('76a914')).toBe(false)
    expect(held.basket).toBe('bsv21')
    const ci = JSON.parse(held.customInstructions ?? '{}') as {
      p: string
      id: string
      amt: string
    }
    expect(ci.p).toBe('bsv-20')
    expect(ci.id).toBe(tokenId)
    expect(ci.amt).toBe('60')
  })

  it('does not treat remittance-only 1-sat as a 162 listable tip', () => {
    const classified = classifyMarketListingAsset({
      outpoint: tip,
      satoshis: 1,
      lockingScriptHex: `76a914${'11'.repeat(20)}88ac`,
      tags: ['bsv21', `bsv21:${tokenId}`, 'amt:60'],
      customInstructions: JSON.stringify({
        p: 'bsv-20',
        op: 'transfer',
        id: tokenId,
        amt: '60',
      }),
    })
    expect(classified.assetType).not.toBe('bsv21')
  })
})
