import {
  Beef,
  LockingScript,
  P2PKH,
  PrivateKey,
  Script,
  Spend,
  Transaction,
  UnlockingScript,
  Utils,
} from '@bsv/sdk'
import { createActor } from 'xstate'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mayAbortOffer, offerMachine } from '../machines/offerMachine'
import {
  buildMarketHeldRemittance,
  buildMarketSettlementUnlocks,
  calculateMarketSettlement,
  classifyMarketListingAsset,
  createMarketListingAdvert,
  isAlreadySpentListingFailure,
  isMarketListingOrigin,
  MarketListingError,
  resolveOrdinalListingOrigin,
} from './marketListing'
import { rememberProvenVerdict } from './provenCache'
import {
  marketSettlementShape,
  unlocksBindSellerPayment,
} from './marketSettlementLayout'
import { unlockSighashByte } from './offerSeal'
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
  /** Token-parent BEEF the listing proof walks; empty when a test has none. */
  beef: null as null | import('@bsv/sdk').Beef,
  address: '',
  identityKey: '',
  listOutputsCalls: [] as Array<{ basket?: string; tags?: string[]; limit?: number }>,
  storage: null as null | {
    runAsStorageProvider: <T>(fn: (sp: unknown) => Promise<T>) => Promise<T>
  },
  signAction: vi.fn(async (): Promise<{ txid?: string; tx?: number[] }> => {
    throw new Error('signAction not staged')
  }),
  abortAction: vi.fn(async () => ({})),
  registerSignedSend: vi.fn(async (args: { txid: string }) => ({ txid: args.txid })),
  startSignedSendPropagation: vi.fn(),
}))

vi.mock('./signedSendLifecycle', () => ({
  registerSignedSend: listingHarness.registerSignedSend,
  startSignedSendPropagation: listingHarness.startSignedSendPropagation,
}))

vi.mock('./session', () => ({
  getActiveWallet: () => ({
    chain: 'main',
    identityKey: listingHarness.identityKey,
    address: listingHarness.address,
    rootKeyHex: '1'.padStart(64, '0'),
    wallet: {
      listOutputs: async (query: {
        basket?: string
        tags?: string[]
        limit?: number
      }) => {
        listingHarness.listOutputsCalls.push(query)
        return {
          outputs:
            query.basket === '1sat' && listingHarness.listed
              ? [listingHarness.listed]
              : [],
        }
      },
      createAction: listingHarness.createAction,
      signAction: listingHarness.signAction,
      abortAction: listingHarness.abortAction,
      storage: listingHarness.storage ?? undefined,
    },
  }),
}))

vi.mock('./beefCache', () => ({
  getBeefForTxidCached: async () => {
    const { Beef } = await import('@bsv/sdk')
    return listingHarness.beef ?? new Beef()
  },
  prepareBroadcastCheque: async (
    _wallet: unknown,
    _txid: string,
    atomic: number[],
  ) => ({
    atomic,
    decision: { kind: 'broadcast' as const, parents: 'unconfirmed-bodies' as const },
  }),
}))

