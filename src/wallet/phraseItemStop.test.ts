import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Beef, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'

/**
 * Destination change pays the fee for every collectable, so a large collection
 * can exhaust the wallet part-way through. That must end the run and keep the
 * cursor on the tip it did not reach — blaming the tip and grinding on would
 * report hundreds of identical "failures" and lose the resume point.
 */

const createAction = vi.fn()
const abortAction = vi.fn()
const refreshFromChain = vi.fn()
const stored = new Map<string, string>()

vi.mock('./spendGuard', () => ({
  runExclusiveSpend: (fn: () => Promise<unknown>) => fn(),
}))
vi.mock('./paymentPolicy', () => ({ assertOnlineForPayment: () => undefined }))
vi.mock('./appLog', () => ({ appendAppLog: vi.fn() }))
vi.mock('./chainIngest', () => ({
  refreshFromChain: (...a: unknown[]) => refreshFromChain(...a),
}))
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
    const txid = (outpoints[0] ?? '').split('.')[0] ?? ''
    const beef = beefByTxid.get(txid)
    if (!beef) return { ready: [], beef: [], failures: [{ reason: 'no beef' }] }
    return { ready: outpoints, beef, failures: [] }
  },
  withVisibleOnChainBeef: async <T,>(fn: () => Promise<T>) => fn(),
}))
vi.mock('./oneSatProvenance', () => ({
  buildInternalizeCustomInstructions: () => '{}',
}))

const CANDIDATE = {
  scheme: 'yours-wallet' as const,
  label: 'Yours wallet',
  path: "m/44'/236'/0'/1/0",
  rootKeyHex: '11'.repeat(32),
  identityKey: '03'.repeat(33),
  address: PHRASE_KEY.toAddress(),
}

describe('migratePhraseItemsBatch funds stop', () => {
  beforeEach(() => {
    vi.resetModules()
    stored.clear()
    createAction.mockReset()
    abortAction.mockReset()
    refreshFromChain.mockReset()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify(
            TIPS.map((t) => ({
              txid: t.txid,
              vout: 0,
              outpoint: t.outpoint,
              satoshis: 1,
              origin: { outpoint: t.outpoint },
              owner: CANDIDATE.address,
            })),
          ),
          { status: 200 },
        ),
      ),
    )
  })

  it('stops on insufficient funds and leaves the cursor on the unreached tip', async () => {
    const err = new Error(
      'Insufficient funds in the available inputs to cover the cost of the required outputs and the transaction fee (539816 more satoshis are needed, for a total of 539816)',
    )
    createAction.mockRejectedValue(err)

    const { migratePhraseItemsBatch, peekPhraseItemMigrateCursor } = await import(
      './phraseSweep'
    )
    const progress = await migratePhraseItemsBatch({
      candidate: CANDIDATE,
      batchSize: 2,
    })

    expect(progress.stopped).toBe('funds')
    expect(progress.done).toBe(false)
    expect(progress.moved).toBe(0)
    // The tip was never attempted to completion, so it must not be counted as
    // failed nor skipped over.
    expect(progress.failed).toBe(0)
    expect(progress.scanned).toBe(0)
    expect(peekPhraseItemMigrateCursor()?.offset).toBe(0)
    // One attempt, then stop — not once per remaining tip.
    expect(createAction).toHaveBeenCalledTimes(1)
  })

  it('aborts the action when signing fails, so no phantom item is left listed', async () => {
    // An unsigned action still lists its `1sat` output until background review
    // fails it — that is the collectable that appeared and then vanished.
    createAction.mockResolvedValue({
      signableTransaction: { reference: 'ref-1', tx: TIPS[0]!.beef },
    })

    const { migratePhraseItemsBatch } = await import('./phraseSweep')
    const progress = await migratePhraseItemsBatch({
      candidate: CANDIDATE,
      batchSize: 1,
    })

    expect(progress.failed).toBe(1)
    expect(progress.moved).toBe(0)
    expect(abortAction).toHaveBeenCalledWith({ reference: 'ref-1' })
  })
})
