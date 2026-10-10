import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Beef, P2PKH, PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk'
import { accountLocalKey } from './accountLocalKeys'

/**
 * Destination change pays the fee for every collectable, so a large collection
 * can exhaust the wallet part-way through. That must end the run with the
 * unreached tips answered `funds` — blaming the tip and grinding on would
 * report hundreds of identical "failures".
 */

const createAction = vi.fn()
const abortAction = vi.fn()
const refreshFromChain = vi.fn()
const stored = new Map<string, string>()

vi.mock('./spendGuard', () => ({
  runExclusiveSpend: (fn: () => Promise<unknown>) => fn(),
}))
vi.mock('./walletCoordinator', () => ({
  leaseSpendPriority: () => ({ touch: () => undefined, release: () => undefined }),
}))
vi.mock('./paymentPolicy', () => ({ assertOnlineForPayment: () => undefined }))
vi.mock('./appLog', () => ({ appendAppLog: vi.fn() }))
vi.mock('./chainIngest', () => ({
  refreshFromChain: (...a: unknown[]) => refreshFromChain(...a),
}))
vi.mock('./deviceSync', () => ({ scheduleHistoryBackupPush: vi.fn() }))
vi.mock('./legacyReceiptActivity', () => ({
  recordFundingReceipts: vi.fn(),
  recordMigratedItemActivity: vi.fn(),
}))
vi.mock('./legacyScan', () => ({
  importLegacyUtxos: vi.fn(),
  scanAddressViaBitails: vi.fn(),
  scanAddressViaWhatsOnChain: vi.fn(),
  txExistsOnChain: async () => false,
}))
/** `txid.vout` → the local transaction this wallet sealed it under. */
const seals = new Map<string, string>()
const cheques = new Map<string, number[]>()
const minerSubmit = vi.fn()
vi.mock('./utxoLockManager', () => ({
  sealedSpenderOf: (outpoint: string) => seals.get(outpoint.replace('_', '.')) ?? null,
}))
vi.mock('./signedChequeArchive', () => ({
  signedChequeAtomic: (txid: string) => cheques.get(txid) ?? null,
}))
vi.mock('./minerSubmit', () => ({
  submitAtomicBeefToMiners: (...a: unknown[]) => minerSubmit(...a),
}))
vi.mock('./legacyStuckSweep', () => ({ retryableStuckSweeps: vi.fn() }))
vi.mock('./legacyImportGuard', () => ({
  forgetLegacyImported: vi.fn(),
  legacySweepRecord: () => null,
}))
vi.mock('./session', () => ({
  getActiveWallet: () => ({
    identityKey: '02'.repeat(33),
    address: '1PjUSNqWWKFwG9vCnpnoMRDnkr1m89h9NU',
    chain: 'main',
    wallet: {
      createAction: (...a: unknown[]) => createAction(...a),
      abortAction: (...a: unknown[]) => abortAction(...a),
    },
    services: {},
  }),
}))
vi.mock('./durableStorage', () => ({
  durableGetItem: (k: string) => stored.get(k) ?? null,
  durableSetItem: (k: string, v: string) => {
    stored.set(k, v)
    return true
  },
  durableRemoveItem: (k: string) => {
    stored.delete(k)
    return true
  },
}))

const PHRASE_KEY = PrivateKey.fromHex('11'.repeat(32))

/** A real 1-sat tip locked to the phrase key, so eligibility passes for real. */
function makeTip(nonce: number) {
  const tx = new Transaction()
  tx.addOutput({
    satoshis: 1,
    lockingScript: new P2PKH().lock(PHRASE_KEY.toAddress()),
  })
  tx.addOutput({
    satoshis: nonce,
    lockingScript: new P2PKH().lock(PHRASE_KEY.toAddress()),
  })
  const beef = new Beef()
  beef.mergeRawTx(tx.toBinary())
  const txid = tx.id('hex')
  return { txid, outpoint: `${txid}_0`, beef: beef.toBinary() }
}

const TIPS = [makeTip(1000), makeTip(2000)]

