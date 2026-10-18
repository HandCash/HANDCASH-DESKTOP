import {
  Beef,
  LockingScript,
  P2PKH,
  PrivateKey,
  PublicKey,
  Transaction,
  UnlockingScript,
} from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  accountLocalKey,
  bindAccountLocalKeyScope,
} from './accountLocalKeys'
import { durableRemoveItem, durableSetItem } from './durableStorage'
import type { MarketListingAdvert } from './marketListing'
import {
  listingHasBuyerCompletableSettlement,
  marketSettlementCommitment,
  mergePendingPurchase,
  overlayListingBeefBinary,
  protectedMarketActionReferences,
  rebindMarketSettlementForAccount,
  hydrateMarketListingForPurchase,
  validateMarketSettlementOutputs,
} from './marketSettlement'
import {
  encodeMarketOffer,
  MARKET_OFFER_MAGIC,
  type MarketOfferFields,
} from './marketOverlayProtocol'
import { marketSettlementShape } from './marketSettlementLayout'
import {
  MARKET_FEE_BASIS_POINTS,
  MARKET_FEE_IDENTITY_KEY,
  MARKET_FEE_PAY_TO_ADDRESS,
} from './walletConfig'
import { decodeBsv21Binary } from './token'
import { buildBsv21ValueLock } from './token'

const TOKEN_ID = `${'ab'.repeat(32)}_0`

