import { beforeEach, describe, expect, it, vi } from 'vitest'

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

  it('registers an app createAction on the shared signed lifecycle', async () => {
    const { funnelAppSignedCheque } = await import('./appSignedCheque')
    await expect(
      funnelAppSignedCheque({
        txid: TXID,
        atomicBeef: ATOMIC,
        satoshis: 20_000,
      }),
    ).resolves.toBe(true)

    expect(registerSignedSend).toHaveBeenCalledWith({
      txid: TXID,
      atomicBeef: ATOMIC,
      flow: 'brc100_action',
      satoshis: 20_000,
    })
  })

  it('leaves the app-owned signed transaction intact when registration throws', async () => {
    registerSignedSend.mockRejectedValueOnce(new Error('ancestry incomplete'))
    const { funnelAppSignedCheque } = await import('./appSignedCheque')
    await expect(
      funnelAppSignedCheque({ txid: TXID, atomicBeef: ATOMIC }),
    ).resolves.toBe(false)
    expect(registerSignedSend).toHaveBeenCalled()
  })
})
