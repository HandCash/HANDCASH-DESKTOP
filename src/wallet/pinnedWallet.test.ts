import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getActiveWallet: vi.fn(),
}))

vi.mock('./session', () => ({
  getActiveWallet: mocks.getActiveWallet,
}))

import { pinnedActiveWallet, pinnedWalletFor } from './pinnedWallet'
import type { ActiveWallet } from './session'
import {
  installWalletRuntime,
  resetWalletRuntimeForTests,
} from './walletRuntime'

class FakeStorage {
  writes = 0
  async updateOutput(): Promise<number> {
    this.writes += 1
    return this.writes
  }
  async runAsStorageProvider<T>(fn: (sp: FakeStorage) => Promise<T>): Promise<T> {
    return fn(this)
  }
}

class FakeWallet {
  storage = new FakeStorage()
  private secret = 'kept'
  async listOutputs(): Promise<string> {
    return this.secret
  }
}

function account(identityKey: string, accountIndex: number): ActiveWallet {
  return {
    chain: 'main',
    identityKey,
    accountIndex,
    wallet: new FakeWallet(),
  } as unknown as ActiveWallet
}

describe('pinnedWallet', () => {
  beforeEach(() => {
    resetWalletRuntimeForTests()
    mocks.getActiveWallet.mockReset()
  })

  it('serves storage while the runtime is current and keeps wallet `this` intact', async () => {
    const a = account('03' + 'a'.repeat(64), 0)
    const runtime = installWalletRuntime(a)
    const pinned = pinnedWalletFor(runtime)

    await expect(pinned.wallet.storage.updateOutput()).resolves.toBe(1)
    await expect(
      (pinned.wallet as unknown as FakeWallet).listOutputs(),
    ).resolves.toBe('kept')
    expect((a.wallet as unknown as FakeWallet).storage.writes).toBe(1)
  })

  /**
   * hc-a580a: a repair captured account A's wallet, the user switched to B,
   * and the tail of the repair kept writing. The pin makes the write itself
   * refuse — including writes issued through the provider handed to
   * `runAsStorageProvider` mid-callback.
   */
  it('refuses every storage call, including the provider inside runAsStorageProvider, once the account changes', async () => {
    const a = account('03' + 'a'.repeat(64), 0)
    const b = account('03' + 'b'.repeat(64), 1)
    const runtime = installWalletRuntime(a)
    const pinned = pinnedWalletFor(runtime)

    let insideWrites = 0
    const run = pinned.wallet.storage.runAsStorageProvider(async (sp) => {
      await (sp as unknown as FakeStorage).updateOutput()
      insideWrites += 1
      installWalletRuntime(b) // the switch lands mid-callback
      await (sp as unknown as FakeStorage).updateOutput() // must throw
      insideWrites += 1
    })
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(insideWrites).toBe(1)
    expect((a.wallet as unknown as FakeWallet).storage.writes).toBe(1)

    // Refusal is at the call, before any promise is made.
    expect(() => pinned.wallet.storage.updateOutput()).toThrowError(
      expect.objectContaining({ name: 'AbortError' }),
    )
    expect(() =>
      (pinned.wallet as unknown as FakeWallet).listOutputs(),
    ).toThrowError(expect.objectContaining({ name: 'AbortError' }))
    // B's own storage was never touched by A's handle.
    expect((b.wallet as unknown as FakeWallet).storage.writes).toBe(0)
  })

  it('pins the active wallet to the installed runtime and is stable per runtime', () => {
    const a = account('03' + 'a'.repeat(64), 0)
    installWalletRuntime(a)
    mocks.getActiveWallet.mockReturnValue(a)
    const first = pinnedActiveWallet()
    const second = pinnedActiveWallet()
    expect(first).toBe(second)
    expect(first?.wallet).not.toBe(a.wallet)
    expect(first?.identityKey).toBe(a.identityKey)
  })

  it('falls back to the raw wallet when no runtime is installed (unit fixtures)', () => {
    const a = account('vitest-primary-identity', 0)
    mocks.getActiveWallet.mockReturnValue(a)
    expect(pinnedActiveWallet()).toBe(a)
  })
})
