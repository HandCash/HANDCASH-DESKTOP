import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActiveWallet } from './session'

const store = new Map<string, string>()

const mockScanLegacyAddress = vi.fn()
const mockImportLegacyUtxos = vi.fn()
const mockClassifyLegacyUtxos = vi.fn()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
  },
}))

const mockTxExistsOnChain = vi.fn(async (): Promise<boolean | null> => null)
const mockShouldYield = vi.fn(() => false)

vi.mock('./walletCoordinator', () => ({
  shouldYieldChainIngestToSpend: () => mockShouldYield(),
}))

vi.mock('./legacyScan', () => ({
  scanLegacyAddress: (...args: unknown[]) => mockScanLegacyAddress(...args),
  importLegacyUtxos: (...args: unknown[]) => mockImportLegacyUtxos(...args),
  txExistsOnChain: () => mockTxExistsOnChain(),
}))

vi.mock('./oneSatImport', () => ({
  classifyLegacyUtxos: (...args: unknown[]) => mockClassifyLegacyUtxos(...args),
  importOneSatOrdinals: vi.fn(async () => ({
    imported: 0,
    failed: 0,
    errors: [],
    outpoints: [],
  })),
  importOneSatLatches: vi.fn(async () => ({
    imported: 0,
    failed: 0,
    errors: [],
    outpoints: [],
  })),
  contentUrlForOrigin: (origin: string) => `https://example.test/content/${origin}`,
}))

vi.mock('./fungibles', () => ({
  importBsv21Tokens: vi.fn(async (items: Array<{ outpoint: string }>) => ({
    imported: items.length,
    failed: 0,
    errors: [],
    outpoints: items.map((i) => i.outpoint),
  })),
}))

const OUTPOINT = 'bb.0'
const SWEEP_TXID = 'c'.repeat(64)
const FUNDING = { outpoint: OUTPOINT, txid: 'bb', vout: 0, satoshis: 5000 }

