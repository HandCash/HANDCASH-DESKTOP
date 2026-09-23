import { beforeEach, describe, expect, it, vi } from 'vitest'

const sealSpentInputsOfSignedTx = vi.fn(async () => 1)
const releaseSealedInputsOfUnsentTx = vi.fn(async () => 1)
const beginSignedTxLifecycle = vi.fn(() => ({
  id: 'token-life',
  status: 'SEEN_IN_MEMPOOL',
}))
const noteDualLayerSigned = vi.fn(() => ({
  id: 'payment-life',
  status: 'SEEN_IN_MEMPOOL',
}))
const noteDualLayerPostBeef = vi.fn()
const tryFinalizeDualLayerTx = vi.fn(async () => null)
const failDualLayerSend = vi.fn()
const submitAtomicBeefToMiners = vi.fn()
const reportLateMinerSubmitFailure = vi.fn(async () => undefined)
const prepareBroadcastCheque = vi.fn(async (_w: unknown, _id: string, atomic: number[]) => ({
  atomic,
  decision: { kind: 'broadcast', parents: 'unconfirmed-bodies' },
}))

const enqueuePendingMinerSubmit = vi.fn(() => true)
const archiveSignedCheque = vi.fn(() => true)
const assertRuntimeCurrent = vi.fn()
const releaseRuntime = vi.fn()
let runtimeCurrent = true
const runtime = {
  instance: {
    chain: 'main',
    accountIndex: 2,
    identityKey: 'identity-two',
  },
  runtimeId: 'runtime-two',
  signal: new AbortController().signal,
}

vi.mock('./beefCache', () => ({
  prepareBroadcastCheque: (...args: unknown[]) => prepareBroadcastCheque(...args),
}))

vi.mock('./session', () => ({
  getActiveWallet: () => ({ chain: 'main' }),
}))

vi.mock('./walletRuntime', () => ({
  requireWalletRuntime: () => runtime,
  retainWalletRuntime: () => ({ runtime, release: releaseRuntime }),
  assertRuntimeAvailable: (...args: unknown[]) => assertRuntimeCurrent(...args),
  runtimeIsCurrent: () => runtimeCurrent,
}))

vi.mock('./staleOutputRelease', () => ({
  sealSpentInputsOfSignedTx: (...args: unknown[]) =>
    sealSpentInputsOfSignedTx(...args),
  releaseSealedInputsOfUnsentTx: (...args: unknown[]) =>
    releaseSealedInputsOfUnsentTx(...args),
}))

vi.mock('./dualLayerSend', () => ({
  beginSignedTxLifecycle: (...args: unknown[]) =>
    beginSignedTxLifecycle(...args),
  noteDualLayerSigned: (...args: unknown[]) => noteDualLayerSigned(...args),
  noteDualLayerPostBeef: (...args: unknown[]) =>
    noteDualLayerPostBeef(...args),
  tryFinalizeDualLayerTx: (...args: unknown[]) =>
    tryFinalizeDualLayerTx(...args),
  failDualLayerSend: (...args: unknown[]) => failDualLayerSend(...args),
}))

vi.mock('./minerSubmit', () => ({
  submitAtomicBeefToMiners: (...args: unknown[]) =>
    submitAtomicBeefToMiners(...args),
  reportLateMinerSubmitFailure: (...args: unknown[]) =>
    reportLateMinerSubmitFailure(...args),
}))

vi.mock('./pendingMinerOutbox', () => ({
  enqueuePendingMinerSubmit: (...args: unknown[]) =>
    enqueuePendingMinerSubmit(...args),
}))

vi.mock('./signedChequeArchive', () => ({
  archiveSignedCheque: (...args: unknown[]) => archiveSignedCheque(...args),
}))

const TXID = 'ab'.repeat(32)
const ATOMIC = [1, 2, 3]

