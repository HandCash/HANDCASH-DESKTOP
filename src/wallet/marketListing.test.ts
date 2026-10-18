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
import {
  marketSettlementShape,
  unlocksBindSellerPayment,
} from './marketSettlementLayout'
import { unlockSighashByte } from './offerSeal'
import { decodeBsv21Binary, encodeBsv21Binary } from './token'
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
            query.basket === 'bsv21' && listingHarness.listed
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


describe('market 162 listing remittance', () => {
  const tokenId = `${'ab'.repeat(32)}_0`
  const tip = `${'cd'.repeat(32)}_3`
  const address = PrivateKey.fromRandom().toAddress()

  it('lists a 162 tip into basket bsv21 with 163 amt/id', () => {
    const lockingScriptHex = buildBsv21ValueLock({ layout: 'brc162',
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
    expect(remit.basket).toBe('p2pft')
    expect(remit.tags).toContain(`p2pft:${tokenId}`)
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
  const seller = PrivateKey.fromHex('1'.padStart(64, '0'))

  /**
   * A real BRC-162 lineage: fixed-supply deploy → transfer paying the seller
   * at `vout`. The listing proof walks this packet (BRC-176); a token id that
   * names no deploy body is refused, not asserted.
   */
  function mintTip(amount: bigint, vout = 3) {
    const filler = new P2PKH().lock(seller.toAddress())
    const deploy = new Transaction()
    deploy.addOutput({
      satoshis: 1,
      lockingScript: encodeBsv21Binary({
        amount,
        payload: { sym: 'TST' },
        rest: filler.toHex(),
      }),
    })
    const tokenId = `${deploy.id('hex')}_0`
    const transfer = new Transaction()
    transfer.addInput({
      sourceTransaction: deploy,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(),
    })
    for (let i = 0; i < vout; i++) {
      transfer.addOutput({ satoshis: 1, lockingScript: filler })
    }
    const lockingScriptHex = buildBsv21ValueLock({ layout: 'brc162',
      tokenId,
      amount,
      address: seller.toAddress(),
    })
    transfer.addOutput({
      satoshis: 1,
      lockingScript: LockingScript.fromHex(lockingScriptHex),
    })
    const beef = new Beef()
    beef.mergeTransaction(transfer)
    return {
      tokenId,
      tip: `${transfer.id('hex')}_${vout}`,
      lockingScriptHex,
      beef,
    }
  }

  /** The tip `listingHarness.listed` names, answered by txid and vout. */
  function holdListedTip() {
    const listed = listingHarness.listed as {
      outpoint: string
      satoshis?: number
      lockingScript?: string
      customInstructions?: string
      tags?: string[]
    } | null
    if (!listed) return
    const [txid, voutText] = listed.outpoint.split('.')
    listingHarness.storage = {
      runAsStorageProvider: async (fn) =>
        fn({
          findUserByIdentityKey: async () => ({ userId: 1 }),
          findOutputBaskets: async () => [{ basketId: 4, name: 'bsv21' }],
          findOutputs: async (args: { partial: { txid: string; vout: number } }) => {
            if (args.partial.txid !== txid || args.partial.vout !== Number(voutText)) return []
            return [
              {
                outputId: 1,
                basketId: 4,
                spendable: true,
                satoshis: listed.satoshis ?? 1,
                customInstructions: listed.customInstructions,
                lockingScript: listed.lockingScript
                  ? [...Utils.toArray(listed.lockingScript, 'hex')]
                  : undefined,
              },
            ]
          },
          findOutputTagMaps: async () =>
            (listed.tags ?? []).map((_, index) => ({ outputTagId: index + 1, isDeleted: false })),
          findOutputTags: async (args: { partial: { outputTagId: number } }) => [
            { tag: listed.tags?.[args.partial.outputTagId - 1], isDeleted: false },
          ],
        }),
    }
  }

  beforeEach(() => {
    listingHarness.createAction.mockClear()
    listingHarness.createAction.mockImplementation(async () => {
      throw new Error('stop-after-createAction')
    })
    listingHarness.listed = null
    listingHarness.beef = null
    listingHarness.listOutputsCalls.length = 0
    listingHarness.storage = null
    listingHarness.signAction.mockReset().mockRejectedValue(new Error('signAction not staged'))
    listingHarness.abortAction.mockClear()
    listingHarness.registerSignedSend.mockClear()
    listingHarness.startSignedSendPropagation.mockClear()
    listingHarness.address = seller.toAddress()
    listingHarness.identityKey = seller.toPublicKey().toString()
  })

  it('reads the selected tip by outpoint instead of the basket', async () => {
    const minted = mintTip(60n, 1)
    const dotted = minted.tip.replace('_', '.')
    const [txid, voutText] = dotted.split('.')
    const findOutputs = vi.fn(async () => [
      {
        outputId: 11,
        basketId: 4,
        spendable: true,
        satoshis: 1,
        customInstructions: JSON.stringify({
          p: 'bsv-20',
          op: 'transfer',
          id: minted.tokenId,
          amt: '60',
        }),
        lockingScript: [...Utils.toArray(minted.lockingScriptHex, 'hex')],
      },
    ])
    listingHarness.beef = minted.beef
    listingHarness.storage = {
      runAsStorageProvider: async (fn) =>
        fn({
          findUserByIdentityKey: async () => ({ userId: 7 }),
          findOutputBaskets: async () => [{ basketId: 4, name: 'bsv21' }],
          findOutputs,
          findOutputTagMaps: async () => [{ outputTagId: 2, isDeleted: false }],
          findOutputTags: async () => [
            { tag: `bsv21:${minted.tokenId}`, isDeleted: false },
          ],
        }),
    }
    await expect(
      createMarketListingAdvert({
        outpoint: minted.tip,
        assetType: 'bsv21',
        priceSats: 100,
      }),
    ).rejects.toThrow(/stop-after-createAction/)
    expect(findOutputs).toHaveBeenCalledWith({
      partial: { userId: 7, txid, vout: Number(voutText) },
      noScript: false,
    })
    expect(listingHarness.listOutputsCalls).toEqual([])
  })

  it('reads the held tip by origin tag instead of scanning the whole basket', async () => {
    const minted = mintTip(60n, 1)
    const knownTip = minted.tip
    const knownOrigin = minted.tokenId
    rememberProvenVerdict(knownTip.replace('_', '.'), {
      tier: 'brc150',
      origin: knownOrigin,
      path: [knownTip, knownOrigin],
      verifiedAt: Date.now(),
    })
    listingHarness.beef = minted.beef
    listingHarness.listed = {
      outpoint: knownTip.replace('_', '.'),
      satoshis: 1,
      lockingScript: minted.lockingScriptHex,
      tags: ['bsv21', `bsv21:${minted.tokenId}`, 'amt:60'],
      customInstructions: JSON.stringify({
        p: 'bsv-20',
        op: 'transfer',
        id: minted.tokenId,
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

  it('proves a fresh 162 tip from binary + 163 + its token-parent BEEF without BRC-150', () => {
    const minted = mintTip(60n)
    const proof = buildBsv21ListingProof({
      outpoint: minted.tip,
      lockingScriptHex: minted.lockingScriptHex,
      customInstructions: JSON.stringify({
        p: 'bsv-20',
        op: 'transfer',
        id: minted.tokenId,
        amt: '60',
      }),
      beef: minted.beef,
    })
    expect(proof).toMatchObject({
      v: 176,
      tokenId: minted.tokenId,
      amt: '60',
      role: 'value',
      tip: minted.tip,
      deployOutpoint: minted.tokenId,
    })
  })

  it('refuses a v:176 proof when the packet cannot prove the tip (BRC-176: record, not claim)', () => {
    const minted = mintTip(60n)
    expect(() =>
      buildBsv21ListingProof({
        outpoint: minted.tip,
        lockingScriptHex: minted.lockingScriptHex,
      }),
    ).toThrow(MarketListingError)
    const forgedId = `${'ab'.repeat(32)}_0`
    const forgedLock = buildBsv21ValueLock({ layout: 'brc162',
      tokenId: forgedId,
      amount: 60n,
      address: seller.toAddress(),
    })
    expect(() =>
      buildBsv21ListingProof({
        outpoint: minted.tip,
        lockingScriptHex: forgedLock,
        beef: minted.beef,
      }),
    ).toThrow(/BRC-176 proof/)
  })

  it('createAction held lock for a 162 list is 162, not P2PKH', async () => {
    const minted = mintTip(60n)
    listingHarness.beef = minted.beef
    listingHarness.listed = {
      outpoint: minted.tip.replace('_', '.'),
      satoshis: 1,
      lockingScript: minted.lockingScriptHex,
      tags: ['bsv21', `bsv21:${minted.tokenId}`, 'amt:60'],
      customInstructions: JSON.stringify({
        p: 'bsv-20',
        op: 'transfer',
        id: minted.tokenId,
        amt: '60',
      }),
    }
    holdListedTip()
    await expect(
      createMarketListingAdvert({ outpoint: minted.tip, priceSats: 100 }),
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
    expect(decoded).toMatchObject({ role: 'value', tokenId: minted.tokenId, amount: 60n })
    expect(held.lockingScript.startsWith('76a914')).toBe(false)
    expect(held.basket).toBe('p2pft')
    const ci = JSON.parse(held.customInstructions ?? '{}') as {
      p: string
      id: string
      amt: string
    }
    expect(ci.p).toBe('bsv-20')
    expect(ci.id).toBe(minted.tokenId)
    expect(ci.amt).toBe('60')
  })

  it('splits a larger 162 tip to listAmt before the offer so lock amt matches the advert', async () => {
    const minted = mintTip(69000n)
    listingHarness.beef = minted.beef
    listingHarness.listed = {
      outpoint: minted.tip.replace('_', '.'),
      satoshis: 1,
      lockingScript: minted.lockingScriptHex,
      tags: ['bsv21', `bsv21:${minted.tokenId}`, 'amt:69000'],
      customInstructions: JSON.stringify({
        p: 'bsv-20',
        op: 'transfer',
        id: minted.tokenId,
        amt: '69000',
      }),
    }
    holdListedTip()
    await expect(
      createMarketListingAdvert({
        outpoint: minted.tip,
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
    expect(listed).toMatchObject({ role: 'value', tokenId: minted.tokenId, amount: 240n })
    const change = decodeBsv21Binary(args.outputs[1]!.lockingScript)
    expect(change).toMatchObject({ role: 'value', tokenId: minted.tokenId, amount: 68760n })
  })

  describe('list split cheque', () => {
    function stageSplit(minted: ReturnType<typeof mintTip>) {
      listingHarness.beef = minted.beef
      listingHarness.listed = {
        outpoint: minted.tip.replace('_', '.'),
        satoshis: 1,
        lockingScript: minted.lockingScriptHex,
        tags: ['bsv21', `bsv21:${minted.tokenId}`, 'amt:69000'],
        customInstructions: JSON.stringify({ p: 'bsv-20', op: 'transfer', id: minted.tokenId, amt: '69000' }),
      }
      holdListedTip()
      const [tipTxid, tipVout] = minted.tip.split('_') as [string, string]
      const split = new Transaction()
      listingHarness.createAction.mockImplementationOnce((async (args: {
        outputs: Array<{ lockingScript: string; satoshis: number }>
      }) => {
        split.addInput({
          sourceTransaction: minted.beef.findTxid(tipTxid)!.tx!,
          sourceOutputIndex: Number(tipVout),
          unlockingScript: new UnlockingScript(),
        })
        for (const out of args.outputs) {
          split.addOutput({ satoshis: out.satoshis, lockingScript: LockingScript.fromHex(out.lockingScript) })
        }
        const staged = new Beef()
        staged.mergeTransaction(split)
        return { signableTransaction: { reference: 'split-ref', tx: staged.toBinary() } }
      }) as never)
      return split
    }

    const listSplit = () =>
      createMarketListingAdvert({ outpoint: mintTip(69000n).tip, assetType: 'bsv21', priceSats: 57600, listAmt: 240 })

    it('registers a signed split as a cheque and never aborts it', async () => {
      const minted = mintTip(69000n)
      const split = stageSplit(minted)
      listingHarness.signAction.mockImplementationOnce(async () => {
        const signed = new Beef()
        signed.mergeTransaction(split)
        const txid = split.id('hex')
        return { txid, tx: Array.from(signed.toBinaryAtomic(txid)) }
      })

      await expect(
        createMarketListingAdvert({ outpoint: minted.tip, assetType: 'bsv21', priceSats: 57600, listAmt: 240 }),
      ).rejects.toThrow(/stop-after-createAction/)

      expect(listingHarness.registerSignedSend).toHaveBeenCalledWith(
        expect.objectContaining({ txid: split.id('hex'), flow: 'market_listing' }),
      )
      expect(listingHarness.startSignedSendPropagation).toHaveBeenCalledTimes(1)
      expect(listingHarness.abortAction).not.toHaveBeenCalled()
      // A cover still queued for miners must not fail an inline broadcast.
      expect(listingHarness.signAction).toHaveBeenCalledWith(
        expect.objectContaining({ reference: 'split-ref', options: { noSend: true } }),
      )
    })

    it('aborts a split that never signed', async () => {
      stageSplit(mintTip(69000n))
      void listSplit
      const minted = mintTip(69000n)
      listingHarness.createAction.mockReset()
      stageSplit(minted)
      listingHarness.signAction.mockRejectedValueOnce(new Error('signer refused'))

      await expect(
        createMarketListingAdvert({ outpoint: minted.tip, assetType: 'bsv21', priceSats: 57600, listAmt: 240 }),
      ).rejects.toThrow(/signer refused/)
      expect(listingHarness.abortAction).toHaveBeenCalledWith({ reference: 'split-ref' })
      expect(listingHarness.registerSignedSend).not.toHaveBeenCalled()
    })
  })

  it('does not treat remittance-only 1-sat as a 162 listable tip', () => {
    const tokenId = `${'ab'.repeat(32)}_0`
    const classified = classifyMarketListingAsset({
      outpoint: `${'cd'.repeat(32)}_3`,
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
  const sellerKey = PrivateKey.fromHex('1'.padStart(64, '0'))

  async function listed(assetType: 'ordinal' | 'bsv21') {
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
    // ANYONECANPAY|SINGLE leaves the input index out of the digest, so both
    // layouts sign the same bytes.
    for (const assetType of ['ordinal', 'bsv21'] as const) {
      const { unlocks } = await listed(assetType)
      expect(unlocks.itemUnlockingScript).toBe(
        '4830450221008817e31ea39e3d305904050da9d90abcc33fbb83295e8305b841a8c23b6f2466022037f6687b380ca0d1e531cd983c64faa98ceca3a6d691a7b9022baad20de6b423c3210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      )
      expect(unlocks.offerUnlockingScript).toBe(
        '483045022100e6391ea682c55085d8e5f8a2ce60cbabcae084369136bdc9959b6226b7bcd463022033b3b530cd87bc340c7f52f0c1dc17c1a732f65804664660233b76dfc3ebd860c3',
      )
    }
  })

  it('signs both seller inputs SINGLE|ANYONECANPAY in the layout of the asset', async () => {
    for (const assetType of ['ordinal', 'bsv21'] as const) {
      const { fields, unlocks } = await listed(assetType)
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
      expect(unlocksBindSellerPayment(unlocks, assetType === 'bsv21' ? 'ordinal' : 'bsv21')).toBe(false)
      expect(unlocksBindSellerPayment({ ...unlocks, version: 1 }, assetType)).toBe(false)
    }
  })

  it('refuses the published item unlock on a transaction that does not pay the seller', async () => {
    for (const assetType of ['ordinal', 'bsv21'] as const) {
      const { listingTx, unlocks } = await listed(assetType)
      const shape = marketSettlementShape(assetType)
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
    }
  })

  it('refuses the published offer unlock on a transaction that does not pay the fee', async () => {
    const { listingTx, unlocks } = await listed('bsv21')
    const grief = new Transaction()
    addListed(grief, listingTx, 0, unlocks.itemUnlockingScript)
    addListed(grief, listingTx, 1, unlocks.offerUnlockingScript)
    const thief = new P2PKH().lock(PrivateKey.fromRandom().toAddress())
    grief.addOutput({ satoshis: 1, lockingScript: thief })
    grief.addOutput({ satoshis: 1, lockingScript: thief })
    expect(spends(grief, 1)).toBe(false)
  })

  it('validates a buyer-completed ordinal settlement with pads ahead of the item', async () => {
    const { fields, listingTx, unlocks } = await listed('ordinal')
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
