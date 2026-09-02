import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  collectActivityTxids: vi.fn(),
  getAppLogs: vi.fn(() => [] as { at: number; level: string; message: string }[]),
  getPreviousSessionLogs: vi.fn(
    () => [] as { at: number; level: string; message: string }[],
  ),
  runChangeHeal: vi.fn(),
  snapshotWalletBalance: vi.fn(),
  txExistsOnChain: vi.fn(),
  getActiveWallet: vi.fn(),
  releaseSpendAttemptFunds: vi.fn(),
  keepChangeOfSignedTx: vi.fn(),
}))

vi.mock('./appActivity', () => ({
  collectActivityTxids: mocks.collectActivityTxids,
}))

vi.mock('./appLog', () => ({
  getAppLogs: mocks.getAppLogs,
  getPreviousSessionLogs: mocks.getPreviousSessionLogs,
}))

vi.mock('./chainedChangeHeal', () => ({
  runChangeHeal: mocks.runChangeHeal,
}))

vi.mock('./diagnosticLog', () => ({
  logDiag: vi.fn(),
  snapshotWalletBalance: mocks.snapshotWalletBalance,
}))

vi.mock('./legacyScan', () => ({
  txExistsOnChain: mocks.txExistsOnChain,
}))

vi.mock('./session', () => ({
  bumpBalanceAfterHeal: vi.fn(),
  getActiveWallet: mocks.getActiveWallet,
}))

vi.mock('./spendAttempt', () => ({
  releaseSpendAttemptFunds: mocks.releaseSpendAttemptFunds,
}))

vi.mock('./staleOutputRelease', () => ({
  keepChangeOfSignedTx: mocks.keepChangeOfSignedTx,
}))

import {
  formatUtxoHealResult,
  healUtxoFromActivityHistory,
} from './utxoHealFromHistory'

const TX = '9ca339904b54368bf32503f0903a1f42e06009bebb19ce97b6fd6e1ce06c6cd1'

describe('healUtxoFromActivityHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.collectActivityTxids.mockReturnValue({
      txids: new Set([TX]),
      archived: 2,
      total: 10,
    })
    mocks.getPreviousSessionLogs.mockReturnValue([
      {
        at: 1,
        level: 'info',
        message: `[stale-output] kept change output(s) of ${TX.slice(0, 12)}`,
      },
    ])
    mocks.snapshotWalletBalance
      .mockResolvedValueOnce({
        spendable: 4,
        pendingChange: 2614,
        displayed: 2618,
      })
      .mockResolvedValueOnce({
        spendable: 2618,
        pendingChange: 0,
        displayed: 2618,
      })
    mocks.getActiveWallet.mockReturnValue({ chain: 'main' })
    mocks.txExistsOnChain.mockResolvedValue(true)
    mocks.keepChangeOfSignedTx.mockResolvedValue(1)
    mocks.runChangeHeal
      .mockResolvedValueOnce({
        restored: 0,
        scriptsLocal: 0,
        scriptsChain: 0,
        pendingPromoted: 0,
        reclaimed: 0,
      })
      .mockResolvedValueOnce({
        restored: 2,
        scriptsLocal: 1,
        scriptsChain: 0,
        pendingPromoted: 1,
        reclaimed: 0,
      })
      .mockResolvedValueOnce({
        restored: 0,
        scriptsLocal: 0,
        scriptsChain: 0,
        pendingPromoted: 0,
        reclaimed: 0,
      })
  })

  it('scans activity + logs, credits change, and runs heal paths', async () => {
    const result = await healUtxoFromActivityHistory()

    expect(mocks.releaseSpendAttemptFunds).toHaveBeenCalledOnce()
    expect(mocks.keepChangeOfSignedTx).toHaveBeenCalledWith(TX)
    expect(mocks.runChangeHeal).toHaveBeenCalled()
    expect(result.changeKept).toBe(1)
    expect(result.heal.restored).toBe(2)
    expect(result.balanceAfter?.spendable).toBe(2618)
    expect(formatUtxoHealResult(result)).toContain('+2614 spendable sats')
  })
})
