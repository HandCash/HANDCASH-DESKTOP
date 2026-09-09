import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const durableStore: Record<string, string> = {}
  return {
  collectActivityTxids: vi.fn(),
  recordWalletEvent: vi.fn(),
  runChangeHeal: vi.fn(),
  snapshotWalletBalance: vi.fn(),
  txExistsOnChain: vi.fn(),
  getActiveWallet: vi.fn(),
    shouldYieldChainIngestToSpend: vi.fn(() => false),
  releaseSpendAttemptFunds: vi.fn(),
  keepChangeOfSignedTx: vi.fn(),
  durableGetItem: vi.fn((key: string) => durableStore[key] ?? ''),
  durableSetItem: vi.fn((key: string, value: string) => {
    if (value) durableStore[key] = value
    else delete durableStore[key]
  }),
  failUnsentLocalTx: vi.fn(async () => false),
  restoreOnChainLocalTx: vi.fn(async () => false),
  listFailedLocalTxids: vi.fn(async () => [] as string[]),
  listPendingLocalChangeTxids: vi.fn(async () => [] as string[]),
  clearDurableStore: () => {
    for (const key of Object.keys(durableStore)) delete durableStore[key]
  },
}})

vi.mock('./appActivity', () => ({
  collectActivityTxids: mocks.collectActivityTxids,
  recordWalletEvent: mocks.recordWalletEvent,
  UTXO_HEAL_METHOD: 'utxo-heal',
  WALLET_ACTIVITY_ORIGIN: 'wallet',
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
  listPendingLocalChangeTxids: (...args: unknown[]) =>
    mocks.listPendingLocalChangeTxids(...args),
  listFailedLocalTxids: (...args: unknown[]) =>
    mocks.listFailedLocalTxids(...args),
  failUnsentLocalTx: (...args: unknown[]) => mocks.failUnsentLocalTx(...args),
  restoreOnChainLocalTx: (...args: unknown[]) =>
    mocks.restoreOnChainLocalTx(...args),
}))

vi.mock('./durableStorage', () => ({
  durableGetItem: mocks.durableGetItem,
  durableSetItem: mocks.durableSetItem,
}))

vi.mock('./walletCoordinator', () => ({
  runChainIngest: vi.fn((fn: () => Promise<unknown>) => fn()),
  shouldYieldChainIngestToSpend: mocks.shouldYieldChainIngestToSpend,
  getSpendPriorityDepth: vi.fn(() => 0),
}))

import {
  formatUtxoHealResult,
  healUtxoFromActivityHistory,
  runUtxoHealPass,
} from './utxoHealFromHistory'
import { __resetHealCheckpointForTests, writeHealCheckpoint } from './utxoHealCheckpoint'

const TX = '9ca339904b54368bf32503f0903a1f42e06009bebb19ce97b6fd6e1ce06c6cd1'

function mockHealSuccess() {
  mocks.collectActivityTxids.mockReturnValue({
    txids: new Set([TX]),
    archived: 2,
    total: 10,
  })
  let balanceReads = 0
  mocks.snapshotWalletBalance.mockImplementation(async () => {
    balanceReads += 1
    if (balanceReads === 1) {
      return { spendable: 4, pendingChange: 2614, displayed: 2618 }
    }
    return { spendable: 2618, pendingChange: 0, displayed: 2618 }
  })
  mocks.getActiveWallet.mockReturnValue({ chain: 'main' })
  mocks.txExistsOnChain.mockResolvedValue(true)
  mocks.keepChangeOfSignedTx.mockResolvedValue(1)
  mocks.runChangeHeal.mockResolvedValue({
    restored: 0,
    scriptsLocal: 0,
    scriptsChain: 0,
    pendingPromoted: 0,
    reclaimed: 0,
  })
}

