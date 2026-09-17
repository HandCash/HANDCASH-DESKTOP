import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  invalidateWalletCaches,
  registerWalletCache,
  registeredWalletCaches,
  resetWalletCacheRegistryForTests,
} from './cacheRegistry'

describe('wallet cache registry', () => {
  beforeEach(resetWalletCacheRegistryForTests)

  it('invalidates declared scopes and refuses unknown ownership', () => {
    const invalidate = vi.fn()
    registerWalletCache('activity', invalidate)
    invalidateWalletCaches(['activity'], 'test')
    expect(invalidate).toHaveBeenCalledOnce()
    expect(() => invalidateWalletCaches(['messages'], 'test')).toThrow(
      'Wallet cache is not registered',
    )
  })

  it('does not let a feature replace an existing cache owner', () => {
    registerWalletCache('activity', () => undefined)
    expect(() => registerWalletCache('activity', () => undefined)).toThrow(
      'already registered',
    )
    expect(registeredWalletCaches()).toEqual(['activity'])
  })
})