const beefByTxid = new Map(TIPS.map((t) => [t.txid, t.beef]))
const parentCalls: string[][] = []
/** Txids whose parents hold back until the test lets them go. */
const heldParents = new Map<string, Promise<void>>()
/** Txids whose parents fail to read this many more times. */
const unreadableReads = new Map<string, number>()

vi.mock('./legacyBeef', () => ({
  buildLegacyInputBeef: async (_svc: unknown, outpoints: string[]) => {
    parentCalls.push(outpoints)
    for (const op of outpoints) await heldParents.get(op.split('.')[0] ?? '')
    const merged = new Beef()
    const ready: string[] = []
    const failures: Array<{ outpoint: string; reason: string }> = []
    for (const op of outpoints) {
      const txid = op.split('.')[0] ?? ''
      const left = unreadableReads.get(txid) ?? 0
      if (left > 0) {
        unreadableReads.set(txid, left - 1)
        failures.push({ outpoint: op, reason: `no provider answered for the proof of ${txid.slice(0, 12)}` })
        continue
      }
      merged.mergeBeef(beefByTxid.get(txid)!)
      ready.push(op)
    }
    return { ready, beef: ready.length > 0 ? merged.toBinary() : [], failures }
  },
  withVisibleOnChainBeef: async <T,>(fn: () => Promise<T>) => fn(),
}))
vi.mock('./oneSatProvenance', () => ({
  buildInternalizeCustomInstructions: () => '{}',
}))

const chosen = TIPS.map((t) => ({ outpoint: t.outpoint, keyHex: PHRASE_KEY.toHex() }))

