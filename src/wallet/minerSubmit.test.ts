import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Beef } from '@bsv/sdk'

const postBeef = vi.fn()
const releaseSealedInputsOfUnsentTx = vi.fn(async () => {})
const onAlreadySpentSend = vi.fn(async () => {})
const restoreOnChainLocalTx = vi.fn(async () => true)
let outboxWritesSucceed = true
const toastError = vi.fn()

vi.mock('./session', () => ({
  getActiveWallet: () => ({
    chain: 'main',
    services: { postBeef },
  }),
}))

vi.mock('./staleOutputRelease', () => ({
  releaseSealedInputsOfUnsentTx: (...a: unknown[]) => releaseSealedInputsOfUnsentTx(...a),
  onAlreadySpentSend: (...a: unknown[]) => onAlreadySpentSend(...a),
  restoreOnChainLocalTx: (...a: unknown[]) => restoreOnChainLocalTx(...a),
  pinBroadcastLocalTx: vi.fn(async () => true),
}))

vi.mock('./pendingMinerOutbox', () => ({
  enqueuePendingMinerSubmit: vi.fn(() => outboxWritesSucceed),
  removePendingMinerSubmit: vi.fn(),
  updatePendingMinerSubmitBody: vi.fn(() => outboxWritesSucceed),
}))

vi.mock('./toast', () => ({
  toastError: (...args: unknown[]) => toastError(...args),
}))

vi.mock('./arcadeSubmitGuard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./arcadeSubmitGuard')>()
  return {
    ...actual,
    rememberArcadeSubmitContact: vi.fn(actual.rememberArcadeSubmitContact),
  }
})

vi.mock('./legacyScan', () => ({
  txExistsOnChain: vi.fn(async () => false),
  spentStatusOfOutpoint: vi.fn(async () => 'unspent' as const),
}))

// Whether the signed AtomicBEEF can stand alone at a miner. Default complete so
// existing cases judge the provider answer, not our BEEF.
let beefComplete = true
let beefGap: 'none' | 'unconfirmed-parents' | 'missing-bodies' = 'missing-bodies'
vi.mock('./beefCache', () => ({
  classifyBeefAncestryGap: () => (beefComplete ? 'none' : beefGap),
  hydrateInputBeef: vi.fn(async () => undefined),
  mergeLocalUnconfirmedAncestry: vi.fn(async (_w: unknown, atomic: number[]) => atomic),
}))

vi.mock('./signedTxInputs', () => ({
  inputOutpointsForSignedTx: vi.fn(async () => [`${'b'.repeat(64)}.0`]),
}))

const watchArcadeLanding = vi.fn()
vi.mock('./arcadeLanding', () => ({
  watchArcadeLanding: (...a: unknown[]) => watchArcadeLanding(...a),
}))

let spvVerdict: { kind: 'verified' } | { kind: 'invalid' | 'incomplete'; reason: string } = {
  kind: 'verified',
}
vi.mock('./spvPackage', () => ({
  verifySignedPackage: vi.fn(async () => spvVerdict),
}))

const TXID = 'a'.repeat(64)
const ATOMIC = [1, 2, 3]