describe('ingestLegacyAddressUtxos receive activity', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
    mockScanLegacyAddress.mockReset()
    mockImportLegacyUtxos.mockReset()
    mockClassifyLegacyUtxos.mockReset()
    mockShouldYield.mockReturnValue(false)

    mockScanLegacyAddress.mockResolvedValue({
      address: 'addr',
      chain: 'main' as const,
      sats: 5000,
      utxos: [FUNDING],
      source: 'whatsonchain' as const,
    })
    mockClassifyLegacyUtxos.mockResolvedValue({
      funding: [FUNDING],
      oneSats: [],
      bsv21: [],
      latches: [],
      heldOneSats: [],
      pendingTips: [],
    })
  })

  const active = { chain: 'main', wallet: {}, address: '1abc' } as unknown as ActiveWallet

  it('writes a Received activity row for each newly swept payment', async () => {
    mockImportLegacyUtxos.mockResolvedValue({
      imported: 1,
      failed: 0,
      errors: [],
      skippedOneSats: 0,
      skippedKnown: 0,
      importedOutpoints: [OUTPOINT],
      importedReceipts: [
        { outpoint: OUTPOINT, satoshis: 5000, receiveTxid: 'bb', sweepTxid: SWEEP_TXID },
      ],
    })

    const { ingestLegacyAddressUtxos } = await import('./ingestLegacyAddress')
    await ingestLegacyAddressUtxos({ active })

    const { listRecentActivity } = await import('./appActivity')
    const entries = listRecentActivity(10)
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'earned',
          method: 'receive',
          sats: 5000,
          txid: 'bb',
          note: 'Received coins',
        }),
      ]),
    )
  })

  it('does not duplicate a receive already logged for that txid', async () => {
    const { recordAppActivity, WALLET_ACTIVITY_ORIGIN, listRecentActivity } =
      await import('./appActivity')
    recordAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'earned',
      sats: 5000,
      method: 'receive',
      txid: 'bb',
    })

    mockImportLegacyUtxos.mockResolvedValue({
      imported: 1,
      failed: 0,
      errors: [],
      skippedOneSats: 0,
      skippedKnown: 0,
      importedOutpoints: [OUTPOINT],
      importedReceipts: [
        { outpoint: OUTPOINT, satoshis: 5000, receiveTxid: 'bb', sweepTxid: SWEEP_TXID },
      ],
    })

    const { ingestLegacyAddressUtxos } = await import('./ingestLegacyAddress')
    await ingestLegacyAddressUtxos({ active })

    const receives = listRecentActivity(20).filter((e) => e.txid === 'bb')
    expect(receives).toHaveLength(1)
  })

  it('still records a receive when the same txid was already logged as a send (self-pay)', async () => {
    const { recordAppActivity, WALLET_ACTIVITY_ORIGIN, listRecentActivity } =
      await import('./appActivity')
    recordAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'spent',
      sats: 5000,
      method: 'send',
      txid: 'bb',
      note: 'Sent to self',
    })

    mockImportLegacyUtxos.mockResolvedValue({
      imported: 1,
      failed: 0,
      errors: [],
      skippedOneSats: 0,
      skippedKnown: 0,
      importedOutpoints: [OUTPOINT],
      importedReceipts: [
        { outpoint: OUTPOINT, satoshis: 5000, receiveTxid: 'bb', sweepTxid: SWEEP_TXID },
      ],
    })

    const { ingestLegacyAddressUtxos } = await import('./ingestLegacyAddress')
    await ingestLegacyAddressUtxos({ active })

    const forTx = listRecentActivity(20).filter((e) => e.txid === 'bb')
    expect(forTx).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'spent', method: 'send' }),
        expect.objectContaining({ kind: 'earned', method: 'receive', sats: 5000 }),
      ]),
    )
  })

  it('does not re-sweep outs already marked imported', async () => {
    mockImportLegacyUtxos.mockResolvedValue({
      imported: 0,
      failed: 0,
      errors: [],
      skippedOneSats: 0,
      skippedKnown: 1,
      importedOutpoints: [],
      importedReceipts: [],
    })

    const { ingestLegacyAddressUtxos } = await import('./ingestLegacyAddress')
    const result = await ingestLegacyAddressUtxos({ active })

    expect(mockImportLegacyUtxos).toHaveBeenCalledTimes(1)
    expect(result.importedFunding).toBe(0)
    expect(result.fundingSkippedKnown).toBe(1)
  })

  it('re-sweeps when the recorded sweep tx is provably absent', async () => {
    // The sweep is queued in delayed mode, so a reported success only means the
    // toolbox accepted it. When it never reached a miner the deposit sits unspent
    // behind a permanent mark, and nothing else in the wallet can free it.
    const { markLegacyImported } = await import('./legacyImportGuard')
    markLegacyImported([{ outpoint: OUTPOINT, txid: SWEEP_TXID }])
    // Age the mark past SWEEP_RETRY_MS.
    vi.setSystemTime(Date.now() + 20 * 60_000)
    mockTxExistsOnChain.mockResolvedValue(false)
    mockImportLegacyUtxos.mockResolvedValue({
      imported: 0,
      failed: 0,
      errors: [],
      skippedOneSats: 0,
      skippedKnown: 1,
      importedOutpoints: [],
      importedReceipts: [],
    })

    const { ingestLegacyAddressUtxos } = await import('./ingestLegacyAddress')
    await ingestLegacyAddressUtxos({ active })

    expect(mockImportLegacyUtxos).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('skips the address scan when a send is waiting', async () => {
    mockShouldYield.mockReturnValue(true)
    const { ingestLegacyAddressUtxos } = await import('./ingestLegacyAddress')
    const result = await ingestLegacyAddressUtxos({ active })
    expect(mockScanLegacyAddress).not.toHaveBeenCalled()
    expect(result.importedFunding).toBe(0)
    expect(result.scan.utxos).toEqual([])
  })

  it('still scans when fundingOnly even if a send is waiting', async () => {
    mockShouldYield.mockReturnValue(true)
    mockScanLegacyAddress.mockResolvedValue({
      address: 'addr',
      chain: 'main' as const,
      sats: 0,
      utxos: [],
      source: 'whatsonchain' as const,
    })
    const { ingestLegacyAddressUtxos } = await import('./ingestLegacyAddress')
    await ingestLegacyAddressUtxos({ active, fundingOnly: true })
    expect(mockScanLegacyAddress).toHaveBeenCalledTimes(1)
  })

  it('leaves the mark alone when the sweep tx does exist', async () => {
    const { markLegacyImported } = await import('./legacyImportGuard')
    markLegacyImported([{ outpoint: OUTPOINT, txid: SWEEP_TXID }])
    vi.setSystemTime(Date.now() + 20 * 60_000)
    mockTxExistsOnChain.mockResolvedValue(true)
    mockImportLegacyUtxos.mockResolvedValue({
      imported: 0,
      failed: 0,
      errors: [],
      skippedOneSats: 0,
      skippedKnown: 1,
      importedOutpoints: [],
      importedReceipts: [],
    })

    const { ingestLegacyAddressUtxos } = await import('./ingestLegacyAddress')
    await ingestLegacyAddressUtxos({ active })

    expect(mockImportLegacyUtxos).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('writes a Received activity row for newly imported BSV-21 tips', async () => {
    const tipOp = `${'aa'.repeat(32)}.0`
    const tokenId = `${'aa'.repeat(32)}_0`
    mockScanLegacyAddress.mockResolvedValue({
      address: 'addr',
      chain: 'main' as const,
      sats: 1,
      utxos: [{ outpoint: tipOp, txid: 'aa'.repeat(32), vout: 0, satoshis: 1 }],
      source: 'whatsonchain' as const,
    })
    mockClassifyLegacyUtxos.mockResolvedValue({
      funding: [],
      oneSats: [],
      bsv21: [
        {
          outpoint: tipOp,
          txid: 'aa'.repeat(32),
          vout: 0,
          tokenId,
          amt: '1000',
          op: 'mint',
          sym: 'DEMO',
        },
      ],
      latches: [],
      heldOneSats: [],
      pendingTips: [],
    })
    mockImportLegacyUtxos.mockResolvedValue({
      imported: 0,
      failed: 0,
      errors: [],
      skippedOneSats: 0,
      skippedKnown: 0,
      importedOutpoints: [],
      importedReceipts: [],
    })

    const { ingestLegacyAddressUtxos } = await import('./ingestLegacyAddress')
    await ingestLegacyAddressUtxos({ active })

    const { listRecentActivity, isTokenActivity } = await import('./appActivity')
    const tokenRow = listRecentActivity(10).find((e) => e.method === 'mint-token')
    expect(tokenRow).toMatchObject({
      kind: 'earned',
      method: 'mint-token',
      note: 'Minted 1,000 DEMO',
      txid: 'aa'.repeat(32),
      item: expect.objectContaining({
        name: 'DEMO',
        tokenId,
        outpoint: tipOp,
        amt: '1000',
      }),
    })
    expect(tokenRow && isTokenActivity(tokenRow)).toBe(true)
  })
})
