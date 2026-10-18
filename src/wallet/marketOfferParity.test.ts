/**
 * The offer script is a cross-repo contract: the wallet writes it, the
 * tm_1sat_market topic manager admits or refuses it. A unit test that only
 * round-trips through our own parser cannot see a divergence, so this decodes
 * the wallet's script with the overlay's verifier itself.
 */
import { LockingScript, PrivateKey, PublicKey, PushDrop } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
// eslint-disable-next-line import/no-relative-parent-imports
import { decodeOfferScript } from '../../../BRC-CLOUD/src/marketOverlayProtocol.js'
import {
  MARKET_FEE_BASIS_POINTS,
  MARKET_FEE_IDENTITY_KEY,
  MARKET_FEE_PAY_TO_ADDRESS,
} from './walletConfig'
import {
  encodeMarketOffer,
  MARKET_OFFER_MAGIC,
  marketOfferSignerKey,
  parseMarketOffer,
  type MarketOfferFields,
} from './marketOverlayProtocol'

const sellerKey = PrivateKey.fromHex('1'.padStart(64, '0'))

function fields(overrides: Partial<MarketOfferFields> = {}): MarketOfferFields {
  const seller = sellerKey.toPublicKey()
  const grossPriceSats = 100_000
  return {
    magic: MARKET_OFFER_MAGIC,
    version: 1,
    itemVout: 0,
    sellerIdentityKey: seller.toString(),
    payTo: seller.toAddress('mainnet'),
    grossPriceSats,
    feeIdentityKey: PublicKey.fromString(MARKET_FEE_IDENTITY_KEY).toString(),
    feePayTo: MARKET_FEE_PAY_TO_ADDRESS,
    feeBasisPoints: MARKET_FEE_BASIS_POINTS,
    exactFeeSats: Math.floor((grossPriceSats * MARKET_FEE_BASIS_POINTS) / 10_000),
    provenanceHash: 'ab'.repeat(32),
    provenanceSize: 321,
    provenanceVersion: 2,
    expiresAt: null,
    nonce: 'cd'.repeat(16),
    depositSats: 1,
    messagebox: 'https://brc-cloud.bcryderman.workers.dev/v1/messagebox',
    ...overrides,
  }
}

/** The overlay always decodes a script from a transaction output, never hex. */
function overlayDecode(hex: string): ReturnType<typeof decodeOfferScript> {
  return decodeOfferScript(LockingScript.fromHex(hex))
}

describe('market offer script parity with tm_1sat_market', () => {
  it('is admitted by the overlay decoder', () => {
    const offer = overlayDecode(encodeMarketOffer(fields(), sellerKey))
    expect(offer.sellerIdentityKey).toBe(sellerKey.toPublicKey().toString())
    expect(offer.priceSats).toBe(100_000)
    expect(offer.feeSats).toBe(Math.floor((100_000 * MARKET_FEE_BASIS_POINTS) / 10_000))
    expect(offer.provenanceHash).toBe('ab'.repeat(32))
    expect(offer.nonce).toBe('cd'.repeat(16))
  })

  it('agrees with the overlay on payout commitments and expiry', () => {
    const expiresAt = Date.now() + 3_600_000
    const offer = overlayDecode(encodeMarketOffer(fields({ expiresAt }), sellerKey))
    expect(offer.expiresAt).toBe(expiresAt)
    expect(offer.sellerPayoutAddress).toBe(sellerKey.toPublicKey().toAddress('mainnet'))
    expect(offer.feePayoutAddress).toBe(MARKET_FEE_PAY_TO_ADDRESS)
  })

  it('round-trips our own parser on the same bytes', () => {
    const value = fields()
    expect(parseMarketOffer(encodeMarketOffer(value, sellerKey))).toEqual(value)
  })
})

describe('market offer v2: every key reachable through BRC-100', () => {
  const listingKey = PrivateKey.fromHex('2'.padStart(64, '0'))
  const payout = PrivateKey.fromHex('3'.padStart(64, '0'))
  const v2 = (overrides: Partial<MarketOfferFields> = {}): MarketOfferFields =>
    fields({
      version: 2,
      listingKey: listingKey.toPublicKey().toString(),
      payTo: payout.toAddress('mainnet'),
      ...overrides,
    })

  it('locks to the listing key and signs as BRC-3, and the overlay admits it', () => {
    const hex = encodeMarketOffer(v2(), sellerKey)
    expect(PushDrop.decode(LockingScript.fromHex(hex), 'before').lockingPublicKey.toString()).toBe(
      listingKey.toPublicKey().toString(),
    )
    const offer = overlayDecode(hex)
    expect(offer.version).toBe(2)
    expect(offer.listingKey).toBe(listingKey.toPublicKey().toString())
    expect(offer.sellerPayoutAddress).toBe(payout.toAddress('mainnet'))
    expect(parseMarketOffer(hex)).toEqual(v2())
  })

  it('verifies under the child BRC-100 createSignature uses, not the identity key', async () => {
    const { ProtoWallet } = await import('@bsv/sdk')
    const viaWallet = await new ProtoWallet(sellerKey).getPublicKey({
      protocolID: [2, '1sat market offer'],
      keyID: '1',
      counterparty: 'anyone',
      forSelf: true,
    })
    expect(marketOfferSignerKey(sellerKey.toPublicKey().toString()).toString()).toBe(viaWallet.publicKey)
  })

  it('refuses identity-address payout and an identity listing key', () => {
    expect(() => encodeMarketOffer(v2({ payTo: sellerKey.toPublicKey().toAddress('mainnet') }), sellerKey)).toThrow(/identity address/)
    expect(() => encodeMarketOffer(v2({ listingKey: sellerKey.toPublicKey().toString() }), sellerKey)).toThrow(/identity key/)
  })
})
