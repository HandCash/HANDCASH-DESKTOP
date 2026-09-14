import { afterEach, describe, expect, it } from 'vitest'
import {
  bindSyncHealthAccount,
  getSyncHealth,
  setSyncHealth,
} from './walletHealth'

describe('walletHealth account stamp', () => {
  afterEach(() => {
    bindSyncHealthAccount(null)
  })

  it('resets status when binding a new vault account', () => {
    bindSyncHealthAccount({ identityKey: 'ik-root', accountIndex: 0 })
    setSyncHealth({ phase: 'ok', message: null })
    expect(getSyncHealth().phase).toBe('ok')
    expect(getSyncHealth().identityKey).toBe('ik-root')

    bindSyncHealthAccount({ identityKey: 'ik-child', accountIndex: 1 })
    expect(getSyncHealth().phase).toBe('idle')
    expect(getSyncHealth().identityKey).toBe('ik-child')
    expect(getSyncHealth().message).toBeNull()
  })

  it('drops sync patches stamped for a prior account', () => {
    bindSyncHealthAccount({ identityKey: 'ik-child', accountIndex: 1 })
    setSyncHealth({ phase: 'syncing', message: 'child sync' })
    setSyncHealth({
      phase: 'ok',
      message: 'root leftover',
      identityKey: 'ik-root',
      accountIndex: 0,
    })
    expect(getSyncHealth().phase).toBe('syncing')
    expect(getSyncHealth().message).toBe('child sync')
    expect(getSyncHealth().identityKey).toBe('ik-child')
  })
})
