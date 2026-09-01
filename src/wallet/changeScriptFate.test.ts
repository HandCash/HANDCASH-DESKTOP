import { beforeEach, describe, expect, it, vi } from 'vitest'
import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk'

const mockGetActiveWallet = vi.fn()

vi.mock('./session', () => ({
  getActiveWallet: () => mockGetActiveWallet(),
}))

const fetchRawTxHex = vi.fn()
const peekRawTxLookup = vi.fn(() => 'unknown' as 'hit' | 'miss' | 'unknown')
vi.mock('./oneSatImport', () => ({
  fetchRawTxHex: (txid: string, chain: string) => fetchRawTxHex(txid, chain),
  peekRawTxLookup: (txid: string) => peekRawTxLookup(txid),
}))

const { classifyChangeScript, findMatchingVout, hasLockingScript, isWalletChangeRow, resolveChangeRowOutpoint, sweepChangeScripts, txidFromTxRow, walletChangeLockingScript } =
  await import('./changeScriptFate')

/** A one-output tx we can point a change row at. */
function fixtureTx(satoshis: number): Transaction {
  const address = PrivateKey.fromRandom().toPublicKey().toAddress('mainnet')
  const tx = new Transaction()
  tx.addOutput({ lockingScript: new P2PKH().lock(address), satoshis })
  return tx
}

describe('classifyChangeScript', () => {
  it('leaves a row that already has a script alone', () => {
    expect(classifyChangeScript({ lockingScript: [118, 169] }, null)).toEqual({
      kind: 'scripted',
    })
    expect(classifyChangeScript({ lockingScript: '76a914' }, null)).toEqual({
      kind: 'scripted',
    })
  })

  it('rebuilds the script from the raw tx that created the output', () => {
    const tx = fixtureTx(4321)
    const fate = classifyChangeScript(
      { txid: tx.id('hex'), vout: 0, satoshis: 4321 },
      tx.toBinary(),
    )
    expect(fate.kind).toBe('heal')
    if (fate.kind !== 'heal') return
    expect(fate.lockingScript).toEqual(tx.outputs[0].lockingScript.toBinary())
  })

  it('refuses a script whose satoshis do not match the row', () => {
    const tx = fixtureTx(4321)
    expect(
      classifyChangeScript(
        { txid: tx.id('hex'), vout: 0, satoshis: 9999 },
        tx.toBinary(),
      ),
    ).toEqual({ kind: 'refuse', reason: 'satoshis-mismatch' })
  })

  it('refuses a vout the raw tx does not have', () => {
    const tx = fixtureTx(4321)
    expect(
      classifyChangeScript(
        { txid: tx.id('hex'), vout: 3, satoshis: 4321 },
        tx.toBinary(),
      ),
    ).toEqual({ kind: 'refuse', reason: 'vout-missing' })
  })

  it('refuses rows with no usable outpoint or no raw tx', () => {
    expect(classifyChangeScript({ vout: 0, satoshis: 1 }, null)).toEqual({
      kind: 'refuse',
      reason: 'no-outpoint',
    })
    expect(
      classifyChangeScript({ txid: 'a'.repeat(64), vout: 0, satoshis: 1 }, null),
    ).toEqual({ kind: 'refuse', reason: 'no-rawtx' })
  })
})

describe('resolveChangeRowOutpoint', () => {
  it('fills txid and vout from a parent transaction row', () => {
    const tx = fixtureTx(9000)
    const resolved = resolveChangeRowOutpoint(
      { change: true, spendable: false, transactionId: 42, satoshis: 9000 },
      { txid: tx.id('hex'), rawTx: tx.toBinary(), status: 'completed' },
    )
    expect(resolved?.txid).toBe(tx.id('hex'))
    expect(resolved?.vout).toBe(0)
    expect(txidFromTxRow({ rawTx: tx.toBinary() })).toBe(tx.id('hex'))
    expect(findMatchingVout(tx.toBinary(), 9000)).toBe(0)
  })
})