describe('healUtxoFromActivityHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.clearDurableStore()
    __resetHealCheckpointForTests()
    mockHealSuccess()
  })

  it('writes Activity on manual heal and reports recovered sats', async () => {
    const result = await healUtxoFromActivityHistory()

    expect(mocks.recordWalletEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'utxo-heal',
        status: 'complete',
        sats: 2614,
      }),
    )
    expect(mocks.durableSetItem).toHaveBeenCalled()
    expect(result.recoveredSats).toBe(2614)
    expect(formatUtxoHealResult(result)).toBe('Recovered 2,614 sats')
  })

  it('skips auto pass when checkpoint is fresh and clean', async () => {
    writeHealCheckpoint({
      at: Date.now(),
      txids: [TX],
      recoveredSats: 0,
      pendingChangeAfter: 0,
      source: 'auto',
    })
    mocks.snapshotWalletBalance.mockReset()
    mocks.snapshotWalletBalance.mockResolvedValue({
      spendable: 100,
      pendingChange: 0,
      displayed: 100,
    })

    const result = await runUtxoHealPass({ source: 'auto' })

    expect(result.skipped).toBe(true)
    expect(mocks.keepChangeOfSignedTx).not.toHaveBeenCalled()
  })

  it('does not touch wallet storage when a spend is waiting', async () => {
    mocks.shouldYieldChainIngestToSpend.mockReturnValueOnce(true)

    await runUtxoHealPass({ source: 'auto', force: true })

    expect(mocks.releaseSpendAttemptFunds).not.toHaveBeenCalled()
    expect(mocks.runChangeHeal).not.toHaveBeenCalled()
  })

  it('merges checkpoint txids so prior heals are never dropped', async () => {
    const other =
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    writeHealCheckpoint({
      at: Date.now() - 60_000,
      txids: [other],
      recoveredSats: 0,
      pendingChangeAfter: 0,
      source: 'auto',
    })
    mocks.collectActivityTxids.mockReturnValue({
      txids: new Set([TX]),
      archived: 0,
      total: 1,
    })

    await runUtxoHealPass({ source: 'auto' })

    const saved = mocks.durableSetItem.mock.calls.at(-1)?.[1] as string
    expect(saved).toContain(other)
    expect(saved).toContain(TX)
    expect(mocks.keepChangeOfSignedTx).toHaveBeenCalledWith(TX)
    expect(mocks.keepChangeOfSignedTx).not.toHaveBeenCalledWith(other)
  })

  it('does not restack change-heal scans when pending change is already 0', async () => {
    mocks.snapshotWalletBalance.mockReset()
    mocks.snapshotWalletBalance.mockResolvedValue({
      spendable: 100,
      pendingChange: 0,
      displayed: 100,
    })

    await runUtxoHealPass({ source: 'auto' })

    const paths = mocks.runChangeHeal.mock.calls.map(
      (call) => (call[0] as { path?: string })?.path,
    )
    expect(paths).toEqual(['spendGate'])
  })

  it('keeps local change when explorers have not seen a just-submitted tx', async () => {
    mocks.txExistsOnChain.mockResolvedValue(false)
    mocks.failUnsentLocalTx.mockResolvedValue(false)
    mocks.getActiveWallet.mockReturnValue({
      chain: 'main',
      wallet: {
        storage: {
          runAsStorageProvider: async (
            fn: (sp: {
              getProvenOrRawTx: (id: string) => Promise<{ rawTx: number[] }>
            }) => Promise<unknown>,
          ) => fn({ getProvenOrRawTx: async () => ({ rawTx: [1, 2, 3] }) }),
        },
      },
    })

    await runUtxoHealPass({ source: 'send-cleanup', force: true })

    expect(mocks.failUnsentLocalTx).toHaveBeenCalledWith(TX)
    expect(mocks.keepChangeOfSignedTx).toHaveBeenCalledWith(TX)
  })

  it('restores a ghost-failed local tx once explorers see it on chain', async () => {
    mocks.txExistsOnChain.mockResolvedValue(true)
    mocks.listFailedLocalTxids.mockResolvedValue([TX])
    mocks.getActiveWallet.mockReturnValue({
      chain: 'main',
      wallet: {
        storage: {
          runAsStorageProvider: async (
            fn: (sp: {
              getProvenOrRawTx: (id: string) => Promise<{ rawTx: number[] }>
            }) => Promise<unknown>,
          ) => fn({ getProvenOrRawTx: async () => ({ rawTx: [1, 2, 3] }) }),
        },
      },
    })

    await runUtxoHealPass({ source: 'send-cleanup', force: true })

    expect(mocks.restoreOnChainLocalTx).toHaveBeenCalledWith(TX)
    expect(mocks.keepChangeOfSignedTx).toHaveBeenCalledWith(TX)
  })
})