function fixture(assetType: 'ordinal' | 'bsv21' = 'ordinal', walletAddress?: string) {
  const shape = marketSettlementShape(assetType)
  const sellerKey = PrivateKey.fromHex('1'.padStart(64, '0'))
  const seller = sellerKey.toPublicKey()
  const fee = PublicKey.fromString(MARKET_FEE_IDENTITY_KEY)
  const buyer = PrivateKey.fromHex('3'.padStart(64, '0')).toPublicKey()
  const buyerAddress = walletAddress ?? buyer.toAddress('mainnet')
  const fields: MarketOfferFields = {
    magic: MARKET_OFFER_MAGIC,
    version: 1,
    itemVout: 0,
    sellerIdentityKey: seller.toString(),
    payTo: seller.toAddress(),
    grossPriceSats: 101,
    feeIdentityKey: fee.toString(),
    feePayTo: MARKET_FEE_PAY_TO_ADDRESS,
    feeBasisPoints: MARKET_FEE_BASIS_POINTS,
    exactFeeSats: Math.floor((101 * MARKET_FEE_BASIS_POINTS) / 10_000),
    provenanceHash: 'ef'.repeat(32),
    provenanceSize: 123,
    provenanceVersion: 2,
    expiresAt: Date.now() + 60_000,
    nonce: '01'.repeat(16),
    depositSats: 1,
    messagebox: 'https://seller.example/v1/messagebox',
  }
  const offerLockingScript = encodeMarketOffer(fields, sellerKey)
  const listingTx = new Transaction()
  listingTx.addOutput({
    satoshis: 1,
    lockingScript:
      assetType === 'bsv21'
        ? LockingScript.fromHex(
            buildBsv21ValueLock({ layout: 'brc162', tokenId: TOKEN_ID, amount: 60n, address: seller.toAddress() }),
          )
        : new P2PKH().lock(seller.toAddress()),
  })
  listingTx.addOutput({
    satoshis: 1,
    lockingScript: LockingScript.fromHex(offerLockingScript),
  })
  const padTx = new Transaction()
  padTx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(buyerAddress) })
  padTx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(buyerAddress) })
  const fundingTx = new Transaction()
  fundingTx.addOutput({
    satoshis: 111,
    lockingScript: new P2PKH().lock(buyerAddress),
  })
  const tx = new Transaction()
  const sources: Array<[Transaction, number]> = []
  shape.padVins.forEach((vin, i) => (sources[vin] = [padTx, i]))
  sources[shape.itemVin] = [listingTx, 0]
  sources[shape.offerVin] = [listingTx, 1]
  sources.push([fundingTx, 0])
  for (const [sourceTransaction, sourceOutputIndex] of sources) {
    tx.addInput({ sourceTransaction, sourceOutputIndex, unlockingScript: new UnlockingScript() })
  }
  const buyerItemLock =
    assetType === 'bsv21'
      ? LockingScript.fromHex(
          buildBsv21ValueLock({ layout: 'brc162', tokenId: TOKEN_ID, amount: 60n, address: buyerAddress }),
        )
      : new P2PKH().lock(buyerAddress)
  const outputs: Array<{ satoshis: number; lockingScript: LockingScript }> = []
  if (shape.padReturnOutputIndex != null) {
    outputs[shape.padReturnOutputIndex] = { satoshis: 2, lockingScript: new P2PKH().lock(buyerAddress) }
  }
  outputs[shape.buyerOutputIndex] = { satoshis: 1, lockingScript: buyerItemLock }
  outputs[shape.sellerOutputIndex] = { satoshis: 97, lockingScript: new P2PKH().lock(seller.toAddress()) }
  outputs[shape.feeOutputIndex] = {
    satoshis: fields.exactFeeSats,
    lockingScript: new P2PKH().lock(MARKET_FEE_PAY_TO_ADDRESS),
  }
  outputs.push({ satoshis: 9, lockingScript: new P2PKH().lock(buyerAddress) })
  for (const output of outputs) tx.addOutput(output)
  const beef = new Beef()
  beef.mergeTransaction(listingTx)
  beef.mergeTransaction(padTx)
  beef.mergeTransaction(fundingTx)
  beef.mergeTransaction(tx)
  const listing: MarketListingAdvert = {
    outpoint: `${listingTx.id('hex')}_0`,
    offerOutpoint: `${listingTx.id('hex')}_1`,
    offerLockingScript,
    assetType,
    ...(assetType === 'bsv21' ? { amt: 60 } : {}),
    seller: fields.sellerIdentityKey,
    payTo: fields.payTo,
    priceSats: fields.grossPriceSats,
    feeIdentityKey: fields.feeIdentityKey,
    feePayTo: fields.feePayTo,
    feeBasisPoints: fields.feeBasisPoints,
    exactFeeSats: fields.exactFeeSats,
    depositSats: 1,
    messagebox: fields.messagebox,
    origin: assetType === 'bsv21' ? TOKEN_ID : `${'cd'.repeat(32)}_0`,
    provenanceHash: fields.provenanceHash,
    provenanceSize: fields.provenanceSize,
    provenanceVersion: 2,
    listedAt: Date.now(),
    expiresAt: fields.expiresAt,
    nonce: fields.nonce,
  }
  const padLock = new P2PKH().lock(buyerAddress).toHex()
  const validate = (opts?: { buyerAddress?: string; sellerView?: boolean }) =>
    validateMarketSettlementOutputs({
      tx,
      beef,
      listing,
      buyerIdentityKey: buyer.toString(),
      buyerAddress: opts?.buyerAddress ?? buyerAddress,
      chain: 'main',
      shape,
      ...(shape.padReturnOutputIndex != null && !opts?.sellerView
        ? { buyerPads: { inputLocks: shape.padVins.map(() => padLock), returnLock: padLock } }
        : {}),
    })
  return { tx, listing, validate: () => validate(), validateAs: validate, buyer, seller, fee, shape }
}

