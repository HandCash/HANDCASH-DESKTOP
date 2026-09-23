import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const durableStore: Record<string, string> = {}
  return {
  collectActivityTxids: vi.fn(),
  reconcilePendingItemActivityWithSpentOutpoints: vi.fn(),
  relistCollectablesAfterLocalStateReplace: vi.fn(async () => undefined),
  recordWalletEvent: vi.fn(),
  runChangeHeal: vi.fn(),
  snapshotWalletBalance: vi.fn(),
  txExistsOnChain: vi.fn(),
  getActiveWallet: vi.fn(),
    shouldYieldChainIngestToSpend: vi.fn(() => false),
  releaseSpendAttemptFunds: vi.fn(),
  keepChangeOfSignedTx: vi.fn(),
  sealSpentInputsOfSignedTx: vi.fn(async () => 0),
  rehideInputsOfLiveLocalTxs: vi.fn(async () => 0),
  listSignedChequeTxids: vi.fn(() => [] as string[]),
  signedChequeAtomic: vi.fn(() => null as number[] | null),
  enqueuePendingMinerSubmit: vi.fn(() => true),
  durableGetItem: vi.fn((key: string) => durableStore[key] ?? ''),
  durableSetItem: vi.fn((key: string, value: string) => {
    if (value) durableStore[key] = value
    else delete durableStore[key]
  }),
  failUnsentLocalTx: vi.fn(async () => false),
  restoreOnChainLocalTx: vi.fn(async () => false),
  restoreFailedLocalTxsKnownOnChain: vi.fn(async () => 0),
  reclaimOutputsSealedByDeadTxs: vi.fn(async () => 0),
  listFailedLocalTxids: vi.fn(async () => [] as string[]),
  listPendingLocalChangeTxids: vi.fn(async () => [] as string[]),
  pinBroadcastLocalTx: vi.fn(async () => true),
  hasArcadeSubmitContacts: vi.fn(() => false),
  txHadArcadeSubmitContact: vi.fn(() => false),
  reconcileKnownUtxosByEvidence: vi.fn(async () => ({
    checked: 3,
    hiddenSpent: 0,
    restoredUnspent: 0,
    quarantined: 0,
    unknown: 0,
    spentOutpoints: [] as string[],
    restoredOutpoints: [] as string[],
    quarantinedOutpoints: [] as string[],
  })),
  clearDurableStore: () => {
    for (const key of Object.keys(durableStore)) delete durableStore[key]
  },
}})

vi.mock('./appActivity', () => ({
  collectActivityTxids: mocks.collectActivityTxids,
  reconcilePendingItemActivityWithSpentOutpoints:
    mocks.reconcilePendingItemActivityWithSpentOutpoints,
  recordWalletEvent: mocks.recordWalletEvent,
  UTXO_HEAL_METHOD: 'utxo-heal',
  WALLET_ACTIVITY_ORIGIN: 'wallet',
}))

vi.mock('./collectables', () => ({
  relistCollectablesAfterLocalStateReplace:
    mocks.relistCollectablesAfterLocalStateReplace,
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
  sealSpentInputsOfSignedTx: (...args: unknown[]) =>
    mocks.sealSpentInputsOfSignedTx(...args),
  rehideInputsOfLiveLocalTxs: (...args: unknown[]) =>
    mocks.rehideInputsOfLiveLocalTxs(...args),
  listPendingLocalChangeTxids: (...args: unknown[]) =>
    mocks.listPendingLocalChangeTxids(...args),
  listFailedLocalTxids: (...args: unknown[]) =>
    mocks.listFailedLocalTxids(...args),
  reconcileKnownUtxosByEvidence: (...args: unknown[]) =>
    mocks.reconcileKnownUtxosByEvidence(...args),
  failUnsentLocalTx: (...args: unknown[]) => mocks.failUnsentLocalTx(...args),
  restoreOnChainLocalTx: (...args: unknown[]) =>
    mocks.restoreOnChainLocalTx(...args),
  restoreFailedLocalTxsKnownOnChain: (...args: unknown[]) =>
    mocks.restoreFailedLocalTxsKnownOnChain(...args),
  reclaimOutputsSealedByDeadTxs: (...args: unknown[]) =>
    mocks.reclaimOutputsSealedByDeadTxs(...args),
  pinBroadcastLocalTx: (...args: unknown[]) =>
    mocks.pinBroadcastLocalTx(...args),
}))

vi.mock('./arcadeSubmitGuard', () => ({
  hasArcadeSubmitContacts: mocks.hasArcadeSubmitContacts,
  txHadArcadeSubmitContact: mocks.txHadArcadeSubmitContact,
}))

vi.mock('./signedChequeArchive', () => ({
  listSignedChequeTxids: () => mocks.listSignedChequeTxids(),
  signedChequeAtomic: (txid: string) => mocks.signedChequeAtomic(txid),
}))