describe('hasLockingScript', () => {
  it('treats empty and missing scripts alike', () => {
    expect(hasLockingScript({ lockingScript: undefined })).toBe(false)
    expect(hasLockingScript({ lockingScript: [] })).toBe(false)
    expect(hasLockingScript({ lockingScript: '' })).toBe(false)
    expect(hasLockingScript({ lockingScript: new Uint8Array([1]) })).toBe(true)
  })
})

describe('isWalletChangeRow', () => {
  it('treats change flag and multi-sat rows as wallet change', () => {
    expect(isWalletChangeRow({ change: true, satoshis: 1 })).toBe(true)
    expect(isWalletChangeRow({ change: false, satoshis: 500 })).toBe(true)
    expect(isWalletChangeRow({ change: false, satoshis: 1 })).toBe(false)
  })
})

describe('sweepChangeScripts', () => {
  const walletAddress = PrivateKey.fromRandom().toPublicKey().toAddress('mainnet')
  const walletScript = new P2PKH().lock(walletAddress).toBinary()
  const findOutputs = vi.fn()
  const getProvenOrRawTx = vi.fn()
  const findTransactions = vi.fn()
  const updateOutput = vi.fn()

  beforeEach(() => {
    findOutputs.mockReset()
    getProvenOrRawTx.mockReset()
    findTransactions.mockReset()
    updateOutput.mockReset()
    fetchRawTxHex.mockReset()
    peekRawTxLookup.mockReset()
    peekRawTxLookup.mockReturnValue('unknown')
    getProvenOrRawTx.mockResolvedValue({})
    findTransactions.mockResolvedValue([])
    updateOutput.mockResolvedValue(1)
    mockGetActiveWallet.mockReset()
    mockGetActiveWallet.mockReturnValue({
      chain: 'main',
      address: walletAddress,
      wallet: {
        storage: {
          runAsStorageProvider: async <T>(fn: (sp: unknown) => Promise<T>) =>
            fn({ findOutputs, getProvenOrRawTx, findTransactions, updateOutput }),
        },
      },
    })
  })

  /** Answer paged scans: page 0 of spendable rows, then nothing. */
  function pageOnce(spendableRows: unknown[], deadRows: unknown[] = []) {
    findOutputs.mockImplementation(
      async (args: {
        partial: { spendable: boolean }
        paged: { offset: number }
      }) => {
        if (args.paged.offset > 0) return []
        return args.partial.spendable ? spendableRows : deadRows
      },
    )
  }

  it('rebuilds from local raw tx without touching spendable', async () => {
    const tx = fixtureTx(500)
    pageOnce([
      {
        outputId: 11,
        change: true,
        spendable: true,
        txid: tx.id('hex'),
        vout: 0,
        satoshis: 500,
      },
    ])
    getProvenOrRawTx.mockResolvedValue({ rawTx: tx.toBinary() })

    const r = await sweepChangeScripts()

    expect(r.healed).toBe(1)
    expect(r.quarantined).toBe(0)
    expect(updateOutput).toHaveBeenCalledExactlyOnceWith(11, {
      lockingScript: tx.outputs[0].lockingScript.toBinary(),
    })
  })

  it('heals rows that only have transactionId after BRC-39 restore', async () => {
    const tx = fixtureTx(9000)
    pageOnce([], [
      {
        outputId: 20,
        change: true,
        spendable: false,
        transactionId: 42,
        satoshis: 9000,
      },
    ])
    findTransactions.mockImplementation(async (args: { partial?: { transactionId?: number } }) => {
      if (args.partial?.transactionId === 42) {
        return [{ txid: tx.id('hex'), rawTx: tx.toBinary(), status: 'completed' }]
      }
      return []
    })

    const r = await sweepChangeScripts()

    expect(r.healed).toBe(1)
    expect(updateOutput).toHaveBeenCalledExactlyOnceWith(20, {
      lockingScript: tx.outputs[0].lockingScript.toBinary(),
    })
  })

  it('assigns wallet P2PKH when a change row has no outpoint after BRC-39 restore', async () => {
    pageOnce([
      { outputId: 12, change: true, spendable: true, satoshis: 500 },
    ])

    const r = await sweepChangeScripts()

    expect(r.healed).toBe(1)
    expect(r.addressFallback).toBe(1)
    expect(r.quarantined).toBe(0)
    expect(r.refused).toBe(0)
    expect(updateOutput).toHaveBeenCalledExactlyOnceWith(12, {
      lockingScript: walletScript,
    })
  })

  it('quarantines a change row when address fallback is unavailable', async () => {
    mockGetActiveWallet.mockReturnValue({
      chain: 'main',
      wallet: {
        storage: {
          runAsStorageProvider: async <T>(fn: (sp: unknown) => Promise<T>) =>
            fn({ findOutputs, getProvenOrRawTx, findTransactions, updateOutput }),
        },
      },
    })
    pageOnce([
      { outputId: 12, change: true, spendable: true, satoshis: 500 },
    ])

    const r = await sweepChangeScripts()

    expect(r.refused).toBe(1)
    expect(r.quarantined).toBe(1)
    expect(updateOutput).toHaveBeenCalledExactlyOnceWith(12, {
      spendable: false,
      spentBy: undefined,
    })
  })

  it('leaves scripted rows and non-change rows alone', async () => {
    pageOnce([
      { outputId: 13, change: true, spendable: true, lockingScript: [118] },
      { outputId: 14, change: false, spendable: true },
    ])

    const r = await sweepChangeScripts()

    expect(r.healed + r.quarantined + r.refused).toBe(0)
    expect(updateOutput).not.toHaveBeenCalled()
  })

  it('only reaches the chain when asked, and rebuilds written-off rows too', async () => {
    const tx = fixtureTx(700)
    pageOnce([], [
      {
        outputId: 15,
        change: true,
        spendable: false,
        txid: tx.id('hex'),
        vout: 0,
        satoshis: 700,
      },
    ])

    await sweepChangeScripts({ fromChain: false })
    expect(fetchRawTxHex).not.toHaveBeenCalled()
    expect(updateOutput).not.toHaveBeenCalled()

    fetchRawTxHex.mockResolvedValue(tx.toHex())
    const r = await sweepChangeScripts({ fromChain: true })

    expect(fetchRawTxHex).toHaveBeenCalledWith(tx.id('hex'), 'main')
    expect(r.healed).toBe(1)
    expect(updateOutput).toHaveBeenCalledExactlyOnceWith(15, {
      lockingScript: tx.outputs[0].lockingScript.toBinary(),
    })
  })

  it('pages past the first window so late poison rows are still found', async () => {
    const early = Array.from({ length: 200 }, (_, i) => ({
      outputId: i + 1,
      change: true,
      spendable: true,
      lockingScript: [118],
    }))
    findOutputs.mockImplementation(
      async (args: {
        partial: { spendable: boolean }
        paged: { offset: number }
      }) => {
        if (!args.partial.spendable) return []
        if (args.paged.offset === 0) return early
        if (args.paged.offset === 200) {
          return [{ outputId: 999, change: true, spendable: true, satoshis: 500 }]
        }
        return []
      },
    )

    const r = await sweepChangeScripts()

    expect(r.scanned).toBe(201)
    expect(r.healed).toBe(1)
    expect(r.addressFallback).toBe(1)
    expect(updateOutput).toHaveBeenCalledExactlyOnceWith(999, {
      lockingScript: walletScript,
    })
  })

  it('does not refetch a known miss for spendable rows', async () => {
    const tx = fixtureTx(500)
    peekRawTxLookup.mockReturnValue('miss')
    pageOnce([
      {
        outputId: 16,
        change: true,
        spendable: true,
        txid: tx.id('hex'),
        vout: 0,
        satoshis: 500,
      },
    ])

    const r = await sweepChangeScripts({ fromChain: true })

    expect(fetchRawTxHex).not.toHaveBeenCalled()
    expect(r.quarantined).toBe(1)
  })

  it('does nothing without an unlocked wallet', async () => {
    mockGetActiveWallet.mockReturnValue(null)
    await expect(sweepChangeScripts()).resolves.toEqual({
      scanned: 0,
      healed: 0,
      quarantined: 0,
      refused: 0,
    })
  })
})
