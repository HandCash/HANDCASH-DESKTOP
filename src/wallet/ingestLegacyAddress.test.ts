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

vi.mock('./legacyScan', () => ({
  scanLegacyAddress: (...args: unknown[]) => mockScanLegacyAddress(...args),
  importLegacyUtxos: (...args: unknown[]) => mockImportLegacyUtxos(...args),
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

describe('ingestLegacyAddressUtxos receive activity', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
    mockScanLegacyAddress.mockReset()
    mockImportLegacyUtxos.mockReset()
    mockClassifyLegacyUtxos.mockReset()

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
      latches: [],
      heldOneSats: [],
    })
  })

  const active = { chain: 'main', wallet: {} } as unknown as ActiveWallet

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
})
