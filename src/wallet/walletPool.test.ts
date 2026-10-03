import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActiveWallet } from './session'
import {
  MAX_WARM_WALLETS,
  clearWarmWallets,
  hasWarmWallet,
  markWarmWalletSelected,
  replaceWarmWallet,
  warmWallet,
  warmWalletKeys,
  warmWalletUnit,
} from './walletPool'

function unit(index: number, databaseName = `db-${index}`) {
  return warmWalletUnit({ chain: 'main', accountIndex: index, identityKey: `ik-${index}`, databaseName })
}

function fakeWallet(index: number) {
  const stopTasks = vi.fn()
  const wallet = { accountIndex: index, monitor: { stopTasks, startTasks: vi.fn() } } as unknown as ActiveWallet
  return { wallet, stopTasks }
}

afterEach(() => clearWarmWallets())

describe('walletPool', () => {
  it('builds a unit once and shares it across callers', async () => {
    const { wallet } = fakeWallet(1)
    const build = vi.fn(async () => wallet)
    const [a, b] = await Promise.all([warmWallet(unit(1), build), warmWallet(unit(1), build)])
    expect(a).toBe(wallet)
    expect(b).toBe(wallet)
    expect(build).toHaveBeenCalledTimes(1)
    expect(hasWarmWallet(unit(1))).toBe(true)
  })

  it('rebuilds when the account selected another Toolbox database', async () => {
    const first = fakeWallet(1)
    const second = fakeWallet(1)
    await warmWallet(unit(1, 'db-a'), async () => first.wallet)
    const next = await warmWallet(unit(1, 'db-b'), async () => second.wallet)
    expect(next).toBe(second.wallet)
    await Promise.resolve()
    expect(first.stopTasks).toHaveBeenCalled()
  })

  it('replace builds fresh even when warm', async () => {
    const first = fakeWallet(0)
    const second = fakeWallet(0)
    await warmWallet(unit(0), async () => first.wallet)
    expect(await replaceWarmWallet(unit(0), async () => second.wallet)).toBe(second.wallet)
  })

  it('evicts the least recently selected unit, never the selected one', async () => {
    const wallets = Array.from({ length: MAX_WARM_WALLETS + 1 }, (_, i) => fakeWallet(i))
    await warmWallet(unit(0), async () => wallets[0]!.wallet)
    markWarmWalletSelected(unit(0))
    for (let i = 1; i <= MAX_WARM_WALLETS; i += 1) {
      await warmWallet(unit(i), async () => wallets[i]!.wallet)
    }
    const keys = warmWalletKeys()
    expect(keys).toHaveLength(MAX_WARM_WALLETS)
    expect(keys).toContain(unit(0).key)
    expect(keys).not.toContain(unit(1).key)
    await Promise.resolve()
    expect(wallets[1]!.stopTasks).toHaveBeenCalled()
    expect(wallets[0]!.stopTasks).not.toHaveBeenCalled()
  })

  it('leaves no entry behind when a build fails', async () => {
    await expect(warmWallet(unit(2), async () => Promise.reject(new Error('idb')))).rejects.toThrow('idb')
    expect(hasWarmWallet(unit(2))).toBe(false)
  })

  it('lock stops every monitor and refuses a build that finishes afterwards', async () => {
    const ready = fakeWallet(0)
    await warmWallet(unit(0), async () => ready.wallet)
    let finish!: (w: ActiveWallet) => void
    const late = fakeWallet(3)
    const pending = warmWallet(unit(3), () => new Promise<ActiveWallet>((resolve) => (finish = resolve)))
    clearWarmWallets()
    finish(late.wallet)
    await expect(pending).rejects.toThrow('Wallet locked')
    await Promise.resolve()
    expect(ready.stopTasks).toHaveBeenCalled()
    expect(late.stopTasks).toHaveBeenCalled()
    expect(warmWalletKeys()).toEqual([])
  })
})
