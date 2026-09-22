import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ActiveWallet } from './session'
import {
  disposeWalletRuntime,
  getWalletRuntime,
  installWalletRuntime,
  registerWalletRuntimeLifecycle,
  resetWalletRuntimeForTests,
  runtimeIsCurrent,
} from './walletRuntime'

function wallet(identityKey: string, accountIndex: number): ActiveWallet {
  return {
    wallet: {} as never,
    services: {} as never,
    rootKeyHex: `${accountIndex + 1}`.repeat(64).slice(0, 64),
    mnemonic: null,
    identityKey,
    address: `address-${accountIndex}`,
    handle: 'test',
    chain: 'main',
    masterRootKeyHex: '1'.repeat(64),
    accountIndex,
  }
}

describe('WalletRuntime', () => {
  beforeEach(() => resetWalletRuntimeForTests())

  it('aborts and fences the old account before publishing the next', () => {
    const first = installWalletRuntime(wallet('first', 0))
    const second = installWalletRuntime(wallet('second', 1))

    expect(first.signal.aborted).toBe(true)
    expect(runtimeIsCurrent(first)).toBe(false)
    expect(runtimeIsCurrent(second)).toBe(true)
    expect((getWalletRuntime()?.instance ?? null).identityKey).toBe('second')
    expect(second.storageNamespace).toBe('main:1:second')
  })

  it('runs feature disposal in reverse composition order', () => {
    const calls: string[] = []
    registerWalletRuntimeLifecycle({
      name: 'first',
      dispose: () => calls.push('first'),
    })
    registerWalletRuntimeLifecycle({
      name: 'second',
      dispose: () => calls.push('second'),
    })
    installWalletRuntime(wallet('first', 0))

    disposeWalletRuntime('account-changed')

    expect(calls).toEqual(['second', 'first'])
  })

  it('refuses duplicate feature ownership', () => {
    registerWalletRuntimeLifecycle({ name: 'tokens' })
    expect(() => registerWalletRuntimeLifecycle({ name: 'tokens' })).toThrow(
      'already registered',
    )
  })
})

describe('wallet runtime architecture ratchet', () => {
  it('does not grow the runtime-backed compatibility accessor', () => {
    let calls = 0
    const visit = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        const stat = statSync(path)
        if (stat.isDirectory()) {
          visit(path)
          continue
        }
        if (
          !/\.(ts|tsx)$/.test(name) ||
          name.endsWith('.test.ts') ||
          name.endsWith('.test.tsx') ||
          path.replaceAll('\\', '/').endsWith('/wallet/session.ts')
        ) {
          continue
        }
        calls += readFileSync(path, 'utf8').split('getActiveWallet(').length - 1
      }
    }
    visit(join(process.cwd(), 'src'))
    // Existing adapters resolve through WalletRuntime in session.ts. New and
    // migrated feature APIs receive WalletRuntime explicitly; this ratchet only
    // shrinks as compatibility adapters are converted.
    expect(calls).toBeLessThanOrEqual(195)
  })
})
