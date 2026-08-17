import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Third-party apps park small companion outputs next to a 1-sat ordinal. Those
 * carry less than the fee their own sweep costs, so every broadcaster rejects
 * them — and a network rejection is treated as transient, so they used to be
 * rebuilt and re-rejected on every scan forever.
 */

const sweepVisibleP2pkhOutpoints = vi.fn()
const beginLegacyImport = vi.fn((ops: string[]) => ops)
const markLegacyImported = vi.fn()
const releaseLegacyImport = vi.fn()
const buildLegacyInputBeef = vi.fn()

vi.mock('./session', () => ({
  getActiveWallet: () => ({ chain: 'main', services: {}, wallet: {} }),
}))

vi.mock('./legacyImportGuard', () => ({
  beginLegacyImport: (ops: string[]) => beginLegacyImport(ops),
  markLegacyImported: (rows: unknown) => markLegacyImported(rows),
  releaseLegacyImport: (ops: unknown) => releaseLegacyImport(ops),
}))

vi.mock('./legacyBeef', () => ({
  buildLegacyInputBeef: (...args: unknown[]) => buildLegacyInputBeef(...args),
}))

vi.mock('./importP2pkhFunding', () => ({
  sweepVisibleP2pkhOutpoints: (...args: unknown[]) =>
    sweepVisibleP2pkhOutpoints(...args),
}))

const { importLegacyUtxos, MIN_SWEEPABLE_SATS } = await import('./legacyScan')

const utxo = (vout: number, satoshis: number) => ({
  outpoint: `${'ab'.repeat(32)}.${vout}`,
  txid: 'ab'.repeat(32),
  vout,
  satoshis,
})

beforeEach(() => {
  sweepVisibleP2pkhOutpoints.mockReset()
  beginLegacyImport.mockReset()
  beginLegacyImport.mockImplementation((ops: string[]) => ops)
  markLegacyImported.mockReset()
  releaseLegacyImport.mockReset()
  buildLegacyInputBeef.mockReset()
  buildLegacyInputBeef.mockImplementation(async (_services, ops: string[]) => ({
    ready: ops,
    beef: [1, 2, 3],
    failures: [],
  }))
})

describe('MIN_SWEEPABLE_SATS', () => {
  it('covers the fee a one-input sweep owes at ARC 100 sat/kb, plus the dust floor', () => {
    // ~193 bytes at 100 satoshis per 1000 bytes is 20 sats of fee.
    expect(MIN_SWEEPABLE_SATS).toBe(21)
  })
})

describe('importLegacyUtxos economic floor', () => {
  it('holds a 2-sat companion output instead of sweeping it forever', async () => {
    const result = await importLegacyUtxos([utxo(1, 2)])

    expect(result.skippedUneconomical).toBe(1)
    expect(result.imported).toBe(0)
    expect(result.failed).toBe(0)
    expect(sweepVisibleP2pkhOutpoints).not.toHaveBeenCalled()
    // Never marked known: the coins are still there if the floor ever changes.
    expect(markLegacyImported).not.toHaveBeenCalled()
  })

  it('still refuses 1-sat outputs as possible ordinals, not as uneconomical', async () => {
    const result = await importLegacyUtxos([utxo(0, 1)])

    expect(result.skippedOneSats).toBe(1)
    expect(result.skippedUneconomical).toBe(0)
    expect(sweepVisibleP2pkhOutpoints).not.toHaveBeenCalled()
  })

  it('sweeps a real deposit and leaves the dust behind in the same pass', async () => {
    sweepVisibleP2pkhOutpoints.mockResolvedValue([
      { outpoint: `${'ab'.repeat(32)}.3`, success: true, txid: 'cd'.repeat(32) },
    ])

    const result = await importLegacyUtxos([utxo(0, 1), utxo(1, 2), utxo(3, 60)])

    expect(result.imported).toBe(1)
    expect(result.skippedOneSats).toBe(1)
    expect(result.skippedUneconomical).toBe(1)
    const [, offered] = buildLegacyInputBeef.mock.calls[0] as [unknown, string[]]
    expect(offered).toEqual([`${'ab'.repeat(32)}.3`])
  })

  it('sweeps an output sitting exactly on the floor', async () => {
    sweepVisibleP2pkhOutpoints.mockResolvedValue([
      { outpoint: `${'ab'.repeat(32)}.1`, success: true, txid: 'cd'.repeat(32) },
    ])

    const result = await importLegacyUtxos([utxo(1, MIN_SWEEPABLE_SATS)])

    expect(result.skippedUneconomical).toBe(0)
    expect(result.imported).toBe(1)
  })
})
