import { describe, expect, it, vi, beforeEach } from 'vitest'
import { LockingScript, P2PKH, PrivateKey, Transaction, Beef } from '@bsv/sdk'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

const mockImportLegacyUtxos = vi.fn()
vi.mock('./legacyScan', () => ({
  importLegacyUtxos: (...args: unknown[]) => mockImportLegacyUtxos(...args),
}))

const mockGetBeef = vi.fn()
vi.mock('./beefCache', () => ({
  getBeefForTxidCached: (...args: unknown[]) => mockGetBeef(...args),
}))

vi.mock('./toast', () => ({
  toastSuccess: vi.fn(),
}))

describe('ingestPaymentByTxid', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
    mockImportLegacyUtxos.mockReset()
    mockGetBeef.mockReset()
  })

  it('sweeps our P2PKH funding outs from BEEF and skips 1-sat + uneconomical dust', async () => {
    const root = PrivateKey.fromRandom()
    const address = root.toPublicKey().toAddress('mainnet')
    const other = PrivateKey.fromRandom().toPublicKey().toAddress('mainnet')

    const tx = new Transaction()
    tx.addOutput({ satoshis: 5_000, lockingScript: new P2PKH().lock(address) })
    tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(address) })
    tx.addOutput({ satoshis: 2_000, lockingScript: new P2PKH().lock(other) })
    // Companion-style 2-sat: heldUneconomical, not funding (chooseLegacySweepPath).
    tx.addOutput({ satoshis: 2, lockingScript: new P2PKH().lock(address) })
    const txid = tx.id('hex')

    const beef = new Beef()
    beef.mergeRawTx(tx.toBinary())
    mockGetBeef.mockResolvedValue(beef)
    mockImportLegacyUtxos.mockResolvedValue({
      imported: 1,
      failed: 0,
      errors: [],
      skippedOneSats: 0,
      skippedUneconomical: 0,
      skippedKnown: 0,
      importedOutpoints: [`${txid}.0`],
      importedReceipts: [
        { outpoint: `${txid}.0`, satoshis: 5_000, receiveTxid: txid },
      ],
    })

    vi.doMock('./session', () => ({
      getActiveWallet: () => ({
        address,
        chain: 'main',
        rootKeyHex: root.toHex(),
        identityKey: root.toPublicKey().toString(),
        wallet: {
          balance: async () => ({ total: 5_000 }),
        },
        services: {},
      }),
      fetchBalanceSats: async () => 5_000,
    }))

    const { ingestPaymentByTxid } = await import('./ingestPaymentByTxid')
    const result = await ingestPaymentByTxid(txid)

    expect(result.imported).toBe(1)
    expect(result.satoshis).toBe(5_000)
    expect(mockImportLegacyUtxos).toHaveBeenCalledTimes(1)
    const [utxos] = mockImportLegacyUtxos.mock.calls[0] as [
      Array<{ outpoint: string; satoshis: number }>,
    ]
    expect(utxos.map((u) => u.outpoint)).toEqual([`${txid}.0`])
    // Only the sweep path reaches import — never 1-sat or sub-floor companions.
    expect(utxos.every((u) => u.satoshis >= 21)).toBe(true)
    expect(mockGetBeef).toHaveBeenCalledWith(
      expect.anything(),
      txid,
      expect.objectContaining({ allowUnprovenRawTx: true }),
    )
    // silence unused LockingScript import lint via side effect
    expect(LockingScript).toBeTruthy()
  })
})