describe('market exact settlement contract', () => {
  it.each(['ordinal', 'bsv21'] as const)(
    'accepts the %s layout with exact seller, fee, and buyer-only change',
    (assetType) => {
      const { tx, validate } = fixture(assetType)
      expect(validate).not.toThrow()
      expect(marketSettlementCommitment(tx)).toHaveLength(64)
    },
  )

  it.each([
    ['ordinal', 'buyer item', 'buyerOutputIndex', 2],
    ['ordinal', 'seller proceeds/deposit', 'sellerOutputIndex', 96],
    ['ordinal', 'exact fee', 'feeOutputIndex', 4],
    ['bsv21', 'buyer item', 'buyerOutputIndex', 2],
    ['bsv21', 'seller proceeds/deposit', 'sellerOutputIndex', 96],
    ['bsv21', 'exact fee', 'feeOutputIndex', 4],
  ] as const)('%s: rejects %s amount tampering', (assetType, _name, slot, sats) => {
    const { tx, validate, shape } = fixture(assetType)
    tx.outputs[shape[slot]]!.satoshis = sats
    expect(validate).toThrow(/outputs do not match/i)
  })

  it('rejects an ordinal pad return that would shift the item satoshi', () => {
    const { tx, validate, shape } = fixture('ordinal')
    tx.outputs[shape.padReturnOutputIndex!]!.satoshis = 1
    expect(validate).toThrow(/pad return/i)
  })

  it('rejects ordinal pads the buyer does not own', () => {
    const { tx, validate, shape } = fixture('ordinal')
    const stranger = new Transaction()
    stranger.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()) })
    tx.inputs[shape.padVins[0]!]!.sourceTransaction = stranger
    tx.inputs[shape.padVins[0]!]!.sourceTXID = stranger.id('hex') as string
    tx.inputs[shape.padVins[0]!]!.sourceOutputIndex = 0
    expect(validate).toThrow(/pad inputs/i)
  })

  it('a seller, who cannot derive the buyer pad children, accepts any P2PKH pad but nothing else', () => {
    const { tx, validateAs, shape } = fixture('ordinal')
    const child = new Transaction()
    child.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()) })
    child.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('006a') })
    const pad = tx.inputs[shape.padVins[0]!]!
    pad.sourceTransaction = child
    pad.sourceTXID = child.id('hex') as string
    pad.sourceOutputIndex = 0
    expect(() => validateAs({ sellerView: true })).not.toThrow()
    pad.sourceOutputIndex = 1
    expect(() => validateAs({ sellerView: true })).toThrow(/pad inputs/i)
  })

  it('accepts private wallet-derived buyer BSV change', () => {
    const derivedChange = fixture()
    derivedChange.tx.outputs[derivedChange.shape.firstChangeIndex]!.lockingScript = new P2PKH().lock(
      PrivateKey.fromRandom().toPublicKey().toAddress(),
    )
    expect(derivedChange.validate).not.toThrow()
  })

  it('rejects duplicate seller inputs and swapped item/offer', () => {
    const duplicate = fixture()
    const funding = duplicate.tx.inputs.length - 1
    duplicate.tx.inputs[funding]!.sourceTransaction =
      duplicate.tx.inputs[duplicate.shape.itemVin]!.sourceTransaction
    duplicate.tx.inputs[funding]!.sourceTXID =
      duplicate.tx.inputs[duplicate.shape.itemVin]!.sourceTransaction!.id('hex') as string
    duplicate.tx.inputs[funding]!.sourceOutputIndex = 0
    expect(duplicate.validate).toThrow(/duplicate/i)

    for (const assetType of ['ordinal', 'bsv21'] as const) {
      const swapped = fixture(assetType)
      const { itemVin, offerVin } = swapped.shape
      ;[swapped.tx.inputs[itemVin], swapped.tx.inputs[offerVin]] = [
        swapped.tx.inputs[offerVin]!,
        swapped.tx.inputs[itemVin]!,
      ]
      expect(swapped.validate).toThrow(/ordering/i)
    }
  })

  it('refuses a layout that does not match the listed asset', () => {
    const { tx, listing, buyer } = fixture('ordinal')
    expect(() =>
      validateMarketSettlementOutputs({
        tx,
        beef: new Beef().mergeTransaction(tx),
        listing,
        buyerIdentityKey: buyer.toString(),
        chain: 'main',
        shape: marketSettlementShape('bsv21'),
      }),
    ).toThrow(/layout/i)
  })

  it('accepts exact settlement with no buyer BSV change output', () => {
    const { tx, validate, shape } = fixture()
    tx.outputs.splice(shape.firstChangeIndex, 1)
    expect(validate).not.toThrow()
  })

  it('accepts inscription-wrapped buyer BSV change from the toolbox', () => {
    const { tx, validate, buyer, shape } = fixture()
    const bareP2pkh = new P2PKH().lock(buyer.toAddress('mainnet')).toHex().toLowerCase()
    tx.outputs[shape.firstChangeIndex]!.lockingScript = LockingScript.fromHex(`0063036f7264${bareP2pkh}`)
    expect(validate).not.toThrow()
  })

  it('accepts 162 leftover token-change after the market fee', () => {
    const { tx, validate, buyer } = fixture('bsv21')
    tx.addOutput({
      satoshis: 1,
      lockingScript: LockingScript.fromHex(
        buildBsv21ValueLock({ layout: 'brc162',
          tokenId: TOKEN_ID,
          amount: 7n,
          address: buyer.toAddress('mainnet'),
        }),
      ),
    })
    expect(validate).not.toThrow()
  })

  it('rejects leftover 162 token-change that does not pay the buyer', () => {
    const { tx, validate, shape } = fixture('bsv21')
    tx.outputs[shape.firstChangeIndex]!.satoshis = 1
    tx.outputs[shape.firstChangeIndex]!.lockingScript = LockingScript.fromHex(
      buildBsv21ValueLock({ layout: 'brc162',
        tokenId: TOKEN_ID,
        amount: 7n,
        address: PrivateKey.fromRandom().toPublicKey().toAddress('mainnet'),
      }),
    )
    expect(validate).toThrow(/non-buyer change/i)
  })

  it('never drops a signed txid or AtomicBEEF when entering recovery', () => {
    const previous = {
      saleId: 'sale',
      reference: 'ref',
      itemVin: 0,
      offerVin: 1,
      phase: 'broadcast' as const,
      txid: 'ab'.repeat(32),
      atomicBeef: [1, 2, 3],
      expiresAt: Date.now() + 60_000,
      sellerIdentityKey: '03'.repeat(33),
      intent: {} as never,
    }
    const recovered = mergePendingPurchase(previous, { phase: 'recovery' })
    expect(recovered.phase).toBe('recovery')
    expect(recovered.txid).toBe(previous.txid)
    expect(recovered.atomicBeef).toEqual([1, 2, 3])
  })

  it('decodes overlay listing BEEF for the listing txid and rejects mismatches', async () => {
    const { Utils } = await import('@bsv/sdk')
    const tx = new Transaction()
    tx.addOutput({ satoshis: 1, lockingScript: new LockingScript() })
    tx.addInput({
      sourceTXID: 'f'.repeat(64),
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(),
      sequence: 0xffffffff,
    })
    const beef = new Beef()
    beef.mergeTxidOnly('f'.repeat(64))
    beef.mergeTransaction(tx)
    const listingTxid = tx.id('hex') as string
    const listingBeefB64 = Utils.toBase64(beef.toBinary())
    const listing = { listingBeefB64 } as MarketListingAdvert & { listingBeefB64: string }
    const decoded = overlayListingBeefBinary(listing, listingTxid)
    expect(decoded).not.toBeNull()
    expect(Beef.fromBinary(decoded!).findTxid(listingTxid)?.tx).toBeTruthy()
    expect(overlayListingBeefBinary(listing, 'a'.repeat(64))).toBeNull()
    expect(overlayListingBeefBinary({} as MarketListingAdvert, listingTxid)).toBeNull()
  })
})


