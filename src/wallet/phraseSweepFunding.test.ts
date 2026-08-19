import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A foreign phrase reaches `importLegacyUtxos` through the same durable import
 * guard as our own address. A stale mark therefore reported "no sweepable BSV"
 * on an address the preview had just valued at 6.2M sats.
 */

const importLegacyUtxos = vi.fn()
const retryableStuckSweeps = vi.fn()
const forgetLegacyImported = vi.fn()
const recordFundingReceipts = vi.fn()
const legacySweepRecord = vi.fn<(op: string) => { at: number; txid?: string } | null>(
  () => null,
)

vi.mock('./legacyScan', () => ({
  importLegacyUtxos: (...args: unknown[]) => importLegacyUtxos(...args),
  scanAddressViaBitails: vi.fn(),
  scanAddressViaWhatsOnChain: vi.fn(),
}))
vi.mock('./legacyStuckSweep', () => ({
  retryableStuckSweeps: (...args: unknown[]) => retryableStuckSweeps(...args),
}))
vi.mock('./legacyImportGuard', () => ({
  forgetLegacyImported: (...args: unknown[]) => forgetLegacyImported(...args),
  legacySweepRecord: (op: string) => legacySweepRecord(op),
}))
vi.mock('./legacyReceiptActivity', () => ({
  recordFundingReceipts: (...args: unknown[]) => recordFundingReceipts(...args),
  recordMigratedItemActivity: vi.fn(),
}))
vi.mock('./spendGuard', () => ({
  runExclusiveSpend: (fn: () => Promise<unknown>) => fn(),
}))
vi.mock('./paymentPolicy', () => ({ assertOnlineForPayment: () => undefined }))
vi.mock('./appLog', () => ({ appendAppLog: vi.fn() }))
vi.mock('./chainIngest', () => ({ refreshFromChain: vi.fn() }))
vi.mock('./session', () => ({
  getActiveWallet: () => ({
    identityKey: '02'.repeat(33),
    address: '1DestinationAddress',
    chain: 'main',
  }),
}))
vi.mock('./durableStorage', () => ({
  durableGetItem: () => null,
  durableSetItem: () => true,
}))

const CANDIDATE = {
  scheme: 'yours-wallet' as const,
  label: 'Yours wallet',
  path: "m/44'/236'/0'/1/0",
  rootKeyHex: '11'.repeat(32),
  identityKey: '03'.repeat(33),
  address: '1KxnNdHSeAE8A1e1LPZs6Cpp8zDups79cj',
}

const FUNDING = [
  { outpoint: 'aa'.repeat(32) + '.0', txid: 'aa'.repeat(32), vout: 0, satoshis: 6_217_733 },
]

function importResult(over: Record<string, unknown> = {}) {
  return {
    imported: 0,
    failed: 0,
    errors: [],
    skippedOneSats: 0,
    skippedUneconomical: 0,
    skippedKnown: 0,
    importedOutpoints: [],
    importedReceipts: [],
    ...over,
  }
}

describe('sweepPhraseFunding stale import marks', () => {
  beforeEach(() => {
    vi.resetModules()
    importLegacyUtxos.mockReset()
    retryableStuckSweeps.mockReset()
    forgetLegacyImported.mockReset()
    recordFundingReceipts.mockReset()
    legacySweepRecord.mockReset()
    legacySweepRecord.mockReturnValue(null)
  })

  it('retries the sweep when the recorded sweep tx is provably missing', async () => {
    importLegacyUtxos
      .mockResolvedValueOnce(importResult({ skippedKnown: 1 }))
      .mockResolvedValueOnce(
        importResult({
          imported: 1,
          importedReceipts: [
            {
              outpoint: FUNDING[0]!.outpoint,
              satoshis: 6_217_733,
              receiveTxid: FUNDING[0]!.txid,
              sweepTxid: 'bb'.repeat(32),
            },
          ],
        }),
      )
    retryableStuckSweeps.mockResolvedValue([FUNDING[0]!.outpoint])

    const { sweepPhraseFunding } = await import('./phraseSweep')
    const result = await sweepPhraseFunding({
      mnemonic: 'x',
      candidate: CANDIDATE,
      utxos: FUNDING,
    })

    expect(forgetLegacyImported).toHaveBeenCalledWith([FUNDING[0]!.outpoint])
    expect(result.imported).toBe(1)
    expect(result.fundingSatsMoved).toBe(6_217_733)
    // Swept coins that never reach Activity read as a sweep that did nothing.
    expect(recordFundingReceipts).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ satoshis: 6_217_733 })]),
    )
  })

  it('reports already-swept rather than pretending there was no BSV', async () => {
    importLegacyUtxos.mockResolvedValue(importResult({ skippedKnown: 4 }))
    retryableStuckSweeps.mockResolvedValue([])

    const { sweepPhraseFunding } = await import('./phraseSweep')
    const result = await sweepPhraseFunding({
      mnemonic: 'x',
      candidate: CANDIDATE,
      utxos: FUNDING,
    })

    expect(forgetLegacyImported).not.toHaveBeenCalled()
    expect(result.alreadySwept).toBe(4)
    expect(importLegacyUtxos).toHaveBeenCalledTimes(1)
  })

  it('backfills Activity for a sweep that landed before receipts were recorded', async () => {
    importLegacyUtxos.mockResolvedValue(importResult({ skippedKnown: 1 }))
    retryableStuckSweeps.mockResolvedValue([])
    legacySweepRecord.mockReturnValue({ at: Date.now(), txid: 'cc'.repeat(32) })

    const { sweepPhraseFunding } = await import('./phraseSweep')
    await sweepPhraseFunding({ mnemonic: 'x', candidate: CANDIDATE, utxos: FUNDING })

    expect(recordFundingReceipts).toHaveBeenCalledWith([
      expect.objectContaining({
        outpoint: FUNDING[0]!.outpoint,
        satoshis: 6_217_733,
        receiveTxid: FUNDING[0]!.txid,
      }),
    ])
    // Backfilling a row must never re-spend the coins.
    expect(importLegacyUtxos).toHaveBeenCalledTimes(1)
  })

  it('does not invent Activity for a sweep with no recorded transaction', async () => {
    importLegacyUtxos.mockResolvedValue(importResult({ skippedKnown: 1 }))
    retryableStuckSweeps.mockResolvedValue([])

    const { sweepPhraseFunding } = await import('./phraseSweep')
    await sweepPhraseFunding({ mnemonic: 'x', candidate: CANDIDATE, utxos: FUNDING })

    expect(recordFundingReceipts).toHaveBeenCalledTimes(1)
    expect(recordFundingReceipts).toHaveBeenCalledWith([])
  })
})