describe('signedSendLifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeCurrent = true
  })

  it('registers token sends on the same lifecycle after sealing inputs', async () => {
    const { registerSignedSend } = await import('./signedSendLifecycle')
    const handle = await registerSignedSend({
      txid: TXID,
      atomicBeef: ATOMIC,
      flow: 'token_transfer',
      satoshis: 1,
      to: 'recipient',
    })

    expect(sealSpentInputsOfSignedTx).toHaveBeenCalledWith(
      TXID,
      ATOMIC,
      runtime.instance,
      true,
    )
    expect(archiveSignedCheque).toHaveBeenCalledWith(TXID, ATOMIC, {
      flow: 'token_transfer',
      owner: {
        accountIndex: 2,
        identityKey: 'identity-two',
        chain: 'main',
      },
    })
    expect(enqueuePendingMinerSubmit).toHaveBeenCalledWith(TXID, ATOMIC, {
      flow: 'token_transfer',
      owner: {
        accountIndex: 2,
        identityKey: 'identity-two',
        chain: 'main',
      },
    })
    expect(beginSignedTxLifecycle).toHaveBeenCalledWith({
      txid: TXID,
      satoshis: 1,
      to: 'recipient',
    })
    expect(handle.lifecycleId).toBe('token-life')
  })

  it('fails closed when the durable cheque archive refuses the write', async () => {
    archiveSignedCheque.mockReturnValueOnce(false)
    const { registerSignedSend } = await import('./signedSendLifecycle')

    await expect(
      registerSignedSend({
        txid: TXID,
        atomicBeef: ATOMIC,
        flow: 'token_transfer',
      }),
    ).rejects.toThrow(/could not be archived/)
    expect(enqueuePendingMinerSubmit).not.toHaveBeenCalled()
    expect(beginSignedTxLifecycle).not.toHaveBeenCalled()
    expect(releaseSealedInputsOfUnsentTx).toHaveBeenCalledWith(TXID, ATOMIC)
  })

  it('unseals immediately when the propagation queue refuses the cheque', async () => {
    enqueuePendingMinerSubmit.mockReturnValueOnce(false)
    const { registerSignedSend } = await import('./signedSendLifecycle')

    await expect(
      registerSignedSend({
        txid: TXID,
        atomicBeef: ATOMIC,
        flow: 'item_transfer',
      }),
    ).rejects.toThrow(/could not be queued for propagation/)
    expect(releaseSealedInputsOfUnsentTx).toHaveBeenCalledWith(TXID, ATOMIC)
    expect(beginSignedTxLifecycle).not.toHaveBeenCalled()
  })

  it('refuses to cross a derivation scope changed during preparation', async () => {
    assertRuntimeCurrent.mockImplementationOnce(() => {
      throw new DOMException('Wallet runtime disposed', 'AbortError')
    })
    const { registerSignedSend } = await import('./signedSendLifecycle')

    await expect(
      registerSignedSend({
        txid: TXID,
        atomicBeef: ATOMIC,
        flow: 'token_transfer',
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(sealSpentInputsOfSignedTx).not.toHaveBeenCalled()
    expect(archiveSignedCheque).not.toHaveBeenCalled()
  })

  it('finishes registration in the captured owner after the foreground account changes', async () => {
    prepareBroadcastCheque.mockImplementationOnce(async (_w, _id, atomic) => {
      runtimeCurrent = false
      return {
        atomic,
        decision: { kind: 'broadcast', parents: 'unconfirmed-bodies' },
      }
    })
    const { registerSignedSend } = await import('./signedSendLifecycle')

    const handle = await registerSignedSend({
      txid: TXID,
      atomicBeef: ATOMIC,
      flow: 'item_transfer',
    })

    expect(sealSpentInputsOfSignedTx).toHaveBeenCalledWith(
      TXID,
      ATOMIC,
      runtime.instance,
      false,
    )
    expect(enqueuePendingMinerSubmit).toHaveBeenCalledWith(
      TXID,
      ATOMIC,
      expect.objectContaining({
        owner: {
          accountIndex: 2,
          identityKey: 'identity-two',
          chain: 'main',
        },
      }),
    )
    expect(beginSignedTxLifecycle).not.toHaveBeenCalled()
    expect(handle.lifecycleId).toBe(`background:${TXID}`)
  })

  it('does not seal or queue a package with missing parent bodies', async () => {
    prepareBroadcastCheque.mockRejectedValueOnce(
      new Error(
        'Cannot broadcast: parent transaction bodies are missing (unconfirmed chain, not a spent coin)',
      ),
    )
    const { registerSignedSend } = await import('./signedSendLifecycle')
    await expect(
      registerSignedSend({
        txid: TXID,
        atomicBeef: ATOMIC,
        flow: 'token_transfer',
      }),
    ).rejects.toThrow(/parent transaction bodies are missing/)
    expect(sealSpentInputsOfSignedTx).not.toHaveBeenCalled()
    expect(archiveSignedCheque).not.toHaveBeenCalled()
    expect(enqueuePendingMinerSubmit).not.toHaveBeenCalled()
  })

  it('reuses a regular payment preflight lifecycle', async () => {
    const { registerSignedSend } = await import('./signedSendLifecycle')
    const handle = await registerSignedSend({
      txid: TXID,
      atomicBeef: ATOMIC,
      flow: 'p2pkh',
      lifecycleId: 'payment-life',
    })

    expect(noteDualLayerSigned).toHaveBeenCalledWith('payment-life', TXID)
    expect(beginSignedTxLifecycle).not.toHaveBeenCalled()
    expect(handle.lifecycleId).toBe('payment-life')
  })

  it('keeps provider silence queued and still attempts BUMP finality', async () => {
    submitAtomicBeefToMiners.mockResolvedValue({
      kind: 'queued',
      reason: 'transport',
    })
    const { propagateSignedSend } = await import('./signedSendLifecycle')
    const result = await propagateSignedSend({
      lifecycleId: 'token-life',
      txid: TXID,
      atomicBeef: ATOMIC,
      flow: 'token_transfer',
    })

    expect(result).toEqual({ kind: 'queued', reason: 'transport' })
    expect(submitAtomicBeefToMiners).toHaveBeenCalledWith(TXID, ATOMIC, {
      flow: 'token_transfer',
    })
    expect(failDualLayerSend).not.toHaveBeenCalled()
    expect(tryFinalizeDualLayerTx).toHaveBeenCalledWith('token-life')
  })

  it('applies miner acceptance and BUMP verification identically for tokens', async () => {
    const summary = {
      accepted: true,
      doubleSpend: false,
      missingInputs: false,
      serviceOnlyErrors: false,
      detail: 'Arcade accepted',
      competingTxs: [],
    }
    submitAtomicBeefToMiners.mockResolvedValue({
      kind: 'accepted',
      ancestryComplete: true,
      keepPropagating: false,
      summary,
    })
    const { propagateSignedSend } = await import('./signedSendLifecycle')
    await propagateSignedSend({
      lifecycleId: 'token-life',
      txid: TXID,
      atomicBeef: ATOMIC,
      flow: 'token_transfer',
    })

    expect(noteDualLayerPostBeef).toHaveBeenCalledWith('token-life', summary)
    expect(tryFinalizeDualLayerTx).toHaveBeenCalledWith('token-life')
  })

  it('applies one hard-reject path to lifecycle and Activity', async () => {
    const reject = new Error('Arcade rejected')
    submitAtomicBeefToMiners.mockRejectedValue(reject)
    const { propagateSignedSend } = await import('./signedSendLifecycle')

    await expect(
      propagateSignedSend(
        {
          lifecycleId: 'token-life',
          txid: TXID,
          atomicBeef: ATOMIC,
          flow: 'token_transfer',
        },
        { pendingId: 'pending-token' },
      ),
    ).rejects.toThrow('Arcade rejected')

    expect(failDualLayerSend).toHaveBeenCalledWith(
      'token-life',
      'ARC_REJECTED',
      'Arcade rejected',
    )
    expect(reportLateMinerSubmitFailure).toHaveBeenCalledWith({
      pendingId: 'pending-token',
      txid: TXID,
      reason: reject,
    })
  })
})
