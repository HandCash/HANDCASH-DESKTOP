import { beforeEach, describe, expect, it, vi } from 'vitest'

const archiveSignedCheque = vi.fn(() => true)
const registerSignedSend = vi.fn(async () => ({
  lifecycleId: 'app-life',
  txid: 'ab'.repeat(32),
  atomicBeef: [1, 2, 3],
  flow: 'brc100_action',
}))
const assertRuntimeCurrent = vi.fn()
const runtime = {
  instance: {
    chain: 'main',
    accountIndex: 3,
    identityKey: 'identity-three',
  },
}

vi.mock('./signedChequeArchive', () => ({
  archiveSignedCheque: (...args: unknown[]) => archiveSignedCheque(...args),
}))

vi.mock('./signedSendLifecycle', () => ({
  registerSignedSend: (...args: unknown[]) => registerSignedSend(...args),
}))

vi.mock('./walletRuntime', () => ({
  requireWalletRuntime: () => runtime,
  assertRuntimeCurrent: (...args: unknown[]) => assertRuntimeCurrent(...args),
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
      owner: {
        accountIndex: 3,
        identityKey: 'identity-three',
        chain: 'main',
      },
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

  it('does not enter the lifecycle when durable archive storage refuses', async () => {
    archiveSignedCheque.mockReturnValueOnce(false)
    const { funnelAppSignedCheque } = await import('./appSignedCheque')

    await expect(
      funnelAppSignedCheque({ txid: TXID, atomicBeef: ATOMIC }),
    ).resolves.toBe(false)
    expect(registerSignedSend).not.toHaveBeenCalled()
  })
})
