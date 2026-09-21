import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
const verifyBumpFinality = vi.fn()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

vi.mock('./spvFinality', () => ({
  verifyBumpFinality: (...args: unknown[]) => verifyBumpFinality(...args),
}))

describe('signed asset BUMP finality', () => {
  beforeEach(async () => {
    store.clear()
    verifyBumpFinality.mockReset()
    const { __resetTxStoreForTests } = await import('./txStore')
    const { __resetUtxoLocksForTests } = await import('./utxoLockManager')
    __resetTxStoreForTests()
    __resetUtxoLocksForTests()
  })

  it('promotes a token transaction to MINED only after verified BUMP', async () => {
    const txid = 'ab'.repeat(32)
    const { beginSignedTxLifecycle, tryFinalizeDualLayerTx } = await import(
      './dualLayerSend'
    )
    const token = beginSignedTxLifecycle({ txid, satoshis: 1 })
    verifyBumpFinality.mockResolvedValue({ ok: true, height: 967_733 })

    await expect(tryFinalizeDualLayerTx(token.id)).resolves.toMatchObject({
      txid,
      status: 'MINED',
      minedHeight: 967_733,
    })
    expect(verifyBumpFinality).toHaveBeenCalledWith(txid)
  })

  it('never invents finality from an invalid proof', async () => {
    const txid = 'cd'.repeat(32)
    const { beginSignedTxLifecycle, tryFinalizeDualLayerTx } = await import(
      './dualLayerSend'
    )
    const item = beginSignedTxLifecycle({ txid, satoshis: 1 })
    verifyBumpFinality.mockResolvedValue({
      ok: false,
      reason: 'invalid',
      detail: 'root mismatch',
    })

    await expect(tryFinalizeDualLayerTx(item.id)).resolves.toMatchObject({
      status: 'SEEN_IN_MEMPOOL',
      diagnostic: 'BUMP_UNVERIFIED',
    })
  })
})