vi.mock('./pendingMinerOutbox', () => ({
  enqueuePendingMinerSubmit: (...args: unknown[]) =>
    mocks.enqueuePendingMinerSubmit(...args),
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
  scheduleHealCheckpointIfDue,
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
  mocks.listSignedChequeTxids.mockReturnValue([TX])
  mocks.signedChequeAtomic.mockImplementation((txid: string) =>
    txid === TX ? [1, 2, 3] : null,
  )
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
    expect(mocks.releaseSpendAttemptFunds).not.toHaveBeenCalled()
    expect(mocks.reconcileKnownUtxosByEvidence).toHaveBeenCalledWith({
      forManualHeal: true,
      maxOutputs: 48,
    })
    expect(result.recoveredSats).toBe(2614)
    expect(formatUtxoHealResult(result)).toBe('Recovered 2,614 sats')
  })

  it('recovers signed change before auditing old output history', async () => {
    mocks.snapshotWalletBalance.mockReset()
    mocks.snapshotWalletBalance
      .mockResolvedValueOnce({ spendable: 0, pendingChange: 0, displayed: 0 })
      .mockResolvedValue({
        spendable: 899_280,
        pendingChange: 0,
        displayed: 899_280,
      })
    mocks.keepChangeOfSignedTx.mockResolvedValue(1)

    const result = await runUtxoHealPass({ source: 'manual', force: true })

    expect(result.recoveredSats).toBe(899_280)
    expect(mocks.reconcileKnownUtxosByEvidence).not.toHaveBeenCalled()
    expect(mocks.restoreFailedLocalTxsKnownOnChain).not.toHaveBeenCalled()
    expect(mocks.reclaimOutputsSealedByDeadTxs).not.toHaveBeenCalled()
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
    expect(mocks.keepChangeOfSignedTx).toHaveBeenCalledWith(
      TX,
      undefined,
      true,
      [1, 2, 3],
    )
    expect(mocks.keepChangeOfSignedTx).not.toHaveBeenCalledWith(
      other,
      undefined,
      true,
      expect.anything(),
    )
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

    expect(mocks.failUnsentLocalTx).not.toHaveBeenCalled()
    // The archived template rides along so a script-less change row can be
    // rebuilt from the body that created it.
    expect(mocks.keepChangeOfSignedTx).toHaveBeenCalledWith(
      TX,
      undefined,
      true,
      [1, 2, 3],
    )
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
    expect(mocks.keepChangeOfSignedTx).toHaveBeenCalledWith(
      TX,
      undefined,
      true,
      [1, 2, 3],
    )
  })

  it('restores Arcade-pinned failed change while explorers still return absent', async () => {
    mocks.txExistsOnChain.mockResolvedValue(false)
    mocks.listFailedLocalTxids.mockResolvedValue([TX])
    mocks.txHadArcadeSubmitContact.mockReturnValue(true)
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

    await runUtxoHealPass({ source: 'manual', force: true })

    expect(mocks.pinBroadcastLocalTx).toHaveBeenCalledWith(TX, [1, 2, 3])
    expect(mocks.keepChangeOfSignedTx).toHaveBeenCalledWith(
      TX,
      undefined,
      true,
      [1, 2, 3],
    )
  })

  it('does not heal activity hashes that have no signed template', async () => {
    mocks.listSignedChequeTxids.mockReturnValue([])
    mocks.signedChequeAtomic.mockReturnValue(null)
    mocks.collectActivityTxids.mockReturnValue({
      txids: new Set([TX]),
      archived: 0,
      total: 1,
    })

    await runUtxoHealPass({ source: 'manual', force: true })

    expect(mocks.keepChangeOfSignedTx).not.toHaveBeenCalled()
    expect(mocks.sealSpentInputsOfSignedTx).not.toHaveBeenCalled()
  })

  it('frees change of an Arcade-pinned send whose template was evicted', async () => {
    mocks.listSignedChequeTxids.mockReturnValue([TX])
    mocks.signedChequeAtomic.mockReturnValue(null)
    mocks.txHadArcadeSubmitContact.mockReturnValue(true)

    await runUtxoHealPass({ source: 'manual', force: true })

    expect(mocks.pinBroadcastLocalTx).toHaveBeenCalledWith(TX)
    expect(mocks.keepChangeOfSignedTx).toHaveBeenCalledWith(TX)
    // No body to replay, so nothing is re-sealed or re-submitted.
    expect(mocks.sealSpentInputsOfSignedTx).not.toHaveBeenCalled()
    expect(mocks.enqueuePendingMinerSubmit).not.toHaveBeenCalled()
  })

  it('does not start a background ingest heal from auto checkpoint', async () => {
    scheduleHealCheckpointIfDue('auto')
    scheduleHealCheckpointIfDue('send-cleanup')
    await new Promise((r) => setTimeout(r, 20))
    expect(mocks.keepChangeOfSignedTx).not.toHaveBeenCalled()
    expect(mocks.runChangeHeal).not.toHaveBeenCalled()
  })
})
