import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PrivateKey } from '@bsv/sdk'

const store = new Map<string, string>()

vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, value)
  },
  removeItem: (key: string) => {
    store.delete(key)
  },
})

vi.mock('../walletRuntime', () => {
  const root = PrivateKey.fromHex('11'.repeat(32))
  return {
    getWalletRuntime: () => ({
      instance: {
        rootKeyHex: root.toHex(),
        identityKey: root.toPublicKey().toString(),
        accountIndex: 0,
        chain: 'main',
      },
    }),
  }
})

vi.mock('../vaultAccountHolding', () => ({
  activeAccountSpendRefusal: () => null,
}))

vi.mock('../paymentPolicy', () => ({
  assertOnlineForPayment: () => undefined,
}))

vi.mock('../appActivity', () => ({
  WALLET_ACTIVITY_ORIGIN: 'handcash',
  recordAppActivity: () => undefined,
}))

vi.mock('../accountLocalKeys', () => ({
  accountLocalKey: (key: string) => key,
}))

import { ARC_USDC_ERC20 } from './chain'
import { encodeBalanceOf, encodeTransfer } from './erc20'
import {
  arcUsdCoinKey,
  arcUsdWallet,
  setArcUsdRpcForTest,
} from './arcUsdWallet'
import { ethAddressFromPrivateKey } from './address'
import type { ArcRpc } from './rpc'

describe('arcUsdWallet', () => {
  beforeEach(async () => {
    store.clear()
    const { durableForgetCached } = await import('../durableStorage')
    durableForgetCached()
    setArcUsdRpcForTest(null)
  })

  it('derives a stable Arc address from the vault root', () => {
    const root = PrivateKey.fromHex('11'.repeat(32))
    const addr = ethAddressFromPrivateKey(arcUsdCoinKey(root))
    expect(arcUsdWallet.getAddress()).toBe(addr)
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('refreshes balance from eth_call and sends an ERC-20 transfer', async () => {
    const calls: { method: string; params: unknown[] }[] = []
    const own = arcUsdWallet.getAddress()
    const rpc: ArcRpc = {
      network: 'arc-mainnet',
      async call(method, params = []) {
        calls.push({ method, params })
        if (method === 'eth_call') {
          // 2.5 USDC
          return `0x${(2_500_000n).toString(16).padStart(64, '0')}`
        }
        if (method === 'eth_chainId') return '0x13b2' // 5042
        if (method === 'eth_getTransactionCount') return '0x0'
        if (method === 'eth_gasPrice') return '0x3b9aca00' // 1 gwei
        if (method === 'eth_estimateGas') return '0x5208'
        if (method === 'eth_sendRawTransaction') {
          expect(params[0]).toMatch(/^0x02|^0x[0-9a-fA-F]+/)
          return `0x${'ab'.repeat(32)}`
        }
        throw new Error(`unexpected ${method}`)
      },
    }
    setArcUsdRpcForTest(rpc, 'arc-mainnet')

    const report = await arcUsdWallet.refresh()
    expect(report.balance.spendable).toBe('2500000')
    expect(calls.some((c) => c.method === 'eth_call')).toBe(true)
    const balanceCall = calls.find((c) => c.method === 'eth_call')!
    expect((balanceCall.params[0] as { data: string }).data).toBe(encodeBalanceOf(own))

    const paid = await arcUsdWallet.send({
      address: '0x1111111111111111111111111111111111111111',
      litoshi: '1000000',
    })
    expect(paid.status).toBe('sent')
    expect(paid.amount).toBe('1000000')
    expect(paid.txid).toMatch(/^0x[a-f0-9]{64}$/)
    const estimate = calls.find((c) => c.method === 'eth_estimateGas')!
    expect((estimate.params[0] as { to: string; data: string }).to.toLowerCase()).toBe(
      ARC_USDC_ERC20.toLowerCase(),
    )
    expect((estimate.params[0] as { data: string }).data).toBe(
      encodeTransfer('0x1111111111111111111111111111111111111111', 1_000_000n),
    )
  })

  it('refuses identity payments and own address', async () => {
    expect(() =>
      arcUsdWallet.preflightSend({
        identityKey: '02' + 'ab'.repeat(32),
        litoshi: '1',
        address: '0x1111111111111111111111111111111111111111',
      }),
    ).toThrow(/identity/i)
    expect(() =>
      arcUsdWallet.preflightSend({ address: arcUsdWallet.getAddress(), litoshi: '1' }),
    ).toThrow(/own/i)
  })
})