vi.mock('./legacyScan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./legacyScan')>()
  return {
    ...actual,
    spentStatusOfOutpoint: vi.fn(async () => 'unspent' as const),
  }
})

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
    // u8 version/provenanceVersion must be OP_1/OP_2, never `01 01`/`01 02`.
    // Miners enforce MINIMALDATA while spending the offer output.
    expect(Script.fromHex(first).chunks[3]?.op).toBe(0x51)
    expect(Script.fromHex(first).chunks[16]?.op).toBe(0x52)
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

  it('rejects legacy offers whose one-byte version used a non-minimal data push', () => {
    const sellerKey = PrivateKey.fromHex('1'.padStart(64, '0'))
    const canonical = encodeMarketOffer(fixture(), sellerKey)
    const magicHex = Buffer.from(MARKET_OFFER_MAGIC).toString('hex')
    const legacy = canonical.replace(`${magicHex}51`, `${magicHex}0101`)
    expect(legacy).not.toBe(canonical)
    expect(() => parseMarketOffer(legacy)).toThrow(/seller must relist/i)
  })

  it('spends a canonical offer under miner script policy', async () => {
    const sellerKey = PrivateKey.fromHex('1'.padStart(64, '0'))
    const lockingScript = LockingScript.fromHex(encodeMarketOffer(fixture(), sellerKey))
    const source = new Transaction()
    source.addOutput({ satoshis: 1, lockingScript })
    const spend = new Transaction()
    const fullUnlock = new P2PKH().unlock(sellerKey, 'all', false, 1, lockingScript)
    spend.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScriptTemplate: {
        sign: async (tx, inputIndex) => {
          const full = await fullUnlock.sign(tx, inputIndex)
          return new UnlockingScript(full.chunks.slice(0, 1))
        },
        estimateLength: async () => 73,
      },
    })
    spend.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(sellerKey.toAddress()) })
    await spend.sign()

    expect(
      new Spend({
        sourceTXID: source.id('hex'),
        sourceOutputIndex: 0,
        sourceSatoshis: 1,
        lockingScript,
        transactionVersion: spend.version,
        otherInputs: [],
        inputIndex: 0,
        unlockingScript: spend.inputs[0]!.unlockingScript!,
        outputs: spend.outputs,
        inputSequence: spend.inputs[0]!.sequence ?? 0xffffffff,
        lockTime: spend.lockTime,
      }).validate(),
    ).toBe(true)
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
        neverSent: false,
        held: false,
        valid: true,
        active: true,
      }),
    ).toEqual({ path: 'refuse', reason: 'offer-not-held' })
    // The signed cheque still "carries" the offer, but no miner took it.
    expect(
      chooseMarketCancelPath({
        offerOutpoint: 'offer',
        neverSent: true,
        held: true,
        valid: true,
        active: true,
      }),
    ).toEqual({ path: 'refuse', reason: 'listing-never-sent' })
  })

  it('allows abort until Arcade accepts, then routes unknown signing to recovery', () => {
    const actor = createActor(offerMachine).start()
    actor.send({
      type: 'LIST',
      venue: 'market',
      path: { path: 'createOffer', itemOutpoint: 'item' },
    })
    actor.send({ type: 'STAGED', reference: 'ref' })
    expect(mayAbortOffer(actor.getSnapshot())).toBe(true)
    actor.send({ type: 'SIGNED_UNKNOWN' })
    // Hard-reject / never-broadcast must still abort the noSend tip reservation.
    expect(mayAbortOffer(actor.getSnapshot())).toBe(true)
    actor.send({ type: 'FAIL', error: 'lost receipt' })
    expect(actor.getSnapshot().matches('recovery')).toBe(true)
    expect(mayAbortOffer(actor.getSnapshot())).toBe(true)
  })

  it('refuses abort after Arcade accepted the listing broadcast', () => {
    const actor = createActor(offerMachine).start()
    actor.send({
      type: 'LIST',
      venue: 'market',
      path: { path: 'createOffer', itemOutpoint: 'item' },
    })
    actor.send({ type: 'STAGED', reference: 'ref' })
    actor.send({ type: 'SIGNED_UNKNOWN' })
    actor.send({ type: 'BROADCASTED', txid: 'ab'.repeat(32) })
    expect(mayAbortOffer(actor.getSnapshot())).toBe(false)
  })

  it('refunds the one-sat offer deposit to seller and pins market origins', () => {
    expect(calculateMarketSettlement(101)).toEqual({
      priceSats: 101,
      sellerSats: 97,
      feeSats: 5,
    })
    expect(isMarketListingOrigin('brc-cloud.bcryderman.workers.dev')).toBe(true)
    expect(isMarketListingOrigin('handcash-market-v2.pages.dev')).toBe(true)
    expect(isMarketListingOrigin('evil.workers.dev')).toBe(false)
  })
})


describe('market listing remittance', () => {
  const origin = `${'ab'.repeat(32)}_0`
  const tip = `${'cd'.repeat(32)}_3`
  const address = PrivateKey.fromRandom().toAddress()

  it('refuses a retired fungible protocol tip', () => {
    const leftover = JSON.stringify({
      p: '1sat-ft',
      origin,
      amt: '68862',
    })
    const classified = classifyMarketListingAsset({
      outpoint: tip,
      satoshis: 1,
      lockingScriptHex: `76a914${'11'.repeat(20)}88ac`,
      tags: ['1sat-ft'],
      customInstructions: leftover,
    })
    expect(classified.refuse).toBe('retired-protocol')
  })

  it('keeps collectable remittance on basket 1sat', () => {
    const remit = buildMarketHeldRemittance({
      assetType: 'ordinal',
      origin,
      name: 'Market item',
      extraTags: ['market-held'],
    })
    expect(remit.basket).toBe('1sat')
    expect(remit.tags).toContain('ordinal')
    expect(JSON.parse(remit.customInstructions).p).not.toBe('1sat-ft')
  })
})


