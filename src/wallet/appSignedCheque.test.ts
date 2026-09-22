import { beforeEach, describe, expect, it, vi } from 'vitest'

const archiveSignedCheque = vi.fn(() => true)
const registerSignedSend = vi.fn(async () => ({
  lifecycleId: 'app-life',
  txid: 'ab'.repeat(32),
  atomicBeef: [1, 2, 3],
  flow: 'brc100_action',
}))

vi.mock('./signedChequeArchive', () => ({
  archiveSignedCheque: (...args: unknown[]) => archiveSignedCheque(...args),
}))

vi.mock('./signedSendLifecycle', () => ({
  registerSignedSend: (...args: unknown[]) => registerSignedSend(...args),
}))

const TXID = 'ab'.repeat(32)
const ATOMIC = [1, 2, 3]

describe('funnelAppSignedCheque', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('archives then registers an app createAction on the shared lifecycle', async () => {
    const { funnelAppSignedCheque } = await import('./appSignedCheque')
    await expect(
      funnelAppSignedCheque({
        txid: TXID,
        atomicBeef: ATOMIC,
        satoshis: 20_000,
      }),
    ).resolves.toBe(true)

    expect(archiveSignedCheque).toHaveBeenCalledWith(TXID, ATOMIC, {
      flow: 'brc100_action',
    })
    expect(registerSignedSend).toHaveBeenCalledWith({
      txid: TXID,
      atomicBeef: ATOMIC,
      flow: 'brc100_action',
      satoshis: 20_000,
    })
  })

  it('keeps the archived template when lifecycle registration throws', async () => {
    registerSignedSend.mockRejectedValueOnce(new Error('ancestry incomplete'))
    const { funnelAppSignedCheque } = await import('./appSignedCheque')
    await expect(
      funnelAppSignedCheque({ txid: TXID, atomicBeef: ATOMIC }),
    ).resolves.toBe(false)
    expect(archiveSignedCheque).toHaveBeenCalled()
  })
})