describe('submitAtomicBeefToMiners', () => {
  beforeEach(async () => {
    outboxWritesSucceed = true
    beefComplete = true
    beefGap = 'missing-bodies'
    spvVerdict = { kind: 'verified' }
    vi.mocked((await import('./beefCache')).hydrateInputBeef).mockClear()
    postBeef.mockReset()
    releaseSealedInputsOfUnsentTx.mockClear()
    onAlreadySpentSend.mockClear()
    restoreOnChainLocalTx.mockClear()
    toastError.mockClear()
    watchArcadeLanding.mockClear()
    const { __resetArcadeSubmitGuardForTests } = await import('./arcadeSubmitGuard')
    __resetArcadeSubmitGuardForTests()
    vi.spyOn(Beef, 'fromBinary').mockReturnValue(new Beef())
    const { txExistsOnChain, spentStatusOfOutpoint } = await import('./legacyScan')
    vi.mocked(txExistsOnChain).mockReset()
    vi.mocked(spentStatusOfOutpoint).mockReset()
    vi.mocked(txExistsOnChain).mockResolvedValue(false)
    vi.mocked(spentStatusOfOutpoint).mockResolvedValue('unspent')
  })

  it('returns accepted when miners accept', async () => {
    postBeef.mockResolvedValueOnce([
      { status: 'success', txidResults: [{ status: 'success' }] },
    ])
    const { submitAtomicBeefToMiners } = await import('./minerSubmit')
    const result = await submitAtomicBeefToMiners(TXID, ATOMIC)
    expect(result).toMatchObject({
      kind: 'accepted',
      ancestryComplete: true,
    })
    expect(restoreOnChainLocalTx).toHaveBeenCalledWith(TXID)
    expect(watchArcadeLanding).not.toHaveBeenCalled()
  })

  it('follows an Arcade 202 to a node instead of calling it landed', async () => {
    postBeef.mockResolvedValueOnce([
      { name: 'ArcadeBeef', status: 'success', txidResults: [{ txid: TXID, status: 'success' }] },
    ])
    const { submitAtomicBeefToMiners } = await import('./minerSubmit')
    const result = await submitAtomicBeefToMiners(TXID, ATOMIC)
    expect(result.kind).toBe('accepted')
    await vi.waitFor(() =>
      expect(watchArcadeLanding).toHaveBeenCalledWith(
        TXID,
        expect.objectContaining({ atomic: ATOMIC }),
      ),
    )
  })

  it('holds a package it cannot SPV-verify yet, posting nothing and keeping the seal', async () => {
    spvVerdict = { kind: 'incomplete', reason: 'missing an associated source transaction' }
    const { submitAtomicBeefToMiners } = await import('./minerSubmit')
    const result = await submitAtomicBeefToMiners(TXID, ATOMIC)
    expect(result).toEqual({ kind: 'queued', reason: 'unverified' })
    expect(postBeef).not.toHaveBeenCalled()
    expect(releaseSealedInputsOfUnsentTx).not.toHaveBeenCalled()
  })

  it('never posts an invalid package and frees the inputs it never sent', async () => {
    spvVerdict = { kind: 'invalid', reason: 'Script evaluation error' }
    const { submitAtomicBeefToMiners } = await import('./minerSubmit')
    await expect(submitAtomicBeefToMiners(TXID, ATOMIC)).rejects.toThrow(/does not verify/)
    expect(postBeef).not.toHaveBeenCalled()
    expect(releaseSealedInputsOfUnsentTx).toHaveBeenCalledWith(TXID, ATOMIC)
  })

  it('keeps a tx Arcade already accepted when local SPV refuses it', async () => {
    spvVerdict = { kind: 'invalid', reason: 'Script evaluation error' }
    const { rememberArcadeSubmitContact } = await import('./arcadeSubmitGuard')
    rememberArcadeSubmitContact(TXID)
    const { submitAtomicBeefToMiners } = await import('./minerSubmit')
    await expect(submitAtomicBeefToMiners(TXID, ATOMIC)).resolves.toMatchObject({
      kind: 'accepted',
      keepPropagating: false,
    })
    expect(postBeef).not.toHaveBeenCalled()
    expect(releaseSealedInputsOfUnsentTx).not.toHaveBeenCalled()
  })

  it('keeps a peer transfer the chain holds when local SPV refuses it', async () => {
    spvVerdict = { kind: 'invalid', reason: 'Script verification failed for transaction x' }
    const { txExistsOnChain } = await import('./legacyScan')
    vi.mocked(txExistsOnChain).mockResolvedValue(true)
    const { submitAtomicBeefToMiners } = await import('./minerSubmit')
    await expect(submitAtomicBeefToMiners(TXID, ATOMIC)).resolves.toMatchObject({
      kind: 'accepted',
    })
    expect(releaseSealedInputsOfUnsentTx).not.toHaveBeenCalled()
  })

  it('queues a signed cheque on transport failure without releasing the seal', async () => {
    postBeef.mockRejectedValueOnce(new Error('provider down'))
    const { submitAtomicBeefToMiners } = await import('./minerSubmit')
    const result = await submitAtomicBeefToMiners(TXID, ATOMIC)
    expect(result).toEqual({ kind: 'queued', reason: 'transport' })
    expect(releaseSealedInputsOfUnsentTx).not.toHaveBeenCalled()
  })

  it('reports an untracked cheque when durable retry storage fails', async () => {
    outboxWritesSucceed = false
    postBeef.mockRejectedValueOnce(new Error('provider down'))
    const { submitAtomicBeefToMiners } = await import('./minerSubmit')
    const result = await submitAtomicBeefToMiners(TXID, ATOMIC)
    expect(result).toEqual({
      kind: 'untracked',
      reason: 'outbox-write-failed',
      network: 'transport',
      summary: undefined,
    })
    expect(releaseSealedInputsOfUnsentTx).not.toHaveBeenCalled()
    await vi.waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'Send needs attention',
        expect.stringMatching(/could not be saved/i),
      ),
    )
  })

  it('queues a signed cheque on service-only silence', async () => {
    postBeef.mockResolvedValueOnce(undefined)
    const { submitAtomicBeefToMiners } = await import('./minerSubmit')
    const result = await submitAtomicBeefToMiners(TXID, ATOMIC)
    expect(result.kind).toBe('queued')
    expect(releaseSealedInputsOfUnsentTx).not.toHaveBeenCalled()
  })

  it('throws and hides when proven conflict and the signed tx is on chain', async () => {
    const { txExistsOnChain } = await import('./legacyScan')
    vi.mocked(txExistsOnChain).mockResolvedValue(true)
    postBeef.mockResolvedValueOnce([
      {
        status: 'error',
        txidResults: [
          {
            status: 'error',
            doubleSpend: true,
            notes: [{ what: 'postRawsErrorMissingInputs' }],
          },
        ],
      },
    ])
    const { submitAtomicBeefToMiners } = await import('./minerSubmit')
    await expect(submitAtomicBeefToMiners(TXID, ATOMIC)).rejects.toThrow('Already spent')
    expect(onAlreadySpentSend).toHaveBeenCalled()
    expect(releaseSealedInputsOfUnsentTx).not.toHaveBeenCalled()
  })

  it('treats unproven missing-inputs as a sealed cheque, not a released spend', async () => {
    postBeef.mockResolvedValueOnce([
      {
        status: 'error',
        txidResults: [
          {
            status: 'error',
            doubleSpend: true,
            notes: [{ what: 'postRawsErrorMissingInputs' }],
          },
        ],
      },
    ])
    const { submitAtomicBeefToMiners } = await import('./minerSubmit')
    const result = await submitAtomicBeefToMiners(TXID, ATOMIC)
    expect(result.kind).toBe('unproven-conflict')
    expect(onAlreadySpentSend).not.toHaveBeenCalled()
    expect(releaseSealedInputsOfUnsentTx).not.toHaveBeenCalled()
  })

  it('treats unproven doubleSpend as a sealed cheque, not a released spend', async () => {
    postBeef.mockResolvedValueOnce([
      {
        status: 'error',
        txidResults: [{ status: 'error', doubleSpend: true }],
      },
    ])
    const { submitAtomicBeefToMiners } = await import('./minerSubmit')
    const result = await submitAtomicBeefToMiners(TXID, ATOMIC)
    expect(result.kind).toBe('unproven-conflict')
    expect(onAlreadySpentSend).not.toHaveBeenCalled()
    expect(releaseSealedInputsOfUnsentTx).not.toHaveBeenCalled()
  })

  it('treats service-only endpoint errors as submitted without hiding coins', async () => {
    postBeef.mockResolvedValueOnce([
      { name: 'arcGorillaPool', status: 'error' },
      { name: 'BitailsPostRaws', status: 'error' },
      { name: 'WoC', status: 'error' },
      { name: 'arcTaal', status: 'error' },
    ])
    const { submitAtomicBeefToMiners } = await import('./minerSubmit')
    const result = await submitAtomicBeefToMiners(TXID, ATOMIC)
    expect(result).toMatchObject({ kind: 'queued', reason: 'service-error' })
    expect(onAlreadySpentSend).not.toHaveBeenCalled()
  })

  it('releases seals on proven conflict when the signed tx never landed', async () => {
    const { txExistsOnChain } = await import('./legacyScan')
    vi.mocked(txExistsOnChain).mockResolvedValueOnce(true) // conflictReal via onChain
    // Second call inside hard-reject path: our tx not on chain → release
    vi.mocked(txExistsOnChain).mockResolvedValueOnce(false)
    postBeef.mockResolvedValueOnce([
      {
        status: 'error',
        txidResults: [
          {
            status: 'error',
            doubleSpend: true,
            notes: [{ what: 'postRawsErrorMissingInputs' }],
          },
        ],
      },
    ])
    const { submitAtomicBeefToMiners } = await import('./minerSubmit')
    await expect(submitAtomicBeefToMiners(TXID, ATOMIC)).rejects.toThrow('Already spent')
    expect(releaseSealedInputsOfUnsentTx).toHaveBeenCalled()
    expect(onAlreadySpentSend).not.toHaveBeenCalled()
  })

  it('does not post a package whose parent transaction is missing', async () => {
    beefComplete = false
    const { submitAtomicBeefToMiners } = await import('./minerSubmit')
    const result = await submitAtomicBeefToMiners(TXID, ATOMIC)
    expect(result).toMatchObject({ kind: 'queued', reason: 'unverified' })
    expect(postBeef).not.toHaveBeenCalled()
    expect(onAlreadySpentSend).not.toHaveBeenCalled()
    expect(releaseSealedInputsOfUnsentTx).not.toHaveBeenCalled()
  })

  it('does not wait on a hydrate that cannot finish for an unconfirmed parent', async () => {
    beefComplete = false
    beefGap = 'unconfirmed-parents'
    const { hydrateInputBeef } = await import('./beefCache')
    postBeef.mockResolvedValueOnce([
      { status: 'success', txidResults: [{ status: 'success' }] },
    ])
    const { submitAtomicBeefToMiners } = await import('./minerSubmit')
    const result = await submitAtomicBeefToMiners(TXID, ATOMIC)
    expect(result).toMatchObject({
      kind: 'accepted',
      ancestryComplete: true,
      keepPropagating: true,
    })
    expect(hydrateInputBeef).not.toHaveBeenCalled()
  })

  it('does not treat a missing parent as a spent input', async () => {
    beefComplete = false
    const { spentStatusOfOutpoint } = await import('./legacyScan')
    vi.mocked(spentStatusOfOutpoint).mockResolvedValue('spent')
    const { submitAtomicBeefToMiners } = await import('./minerSubmit')
    const result = await submitAtomicBeefToMiners(TXID, ATOMIC)
    expect(result).toMatchObject({ kind: 'queued', reason: 'unverified' })
    expect(postBeef).not.toHaveBeenCalled()
    expect(releaseSealedInputsOfUnsentTx).not.toHaveBeenCalled()
  })

  it('does not hard-reject an Arcade service that only errored', async () => {
    postBeef.mockResolvedValueOnce([
      { name: 'ArcadeBeef', status: 'error' },
      { name: 'BitailsPostRaws', status: 'error', txidResults: [] },
    ])
    const { submitAtomicBeefToMiners } = await import('./minerSubmit')
    const result = await submitAtomicBeefToMiners(TXID, ATOMIC)
    expect(result.kind).toBe('queued')
    expect(releaseSealedInputsOfUnsentTx).not.toHaveBeenCalled()
  })

  it('hard-rejects Arcade missing-inputs and drops the local spend', async () => {
    postBeef.mockResolvedValueOnce([
      {
        name: 'ArcadeBeef',
        status: 'error',
        txidResults: [
          {
            status: 'error',
            doubleSpend: true,
            notes: [{ what: 'postRawsErrorMissingInputs' }],
          },
        ],
      },
    ])
    const { submitAtomicBeefToMiners } = await import('./minerSubmit')
    await expect(submitAtomicBeefToMiners(TXID, ATOMIC)).rejects.toThrow()
    expect(releaseSealedInputsOfUnsentTx).toHaveBeenCalled()
    expect(onAlreadySpentSend).not.toHaveBeenCalled()
  })
})
