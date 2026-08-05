import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActiveWallet } from './session'

const store = new Map<string, string>()

const mockScanLegacyAddress = vi.fn()
const mockImportLegacyUtxos = vi.fn()
const mockTxExistsOnChain = vi.fn()
const mockClassifyLegacyUtxos = vi.fn()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
  },
}))

vi.mock('./legacyScan', () => ({
  scanLegacyAddress: (...args: unknown[]) => mockScanLegacyAddress(...args),
  importLegacyUtxos: (...args: unknown[]) => mockImportLegacyUtxos(...args),
  txExistsOnChain: (...args: unknown[]) => mockTxExistsOnChain(...args),
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

const OUTPOINT = 'bb.0'
const SWEEP_TXID = 'c'.repeat(64)
const FUNDING = { outpoint: OUTPOINT, txid: 'bb', vout: 0, satoshis: 5000 }

/** A scan that still lists the swept input as unspent — the indexer is behind. */
function staleScan() {
  return {
    address: 'addr',
    chain: 'main' as const,
    sats: 5000,
    utxos: [FUNDING],
    source: 'whatsonchain' as const,
  }
}

function alreadySwept() {
  return {
    imported: 0,
    failed: 0,
    errors: [],
    skippedOneSats: 0,
    skippedKnown: 1,
    importedOutpoints: [],
    importedReceipts: [],
  }
}

describe('ingestLegacyAddressUtxos stuck-sweep retry', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
    mockScanLegacyAddress.mockReset()
    mockImportLegacyUtxos.mockReset()
    mockTxExistsOnChain.mockReset()
    mockClassifyLegacyUtxos.mockReset()

    mockScanLegacyAddress.mockResolvedValue(staleScan())
    mockClassifyLegacyUtxos.mockResolvedValue({
      funding: [FUNDING],
      oneSats: [],
      latches: [],
      heldOneSats: [],
    })
    mockImportLegacyUtxos.mockResolvedValue(alreadySwept())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // Only `chain` is read on this path; the sweep itself is mocked.
  const active = { chain: 'main', wallet: {} } as unknown as ActiveWallet

  async function markSweptAt(at: number, txid?: string) {
    const guard = await import('./legacyImportGuard')
    vi.useFakeTimers()
    vi.setSystemTime(at)
    guard.markLegacyImported([txid ? { outpoint: OUTPOINT, txid } : OUTPOINT])
    vi.useRealTimers()
    return guard
  }

  it('does not sweep again while the first sweep transaction is on chain', async () => {
    await markSweptAt(Date.now() - 60 * 60_000, SWEEP_TXID)
    mockTxExistsOnChain.mockResolvedValue(true)

    const { ingestLegacyAddressUtxos } = await import('./ingestLegacyAddress')
    const result = await ingestLegacyAddressUtxos({ active })

    expect(mockTxExistsOnChain).toHaveBeenCalledWith(SWEEP_TXID, 'main')
    expect(mockImportLegacyUtxos).toHaveBeenCalledTimes(1)
    expect(result.importedFunding).toBe(0)
  })

  it('does not sweep again inside the retry window even without a sweep txid', async () => {
    await markSweptAt(Date.now())

    const { ingestLegacyAddressUtxos } = await import('./ingestLegacyAddress')
    await ingestLegacyAddressUtxos({ active })

    expect(mockImportLegacyUtxos).toHaveBeenCalledTimes(1)
    expect(mockTxExistsOnChain).not.toHaveBeenCalled()
  })

  it('holds the mark when the provider cannot confirm the sweep transaction', async () => {
    await markSweptAt(Date.now() - 60 * 60_000, SWEEP_TXID)
    mockTxExistsOnChain.mockResolvedValue(null)

    const { ingestLegacyAddressUtxos } = await import('./ingestLegacyAddress')
    await ingestLegacyAddressUtxos({ active })

    expect(mockImportLegacyUtxos).toHaveBeenCalledTimes(1)
  })

  it('retries a stale sweep whose transaction never landed', async () => {
    await markSweptAt(Date.now() - 60 * 60_000, SWEEP_TXID)
    mockTxExistsOnChain.mockResolvedValue(false)
    mockImportLegacyUtxos.mockResolvedValueOnce(alreadySwept()).mockResolvedValueOnce({
      imported: 1,
      failed: 0,
      errors: [],
      skippedOneSats: 0,
      skippedKnown: 0,
      importedOutpoints: [OUTPOINT],
      importedReceipts: [
        {
          outpoint: OUTPOINT,
          satoshis: 5000,
          receiveTxid: 'bb',
          sweepTxid: SWEEP_TXID,
        },
      ],
    })

    const { ingestLegacyAddressUtxos } = await import('./ingestLegacyAddress')
    const result = await ingestLegacyAddressUtxos({ active })

    expect(mockImportLegacyUtxos).toHaveBeenCalledTimes(2)
    expect(result.importedFunding).toBe(1)
  })

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
          note: 'Received',
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
})
