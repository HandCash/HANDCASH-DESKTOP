import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import type { MarketListingAdvert } from './marketListing'
import {
  marketSettlementCommitment,
  validateMarketSettlementOutputs,
} from './marketSettlement'
import { MARKET_FEE_IDENTITY_KEY } from './walletConfig'
import { MARKET_FEE_PAY_TO_ADDRESS } from './walletConfig'

describe('market exact-output settlement', () => {
  it('accepts exact 95/5/item outputs and rejects a tampered fee output', () => {
    const buyer = PrivateKey.fromRandom().toPublicKey()
    const seller = PrivateKey.fromRandom().toPublicKey()
    const tamperedFeeLock = new P2PKH().lock(
      PrivateKey.fromRandom().toPublicKey().toAddress(),
    ).toHex()
    const listing: MarketListingAdvert = {
      outpoint: `${'ab'.repeat(32)}_0`,
      assetType: 'ordinal',
      seller: seller.toString(),
      payTo: seller.toAddress(),
      priceSats: 101,
      feeIdentityKey: MARKET_FEE_IDENTITY_KEY,
      feeBasisPoints: 500,
      origin: `${'cd'.repeat(32)}_0`,
      provenanceHash: 'ef'.repeat(32),
      provenanceSize: 1,
      provenanceVersion: 2,
      listedAt: Date.now(),
      expiresAt: null,
      nonce: '01'.repeat(16),
      signature: '02'.repeat(64),
    }
    const tx = new Transaction()
    tx.addOutput({
      satoshis: 1,
      lockingScript: new P2PKH().lock(buyer.toAddress()),
    })
    tx.addOutput({
      satoshis: 96,
      lockingScript: new P2PKH().lock(seller.toAddress()),
    })
    tx.addOutput({
      satoshis: 5,
      lockingScript: new P2PKH().lock(MARKET_FEE_PAY_TO_ADDRESS),
    })
    const validate = () =>
      validateMarketSettlementOutputs({
        tx,
        listing,
        buyerIdentityKey: buyer.toString(),
        chain: 'main',
        itemOutputIndex: 0,
        sellerOutputIndex: 1,
        feeOutputIndex: 2,
      })
    expect(validate).not.toThrow()
    const committed = marketSettlementCommitment(tx)
    tx.outputs[1]!.satoshis = 95
    expect(marketSettlementCommitment(tx)).not.toBe(committed)
    tx.outputs[1]!.satoshis = 96
    tx.outputs[2]!.lockingScript = new P2PKH().lock(
      PrivateKey.fromRandom().toPublicKey().toAddress(),
    )
    expect(validate).toThrow(/outputs do not match/i)
    expect(tamperedFeeLock).not.toBe(
      new P2PKH().lock(MARKET_FEE_PAY_TO_ADDRESS).toHex(),
    )
  })
})
