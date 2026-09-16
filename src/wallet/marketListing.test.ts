import {
  LockingScript,
  P2PKH,
  PrivateKey,
  Script,
  Spend,
  Transaction,
  UnlockingScript,
} from '@bsv/sdk'
import { createActor } from 'xstate'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { marketListingMachine, mayAbortMarketListing } from '../machines/marketListingMachine'
import {
  buildBsv21ListingProof,
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
import { decodeBsv21Binary } from './token'
import { buildBsv21ValueLock } from './token'
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
  listOutputsCalls: [] as Array<{ basket?: string; tags?: string[]; limit?: number }>,
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
            query.basket === 'bsv21' && listingHarness.listed
              ? [listingHarness.listed]
              : [],
        }
      },
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
        held: false,
        valid: true,
        active: true,
      }),
    ).toEqual({ path: 'refuse', reason: 'offer-not-held' })
  })

  it('allows abort until Arcade accepts, then routes unknown signing to recovery', () => {
    const actor = createActor(marketListingMachine).start()
    actor.send({
      type: 'LIST',
      path: { path: 'createOffer', itemOutpoint: 'item' },
    })
    actor.send({ type: 'STAGED', reference: 'ref' })
    expect(mayAbortMarketListing(actor.getSnapshot())).toBe(true)
    actor.send({ type: 'SIGNED_UNKNOWN' })
    // Hard-reject / never-broadcast must still abort the noSend tip reservation.
    expect(mayAbortMarketListing(actor.getSnapshot())).toBe(true)
    actor.send({ type: 'FAIL', error: 'lost receipt' })
    expect(actor.getSnapshot().matches('recovery')).toBe(true)
    expect(mayAbortMarketListing(actor.getSnapshot())).toBe(true)
  })

  it('refuses abort after Arcade accepted the listing broadcast', () => {
    const actor = createActor(marketListingMachine).start()
    actor.send({
      type: 'LIST',
      path: { path: 'createOffer', itemOutpoint: 'item' },
    })
    actor.send({ type: 'STAGED', reference: 'ref' })
    actor.send({ type: 'SIGNED_UNKNOWN' })
    actor.send({ type: 'BROADCASTED', txid: 'ab'.repeat(32) })
    expect(mayAbortMarketListing(actor.getSnapshot())).toBe(false)
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
  })

  it('refuses a retired fungible protocol tip', () => {
    const leftover = JSON.stringify({
      p: '1sat-ft',
      origin: tokenId,
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
    listingHarness.listOutputsCalls.length = 0
    listingHarness.address = seller.toAddress()
    listingHarness.identityKey = seller.toPublicKey().toString()
  })

  it('reads the held tip by origin tag instead of scanning the whole basket', async () => {
    const knownTip = `${'be'.repeat(32)}_1`
    const knownOrigin = `${'bf'.repeat(32)}_0`
    rememberProvenVerdict(knownTip.replace('_', '.'), {
      tier: 'brc150',
      origin: knownOrigin,
      path: [knownTip, knownOrigin],
      verifiedAt: Date.now(),
    })
    listingHarness.listed = {
      outpoint: knownTip.replace('_', '.'),
      satoshis: 1,
      lockingScript: buildBsv21ValueLock({
        tokenId,
        amount: 60n,
        address: seller.toAddress(),
      }),
      tags: ['bsv21', `bsv21:${tokenId}`, 'amt:60'],
      customInstructions: JSON.stringify({
        p: 'bsv-20',
        op: 'transfer',
        id: tokenId,
        amt: '60',
      }),
    }
    await expect(
      createMarketListingAdvert({ outpoint: knownTip, priceSats: 100 }),
    ).rejects.toThrow(/stop-after-createAction/)
    const first = listingHarness.listOutputsCalls[0]!
    expect(first.tags).toEqual([`origin:${knownOrigin.replace('_', '.')}`])
    expect(first.limit).toBe(25)
    expect(
      listingHarness.listOutputsCalls.some(
        (call) => !call.tags?.length && (call.limit ?? 0) > 1_000,
      ),
    ).toBe(false)
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

  it('splits a larger 162 tip to listAmt before the offer so lock amt matches the advert', async () => {
    const lockingScriptHex = buildBsv21ValueLock({
      tokenId,
      amount: 69000n,
      address: seller.toAddress(),
    })
    listingHarness.listed = {
      outpoint: tip.replace('_', '.'),
      satoshis: 1,
      lockingScript: lockingScriptHex,
      tags: ['bsv21', `bsv21:${tokenId}`, 'amt:69000'],
      customInstructions: JSON.stringify({
        p: 'bsv-20',
        op: 'transfer',
        id: tokenId,
        amt: '69000',
      }),
    }
    await expect(
      createMarketListingAdvert({
        outpoint: tip,
        assetType: 'bsv21',
        priceSats: 57600,
        listAmt: 240,
      }),
    ).rejects.toThrow(/stop-after-createAction/)
    expect(listingHarness.createAction).toHaveBeenCalledTimes(1)
    const args = listingHarness.createAction.mock.calls[0]![0] as {
      description: string
      outputs: Array<{
        lockingScript: string
        basket?: string
        outputDescription?: string
      }>
    }
    expect(args.description).toMatch(/split/i)
    expect(args.outputs.some((o) => o.basket === 'market-offers')).toBe(false)
    const listed = decodeBsv21Binary(args.outputs[0]!.lockingScript)
    expect(listed).toMatchObject({ role: 'value', tokenId, amount: 240n })
    const change = decodeBsv21Binary(args.outputs[1]!.lockingScript)
    expect(change).toMatchObject({ role: 'value', tokenId, amount: 68760n })
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
  it('builds version-1 NONE|ACP item and SINGLE|ACP offer unlocks', async () => {
    const fields = fixture()
    const sellerKey = PrivateKey.fromHex('1'.padStart(64, '0'))
    const offerLockingScript = encodeMarketOffer(fields, sellerKey)
    const itemLockingScript = new P2PKH().lock(fields.payTo).toHex()
    const listingTx = new Transaction()
    listingTx.addOutput({
      satoshis: 1,
      lockingScript: LockingScript.fromHex(itemLockingScript),
    })
    listingTx.addOutput({
      satoshis: 1,
      lockingScript: LockingScript.fromHex(offerLockingScript),
    })
    const amounts = calculateMarketSettlement(fields.grossPriceSats)
    const unlocks = await buildMarketSettlementUnlocks({
      listingTx,
      txid: listingTx.id('hex') as string,
      itemLockingScript,
      offerLockingScript,
      payTo: fields.payTo,
      priceSats: fields.grossPriceSats,
      feePayToAddress: fields.feePayTo,
      privateKey: sellerKey,
    })
    expect(unlocks).toMatchObject({
      version: 1,
      itemSighash: 'NONE|ANYONECANPAY',
      offerSighash: 'SINGLE|ANYONECANPAY',
      sellerSats: amounts.sellerSats,
      feeSats: amounts.feeSats,
    })
    expect(unlocks.itemUnlockingScript).toMatch(/^[0-9a-f]+$/i)
    expect(unlocks.offerUnlockingScript).toMatch(/^[0-9a-f]+$/i)
    // Item is sig+pubkey; offer is checksig-only (sig push).
    expect(unlocks.offerUnlockingScript.length).toBeLessThan(
      unlocks.itemUnlockingScript.length,
    )
  })
})