describe('ordinal listing origin', () => {
  const proven = `${'a1'.repeat(32)}_0`
  const claimed = `${'c1'.repeat(32)}_9`

  it('prefers the durable BRC-150 origin over remittance metadata', () => {
    const tip = `${'e1'.repeat(32)}_1`
    rememberProvenVerdict(tip, {
      tier: 'brc150',
      origin: proven,
      path: [tip, proven],
      verifiedAt: Date.now(),
    })
    expect(
      resolveOrdinalListingOrigin({
        outpoint: tip,
        customOrigin: claimed,
        tags: [`origin:${claimed}`],
      }),
    ).toBe(proven)
  })

  it('falls back to customInstructions then the origin tag', () => {
    const tip = `${'e2'.repeat(32)}_1`
    expect(
      resolveOrdinalListingOrigin({
        outpoint: tip,
        customOrigin: claimed,
        tags: [`origin:${proven}`],
      }),
    ).toBe(claimed)
    expect(
      resolveOrdinalListingOrigin({
        outpoint: `${'e3'.repeat(32)}_2`,
        tags: [`origin:${proven}`],
      }),
    ).toBe(proven)
  })

  it('refuses a 1sat list with no proven, remittance, or tag origin', () => {
    expect(() =>
      resolveOrdinalListingOrigin({ outpoint: `${'e4'.repeat(32)}_3` }),
    ).toThrow(/no valid BRC-150 origin/i)
  })
})

describe('isAlreadySpentListingFailure', () => {
  it('matches explicit already-spent / double-spend, not bare MissingInputs', () => {
    expect(isAlreadySpentListingFailure('Already spent')).toBe(true)
    expect(isAlreadySpentListingFailure('ARCADE_HARD_REJECT: Already spent')).toBe(
      true,
    )
    expect(isAlreadySpentListingFailure('double spend detected')).toBe(true)
    expect(isAlreadySpentListingFailure('missing inputs on vin 2')).toBe(false)
    expect(isAlreadySpentListingFailure('ARCADE_HARD_REJECT: Not sent')).toBe(false)
    expect(isAlreadySpentListingFailure('ITEM_ORIGIN_UNPROVEN')).toBe(false)
    expect(isAlreadySpentListingFailure('ACTION_DENIED')).toBe(false)
  })
})