describe('bsv21 market settlement buyer lock', () => {
  it('requires a 162 buyer item lock, not P2PKH', () => {
    const { tx, validate, buyer, shape } = fixture('bsv21')
    expect(validate).not.toThrow()
    expect(decodeBsv21Binary(tx.outputs[shape.buyerOutputIndex]!.lockingScript.toHex())).toMatchObject({
      role: 'value',
      tokenId: TOKEN_ID,
      amount: 60n,
    })
    tx.outputs[shape.buyerOutputIndex]!.lockingScript = new P2PKH().lock(buyer.toAddress('mainnet'))
    expect(validate).toThrow(/outputs do not match/i)
  })

  it('accepts buyer wallet addresses that differ from the identity-derived address', () => {
    const wallet = PrivateKey.fromRandom().toPublicKey().toAddress('mainnet')
    for (const assetType of ['ordinal', 'bsv21'] as const) {
      const { validate, validateAs, buyer } = fixture(assetType, wallet)
      expect(validate).not.toThrow()
      expect(() => validateAs({ buyerAddress: buyer.toAddress('mainnet') })).toThrow()
    }
  })
})

describe('listingHasBuyerCompletableSettlement', () => {
  const sig = (byte: string) => `47${'30'.padEnd(140, '0')}${byte}21${'02'.padEnd(66, '1')}`
  const unlocks = {
    version: 2 as const,
    layout: 'ordinal-v2' as const,
    itemUnlockingScript: sig('c3'),
    offerUnlockingScript: sig('c3').slice(0, 2 + 0x47 * 2),
    itemSighash: 'SINGLE|ANYONECANPAY' as const,
    offerSighash: 'SINGLE|ANYONECANPAY' as const,
    sellerSats: 97,
    feeSats: 5,
  }
  const amounts = { sellerSats: 97, feeSats: 5 }

  it('selects the pre-sign buy path when bound v2 scripts match amounts', () => {
    expect(
      listingHasBuyerCompletableSettlement({ settlementUnlocks: unlocks, assetType: 'ordinal' }, amounts),
    ).toBe(true)
  })

  it('never completes version-1 NONE|ANYONECANPAY item unlocks', () => {
    expect(
      listingHasBuyerCompletableSettlement({
        settlementUnlocks: { ...unlocks, version: 1, itemUnlockingScript: sig('c2') } as never,
        assetType: 'ordinal',
      }),
    ).toBe(false)
    expect(
      listingHasBuyerCompletableSettlement({
        settlementUnlocks: { ...unlocks, itemUnlockingScript: sig('c2') },
        assetType: 'ordinal',
      }),
    ).toBe(false)
  })

  it('keeps the listing unbuyable when unlocks are missing, mislaid, or amounts diverge', () => {
    expect(listingHasBuyerCompletableSettlement({ assetType: 'ordinal' })).toBe(false)
    expect(
      listingHasBuyerCompletableSettlement({ settlementUnlocks: null, assetType: 'ordinal' }),
    ).toBe(false)
    expect(
      listingHasBuyerCompletableSettlement({ settlementUnlocks: unlocks, assetType: 'bsv21' }),
    ).toBe(false)
    for (const patch of [{ sellerSats: 1 }, { sellerSats: 96 }, { feeSats: 0 }, { itemUnlockingScript: '' }]) {
      expect(
        listingHasBuyerCompletableSettlement(
          { settlementUnlocks: { ...unlocks, ...patch }, assetType: 'ordinal' },
          amounts,
        ),
      ).toBe(false)
    }
  })

  it('merges overlay unlocks from listing detail', async () => {
    const listing = {
      outpoint: `${'ab'.repeat(32)}_0`,
      priceSats: 100,
      assetType: 'ordinal',
    } as unknown as MarketListingAdvert
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ listing: { settlementUnlocks: unlocks } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch
    try {
      const merged = await hydrateMarketListingForPurchase(listing)
      expect(listingHasBuyerCompletableSettlement(merged)).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('market settlement account storage', () => {
  it('does not expose pending references to another account', () => {
    const base = 'handcash.market.pending.v2'
    const primaryKey = accountLocalKey(base)
    durableSetItem(
      primaryKey,
      JSON.stringify([
        {
          saleId: 'sale-primary',
          reference: 'ref-primary',
          phase: 'signedUnknown',
          expiresAt: Date.now() + 60_000,
        },
      ]),
    )
    expect(protectedMarketActionReferences()).toEqual(new Set(['ref-primary']))

    bindAccountLocalKeyScope({
      accountIndex: 1,
      identityKey: 'vitest-secondary-identity',
      chain: 'main',
    })
    rebindMarketSettlementForAccount()
    expect(protectedMarketActionReferences()).toEqual(new Set())

    durableRemoveItem(primaryKey)
  })
})
