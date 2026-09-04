import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Beef } from '@bsv/sdk'

const postBeef = vi.fn()
const releaseSealedInputsOfUnsentTx = vi.fn(async () => {})
const onAlreadySpentSend = vi.fn(async () => {})

vi.mock('./session', () => ({
  getActiveWallet: () => ({
    chain: 'main',
    services: { postBeef },
  }),
}))

vi.mock('./staleOutputRelease', () => ({
  releaseSealedInputsOfUnsentTx: (...a: unknown[]) => releaseSealedInputsOfUnsentTx(...a),
  onAlreadySpentSend: (...a: unknown[]) => onAlreadySpentSend(...a),
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

const TXID = 'a'.repeat(64)
const ATOMIC = [1, 2, 3]

describe('submitAtomicBeefToMiners', () => {
  beforeEach(async () => {
    postBeef.mockReset()
    releaseSealedInputsOfUnsentTx.mockClear()
    onAlreadySpentSend.mockClear()
    vi.spyOn(Beef, 'fromBinary').mockReturnValue(new Beef())
    const { txExistsOnChain, spentStatusOfOutpoint } = await import('./legacyScan')
    vi.mocked(txExistsOnChain).mockReset()
    vi.mocked(spentStatusOfOutpoint).mockReset()
    vi.mocked(txExistsOnChain).mockResolvedValue(false)
    vi.mocked(spentStatusOfOutpoint).mockResolvedValue('unspent')
  })

  it('returns confirmed when miners accept', async () => {
    postBeef.mockResolvedValueOnce([
      { status: 'success', txidResults: [{ status: 'success' }] },
    ])
    const { submitAtomicBeefToMiners } = await import('./minerSubmit')
    const result = await submitAtomicBeefToMiners(TXID, ATOMIC)
    expect(result.confirmed).toBe(true)
    expect(result.submitted).toBe(true)
  })

  it('treats transport failure as submitted without releasing the seal', async () => {
    postBeef.mockRejectedValueOnce(new Error('provider down'))
    const { submitAtomicBeefToMiners } = await import('./minerSubmit')
    const result = await submitAtomicBeefToMiners(TXID, ATOMIC)
    expect(result.submitted).toBe(true)
    expect(result.confirmed).toBe(false)
    expect(releaseSealedInputsOfUnsentTx).not.toHaveBeenCalled()
  })

  it('treats service-only silence as submitted', async () => {
    postBeef.mockResolvedValueOnce(undefined)
    const { submitAtomicBeefToMiners } = await import('./minerSubmit')
    const result = await submitAtomicBeefToMiners(TXID, ATOMIC)
    expect(result.submitted).toBe(true)
    expect(result.confirmed).toBe(false)
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

  it('treats unproven missing-inputs as submitted and releases the seal', async () => {
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
    expect(result.submitted).toBe(true)
    expect(onAlreadySpentSend).not.toHaveBeenCalled()
    expect(releaseSealedInputsOfUnsentTx).toHaveBeenCalled()
  })

  it('treats ghost doubleSpend as submitted and releases the seal', async () => {
    postBeef.mockResolvedValueOnce([
      {
        status: 'error',
        txidResults: [{ status: 'error', doubleSpend: true }],
      },
    ])
    const { submitAtomicBeefToMiners } = await import('./minerSubmit')
    const result = await submitAtomicBeefToMiners(TXID, ATOMIC)
    expect(result.submitted).toBe(true)
    expect(onAlreadySpentSend).not.toHaveBeenCalled()
    expect(releaseSealedInputsOfUnsentTx).toHaveBeenCalled()
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
    expect(result.submitted).toBe(true)
    expect(result.confirmed).toBe(false)
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

  it('does not roll back when Arcade reports missing inputs but coins are unspent', async () => {
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
    const result = await submitAtomicBeefToMiners(TXID, ATOMIC)
    expect(result.submitted).toBe(true)
    expect(onAlreadySpentSend).not.toHaveBeenCalled()
    expect(releaseSealedInputsOfUnsentTx).toHaveBeenCalled()
  })
})