describe('list-time market settlement unlocks', () => {
  const sellerKey = PrivateKey.fromHex('1'.padStart(64, '0'))

  async function listed() {
    const assetType = 'ordinal' as const
    const fields = fixture()
    const offerLockingScript = encodeMarketOffer(fields, sellerKey)
    const itemLockingScript = new P2PKH().lock(fields.payTo).toHex()
    const listingTx = new Transaction()
    listingTx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(itemLockingScript) })
    listingTx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(offerLockingScript) })
    const unlocks = await buildMarketSettlementUnlocks({
      listingTx,
      txid: listingTx.id('hex') as string,
      assetType,
      itemLockingScript,
      offerLockingScript,
      payTo: fields.payTo,
      priceSats: fields.grossPriceSats,
      feePayToAddress: fields.feePayTo,
      privateKey: sellerKey,
    })
    return { fields, listingTx, unlocks, itemLockingScript, offerLockingScript }
  }

  function spends(tx: Transaction, vin: number): boolean {
    const input = tx.inputs[vin]!
    const source = input.sourceTransaction!.outputs[input.sourceOutputIndex]!
    try {
      return new Spend({
        sourceTXID: input.sourceTXID ?? (input.sourceTransaction!.id('hex') as string),
        sourceOutputIndex: input.sourceOutputIndex,
        sourceSatoshis: source.satoshis!,
        lockingScript: source.lockingScript,
        transactionVersion: tx.version,
        otherInputs: tx.inputs.filter((_, i) => i !== vin),
        outputs: tx.outputs,
        inputIndex: vin,
        unlockingScript: input.unlockingScript!,
        inputSequence: input.sequence ?? 0xffffffff,
        lockTime: tx.lockTime,
      }).validate()
    } catch {
      return false
    }
  }

  function addListed(tx: Transaction, listingTx: Transaction, vout: number, unlock: string) {
    tx.addInput({
      sourceTXID: listingTx.id('hex') as string,
      sourceOutputIndex: vout,
      sourceTransaction: listingTx,
      unlockingScript: UnlockingScript.fromHex(unlock),
      sequence: 0xffffffff,
    })
  }

  it('keeps the published seller signatures byte for byte', async () => {
    const { unlocks } = await listed()
    expect(unlocks.itemUnlockingScript).toBe(
      '4830450221008817e31ea39e3d305904050da9d90abcc33fbb83295e8305b841a8c23b6f2466022037f6687b380ca0d1e531cd983c64faa98ceca3a6d691a7b9022baad20de6b423c3210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    )
    expect(unlocks.offerUnlockingScript).toBe(
      '483045022100e6391ea682c55085d8e5f8a2ce60cbabcae084369136bdc9959b6226b7bcd463022033b3b530cd87bc340c7f52f0c1dc17c1a732f65804664660233b76dfc3ebd860c3',
    )
  })

  it('signs both seller inputs SINGLE|ANYONECANPAY in the ordinal layout', async () => {
    const assetType = 'ordinal' as const
    const { fields, unlocks } = await listed()
    const amounts = calculateMarketSettlement(fields.grossPriceSats)
    expect(unlocks).toMatchObject({
      version: 2,
      layout: marketSettlementShape(assetType).layout,
      itemSighash: 'SINGLE|ANYONECANPAY',
      offerSighash: 'SINGLE|ANYONECANPAY',
      sellerSats: amounts.sellerSats,
      feeSats: amounts.feeSats,
    })
    expect(unlockSighashByte(unlocks.itemUnlockingScript)).toBe(0xc3)
    expect(unlockSighashByte(unlocks.offerUnlockingScript)).toBe(0xc3)
    expect(unlocksBindSellerPayment(unlocks, assetType)).toBe(true)
    expect(unlocksBindSellerPayment({ ...unlocks, version: 1 }, assetType)).toBe(false)
  })

  it('refuses the published item unlock on a transaction that does not pay the seller', async () => {
    const { listingTx, unlocks } = await listed()
    const shape = marketSettlementShape('ordinal')
    const thief = new P2PKH().lock(PrivateKey.fromRandom().toAddress())
    for (let vin = 0; vin <= shape.itemVin; vin += 1) {
      const theft = new Transaction()
      for (let i = 0; i < vin; i += 1) addListed(theft, listingTx, 1, unlocks.offerUnlockingScript)
      addListed(theft, listingTx, 0, unlocks.itemUnlockingScript)
      for (let i = 0; i <= Math.max(vin, shape.feeOutputIndex); i += 1) {
        theft.addOutput({ satoshis: 1, lockingScript: thief })
      }
      expect(spends(theft, vin)).toBe(false)
    }
  })

  it('refuses the published offer unlock on a transaction that does not pay the fee', async () => {
    const { listingTx, unlocks } = await listed()
    const grief = new Transaction()
    addListed(grief, listingTx, 0, unlocks.itemUnlockingScript)
    addListed(grief, listingTx, 1, unlocks.offerUnlockingScript)
    const thief = new P2PKH().lock(PrivateKey.fromRandom().toAddress())
    grief.addOutput({ satoshis: 1, lockingScript: thief })
    grief.addOutput({ satoshis: 1, lockingScript: thief })
    expect(spends(grief, 1)).toBe(false)
  })

  it('validates a buyer-completed ordinal settlement with pads ahead of the item', async () => {
    const { fields, listingTx, unlocks } = await listed()
    const shape = marketSettlementShape('ordinal')
    const amounts = calculateMarketSettlement(fields.grossPriceSats)
    const buyer = PrivateKey.fromRandom()
    const buyerLock = new P2PKH().lock(buyer.toAddress())
    const padTx = new Transaction()
    padTx.addOutput({ satoshis: 1, lockingScript: buyerLock })
    padTx.addOutput({ satoshis: 1, lockingScript: buyerLock })
    const tx = new Transaction()
    for (const vout of [0, 1]) {
      tx.addInput({
        sourceTXID: padTx.id('hex') as string,
        sourceOutputIndex: vout,
        sourceTransaction: padTx,
        unlockingScriptTemplate: new P2PKH().unlock(buyer, 'all', false, 1, buyerLock),
        sequence: 0xffffffff,
      })
    }
    addListed(tx, listingTx, 0, unlocks.itemUnlockingScript)
    addListed(tx, listingTx, 1, unlocks.offerUnlockingScript)
    tx.addOutput({ satoshis: 2, lockingScript: buyerLock })
    tx.addOutput({ satoshis: 1, lockingScript: buyerLock })
    tx.addOutput({ satoshis: amounts.sellerSats, lockingScript: new P2PKH().lock(fields.payTo) })
    tx.addOutput({ satoshis: amounts.feeSats, lockingScript: new P2PKH().lock(fields.feePayTo) })
    for (const vin of shape.padVins) {
      tx.inputs[vin]!.unlockingScript = await tx.inputs[vin]!.unlockingScriptTemplate!.sign(tx, vin)
    }
    expect(shape.padVins.every((vin) => spends(tx, vin))).toBe(true)
    expect(spends(tx, shape.itemVin)).toBe(true)
    expect(spends(tx, shape.offerVin)).toBe(true)
  })
})
