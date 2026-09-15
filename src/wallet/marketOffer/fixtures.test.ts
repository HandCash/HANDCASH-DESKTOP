import { PrivateKey, PublicKey } from '@bsv/sdk'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  MARKET_FEE_BASIS_POINTS,
  MARKET_FEE_IDENTITY_KEY,
} from '../walletConfig'
import {
  encodeMarketOffer,
  MARKET_OFFER_MAGIC,
  marketOfferUsesMinimalPushes,
  parseMarketOffer,
} from './index'
import type { MarketOfferFields } from '../marketOverlayProtocol'

const fixture = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures/canonical.json'),
    'utf8',
  ),
) as {
  sellerPrivHex: string
  grossPriceSats: number
  feeBasisPoints: number
  feePayTo: string
  provenanceHash: string
  provenanceSize: number
  nonce: string
  messagebox: string
}

const sellerKey = PrivateKey.fromHex(fixture.sellerPrivHex)

function fields(): MarketOfferFields {
  const seller = sellerKey.toPublicKey()
  return {
    magic: MARKET_OFFER_MAGIC,
    version: 1,
    itemVout: 0,
    sellerIdentityKey: seller.toString(),
    payTo: seller.toAddress('mainnet'),
    grossPriceSats: fixture.grossPriceSats,
    feeIdentityKey: PublicKey.fromString(MARKET_FEE_IDENTITY_KEY).toString(),
    feePayTo: fixture.feePayTo,
    feeBasisPoints: fixture.feeBasisPoints,
    exactFeeSats: Math.floor((fixture.grossPriceSats * MARKET_FEE_BASIS_POINTS) / 10_000),
    provenanceHash: fixture.provenanceHash,
    provenanceSize: fixture.provenanceSize,
    provenanceVersion: 2,
    expiresAt: null,
    nonce: fixture.nonce,
    depositSats: 1,
    messagebox: fixture.messagebox,
  }
}

describe('marketOffer fixtures', () => {
  it('encodes canonical MINIMALDATA accepted by the wire parser', () => {
    const hex = encodeMarketOffer(fields(), sellerKey)
    expect(marketOfferUsesMinimalPushes(hex)).toBe(true)
    const offer = parseMarketOffer(hex)
    expect(offer?.grossPriceSats).toBe(fixture.grossPriceSats)
    expect(offer?.nonce).toBe(fixture.nonce)
  })

  it('rejects a non-minimal version push after 1SAT-MARKET', () => {
    const magic = Buffer.from(MARKET_OFFER_MAGIC, 'utf8').toString('hex')
    const nonMinimal = `${magic}0101`
    expect(marketOfferUsesMinimalPushes(nonMinimal)).toBe(false)
  })
})
