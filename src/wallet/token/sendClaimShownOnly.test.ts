import { PrivateKey } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildBsv21ValueLock } from './sendPlan'

const TOKEN = `${'ab'.repeat(32)}_0`
const ADDR = PrivateKey.fromRandom().toAddress()
const TIP = `${'cd'.repeat(32)}.1`
const LOCK = buildBsv21ValueLock({ tokenId: TOKEN, amount: 800n, address: ADDR })

const basket = { claimed: false, claimable: true }
const reconcileNow = vi.fn(async (_asset: string, _outpoints: string[]) => {
  if (basket.claimable) basket.claimed = true
})

vi.mock('../session', () => ({
  getActiveWallet: () => ({
    chain: 'main',
    identityKey: '03' + 'aa'.repeat(32),
    address: ADDR,
    wallet: { listOutputs: async () => ({ outputs: [] }) },
  }),
}))

vi.mock('./listTips', () => ({
  listBsv21BinaryTips: async () =>
    basket.claimed
      ? [{ outpoint: TIP, tokenId: TOKEN, amt: '800', dec: 0, lockingScript: LOCK }]
      : [],
  listBsv21BinaryTokens: async () => [],
}))

vi.mock('./list', () => ({
  getCachedFungibles: () => [
    { tokenId: TOKEN, sym: 'REF', amt: '800', dec: 0, utxoCount: 1, outpoint: TIP },
  ],
}))

vi.mock('../holdingsReconcile', () => ({
  reconcileNow: (asset: string, outpoints: string[]) => reconcileNow(asset, outpoints),
}))

vi.mock('../staleOutputRelease', () => ({
  restoreUnspentAssetOutpoint: async () => false,
}))

describe('token send over a tip only its card shows', () => {
  beforeEach(() => {
    basket.claimed = false
    basket.claimable = true
    reconcileNow.mockClear()
  })

  it('claims the shown-only tip before planning the spend', async () => {
    const { sendBsv21Tokens } = await import('./send')
    await expect(
      sendBsv21Tokens({ tokenId: TOKEN, amount: 200, toAddress: ADDR }),
    ).rejects.not.toThrow(/only 0 available/)
    expect(reconcileNow).toHaveBeenCalledWith('token', [TIP])
  })

  it('fails on the amount when the chain refuses the claim', async () => {
    basket.claimable = false
    const { sendBsv21Tokens } = await import('./send')
    await expect(
      sendBsv21Tokens({ tokenId: TOKEN, amount: 200, toAddress: ADDR }),
    ).rejects.toThrow(/only 0 available/)
    expect(reconcileNow).toHaveBeenCalledTimes(1)
  })

  it('never asks the reconcile when the basket covers the amount', async () => {
    basket.claimed = true
    const { sendBsv21Tokens } = await import('./send')
    await sendBsv21Tokens({ tokenId: TOKEN, amount: 200, toAddress: ADDR }).catch(() => {})
    expect(reconcileNow).not.toHaveBeenCalled()
  })
})
