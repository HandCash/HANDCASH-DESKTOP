import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Beef, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
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

vi.mock('./legacyBeef', () => ({
  buildLegacyInputBeef: async (_svc: unknown, outpoints: string[]) => {
    const merged = new Beef()
    for (const op of outpoints) merged.mergeBeef(beefByTxid.get(op.split('.')[0] ?? '')!)
    return { ready: outpoints, beef: merged.toBinary(), failures: [] }
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