describe('migrateChosenPhraseItems stops', () => {
  beforeEach(() => {
    vi.resetModules()
    stored.clear()
    createAction.mockReset()
    abortAction.mockReset()
    refreshFromChain.mockReset()
    parentCalls.length = 0
    heldParents.clear()
    unreadableReads.clear()
    seals.clear()
    cheques.clear()
    minerSubmit.mockReset()
  })

  it('cashes an earlier unlanded leg that sealed tips instead of building over them', async () => {
    const three = Array.from({ length: 3 }, (_, i) => makeTip(30_000 + i))
    for (const tip of three) beefByTxid.set(tip.txid, tip.beef)
    const dest = new P2PKH().lock('1PjUSNqWWKFwG9vCnpnoMRDnkr1m89h9NU')
    const earlier = new Transaction()
    for (const tip of three.slice(0, 2)) {
      earlier.addInput({ sourceTXID: tip.txid, sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex('') })
      earlier.addOutput({ lockingScript: dest, satoshis: 1 })
    }
    const earlierTxid = earlier.id('hex')
    const body = new Beef()
    body.mergeRawTx(earlier.toBinary())
    cheques.set(earlierTxid, body.toBinaryAtomic(earlierTxid))
    for (const tip of three.slice(0, 2)) seals.set(`${tip.txid}.0`, earlierTxid)
    minerSubmit.mockResolvedValue({ kind: 'accepted', ancestryComplete: true, keepPropagating: false })
    const inputCounts: number[] = []
    createAction.mockImplementation(async (args: { inputs?: unknown[] }) => {
      inputCounts.push(args.inputs?.length ?? 0)
      throw new Error('Insufficient funds in the available inputs (1000 more satoshis are needed)')
    })
    const landed: string[] = []

    const { migrateChosenPhraseItems } = await import('./phraseSweep')
    const run = await migrateChosenPhraseItems({
      items: three.map((t) => ({ outpoint: t.outpoint, keyHex: PHRASE_KEY.toHex() })),
      onLanded: (outpoints) => landed.push(...outpoints),
    })

    expect(minerSubmit).toHaveBeenCalledWith(earlierTxid, expect.any(Array), { flow: 'item_transfer' })
    expect(inputCounts).toEqual([1])
    expect(run.results.get(three[0]!.outpoint)).toEqual({ kind: 'moved', txid: earlierTxid })
    expect(run.results.get(three[1]!.outpoint)).toEqual({ kind: 'moved', txid: earlierTxid })
    expect(run.results.get(three[2]!.outpoint)?.kind).toBe('funds')
    expect(landed).toEqual([three[0]!.outpoint, three[1]!.outpoint])
  })

  it('leaves tips sealed by an undecided leg for the next run, without building over them', async () => {
    const tip = makeTip(40_000)
    beefByTxid.set(tip.txid, tip.beef)
    seals.set(`${tip.txid}.0`, 'e'.repeat(64))

    const { migrateChosenPhraseItems } = await import('./phraseSweep')
    const run = await migrateChosenPhraseItems({ items: [{ outpoint: tip.outpoint, keyHex: PHRASE_KEY.toHex() }] })

    expect(createAction).not.toHaveBeenCalled()
    expect(run.results.get(tip.outpoint)?.kind).toBe('deferred')
  })

  it('signs the first chunk while the next chunk’s parents still download, one source tx per decode', async () => {
    const many = Array.from({ length: 30 }, (_, i) => makeTip(10_000 + i))
    for (const tip of many) beefByTxid.set(tip.txid, tip.beef)
    let releaseSecondChunk!: () => void
    const secondChunk = new Promise<void>((resolve) => (releaseSecondChunk = resolve))
    for (const tip of many.slice(24)) heldParents.set(tip.txid, secondChunk)
    createAction.mockImplementation(async () => {
      releaseSecondChunk()
      throw new Error('Insufficient funds in the available inputs (1000 more satoshis are needed)')
    })

    const { migrateChosenPhraseItems } = await import('./phraseSweep')
    const run = await migrateChosenPhraseItems({
      items: many.map((t) => ({ outpoint: t.outpoint, keyHex: PHRASE_KEY.toHex() })),
    })

    expect(createAction).toHaveBeenCalledTimes(1)
    expect(run.stopped).toBe('funds')
    expect([...run.results.values()].every((r) => r.kind === 'funds')).toBe(true)
    expect(run.results.size).toBe(30)
    expect(parentCalls.every((outpoints) => outpoints.length === 1)).toBe(true)
  })

  it('reads an unreadable item once more after the run’s other chunks, then answers it for good', async () => {
    const flaky = makeTip(50_000)
    const gone = makeTip(50_001)
    for (const tip of [flaky, gone]) beefByTxid.set(tip.txid, tip.beef)
    unreadableReads.set(flaky.txid, 1)
    unreadableReads.set(gone.txid, 2)
    const inputCounts: number[] = []
    createAction.mockImplementation(async (args: { inputs?: unknown[] }) => {
      inputCounts.push(args.inputs?.length ?? 0)
      throw new Error('Insufficient funds in the available inputs (1000 more satoshis are needed)')
    })

    vi.useFakeTimers()
    try {
      const { migrateChosenPhraseItems } = await import('./phraseSweep')
      const running = migrateChosenPhraseItems({
        items: [flaky, gone].map((t) => ({ outpoint: t.outpoint, keyHex: PHRASE_KEY.toHex() })),
      })
      await vi.advanceTimersByTimeAsync(11_000)
      const run = await running

      expect(parentCalls.flat().filter((op) => op.startsWith(flaky.txid))).toHaveLength(2)
      expect(inputCounts).toEqual([1])
      expect(run.results.get(flaky.outpoint)?.kind).toBe('funds')
      expect(run.results.get(gone.outpoint)).toMatchObject({
        kind: 'unreadable',
        message: expect.stringMatching(/no provider answered/),
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops on insufficient funds after one attempt and answers the rest funds', async () => {
    createAction.mockRejectedValue(
      new Error(
        'Insufficient funds in the available inputs to cover the cost of the required outputs and the transaction fee (539816 more satoshis are needed, for a total of 539816)',
      ),
    )
    const { migrateChosenPhraseItems } = await import('./phraseSweep')
    const run = await migrateChosenPhraseItems({ items: chosen })

    expect(run.stopped).toBe('funds')
    expect([...run.results.values()].map((r) => r.kind)).toEqual(['funds', 'funds'])
    // One attempt for the shared transaction, then stop — not once per tip.
    expect(createAction).toHaveBeenCalledTimes(1)
  })

  it('drops tips the input check found spent elsewhere and rebuilds the rest whole, never halving', async () => {
    const four = Array.from({ length: 4 }, (_, i) => makeTip(20_000 + i))
    for (const tip of four) beefByTxid.set(tip.txid, tip.beef)
    const dead = four[1]!
    const inputCounts: number[] = []
    createAction.mockImplementation(async (args: { inputs?: unknown[] }) => {
      inputCounts.push(args.inputs?.length ?? 0)
      if (inputCounts.length === 1) {
        throw Object.assign(new Error('inputs spent elsewhere'), {
          code: 'INPUTS_UNVERIFIED',
          reason: 'input-spent',
          dead: [dead.outpoint.replace('_', '.')],
        })
      }
      throw new Error('Insufficient funds in the available inputs (1000 more satoshis are needed)')
    })

    const { migrateChosenPhraseItems } = await import('./phraseSweep')
    const run = await migrateChosenPhraseItems({
      items: four.map((t) => ({ outpoint: t.outpoint, keyHex: PHRASE_KEY.toHex() })),
    })

    expect(inputCounts).toEqual([4, 3])
    expect(run.results.get(dead.outpoint)).toMatchObject({ kind: 'skipped', reason: 'spentElsewhere' })
    for (const tip of four.filter((t) => t !== dead)) expect(run.results.get(tip.outpoint)?.kind).toBe('funds')
  })

  it('aborts the action when signing fails, so no phantom item is left listed', async () => {
    // An unsigned action still lists its `1sat` output until background review
    // fails it — that is the collectable that appeared and then vanished.
    createAction.mockResolvedValue({
      signableTransaction: { reference: 'ref-1', tx: TIPS[0]!.beef },
    })
    const { migrateChosenPhraseItems } = await import('./phraseSweep')
    const run = await migrateChosenPhraseItems({ items: chosen.slice(0, 1) })

    expect(run.results.get(TIPS[0]!.outpoint)?.kind).toBe('failed')
    expect(abortAction).toHaveBeenCalledWith({ reference: 'ref-1' })
  })
})

describe('pending per-address import cursor', () => {
  beforeEach(() => {
    vi.resetModules()
    stored.clear()
  })

  it('removes a forgotten cursor and immediately clears Activity subscribers', async () => {
    stored.set(
      accountLocalKey('handcash.brc100.phraseSweepItemCursor.v1'),
      JSON.stringify({
        sourceAddress: PHRASE_KEY.toAddress(),
        destIdentityKey: '02'.repeat(33),
        offset: 465,
        moved: 465,
        failed: 0,
      }),
    )
    const {
      clearPhraseItemMigrateCursor,
      peekPhraseItemMigrateCursor,
      subscribePhraseItemMigrateCursor,
    } = await import('./phraseSweep')
    const seen: unknown[] = []
    const unsubscribe = subscribePhraseItemMigrateCursor((value) => seen.push(value))

    clearPhraseItemMigrateCursor()

    expect(peekPhraseItemMigrateCursor()).toBeNull()
    expect(seen.at(-1)).toBeNull()
    unsubscribe()
  })
})

describe('itemOutputVouts', () => {
  it('reads each tip’s new output from the signed transaction, skipping change', async () => {
    const { itemOutputVouts } = await import('./phraseSweep')
    const dest = new P2PKH().lock(PrivateKey.fromRandom().toAddress())
    const change = new P2PKH().lock(PrivateKey.fromRandom().toAddress())
    const signed = new Transaction()
    signed.addOutput({ lockingScript: change, satoshis: 4_000 })
    signed.addOutput({ lockingScript: dest, satoshis: 1 })
    signed.addOutput({ lockingScript: dest, satoshis: 1 })
    expect(itemOutputVouts(signed, dest.toHex(), 2)).toEqual([1, 2])
    expect(itemOutputVouts(signed, dest.toHex(), 3)).toEqual([])
    expect(itemOutputVouts(null, dest.toHex(), 2)).toEqual([])
  })
})
