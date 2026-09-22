import { describe, expect, it, beforeEach } from 'vitest'
import {
  accountLocalKey,
  bindAccountLocalKeyScope,
  resetAccountLocalKeyScopeForTests,
  peekAccountLocalKeyScope,
} from './accountLocalKeys'
import {
  durableForgetCached,
  durableGetItem,
  durableRemoveItem,
  durableSetItem,
} from './durableStorage'

describe('accountLocalKeys', () => {
  beforeEach(() => resetAccountLocalKeyScopeForTests())

  it('gives the primary an explicit wallet namespace', () => {
    bindAccountLocalKeyScope({ accountIndex: 0, identityKey: 'ik0' })
    expect(accountLocalKey('handcash.brc100.friends')).toBe(
      'handcash.brc100.friends:wallet:main:0:ik0',
    )
    expect(peekAccountLocalKeyScope().identityKey).toBe('ik0')
  })

  it('scopes sub-accounts by identity', () => {
    bindAccountLocalKeyScope({ accountIndex: 2, identityKey: 'ik2abc' })
    expect(accountLocalKey('handcash.brc100.friends')).toBe(
      'handcash.brc100.friends:wallet:main:2:ik2abc',
    )
    expect(accountLocalKey('handcash.brc100.appActivity')).toBe(
      'handcash.brc100.appActivity:wallet:main:2:ik2abc',
    )
  })

  it('imports an unscoped legacy key into primary once, never into a child', () => {
    const base = 'handcash.brc100.friends'
    const primary =
      'handcash.brc100.friends:wallet:main:0:migration-primary'
    const child = 'handcash.brc100.friends:wallet:main:1:migration-child'
    durableRemoveItem(base)
    durableRemoveItem(primary)
    durableRemoveItem(child)
    expect(durableSetItem(base, '{"legacy":true}')).toBe(true)
    durableForgetCached(primary)
    expect(durableGetItem(base)).toBe('{"legacy":true}')

    bindAccountLocalKeyScope({
      accountIndex: 0,
      identityKey: 'migration-primary',
      chain: 'main',
    })
    expect(durableGetItem(accountLocalKey(base))).toBe('{"legacy":true}')

    bindAccountLocalKeyScope({
      accountIndex: 1,
      identityKey: 'migration-child',
      chain: 'main',
    })
    expect(durableGetItem(accountLocalKey(base))).toBeNull()
  })
})
